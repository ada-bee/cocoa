import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CocoaGatewayPolicyError,
  resolveCocoaGatewayProviderInstanceConfigMap,
} from "./CocoaGatewayPolicy.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const validSettings = () =>
  decodeSettings({
    providerInstances: {
      macbook_air: {
        driver: "codex",
        config: {
          endpointTransport: {
            type: "cocoa-host",
            url: "wss://macaroni.test:4500",
            key: "test_host_key",
          },
        },
      },
      linux_dev_box: {
        driver: "codex",
        config: {
          endpointTransport: {
            type: "cocoa-host",
            url: "wss://rigatoni-alfredo.test:4500",
            key: "test_host_key",
          },
        },
      },
    },
    textGenerationModelSelection: {
      instanceId: "macbook_air",
      model: "gpt-5.4",
    },
  });

const expectReason = (settings: ServerSettings, reason: CocoaGatewayPolicyError["reason"]) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(resolveCocoaGatewayProviderInstanceConfigMap(settings));
    assert.instanceOf(error, CocoaGatewayPolicyError);
    assert.strictEqual(error.reason, reason);
  });

describe("Cocoa gateway provider policy", () => {
  it.effect("accepts administrator-installed endpoint tools", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          macbook_air: {
            driver: "codex",
            config: {
              endpointTransport: {
                type: "cocoa-host",
                url: "wss://macaroni.test:4500",
                key: "test_host_key",
              },
              workspaceHelper: {
                type: "inline-python3-v1",
                executablePath: "/usr/bin/python3",
              },
              endpointGitExecutablePath: "/usr/bin/git",
              checkpointHelper: {
                type: "cocoa-checkpoint-helper-v1",
                executablePath: "/opt/cocoa/bin/cocoa-workspace-helper",
                expectedProtocol: 1,
              },
            },
          },
        },
        textGenerationModelSelection: {
          instanceId: "macbook_air",
          model: "gpt-5.4",
        },
      });
      const resolved = yield* resolveCocoaGatewayProviderInstanceConfigMap(settings);

      expect(resolved[ProviderInstanceId.make("macbook_air")]?.config).toMatchObject({
        endpointGitExecutablePath: "/usr/bin/git",
        checkpointHelper: {
          type: "cocoa-checkpoint-helper-v1",
          executablePath: "/opt/cocoa/bin/cocoa-workspace-helper",
          expectedProtocol: 1,
        },
      });
    }),
  );

  it.effect("returns only explicitly configured endpoint-backed Codex instances", () =>
    Effect.gen(function* () {
      const settings = validSettings();
      const resolved = yield* resolveCocoaGatewayProviderInstanceConfigMap(settings);

      expect(Object.keys(resolved)).toEqual(["macbook_air", "linux_dev_box"]);
      assert.strictEqual(resolved, settings.providerInstances);
    }),
  );

  it.effect("accepts a Codex instance bound to a first-class provider host", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerHosts: {
          macbook: {
            transport: {
              type: "cocoa-host",
              url: "wss://macbook.test:4500",
              key: "persisted_random_key",
            },
          },
        },
        providerInstances: {
          codex: { driver: "codex", hostId: "macbook", config: {} },
        },
        textGenerationModelSelection: { instanceId: "codex", model: "gpt-5.4" },
      });

      const resolved = yield* resolveCocoaGatewayProviderInstanceConfigMap(settings);
      expect(resolved[ProviderInstanceId.make("codex")]).toMatchObject({
        driver: "codex",
        hostId: "macbook",
      });
    }),
  );

  it.effect("rejects an instance that references a missing provider host", () => {
    const settings = decodeSettings({
      providerInstances: {
        codex: { driver: "codex", hostId: "missing_host", config: {} },
      },
      textGenerationModelSelection: { instanceId: "codex", model: "gpt-5.4" },
    });
    return expectReason(settings, "missing-provider-host");
  });

  it.effect("rejects a generated-text selection stored under another provider's key", () => {
    const settings = validSettings();
    return expectReason(
      {
        ...settings,
        textGenerationModelSelections: {
          [ProviderInstanceId.make("macbook_air")]: {
            instanceId: ProviderInstanceId.make("linux_dev_box"),
            model: "gpt-5.4",
          },
        },
      },
      "invalid-model-selection",
    );
  });

  it.effect("rejects a host default stored under another provider's key", () => {
    const settings = validSettings();
    return expectReason(
      {
        ...settings,
        defaultModelSelections: {
          [ProviderInstanceId.make("macbook_air")]: {
            instanceId: ProviderInstanceId.make("linux_dev_box"),
            model: "gpt-5.4",
          },
        },
      },
      "invalid-model-selection",
    );
  });

  it.effect("accepts an empty explicit instance map as the online onboarding state", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({});
      const resolved = yield* resolveCocoaGatewayProviderInstanceConfigMap(settings);

      expect(resolved).toEqual({});
      assert.strictEqual(resolved, settings.providerInstances);
    }),
  );

  it.effect(
    "allows removing the last instance without requiring placeholder model selections",
    () =>
      Effect.gen(function* () {
        const withoutInstances = decodeSettings({
          providerInstances: {},
          textGenerationModelSelection: {
            instanceId: "removed_host",
            model: "gpt-5.4",
          },
          sourceControlWriterModelSelection: {
            instanceId: "removed_host",
            model: "gpt-5.4",
          },
        });
        const resolved = yield* resolveCocoaGatewayProviderInstanceConfigMap(withoutInstances);

        expect(resolved).toEqual({});
        assert.strictEqual(resolved, withoutInstances.providerInstances);
      }),
  );

  it.effect("accepts an explicitly configured external OpenCode daemon", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          opencode_remote: {
            driver: "opencode",
            config: {
              serverUrl: "https://opencode.example.test",
              serverPassword: "secret",
            },
          },
        },
        textGenerationModelSelection: {
          instanceId: "opencode_remote",
          model: "anthropic/claude-sonnet-4",
        },
      });

      const resolved = yield* resolveCocoaGatewayProviderInstanceConfigMap(settings);
      expect(resolved[ProviderInstanceId.make("opencode_remote")]?.config).toMatchObject({
        serverUrl: "https://opencode.example.test",
        serverPassword: "secret",
      });
    }),
  );

  it.effect("rejects OpenCode without an explicit daemon URL", () => {
    const settings = decodeSettings({
      providerInstances: {
        opencode_remote: {
          driver: "opencode",
          config: {},
        },
      },
      textGenerationModelSelection: {
        instanceId: "opencode_remote",
        model: "anthropic/claude-sonnet-4",
      },
    });
    return expectReason(settings, "missing-server-url");
  });

  it.effect("rejects unsupported drivers before registry construction", () => {
    const settings = validSettings();
    return expectReason(
      {
        ...settings,
        providerInstances: {
          ...settings.providerInstances,
          [ProviderInstanceId.make("linux_dev_box")]: {
            driver: "claudeAgent" as never,
            config: settings.providerInstances[ProviderInstanceId.make("linux_dev_box")]?.config,
          },
        },
      },
      "unsupported-driver",
    );
  });

  it.effect("rejects local-process fields even when an endpoint is present", () => {
    const settings = validSettings();
    return expectReason(
      {
        ...settings,
        providerInstances: {
          ...settings.providerInstances,
          [ProviderInstanceId.make("macbook_air")]: {
            ...settings.providerInstances[ProviderInstanceId.make("macbook_air")]!,
            config: {
              ...(settings.providerInstances[ProviderInstanceId.make("macbook_air")]!
                .config as object),
              binaryPath: "/usr/bin/codex",
            },
          },
        },
      },
      "local-process-field",
    );
  });

  it.effect("rejects API and model-provider credentials on the provider environment", () => {
    const settings = validSettings();
    const macbook = settings.providerInstances[ProviderInstanceId.make("macbook_air")]!;

    return Effect.all(
      ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"].map((name) =>
        expectReason(
          {
            ...settings,
            providerInstances: {
              ...settings.providerInstances,
              [ProviderInstanceId.make("macbook_air")]: {
                ...macbook,
                environment: [
                  {
                    name,
                    value: "must-never-enter-the-cocoa-gateway",
                    sensitive: true,
                  },
                ],
              },
            },
          },
          "provider-environment-forbidden",
        ),
      ),
      { discard: true },
    );
  });

  it.effect("allows a Cocoa host key on every endpoint", () => {
    const settings = validSettings();
    const macbook = settings.providerInstances[ProviderInstanceId.make("macbook_air")]!;
    const linux = settings.providerInstances[ProviderInstanceId.make("linux_dev_box")]!;
    const withHostKeys = {
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        [ProviderInstanceId.make("macbook_air")]: {
          ...macbook,
          config: {
            endpointTransport: {
              type: "cocoa-host" as const,
              url: "wss://codex.internal.example:4500",
              key: "test_host_key" as const,
            },
          },
        },
        [ProviderInstanceId.make("linux_dev_box")]: {
          ...linux,
          config: {
            endpointTransport: {
              type: "cocoa-host" as const,
              url: "wss://rigatoni-alfredo.test:4500",
              key: "test_host_key" as const,
            },
          },
        },
      },
    };

    return Effect.gen(function* () {
      const resolved = yield* resolveCocoaGatewayProviderInstanceConfigMap(withHostKeys);
      expect(resolved[ProviderInstanceId.make("macbook_air")]?.config).toMatchObject({
        endpointTransport: {
          type: "cocoa-host",
          key: "test_host_key",
        },
      });
      expect(resolved[ProviderInstanceId.make("linux_dev_box")]?.config).toMatchObject({
        endpointTransport: {
          type: "cocoa-host",
          key: "test_host_key",
        },
      });
    });
  });

  it.effect("rejects missing and malformed endpoint configuration", () => {
    const settings = validSettings();
    return Effect.all([
      expectReason(
        {
          ...settings,
          providerInstances: {
            [ProviderInstanceId.make("macbook_air")]: { driver: "codex" as never },
          },
        },
        "missing-provider-config",
      ),
      expectReason(
        {
          ...settings,
          providerInstances: {
            [ProviderInstanceId.make("macbook_air")]: { driver: "codex" as never, config: {} },
          },
        },
        "missing-endpoint-transport",
      ),
      expectReason(
        {
          ...settings,
          providerInstances: {
            [ProviderInstanceId.make("macbook_air")]: {
              driver: "codex" as never,
              config: { endpointTransport: { type: "ssh-proxy", host: "bad host" } },
            },
          },
        },
        "invalid-provider-config",
      ),
    ]).pipe(Effect.asVoid);
  });

  it.effect("rejects selections that do not target an enabled explicit instance", () => {
    const settings = validSettings();
    return expectReason(
      {
        ...settings,
        textGenerationModelSelection: {
          ...settings.textGenerationModelSelection,
          instanceId: ProviderInstanceId.make("missing"),
        },
      },
      "invalid-model-selection",
    );
  });

  it.effect("allows a checkpoint helper only with an explicit endpoint Git executable", () => {
    const settings = validSettings();
    const macbook = settings.providerInstances[ProviderInstanceId.make("macbook_air")]!;
    const checkpointHelper = {
      type: "cocoa-checkpoint-helper-v1" as const,
      executablePath: "/run/current-system/sw/bin/cocoa-checkpoint-helper",
      expectedProtocol: 1 as const,
    };
    const withCheckpointHelper = {
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        [ProviderInstanceId.make("macbook_air")]: {
          ...macbook,
          config: {
            ...(macbook.config as object),
            endpointGitExecutablePath: "/run/current-system/sw/bin/git",
            checkpointHelper,
          },
        },
      },
    };

    return Effect.gen(function* () {
      const resolved = yield* resolveCocoaGatewayProviderInstanceConfigMap(withCheckpointHelper);
      expect(resolved[ProviderInstanceId.make("macbook_air")]?.config).toMatchObject({
        endpointGitExecutablePath: "/run/current-system/sw/bin/git",
        checkpointHelper,
      });

      const withoutGit = {
        ...withCheckpointHelper,
        providerInstances: {
          ...withCheckpointHelper.providerInstances,
          [ProviderInstanceId.make("macbook_air")]: {
            ...macbook,
            config: {
              ...(macbook.config as object),
              checkpointHelper,
            },
          },
        },
      };
      yield* expectReason(withoutGit, "checkpoint-helper-requires-endpoint-git");
    });
  });
});
