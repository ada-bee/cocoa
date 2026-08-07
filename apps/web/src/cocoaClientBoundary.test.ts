import { describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import rootSource from "./routes/__root.tsx?raw";
import mainSource from "./main.tsx?raw";
import platformSource from "./connection/platform.ts?raw";
import sidebarSource from "./components/Sidebar.tsx?raw";
import commandPaletteSource from "./components/CommandPalette.tsx?raw";
import hostConnectionsSettingsSource from "./components/settings/HostConnectionsSettings.tsx?raw";
import addProviderInstanceDialogSource from "./components/settings/AddProviderInstanceDialog.tsx?raw";
import providerSettingsFormSource from "./components/settings/ProviderSettingsForm.tsx?raw";
import providerInstanceCardSource from "./components/settings/ProviderInstanceCard.tsx?raw";
import settingsPanelsSource from "./components/settings/SettingsPanels.tsx?raw";
import providerStatusSource from "./components/settings/providerStatus.ts?raw";
import settingsSearchSource from "./components/settings/settingsSearch.ts?raw";
import primaryHttpLayerSource from "./environments/primary/httpLayer.ts?raw";
import runtimeSource from "./lib/runtime.ts?raw";
import connectionsRouteSource from "./routes/settings.connections.tsx?raw";

const cocoaClientRoots = [
  mainSource,
  rootSource,
  platformSource,
  sidebarSource,
  commandPaletteSource,
  hostConnectionsSettingsSource,
  providerStatusSource,
  settingsSearchSource,
  providerSettingsFormSource,
  primaryHttpLayerSource,
  runtimeSource,
  connectionsRouteSource,
].join("\n");

describe("Cocoa web client boundary", () => {
  it("does not depend on hosted identity or relay packages", () => {
    expect(packageJson.dependencies).not.toHaveProperty("@clerk/react");
    expect(packageJson.dependencies).not.toHaveProperty("@clerk/electron");
    expect(packageJson.dependencies).not.toHaveProperty("jose");
  });

  it("keeps Cocoa roots free of hosted, relay, SSH, and provider-update surfaces", () => {
    for (const forbidden of [
      "ManagedRelay",
      "Clerk",
      "Dpop",
      "SshEnvironmentGateway",
      "ConnectOnboardingDialog",
      "RelayClientInstallDialog",
      "ProviderUpdateLaunchNotification",
      "desktopLocal",
      "DesktopLocal",
      "getLocalEnvironment",
      "readDesktopPrimaryBearerToken",
      "provider-update",
      "install the latest provider",
      'from "../components/settings/ConnectionsSettings"',
    ]) {
      expect(cocoaClientRoots).not.toContain(forbidden);
    }
    expect(connectionsRouteSource).toContain("HostConnectionsSettings");
    expect(hostConnectionsSettingsSource).toContain("useUpdatePrimarySettings");
    expect(hostConnectionsSettingsSource).not.toContain("new WebSocket");
    expect(settingsPanelsSource).toContain("deriveCocoaHostConnections");
    expect(settingsPanelsSource).not.toContain("AddProviderInstanceDialog");
    expect(providerSettingsFormSource).toContain('definition.value === "codex"');
    expect(settingsPanelsSource).toContain("connectionManaged");
    expect(providerInstanceCardSource).toContain("connectionManaged ? null");
  });

  it("keeps host pairing as the only Cocoa provider creation surface", () => {
    expect(settingsPanelsSource).toContain("deriveCocoaHostConnections");
    expect(settingsPanelsSource).not.toContain("AddProviderInstanceDialog");
    expect(addProviderInstanceDialogSource).toContain("COCOA_PROVIDER_CLIENT_DEFINITIONS");
    expect(addProviderInstanceDialogSource).toContain("COCOA_PROVIDER_CLIENT_DEFINITION_BY_VALUE");
    expect(addProviderInstanceDialogSource).not.toContain("DRIVER_OPTIONS.map");
    expect(addProviderInstanceDialogSource).not.toContain("COMING_SOON_DRIVER_OPTIONS");
  });
});
