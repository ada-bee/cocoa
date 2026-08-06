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
    gatewayLayers: ["CocoaServerEnvironmentLayerLive"],
    legacyCallSites: ["ServerEnvironment.layer", "ProcessRunner.layer", "fixPath"],
  },
} as const;

/** Any entry is a temporary exception which must be removed before release. */
export const COCOA_GATEWAY_FORBIDDEN_DEPENDENCY_ALLOWLIST: readonly string[] = [];
