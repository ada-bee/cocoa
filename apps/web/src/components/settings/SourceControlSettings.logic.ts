import type {
  ServerSettings,
  ServerSettingsPatch,
  SourceControlHostingProviderKind,
} from "@t3tools/contracts";
import {
  buildUpdateCocoaHostSettingsPatch,
  deriveCocoaHostConnections,
  type CocoaHostConnection,
} from "./HostConnectionsSettings.logic";

/**
 * Store one hosting integration as either disabled or bound to a concrete,
 * canonical provider host. Selecting a legacy endpoint migrates it in the
 * same settings update so the gateway never sees a synthetic `legacy_*` id.
 */
export function buildSourceControlHostingProviderPatch(
  settings: ServerSettings,
  kind: SourceControlHostingProviderKind,
  connection: CocoaHostConnection | null,
): ServerSettingsPatch {
  const sourceControlHostingHostDefaults = {
    ...settings.sourceControlHostingHostDefaults,
  };
  const sourceControlDisabledHostingProviders =
    connection === null
      ? settings.sourceControlDisabledHostingProviders.includes(kind)
        ? settings.sourceControlDisabledHostingProviders
        : [...settings.sourceControlDisabledHostingProviders, kind]
      : settings.sourceControlDisabledHostingProviders.filter((candidate) => candidate !== kind);

  if (connection === null) {
    delete sourceControlHostingHostDefaults[kind];
    return { sourceControlDisabledHostingProviders, sourceControlHostingHostDefaults };
  }

  if (!connection.legacy) {
    sourceControlHostingHostDefaults[kind] = connection.hostId;
    return { sourceControlDisabledHostingProviders, sourceControlHostingHostDefaults };
  }

  const migration = buildUpdateCocoaHostSettingsPatch(settings, connection, connection.host);
  const providerHosts = migration.providerHosts ?? settings.providerHosts;
  const providerInstances = migration.providerInstances ?? settings.providerInstances;
  const canonical = deriveCocoaHostConnections({ providerHosts, providerInstances }).find(
    (candidate) => !candidate.legacy && candidate.transport.url === connection.transport.url,
  );
  if (!canonical) throw new Error("Could not migrate the selected provider host.");

  sourceControlHostingHostDefaults[kind] = canonical.hostId;
  return {
    ...migration,
    sourceControlDisabledHostingProviders,
    sourceControlHostingHostDefaults,
  };
}
