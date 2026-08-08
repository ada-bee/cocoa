import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetService from "@t3tools/shared/Net";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitorCore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerEnvironment from "../environment/CocoaServerEnvironment.ts";
import * as Keybindings from "../keybindings.ts";
import { CoreOrchestrationReactorLive } from "../orchestration/Layers/CoreOrchestrationReactor.ts";
import { CheckpointCoordinatorLive } from "../orchestration/Layers/CheckpointCoordinator.ts";
import { CheckpointRevertGateLive } from "../orchestration/Layers/CheckpointRevertGate.ts";
import { CheckpointRevertReactorLive } from "../orchestration/Layers/CheckpointRevertReactor.ts";
import { PostTurnCheckpointReactorLive } from "../orchestration/Layers/PostTurnCheckpointReactor.ts";
import { ProviderCommandReactorLive } from "../orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { RuntimeReceiptBusLive } from "../orchestration/Layers/RuntimeReceiptBus.ts";
import { ThreadDeletionReactorLive } from "../orchestration/Layers/ThreadDeletionReactor.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { CheckpointRevertIntentRepositoryLive } from "../persistence/Layers/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepositoryLive } from "../persistence/Layers/CheckpointRevertSagas.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { PostTurnCheckpointIntentRepositoryLive } from "../persistence/Layers/PostTurnCheckpointIntents.ts";
import { ProviderConversationCacheRepositoryLive } from "../persistence/Layers/ProviderConversationCache.ts";
import { ProjectionCheckpointRepositoryLive } from "../persistence/Layers/ProjectionCheckpoints.ts";
import { ProviderCheckpointOperationRepositoryLive } from "../persistence/Layers/ProviderCheckpointOperations.ts";
import { cocoaLayerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/SqliteCore.ts";
import { TurnDispatchJournalRepositoryLive } from "../persistence/Layers/TurnDispatchJournal.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProjectExecution from "../project/ProjectExecution.ts";
import * as ProjectFaviconResolver from "../project/CocoaProjectFaviconResolver.ts";
import * as ProjectRepository from "../project/ProjectRepository.ts";
import * as ProviderRepositoryIdentityResolver from "../project/ProviderRepositoryIdentityResolver.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectTerminal from "../project/ProjectTerminal.ts";
import * as ProjectWorkspace from "../project/ProjectWorkspace.ts";
import * as RepositoryReadService from "../project/RepositoryReadService.ts";
import * as RepositoryMutationService from "../project/RepositoryMutationService.ts";
import * as RepositoryGitActionService from "../project/RepositoryGitActionService.ts";
import * as RepositoryStatusBroadcaster from "../project/RepositoryStatusBroadcaster.ts";
import { ProviderAdapterRegistryLive } from "../provider/Layers/ProviderAdapterRegistry.ts";
import * as ProviderEventLoggers from "../provider/Layers/ProviderEventLoggersService.ts";
import { ProviderGenerationRecoveryReactorLive } from "../provider/Layers/ProviderGenerationRecoveryReactor.ts";
import { ProviderConversationCacheSyncLive } from "../provider/Layers/ProviderConversationCacheSync.ts";
import { ProviderConversationProjectionQueryLive } from "../provider/Layers/ProviderConversationProjectionQuery.ts";
import { ProviderConversationAuthorityLive } from "../provider/Layers/ProviderConversationAuthority.ts";
import { CocoaProviderInstanceRegistryHydrationLive } from "../provider/Layers/CocoaProviderInstanceRegistryHydration.ts";
import { ProviderRegistryLive } from "../provider/Layers/ProviderRegistry.ts";
import { ProviderServiceLive } from "../provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionReaperLive } from "../provider/Layers/ProviderSessionReaper.ts";
import * as ProviderFilesystemBrowse from "../provider/ProviderFilesystemBrowse.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as TerminalManager from "../terminal/ProviderManagerLayer.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as AnalyticsService from "../telemetry/AnalyticsServiceContract.ts";
import * as UsageService from "../usage/UsageService.ts";
import {
  CocoaExternalLauncherLayerLive,
  CocoaUnavailableDiagnosticsLayerLive,
} from "./CocoaGatewayRuntimeStubs.ts";

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const ServerSettingsLayerLive = ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer));

const AuthLayerLive = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerSecretStore.layer),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);

const ProviderLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

const ProviderRuntimeLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const CocoaProjectRepositoryLayerLive = ProjectRepository.layer.pipe(
  Layer.provide(CocoaProviderInstanceRegistryHydrationLive),
  Layer.provide(OrchestrationLayerLive),
);

const CocoaProviderRepositoryIdentityResolverLayerLive =
  ProviderRepositoryIdentityResolver.layer.pipe(
    Layer.provide(CocoaProviderInstanceRegistryHydrationLive),
  );

const ProviderCheckpointOperationLayerLive = ProviderCheckpointOperationRepositoryLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

const ProviderConversationCacheRepositoryLayerLive = ProviderConversationCacheRepositoryLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

