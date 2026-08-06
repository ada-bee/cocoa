import {
  EnvironmentAuthHttpApi,
  EnvironmentHttpApi,
  EnvironmentMetadataHttpApi,
  EnvironmentOrchestrationHttpApi,
  ServerSelfUpdateError,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Types from "effect/Types";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as ServerConfig from "./config.ts";
import * as HttpResponseCompression from "./httpCompression/HttpResponseCompression.ts";
import {
  otlpTracesProxyRouteLayer,
  assetRouteLayer,
  serverEnvironmentHttpApiLayer,
  staticAndDevRouteLayer,
  browserApiCorsLayer,
  gatewayHealthRouteLayer,
  httpCompressionLayer,
} from "./http.ts";
import * as GatewayHealth from "./health/GatewayHealth.ts";
import { cocoaClientV1WebSocketRouteLayer } from "./clientApi/v1/Route.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { CocoaRuntimeDependenciesLive } from "./cocoa/CocoaGatewayRuntime.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { ProviderCheckpointOperationRepositoryLive } from "./persistence/Layers/ProviderCheckpointOperations.ts";
import { ProjectionCheckpointRepositoryLive } from "./persistence/Layers/ProjectionCheckpoints.ts";
import { PostTurnCheckpointIntentRepositoryLive } from "./persistence/Layers/PostTurnCheckpointIntents.ts";
import { CheckpointRevertIntentRepositoryLive } from "./persistence/Layers/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepositoryLive } from "./persistence/Layers/CheckpointRevertSagas.ts";
import { TurnDispatchJournalRepositoryLive } from "./persistence/Layers/TurnDispatchJournal.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "./persistence/ProviderSessionRuntime.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import * as ProviderEventLoggers from "./provider/Layers/ProviderEventLoggers.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import { ProviderGenerationRecoveryReactorLive } from "./provider/Layers/ProviderGenerationRecoveryReactor.ts";
import * as OpenCodeRuntime from "./provider/opencodeRuntime.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { LegacyProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { CheckpointCoordinatorLive } from "./orchestration/Layers/CheckpointCoordinator.ts";
import { PostTurnCheckpointReactorLive } from "./orchestration/Layers/PostTurnCheckpointReactor.ts";
import { CheckpointRevertReactorLive } from "./orchestration/Layers/CheckpointRevertReactor.ts";
import { CheckpointRevertGateLive } from "./orchestration/Layers/CheckpointRevertGate.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import * as ProviderFilesystemBrowse from "./provider/ProviderFilesystemBrowse.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as ProjectTerminal from "./project/ProjectTerminal.ts";
import * as ProjectWorkspace from "./project/ProjectWorkspace.ts";
import * as ProjectRepository from "./project/ProjectRepository.ts";
import * as RepositoryReadService from "./project/RepositoryReadService.ts";
import * as RepositoryStatusBroadcaster from "./project/RepositoryStatusBroadcaster.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./auth/http.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  connectHttpApiLayer,
  reconcileDesiredCloudLink,
  releaseManagedTunnelOnShutdown,
} from "./cloud/http.ts";
import { serverRelayBrokerTracingLayer } from "./cloud/relayTracing.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as CloudCliState from "./cloud/CliState.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import { orchestrationHttpApiLayer } from "./orchestration/http.ts";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import { disableTailscaleServe, ensureTailscaleServe } from "@t3tools/tailscale";
import { forkParked, ServerActivation } from "./serverActivation.ts";

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// T3's primary transport is long-lived WebSocket RPC, whose Effect scope finalizer
// already closes the websocket gracefully. Do not add an artificial drain before
// those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const ResourceAttributionLayerLive = ResourceAttribution.layer;
const ApplicationObservabilityLive = ObservabilityLive.pipe(
  Layer.provideMerge(ResourceAttributionLayerLive),
);

const ServerSettingsLayerLive = ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer));

