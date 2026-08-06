import { describe, expect, it } from "@effect/vitest";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { withRequestTracing } from "./RequestTracing.ts";

function collectingTracer(spans: Array<string>): Tracer.Tracer {
  return Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        spans.push(span.name);
      };
      return span;
    },
  });
}

describe("request tracing", () => {
  it.effect("accepts the legacy product tracer without importing it at runtime", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const productSpans: Array<string> = [];

      yield* Effect.void.pipe(
        Effect.withSpan("environment.request"),
        withRequestTracing,
        Effect.provideService(RelayClientTracer, Option.some(collectingTracer(productSpans))),
        Effect.withTracer(collectingTracer(userSpans)),
      );

      expect(productSpans).toEqual(["environment.request"]);
      expect(userSpans).toEqual([]);
    }),
  );

  it.effect("preserves the active tracer when no override is configured", () =>
    Effect.gen(function* () {
      const spans: Array<string> = [];
      yield* Effect.void.pipe(
        Effect.withSpan("environment.request"),
        withRequestTracing,
        Effect.withTracer(collectingTracer(spans)),
      );
      expect(spans).toEqual(["environment.request"]);
    }),
  );
});
