import { describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import rootSource from "./routes/__root.tsx?raw";
import mainSource from "./main.tsx?raw";
import platformSource from "./connection/platform.ts?raw";
import runtimeSource from "./lib/runtime.ts?raw";
import connectionsRouteSource from "./routes/settings.connections.tsx?raw";

const cocoaClientRoots = [
  mainSource,
  rootSource,
  platformSource,
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
      'from "../components/settings/ConnectionsSettings"',
    ]) {
      expect(cocoaClientRoots).not.toContain(forbidden);
    }
    expect(connectionsRouteSource).toContain("DirectConnectionsSettings");
  });
});