const NativeTelemetryLayerLive = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);
const DesktopTelemetryReceiverLayerLive = DesktopTelemetryReceiver.layer.pipe(
  Layer.provideMerge(ServerSettingsLayerLive),
);

const ResourceTelemetryLayerLive = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(NativeTelemetryLayerLive),
  Layer.provideMerge(DesktopTelemetryReceiverLayerLive),
);

const HostPowerMonitorLayerLive = HostPowerMonitor.layer.pipe(
  Layer.provide(DesktopTelemetryReceiverLayerLive),
);

const BackgroundLayerLive = BackgroundPolicy.layer.pipe(
  Layer.provide(HostPowerMonitorLayerLive),
  Layer.provideMerge(ServerSettingsLayerLive),
);

const ResourceDiagnosticsLayerLive = Layer.mergeAll(
  ResourceTelemetryLayerLive,
  ProcessDiagnostics.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
);

const RelayClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return RelayClient.layerCloudflared({ baseDir: config.baseDir });
  }),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        hostname: config.host ?? "127.0.0.1",
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.host ?? "127.0.0.1",
        port: config.port,
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
      });
    }
  }),
);

const HttpResponseCompressionLive =
  typeof Bun !== "undefined" ? HttpResponseCompression.layerBun : HttpResponseCompression.layerNode;

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const makeReactorLayer = <ROut, E, RIn, EProject, RProject>(
  orchestrationReactorLayer: Layer.Layer<ROut, E, RIn>,
  projectRepositoryLayer: Layer.Layer<ProjectRepository.ProjectRepository, EProject, RProject>,
) => {
  const turnDispatchJournalLayer = TurnDispatchJournalRepositoryLive;
  const postTurnCheckpointIntentLayer = PostTurnCheckpointIntentRepositoryLive;
  const checkpointRevertIntentLayer = CheckpointRevertIntentRepositoryLive;
  const checkpointRevertSagaLayer = CheckpointRevertSagaRepositoryLive;
  const projectionCheckpointLayer = ProjectionCheckpointRepositoryLive;
  const providerCheckpointOperationLayer = ProviderCheckpointOperationRepositoryLive.pipe(
    Layer.provide(PersistenceLayerLive),
  );
  const checkpointCoordinatorLayer = CheckpointCoordinatorLive.pipe(
    Layer.provide(projectRepositoryLayer),
    Layer.provide(OrchestrationLayerLive),
    Layer.provide(providerCheckpointOperationLayer),
  );
  const checkpointRevertGateLayer = CheckpointRevertGateLive.pipe(
    Layer.provide(checkpointRevertIntentLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provide(turnDispatchJournalLayer),
    Layer.provide(checkpointCoordinatorLayer),
    Layer.provide(checkpointRevertGateLayer),
  );
  const postTurnCheckpointReactorLayer = PostTurnCheckpointReactorLive.pipe(
    Layer.provide(projectRepositoryLayer),
    Layer.provide(turnDispatchJournalLayer),
    Layer.provide(postTurnCheckpointIntentLayer),
    Layer.provide(providerCheckpointOperationLayer),
  );
  const checkpointRevertReactorLayer = CheckpointRevertReactorLive.pipe(
    Layer.provide(projectRepositoryLayer),
    Layer.provide(OrchestrationLayerLive),
    Layer.provide(providerCheckpointOperationLayer),
    Layer.provide(projectionCheckpointLayer),
    Layer.provide(checkpointRevertIntentLayer),
    Layer.provide(checkpointRevertSagaLayer),
  );
  const providerGenerationRecoveryLayer = ProviderGenerationRecoveryReactorLive.pipe(
    Layer.provide(providerCommandReactorLayer),
    Layer.provide(postTurnCheckpointReactorLayer),
    Layer.provide(checkpointRevertReactorLayer),
  );
  return Layer.empty.pipe(
    Layer.provideMerge(orchestrationReactorLayer),
    Layer.provideMerge(ProviderRuntimeIngestionLive),
    Layer.provideMerge(providerGenerationRecoveryLayer),
    Layer.provideMerge(turnDispatchJournalLayer),
    Layer.provideMerge(postTurnCheckpointIntentLayer),
    Layer.provideMerge(checkpointRevertIntentLayer),
    Layer.provideMerge(checkpointRevertSagaLayer),
    Layer.provideMerge(projectionCheckpointLayer),
    Layer.provideMerge(providerCheckpointOperationLayer),
    Layer.provideMerge(checkpointCoordinatorLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(postTurnCheckpointReactorLayer),
    Layer.provideMerge(checkpointRevertReactorLayer),
    Layer.provideMerge(checkpointRevertGateLayer),
    Layer.provideMerge(ThreadDeletionReactorLive),
    Layer.provideMerge(RuntimeReceiptBusLive),
  );
};

const LegacyOrchestrationReactorLive = OrchestrationReactorLive.pipe(
  Layer.provide(AgentAwarenessRelay.layer.pipe(Layer.provide(ServerSecretStore.layer))),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);

// `ProviderAdapterRegistryLive` is now a facade that resolves kind → adapter
// by looking up the default `ProviderInstance` per driver in the instance
// registry. Adapter construction itself moved inside each driver's
// `create()`; `ProviderEventLoggers.layer` owns the shared native/canonical
// NDJSON writers and is provided at the outer runtime layer so both
// `ProviderService` and the per-instance drivers read the same logger pair.
const ProviderLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const VcsDriverRegistryLayerLive = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProjectConfig.layer),
);

