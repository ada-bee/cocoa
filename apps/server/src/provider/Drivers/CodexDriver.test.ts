import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as CodexErrors from "effect-codex-app-server/errors";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import type { CodexAdapterLiveOptions } from "../Layers/CodexAdapter.ts";
import type {
  CodexSessionRuntimeOptions,
  CodexSessionRuntimeShape,
} from "../Layers/CodexSessionRuntime.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import * as CodexEndpointConnection from "../codexEndpoint/CodexEndpointConnection.ts";
import type { CodexEndpointRouter } from "../codexEndpoint/CodexEndpointRouter.ts";
import * as CodexEndpointSupervisor from "../codexEndpoint/CodexEndpointSupervisor.ts";
import {
  CodexEndpointUnsupportedAuthenticationError,
  CodexEndpointWebSocketOpenError,
} from "../codexEndpoint/DirectWebSocketConnector.ts";
import { makeCodexDriver, type CodexDriverDependencies } from "./CodexDriver.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const DRIVER_KIND = ProviderDriverKind.make("codex");
const ENDPOINT_CONFIG = decodeCodexSettings({
  endpointTransport: {
    type: "direct-websocket",
    url: "ws://127.0.0.1:7777",
    authentication: { type: "none" },
  },
});

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const BackgroundPolicyNoWorkLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: false,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(false),
  shouldRunScopeWork: () => Effect.succeed(false),
  shouldRunOpportunisticWork: Effect.succeed(false),
});
const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);
const TestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "codex-driver-endpoint-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(BackgroundPolicyNoWorkLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

const unavailableTextGeneration = {
  generateCommitMessage: () => Effect.die("unused"),
  generatePrContent: () => Effect.die("unused"),
  generateBranchName: () => Effect.die("unused"),
  generateThreadTitle: () => Effect.die("unused"),
} as TextGeneration["Service"];

function providerDraft(state: "ready" | "error", version = "0.147.0") {
  return buildServerProvider({
    presentation: { displayName: "Codex", showInteractionModeToggle: true },
    enabled: true,
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    skills: [],
    probe: {
      installed: true,
      version,
      status: state,
      auth: { status: "authenticated" },
      ...(state === "error" ? { message: "endpoint disconnected" } : {}),
    },
  });
}

const terminationError = (instanceId: ProviderInstanceId, label: string) =>
  new CodexEndpointConnection.CodexEndpointTerminationError({
    providerInstanceId: instanceId,
    cause: new CodexErrors.CodexAppServerTransportError({
      operation: "read-input-stream",
      cause: new Error(label),
    }),
  });

const makeTerminationConnection = Effect.fn("test.makeDriverTerminationConnection")(function* (
  instanceId: ProviderInstanceId,
  generation: number,
) {
  const terminated = yield* Deferred.make<CodexEndpointConnection.CodexEndpointTerminationError>();
  return {
    connection: CodexEndpointConnection.CodexEndpointConnection.of({
      identity: { providerInstanceId: instanceId },
      client: {
        generation,
      } as unknown as CodexEndpointConnection.CodexEndpointConnection["Service"]["client"],
      compatibility: {
        userAgent: `codex_cli_rs/0.${generation}.0`,
        serverVersion: `0.${generation}.0`,
        codexHome: `/remote/${generation}/.codex`,
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Deferred.await(terminated).pipe(Effect.flatMap(Effect.fail)),
    }),
    terminate: (label = `generation-${generation}-terminated`) =>
      Deferred.succeed(terminated, terminationError(instanceId, label)),
  };
});

interface RetrySleepRequest {
  readonly release: Deferred.Deferred<void>;
}

const makeGatedRetry = Effect.fn("test.makeDriverGatedRetry")(function* () {
  const requests = yield* Queue.unbounded<RetrySleepRequest>();
  return {
    requests,
    sleep: (_delay: Duration.Duration) =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        yield* Queue.offer(requests, { release });
        yield* Deferred.await(release);
      }),
  };
});

