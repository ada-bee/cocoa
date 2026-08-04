import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import raspberryPiSettings from "../../../../deploy/raspberry-pi/settings.example.json" with { type: "json" };

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
            type: "direct-websocket",
            url: "ws://192.168.20.99:4500",
            authentication: { type: "none" },
          },
        },
      },
      linux_dev_box: {
        driver: "codex",
        config: {
          endpointTransport: {
            type: "ssh-proxy",
            host: "rigatoni-alfredo",
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
  it.effect(
    "decodes the Pi deployment endpoints with administrator-installed checkpoint helpers",
    () =>
      Effect.gen(function* () {
        const settings = decodeSettings(raspberryPiSettings);
        const resolved = yield* resolveCocoaGatewayProviderInstanceConfigMap(settings);

        expect(resolved[ProviderInstanceId.make("codex_macbook_air")]?.config).toMatchObject({
          endpointGitExecutablePath: "/usr/bin/git",
          checkpointHelper: {
            type: "cocoa-checkpoint-helper-v1",
            executablePath: "/Users/ada-bee/.nix-profile/bin/cocoa-workspace-helper",
            expectedProtocol: 1,
          },
        });
        expect(
          resolved[ProviderInstanceId.make("codex_linux_rigatoni_alfredo")]?.config,
        ).toMatchObject({
          endpointGitExecutablePath: "/usr/bin/git",
          checkpointHelper: {
            type: "cocoa-checkpoint-helper-v1",
            executablePath: "/home/ada-bee/.nix-profile/bin/cocoa-workspace-helper",
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

  it.effect("rejects an empty explicit instance map", () =>
    expectReason(decodeSettings({}), "empty-provider-map"),
  );

  it.effect("rejects non-Codex drivers before registry construction", () => {
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
