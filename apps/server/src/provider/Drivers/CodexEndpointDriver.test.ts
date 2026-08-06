import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
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
import { CodexEndpointInvalidCredentialError } from "../codexEndpoint/DirectWebSocketConnector.ts";
import * as CodexEndpointConnection from "../codexEndpoint/CodexEndpointConnection.ts";
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

const createInput = (config: CodexSettings, enabled = true) => ({
  instanceId: INSTANCE_ID,
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

  const credentialPath = "/run/secrets/highly-sensitive-key-name";
  const credentialFailure = codexEndpointLifecyclePresentation({
    _tag: "Blocked",
    error: new CodexEndpointInvalidCredentialError({
      path: credentialPath,
      reason: "too-short",
    }),
  });
  assert.equal(credentialFailure.connectionState, "blocked");
  assert.notInclude(credentialFailure.message, credentialPath);
  assert.notInclude(credentialFailure.message, "too-short");

  assert.equal(
    codexEndpointLifecyclePresentation({ _tag: "Connecting", attempt: 2 }).connectionState,
    "connecting",
  );
  assert.equal(
    codexEndpointLifecyclePresentation({
      _tag: "Retrying",
      attempt: 3,
      error: new CodexEndpointInvalidCredentialError({ path: credentialPath, reason: "too-short" }),
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
        type: "direct-websocket",
        url: "ws://127.0.0.1:7777",
        authentication: { type: "none" },
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
  it.effect("fails closed when endpoint transport is absent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* makeCodexEndpointDriver()
          .create(createInput(decodeCodexSettings({})))
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderDriverError");
        assert.match(error.detail, /require an explicit endpoint transport/i);
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
          endpointTransport: {
            type: "direct-websocket",
            url: "ws://127.0.0.1:7777",
            authentication: { type: "none" },
          },
          endpointTerminal: { enabled: true, sandboxMode: "workspaceWrite" },
          endpointGitExecutablePath: "/usr/bin/git",
          workspaceHelper: {
            type: "cocoa-workspace-helper-v1",
            executablePath: "/usr/bin/cocoa-workspace-helper",
            expectedProtocol: 1,
          },
        });

        const instance = yield* driver.create(createInput(config, false));
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