const supervisorOverride = (
  extra: Partial<CodexEndpointSupervisor.CodexEndpointSupervisorDependencies>,
): CodexDriverDependencies["makeEndpointSupervisor"] =>
  ((options: CodexEndpointSupervisor.MakeCodexEndpointSupervisorOptions) =>
    CodexEndpointSupervisor.make({
      ...options,
      dependencies: { ...options.dependencies, ...extra },
    })) as CodexDriverDependencies["makeEndpointSupervisor"];

it.layer(TestLayer)("CodexDriver endpoint integration", (it) => {
  it.effect(
    "reconnects generation 1 to 2, refreshes lifecycle snapshots, and rejects a stale start",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const instanceScope = yield* Scope.make();
          const first = yield* makeTerminationConnection(INSTANCE_ID, 1);
          const second = yield* makeTerminationConnection(INSTANCE_ID, 2);
          const retry = yield* makeGatedRetry();
          const stopped = yield* Deferred.make<void>();
          const nativeStartEntered = yield* Deferred.make<void>();
          const releaseNativeStart = yield* Deferred.make<void>();
          let adapterOptions: CodexAdapterLiveOptions | undefined;
          let endpointFactoryCalls = 0;
          let stopAllCalls = 0;
          let generationReleases = 0;

          const router = { registerSession: () => Effect.die("unused") } as CodexEndpointRouter;
          const adapter = {
            stopAll: () =>
              Effect.sync(() => {
                stopAllCalls += 1;
              }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)), Effect.asVoid),
          } as unknown as CodexAdapterShape;

          const dependencies: Partial<CodexDriverDependencies> = {
            makeEndpointSupervisor: supervisorOverride({
              retryDelay: () => Effect.succeed(Duration.zero),
              sleep: retry.sleep,
            }),
            makeEndpoint: (() =>
              Effect.gen(function* () {
                endpointFactoryCalls += 1;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    generationReleases += 1;
                  }),
                );
                return endpointFactoryCalls === 1 ? first.connection : second.connection;
              })) as CodexDriverDependencies["makeEndpoint"],
            makeEndpointRouter: (() =>
              Effect.succeed(router)) as CodexDriverDependencies["makeEndpointRouter"],
            makeEndpointRuntime: (() =>
              Effect.succeed({
                start: () =>
                  Deferred.succeed(nativeStartEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseNativeStart)),
                    Effect.as({}),
                  ),
              } as unknown as CodexSessionRuntimeShape)) as CodexDriverDependencies["makeEndpointRuntime"],
            makeAdapter: ((_config: CodexSettings, options?: CodexAdapterLiveOptions) => {
              adapterOptions = options;
              return Effect.succeed(adapter);
            }) as CodexDriverDependencies["makeAdapter"],
            checkEndpointProviderStatus: ((
              _config: CodexSettings,
              connection: typeof first.connection,
            ) =>
              Effect.succeed(
                providerDraft("ready", connection.compatibility.serverVersion),
              )) as CodexDriverDependencies["checkEndpointProviderStatus"],
            resolveHomeLayout: (() =>
              Effect.die(
                "endpoint branch resolved local home",
              )) as CodexDriverDependencies["resolveHomeLayout"],
            materializeShadowHome: (() =>
              Effect.die(
                "endpoint branch materialized local home",
              )) as CodexDriverDependencies["materializeShadowHome"],
            makeLocalTextGeneration: (() =>
              Effect.die(
                "endpoint branch constructed local text generation",
              )) as CodexDriverDependencies["makeLocalTextGeneration"],
            checkLocalProviderStatus: (() =>
              Effect.die(
                "endpoint branch ran local status probe",
              )) as CodexDriverDependencies["checkLocalProviderStatus"],
          };
          const driver = makeCodexDriver(dependencies);
          const instance = yield* driver
            .create({
              instanceId: INSTANCE_ID,
              displayName: "Remote Codex",
              accentColor: undefined,
              environment: [],
              enabled: true,
              config: ENDPOINT_CONFIG,
            })
            .pipe(Effect.provideService(Scope.Scope, instanceScope));

          assert.equal(endpointFactoryCalls, 1);
          assert.equal(
            instance.continuationIdentity.continuationKey,
            `codex:instance:${INSTANCE_ID}`,
          );
          assert.equal(instance.gatewayMcpMode, "unavailable");
          assert.isNull(instance.snapshot.maintenanceCapabilities.update);
          assert.equal((yield* instance.snapshot.getSnapshot).status, "ready");
          assert.isDefined(instance.generationLifecycle);

          // Subscribe first and then read current: a consumer created after
          // materialization still observes the initial Ready generation.
          const lifecycleChanges = yield* instance.generationLifecycle!.subscribeChanges;
          const initialGeneration = yield* instance.generationLifecycle!.getCurrent;
          assert.deepStrictEqual(initialGeneration, {
            _tag: "Ready",
            providerInstanceId: INSTANCE_ID,
            generationId: 1,
          });
          const generationTwo = yield* Deferred.make<void>();
          yield* Stream.fromSubscription(lifecycleChanges).pipe(
            Stream.runForEach((state) =>
              state._tag === "Ready" && state.generationId === 2
                ? Deferred.succeed(generationTwo, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkScoped,
          );

          const errorSnapshot = yield* Deferred.make<void>();
          const recoveredSnapshot = yield* Deferred.make<void>();
          yield* instance.snapshot.streamChanges.pipe(
            Stream.runForEach((snapshot) =>
              snapshot.status === "error"
                ? Deferred.succeed(errorSnapshot, undefined).pipe(Effect.asVoid)
                : snapshot.status === "ready" && snapshot.version === "0.2.0"
                  ? Deferred.succeed(recoveredSnapshot, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            ),
            Effect.forkScoped,
          );

          const runtimeOptions = {
            threadId: ThreadId.make("thread-remote"),
            providerInstanceId: ProviderInstanceId.make("wrong-instance"),
            binaryPath: "must-not-run",
            cwd: "/remote/workspace",
            runtimeMode: "full-access",
          } satisfies CodexSessionRuntimeOptions;
          const staleRuntime = yield* adapterOptions!.makeRuntime!(runtimeOptions);
          const staleStart = yield* staleRuntime.start().pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(nativeStartEntered);
          yield* first.terminate("disconnected");
          yield* Deferred.await(stopped);
          yield* Deferred.await(errorSnapshot);
          assert.equal(stopAllCalls, 1);
          assert.equal((yield* instance.snapshot.getSnapshot).status, "error");
          assert.equal((yield* instance.generationLifecycle!.getCurrent)._tag, "Unavailable");
          assert.equal(generationReleases, 1);

          yield* Deferred.succeed(releaseNativeStart, undefined);
          const staleStartResult = yield* Fiber.join(staleStart);
          assert.equal(staleStartResult._tag, "Failure");
          if (staleStartResult._tag === "Success") {
            return assert.fail("expected stale generation start to fail");
          }
          assert.equal(
            staleStartResult.failure._tag,
            "CodexSessionRuntimeEndpointUnavailableError",
          );

          const retryRequest = yield* Queue.take(retry.requests);
          yield* Deferred.succeed(retryRequest.release, undefined);
          yield* Deferred.await(generationTwo);
          yield* Deferred.await(recoveredSnapshot);
          assert.equal(endpointFactoryCalls, 2);
          assert.equal((yield* instance.snapshot.getSnapshot).status, "ready");
          assert.equal((yield* instance.snapshot.getSnapshot).version, "0.2.0");
          assert.equal(stopAllCalls, 1);

          const recoveredRuntime = yield* adapterOptions!.makeRuntime!(runtimeOptions).pipe(
            Effect.result,
          );
          assert.equal(recoveredRuntime._tag, "Success");

          const textGeneration = yield* instance.textGeneration
            .generateThreadTitle({
              cwd: "/remote/workspace",
              message: "title",
              modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.6-sol", options: [] },
            })
            .pipe(Effect.result);
          assert.equal(textGeneration._tag, "Failure");
          if (textGeneration._tag === "Success") {
            return assert.fail("expected endpoint text generation to fail");
          }
          assert.include(textGeneration.failure.detail, "unavailable");

          yield* Scope.close(instanceScope, Exit.void);
          assert.equal(generationReleases, 2);
        }),
      ),
  );

  it.effect("does not connect or invoke local seams for a disabled endpoint instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let endpointCalls = 0;
        let localCalls = 0;
        const adapter = { stopAll: () => Effect.void } as unknown as CodexAdapterShape;
        const driver = makeCodexDriver({
          makeEndpoint: (() => {
            endpointCalls += 1;
            return Effect.die("disabled endpoint connected");
          }) as CodexDriverDependencies["makeEndpoint"],
          makeAdapter: (() => Effect.succeed(adapter)) as CodexDriverDependencies["makeAdapter"],
          resolveHomeLayout: (() => {
            localCalls += 1;
            return Effect.die("disabled endpoint resolved local home");
          }) as CodexDriverDependencies["resolveHomeLayout"],
          materializeShadowHome: (() => {
            localCalls += 1;
            return Effect.die("disabled endpoint materialized local home");
          }) as CodexDriverDependencies["materializeShadowHome"],
          makeLocalTextGeneration: (() => {
            localCalls += 1;
            return Effect.succeed(unavailableTextGeneration);
          }) as CodexDriverDependencies["makeLocalTextGeneration"],
          checkLocalProviderStatus: (() => {
            localCalls += 1;
            return Effect.die("disabled endpoint ran local probe");
          }) as CodexDriverDependencies["checkLocalProviderStatus"],
        });

        const instance = yield* driver.create({
          instanceId: INSTANCE_ID,
          displayName: undefined,
          accentColor: undefined,
          environment: [],
          enabled: false,
          config: ENDPOINT_CONFIG,
        });
        assert.equal(endpointCalls, 0);
        assert.equal(localCalls, 0);
        assert.isFalse(instance.enabled);
        assert.equal(instance.gatewayMcpMode, "unavailable");
        assert.isNull(instance.snapshot.maintenanceCapabilities.update);
      }),
    ),
  );

  it.effect("keeps transient initial failure Retrying and permanent failure Blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const retry = yield* makeGatedRetry();
        const recovered = yield* makeTerminationConnection(INSTANCE_ID, 1);
        const directTransport = ENDPOINT_CONFIG.endpointTransport;
        if (directTransport?.type !== "direct-websocket") {
          return yield* Effect.die("expected direct WebSocket endpoint test config");
        }
        const router = { registerSession: () => Effect.die("unused") } as CodexEndpointRouter;
        const adapter = { stopAll: () => Effect.void } as unknown as CodexAdapterShape;
        let transientCalls = 0;
        const transientDriver = makeCodexDriver({
          makeEndpointSupervisor: supervisorOverride({
            retryDelay: () => Effect.succeed(Duration.zero),
            sleep: retry.sleep,
          }),
          makeEndpoint: (() => {
            transientCalls += 1;
            return transientCalls === 1
              ? Effect.fail(
                  new CodexEndpointWebSocketOpenError({
                    url: directTransport.url,
                    cause: new Error("host unavailable"),
                  }),
                )
              : Effect.succeed(recovered.connection);
          }) as CodexDriverDependencies["makeEndpoint"],
          makeEndpointRouter: (() =>
            Effect.succeed(router)) as CodexDriverDependencies["makeEndpointRouter"],
          makeAdapter: (() => Effect.succeed(adapter)) as CodexDriverDependencies["makeAdapter"],
          checkEndpointProviderStatus: (() =>
            Effect.succeed(
              providerDraft("ready", "0.1.0"),
            )) as CodexDriverDependencies["checkEndpointProviderStatus"],
        });

        const transient = yield* transientDriver.create({
          instanceId: INSTANCE_ID,
          displayName: undefined,
          accentColor: undefined,
          environment: [],
          enabled: true,
          config: ENDPOINT_CONFIG,
        });
        const retryingSnapshot = yield* transient.snapshot.getSnapshot;
        assert.equal(retryingSnapshot.status, "error");
        assert.include(retryingSnapshot.message ?? "", "will retry");
        assert.equal((yield* transient.generationLifecycle!.getCurrent)._tag, "Unavailable");

        const lifecycleChanges = yield* transient.generationLifecycle!.subscribeChanges;
        const becameReady = yield* Deferred.make<void>();
        yield* Stream.fromSubscription(lifecycleChanges).pipe(
          Stream.runForEach((state) =>
            state._tag === "Ready"
              ? Deferred.succeed(becameReady, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const retryRequest = yield* Queue.take(retry.requests);
        yield* Deferred.succeed(retryRequest.release, undefined);
        yield* Deferred.await(becameReady);
        assert.equal(transientCalls, 2);

        let blockedSleepCalls = 0;
        const blockedDriver = makeCodexDriver({
          makeEndpointSupervisor: supervisorOverride({
            sleep: () => Effect.sync(() => void (blockedSleepCalls += 1)),
          }),
          makeEndpoint: (() =>
            Effect.fail(
              new CodexEndpointUnsupportedAuthenticationError({
                authenticationType: "signed-bearer-token",
              }),
            )) as CodexDriverDependencies["makeEndpoint"],
          makeAdapter: (() => Effect.succeed(adapter)) as CodexDriverDependencies["makeAdapter"],
        });
        const blocked = yield* blockedDriver.create({
          instanceId: ProviderInstanceId.make("codex_blocked"),
          displayName: undefined,
          accentColor: undefined,
          environment: [],
          enabled: true,
          config: ENDPOINT_CONFIG,
        });
        const blockedSnapshot = yield* blocked.snapshot.getSnapshot;
        assert.equal(blockedSnapshot.status, "error");
        assert.include(blockedSnapshot.message ?? "", "blocked");
        assert.equal((yield* blocked.generationLifecycle!.getCurrent)._tag, "Unavailable");
        assert.equal(blockedSleepCalls, 0);
      }),
    ),
  );

  it.effect("isolates supervisors per instance and closes only the replaced instance scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instanceAId = ProviderInstanceId.make("codex_remote_a");
        const instanceBId = ProviderInstanceId.make("codex_remote_b");
        const connectionA = yield* makeTerminationConnection(instanceAId, 1);
        const connectionB = yield* makeTerminationConnection(instanceBId, 1);
        const retry = yield* makeGatedRetry();
        const scopeA = yield* Scope.make();
        const scopeB = yield* Scope.make();
        const stoppedA = yield* Deferred.make<void>();
        const adapterOptions = new Map<string, CodexAdapterLiveOptions>();
        const stopCalls = new Map<string, number>();
        const releases = new Map<string, number>();
        const router = { registerSession: () => Effect.die("unused") } as CodexEndpointRouter;

        const driver = makeCodexDriver({
          makeEndpointSupervisor: supervisorOverride({
            retryDelay: () => Effect.succeed(Duration.zero),
            sleep: retry.sleep,
          }),
          makeEndpoint: ((options: { readonly providerInstanceId: ProviderInstanceId }) =>
            Effect.gen(function* () {
              const id = options.providerInstanceId;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => releases.set(id, (releases.get(id) ?? 0) + 1)),
              );
              return id === instanceAId ? connectionA.connection : connectionB.connection;
            })) as CodexDriverDependencies["makeEndpoint"],
          makeEndpointRouter: (() =>
            Effect.succeed(router)) as CodexDriverDependencies["makeEndpointRouter"],
          makeEndpointRuntime: (() =>
            Effect.succeed(
              {} as CodexSessionRuntimeShape,
            )) as CodexDriverDependencies["makeEndpointRuntime"],
          makeAdapter: ((_config: CodexSettings, options?: CodexAdapterLiveOptions) =>
            Effect.gen(function* () {
              const adapterInput = options;
              if (adapterInput?.instanceId === undefined) {
                return yield* Effect.die("expected instance-bound adapter options");
              }
              const id = adapterInput.instanceId;
              adapterOptions.set(id, adapterInput);
              return {
                stopAll: () =>
                  Effect.sync(() => stopCalls.set(id, (stopCalls.get(id) ?? 0) + 1)).pipe(
                    Effect.andThen(
                      id === instanceAId
                        ? Deferred.succeed(stoppedA, undefined).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
              } as unknown as CodexAdapterShape;
            })) as CodexDriverDependencies["makeAdapter"],
          checkEndpointProviderStatus: ((
            _config: CodexSettings,
            connection: typeof connectionA.connection,
          ) =>
            Effect.succeed(
              providerDraft("ready", connection.compatibility.serverVersion),
            )) as CodexDriverDependencies["checkEndpointProviderStatus"],
        });

        const create = (instanceId: ProviderInstanceId, scope: Scope.Scope) =>
          driver
            .create({
              instanceId,
              displayName: undefined,
              accentColor: undefined,
              environment: [],
              enabled: true,
              config: ENDPOINT_CONFIG,
            })
            .pipe(Effect.provideService(Scope.Scope, scope));
        const instanceA = yield* create(instanceAId, scopeA);
        const instanceB = yield* create(instanceBId, scopeB);

        yield* connectionA.terminate();
        yield* Deferred.await(stoppedA);
        assert.equal(stopCalls.get(instanceAId), 1);
        assert.isUndefined(stopCalls.get(instanceBId));
        assert.equal((yield* instanceA.generationLifecycle!.getCurrent)._tag, "Unavailable");
        assert.deepStrictEqual(yield* instanceB.generationLifecycle!.getCurrent, {
          _tag: "Ready",
          providerInstanceId: instanceBId,
          generationId: 1,
        });

        const runtimeB = yield* adapterOptions.get(instanceBId)!.makeRuntime!({
          threadId: ThreadId.make("thread-b"),
          providerInstanceId: instanceBId,
          binaryPath: "unused",
          cwd: "/remote/b",
          runtimeMode: "full-access",
        }).pipe(Effect.result);
        assert.equal(runtimeB._tag, "Success");

        yield* Scope.close(scopeA, Exit.void);
        assert.equal(releases.get(instanceAId), 1);
        assert.isUndefined(releases.get(instanceBId));
        assert.equal((yield* instanceB.generationLifecycle!.getCurrent)._tag, "Ready");

        yield* Scope.close(scopeB, Exit.void);
        assert.equal(releases.get(instanceBId), 1);
      }),
    ),
  );

  it.effect("keeps legacy no-endpoint instances on the isolated local seams", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const localCalls: Array<string> = [];
        const endpointCalls: Array<string> = [];
        const adapter = { stopAll: () => Effect.void } as unknown as CodexAdapterShape;
        const driver = makeCodexDriver({
          makeEndpoint: (() => {
            endpointCalls.push("factory");
            return Effect.die("legacy branch connected endpoint");
          }) as CodexDriverDependencies["makeEndpoint"],
          makeEndpointRouter: (() => {
            endpointCalls.push("router");
            return Effect.die("legacy branch created endpoint router");
          }) as CodexDriverDependencies["makeEndpointRouter"],
          makeEndpointRuntime: (() => {
            endpointCalls.push("runtime");
            return Effect.die("legacy branch created endpoint runtime");
          }) as CodexDriverDependencies["makeEndpointRuntime"],
          makeAdapter: (() => Effect.succeed(adapter)) as CodexDriverDependencies["makeAdapter"],
          resolveHomeLayout: (() => {
            localCalls.push("home");
            return Effect.succeed({
              mode: "direct" as const,
              sharedHomePath: "/legacy/.codex",
              effectiveHomePath: "/legacy/.codex",
              continuationKey: "codex:home:/legacy/.codex",
            });
          }) as CodexDriverDependencies["resolveHomeLayout"],
          materializeShadowHome: (() => {
            localCalls.push("materialize");
            return Effect.void;
          }) as CodexDriverDependencies["materializeShadowHome"],
          makeLocalTextGeneration: (() => {
            localCalls.push("text-generation");
            return Effect.succeed(unavailableTextGeneration);
          }) as CodexDriverDependencies["makeLocalTextGeneration"],
          checkLocalProviderStatus: (() => {
            localCalls.push("probe");
            return Effect.succeed(providerDraft("ready"));
          }) as CodexDriverDependencies["checkLocalProviderStatus"],
        });

        const instance = yield* driver.create({
          instanceId: ProviderInstanceId.make("codex_legacy"),
          displayName: undefined,
          accentColor: undefined,
          environment: [],
          enabled: false,
          config: decodeCodexSettings({ enabled: false, homePath: "/legacy/.codex" }),
        });

        assert.deepStrictEqual(endpointCalls, []);
        assert.deepStrictEqual(localCalls, ["home", "materialize", "text-generation", "probe"]);
        assert.equal(instance.continuationIdentity.continuationKey, "codex:home:/legacy/.codex");
        assert.isUndefined(instance.gatewayMcpMode);
      }),
    ),
  );
});
