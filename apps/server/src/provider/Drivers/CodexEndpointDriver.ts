/** Endpoint-only Codex driver used by the Cocoa production catalog. */
import {
  CodexSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeCodexEndpointTextGeneration } from "../../textGeneration/CodexEndpointTextGeneration.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapterCore } from "../Layers/CodexAdapterCore.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggersService.ts";
import {
  CodexSessionRuntimeEndpointUnavailableError,
  makeCodexEndpointSessionRuntime,
} from "../Layers/CodexSessionRuntimeCore.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  createProviderVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "../ProviderMaintenancePolicy.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
  type ProviderInstanceGenerationState,
} from "../ProviderDriver.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import * as CodexEndpointFactory from "../codexEndpoint/CodexEndpointFactory.ts";
import type {
  CodexEndpointCompatibilityMetadata,
  CodexEndpointCompatibilityError,
} from "../codexEndpoint/CodexEndpointConnection.ts";
import { makeCodexExecutionAdapter } from "../codexEndpoint/CodexExecutionAdapter.ts";
import { makeCodexEndpointRouter } from "../codexEndpoint/CodexEndpointRouter.ts";
import * as CodexEndpointSupervisor from "../codexEndpoint/CodexEndpointSupervisor.ts";
import { makeCodexTerminalAdapter } from "../codexTerminal/CodexTerminalAdapter.ts";
import { makeCodexVcsAdapter } from "../codexVcs/CodexVcsAdapter.ts";
import { makeCodexWorkspaceAdapter } from "../codexWorkspace/CodexWorkspaceAdapter.ts";
import {
  checkCodexEndpointProviderStatus,
  makePendingCodexEndpointProvider,
  type CodexEndpointProviderDraft,
} from "./CodexEndpointProviderSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("codex");
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const protocolCompatibilityMessage = (error: CodexEndpointCompatibilityError): string =>
  `The Codex endpoint protocol is incompatible: required method '${error.method}' is ${error.reason}. Update Codex on the provider host or adjust the provider configuration.`;

export const codexEndpointLifecyclePresentation = (
  state: CodexEndpointSupervisor.CodexEndpointSupervisorState,
): Pick<CodexEndpointProviderDraft, "status" | "message" | "connectionState"> => {
  switch (state._tag) {
    case "Connecting":
      return {
        status: "warning",
        connectionState: "connecting",
        message: `Connecting to the Codex endpoint (attempt ${state.attempt}).`,
      };
    case "Retrying":
      return {
        status: "error",
        connectionState: "disconnected",
        message: `The Codex endpoint connection was interrupted and will retry (attempt ${state.attempt}).`,
      };
    case "Blocked":
      return {
        status: "error",
        connectionState: "blocked",
        message:
          state.error._tag === "CodexEndpointCompatibilityError"
            ? protocolCompatibilityMessage(state.error)
            : "The Codex endpoint connection is blocked by its configuration or authentication. Update the provider settings to retry.",
      };
    case "Closed":
      return {
        status: "error",
        connectionState: "disconnected",
        message: "The Codex endpoint connection is closed.",
      };
    case "Ready":
      return {
        status: "warning",
        connectionState: "ready",
        message: "The Codex endpoint is ready; provider status is being refreshed.",
      };
  }
};

type CodexTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const makeUnavailableTextGeneration = (
  instanceId: ProviderInstance["instanceId"],
): TextGeneration.TextGeneration["Service"] => {
  const unavailable = (operation: CodexTextGenerationOperation) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `Text generation is unavailable for endpoint-backed Codex instance '${instanceId}'.`,
      }),
    );
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: () => unavailable("generateCommitMessage"),
    generatePrContent: () => unavailable("generatePrContent"),
    generateBranchName: () => unavailable("generateBranchName"),
    generateThreadTitle: () => unavailable("generateThreadTitle"),
  });
};

export interface CodexEndpointDriverDependencies {
  readonly makeEndpointSupervisor: typeof CodexEndpointSupervisor.make;
  readonly makeEndpoint: typeof CodexEndpointFactory.make;
  readonly makeEndpointRouter: typeof makeCodexEndpointRouter;
  readonly makeEndpointRuntime: typeof makeCodexEndpointSessionRuntime;
  readonly makeEndpointTextGeneration: typeof makeCodexEndpointTextGeneration;
  readonly makeEndpointTerminal: typeof makeCodexTerminalAdapter;
  readonly makeEndpointExecution: typeof makeCodexExecutionAdapter;
  readonly makeEndpointVcs: typeof makeCodexVcsAdapter;
  readonly makeEndpointWorkspace: typeof makeCodexWorkspaceAdapter;
  readonly checkEndpointProviderStatus: typeof checkCodexEndpointProviderStatus;
}