const OrchestrationCommandReceiptRepositoryLayerLive =
  OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provide(PersistenceLayerLive));

const ProviderConversationCacheSyncLayerLive = ProviderConversationCacheSyncLive.pipe(
  Layer.provide(ProviderConversationCacheRepositoryLayerLive),
  Layer.provide(CocoaProviderInstanceRegistryHydrationLive),
  Layer.provide(ProviderSessionDirectoryLayerLive),
  Layer.provide(OrchestrationLayerLive),
);

const ProviderConversationProjectionQueryLayerLive = ProviderConversationProjectionQueryLive.pipe(
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(ProviderConversationCacheRepositoryLayerLive),
  Layer.provide(ProviderConversationCacheSyncLayerLive),
  Layer.provide(CocoaProviderRepositoryIdentityResolverLayerLive),
);

const ProviderConversationAuthorityLayerLive = ProviderConversationAuthorityLive.pipe(
  Layer.provide(ProviderConversationCacheRepositoryLayerLive),
  Layer.provide(CocoaProviderInstanceRegistryHydrationLive),
  Layer.provide(ProviderSessionDirectoryLayerLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLayerLive),
);

const CheckpointCoordinatorLayerLive = CheckpointCoordinatorLive.pipe(
  Layer.provide(CocoaProjectRepositoryLayerLive),
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(ProviderCheckpointOperationLayerLive),
);

const CheckpointRevertGateLayerLive = CheckpointRevertGateLive.pipe(
  Layer.provide(CheckpointRevertIntentRepositoryLive),
);

const ProviderCommandReactorLayerLive = ProviderCommandReactorLive.pipe(
  Layer.provide(TurnDispatchJournalRepositoryLive),
  Layer.provide(CheckpointCoordinatorLayerLive),
  Layer.provide(CheckpointRevertGateLayerLive),
);

const PostTurnCheckpointReactorLayerLive = PostTurnCheckpointReactorLive.pipe(
  Layer.provide(CocoaProjectRepositoryLayerLive),
  Layer.provide(TurnDispatchJournalRepositoryLive),
  Layer.provide(PostTurnCheckpointIntentRepositoryLive),
  Layer.provide(ProviderCheckpointOperationLayerLive),
);

const CheckpointRevertReactorLayerLive = CheckpointRevertReactorLive.pipe(
  Layer.provide(CocoaProjectRepositoryLayerLive),
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(ProviderCheckpointOperationLayerLive),
  Layer.provide(ProjectionCheckpointRepositoryLive),
  Layer.provide(CheckpointRevertIntentRepositoryLive),
  Layer.provide(CheckpointRevertSagaRepositoryLive),
);

const ProviderGenerationRecoveryLayerLive = ProviderGenerationRecoveryReactorLive.pipe(
  Layer.provide(ProviderCommandReactorLayerLive),
  Layer.provide(PostTurnCheckpointReactorLayerLive),
  Layer.provide(CheckpointRevertReactorLayerLive),
);

const CocoaReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CoreOrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderGenerationRecoveryLayerLive),
  Layer.provideMerge(TurnDispatchJournalRepositoryLive),
  Layer.provideMerge(PostTurnCheckpointIntentRepositoryLive),
  Layer.provideMerge(CheckpointRevertIntentRepositoryLive),
  Layer.provideMerge(CheckpointRevertSagaRepositoryLive),
  Layer.provideMerge(ProjectionCheckpointRepositoryLive),
  Layer.provideMerge(ProviderCheckpointOperationLayerLive),
  Layer.provideMerge(CheckpointCoordinatorLayerLive),
  Layer.provideMerge(ProviderCommandReactorLayerLive),
  Layer.provideMerge(PostTurnCheckpointReactorLayerLive),
  Layer.provideMerge(CheckpointRevertReactorLayerLive),
  Layer.provideMerge(CheckpointRevertGateLayerLive),
  Layer.provideMerge(ThreadDeletionReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const CocoaProjectTerminalLayerLive = ProjectTerminal.layer.pipe(
  Layer.provide(CocoaProviderInstanceRegistryHydrationLive),
  Layer.provide(OrchestrationLayerLive),
);

const CocoaTerminalLayerLive = TerminalManager.layer.pipe(
  Layer.provide(CocoaProjectTerminalLayerLive),
);

const CocoaProjectWorkspaceLayerLive = ProjectWorkspace.layer.pipe(
  Layer.provide(CocoaProviderInstanceRegistryHydrationLive),
  Layer.provide(OrchestrationLayerLive),
);

const CocoaProjectExecutionLayerLive = ProjectExecution.layer.pipe(
  Layer.provide(CocoaProviderInstanceRegistryHydrationLive),
  Layer.provide(OrchestrationLayerLive),
);

const CocoaProviderFilesystemBrowseLayerLive = ProviderFilesystemBrowse.layer.pipe(
  Layer.provide(CocoaProviderInstanceRegistryHydrationLive),
);

const CocoaWorkspaceAccessLayerLive = Layer.mergeAll(
  CocoaProjectWorkspaceLayerLive,
  CocoaProviderFilesystemBrowseLayerLive,
);

const CocoaProjectFaviconResolverLayerLive = ProjectFaviconResolver.layer;

const CocoaRepositoryReadLayerLive = RepositoryReadService.layer.pipe(
  Layer.provide(CocoaProjectRepositoryLayerLive),
);

const CocoaRepositoryMutationLayerLive = RepositoryMutationService.layer.pipe(
  Layer.provide(CocoaProjectRepositoryLayerLive),
);

const CocoaTextGenerationLayerLive = TextGeneration.layer.pipe(
  Layer.provide(CocoaProviderInstanceRegistryHydrationLive),
);

const CocoaRepositoryGitActionLayerLive = RepositoryGitActionService.layer.pipe(
  Layer.provide(CocoaProjectRepositoryLayerLive),
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(CocoaTextGenerationLayerLive),
);

const CocoaRepositoryStatusLayerLive = RepositoryStatusBroadcaster.layer.pipe(
  Layer.provide(CocoaRepositoryReadLayerLive),
);

const CocoaCheckpointingLayerLive = CheckpointDiffQuery.layer.pipe(
  Layer.provide(CocoaProjectRepositoryLayerLive),
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(ProviderCheckpointOperationLayerLive),
);

const CocoaProjectSetupScriptRunnerLayerLive = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(CocoaTerminalLayerLive),
  Layer.provide(OrchestrationLayerLive),
);

