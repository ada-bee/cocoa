import type { CocoaGatewayArchitectureClassification } from "./CocoaGatewayArchitectureAudit.ts";

/**
 * Executable dependency map for Cocoa's remote-only server composition.
 *
 * `gatewayLayers` are the permitted remote replacements for each forbidden
 * local-operation category. `legacyCallSites` name the corresponding
 * local/hosted implementations kept in the shared source tree for upstream
 * compatibility. The architecture test verifies that none of those legacy
 * symbols enter the Cocoa layer assembly.
 */
export const COCOA_GATEWAY_RUNTIME_DEPENDENCY_MAP = {
  providerLifecycle: {
    gatewayLayers: ["CocoaProviderInstanceRegistryHydrationLive"],
    legacyCallSites: [
      "ProviderInstanceRegistryHydrationLive",
      "LegacyProviderInstanceRegistryHydrationLive",
      "BUILT_IN_DRIVERS",
      "OpenCodeRuntime.OpenCodeRuntimeLive",
    ],
  },
  projectFilesystem: {
    gatewayLayers: ["CocoaWorkspaceAccessLayerLive"],
    legacyCallSites: [
      "WorkspaceAccessLayerLive",
      "WorkspaceLayerLive",
      "WorkspacePaths.layer",
      "WorkspaceEntriesLayerLive",
      "T3ProjectFileLoader.layer",
      "RepositoryIdentityResolver.layer",
      "ProjectFaviconResolverLayerLive",
    ],
  },
  projectVcs: {
    gatewayLayers: [
      "CocoaProjectRepositoryLayerLive",
      "CocoaRepositoryReadLayerLive",
      "CocoaRepositoryStatusLayerLive",
      "CocoaCheckpointingLayerLive",
    ],
    legacyCallSites: [
      "CheckpointingLayerLive",
      "CheckpointStore.layer",
      "SourceControlProviderRegistryLayerLive",
      "GitManagerLayerLive",
      "GitLayerLive",
      "GitVcsDriver.layer",
      "VcsDriverRegistryLayerLive",
      "VcsProvisioningService.layer",
      "GitWorkflowLayerLive",
      "ReviewLayerLive",
      "SourceControlRepositoryServiceLayerLive",
      "VcsLayerLive",
      "VcsProcess.layer",
    ],
  },
  shellAndTerminal: {
    gatewayLayers: [
      "CocoaProjectTerminalLayerLive",
      "CocoaTerminalLayerLive",
      "CocoaExternalLauncherLayerLive",
    ],
    legacyCallSites: [
      "PreviewLayerLive",
      "PortScannerLayerLive",
      "ProcessRunner.layer",
      "ExternalLauncher.layer",
    ],
  },
  hostedConnectivity: {
    gatewayLayers: [],
    legacyCallSites: [
      "LegacyHostedRuntimeLayerLive",
      "RelayClientLive",
      "AgentAwarenessRelay.layer",
      "serverRelayBrokerTracingLayer",
    ],
  },
  localDiagnostics: {
    gatewayLayers: ["CocoaUnavailableDiagnosticsLayerLive"],
    legacyCallSites: ["ResourceDiagnosticsLayerLive", "ResourceTelemetryLayerLive"],
  },
  serverEnvironment: {
    gatewayLayers: ["ServerEnvironment.cocoaGatewayLayer"],
    legacyCallSites: ["ServerEnvironment.layer", "ProcessRunner.layer", "fixPath"],
  },
} as const;

/** Any entry is a temporary exception which must be removed before release. */
export const COCOA_GATEWAY_FORBIDDEN_DEPENDENCY_ALLOWLIST: readonly string[] = [];

export const COCOA_GATEWAY_RUNTIME_ENTRY = "cocoa/CocoaGatewayRuntime.ts";

export type CocoaGatewayRuntimeDependencyCategory =
  | "authentication"
  | "diagnostics"
  | "gateway-persistence"
  | "gateway-runtime"
  | "provider-endpoint"
  | "provider-workspace"
  | "provider-vcs"
  | "terminal"
  | "turn-orchestration";

/**
 * Complete direct-import manifest for the isolated Cocoa runtime composition.
 *
 * The architecture test checks this list for exact equality with the runtime
 * module's relative imports, recursively walks those imports, and reports the
 * full transitive module inventory. Adding a runtime dependency therefore
 * requires an intentional category here before it can enter Cocoa.
 */
