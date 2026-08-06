import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
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
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import type {
  ProviderInstanceGenerationLifecycle,
  ProviderInstanceGenerationState,
} from "../ProviderDriver.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import type {
  ProviderTerminalAdapter,
  ProviderTerminalSession,
} from "../ProviderTerminalAdapter.ts";
import type { ProviderVcsAdapter } from "../ProviderVcsAdapter.ts";
import * as CodexEndpointConnection from "../codexEndpoint/CodexEndpointConnection.ts";
import type { CodexEndpointRouter } from "../codexEndpoint/CodexEndpointRouter.ts";
import * as CodexEndpointSupervisor from "../codexEndpoint/CodexEndpointSupervisor.ts";
import {
  CodexEndpointInvalidCredentialError,
  CodexEndpointWebSocketOpenError,
} from "../codexEndpoint/DirectWebSocketConnector.ts";
import { makeCodexDriver, type CodexDriverDependencies } from "./CodexDriver.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const ENDPOINT_CONFIG = decodeCodexSettings({
  endpointTransport: {
    type: "direct-websocket",
    url: "ws://127.0.0.1:7777",
    authentication: { type: "none" },
  },
});
const WORKSPACE_ENDPOINT_CONFIG = decodeCodexSettings({
  endpointTransport: {
    type: "direct-websocket",
    url: "ws://127.0.0.1:7777",
    authentication: { type: "none" },
  },
  workspaceHelper: {
    type: "cocoa-workspace-helper-v1",
    executablePath: "/run/current-system/sw/bin/cocoa-workspace-helper",
    expectedProtocol: 1,
  },
  endpointGitExecutablePath: "/run/current-system/sw/bin/git",
  checkpointHelper: {
    type: "cocoa-checkpoint-helper-v1",
    executablePath: "/run/current-system/sw/bin/cocoa-checkpoint-helper",
    expectedProtocol: 1,
  },
});
const TERMINAL_ENDPOINT_CONFIG = decodeCodexSettings({
  endpointTransport: {
    type: "direct-websocket",
    url: "ws://127.0.0.1:7777",
    authentication: { type: "none" },
  },
  endpointTerminal: { enabled: true, sandboxMode: "workspaceWrite" },
});
const TERMINAL_WORKSPACE_ENDPOINT_CONFIG = decodeCodexSettings({
  endpointTransport: {
    type: "direct-websocket",
    url: "ws://127.0.0.1:7777",
    authentication: { type: "none" },
  },
  endpointTerminal: { enabled: true, sandboxMode: "dangerFullAccess" },
  endpointGitExecutablePath: "/run/current-system/sw/bin/git",
  workspaceHelper: {
    type: "cocoa-workspace-helper-v1",
    executablePath: "/run/current-system/sw/bin/cocoa-workspace-helper",
    expectedProtocol: 1,
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
  capabilityOverrides: Partial<CodexEndpointConnection.CodexEndpointNativeCapabilities> = {},
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
        versionRelation: "baseline",
        capabilities: {
          conversation: true,
          conversationRead: true,
          checkedConversationRollback: true,
          commandExec: true,
          commandExecControl: true,
          methods: {
            "thread/start": "available",
            "thread/resume": "available",
            "turn/start": "available",
            "turn/interrupt": "available",
            "thread/read": "available",
            "thread/rollback": "available",
            "command/exec": "available",
            "command/exec/write": "available",
            "command/exec/resize": "available",
            "command/exec/terminate": "available",
          },
          ...capabilityOverrides,
        },
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

const awaitGenerationState = Effect.fn("test.awaitDriverGenerationState")(function* (
  lifecycle: ProviderInstanceGenerationLifecycle,
  predicate: (state: ProviderInstanceGenerationState) => boolean,
) {
  const changes = yield* lifecycle.subscribeChanges;
  const observed = yield* Deferred.make<ProviderInstanceGenerationState>();
  yield* Stream.fromSubscription(changes).pipe(
    Stream.runForEach((state) =>
      predicate(state) ? Deferred.succeed(observed, state).pipe(Effect.asVoid) : Effect.void,
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const current = yield* lifecycle.getCurrent;
  return predicate(current) ? current : yield* Deferred.await(observed);
});

const awaitSnapshot = Effect.fn("test.awaitDriverSnapshot")(function* (
  snapshot: ServerProviderShape,
  predicate: (state: ServerProvider) => boolean,
) {
  const observed = yield* Deferred.make<ServerProvider>();
  yield* snapshot.streamChanges.pipe(
    Stream.runForEach((state) =>
      predicate(state) ? Deferred.succeed(observed, state).pipe(Effect.asVoid) : Effect.void,
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const current = yield* snapshot.getSnapshot;
  return predicate(current) ? current : yield* Deferred.await(observed);
});

it.layer(TestLayer)("CodexDriver endpoint integration", (it) => {
  it.effect(
    "reconnects generation 1 to 2, refreshes lifecycle snapshots, and rejects a stale start",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const instanceScope = yield* Scope.make();
          const first = yield* makeTerminationConnection(INSTANCE_ID, 1);
          const second = yield* makeTerminationConnection(INSTANCE_ID, 2, {
            conversationRead: false,
            checkedConversationRollback: false,
            commandExec: false,
            commandExecControl: false,
          });
          const retry = yield* makeGatedRetry();
          const stopped = yield* Deferred.make<void>();
          const nativeStartEntered = yield* Deferred.make<void>();
          const releaseNativeStart = yield* Deferred.make<void>();
          let adapterOptions: CodexAdapterLiveOptions | undefined;
          let endpointFactoryCalls = 0;
          let stopAllCalls = 0;
          let generationReleases = 0;
          let workspaceFactoryCalls = 0;
          let vcsFactoryCalls = 0;
          const workspaceGenerations: Array<number> = [];
          const vcsGenerations: Array<number> = [];
          const textGenerationGenerations: Array<number> = [];
          let vcsFactoryPath: string | undefined;
          let vcsFactoryProviderInstanceId: ProviderInstanceId | undefined;
          let vcsFactoryCheckpointHelper: CodexSettings["checkpointHelper"];
          let endpointTextGenerationFactoryCalls = 0;

          const router = {
            registerSession: () => Effect.die("unused"),
            registerInternalOperation: () => Effect.die("unused"),
          } as CodexEndpointRouter;

          const adapter = {
            capabilities: {
              sessionModelSwitch: "in-session",
              conversationRead: "ordered-turn-ids-v1",
              checkedConversationRollback: "ordered-turn-ids-v1",
              conversationReconciliation: "ordered-turn-state-v1",
            },
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
            makeEndpointWorkspace: ((options) => {
              workspaceFactoryCalls += 1;
              return {
                browseDirectory: () => Effect.die("unused"),
                openRoot: () =>
                  Effect.gen(function* () {
                    const borrowed = yield* options.borrowConnection;
                    yield* borrowed.ensureCurrent;
                    workspaceGenerations.push(borrowed.generationId);
                    yield* borrowed.ensureCurrent;
                    return {
                      getMetadata: () => Effect.die("unused"),
                      listDirectory: () => Effect.die("unused"),
                      listEntries: () => Effect.die("unused"),
                      readFile: () => Effect.die("unused"),
                    };
                  }).pipe(Effect.orDie),
              };
            }) as CodexDriverDependencies["makeEndpointWorkspace"],
            makeEndpointVcs: ((options) => {
              vcsFactoryCalls += 1;
              vcsFactoryPath = options.gitExecutablePath;
              vcsFactoryProviderInstanceId = options.providerInstanceId;
              vcsFactoryCheckpointHelper = options.checkpointHelper;
              return {
                openRepository: () =>
                  Effect.gen(function* () {
                    const borrowed = yield* options.borrowConnection;
                    yield* borrowed.ensureCurrent;
                    vcsGenerations.push(borrowed.generationId);
                    yield* borrowed.ensureCurrent;
                    return { _tag: "NotRepository" as const };
                  }).pipe(Effect.orDie),
              } satisfies ProviderVcsAdapter;
            }) as CodexDriverDependencies["makeEndpointVcs"],
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
            makeEndpointTextGeneration: ((options) => {
              endpointTextGenerationFactoryCalls += 1;
              assert.equal(options.providerInstanceId, INSTANCE_ID);
              return Effect.succeed({
                generateCommitMessage: () => Effect.die("unused"),
                generatePrContent: () => Effect.die("unused"),
                generateBranchName: () => Effect.die("unused"),
                generateThreadTitle: () =>
                  options.borrowRoutedConnection.pipe(
                    Effect.tap((borrowed) => borrowed.ensureCurrent),
                    Effect.tap((borrowed) =>
                      Effect.sync(() => textGenerationGenerations.push(borrowed.generationId)),
                    ),
                    Effect.as({ title: "Endpoint title" }),
                    Effect.orDie,
                  ),
              } satisfies TextGeneration["Service"]);
            }) as CodexDriverDependencies["makeEndpointTextGeneration"],
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
              environment: [
                {
                  name: "OPENAI_API_KEY",
                  value: "must-not-be-captured-by-endpoint-adapter",
                  sensitive: true,
                },
              ],
              enabled: true,
              config: WORKSPACE_ENDPOINT_CONFIG,
            })
            .pipe(Effect.provideService(Scope.Scope, instanceScope));

          yield* awaitGenerationState(
            instance.generationLifecycle!,
            (state) => state._tag === "Ready" && state.generationId === 1,
          );
          yield* awaitSnapshot(
            instance.snapshot,
            (snapshot) => snapshot.status === "ready" && snapshot.version === "0.1.0",
          );

          assert.equal(endpointFactoryCalls, 1);
          assert.deepStrictEqual(adapterOptions?.environment, {});
          assert.equal(workspaceFactoryCalls, 1);
          assert.equal(vcsFactoryCalls, 1);
          assert.equal(endpointTextGenerationFactoryCalls, 1);
          assert.equal(vcsFactoryPath, "/run/current-system/sw/bin/git");
          assert.equal(vcsFactoryProviderInstanceId, INSTANCE_ID);
          assert.deepStrictEqual(
            vcsFactoryCheckpointHelper,
            WORKSPACE_ENDPOINT_CONFIG.checkpointHelper,
          );
          assert.isDefined(instance.workspace);
          assert.isDefined(instance.vcs);
          assert.equal(instance.adapter.capabilities.conversationRead, "ordered-turn-ids-v1");
          assert.equal(
            instance.adapter.capabilities.checkedConversationRollback,
            "ordered-turn-ids-v1",
          );
          assert.equal(
            instance.adapter.capabilities.conversationReconciliation,
            "ordered-turn-state-v1",
          );
          assert.deepStrictEqual(workspaceGenerations, []);
          assert.deepStrictEqual(vcsGenerations, []);
          assert.deepStrictEqual(textGenerationGenerations, []);
          yield* instance.workspace!.openRoot("/remote/workspace");
          yield* instance.vcs!.openRepository("/remote/workspace");
          const initialTextGeneration = yield* instance.textGeneration.generateThreadTitle({
            providerInstanceId: INSTANCE_ID,
            cwd: "/remote/workspace",
            message: "title",
            modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.6-sol", options: [] },
          });
          assert.equal(initialTextGeneration.title, "Endpoint title");
          assert.deepStrictEqual(workspaceGenerations, [1]);
          assert.deepStrictEqual(vcsGenerations, [1]);
          assert.deepStrictEqual(textGenerationGenerations, [1]);
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
          assert.isUndefined(instance.workspace);
          assert.isUndefined(instance.vcs);
          assert.equal(instance.adapter.capabilities.conversationRead, "unsupported");
          assert.equal(instance.adapter.capabilities.checkedConversationRollback, "unsupported");
          assert.equal(instance.adapter.capabilities.conversationReconciliation, "unsupported");
          assert.deepStrictEqual(workspaceGenerations, [1]);
          assert.deepStrictEqual(vcsGenerations, [1]);

          const recoveredRuntime = yield* adapterOptions!.makeRuntime!(runtimeOptions).pipe(
            Effect.result,
          );
          assert.equal(recoveredRuntime._tag, "Success");

          const textGeneration = yield* instance.textGeneration
            .generateThreadTitle({
              providerInstanceId: INSTANCE_ID,
              cwd: "/remote/workspace",
              message: "title",
              modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.6-sol", options: [] },
            })
            .pipe(Effect.result);
          assert.equal(textGeneration._tag, "Success");
          if (textGeneration._tag === "Success") {
            assert.deepStrictEqual(textGeneration.success, { title: "Endpoint title" });
          }
          assert.deepStrictEqual(textGenerationGenerations, [1, 2]);

          yield* Scope.close(instanceScope, Exit.void);
          assert.equal(generationReleases, 2);
        }),
      ),
  );

  it.effect("uses a provider-scoped connection borrow for endpoint status checks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instanceScope = yield* Scope.make();
        const endpoint = yield* makeTerminationConnection(INSTANCE_ID, 1);
        const adapter = { stopAll: () => Effect.void } as unknown as CodexAdapterShape;
        let connectionBorrowCalls = 0;
        const fabricatedThreadIds: Array<ThreadId> = [];

        const driver = makeCodexDriver({
          makeEndpointSupervisor: (() =>
            Effect.gen(function* () {
              const changes =
                yield* PubSub.unbounded<CodexEndpointSupervisor.CodexEndpointSupervisorState>();
              yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
              return {
                start: () => Effect.void,
                borrow: (threadId: ThreadId) =>
                  Effect.sync(() => {
                    fabricatedThreadIds.push(threadId);
                  }).pipe(Effect.andThen(Effect.die("provider status must not borrow a session"))),
                borrowConnection: Effect.sync(() => {
                  connectionBorrowCalls += 1;
                  return {
                    generationId: 1,
                    connection: endpoint.connection,
                    ensureCurrent: Effect.void,
                  };
                }),
                borrowRoutedConnection: Effect.die("routed borrow unused"),
                getState: Effect.succeed({
                  _tag: "Ready" as const,
                  generationId: 1,
                  compatibility: endpoint.connection.compatibility,
                }),
                subscribeChanges: PubSub.subscribe(changes),
              } satisfies CodexEndpointSupervisor.CodexEndpointSupervisor;
            })) as CodexDriverDependencies["makeEndpointSupervisor"],
          makeAdapter: ((_config: CodexSettings, options?: CodexAdapterLiveOptions) => {
            assert.deepStrictEqual(options?.environment, {});
            return Effect.succeed(adapter);
          }) as CodexDriverDependencies["makeAdapter"],
          makeEndpointWorkspace: (() =>
            Effect.die(
              "workspace factory called without helper",
            )) as unknown as CodexDriverDependencies["makeEndpointWorkspace"],
          makeEndpointTerminal: (() =>
            Effect.die(
              "terminal factory called while disabled by default",
            )) as CodexDriverDependencies["makeEndpointTerminal"],
          makeEndpointVcs: (() => {
            throw new Error("VCS factory called without an explicit Git executable");
          }) as CodexDriverDependencies["makeEndpointVcs"],
          checkEndpointProviderStatus: ((_config: CodexSettings, connection: unknown) => {
            assert.strictEqual(connection, endpoint.connection);
            return Effect.succeed(providerDraft("ready", "0.1.0"));
          }) as CodexDriverDependencies["checkEndpointProviderStatus"],
        });

        const instance = yield* driver
          .create({
            instanceId: INSTANCE_ID,
            displayName: undefined,
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: ENDPOINT_CONFIG,
          })
          .pipe(Effect.provideService(Scope.Scope, instanceScope));

        assert.isAbove(connectionBorrowCalls, 0);
        assert.deepStrictEqual(fabricatedThreadIds, []);
        assert.isUndefined(instance.workspace);
        assert.isUndefined(instance.terminal);
        assert.isUndefined(instance.vcs);
        assert.equal((yield* instance.snapshot.getSnapshot).status, "ready");
        yield* Scope.close(instanceScope, Exit.void);
      }),
    ),
  );

  it.effect("hydrates while the shared conversation and terminal connector remains pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instanceScope = yield* Scope.make("sequential");
        const connectorStarts = yield* Queue.unbounded<number>();
        const connectorInterruptions = yield* Queue.unbounded<number>();
        let connectorCount = 0;

        const adapter = { stopAll: () => Effect.void } as unknown as CodexAdapterShape;
        const driver = makeCodexDriver({
          makeEndpoint: (() =>
            Effect.suspend(() => {
              const connectorId = ++connectorCount;
              return Queue.offer(connectorStarts, connectorId).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Queue.offer(connectorInterruptions, connectorId).pipe(Effect.asVoid),
                ),
              );
            })) as CodexDriverDependencies["makeEndpoint"],
          makeAdapter: (() => Effect.succeed(adapter)) as CodexDriverDependencies["makeAdapter"],
          makeEndpointTerminal: (() =>
            Effect.succeed({
              start: () => Effect.die("pending terminal connector must not be borrowed"),
            } satisfies ProviderTerminalAdapter)) as CodexDriverDependencies["makeEndpointTerminal"],
        });

        const instance = yield* driver
          .create({
            instanceId: INSTANCE_ID,
            displayName: undefined,
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: TERMINAL_ENDPOINT_CONFIG,
          })
          .pipe(Effect.provideService(Scope.Scope, instanceScope));

        assert.equal((yield* instance.snapshot.getSnapshot).status, "warning");
        assert.deepStrictEqual(yield* instance.generationLifecycle!.getCurrent, {
          _tag: "Unavailable",
          providerInstanceId: INSTANCE_ID,
        });
        assert.isUndefined(instance.terminal);
        assert.equal(yield* Queue.take(connectorStarts), 1);
        assert.equal(connectorCount, 1);

        yield* Scope.close(instanceScope, Exit.void);
        assert.equal(yield* Queue.take(connectorInterruptions), 1);
        assert.equal((yield* instance.generationLifecycle!.getCurrent)._tag, "Unavailable");
      }),
    ),
  );

  it.effect("borrows explicit terminal access from the single shared endpoint supervisor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instanceScope = yield* Scope.make();
        const conversationOne = yield* makeTerminationConnection(INSTANCE_ID, 1);
        const conversationTwo = yield* makeTerminationConnection(INSTANCE_ID, 2);
        const transports: Array<unknown> = [];
        let startCalls = 0;
        let releaseCalls = 0;
        const terminalStartConnections: Array<unknown> = [];
        let supervisorCount = 0;
        let conversationCurrent = conversationOne.connection;
        let conversationStopCalls = 0;
        let invalidateConversation:
          | ((
              event: CodexEndpointSupervisor.CodexEndpointGenerationInvalidated,
            ) => Effect.Effect<void>)
          | undefined;
        let terminalFactoryInput:
          | {
              readonly providerInstanceId: ProviderInstanceId;
              readonly sandboxMode: "workspaceWrite" | "dangerFullAccess";
            }
          | undefined;

        const adapter = {
          stopAll: () =>
            Effect.sync(() => {
              conversationStopCalls += 1;
            }),
        } as unknown as CodexAdapterShape;
        const terminalSession: ProviderTerminalSession = {
          write: () => Effect.void,
          resize: () => Effect.void,
          terminate: Effect.void,
        };

        const driver = makeCodexDriver({
          makeEndpointSupervisor: ((options) =>
            Effect.gen(function* () {
              supervisorCount += 1;
              transports.push(options.transport);
              const changes =
                yield* PubSub.unbounded<CodexEndpointSupervisor.CodexEndpointSupervisorState>();
              yield* Effect.addFinalizer(() =>
                PubSub.shutdown(changes).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      releaseCalls += 1;
                    }),
                  ),
                ),
              );

              return {
                start: (startOptions) =>
                  Effect.sync(() => {
                    startCalls += 1;
                    invalidateConversation = (
                      event: CodexEndpointSupervisor.CodexEndpointGenerationInvalidated,
                    ) => startOptions.onGenerationInvalidated(event).pipe(Effect.ignore);
                  }),
                borrow: () => Effect.die("session borrow unused"),
                borrowConnection: Effect.sync(() => ({
                  generationId: conversationCurrent === conversationOne.connection ? 1 : 2,
                  connection: conversationCurrent,
                  ensureCurrent: Effect.void,
                })),
                borrowRoutedConnection: Effect.die("routed borrow unused"),
                getState: Effect.sync(() => ({
                  _tag: "Ready" as const,
                  generationId: conversationCurrent === conversationOne.connection ? 1 : 2,
                  compatibility: conversationCurrent.compatibility,
                })),
                subscribeChanges: PubSub.subscribe(changes),
              } satisfies CodexEndpointSupervisor.CodexEndpointSupervisor;
            })) as CodexDriverDependencies["makeEndpointSupervisor"],
          makeAdapter: (() => Effect.succeed(adapter)) as CodexDriverDependencies["makeAdapter"],
          makeEndpointTerminal: ((options) => {
            terminalFactoryInput = options;
            return Effect.succeed({
              start: () =>
                options.borrowConnection.pipe(
                  Effect.tap((borrowed) =>
                    Effect.sync(() => {
                      terminalStartConnections.push(borrowed.connection);
                    }),
                  ),
                  Effect.as(terminalSession),
                  Effect.orDie,
                ),
            } satisfies ProviderTerminalAdapter);
          }) as CodexDriverDependencies["makeEndpointTerminal"],
          makeEndpointWorkspace: (() =>
            Effect.die(
              "workspace factory called without helper",
            )) as unknown as CodexDriverDependencies["makeEndpointWorkspace"],
          checkEndpointProviderStatus: ((_config: CodexSettings, connection: unknown) => {
            assert.strictEqual(connection, conversationOne.connection);
            return Effect.succeed(providerDraft("ready", "0.1.0"));
          }) as CodexDriverDependencies["checkEndpointProviderStatus"],
        });

        const instance = yield* driver
          .create({
            instanceId: INSTANCE_ID,
            displayName: undefined,
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: TERMINAL_ENDPOINT_CONFIG,
          })
          .pipe(Effect.provideService(Scope.Scope, instanceScope));

        assert.equal(supervisorCount, 1);
        assert.equal(startCalls, 1);
        assert.lengthOf(transports, 1);
        assert.strictEqual(transports[0], TERMINAL_ENDPOINT_CONFIG.endpointTransport);
        assert.equal(terminalFactoryInput?.providerInstanceId, INSTANCE_ID);
        assert.equal(terminalFactoryInput?.sandboxMode, "workspaceWrite");
        assert.isDefined(instance.terminal);

        yield* instance.terminal!.start({} as never, () => Effect.void).pipe(Effect.scoped);
        assert.deepStrictEqual(terminalStartConnections, [conversationOne.connection]);

        const endpointFailure = new CodexEndpointWebSocketOpenError({
          url: "ws://127.0.0.1:7777",
          cause: new Error("shared endpoint transport failed"),
        });
        conversationCurrent = conversationTwo.connection;
        yield* invalidateConversation!({ generationId: 1, error: endpointFailure });
        yield* instance.terminal!.start({} as never, () => Effect.void).pipe(Effect.scoped);
        assert.equal(conversationStopCalls, 1);
        assert.deepStrictEqual(terminalStartConnections, [
          conversationOne.connection,
          conversationTwo.connection,
        ]);

        yield* Scope.close(instanceScope, Exit.void);
        assert.equal(releaseCalls, 1);
      }),
    ),
  );

  it.effect("does not connect or invoke local seams for a disabled endpoint instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let endpointCalls = 0;
        let localCalls = 0;
        let terminalCalls = 0;
        let vcsCalls = 0;
        let workspaceCalls = 0;
        let adapterOptions: CodexAdapterLiveOptions | undefined;
        const adapter = { stopAll: () => Effect.void } as unknown as CodexAdapterShape;
        const driver = makeCodexDriver({
          makeEndpoint: (() => {
            endpointCalls += 1;
            return Effect.die("disabled endpoint connected");
          }) as CodexDriverDependencies["makeEndpoint"],
          makeAdapter: ((_config: CodexSettings, options?: CodexAdapterLiveOptions) => {
            adapterOptions = options;
            return Effect.succeed(adapter);
          }) as CodexDriverDependencies["makeAdapter"],
          makeEndpointWorkspace: (() => {
            workspaceCalls += 1;
            throw new Error("disabled endpoint created workspace adapter");
          }) as CodexDriverDependencies["makeEndpointWorkspace"],
          makeEndpointTerminal: (() => {
            terminalCalls += 1;
            return Effect.die("disabled endpoint created terminal adapter");
          }) as CodexDriverDependencies["makeEndpointTerminal"],
          makeEndpointVcs: (() => {
            vcsCalls += 1;
            throw new Error("disabled endpoint created VCS adapter");
          }) as CodexDriverDependencies["makeEndpointVcs"],
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
          environment: [
            {
              name: "OPENAI_API_KEY",
              value: "must-not-be-captured-by-disabled-endpoint-adapter",
              sensitive: true,
            },
          ],
          enabled: false,
          config: TERMINAL_WORKSPACE_ENDPOINT_CONFIG,
        });
        assert.equal(endpointCalls, 0);
        assert.equal(localCalls, 0);
        assert.equal(terminalCalls, 0);
        assert.equal(vcsCalls, 0);
        assert.equal(workspaceCalls, 0);
        assert.deepStrictEqual(adapterOptions?.environment, {});
        assert.isUndefined(instance.workspace);
        assert.isUndefined(instance.terminal);
        assert.isUndefined(instance.vcs);
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
        const router = {
          registerSession: () => Effect.die("unused"),
          registerInternalOperation: () => Effect.die("unused"),
        } as CodexEndpointRouter;
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
        const retryingSnapshot = yield* awaitSnapshot(
          transient.snapshot,
          (snapshot) =>
            snapshot.status === "error" && (snapshot.message ?? "").includes("will retry"),
        );
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
              new CodexEndpointInvalidCredentialError({
                path: "/run/secrets/codex-signing-key",
                reason: "too-short",
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
        const blockedSnapshot = yield* awaitSnapshot(
          blocked.snapshot,
          (snapshot) => snapshot.status === "error" && (snapshot.message ?? "").includes("blocked"),
        );
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
        const router = {
          registerSession: () => Effect.die("unused"),
          registerInternalOperation: () => Effect.die("unused"),
        } as CodexEndpointRouter;

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

        yield* awaitGenerationState(
          instanceA.generationLifecycle!,
          (state) => state._tag === "Ready",
        );
        yield* awaitGenerationState(
          instanceB.generationLifecycle!,
          (state) => state._tag === "Ready",
        );

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
        let workspaceCalls = 0;
        let terminalCalls = 0;
        let vcsCalls = 0;
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
          makeEndpointWorkspace: (() => {
            workspaceCalls += 1;
            throw new Error("legacy branch created workspace adapter");
          }) as CodexDriverDependencies["makeEndpointWorkspace"],
          makeEndpointTerminal: (() => {
            terminalCalls += 1;
            return Effect.die("legacy branch created terminal adapter");
          }) as CodexDriverDependencies["makeEndpointTerminal"],
          makeEndpointVcs: (() => {
            vcsCalls += 1;
            throw new Error("legacy branch created VCS adapter");
          }) as CodexDriverDependencies["makeEndpointVcs"],
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
          config: decodeCodexSettings({
            enabled: false,
            endpointTerminal: { enabled: true, sandboxMode: "workspaceWrite" },
            endpointGitExecutablePath: "/run/current-system/sw/bin/git",
            homePath: "/legacy/.codex",
            workspaceHelper: {
              type: "cocoa-workspace-helper-v1",
              executablePath: "/run/current-system/sw/bin/cocoa-workspace-helper",
              expectedProtocol: 1,
            },
          }),
        });

        assert.deepStrictEqual(endpointCalls, []);
        assert.equal(workspaceCalls, 0);
        assert.equal(terminalCalls, 0);
        assert.equal(vcsCalls, 0);
        assert.isUndefined(instance.workspace);
        assert.isUndefined(instance.terminal);
        assert.isUndefined(instance.vcs);
        assert.deepStrictEqual(localCalls, ["home", "materialize", "text-generation", "probe"]);
        assert.equal(instance.continuationIdentity.continuationKey, "codex:home:/legacy/.codex");
        assert.isUndefined(instance.gatewayMcpMode);
      }),
    ),
  );
});
