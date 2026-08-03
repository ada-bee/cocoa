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
 * returned instance. Endpoint-backed instances own exactly one initialized
 * connection and one notification router for their whole driver scope;
 * legacy instances retain their isolated local app-server behavior.
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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
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
import {
  CodexSessionRuntimeEndpointUnavailableError,
  makeCodexEndpointSessionRuntime,
} from "../Layers/CodexSessionRuntime.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import * as CodexEndpointFactory from "../codexEndpoint/CodexEndpointFactory.ts";
import { makeCodexEndpointRouter } from "../codexEndpoint/CodexEndpointRouter.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
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
  readonly makeEndpoint: typeof CodexEndpointFactory.make;
  readonly makeEndpointRouter: typeof makeCodexEndpointRouter;
  readonly makeEndpointRuntime: typeof makeCodexEndpointSessionRuntime;
  readonly makeAdapter: typeof makeCodexAdapter;
  readonly makeLocalTextGeneration: typeof makeCodexTextGeneration;
  readonly checkEndpointProviderStatus: typeof checkCodexEndpointProviderStatus;
  readonly checkLocalProviderStatus: typeof checkCodexProviderStatus;
  readonly resolveHomeLayout: typeof resolveCodexHomeLayout;
  readonly materializeShadowHome: typeof materializeCodexShadowHome;
}

const defaultDependencies: CodexDriverDependencies = {
  makeEndpoint: CodexEndpointFactory.make,
  makeEndpointRouter: makeCodexEndpointRouter,
  makeEndpointRuntime: makeCodexEndpointSessionRuntime,
  makeAdapter: makeCodexAdapter,
  makeLocalTextGeneration: makeCodexTextGeneration,
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
          const textGeneration = makeUnavailableEndpointTextGeneration(instanceId);

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
              snapshot,
              adapter,
              textGeneration,
            } satisfies ProviderInstance;
          }

          const connection = yield* dependencies
            .makeEndpoint({
              providerInstanceId: instanceId,
              transport: config.endpointTransport,
            })
            .pipe(
              Effect.mapError((cause) =>
                mapDriverError(`Failed to connect Codex endpoint: ${cause.message}`, cause),
              ),
            );
          const router = yield* dependencies.makeEndpointRouter(connection.client);
          const generationAvailable = yield* Ref.make(true);
          const adapter = yield* dependencies.makeAdapter(effectiveConfig, {
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
              const ensureGenerationAvailable = Ref.get(generationAvailable).pipe(
                Effect.flatMap((available) =>
                  available
                    ? Effect.void
                    : Effect.fail(
                        new CodexSessionRuntimeEndpointUnavailableError({
                          threadId: runtimeOptions.threadId,
                          providerInstanceId: instanceId,
                        }),
                      ),
                ),
              );
              return ensureGenerationAvailable.pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    dependencies.makeEndpointRuntime({
                      connection,
                      router,
                      options: {
                        ...endpointOptions,
                        providerInstanceId: instanceId,
                      },
                    }),
                  ),
                ),
                Effect.map((runtime) => ({
                  ...runtime,
                  start: () =>
                    ensureGenerationAvailable.pipe(
                      Effect.andThen(runtime.start()),
                      Effect.flatMap((session) =>
                        ensureGenerationAvailable.pipe(Effect.as(session)),
                      ),
                    ),
                })),
              );
            },
            ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
          });

          const checkProvider = dependencies
            .checkEndpointProviderStatus(effectiveConfig, connection)
            .pipe(Effect.map(stampIdentity));
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
            initialSnapshot: (settings) =>
              makePendingCodexProvider(settings.provider).pipe(Effect.map(stampIdentity)),
            checkProvider,
          }).pipe(
            Effect.mapError((cause) =>
              mapDriverError(
                `Failed to build Codex endpoint snapshot: ${cause.message ?? String(cause)}`,
                cause,
              ),
            ),
          );

          // A connection and router form one immutable generation. This first
          // endpoint slice deliberately fails closed: termination invalidates
          // the generation and stops every borrower once. Reconciliation may
          // construct a fresh driver scope later; sessions never swap clients
          // or replay mutations here. Refresh after invalidation so consumers
          // promptly observe the endpoint's error state.
          yield* connection.awaitTermination.pipe(
            Effect.catch((cause) =>
              Ref.getAndSet(generationAvailable, false).pipe(
                Effect.flatMap((wasAvailable) =>
                  wasAvailable
                    ? adapter.stopAll().pipe(
                        Effect.catch((stopCause) =>
                          Effect.logWarning("Failed to stop Codex endpoint sessions", {
                            providerInstanceId: instanceId,
                            cause: stopCause,
                          }),
                        ),
                        Effect.andThen(
                          snapshot.refresh.pipe(
                            Effect.catchCause((refreshCause) =>
                              Effect.logWarning(
                                "Failed to refresh terminated Codex endpoint snapshot",
                                {
                                  providerInstanceId: instanceId,
                                  cause: refreshCause,
                                },
                              ),
                            ),
                          ),
                        ),
                      )
                    : Effect.void,
                ),
                Effect.tap(() =>
                  Effect.logWarning("Codex endpoint generation terminated", {
                    providerInstanceId: instanceId,
                    cause,
                  }),
                ),
              ),
            ),
            Effect.forkScoped,
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
        const textGeneration = yield* dependencies.makeLocalTextGeneration(
          effectiveConfig,
          processEnv,
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