export const COCOA_GATEWAY_RUNTIME_IMPORT_MANIFEST: ReadonlyArray<{
  readonly path: string;
  readonly category: CocoaGatewayRuntimeDependencyCategory;
}> = [
  { path: "auth/EnvironmentAuth.ts", category: "authentication" },
  { path: "auth/ServerSecretStore.ts", category: "authentication" },
  { path: "background/BackgroundPolicy.ts", category: "gateway-runtime" },
  { path: "background/HostPowerMonitor.ts", category: "gateway-runtime" },
  { path: "checkpointing/CheckpointDiffQuery.ts", category: "provider-vcs" },
  { path: "cocoa/CocoaGatewayRuntimeStubs.ts", category: "gateway-runtime" },
  { path: "diagnostics/TraceDiagnostics.ts", category: "diagnostics" },
  { path: "environment/ServerEnvironment.ts", category: "gateway-runtime" },
  { path: "keybindings.ts", category: "gateway-runtime" },
  {
    path: "orchestration/Layers/CheckpointCoordinator.ts",
    category: "turn-orchestration",
  },
  { path: "orchestration/Layers/CheckpointRevertGate.ts", category: "turn-orchestration" },
  {
    path: "orchestration/Layers/CheckpointRevertReactor.ts",
    category: "turn-orchestration",
  },
  {
    path: "orchestration/Layers/OrchestrationReactor.ts",
    category: "turn-orchestration",
  },
  {
    path: "orchestration/Layers/PostTurnCheckpointReactor.ts",
    category: "turn-orchestration",
  },
  {
    path: "orchestration/Layers/ProviderCommandReactor.ts",
    category: "turn-orchestration",
  },
  {
    path: "orchestration/Layers/ProviderRuntimeIngestion.ts",
    category: "turn-orchestration",
  },
  { path: "orchestration/Layers/RuntimeReceiptBus.ts", category: "turn-orchestration" },
  {
    path: "orchestration/Layers/ThreadDeletionReactor.ts",
    category: "turn-orchestration",
  },
  { path: "orchestration/runtimeLayer.ts", category: "turn-orchestration" },
  {
    path: "persistence/Layers/CheckpointRevertIntents.ts",
    category: "gateway-persistence",
  },
  {
    path: "persistence/Layers/CheckpointRevertSagas.ts",
    category: "gateway-persistence",
  },
  {
    path: "persistence/Layers/PostTurnCheckpointIntents.ts",
    category: "gateway-persistence",
  },
  {
    path: "persistence/Layers/ProjectionCheckpoints.ts",
    category: "gateway-persistence",
  },
  {
    path: "persistence/Layers/ProviderCheckpointOperations.ts",
    category: "gateway-persistence",
  },
  { path: "persistence/Layers/SqliteCore.ts", category: "gateway-persistence" },
  {
    path: "persistence/Layers/TurnDispatchJournal.ts",
    category: "gateway-persistence",
  },
  { path: "persistence/ProviderSessionRuntime.ts", category: "gateway-persistence" },
  { path: "preview/Manager.ts", category: "gateway-runtime" },
  { path: "project/ProjectExecution.ts", category: "provider-endpoint" },
  { path: "project/ProjectFaviconResolver.ts", category: "provider-workspace" },
  { path: "project/ProjectRepository.ts", category: "provider-vcs" },
  { path: "project/ProjectSetupScriptRunner.ts", category: "terminal" },
  { path: "project/ProjectTerminal.ts", category: "terminal" },
  { path: "project/ProjectWorkspace.ts", category: "provider-workspace" },
  { path: "project/RepositoryReadService.ts", category: "provider-vcs" },
  { path: "project/RepositoryStatusBroadcaster.ts", category: "provider-vcs" },
  { path: "provider/Layers/ProviderAdapterRegistry.ts", category: "provider-endpoint" },
  { path: "provider/Layers/ProviderEventLoggers.ts", category: "gateway-persistence" },
  {
    path: "provider/Layers/ProviderGenerationRecoveryReactor.ts",
    category: "turn-orchestration",
  },
  {
    path: "provider/Layers/CocoaProviderInstanceRegistryHydration.ts",
    category: "provider-endpoint",
  },
  { path: "provider/Layers/ProviderRegistry.ts", category: "provider-endpoint" },
  { path: "provider/Layers/ProviderService.ts", category: "provider-endpoint" },
  { path: "provider/Layers/ProviderSessionDirectory.ts", category: "provider-endpoint" },
  { path: "provider/Layers/ProviderSessionReaper.ts", category: "provider-endpoint" },
  { path: "provider/ProviderFilesystemBrowse.ts", category: "provider-workspace" },
  { path: "serverLifecycleEvents.ts", category: "gateway-runtime" },
  { path: "serverSettings.ts", category: "gateway-persistence" },
  { path: "telemetry/AnalyticsService.ts", category: "diagnostics" },
  { path: "terminal/Manager.ts", category: "terminal" },
  { path: "textGeneration/TextGeneration.ts", category: "provider-endpoint" },
] as const;