const SourceControlProviderRegistryLayerLive = SourceControlProviderRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(AzureDevOpsCli.layer, BitbucketApi.layer, GitHubCli.layer, GitLabCli.layer),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const GitManagerLayerLive = GitManager.layer.pipe(
  Layer.provideMerge(ProjectSetupScriptRunner.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(TextGeneration.layer),
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(GitVcsDriver.layer),
);

const GitWorkflowLayerLive = GitWorkflowService.layer.pipe(
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
);

const SourceControlRepositoryServiceLayerLive = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
);

const ReviewLayerLive = ReviewService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const ProjectRepositoryLayerLive = ProjectRepository.layer.pipe(
  Layer.provide(LegacyProviderInstanceRegistryHydrationLive),
  Layer.provide(OrchestrationLayerLive),
);

const LegacyReactorLayerLive = makeReactorLayer(
  LegacyOrchestrationReactorLive,
  ProjectRepositoryLayerLive,
);

const RepositoryReadLayerLive = RepositoryReadService.layer.pipe(
  Layer.provide(ProjectRepositoryLayerLive),
);

const RepositoryStatusLayerLive = RepositoryStatusBroadcaster.layer.pipe(
  Layer.provide(RepositoryReadLayerLive),
);

const VcsLayerLive = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
  Layer.provideMerge(GitWorkflowLayerLive),
  Layer.provideMerge(ReviewLayerLive),
  Layer.provideMerge(SourceControlRepositoryServiceLayerLive),
  Layer.provideMerge(VcsStatusBroadcaster.layer.pipe(Layer.provide(GitWorkflowLayerLive))),
  Layer.provideMerge(RepositoryReadLayerLive),
  Layer.provideMerge(RepositoryStatusLayerLive),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(
    CheckpointDiffQuery.layer.pipe(
      Layer.provide(ProjectRepositoryLayerLive),
      Layer.provide(OrchestrationLayerLive),
      Layer.provide(
        ProviderCheckpointOperationRepositoryLive.pipe(Layer.provide(PersistenceLayerLive)),
      ),
    ),
  ),
  Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
);

const PortScannerLayerLive = PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer));

const ProjectTerminalLayerLive = ProjectTerminal.layer.pipe(
  Layer.provide(LegacyProviderInstanceRegistryHydrationLive),
  Layer.provide(OrchestrationLayerLive),
);

const TerminalLayerLive = TerminalManager.layer.pipe(Layer.provide(ProjectTerminalLayerLive));