const CocoaBackgroundLayerLive = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(ServerSettingsLayerLive),
);

const CocoaRuntimeBaseFoundationLive = CocoaReactorLayerLive.pipe(
  Layer.provideMerge(ServerSettingsLayerLive),
  Layer.provideMerge(CocoaCheckpointingLayerLive),
  Layer.provideMerge(ProviderRuntimeLayerLive),
  Layer.provideMerge(ProviderConversationCacheRepositoryLayerLive),
  Layer.provideMerge(ProviderConversationCacheSyncLayerLive),
  Layer.provideMerge(ProviderConversationProjectionQueryLayerLive),
  // Routes and startup consume the base projection service directly. Keep it
  // exported even though provider-aware projections wrap it for Cocoa reads.
  Layer.provideMerge(OrchestrationLayerLive),
  Layer.provideMerge(ProviderConversationAuthorityLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(Keybindings.layer),
  Layer.provideMerge(ProviderRegistryLive),
  Layer.provideMerge(CocoaProviderInstanceRegistryHydrationLive),
  Layer.provideMerge(ProviderEventLoggers.layerDisabled),
  Layer.provideMerge(CocoaWorkspaceAccessLayerLive),
  Layer.provideMerge(CocoaProjectExecutionLayerLive),
  Layer.provideMerge(CocoaProjectRepositoryLayerLive),
);

const CocoaRuntimeBaseWithUsageLive = UsageService.layer.pipe(
  Layer.provideMerge(CocoaRuntimeBaseFoundationLive),
);

const CocoaRuntimeBaseDependenciesLive = CocoaRuntimeBaseWithUsageLive.pipe(
  Layer.provideMerge(CocoaRepositoryReadLayerLive),
  Layer.provideMerge(CocoaRepositoryMutationLayerLive),
  Layer.provideMerge(CocoaRepositoryStatusLayerLive),
  Layer.provideMerge(CocoaProjectTerminalLayerLive),
  Layer.provideMerge(CocoaTerminalLayerLive),
  Layer.provideMerge(CocoaProjectSetupScriptRunnerLayerLive),
  Layer.provideMerge(PreviewManager.layer),
);

const CocoaRuntimeCoreDependenciesLive = CocoaRuntimeBaseDependenciesLive.pipe(
  Layer.provideMerge(CocoaProjectFaviconResolverLayerLive),
  Layer.provideMerge(CocoaTextGenerationLayerLive),
  Layer.provideMerge(CocoaRepositoryGitActionLayerLive),
  Layer.provideMerge(ServerEnvironment.layer),
  Layer.provideMerge(AuthLayerLive),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(CocoaBackgroundLayerLive),
  Layer.provideMerge(CocoaExternalLauncherLayerLive),
  Layer.provideMerge(CocoaUnavailableDiagnosticsLayerLive),
);

export const CocoaRuntimeDependenciesLive = CocoaRuntimeCoreDependenciesLive.pipe(
  Layer.provideMerge(AnalyticsService.layerDisabled),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provide(NetService.layer),
  Layer.provide(ProviderEventLoggers.layerDisabled),
  Layer.provide(ServerSettingsLayerLive),
);

// Force this module's runtime graph to remain entirely statically importable. A
// dynamic import here could hide a transitive dependency from the architecture
// closure walker.
export const CocoaGatewayRuntimeStaticImportSentinel = Effect.void;
