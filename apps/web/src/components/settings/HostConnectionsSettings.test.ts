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
  parseGatewayPairingInput,
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
  });
});

describe("Cocoa gateway pairing", () => {
  it("accepts a full pairing link and keeps credentials out of the saved host", () => {
    expect(
      parseGatewayPairingInput({
        gateway: "https://cocoa.example.test/pair#token=one-time-secret",
        pairingCode: "",
      }),
    ).toEqual({
      host: "https://cocoa.example.test",
      pairingCode: "one-time-secret",
    });
  });

  it("accepts a gateway URL with a separately entered code", () => {
    expect(
      parseGatewayPairingInput({
        gateway: "192.168.20.99:3773/path",
        pairingCode: "pair-code",
      }),
    ).toEqual({
      host: "https://192.168.20.99:3773",
      pairingCode: "pair-code",
    });
  });

  it("rejects an input without a one-time code", () => {
    expect(() =>
      parseGatewayPairingInput({ gateway: "https://cocoa.example.test", pairingCode: "" }),
    ).toThrowError("Enter the one-time pairing code from the gateway.");
  });
});