const PreviewLayerLive = Layer.empty.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(PortScannerLayerLive),
);

const WorkspaceEntriesLayerLive = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const WorkspaceLayerLive = Layer.mergeAll(WorkspacePaths.layer, WorkspaceEntriesLayerLive);

const ProjectWorkspaceLayerLive = ProjectWorkspace.layer.pipe(
  Layer.provide(LegacyProviderInstanceRegistryHydrationLive),
  Layer.provide(OrchestrationLayerLive),
);

const ProviderFilesystemBrowseLayerLive = ProviderFilesystemBrowse.layer.pipe(
  Layer.provide(LegacyProviderInstanceRegistryHydrationLive),
);

const WorkspaceAccessLayerLive = Layer.mergeAll(
  WorkspaceLayerLive,
  ProjectWorkspaceLayerLive,
  ProviderFilesystemBrowseLayerLive,
);

const ProjectFaviconResolverLayerLive = ProjectFaviconResolver.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(T3ProjectFileLoader.layer),
);

const AuthLayerLive = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerSecretStore.layer),
);

const CloudManagedEndpointRuntimeLive = Layer.mergeAll(
  RelayClientLive,
  CloudManagedEndpointRuntime.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(RelayClientLive),
  ),
);

const LegacyHostedRuntimeLayerLive = Layer.mergeAll(
  CloudCliTokenManager.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ExternalLauncher.layer),
  ),
  CloudManagedEndpointRuntimeLive,
);

const ProviderRuntimeLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const LegacyRuntimeCoreDependenciesLive = LegacyReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(ServerSettingsLayerLive),
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(VcsLayerLive),
  Layer.provideMerge(ProviderRuntimeLayerLive),
  Layer.provideMerge(Layer.mergeAll(TerminalLayerLive, PreviewLayerLive)),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(Keybindings.layer),
  Layer.provideMerge(ProviderRegistryLive),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // `providerInstances` hydration merges `settings.providers.<kind>`
  // with explicit `providerInstances` entries on boot.
  Layer.provideMerge(LegacyProviderInstanceRegistryHydrationLive),
  // Shared native/canonical NDJSON writers used by both the per-instance
  // drivers (native stream, written from inside each `<X>Adapter`) and
  // `ProviderService` (canonical stream, written after event normalization).
  // Provided once at the runtime level so every consumer sees the same
  // logger instances.
  Layer.provideMerge(ProviderEventLoggers.layer),
  // `OpenCodeDriver.create()` yields `OpenCodeRuntime`; previously the old
  // `ProviderRegistryLive` pulled `OpenCodeRuntimeLive` in for itself, but
  // the rewritten registry reads snapshots off the instance registry and
  // no longer transitively provides it. Exposing it at the runtime level
  // keeps a single Live for all opencode consumers.
  Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
  Layer.provideMerge(WorkspaceAccessLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLayerLive),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ServerEnvironment.layer),
  Layer.provideMerge(AuthLayerLive),
  Layer.provideMerge(ServerSecretStore.layer),
);

const AnalyticsLayerLive = Layer.unwrap(
  ServerConfig.ServerConfig.pipe(
    Effect.map((config) =>
      config.runtimeProfile === "cocoa-gateway"
        ? AnalyticsService.layerDisabled
        : AnalyticsService.layer,
    ),
  ),
);

const LegacyRuntimeDependenciesLive = LegacyRuntimeCoreDependenciesLive.pipe(
  // Misc.
  Layer.provideMerge(BackgroundLayerLive),
  Layer.provideMerge(ResourceDiagnosticsLayerLive),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(AnalyticsLayerLive),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provide(NetService.layer),
  Layer.provide(OpenCodeRuntime.OpenCodeRuntimeLive),
  Layer.provide(ProviderEventLoggers.layer),
  Layer.provide(ServerSettingsLayerLive),
);

const LegacyRuntimeDependenciesWithVcsLive = LegacyRuntimeDependenciesLive.pipe(
  Layer.provideMerge(VcsProcess.layer),
);

