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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

function providerDraft(state: "ready" | "error") {
  return buildServerProvider({
    presentation: { displayName: "Codex", showInteractionModeToggle: true },
    enabled: true,
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    skills: [],
    probe: {
      installed: true,
      version: "0.147.0",
      status: state,
      auth: { status: "authenticated" },
      ...(state === "error" ? { message: "endpoint disconnected" } : {}),
    },
  });
}

it.layer(TestLayer)("CodexDriver endpoint integration", (it) => {
  it.effect(
    "owns one endpoint generation and fails all later starts closed after termination",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const termination =
            yield* Deferred.make<CodexEndpointConnection.CodexEndpointTerminationError>();
          const stopped = yield* Deferred.make<void>();
          const terminatedSnapshotRefreshed = yield* Deferred.make<void>();
          let terminated = false;
          let adapterOptions: CodexAdapterLiveOptions | undefined;
          const endpointFactoryCalls: Array<unknown> = [];
          const endpointRouterCalls: Array<unknown> = [];
          const endpointRuntimeCalls: Array<unknown> = [];
          let stopAllCalls = 0;

          const connection = CodexEndpointConnection.CodexEndpointConnection.of({
            identity: { providerInstanceId: INSTANCE_ID },
            client: {} as CodexEndpointConnection.CodexEndpointConnection["Service"]["client"],
            compatibility: {
              userAgent: "codex_cli_rs/0.147.0",
              serverVersion: "0.147.0",
              codexHome: "/remote/.codex",
              platformFamily: "unix",
              platformOs: "linux",
            },
            awaitTermination: Deferred.await(termination).pipe(Effect.flatMap(Effect.fail)),
          });
          const router = { registerSession: () => Effect.die("unused") } as CodexEndpointRouter;
          const adapter = {
            stopAll: () =>
              Effect.sync(() => {
                stopAllCalls += 1;
              }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)), Effect.asVoid),
          } as unknown as CodexAdapterShape;

          const dependencies: Partial<CodexDriverDependencies> = {
            makeEndpoint: ((options: unknown) => {
              endpointFactoryCalls.push(options);
              return Effect.succeed(connection);
            }) as CodexDriverDependencies["makeEndpoint"],
            makeEndpointRouter: ((client: unknown) => {
              endpointRouterCalls.push(client);
              return Effect.succeed(router);
            }) as CodexDriverDependencies["makeEndpointRouter"],
            makeEndpointRuntime: ((input: unknown) => {
              endpointRuntimeCalls.push(input);
              return Effect.succeed({} as CodexSessionRuntimeShape);
            }) as CodexDriverDependencies["makeEndpointRuntime"],
            makeAdapter: ((_config: CodexSettings, options?: CodexAdapterLiveOptions) => {
              adapterOptions = options;
              return Effect.succeed(adapter);
            }) as CodexDriverDependencies["makeAdapter"],
            checkEndpointProviderStatus: (() =>
              Effect.sync(() => providerDraft(terminated ? "error" : "ready")).pipe(
                Effect.tap(() =>
                  terminated
                    ? Deferred.succeed(terminatedSnapshotRefreshed, undefined)
                    : Effect.void,
                ),
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
          const instance = yield* driver.create({
            instanceId: INSTANCE_ID,
            displayName: "Remote Codex",
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: ENDPOINT_CONFIG,
          });

          assert.lengthOf(endpointFactoryCalls, 1);
          assert.deepStrictEqual(endpointFactoryCalls[0], {
            providerInstanceId: INSTANCE_ID,
            transport: ENDPOINT_CONFIG.endpointTransport,
          });
          assert.deepStrictEqual(endpointRouterCalls, [connection.client]);
          assert.equal(
            instance.continuationIdentity.continuationKey,
            `codex:instance:${INSTANCE_ID}`,
          );
          assert.equal(instance.gatewayMcpMode, "unavailable");
          assert.isNull(instance.snapshot.maintenanceCapabilities.update);

          const runtimeOptions = {
            threadId: ThreadId.make("thread-remote"),
            providerInstanceId: ProviderInstanceId.make("wrong-instance"),
            binaryPath: "must-not-run",
            cwd: "/remote/workspace",
            runtimeMode: "full-access",
          } satisfies CodexSessionRuntimeOptions;
          yield* adapterOptions!.makeRuntime!(runtimeOptions);
          assert.lengthOf(endpointRuntimeCalls, 1);
          const endpointRuntimeInput = endpointRuntimeCalls[0] as {
            readonly connection: unknown;
            readonly router: unknown;
            readonly options: {
              readonly providerInstanceId: ProviderInstanceId;
              readonly threadId: ThreadId;
            };
          };
          assert.equal(endpointRuntimeInput.connection, connection);
          assert.equal(endpointRuntimeInput.router, router);
          assert.equal(endpointRuntimeInput.options.providerInstanceId, INSTANCE_ID);
          assert.equal(endpointRuntimeInput.options.threadId, runtimeOptions.threadId);

          terminated = true;
          const transportCause = new CodexErrors.CodexAppServerTransportError({
            operation: "read-input-stream",
            cause: new Error("disconnected"),
          });
          yield* Deferred.succeed(
            termination,
            new CodexEndpointConnection.CodexEndpointTerminationError({
              providerInstanceId: INSTANCE_ID,
              cause: transportCause,
            }),
          );
          yield* Deferred.await(stopped);
          yield* Deferred.await(terminatedSnapshotRefreshed);
          assert.equal(stopAllCalls, 1);
          assert.equal((yield* instance.snapshot.getSnapshot).status, "error");

          const later = yield* adapterOptions!.makeRuntime!(runtimeOptions).pipe(Effect.result);
          assert.equal(later._tag, "Failure");
          if (later._tag === "Success") {
            return assert.fail("expected terminated endpoint runtime construction to fail");
          }
          assert.equal(later.failure._tag, "CodexSessionRuntimeEndpointUnavailableError");
          assert.lengthOf(endpointRuntimeCalls, 1);

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

  it.effect("maps endpoint acquisition failures to ProviderDriverError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = makeCodexDriver({
          makeEndpoint: (() =>
            Effect.fail(
              new CodexEndpointConnection.CodexEndpointInitializationTimeoutError({
                providerInstanceId: INSTANCE_ID,
                timeout: "10 seconds",
              }),
            )) as CodexDriverDependencies["makeEndpoint"],
        });

        const result = yield* driver
          .create({
            instanceId: INSTANCE_ID,
            displayName: undefined,
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: ENDPOINT_CONFIG,
          })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        if (result._tag === "Success") {
          return assert.fail("expected endpoint acquisition to fail");
        }
        assert.equal(result.failure._tag, "ProviderDriverError");
        assert.equal(result.failure.instanceId, INSTANCE_ID);
        assert.include(result.failure.detail, "Failed to connect Codex endpoint");
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
