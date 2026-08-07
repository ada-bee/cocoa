import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  deriveProviderInstanceConfigMap,
  resolveProviderInstanceConfigMap,
  resolveProviderRegistryConfig,
} from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const settings = decodeSettings({
  providerHosts: {
    macbook: {
      displayName: "MacBook Air",
      transport: {
        type: "cocoa-host",
        url: "wss://macaroni.test:4500",
        key: "test_host_key",
      },
    },
  },
  providerInstances: {
    macbook_air: {
      driver: "codex",
      hostId: "macbook",
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
  textGenerationModelSelection: { instanceId: "macbook_air", model: "gpt-5.4" },
});

describe("provider instance config resolution", () => {
  it("keeps legacy synthesized defaults isolated to the legacy profile", () => {
    const resolved = deriveProviderInstanceConfigMap(settings);
    expect(Object.keys(resolved)).toContain("macbook_air");
    expect(Object.keys(resolved)).toContain("linux_dev_box");
    expect(Object.keys(resolved)).toContain("codex");
    expect(Object.keys(resolved)).toContain("claudeAgent");
  });

  it.effect("uses the exact explicit map in the Cocoa gateway profile", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveProviderInstanceConfigMap(settings, "cocoa-gateway");
      expect(Object.keys(resolved)).toEqual(["macbook_air", "linux_dev_box"]);
      assert.strictEqual(resolved, settings.providerInstances);
    }),
  );

  it.effect("retains legacy resolution when the legacy profile is selected", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveProviderInstanceConfigMap(settings, "legacy");
      assert.deepEqual(resolved, deriveProviderInstanceConfigMap(settings));
    }),
  );

  it.effect("retains the authoritative host catalog alongside resolved instances", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveProviderRegistryConfig(settings, "cocoa-gateway");
      assert.strictEqual(resolved.providerInstances, settings.providerInstances);
      assert.strictEqual(resolved.providerHosts, settings.providerHosts);
    }),
  );

  it.effect("rejects invalid Cocoa settings instead of synthesizing a default", () =>
    Effect.gen(function* () {
      let constructionCount = 0;
      const invalid = {
        ...settings,
        textGenerationModelSelection: {
          ...settings.textGenerationModelSelection,
          instanceId: ProviderInstanceId.make("missing"),
        },
      };
      const error = yield* Effect.flip(
        resolveProviderInstanceConfigMap(invalid, "cocoa-gateway").pipe(
          Effect.tap(() => Effect.sync(() => constructionCount++)),
        ),
      );
      assert.strictEqual(error.reason, "invalid-model-selection");
      assert.strictEqual(constructionCount, 0);
    }),
  );
});