type RuntimeDependenciesLayer = Layer.Layer<
  | Layer.Success<typeof CocoaRuntimeDependenciesLive>
  | Layer.Success<typeof LegacyRuntimeDependenciesWithVcsLive>,
  | Layer.Error<typeof CocoaRuntimeDependenciesLive>
  | Layer.Error<typeof LegacyRuntimeDependenciesWithVcsLive>,
  | Layer.Services<typeof CocoaRuntimeDependenciesLive>
  | Layer.Services<typeof LegacyRuntimeDependenciesWithVcsLive>
>;

const ServerSelfUpdateLayerLive = Layer.unwrap(
  ServerConfig.ServerConfig.pipe(
    Effect.map((config) =>
      config.runtimeProfile === "cocoa-gateway"
        ? Layer.succeed(
            ServerSelfUpdate.ServerSelfUpdate,
            ServerSelfUpdate.ServerSelfUpdate.of({
              update: () =>
                Effect.fail(
                  new ServerSelfUpdateError({
                    reason: "Cocoa gateway updates are administrator-managed.",
                  }),
                ),
            }),
          )
        : ServerSelfUpdate.layer,
    ),
  ),
);

const commandReadinessLayer = HttpRouter.middleware()(
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    return (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect));
  }),
).layer;

class CocoaGatewayEnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi) {}

const legacyEnvironmentHttpApiLayer = HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(connectHttpApiLayer),
  Layer.provide(orchestrationHttpApiLayer),
  Layer.provide(serverEnvironmentHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
);

const cocoaGatewayEnvironmentHttpApiLayer = HttpApiBuilder.layer(
  CocoaGatewayEnvironmentHttpApi,
).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(orchestrationHttpApiLayer),
  Layer.provide(serverEnvironmentHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
);

const environmentHttpApiLayer = Layer.unwrap(
  ServerConfig.ServerConfig.pipe(
    Effect.map((config) =>
      config.runtimeProfile === "cocoa-gateway"
        ? cocoaGatewayEnvironmentHttpApiLayer
        : legacyEnvironmentHttpApiLayer,
    ),
  ),
);

const commandReadyRoutesLayer = Layer.mergeAll(
  Layer.mergeAll(
    environmentHttpApiLayer,
    otlpTracesProxyRouteLayer,
    assetRouteLayer,
    staticAndDevRouteLayer,
    websocketRpcRouteLayer,
    cocoaClientV1WebSocketRouteLayer,
  ),
  McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)),
).pipe(
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(ServerSelfUpdateLayerLive),
  Layer.provide(commandReadinessLayer),
);