/**
 * Exact capability classifications inside the transitive Cocoa source closure.
 * These are not exceptions: each entry explains why a seemingly forbidden host
 * primitive belongs to a gateway-owned or provider-host boundary. The separate
 * exception allowlist above remains empty.
 */
export const COCOA_GATEWAY_TRANSITIVE_CALLSITE_MANIFEST = [
  {
    sourcePath: "atomicWrite.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Shared atomic writes are scoped to gateway-owned state files.",
  },
  {
    sourcePath: "attachmentStore.ts",
    specifier: "node:fs",
    capability: "local-project-filesystem",
    classification: "gateway-attachment-storage",
    rationale: "Gateway-owned bounded attachment blobs live outside provider workspaces.",
  },
  {
    sourcePath: "auth/ServerSecretStore.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-auth-secret-storage",
    rationale: "Stores only the gateway authentication secret under gateway state.",
  },
  {
    sourcePath: "cloud/pinnedRuntime.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Only the disabled legacy self-update branch inspects its pinned runtime.",
  },
  {
    sourcePath: "cloud/pinnedRuntime.ts",
    specifier: "../processRunner.ts",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "Reachable only through legacy server-environment exports; Cocoa uses cocoaGatewayLayer.",
  },
  {
    sourcePath: "cloud/selfUpdate.ts",
    specifier: "../processRunner.ts",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa supplies administrator-managed update behavior and never invokes the legacy updater.",
  },
  {
    sourcePath: "cloud/selfUpdate.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa disables the legacy updater and its local runtime replacement writes.",
  },
  {
    sourcePath: "config.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-configuration-storage",
    rationale: "Loads gateway configuration and creates gateway-owned state directories.",
  },
  {
    sourcePath: "cloud/selfUpdate.ts",
    specifier: "./serviceLauncherClient.ts",
    capability: "hosted-connectivity",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa supplies administrator-managed update behavior and never invokes hosted launchers.",
  },
  {
    sourcePath: "cocoa/CocoaGatewayRuntimeStubs.ts",
    specifier: "../process/externalLauncher.ts",
    capability: "local-shell-or-pty",
    classification: "gateway-unavailable-stub",
    rationale:
      "Imports only the service contract and installs an implementation that always reports unavailable.",
  },
  {
    sourcePath: "diagnostics/ProcessDiagnostics.ts",
    specifier: "symbol:process.kill",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa installs CocoaUnavailableDiagnosticsLayerLive and never constructs process diagnostics.",
  },
  {
    sourcePath: "diagnostics/TraceDiagnostics.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-diagnostics-storage",
    rationale: "Writes opt-in gateway trace diagnostics, never provider workspace data.",
  },
  {
    sourcePath: "environment/ServerEnvironment.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Persists only the stable gateway environment identifier under gateway state.",
  },
  {
    sourcePath: "environment/ServerEnvironment.ts",
    specifier: "../cloud/serviceLauncherClient.ts",
    capability: "hosted-connectivity",
    classification: "shared-module-legacy-branch",
    rationale:
      "The isolated runtime selects cocoaGatewayLayer, whose descriptor does not probe hosted launchers.",
  },
  {
    sourcePath: "environment/ServerEnvironment.ts",
    specifier: "../processRunner.ts",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "The isolated runtime selects cocoaGatewayLayer, whose descriptor does not run host commands.",
  },
  {
    sourcePath: "environment/ServerEnvironmentLabel.ts",
    specifier: "../processRunner.ts",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale: "Only the legacy ServerEnvironment.layer calls this label resolver.",
  },
  {
    sourcePath: "environment/ServerEnvironmentLabel.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Only the legacy environment label resolver reads host files.",
  },
  {
    sourcePath: "gatewayManagedImageAttachments.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-attachment-storage",
    rationale: "Reads bounded gateway-managed attachment blobs outside provider workspaces.",
  },
  {
    sourcePath: "keybindings.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-configuration-storage",
    rationale: "Persists gateway client keybinding configuration under gateway state.",
  },
  {
    sourcePath: "orchestration/Layers/OrchestrationReactor.ts",
    specifier: "../../relay/AgentAwarenessRelay.ts",
    capability: "hosted-connectivity",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa selects CoreOrchestrationReactorLive, which omits the relay service and start call.",
  },
  {
    sourcePath: "orchestration/Layers/ProjectionPipeline.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-attachment-storage",
    rationale: "Projection side effects remove gateway-owned attachments for deleted threads.",
  },
  {
    sourcePath: "persistence/Layers/SqliteCore.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Creates the parent directory for Cocoa's gateway-owned SQLite database.",
  },
  {
    sourcePath: "process/externalLauncher.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-unavailable-stub",
    rationale: "Cocoa imports the contract but installs the always-unavailable launcher stub.",
  },
  {
    sourcePath: "project/ProjectFaviconResolver.ts",
    specifier: "../workspace/WorkspacePaths.ts",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa selects the no-op layer; only makeLocal performs favicon discovery.",
  },
  {
    sourcePath: "project/ProjectFaviconResolver.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa selects the no-op layer; only makeLocal reads favicon files.",
  },
  {
    sourcePath: "project/ProjectFaviconResolver.ts",
    specifier: "./T3ProjectFileLoader.ts",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa selects the no-op layer; only makeLocal loads project files.",
  },
  {
    sourcePath: "project/T3ProjectFileLoader.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa project workspace access is provider-backed; this local loader is unreachable.",
  },
  {
    sourcePath: "provider/Drivers/CodexDriver.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "provider-endpoint-credential-storage",
    rationale: "Endpoint construction may read an administrator-configured credential file.",
  },
  {
    sourcePath: "provider/Drivers/CodexHomeLayout.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Shadow-home materialization belongs to the unreachable local Codex branch.",
  },
  {
    sourcePath: "provider/Layers/CodexAdapter.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Local Codex adapter filesystem access is unreachable under endpoint-only policy.",
  },
  {
    sourcePath: "provider/Layers/ProviderRegistry.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Supplies gateway state storage required by the provider status cache.",
  },
  {
    sourcePath: "provider/codexEndpoint/CodexEndpointFactory.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "provider-endpoint-credential-storage",
    rationale:
      "Propagates filesystem capability solely for endpoint credentials and SSH transport.",
  },
  {
    sourcePath: "provider/codexEndpoint/CodexEndpointFactory.ts",
    specifier: "effect/unstable/process",
    capability: "local-shell-or-pty",
    classification: "provider-endpoint-ssh-transport",
    rationale: "The process service is scoped to the fixed ssh app-server proxy transport helper.",
  },
  {
    sourcePath: "provider/codexEndpoint/CodexEndpointSupervisor.ts",
    specifier: "effect/unstable/process",
    capability: "local-shell-or-pty",
    classification: "provider-endpoint-ssh-transport",
    rationale: "The supervisor passes the process service only to endpoint transport construction.",
  },
  {
    sourcePath: "provider/codexEndpoint/CodexEndpointSupervisor.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "provider-endpoint-credential-storage",
    rationale: "Propagates filesystem capability solely to configured endpoint transports.",
  },
  {
    sourcePath: "provider/codexEndpoint/DirectWebSocketConnector.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "provider-endpoint-credential-storage",
    rationale: "Reads only an explicitly configured bearer-token credential path.",
  },
  {
    sourcePath: "provider/codexEndpoint/SshProxyConnector.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "provider-endpoint-ssh-transport",
    rationale: "Effect's SSH child-process transport requires the platform filesystem service.",
  },
  {
    sourcePath: "provider/codexEndpoint/SshProxyConnector.ts",
    specifier: "effect/unstable/process",
    capability: "local-shell-or-pty",
    classification: "provider-endpoint-ssh-transport",
    rationale: "This module spawns only the administrator-configured ssh connection helper.",
  },
  {
    sourcePath: "provider/Drivers/CodexDriver.ts",
    specifier: "effect/unstable/process",
    capability: "local-shell-or-pty",
    classification: "provider-endpoint-ssh-transport",
    rationale:
      "Cocoa policy requires endpoint mode; its process requirement constructs the ssh transport.",
  },
  {
    sourcePath: "provider/Layers/CodexAdapter.ts",
    specifier: "effect/unstable/process",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "Local Codex adapter construction is unreachable under required Cocoa endpoint policy.",
  },
  {
    sourcePath: "provider/Layers/CodexSessionRuntime.ts",
    specifier: "effect/unstable/process",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale: "Local Codex session spawning is unreachable under required Cocoa endpoint policy.",
  },
  {
    sourcePath: "provider/Layers/EventNdjsonLogger.ts",
    specifier: "node:fs",
    capability: "local-project-filesystem",
    classification: "gateway-provider-event-log",
    rationale:
      "Writes bounded gateway diagnostics under gateway state, never a provider workspace.",
  },
  {
    sourcePath: "provider/providerSnapshot.ts",
    specifier: "../processRunner.ts",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa endpoint snapshots are supplied by CodexDriver and do not run local provider probes.",
  },
  {
    sourcePath: "provider/providerMaintenance.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa disables provider updates; local executable canonicalization is unreachable.",
  },
  {
    sourcePath: "provider/providerStatusCache.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Persists provider status metadata under gateway state, not provider workspaces.",
  },
  {
    sourcePath: "provider/providerSnapshot.ts",
    specifier: "effect/unstable/process",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa endpoint snapshots are supplied by CodexDriver and do not spawn local providers.",
  },
  {
    sourcePath: "resourceTelemetry/DesktopTelemetryReceiver.ts",
    specifier: "node:fs",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa constructs HostPowerMonitor.make directly and never installs desktop telemetry.",
  },
  {
    sourcePath: "resourceTelemetry/NativeTelemetryClient.ts",
    specifier: "./ResourceMonitorBinary.ts",
    capability: "provider-process-lifecycle",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa does not install native resource telemetry or its helper binary.",
  },
  {
    sourcePath: "resourceTelemetry/ResourceMonitorBinary.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa never installs the native resource telemetry helper binary.",
  },
  {
    sourcePath: "serverSettings.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-configuration-storage",
    rationale: "Persists gateway settings under gateway state and watches administrator edits.",
  },
  {
    sourcePath: "telemetry/Identify.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa installs disabled analytics, so legacy telemetry identity files are unused.",
  },
  {
    sourcePath: "resourceTelemetry/NativeTelemetryClient.ts",
    specifier: "effect/unstable/process",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa does not install native resource telemetry or its helper process.",
  },
  {
    sourcePath: "terminal/Manager.ts",
    specifier: "../processRunner.ts",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "TerminalManager.layer uses makeProviderTerminalManager; only makeWithOptions is local PTY code.",
  },
  {
    sourcePath: "terminal/Manager.ts",
    specifier: "./PtyAdapter.ts",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale: "The provider terminal manager never constructs the local PTY implementation.",
  },
  {
    sourcePath: "terminal/Manager.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "The provider terminal manager never executes local shell discovery or history IO.",
  },
  {
    sourcePath: "terminal/Manager.ts",
    specifier: "symbol:process.kill",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "TerminalManager.layer uses makeProviderTerminalManager; process termination belongs to makeWithOptions.",
  },
  {
    sourcePath: "textGeneration/CodexTextGeneration.ts",
    specifier: "effect/unstable/process",
    capability: "local-shell-or-pty",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa selects endpoint-backed text generation and never installs local CodexTextGeneration.",
  },
  {
    sourcePath: "textGeneration/CodexTextGeneration.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale: "Cocoa selects endpoint-backed text generation, not the local Codex home reader.",
  },
  {
    sourcePath: "textGeneration/CodexEndpointTextGeneration.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-attachment-storage",
    rationale: "Reads gateway-managed prompt attachments before sending them to the endpoint.",
  },
  {
    sourcePath: "workspace/WorkspacePaths.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "shared-module-legacy-branch",
    rationale:
      "Cocoa uses provider workspace adapters; local workspace path discovery is unreachable.",
  },
] as const satisfies ReadonlyArray<CocoaGatewayArchitectureClassification>;
