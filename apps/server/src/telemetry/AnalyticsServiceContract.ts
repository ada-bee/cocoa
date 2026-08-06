import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Product analytics boundary shared by legacy and Cocoa runtimes. */
export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/telemetry/AnalyticsService",
) {
  static readonly layerDisabled = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );

  static readonly layerTest = AnalyticsService.layerDisabled;
}

export const layerDisabled = AnalyticsService.layerDisabled;
export const layerTest = AnalyticsService.layerTest;
