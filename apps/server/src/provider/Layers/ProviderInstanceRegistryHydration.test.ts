import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  deriveProviderInstanceConfigMap,
  resolveProviderInstanceConfigMap,
} from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const settings = decodeSettings({
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
      config: { endpointTransport: { type: "ssh-proxy", host: "rigatoni-alfredo" } },
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
