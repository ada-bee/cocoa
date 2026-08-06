import type { CocoaGatewayArchitectureClassification } from "./CocoaGatewayArchitectureAudit.ts";

/** Human-readable cross-check for the remote-only replacements in Cocoa. */
export const COCOA_GATEWAY_RUNTIME_DEPENDENCY_MAP = {
  providerLifecycle: {
    gatewayLayers: ["CocoaProviderInstanceRegistryHydrationLive", "CodexEndpointDriver"],
    legacyCallSites: ["CodexDriver", "BUILT_IN_DRIVERS", "OpenCodeRuntimeLive"],
  },
  projectFilesystem: {
    gatewayLayers: ["CocoaWorkspaceAccessLayerLive"],
    legacyCallSites: [
      "WorkspaceAccessLayerLive",
      "WorkspacePaths.layer",
      "T3ProjectFileLoader.layer",
    ],
  },
  projectVcs: {
    gatewayLayers: [
      "CocoaProjectRepositoryLayerLive",
      "CocoaRepositoryReadLayerLive",
      "CocoaRepositoryStatusLayerLive",
      "CocoaCheckpointingLayerLive",
    ],
    legacyCallSites: ["GitManagerLayerLive", "GitVcsDriver.layer", "VcsProcess.layer"],
  },
  shellAndTerminal: {
    gatewayLayers: ["CocoaProjectTerminalLayerLive", "CocoaTerminalLayerLive"],
    legacyCallSites: ["PtyAdapter", "TerminalManager.layer", "ExternalLauncher.layer"],
  },
  hostedConnectivity: {
    gatewayLayers: [],
    legacyCallSites: ["RelayClientLive", "AgentAwarenessRelay.layer", "Tailscale"],
  },
  localDiagnostics: {
    gatewayLayers: ["CocoaUnavailableDiagnosticsLayerLive"],
    legacyCallSites: [
      "ResourceTelemetryLayerLive",
      "TraceDiagnostics.layer",
      "AnalyticsService.layer",
    ],
  },
  serverEnvironment: {
    gatewayLayers: ["CocoaServerEnvironment.layer"],
    legacyCallSites: ["ServerEnvironment.layer", "ServiceLauncherClient.layer", "fixPath"],
  },
} as const;

/** Any entry is a temporary exception which must be removed before release. */
export const COCOA_GATEWAY_FORBIDDEN_DEPENDENCY_ALLOWLIST: readonly string[] = [];

/** Audit the executable users deploy, not a hand-selected inner layer. */
export const COCOA_GATEWAY_RUNTIME_ENTRY = "cocoa-bin.ts";

export type CocoaGatewayRuntimeDependencyCategory =
  | "gateway-cli"
  | "gateway-configuration"
  | "gateway-runtime";

/** Exact relative imports at the production executable boundary. */
export const COCOA_GATEWAY_RUNTIME_IMPORT_MANIFEST: ReadonlyArray<{
  readonly path: string;
  readonly category: CocoaGatewayRuntimeDependencyCategory;
}> = [
  { path: "../package.json", category: "gateway-cli" },
  { path: "cocoa/CocoaGatewayCliConfig.ts", category: "gateway-configuration" },
  { path: "cocoa/CocoaGatewayServer.ts", category: "gateway-runtime" },
  { path: "config.ts", category: "gateway-configuration" },
] as const;

/**
 * Exact host-primitive evidence inside the Cocoa executable closure.
 *
 * Filesystem callsites are limited to gateway-owned state/assets/uploads or
 * endpoint transport credentials. The only process service is the configured
 * SSH proxy transport; Cocoa never starts a provider, project command, Git, or
 * PTY process on the gateway.
 */
