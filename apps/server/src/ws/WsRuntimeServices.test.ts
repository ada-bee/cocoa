import { describe, expect, it } from "@effect/vitest";
import * as LegacyRelayClient from "@t3tools/shared/relayClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { RelayClient } from "./WsRuntimeServices.ts";

describe("WebSocket runtime service contracts", () => {
  it("resolves a legacy relay client through the clean compatibility tag", () => {
    const service = LegacyRelayClient.RelayClient.of({
      resolve: Effect.succeed({ status: "missing", version: "test" }),
      install: Effect.die("not used"),
      installWithProgress: () => Effect.die("not used"),
    });
    const context = Context.make(LegacyRelayClient.RelayClient, service);

    expect(Context.get(context as unknown as Context.Context<RelayClient>, RelayClient)).toBe(
      service,
    );
  });
});
