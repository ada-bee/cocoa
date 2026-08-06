import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "../config.ts";
import { authenticateRawRouteWithScope } from "../http.ts";
import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

/** Legacy browser telemetry proxy. Cocoa intentionally omits this route. */
export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  "/api/observability/v1/traces",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", { cause, bodyJson }),
      ),
    );

    if (otlpTracesUrl === undefined) return HttpServerResponse.empty({ status: 204 });

    return yield* httpClient.post(otlpTracesUrl, { body: HttpBody.jsonUnsafe(bodyJson) }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.as(HttpServerResponse.empty({ status: 204 })),
      Effect.tapError((cause) =>
        Effect.logWarning("Failed to export browser OTLP traces", { cause, otlpTracesUrl }),
      ),
      Effect.orElseSucceed(() => HttpServerResponse.text("Trace export failed.", { status: 502 })),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