export const COCOA_GATEWAY_TRANSITIVE_CALLSITE_MANIFEST = [
  {
    sourcePath: "assets/AssetAccess.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-configuration-storage",
    rationale: "Reads packaged reference-client assets, never provider workspace files.",
  },
  {
    sourcePath: "atomicWrite.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Atomically writes gateway-owned state files.",
  },
  {
    sourcePath: "attachmentStore.ts",
    specifier: "node:fs",
    capability: "local-project-filesystem",
    classification: "gateway-attachment-storage",
    rationale: "Stores bounded gateway-managed upload blobs.",
  },
  {
    sourcePath: "auth/ServerSecretStore.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-auth-secret-storage",
    rationale: "Stores only the gateway authentication secret.",
  },
  {
    sourcePath: "cocoa/CocoaGatewayCliConfig.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-configuration-storage",
    rationale: "Creates the administrator-selected gateway data directory.",
  },
  {
    sourcePath: "config.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-configuration-storage",
    rationale: "Derives and creates gateway-owned state paths.",
  },
  {
    sourcePath: "environment/CocoaServerEnvironment.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Persists the stable Cocoa gateway environment identifier.",
  },
  {
    sourcePath: "gatewayManagedImageAttachments.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-attachment-storage",
    rationale: "Reads only gateway-managed upload blobs before endpoint transfer.",
  },
  {
    sourcePath: "health/GatewayHealth.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Checks readiness of gateway-owned state paths.",
  },
  {
    sourcePath: "http.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-configuration-storage",
    rationale: "Serves packaged web assets and development assets configured by the administrator.",
  },
  {
    sourcePath: "keybindings.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-configuration-storage",
    rationale: "Loads gateway-owned reference-client keybinding settings.",
  },
  {
    sourcePath: "orchestration/Layers/ProjectionPipeline.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Materializes bounded gateway-owned projection attachments.",
  },
  {
    sourcePath: "orchestration/Normalizer.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Normalizes gateway-managed attachment references.",
  },
  {
    sourcePath: "persistence/Layers/SqliteCore.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Creates and opens the durable Cocoa SQLite database.",
  },
  ...[
    "provider/codexEndpoint/CodexEndpointFactory.ts",
    "provider/codexEndpoint/CodexEndpointSupervisor.ts",
    "provider/codexEndpoint/DirectWebSocketConnector.ts",
    "provider/codexEndpoint/SshProxyConnector.ts",
    "provider/Drivers/CodexEndpointDriver.ts",
  ].map(
    (sourcePath) =>
      ({
        sourcePath,
        specifier: "effect/FileSystem",
        capability: "local-project-filesystem",
        classification: "provider-endpoint-credential-storage",
        rationale: "Reads administrator-configured endpoint TLS or SSH credential material.",
      }) as const,
  ),
  ...[
    "provider/codexEndpoint/CodexEndpointFactory.ts",
    "provider/codexEndpoint/CodexEndpointSupervisor.ts",
    "provider/codexEndpoint/SshProxyConnector.ts",
    "provider/Drivers/CodexEndpointDriver.ts",
  ].map(
    (sourcePath) =>
      ({
        sourcePath,
        specifier: "effect/unstable/process",
        capability: "local-shell-or-pty",
        classification: "provider-endpoint-ssh-transport",
        rationale: "The SSH proxy transport launches only the configured system SSH client.",
      }) as const,
  ),
  {
    sourcePath: "provider/Layers/CodexAdapterCore.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-attachment-storage",
    rationale: "Reads gateway-managed turn attachments for transfer to Codex.",
  },
  {
    sourcePath: "provider/Layers/ProviderRegistry.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Persists gateway-owned provider status projections.",
  },
  {
    sourcePath: "provider/providerStatusCache.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Reads and writes gateway-owned provider status cache files.",
  },
  {
    sourcePath: "serverRuntimeState.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-persistence",
    rationale: "Persists the gateway listener runtime state.",
  },
  {
    sourcePath: "serverSettings.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-configuration-storage",
    rationale: "Reads and writes gateway provider endpoint settings.",
  },
  {
    sourcePath: "textGeneration/CodexEndpointTextGeneration.ts",
    specifier: "effect/FileSystem",
    capability: "local-project-filesystem",
    classification: "gateway-attachment-storage",
    rationale: "Reads gateway-managed prompt attachments before endpoint transfer.",
  },
] as const satisfies ReadonlyArray<CocoaGatewayArchitectureClassification>;
