import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { HttpServerRequest, HttpTraceContext } from "effect/unstable/http";

/**
 * Optional product tracing override. The identifier matches the legacy shared
 * tracer so existing legacy composition remains compatible without importing
 * relay implementation code into generic HTTP and authentication handlers.
 */
export class RequestTracerOverride extends Context.Reference(
  // Keep interoperability with the legacy shared tracing layer without importing it.
  "@t3tools/shared/relayTracing/RelayClientTracer",
  {
    defaultValue: () => Option.none<Tracer.Tracer>(),
  },
) {}

export const withRequestTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  RequestTracerOverride.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (tracer) => effect.pipe(Effect.provideService(Tracer.Tracer, tracer)),
      }),
    ),
  );

export const traceRequest = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(withRequestTracing);

export const traceAuthenticatedRequest = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest> =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap((request) =>
      Option.match(HttpTraceContext.fromHeaders(request.headers), {
        onNone: () => effect,
        onSome: (parent) => effect.pipe(Effect.withParentSpan(parent)),
      }),
    ),
    withRequestTracing,
  );