const defaultDependencies: CodexEndpointDriverDependencies = {
  makeEndpointSupervisor: CodexEndpointSupervisor.make,
  makeEndpoint: CodexEndpointFactory.make,
  makeEndpointRouter: makeCodexEndpointRouter,
  makeEndpointRuntime: makeCodexEndpointSessionRuntime,
  makeEndpointTextGeneration: makeCodexEndpointTextGeneration,
  makeEndpointTerminal: makeCodexTerminalAdapter,
  makeEndpointExecution: makeCodexExecutionAdapter,
  makeEndpointVcs: makeCodexVcsAdapter,
  makeEndpointWorkspace: makeCodexWorkspaceAdapter,
  checkEndpointProviderStatus: checkCodexEndpointProviderStatus,
};

export type CodexEndpointDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: CodexEndpointProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const makeCodexEndpointDriver = (
  overrides: Partial<CodexEndpointDriverDependencies> = {},
): ProviderDriver<CodexSettings, CodexEndpointDriverEnv> => {
  const dependencies = { ...defaultDependencies, ...overrides };
  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "Codex", supportsMultipleInstances: true },
    configSchema: CodexSettings,
    defaultConfig: () => decodeCodexSettings({}),
    create: ({ instanceId, displayName, accentColor, enabled, config }) =>
      Effect.gen(function* () {
        if (config.endpointTransport === undefined) {
          return yield* new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Cocoa Codex instances require an explicit endpoint transport.",
          });
        }

        const serverSettings = yield* ServerSettingsService;
        const eventLoggers = yield* ProviderEventLoggers;
        const mapDriverError = (detail: string, cause: unknown) =>
          new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail, cause });
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        });
        const stampIdentity = withInstanceIdentity({
          instanceId,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const effectiveConfig = { ...config, enabled } satisfies CodexSettings;
        const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        });
        const unavailableTextGeneration = makeUnavailableTextGeneration(instanceId);

        if (!enabled) {
          const adapter = yield* makeCodexAdapterCore(effectiveConfig, {
            instanceId,
            enabled: false,
            makeRuntime: (options) =>
              Effect.fail(
                new CodexSessionRuntimeEndpointUnavailableError({
                  threadId: options.threadId,
                  providerInstanceId: instanceId,
                }),
              ),
            ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
          });
          const snapshotSettings = makeProviderSnapshotSettingsSource(
            effectiveConfig,
            serverSettings,
          );
          const pendingSnapshot = makePendingCodexEndpointProvider(effectiveConfig).pipe(
            Effect.map(stampIdentity),
          );
          const snapshot = yield* makeManagedServerProvider<
            ProviderSnapshotSettings<CodexSettings>
          >({
            maintenanceCapabilities,
            getSettings: snapshotSettings.getSettings,
            streamSettings: snapshotSettings.streamSettings,
            haveSettingsChanged: haveProviderSnapshotSettingsChanged,
            initialSnapshot: () => pendingSnapshot,
            checkProvider: pendingSnapshot,
          }).pipe(
            Effect.mapError((cause) =>
              mapDriverError(
                `Failed to build disabled Codex endpoint snapshot: ${cause.message}`,
                cause,
              ),
            ),
          );
          return {
            instanceId,
            driverKind: DRIVER_KIND,
            continuationIdentity,
            displayName,
            accentColor,
            enabled,
            gatewayMcpMode: "unavailable",
            snapshot,
            adapter,
            textGeneration: unavailableTextGeneration,
          } satisfies ProviderInstance;
        }

        const supervisor = yield* dependencies.makeEndpointSupervisor({
          providerInstanceId: instanceId,
          transport: config.endpointTransport,
          dependencies: {
            makeEndpoint: dependencies.makeEndpoint,
            makeRouter: dependencies.makeEndpointRouter,
          },
        });
        const endpointTextGeneration = yield* dependencies.makeEndpointTextGeneration({
          providerInstanceId: instanceId,
          borrowRoutedConnection: supervisor.borrowRoutedConnection,
        });
        const textGeneration = TextGeneration.bindTextGenerationOwnership(
          instanceId,
          endpointTextGeneration,
        );
        const execution = dependencies.makeEndpointExecution({
          providerInstanceId: instanceId,
          borrowConnection: supervisor.borrowConnection,
        });
        const terminalSandboxMode =
          effectiveConfig.endpointTerminal.enabled === false
            ? undefined
            : effectiveConfig.endpointTerminal.sandboxMode;
        const terminal =
          terminalSandboxMode === undefined
            ? undefined
            : yield* dependencies.makeEndpointTerminal({
                providerInstanceId: instanceId,
                sandboxMode: terminalSandboxMode,
                borrowConnection: supervisor.borrowConnection,
              });
        const workspace =
          config.workspaceHelper === undefined
            ? undefined
            : dependencies.makeEndpointWorkspace({
                providerInstanceId: instanceId,
                helper: config.workspaceHelper,
                borrowConnection: supervisor.borrowConnection,
              });
        const vcs =
          config.endpointGitExecutablePath === undefined
            ? undefined
            : dependencies.makeEndpointVcs({
                providerInstanceId: instanceId,
                gitExecutablePath: config.endpointGitExecutablePath,
                ...(config.checkpointHelper === undefined
                  ? {}
                  : { checkpointHelper: config.checkpointHelper }),
                borrowConnection: supervisor.borrowConnection,
              });

        let conversationCompatibility: CodexEndpointCompatibilityMetadata | undefined;
        const nativeAdapter = yield* makeCodexAdapterCore(effectiveConfig, {
          instanceId,
          enabled: true,
          makeRuntime: (options) =>
            Effect.suspend(() => supervisor.borrow(options.threadId)).pipe(
              Effect.flatMap((borrowed) =>
                borrowed.ensureCurrent.pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      dependencies.makeEndpointRuntime({
                        connection: borrowed.connection,
                        router: borrowed.router,
                        options,
                      }),
                    ),
                  ),
                  Effect.flatMap((runtime) =>
                    borrowed.ensureCurrent.pipe(
                      Effect.as({
                        ...runtime,
                        start: () =>
                          borrowed.ensureCurrent.pipe(
                            Effect.andThen(runtime.start()),
                            Effect.flatMap((session) =>
                              borrowed.ensureCurrent.pipe(Effect.as(session)),
                            ),
                          ),
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        });
        const adapter = {
          ...nativeAdapter,
          capabilities: {
            get sessionModelSwitch() {
              return conversationCompatibility === undefined
                ? ("unsupported" as const)
                : nativeAdapter.capabilities.sessionModelSwitch;
            },
            get conversationRead() {
              return conversationCompatibility?.capabilities?.conversationRead === true
                ? ("ordered-turn-ids-v1" as const)
                : ("unsupported" as const);
            },
            get checkedConversationRollback() {
              return conversationCompatibility?.capabilities?.checkedConversationRollback === true
                ? ("ordered-turn-ids-v1" as const)
                : ("unsupported" as const);
            },
            get conversationReconciliation() {
              return conversationCompatibility?.capabilities?.conversationRead === true
                ? (nativeAdapter.capabilities.conversationReconciliation ??
                    ("unsupported" as const))
                : ("unsupported" as const);
            },
          },
        } satisfies ProviderInstance["adapter"];

        const supervisorChanges = yield* supervisor.subscribeChanges;
        const generationChanges = yield* Effect.acquireRelease(
          PubSub.unbounded<ProviderInstanceGenerationState>(),
          PubSub.shutdown,
        );
        const toGenerationState = (
          state: CodexEndpointSupervisor.CodexEndpointSupervisorState,
        ): ProviderInstanceGenerationState =>
          state._tag === "Ready"
            ? { _tag: "Ready", providerInstanceId: instanceId, generationId: state.generationId }
            : { _tag: "Unavailable", providerInstanceId: instanceId };
        const generationLifecycle = {
          getCurrent: supervisor.getState.pipe(Effect.map(toGenerationState)),
          subscribeChanges: PubSub.subscribe(generationChanges),
        } as const;
        const lastReadySnapshot = yield* Ref.make<CodexEndpointProviderDraft | null>(null);
        const observedServerVersion = yield* Ref.make<string | null>(null);

        const withVersionAdvisory = (
          draft: CodexEndpointProviderDraft,
        ): CodexEndpointProviderDraft => ({
          ...draft,
          versionAdvisory: createProviderVersionAdvisory({
            driver: DRIVER_KIND,
            currentVersion: draft.version,
            checkedAt: draft.checkedAt,
            maintenanceCapabilities,
          }),
        });
        const makeLifecycleSnapshot = Effect.fn("CodexEndpointDriver.makeLifecycleSnapshot")(
          function* (state: CodexEndpointSupervisor.CodexEndpointSupervisorState) {
            const previous = yield* Ref.get(lastReadySnapshot);
            const pending = previous ?? (yield* makePendingCodexEndpointProvider(effectiveConfig));
            const observedVersion =
              state._tag === "Ready"
                ? (state.compatibility.serverVersion ?? (yield* Ref.get(observedServerVersion)))
                : yield* Ref.get(observedServerVersion);
            const presentation = codexEndpointLifecyclePresentation(state);
            return withVersionAdvisory({
              ...pending,
              enabled: true,
              installed: true,
              version: observedVersion,
              status: presentation.status,
              message: presentation.message,
              connectionState: presentation.connectionState,
            });
          },
        );
        const checkProvider = Effect.fn("CodexEndpointDriver.checkProvider")(function* () {
          for (let staleAttempts = 0; staleAttempts < 3; staleAttempts += 1) {
            const state = yield* supervisor.getState;
            if (state._tag !== "Ready") return yield* makeLifecycleSnapshot(state);
            if (state.compatibility.serverVersion !== undefined) {
              yield* Ref.set(observedServerVersion, state.compatibility.serverVersion);
            }
            const borrowed = yield* supervisor.borrowConnection.pipe(Effect.result);
            if (borrowed._tag === "Failure") {
              yield* Effect.yieldNow;
              continue;
            }
            if ((yield* borrowed.success.ensureCurrent.pipe(Effect.result))._tag === "Failure") {
              yield* Effect.yieldNow;
              continue;
            }
            const readySnapshot = yield* dependencies.checkEndpointProviderStatus(
              effectiveConfig,
              borrowed.success.connection,
            );
            if ((yield* borrowed.success.ensureCurrent.pipe(Effect.result))._tag === "Failure") {
              yield* Effect.yieldNow;
              continue;
            }
            const advisorySnapshot = withVersionAdvisory(readySnapshot);
            yield* Ref.set(lastReadySnapshot, advisorySnapshot);
            return advisorySnapshot;
          }
          return yield* makeLifecycleSnapshot(yield* supervisor.getState);
        });

        yield* supervisor.start({
          onGenerationInvalidated: ({ generationId, error }) =>
            adapter.stopAll().pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to stop invalidated Codex endpoint sessions", {
                  providerInstanceId: instanceId,
                  generationId,
                  endpointErrorTag: error._tag,
                  cause,
                }),
              ),
            ),
        });
        const initialState = yield* supervisor.getState;
        conversationCompatibility =
          initialState._tag === "Ready" ? initialState.compatibility : undefined;

        const stampedCheckProvider = checkProvider().pipe(Effect.map(stampIdentity));
        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: () => stampedCheckProvider,
          checkProvider: stampedCheckProvider,
        }).pipe(
          Effect.mapError((cause) =>
            mapDriverError(`Failed to build Codex endpoint snapshot: ${cause.message}`, cause),
          ),
        );

        yield* Stream.fromSubscription(supervisorChanges).pipe(
          Stream.runForEach((state) => {
            conversationCompatibility = state._tag === "Ready" ? state.compatibility : undefined;
            return snapshot.refresh.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to refresh Codex endpoint lifecycle snapshot", {
                  providerInstanceId: instanceId,
                  supervisorState: state._tag,
                  cause,
                }),
              ),
              Effect.andThen(PubSub.publish(generationChanges, toGenerationState(state))),
              Effect.asVoid,
            );
          }),
          Effect.forkScoped,
        );

        return {
          instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          gatewayMcpMode: "unavailable",
          generationLifecycle,
          snapshot,
          adapter,
          get workspace() {
            return workspace !== undefined &&
              conversationCompatibility?.capabilities?.commandExec === true
              ? workspace
              : undefined;
          },
          get terminal() {
            return terminal !== undefined &&
              conversationCompatibility?.platformFamily === "unix" &&
              conversationCompatibility.capabilities?.commandExecControl === true
              ? terminal
              : undefined;
          },
          get execution() {
            return conversationCompatibility?.capabilities?.commandExec === true
              ? execution
              : undefined;
          },
          get vcs() {
            return vcs !== undefined &&
              conversationCompatibility?.capabilities?.commandExec === true
              ? vcs
              : undefined;
          },
          textGeneration,
        } satisfies ProviderInstance;
      }),
  };
};

export const CodexEndpointDriver = makeCodexEndpointDriver();
