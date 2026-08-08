import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderHostId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveCocoaHostConnections } from "./HostConnectionsSettings.logic";
import { buildSourceControlHostingProviderPatch } from "./SourceControlSettings.logic";

const canonicalSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerHosts: {
    shared_host: {
      displayName: "Shared host",
      transport: {
        type: "cocoa-host" as const,
        url: "wss://shared.example.test/control",
        key: "shared-host-key",
      },
    },
  },
};
const canonicalHost = deriveCocoaHostConnections(canonicalSettings)[0]!;

describe("source-control hosting host defaults", () => {
  it("sets one service default without replacing the others", () => {
    const patch = buildSourceControlHostingProviderPatch(
      {
        ...canonicalSettings,
        sourceControlHostingHostDefaults: {
          gitlab: ProviderHostId.make("gitlab_host"),
        },
      },
      "github",
      canonicalHost,
    );

    expect(patch.sourceControlHostingHostDefaults).toEqual({
      github: "shared_host",
      gitlab: "gitlab_host",
    });
    expect(patch.sourceControlDisabledHostingProviders).toEqual([]);
  });

  it("disables one provider by removing its host while preserving other defaults", () => {
    const patch = buildSourceControlHostingProviderPatch(
      {
        ...canonicalSettings,
        sourceControlHostingHostDefaults: {
          github: ProviderHostId.make("shared_host"),
          gitlab: ProviderHostId.make("shared_host"),
        },
      },
      "github",
      null,
    );

    expect(patch.sourceControlHostingHostDefaults).toEqual({ gitlab: "shared_host" });
    expect(patch.sourceControlDisabledHostingProviders).toEqual(["github"]);
  });

  it("enables one provider on a concrete host without changing the others", () => {
    const patch = buildSourceControlHostingProviderPatch(
      {
        ...canonicalSettings,
        sourceControlDisabledHostingProviders: ["github", "azure-devops"],
      },
      "github",
      canonicalHost,
    );

    expect(patch.sourceControlDisabledHostingProviders).toEqual(["azure-devops"]);
    expect(patch.sourceControlHostingHostDefaults).toEqual({ github: "shared_host" });
  });

  it("atomically migrates a legacy endpoint before selecting it", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: {
            endpointTransport: {
              type: "cocoa-host" as const,
              url: "wss://legacy.example.test/control",
              key: "legacy-host-key",
            },
          },
        },
      },
      sourceControlDisabledHostingProviders: ["github"] as const,
    };
    const legacyHost = deriveCocoaHostConnections(settings)[0]!;

    const patch = buildSourceControlHostingProviderPatch(settings, "github", legacyHost);

    expect(patch.providerHosts?.[ProviderHostId.make("legacy_example_test")]?.transport.url).toBe(
      "wss://legacy.example.test/control",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex")]?.hostId).toBe(
      "legacy_example_test",
    );
    expect(patch.sourceControlHostingHostDefaults).toEqual({
      github: "legacy_example_test",
    });
    expect(patch.sourceControlDisabledHostingProviders).toEqual([]);
  });
});
