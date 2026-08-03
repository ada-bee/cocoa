import { describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import rootSource from "./routes/__root.tsx?raw";
import mainSource from "./main.tsx?raw";
import platformSource from "./connection/platform.ts?raw";
import sidebarSource from "./components/Sidebar.tsx?raw";
import commandPaletteSource from "./components/CommandPalette.tsx?raw";
import directConnectionsSettingsSource from "./components/settings/DirectConnectionsSettings.tsx?raw";
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
  directConnectionsSettingsSource,
  providerStatusSource,
  settingsSearchSource,
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
    expect(connectionsRouteSource).toContain("DirectConnectionsSettings");
  });
});
