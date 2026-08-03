import { describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import appConfigSource from "../app.config.ts?raw";
import appSource from "./App.tsx?raw";
import stackSource from "./Stack.tsx?raw";
import platformSource from "./connection/platform.ts?raw";
import catalogStoreSource from "./connection/catalog-store.ts?raw";
import connectionStorageSource from "./connection/storage.ts?raw";
import runtimeSource from "./lib/runtime.ts?raw";
import settingsSource from "./features/settings/SettingsRouteScreen.tsx?raw";
import environmentsSource from "./features/settings/SettingsEnvironmentsRouteScreen.tsx?raw";
import controllerSource from "./features/connection/useConnectionController.ts?raw";

const productionRoots = [
  appConfigSource,
  appSource,
  stackSource,
  platformSource,
  runtimeSource,
  settingsSource,
  environmentsSource,
  controllerSource,
].join("\n");

describe("Cocoa mobile client boundary", () => {
  it("does not depend on hosted identity, relay, or DPoP packages", () => {
    expect(packageJson.dependencies).not.toHaveProperty("@clerk/expo");
    expect(packageJson.dependencies).not.toHaveProperty("@noble/curves");
    expect(packageJson.dependencies).not.toHaveProperty("@noble/hashes");
    expect(packageJson.dependencies).not.toHaveProperty("expo-auth-session");
    expect(packageJson.dependencies).not.toHaveProperty("expo-web-browser");
  });

  it("keeps production roots free of hosted, relay, SSH, and cloud surfaces", () => {
    for (const forbidden of [
      "@clerk",
      "ManagedRelay",
      "CloudSession",
      "RelayDeviceIdentity",
      "SshEnvironmentGateway",
      "DPoP",
      "Dpop",
      "T3 Connect",
      "CloudAuthProvider",
      "ConnectOnboarding",
      "CloudEnvironmentRows",
    ]) {
      expect(productionRoots).not.toContain(forbidden);
    }
  });

  it("persists the direct catalog, including bearer credentials, through SecureStore", () => {
    expect(catalogStoreSource).toContain("MobileSecureStorage.MobileSecureStorage");
    expect(connectionStorageSource).toContain("CredentialStore.ConnectionCredentialStore");
    expect(catalogStoreSource).not.toContain("console.");
    expect(connectionStorageSource).not.toContain("console.");
  });
});
