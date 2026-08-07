import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { resolveCocoaPassword } from "./CocoaGatewayCliConfig.ts";

it.layer(NodeServices.layer)("resolveCocoaPassword", (it) => {
  it.effect("keeps an explicitly configured password redacted", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveCocoaPassword(Redacted.make("foobar123"));

      expect(resolved.generated).toBe(false);
      expect(Redacted.value(resolved.password)).toBe("foobar123");
    }),
  );

  it.effect("generates a high-entropy password when none is configured", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveCocoaPassword(undefined);

      expect(resolved.generated).toBe(true);
      expect(Redacted.value(resolved.password)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }),
  );
});
