import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderHostId } from "./providerHost.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings sidebar v2", () => {
  it("defaults the beta off with a three-day auto-settle threshold", () => {
    const settings = decodeClientSettings({});
    expect(settings.sidebarV2Enabled).toBe(false);
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
  });

  it("treats settings written before the beta had a per-channel default as unconfigured", () => {
    // The stored blob always carries `sidebarV2Enabled`, so only the companion
    // flag can distinguish "user opted out" from "never touched it".
    expect(decodeClientSettings({ sidebarV2Enabled: false }).sidebarV2ConfiguredByUser).toBe(false);
    expect(decodeClientSettings({ sidebarV2Enabled: true }).sidebarV2ConfiguredByUser).toBe(false);
  });

  it("preserves an explicit beta choice", () => {
    const settings = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(settings.sidebarV2Enabled).toBe(false);
    expect(settings.sidebarV2ConfiguredByUser).toBe(true);
  });

  it("carries an explicit beta opt-out through the patch the beta toggle writes", () => {
    const patch = decodeClientSettingsPatch({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(patch.sidebarV2Enabled).toBe(false);
    expect(patch.sidebarV2ConfiguredByUser).toBe(true);
  });

  it("allows auto-settle by inactivity to be disabled", () => {
    expect(
      decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
    ).toBeNull();
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults text generation to Luna at low reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettings.providerHosts", () => {
  it("defaults to an empty catalog for legacy settings", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerHosts).toEqual({});
    expect(decodeServerSettings({}).providerHosts).toEqual({});
  });

  it("decodes first-class hosts and instance host references", () => {
    const decoded = decodeServerSettings({
      providerHosts: {
        mac_studio: {
          displayName: "Mac Studio",
          iconSvg: "<svg />",
          accentColor: "#dc2626",
          transport: {
            type: "cocoa-host",
            url: "wss://mac-studio.example.test/",
            key: "host-key",
          },
        },
      },
      providerInstances: {
        codex_work: {
          driver: "codex",
          hostId: "mac_studio",
        },
      },
    });

    const hostId = ProviderHostId.make("mac_studio");
    expect(decoded.providerHosts[hostId]?.displayName).toBe("Mac Studio");
    expect(decoded.providerHosts[hostId]?.iconSvg).toBe("<svg />");
    expect(decoded.providerHosts[hostId]?.accentColor).toBe("#dc2626");
    expect(decoded.providerInstances[ProviderInstanceId.make("codex_work")]?.hostId).toBe(hostId);
  });

  it("treats providerHosts patches as optional whole-map replacements", () => {
    expect(decodeServerSettingsPatch({}).providerHosts).toBeUndefined();

    const patch = decodeServerSettingsPatch({
      providerHosts: {
        linux_build: {
          transport: {
            type: "cocoa-host",
            url: "wss://linux.example.test/",
            key: "linux-key",
          },
        },
      },
    });

    expect(patch.providerHosts?.[ProviderHostId.make("linux_build")]?.transport.url).toBe(
      "wss://linux.example.test/",
    );
  });
});

describe("ServerSettings.sourceControlHostingHostDefaults", () => {
  it("defaults to no centralized hosting-operation hosts", () => {
    expect(DEFAULT_SERVER_SETTINGS.sourceControlHostingHostDefaults).toEqual({});
    expect(decodeServerSettings({}).sourceControlHostingHostDefaults).toEqual({});
  });

  it("decodes and patches per-service provider hosts", () => {
    const decoded = decodeServerSettings({
      sourceControlHostingHostDefaults: {
        github: "mac_studio",
        gitlab: "linux_build",
      },
    });
    expect(decoded.sourceControlHostingHostDefaults).toEqual({
      github: ProviderHostId.make("mac_studio"),
      gitlab: ProviderHostId.make("linux_build"),
    });

    expect(
      decodeServerSettingsPatch({
        sourceControlHostingHostDefaults: { github: "linux_build" },
      }).sourceControlHostingHostDefaults,
    ).toEqual({ github: ProviderHostId.make("linux_build") });
  });
});

describe("ServerSettings source-control provider overrides", () => {
  it("defaults legacy settings to no disabled hosting providers or scoped writer selections", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlDisabledHostingProviders).toEqual([]);
    expect(settings.sourceControlWriterModelSelections).toEqual({});
    expect(DEFAULT_SERVER_SETTINGS.sourceControlDisabledHostingProviders).toEqual([]);
    expect(DEFAULT_SERVER_SETTINGS.sourceControlWriterModelSelections).toEqual({});
  });

  it("decodes provider-scoped writer selections and disabled hosting providers", () => {
    const settings = decodeServerSettings({
      sourceControlDisabledHostingProviders: ["github", "azure-devops"],
      sourceControlWriterModelSelections: {
        codex_work: {
          instanceId: "codex_writer",
          model: "gpt-5.4-mini",
        },
      },
    });

    expect(settings.sourceControlDisabledHostingProviders).toEqual(["github", "azure-devops"]);
    expect(settings.sourceControlWriterModelSelections).toEqual({
      [ProviderInstanceId.make("codex_work")]: {
        instanceId: ProviderInstanceId.make("codex_writer"),
        model: "gpt-5.4-mini",
      },
    });
  });

  it("keeps both patch fields optional and validates their closed boundaries", () => {
    const empty = decodeServerSettingsPatch({});
    expect(empty.sourceControlDisabledHostingProviders).toBeUndefined();
    expect(empty.sourceControlWriterModelSelections).toBeUndefined();

    const patch = decodeServerSettingsPatch({
      sourceControlDisabledHostingProviders: [],
      sourceControlWriterModelSelections: {},
    });
    expect(patch.sourceControlDisabledHostingProviders).toEqual([]);
    expect(patch.sourceControlWriterModelSelections).toEqual({});

    expect(() =>
      decodeServerSettingsPatch({ sourceControlDisabledHostingProviders: ["gitea"] }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({ sourceControlDisabledHostingProviders: ["unknown"] }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({ sourceControlDisabledHostingProviders: ["github", "github"] }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        sourceControlWriterModelSelections: {
          "invalid provider id": { instanceId: "codex", model: "gpt-5" },
        },
      }),
    ).toThrow();
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it("defaults all style settings for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlWritingStyle).toEqual({
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    expect(settings.sourceControlWriterModelSelection).toBeNull();
  });

  it("trims partial style updates", () => {
    const patch = decodeServerSettingsPatch({
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "  Prefer concise wording.  ",
      },
    });

    expect(patch.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Prefer concise wording.",
    });
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      textGenerationModelSelections: {
        codex_personal: {
          instanceId: "codex_personal",
          model: "  gpt-5.4-title  ",
        },
      },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(
      patch.textGenerationModelSelections?.[ProviderInstanceId.make("codex_personal")]?.model,
    ).toBe("gpt-5.4-title");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});
