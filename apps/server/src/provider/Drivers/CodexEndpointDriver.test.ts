import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderHostConfig, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../Layers/ProviderEventLoggersService.ts";
import * as CodexEndpointConnection from "../codexEndpoint/CodexEndpointConnection.ts";
import { CodexEndpointWebSocketOpenError } from "../codexEndpoint/CocoaHostConnector.ts";
import {
  codexEndpointLifecyclePresentation,
  makeCodexEndpointDriver,
  type CodexEndpointDriverDependencies,
} from "./CodexEndpointDriver.ts";
import {
  checkCodexEndpointProviderStatus,
  makePendingCodexEndpointProvider,
} from "./CodexEndpointProviderSnapshot.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeProviderHost = Schema.decodeSync(ProviderHostConfig);
const INSTANCE_ID = ProviderInstanceId.make("remote_codex");
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

const TestLayer = ServerConfig.layerTest(
  "/gateway/not-a-provider-workspace",
  {
    prefix: "codex-endpoint-driver-test",
  },
  { runtimeProfile: "cocoa-gateway" },
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(BackgroundPolicyNoWorkLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

const createInput = (config: CodexSettings, enabled = true, host?: ProviderHostConfig) => ({
  instanceId: INSTANCE_ID,
  ...(host === undefined ? {} : { host }),
  displayName: "Remote Codex",
  accentColor: undefined,
  environment: [],
  enabled,
  config,
});

it("normalizes endpoint lifecycle states and exposes only safe compatibility detail", () => {
  const incompatible = codexEndpointLifecyclePresentation({
    _tag: "Blocked",
    error: new CodexEndpointConnection.CodexEndpointCompatibilityError({
      providerInstanceId: INSTANCE_ID,
      method: "thread/start",
      reason: "missing",
    }),
  });
  assert.equal(incompatible.connectionState, "blocked");
  assert.include(incompatible.message, "required method 'thread/start' is missing");

  const authorizationFailure = codexEndpointLifecyclePresentation({
    _tag: "Blocked",
    error: new CodexEndpointWebSocketOpenError({
      url: "wss://host.example.test/codex",
      cause: new Error("upgrade rejected"),
      httpStatus: 401,
    }),
  });
  assert.equal(authorizationFailure.connectionState, "blocked");
  assert.notInclude(authorizationFailure.message, "host.example.test");
  assert.notInclude(authorizationFailure.message, "upgrade rejected");

  assert.equal(
    codexEndpointLifecyclePresentation({ _tag: "Connecting", attempt: 2 }).connectionState,
    "connecting",
  );
  assert.equal(
    codexEndpointLifecyclePresentation({
      _tag: "Retrying",
      attempt: 3,
      error: new CodexEndpointWebSocketOpenError({
        url: "wss://host.example.test/codex",
        cause: new Error("offline"),
      }),
      delay: null,
    }).connectionState,
    "disconnected",
  );
  assert.equal(
    codexEndpointLifecyclePresentation({ _tag: "Closed" }).connectionState,
    "disconnected",
  );
  assert.equal(
    codexEndpointLifecyclePresentation({
      _tag: "Ready",
      generationId: 1,
      compatibility: {} as never,
    }).connectionState,
    "ready",
  );
});

it.effect("stamps pending and account-blocked endpoint snapshots with connection state", () =>
  Effect.gen(function* () {
    const settings = decodeCodexSettings({
      endpointTransport: {
        type: "cocoa-host",
        url: "ws://127.0.0.1:7777",
        key: "test_host_key",
      },
    });
    assert.equal((yield* makePendingCodexEndpointProvider(settings)).connectionState, "connecting");

    const snapshot = yield* checkCodexEndpointProviderStatus(settings, {
      compatibility: { serverVersion: "0.146.0" },
      client: {
        request: () => Effect.succeed({ account: null, requiresOpenaiAuth: true }),
      },
    } as never);
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.auth.status, "unauthenticated");
    assert.equal(snapshot.connectionState, "blocked");
  }),
);

it.layer(TestLayer)("CodexEndpointDriver", (it) => {
  it.effect("fails closed only when both host and legacy endpoint transport are absent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* makeCodexEndpointDriver()
          .create(createInput(decodeCodexSettings({})))
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderDriverError");
        assert.match(
          error.detail,
          /require a resolved provider host or a legacy endpoint transport/i,
        );
      }),
    ),
  );

  it.effect("uses the resolved host transport instead of a duplicated legacy transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const legacyTransport = {
          type: "cocoa-host" as const,
          url: "wss://legacy.example.test:4500",
          key: "legacy_key",
        };
        const host = decodeProviderHost({
          transport: {
            type: "cocoa-host",
            url: "wss://host.example.test:4500",
            key: "host_key",
          },
        });
        let capturedTransport: unknown;
        const driver = makeCodexEndpointDriver({
          makeEndpointSupervisor: ((options: { readonly transport: unknown }) => {
            capturedTransport = options.transport;
            return Effect.die("stop after observing endpoint transport");
          }) as CodexEndpointDriverDependencies["makeEndpointSupervisor"],
        });

        yield* driver
          .create(
            createInput(decodeCodexSettings({ endpointTransport: legacyTransport }), true, host),
          )
          .pipe(Effect.exit);

        assert.deepStrictEqual(capturedTransport, host.transport);
        assert.notDeepEqual(capturedTransport, legacyTransport);
      }),
    ),
  );

  it.effect("retains provider-local endpoint transport as a legacy fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const legacyTransport = {
          type: "cocoa-host" as const,
          url: "wss://legacy.example.test:4500",
          key: "legacy_key",
        };
        let capturedTransport: unknown;
        const driver = makeCodexEndpointDriver({
          makeEndpointSupervisor: ((options: { readonly transport: unknown }) => {
            capturedTransport = options.transport;
            return Effect.die("stop after observing endpoint transport");
          }) as CodexEndpointDriverDependencies["makeEndpointSupervisor"],
        });

        yield* driver
          .create(createInput(decodeCodexSettings({ endpointTransport: legacyTransport })))
          .pipe(Effect.exit);

        assert.deepStrictEqual(capturedTransport, legacyTransport);
      }),
    ),
  );

  it.effect("does not acquire endpoint capabilities for a disabled instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let endpointCalls = 0;
        let capabilityCalls = 0;
        const disabledCapability = () => {
          capabilityCalls += 1;
          throw new Error("disabled endpoint constructed a provider-host capability");
        };
        const driver = makeCodexEndpointDriver({
          makeEndpointSupervisor: (() => {
            endpointCalls += 1;
            return Effect.die("disabled endpoint started a supervisor");
          }) as CodexEndpointDriverDependencies["makeEndpointSupervisor"],
          makeEndpointTerminal:
            disabledCapability as CodexEndpointDriverDependencies["makeEndpointTerminal"],
          makeEndpointExecution:
            disabledCapability as CodexEndpointDriverDependencies["makeEndpointExecution"],
          makeEndpointVcs: disabledCapability as CodexEndpointDriverDependencies["makeEndpointVcs"],
          makeEndpointWorkspace:
            disabledCapability as CodexEndpointDriverDependencies["makeEndpointWorkspace"],
          makeEndpointTextGeneration:
            disabledCapability as CodexEndpointDriverDependencies["makeEndpointTextGeneration"],
        });
        const config = decodeCodexSettings({
          endpointTerminal: { enabled: true, sandboxMode: "workspaceWrite" },
          endpointGitExecutablePath: "/usr/bin/git",
          workspaceHelper: {
            type: "cocoa-workspace-helper-v1",
            executablePath: "/usr/bin/cocoa-workspace-helper",
            expectedProtocol: 1,
          },
        });

        const host = decodeProviderHost({
          transport: {
            type: "cocoa-host",
            url: "ws://127.0.0.1:7777",
            key: "test_host_key",
          },
        });
        const instance = yield* driver.create(createInput(config, false, host));
        assert.equal(endpointCalls, 0);
        assert.equal(capabilityCalls, 0);
        assert.isFalse(instance.enabled);
        assert.equal(instance.gatewayMcpMode, "unavailable");
        assert.isUndefined(instance.workspace);
        assert.isUndefined(instance.terminal);
        assert.isUndefined(instance.execution);
        assert.isUndefined(instance.vcs);
        assert.isNull(instance.snapshot.maintenanceCapabilities.update);
        const snapshot = yield* instance.snapshot.getSnapshot;
        assert.equal(snapshot.status, "disabled");
        assert.equal(snapshot.connectionState, "disconnected");
      }),
    ),
  );
});