export const makeRoutesLayer = Layer.mergeAll(
  commandReadyRoutesLayer,
  gatewayHealthRouteLayer.pipe(Layer.provide(GatewayHealth.layer)),
).pipe(Layer.provide(browserApiCorsLayer), Layer.provide(httpCompressionLayer));

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const runtimeDependenciesLive = (
      config.runtimeProfile === "cocoa-gateway"
        ? CocoaRuntimeDependenciesLive
        : LegacyRuntimeDependenciesWithVcsLive
    ) as RuntimeDependenciesLayer;
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const activationLayer = Layer.succeed(ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const tailscaleParked = yield* Deferred.make<void>();
    const cloudLinkParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();
    const launcherLayer = ServiceLauncherClient.layer;

    if (config.runtimeProfile !== "cocoa-gateway") {
      yield* fixPath();
    }

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const runtimeStateLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
          yield* awaitActivation;
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) {
            return;
          }

          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
        }),
        () =>
          clearPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to clear server runtime state", { cause }),
            ),
          ),
      ),
    );
    const legacyFleetFeatures = config.runtimeProfile !== "cocoa-gateway";
    const hostedRuntimeLayer = legacyFleetFeatures ? LegacyHostedRuntimeLayerLive : Layer.empty;
    const tailscaleServeEnabled = legacyFleetFeatures && config.tailscaleServeEnabled;
    const tailscaleServeLayer = tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie);
              yield* awaitActivation;
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (typeof address === "string" || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost: "127.0.0.1",
              }).pipe(
                Effect.as({ localPort, servePort: config.tailscaleServePort }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve", {
                    cause,
                    localPort,
                    servePort: config.tailscaleServePort,
                  }).pipe(Effect.as(null)),
                ),
              );
            }),
            (configured) =>
              configured
                ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("Tailscale Serve disabled", {
                        servePort: configured.servePort,
                      }),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ),
        )
      : Layer.empty;
    const cloudDesiredLinkReconcileLayer =
      !legacyFleetFeatures || !hasCloudPublicConfig
        ? Layer.effectDiscard(
            Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie, Effect.asVoid),
          )
        : Layer.effectDiscard(
            Effect.gen(function* () {
              yield* forkParked(
                Effect.gen(function* () {
                  // Only an activated runtime owns the tunnel cleanup finalizer.
                  yield* Effect.addFinalizer(() =>
                    releaseManagedTunnelOnShutdown().pipe(
                      Effect.timeout("10 seconds"),
                      Effect.tap((released) =>
                        released
                          ? Effect.logInfo("Released the managed tunnel on shutdown")
                          : Effect.void,
                      ),
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          "Failed to release the managed tunnel on shutdown; the next link reuses it",
                          { cause },
                        ),
                      ),
                      Effect.asVoid,
                    ),
                  );
                  if (!(yield* CloudCliState.readCliDesiredCloudLink)) return;
                  const server = yield* HttpServer.HttpServer;
                  const address = server.address;
                  if (typeof address === "string" || !("port" in address)) return;
                  yield* Effect.sleep("250 millis").pipe(
                    Effect.andThen(reconcileDesiredCloudLink(`http://127.0.0.1:${address.port}`)),
                    Effect.retry({
                      while: (error) =>
                        error._tag !== "EnvironmentHttpBadRequestError" &&
                        error._tag !== "EnvironmentHttpUnauthorizedError" &&
                        error._tag !== "EnvironmentHttpConflictError",
                      schedule: Schedule.exponential("1 second").pipe(
                        Schedule.modifyDelay(({ duration }) =>
                          Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                        ),
                        Schedule.upTo({ duration: "10 minutes" }),
                      ),
                    }),
                    Effect.tap(() =>
                      Effect.logInfo("T3 Connect desired link reconciled on startup"),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to reconcile T3 Connect desired link on startup", {
                        cause,
                      }),
                    ),
                  );
                }),
              );
              yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
            }),
          ).pipe(Layer.provide(LegacyHostedRuntimeLayerLive));

    const runtimeServicesLive = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [
          Deferred.await(runtimeStateParked),
          Deferred.await(cloudLinkParked),
          Deferred.await(routesReady),
          ...(tailscaleServeEnabled ? [Deferred.await(tailscaleParked)] : []),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(Layer.provideMerge(runtimeDependenciesLive), Layer.provide(launcherLayer));

    const routesLayer = HttpRouter.serve(makeRoutesLayer.pipe(Layer.provide(launcherLayer)), {
      disableLogger: !config.logWebSocketEvents,
    }).pipe(Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)));
    const serverApplicationLayer = Layer.mergeAll(
      routesLayer,
      httpListeningLayer,
      runtimeStateLayer,
      tailscaleServeLayer,
      cloudDesiredLinkReconcileLayer,
    );

    const relayTracingLayer = legacyFleetFeatures ? serverRelayBrokerTracingLayer : Layer.empty;
    return serverApplicationLayer.pipe(
      Layer.provideMerge(runtimeServicesLive),
      Layer.provide(activationLayer),
      Layer.provideMerge(relayTracingLayer),
      Layer.provideMerge(HttpResponseCompressionLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ApplicationObservabilityLive),
      Layer.provide(hostedRuntimeLayer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// The CLI supplies configuration.
export const runServer = Layer.launch(makeServerLayer);
