import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  encodeCocoaHostPairingToken,
  type CocoaHostTransport,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAddCocoaHostSettingsPatch,
  buildRemoveCocoaHostSettingsPatch,
  deriveCocoaHostConnections,
  parseCocoaHostPairingInput,
  readCocoaHostIconSvg,
  sanitizeCocoaHostIconSvg,
  withCocoaHostIconSvg,
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

    expect(patch.providerInstances?.[ProviderInstanceId.make("codex")]).toMatchObject({
      driver: "codex",
      displayName: "host-one.example.test",
      enabled: true,
      config: {
        endpointTransport: {
          type: "cocoa-host",
          url: "wss://host-one.example.test/socket",
          key: "first-key",
        },
      },
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
    expect(instance?.config).toEqual({
      customModels: ["gpt-custom"],
      endpointTransport: {
        type: "cocoa-host",
        url: "wss://host-one.example.test/socket",
        key: "first-key",
      },
    });
  });

  it("derives collision-free instance ids from later hostnames", () => {
    const first = buildAddCocoaHostSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      transport("wss://host-one.example.test/socket", "first-key"),
    );
    const firstSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: first.providerInstances!,
    };
    const second = buildAddCocoaHostSettingsPatch(
      firstSettings,
      transport("wss://host-two.example.test/socket", "second-key"),
    );
    const secondSettings = {
      ...firstSettings,
      providerInstances: second.providerInstances!,
    };
    const duplicateHostname = buildAddCocoaHostSettingsPatch(
      secondSettings,
      transport("wss://host-two.example.test/other", "third-key"),
    );

    expect(Object.keys(second.providerInstances!)).toContain("codex_host_two_example_test");
    expect(Object.keys(duplicateHostname.providerInstances!)).toContain(
      "codex_host_two_example_test_2",
    );
  });

  it("removes the last host without leaving an invalid disabled provider slot", () => {
    const added = buildAddCocoaHostSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      transport("wss://host-one.example.test/socket", "first-key"),
    );
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: added.providerInstances!,
    };
    const [connection] = deriveCocoaHostConnections(settings);
    const removed = buildRemoveCocoaHostSettingsPatch(settings, connection!);

    expect(removed.providerInstances).toEqual({});
    expect(deriveCocoaHostConnections({ providerInstances: removed.providerInstances! })).toEqual(
      [],
    );
  });

  it("repoints selected model roles when their host is removed and another remains", () => {
    const first = buildAddCocoaHostSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      transport("wss://host-one.example.test/socket", "first-key"),
    );
    const withFirst = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: first.providerInstances!,
    };
    const second = buildAddCocoaHostSettingsPatch(
      withFirst,
      transport("wss://host-two.example.test/socket", "second-key"),
    );
    const settings = {
      ...withFirst,
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

  it("stores only bounded inert SVG host icons", () => {
    const instance = {
      driver: ProviderDriverKind.make("codex"),
      config: { endpointTransport: transport("wss://host.test/socket", "key") },
    };
    const svg = sanitizeCocoaHostIconSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    );
    const withIcon = withCocoaHostIconSvg(instance, svg);

    expect(readCocoaHostIconSvg(withIcon)).toBe(svg);
    expect(readCocoaHostIconSvg(withCocoaHostIconSvg(withIcon, null))).toBeNull();
    expect(() => sanitizeCocoaHostIconSvg("<svg><script>alert(1)</script></svg>")).toThrow();
    expect(() =>
      sanitizeCocoaHostIconSvg('<svg><image href="https://example.test/icon.png"/></svg>'),
    ).toThrow();
  });
});
