import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderHostId,
  ProviderInstanceId,
  encodeCocoaHostPairingToken,
  type CocoaHostTransport,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAddCocoaHostSettingsPatch,
  buildRemoveCocoaHostSettingsPatch,
  buildUpdateCocoaHostSettingsPatch,
  deriveCocoaHostConnections,
  parseCocoaHostPairingInput,
} from "./HostConnectionsSettings.logic";

const transport = (url: string, key: string): CocoaHostTransport =>
  parseCocoaHostPairingInput(
    `cocoa-host-v1:${Buffer.from(JSON.stringify({ version: 1, url, key })).toString("base64url")}`,
  );

describe("Cocoa host connections", () => {
  it("parses the printed pairing token and infers plaintext transport acknowledgement", () => {
    const decoded = transport("ws://host-one.lan:4774", "host-key");

    expect(decoded).toEqual({
      type: "cocoa-host",
      url: "ws://host-one.lan:4774",
      key: "host-key",
      allowInsecureTransport: true,
    });
    expect(parseCocoaHostPairingInput(encodeCocoaHostPairingToken(decoded))).toEqual(decoded);
  });

  it("rejects anything except a Cocoa host pairing token", () => {
    expect(() => parseCocoaHostPairingInput("ws://host-one.lan:4774")).toThrowError(
      "Enter a valid Cocoa host pairing token.",
    );
  });

  it("adds the first host as codex and preserves the selected model and options", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("old_codex"),
        model: "gpt-existing",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    };

    const patch = buildAddCocoaHostSettingsPatch(
      settings,
      transport("wss://host-one.example.test/socket", "first-key"),
    );

    expect(patch.providerHosts?.[ProviderHostId.make("host_one_example_test")]).toMatchObject({
      displayName: "host-one.example.test",
      transport: {
        type: "cocoa-host",
        url: "wss://host-one.example.test/socket",
        key: "first-key",
      },
    });
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex")]).toMatchObject({
      driver: "codex",
      hostId: "host_one_example_test",
      enabled: true,
      config: {},
    });
    expect(patch.textGenerationModelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-existing",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("replaces legacy local-process configuration when pairing the first host", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          environment: [{ name: "CODEX_HOME", value: "/legacy" }],
          config: {
            binaryPath: "/legacy/codex",
            launchArgs: "app-server",
            customModels: ["gpt-custom"],
          },
        },
      },
    };

    const patch = buildAddCocoaHostSettingsPatch(
      settings,
      transport("wss://host-one.example.test/socket", "first-key"),
    );
    const instance = patch.providerInstances?.[ProviderInstanceId.make("codex")];

    expect(instance).not.toHaveProperty("environment");
    expect(instance?.hostId).toBe("host_one_example_test");
    expect(instance?.config).toEqual({
      customModels: ["gpt-custom"],
    });
    expect(patch.providerHosts?.[ProviderHostId.make("host_one_example_test")]?.transport.key).toBe(
      "first-key",
    );
  });

  it("derives collision-free instance ids from later hostnames", () => {
    const first = buildAddCocoaHostSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      transport("wss://host-one.example.test/socket", "first-key"),
    );
    const firstSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerHosts: first.providerHosts!,
      providerInstances: first.providerInstances!,
    };
    const second = buildAddCocoaHostSettingsPatch(
      firstSettings,
      transport("wss://host-two.example.test/socket", "second-key"),
    );
    const secondSettings = {
      ...firstSettings,
      providerHosts: second.providerHosts!,
      providerInstances: second.providerInstances!,
    };
    const duplicateHostname = buildAddCocoaHostSettingsPatch(
      secondSettings,
      transport("wss://host-two.example.test/other", "third-key"),
    );

    expect(Object.keys(second.providerHosts!)).toContain("host_two_example_test");
    expect(Object.keys(duplicateHostname.providerHosts!)).toContain("host_two_example_test_2");
    expect(Object.keys(duplicateHostname.providerInstances!)).toContain(
      "codex_host_two_example_test_2",
    );
  });

  it("prefixes numeric hostnames with a valid provider host id segment", () => {
    const patch = buildAddCocoaHostSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      transport("ws://192.168.20.61:4501", "host-key"),
    );

    expect(Object.keys(patch.providerHosts!)).toEqual(["host_192_168_20_61"]);
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex")]?.hostId).toBe(
      "host_192_168_20_61",
    );
  });

  it("migrates a legacy IP endpoint when its appearance changes", () => {
    const endpointTransport = transport("ws://192.168.20.61:4501", "host-key");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Rigatoni",
          config: { endpointTransport },
        },
      },
    };
    const [legacy] = deriveCocoaHostConnections(settings);
    const patch = buildUpdateCocoaHostSettingsPatch(settings, legacy!, {
      ...legacy!.host,
      icon: "database",
      accentColor: "#7c3aed",
    });

    expect(patch.providerHosts?.[ProviderHostId.make("host_192_168_20_61")]).toMatchObject({
      icon: "database",
      accentColor: "#7c3aed",
    });
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex")]?.hostId).toBe(
      "host_192_168_20_61",
    );
  });

  it("updates an existing host transport without duplicating its Codex binding", () => {
    const first = buildAddCocoaHostSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      transport("wss://host-one.example.test/socket", "first-key"),
    );
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerHosts: {
        ...first.providerHosts!,
        host_one_example_test: {
          ...first.providerHosts?.[ProviderHostId.make("host_one_example_test")]!,
          icon: "database" as const,
          accentColor: "#7c3aed",
        },
      },
      providerInstances: first.providerInstances!,
    };
    const updated = buildAddCocoaHostSettingsPatch(
      settings,
      transport("wss://host-one.example.test/socket", "rotated-key"),
    );

    expect(Object.keys(updated.providerHosts!)).toEqual(["host_one_example_test"]);
    expect(Object.keys(updated.providerInstances!)).toEqual(["codex"]);
    expect(
      updated.providerHosts?.[ProviderHostId.make("host_one_example_test")]?.transport.key,
    ).toBe("rotated-key");
    expect(updated.providerHosts?.[ProviderHostId.make("host_one_example_test")]).toMatchObject({
      icon: "database",
      accentColor: "#7c3aed",
    });
    expect(updated.providerInstances?.[ProviderInstanceId.make("codex")]?.hostId).toBe(
      "host_one_example_test",
    );
  });

  it("removes the last host without leaving an invalid disabled provider slot", () => {
    const added = buildAddCocoaHostSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      transport("wss://host-one.example.test/socket", "first-key"),
    );
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerHosts: added.providerHosts!,
      providerInstances: added.providerInstances!,
    };
    const [connection] = deriveCocoaHostConnections(settings);
    const removed = buildRemoveCocoaHostSettingsPatch(settings, connection!);

    expect(removed.providerInstances).toEqual({});
    expect(removed.providerHosts).toEqual({});
    expect(
      deriveCocoaHostConnections({
        providerHosts: removed.providerHosts!,
        providerInstances: removed.providerInstances!,
      }),
    ).toEqual([]);
  });

  it("repoints selected model roles when their host is removed and another remains", () => {
    const first = buildAddCocoaHostSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      transport("wss://host-one.example.test/socket", "first-key"),
    );
    const withFirst = {
      ...DEFAULT_SERVER_SETTINGS,
      providerHosts: first.providerHosts!,
      providerInstances: first.providerInstances!,
    };
    const second = buildAddCocoaHostSettingsPatch(
      withFirst,
      transport("wss://host-two.example.test/socket", "second-key"),
    );
    const settings = {
      ...withFirst,
      providerHosts: second.providerHosts!,
      providerInstances: second.providerInstances!,
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "text-model",
        options: [{ id: "reasoningEffort", value: "high" }] as const,
      },
      sourceControlWriterModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "writer-model",
        options: [{ id: "reasoningEffort", value: "medium" }] as const,
      },
      textGenerationModelSelections: {
        codex: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "per-provider-model",
        },
        codex_host_two_example_test: {
          instanceId: ProviderInstanceId.make("codex_host_two_example_test"),
          model: "remaining-model",
        },
      },
      defaultModelSelections: {
        codex: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "removed-default",
        },
        codex_host_two_example_test: {
          instanceId: ProviderInstanceId.make("codex_host_two_example_test"),
          model: "remaining-default",
        },
      },
    };
    const [firstConnection] = deriveCocoaHostConnections(settings);

    const removed = buildRemoveCocoaHostSettingsPatch(settings, firstConnection!);

    expect(removed.textGenerationModelSelection).toEqual({
      instanceId: "codex_host_two_example_test",
      model: "text-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(removed.sourceControlWriterModelSelection).toEqual({
      instanceId: "codex_host_two_example_test",
      model: "writer-model",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
    expect(removed.textGenerationModelSelections).toEqual({
      codex_host_two_example_test: {
        instanceId: "codex_host_two_example_test",
        model: "remaining-model",
      },
    });
    expect(removed.defaultModelSelections).toEqual({
      codex_host_two_example_test: {
        instanceId: "codex_host_two_example_test",
        model: "remaining-default",
      },
    });
  });

  it("derives canonical hosts first and keeps a narrow legacy endpoint fallback", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerHosts: {
        mac_studio: {
          displayName: "Mac Studio",
          transport: transport("wss://mac-studio.test/socket", "new-key"),
        },
      },
      providerInstances: {
        codex: {
          driver: ProviderDriverKind.make("codex"),
          hostId: ProviderHostId.make("mac_studio"),
        },
        codex_legacy: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Old host",
          config: { endpointTransport: transport("wss://old-host.test/socket", "old-key") },
        },
      },
    };

    const [canonical, legacy] = deriveCocoaHostConnections(settings);
    expect(canonical).toMatchObject({
      hostId: "mac_studio",
      host: { displayName: "Mac Studio" },
      codexBinding: { instanceId: "codex" },
      legacy: false,
    });
    expect(legacy).toMatchObject({
      hostId: "legacy_codex_legacy",
      host: { displayName: "Old host" },
      codexBinding: { instanceId: "codex_legacy" },
      legacy: true,
    });
  });

  it("migrates a legacy connection when its host appearance is edited", () => {
    const legacyTransport = transport("wss://old-host.test/socket", "old-key");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex: {
          driver: ProviderDriverKind.make("codex"),
          config: { endpointTransport: legacyTransport },
        },
      },
    };
    const [legacy] = deriveCocoaHostConnections(settings);
    const patch = buildUpdateCocoaHostSettingsPatch(settings, legacy!, {
      displayName: "Renamed host",
      transport: legacyTransport,
    });

    expect(patch.providerHosts?.[ProviderHostId.make("old_host_test")]?.displayName).toBe(
      "Renamed host",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex")]?.hostId).toBe(
      "old_host_test",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex")]?.config).not.toHaveProperty(
      "endpointTransport",
    );
  });

  it("explicitly removes every provider bound to a deleted host", () => {
    const hostId = ProviderHostId.make("shared_host");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerHosts: {
        shared_host: { transport: transport("wss://shared.test/socket", "key") },
      },
      providerInstances: {
        codex: { driver: ProviderDriverKind.make("codex"), hostId },
        opencode: { driver: ProviderDriverKind.make("opencode"), hostId },
        remote_other: { driver: ProviderDriverKind.make("codex") },
      },
    };
    const [connection] = deriveCocoaHostConnections(settings);
    const patch = buildRemoveCocoaHostSettingsPatch(settings, connection!);

    expect(patch.providerHosts).toEqual({});
    expect(patch.providerInstances).toEqual({
      remote_other: { driver: "codex" },
    });
  });
});
