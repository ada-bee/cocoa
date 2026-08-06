import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Minimal writer contract used by provider adapters without importing file-backed logging. */
export interface ProviderEventLogger {
  readonly filePath: string;
  readonly write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  {
    readonly native: ProviderEventLogger | undefined;
    readonly canonical: ProviderEventLogger | undefined;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/provider/Layers/ProviderEventLoggers",
) {}

export const NoOpProviderEventLoggers: ProviderEventLoggers["Service"] = {
  native: undefined,
  canonical: undefined,
};

export const layerDisabled = Layer.succeed(
  ProviderEventLoggers,
  ProviderEventLoggers.of(NoOpProviderEventLoggers),
);
