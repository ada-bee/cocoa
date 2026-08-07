import { HostConnectionsSettings } from "./HostConnectionsSettings";

/**
 * Cocoa keeps the upstream provider-settings route/component boundary, but
 * clients never connect to execution environments directly. Provider hosts
 * are configured through the gateway and will project their nested harnesses
 * into this panel as the host protocol grows.
 */
export function ProviderSettingsPanel() {
  return <HostConnectionsSettings />;
}
