import type { ProviderHostConfig, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeHostEndpointCapabilities } from "./HostEndpointCapabilities.ts";
import { makeHostEndpointControlSupervisor } from "./HostEndpointControlSupervisor.ts";

export type ProviderHostCapabilities = Pick<
  ProviderInstance,
  "workspace" | "terminal" | "execution" | "vcs"
>;

/**
 * Connect a provider instance to the independently managed host execution
 * plane. The supervisor only replaces the client used for new top-level
 * operations; handles returned by an earlier operation remain pinned to their
 * original host generation and are never replayed after reconnect.
 */
export const makeProviderHostCapabilities = Effect.fn("makeProviderHostCapabilities")(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly host: ProviderHostConfig;
  }): Effect.fn.Return<ProviderHostCapabilities, never, Scope.Scope> {
    const supervisor = yield* makeHostEndpointControlSupervisor({
      transport: input.host.transport,
      clientInfo: { name: "cocoa_gateway", version: "0.0.32" },
    });
    yield* supervisor.start;
    return makeHostEndpointCapabilities({
      providerInstanceId: input.instanceId,
      borrowClient: supervisor.borrowClient,
    });
  },
);
