/**
 * CodexDriver — first concrete `ProviderDriver` in the new per-instance model.
 *
 * A driver is a plain value (not a Context.Service) whose `create()` returns
 * one `ProviderInstance` bundling:
 *   - `snapshot`   — the live `ServerProviderShape` for this instance;
 *   - `adapter`    — the Codex session/turn/approval runtime;
 *   - `textGeneration` — provider-bound text generation, or an explicit
 *     unavailable service when the remote endpoint does not expose it.
 *
 * Each call to `create()` captures the typed config in closures owned by the
 * returned instance. Endpoint-backed instances own a conversation supervisor
 * whose immutable connection/router generation is replaced after transient
 * termination. When explicitly enabled, terminal work owns a second isolated
 * supervisor; legacy instances retain their isolated local app-server behavior.
 *
 * Resource lifecycle: `create()` runs in a scope handed in by the registry.
 * Closing that scope releases the endpoint transport (or legacy adapter child
 * processes), the managed snapshot refresh fiber, and any transient local
 * text-generation resources. The registry uses this to tear down an instance
 * when its `providerInstances` entry disappears or its config changes.
 *
 * @module provider/Drivers/CodexDriver
 */
import {
  CodexSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import { makeCodexEndpointTextGeneration } from "../../textGeneration/CodexEndpointTextGeneration.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import {
  checkCodexEndpointProviderStatus,
  checkCodexProviderStatus,
  makePendingCodexProvider,
} from "../Layers/CodexProvider.ts";
import { makeCodexEndpointSessionRuntime } from "../Layers/CodexSessionRuntime.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
  type ProviderInstanceGenerationState,
} from "../ProviderDriver.ts";
import * as CodexEndpointFactory from "../codexEndpoint/CodexEndpointFactory.ts";
import type { CodexEndpointCompatibilityMetadata } from "../codexEndpoint/CodexEndpointConnection.ts";
import { makeCodexEndpointRouter } from "../codexEndpoint/CodexEndpointRouter.ts";
import * as CodexEndpointSupervisor from "../codexEndpoint/CodexEndpointSupervisor.ts";
import { makeCodexTerminalAdapter } from "../codexTerminal/CodexTerminalAdapter.ts";
import { makeCodexVcsAdapter } from "../codexVcs/CodexVcsAdapter.ts";
import { makeCodexWorkspaceAdapter } from "../codexWorkspace/CodexWorkspaceAdapter.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@openai/codex",
  homebrewFormula: "codex",
  nativeUpdate: null,
});

type CodexTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const makeUnavailableEndpointTextGeneration = (
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

export interface CodexDriverDependencies {
  readonly makeEndpointSupervisor: typeof CodexEndpointSupervisor.make;
  readonly makeEndpoint: typeof CodexEndpointFactory.make;
  readonly makeEndpointRouter: typeof makeCodexEndpointRouter;
  readonly makeEndpointRuntime: typeof makeCodexEndpointSessionRuntime;
  readonly makeEndpointTerminal: typeof makeCodexTerminalAdapter;
  readonly makeEndpointVcs: typeof makeCodexVcsAdapter;
  readonly makeEndpointWorkspace: typeof makeCodexWorkspaceAdapter;
  readonly makeAdapter: typeof makeCodexAdapter;
  readonly makeLocalTextGeneration: typeof makeCodexTextGeneration;
  readonly makeEndpointTextGeneration: typeof makeCodexEndpointTextGeneration;
  readonly checkEndpointProviderStatus: typeof checkCodexEndpointProviderStatus;
  readonly checkLocalProviderStatus: typeof checkCodexProviderStatus;
  readonly resolveHomeLayout: typeof resolveCodexHomeLayout;
  readonly materializeShadowHome: typeof materializeCodexShadowHome;
}

const defaultDependencies: CodexDriverDependencies = {
  makeEndpointSupervisor: CodexEndpointSupervisor.make,
  makeEndpoint: CodexEndpointFactory.make,
  makeEndpointRouter: makeCodexEndpointRouter,
  makeEndpointRuntime: makeCodexEndpointSessionRuntime,
  makeEndpointTerminal: makeCodexTerminalAdapter,
  makeEndpointVcs: makeCodexVcsAdapter,
  makeEndpointWorkspace: makeCodexWorkspaceAdapter,
  makeAdapter: makeCodexAdapter,
  makeLocalTextGeneration: makeCodexTextGeneration,
  makeEndpointTextGeneration: makeCodexEndpointTextGeneration,
  checkEndpointProviderStatus: checkCodexEndpointProviderStatus,
  checkLocalProviderStatus: checkCodexProviderStatus,
  resolveHomeLayout: resolveCodexHomeLayout,
  materializeShadowHome: materializeCodexShadowHome,
};

/**
 * Services the driver needs to materialize an instance. Surfaced as the
 * driver's `R` so the registry layer aggregates these across every
 * registered driver and the runtime satisfies them once.
 */
export type CodexDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * driver-kind-only codex helpers. Once `buildServerProvider` in
 * `providerSnapshot.ts` is widened to accept `instanceId`/`driver`, this
 * wrapper disappears.
 */
const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const makeCodexDriver = (
  overrides: Partial<CodexDriverDependencies> = {},
): ProviderDriver<CodexSettings, CodexDriverEnv> => {
  const dependencies: CodexDriverDependencies = { ...defaultDependencies, ...overrides };

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: "Codex",
      supportsMultipleInstances: true,
    },
    configSchema: CodexSettings,
    defaultConfig: (): CodexSettings => decodeCodexSettings({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        const eventLoggers = yield* ProviderEventLoggers;
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const mapDriverError = (detail: string, cause: unknown) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail,
            cause,
          });

        if (config.endpointTransport) {
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
          const disabledTextGeneration = makeUnavailableEndpointTextGeneration(instanceId);

          if (!enabled) {
            const adapter = yield* dependencies.makeAdapter(effectiveConfig, {
              instanceId,
              enabled: false,
              environment: processEnv,
              ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
            });
            const snapshotSettings = makeProviderSnapshotSettingsSource(
              effectiveConfig,
              serverSettings,
            );
            const pendingSnapshot = makePendingCodexProvider(effectiveConfig).pipe(
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
                  `Failed to build disabled Codex endpoint snapshot: ${cause.message ?? String(cause)}`,
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
              textGeneration: disabledTextGeneration,
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
          let conversationCompatibility: CodexEndpointCompatibilityMetadata | undefined;
          let terminalCompatibility: CodexEndpointCompatibilityMetadata | undefined;
          const terminalConfig = effectiveConfig.endpointTerminal;
          const terminalSandboxMode =
            terminalConfig.enabled === false ? undefined : terminalConfig.sandboxMode;
          const terminalSupervisor =
            terminalSandboxMode === undefined
              ? undefined
              : yield* dependencies.makeEndpointSupervisor({
                  providerInstanceId: instanceId,
                  transport: config.endpointTransport,
                  dependencies: {
                    makeEndpoint: dependencies.makeEndpoint,
                    makeRouter: dependencies.makeEndpointRouter,
                  },
                });
          const terminalChanges =
            terminalSupervisor === undefined
              ? undefined
              : yield* terminalSupervisor.subscribeChanges;
          const terminal =
            terminalSupervisor === undefined || terminalSandboxMode === undefined
              ? undefined
              : yield* dependencies.makeEndpointTerminal({
                  providerInstanceId: instanceId,
                  sandboxMode: terminalSandboxMode,
                  borrowConnection: terminalSupervisor.borrowConnection,
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
          const supervisorChanges = yield* supervisor.subscribeChanges;
          const generationChanges = yield* Effect.acquireRelease(
            PubSub.unbounded<ProviderInstanceGenerationState>(),
            PubSub.shutdown,
          );
          const toGenerationState = (
            state: CodexEndpointSupervisor.CodexEndpointSupervisorState,
          ): ProviderInstanceGenerationState =>
            state._tag === "Ready"
              ? {
                  _tag: "Ready",
                  providerInstanceId: instanceId,
                  generationId: state.generationId,
                }
              : { _tag: "Unavailable", providerInstanceId: instanceId };
          const generationLifecycle = {
            getCurrent: supervisor.getState.pipe(Effect.map(toGenerationState)),
            subscribeChanges: PubSub.subscribe(generationChanges),
          } as const;
          const lastReadySnapshot = yield* Ref.make<ServerProviderDraft | null>(null);
          const observedServerVersion = yield* Ref.make<string | null>(null);

          const withEndpointVersionAdvisory = (
            draft: ServerProviderDraft,
          ): ServerProviderDraft => ({
            ...draft,
            versionAdvisory: createProviderVersionAdvisory({
              driver: DRIVER_KIND,
              currentVersion: draft.version,
              checkedAt: draft.checkedAt,
              maintenanceCapabilities,
            }),
          });

          const makeLifecycleSnapshot = Effect.fn("CodexDriver.makeEndpointLifecycleSnapshot")(
            function* (state: CodexEndpointSupervisor.CodexEndpointSupervisorState) {
              const previous = yield* Ref.get(lastReadySnapshot);
              const pending = previous ?? (yield* makePendingCodexProvider(effectiveConfig));
              const observedVersion =
                state._tag === "Ready"
                  ? (state.compatibility.serverVersion ?? (yield* Ref.get(observedServerVersion)))
                  : yield* Ref.get(observedServerVersion);
              const presentation = (() => {
                switch (state._tag) {
                  case "Connecting":
                    return {
                      status: "warning" as const,
                      message: `Connecting to the Codex endpoint (attempt ${state.attempt}).`,
                    };
                  case "Retrying":
                    return {
                      status: "error" as const,
                      message: `The Codex endpoint connection was interrupted and will retry (attempt ${state.attempt}).`,
                    };
                  case "Blocked":
                    return {
                      status: "error" as const,
                      message:
                        "The Codex endpoint connection is blocked by its configuration or authentication. Update the provider settings to retry.",
                    };
                  case "Closed":
                    return {
                      status: "error" as const,
                      message: "The Codex endpoint connection is closed.",
                    };
                  case "Ready":
                    return {
                      status: "warning" as const,
                      message: "The Codex endpoint is ready; provider status is being refreshed.",
                    };
                }
              })();
              return withEndpointVersionAdvisory({
                ...pending,
                enabled: true,
                installed: true,
                version: observedVersion,
                status: presentation.status,
                message: presentation.message,
              });
            },
          );

          const checkProvider = Effect.fn("CodexDriver.checkEndpointSupervisorStatus")(
            function* () {
              for (let staleAttempts = 0; staleAttempts < 3; staleAttempts += 1) {
                const state = yield* supervisor.getState;
                if (state._tag !== "Ready") {
                  return yield* makeLifecycleSnapshot(state);
                }
                if (state.compatibility.serverVersion !== undefined) {
                  yield* Ref.set(observedServerVersion, state.compatibility.serverVersion);
                }
                const borrowed = yield* supervisor.borrowConnection.pipe(Effect.result);
                if (borrowed._tag === "Failure") {
                  yield* Effect.yieldNow;
                  continue;
                }
                const currentBeforeCheck = yield* borrowed.success.ensureCurrent.pipe(
                  Effect.result,
                );
                if (currentBeforeCheck._tag === "Failure") {
                  yield* Effect.yieldNow;
                  continue;
                }
                const readySnapshot = yield* dependencies.checkEndpointProviderStatus(
                  effectiveConfig,
                  borrowed.success.connection,
                );
                const currentAfterCheck = yield* borrowed.success.ensureCurrent.pipe(Effect.result);
                if (currentAfterCheck._tag === "Failure") {
                  yield* Effect.yieldNow;
                  continue;
                }
                const advisorySnapshot = withEndpointVersionAdvisory(readySnapshot);
                yield* Ref.set(lastReadySnapshot, advisorySnapshot);
                return advisorySnapshot;
              }
              return yield* makeLifecycleSnapshot(yield* supervisor.getState);
            },
          );

          const nativeAdapter = yield* dependencies.makeAdapter(effectiveConfig, {
            instanceId,
            enabled: true,
            environment: processEnv,
            makeRuntime: (runtimeOptions) => {
              const {
                binaryPath: _binaryPath,
                homePath: _homePath,
                launchArgs: _launchArgs,
                environment: _environment,
                providerInstanceId: _providerInstanceId,
                ...endpointOptions
              } = runtimeOptions;
              return Effect.suspend(() => supervisor.borrow(runtimeOptions.threadId)).pipe(
                Effect.flatMap((borrowed) =>
                  borrowed.ensureCurrent.pipe(
                    Effect.andThen(
                      Effect.suspend(() =>
                        dependencies.makeEndpointRuntime({
                          connection: borrowed.connection,
                          router: borrowed.router,
                          options: {
                            ...endpointOptions,
                            providerInstanceId: instanceId,
                          },
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
              );
            },
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
            },
          } satisfies ProviderInstance["adapter"];

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
          if (terminalSupervisor !== undefined) {
            // Schedule the isolated terminal connection without making
            // provider hydration wait for its connector timeout. Its retry
            // lifecycle remains separate from conversation/provider health.
            yield* terminalSupervisor.start({
              // Terminal sessions are permanently bound to their captured
              // connection generation. Their invalidation is deliberately
              // independent from conversation session cleanup.
              onGenerationInvalidated: () => Effect.void,
            });
          }

          const initialConversationState = yield* supervisor.getState;
          conversationCompatibility =
            initialConversationState._tag === "Ready"
              ? initialConversationState.compatibility
              : undefined;
          if (terminalSupervisor !== undefined) {
            const initialTerminalState = yield* terminalSupervisor.getState;
            terminalCompatibility =
              initialTerminalState._tag === "Ready"
                ? initialTerminalState.compatibility
                : undefined;
          }

          const stampedCheckProvider = checkProvider().pipe(Effect.map(stampIdentity));
          const snapshotSettings = makeProviderSnapshotSettingsSource(
            effectiveConfig,
            serverSettings,
          );
          const snapshot = yield* makeManagedServerProvider<
            ProviderSnapshotSettings<CodexSettings>
          >({
            maintenanceCapabilities,
            getSettings: snapshotSettings.getSettings,
            streamSettings: snapshotSettings.streamSettings,
            haveSettingsChanged: haveProviderSnapshotSettingsChanged,
            initialSnapshot: () => stampedCheckProvider,
            checkProvider: stampedCheckProvider,
          }).pipe(
            Effect.mapError((cause) =>
              mapDriverError(
                `Failed to build Codex endpoint snapshot: ${cause.message ?? String(cause)}`,
                cause,
              ),
            ),
          );

          // The supervisor subscription was acquired before `start`, so the
          // initial Ready/Retrying/Blocked transition is buffered even though
          // this bridge starts only after the managed snapshot exists.
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
          if (terminalChanges !== undefined) {
            yield* Stream.fromSubscription(terminalChanges).pipe(
              Stream.runForEach((state) =>
                Effect.sync(() => {
                  terminalCompatibility = state._tag === "Ready" ? state.compatibility : undefined;
                }),
              ),
              Effect.forkScoped,
            );
          }

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
                terminalCompatibility?.platformFamily === "unix" &&
                terminalCompatibility.capabilities?.commandExecControl === true
                ? terminal
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
        }

        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const httpClient = yield* HttpClient.HttpClient;
        const homeLayout = yield* dependencies.resolveHomeLayout(config);
        const continuationIdentity = codexContinuationIdentity(homeLayout);
        const stampIdentity = withInstanceIdentity({
          instanceId,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        yield* dependencies
          .materializeShadowHome(homeLayout)
          .pipe(Effect.mapError((cause) => mapDriverError(cause.message, cause)));
        const effectiveConfig = {
          ...config,
          enabled,
          homePath: homeLayout.effectiveHomePath ?? "",
        } satisfies CodexSettings;
        const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          UPDATE,
          {
            binaryPath: effectiveConfig.binaryPath,
            env: processEnv,
          },
        );
        const adapter = yield* dependencies.makeAdapter(effectiveConfig, {
          instanceId,
          enabled,
          environment: processEnv,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        });
        const localTextGeneration = yield* dependencies.makeLocalTextGeneration(
          effectiveConfig,
          processEnv,
        );
        const textGeneration = TextGeneration.bindTextGenerationOwnership(
          instanceId,
          localTextGeneration,
        );
        const checkProvider = dependencies
          .checkLocalProviderStatus(effectiveConfig, undefined, processEnv)
          .pipe(
            Effect.map(stampIdentity),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            makePendingCodexProvider(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
            ),
        }).pipe(
          Effect.mapError((cause) =>
            mapDriverError(
              `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
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
          snapshot,
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }),
  };
};

export const CodexDriver = makeCodexDriver();
