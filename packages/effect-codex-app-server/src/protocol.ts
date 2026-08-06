import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as CodexError from "./errors.ts";
import { JsonRpcId, JsonRpcResponseEnvelope } from "./_internal/shared.ts";
const isJsonRpcId = Schema.is(JsonRpcId);
const isJsonRpcResponseEnvelope = Schema.is(JsonRpcResponseEnvelope);
const isCodexAppServerError = Schema.is(CodexError.CodexAppServerError);

export interface CodexAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface CodexAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerRawObservationOptions {
  /** Maximum number of pending messages retained for each active raw observer. */
  readonly capacity: number;
}

export interface CodexAppServerClientRequestLimits {
  /** Maximum number of requests awaiting a response on one protocol connection. */
  readonly maxInFlight?: number;
  /** Default response deadline. Individual requests may make an explicit narrow override. */
  readonly defaultTimeoutMs?: number;
}

export interface CodexAppServerInboundRequestLimits {
  /** Maximum number of server requests whose handlers may execute concurrently. */
  readonly maxConcurrent?: number;
  /** Maximum number of server requests waiting for an available handler. */
  readonly queueCapacity?: number;
}

export interface CodexAppServerRequestOptions {
  /**
   * Override the response deadline for this request. `null` is reserved for calls whose protocol
   * contract is intentionally long-lived, such as a streaming terminal `command/exec` request.
   */
  readonly timeoutMs?: number | null;
}

export const DEFAULT_CODEX_APP_SERVER_MAX_IN_FLIGHT_REQUESTS = 256;
export const DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 150_000;
export const DEFAULT_CODEX_APP_SERVER_MAX_CONCURRENT_INBOUND_REQUESTS = 32;
export const DEFAULT_CODEX_APP_SERVER_INBOUND_REQUEST_QUEUE_CAPACITY = 64;

const DEFAULT_RAW_OBSERVATION_CAPACITY = 256;
/** Maximum number of encoded frames retained while the transport writer is backpressured. */
const DEFAULT_OUTGOING_FRAME_CAPACITY = 256;

export interface CodexAppServerProtocolOptions {
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  /**
   * Overrides the capacity of the live, non-replaying raw message streams. Messages are dropped
   * for a slow observer once its bounded buffer reaches this capacity. Typed handlers are not
   * affected.
   */
  readonly rawObservation?: CodexAppServerRawObservationOptions;
  readonly clientRequests?: CodexAppServerClientRequestLimits;
  readonly inboundRequests?: CodexAppServerInboundRequestLimits;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: CodexAppServerIncomingNotification,
  ) => Effect.Effect<void, never>;
  readonly onRequest?: (
    request: CodexAppServerIncomingRequest,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly onTermination?: (error: CodexError.CodexAppServerError) => Effect.Effect<void, never>;
}

export interface CodexAppServerPatchedProtocolOptions extends CodexAppServerProtocolOptions {
  readonly stdio: Stdio.Stdio;
}

/**
 * A transport where every incoming and outgoing element is one complete JSON protocol message.
 * WebSocket adapters should use this boundary directly rather than adding JSONL delimiters.
 */
export interface CodexAppServerFramedProtocolOptions extends CodexAppServerProtocolOptions {
  readonly incoming: Stream.Stream<string, CodexError.CodexAppServerError>;
  readonly outgoing: (
    frames: Stream.Stream<string>,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

export interface CodexAppServerPatchedProtocol {
  readonly incomingNotifications: Stream.Stream<CodexAppServerIncomingNotification>;
  readonly incomingRequests: Stream.Stream<CodexAppServerIncomingRequest>;
  readonly request: (
    method: string,
    payload?: unknown,
    options?: CodexAppServerRequestOptions,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly notify: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respond: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respondError: (
    requestId: string | number,
    error: CodexError.CodexAppServerRequestError,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

interface CodexAppServerPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, CodexError.CodexAppServerError>;
  readonly method: string;
}

interface CodexAppServerProtocolState {
  readonly terminalError?: CodexError.CodexAppServerError;
  readonly pending: Map<string, CodexAppServerPendingRequest>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const finitePositiveIntegerOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;

function isIncomingRequest(value: unknown): value is CodexAppServerIncomingRequest {
  if (!isObject(value) || typeof value.method !== "string") {
    return false;
  }
  return isJsonRpcId(value.id);
}

function isIncomingNotification(value: unknown): value is CodexAppServerIncomingNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function isIncomingResponse(value: unknown): value is typeof JsonRpcResponseEnvelope.Type {
  return isJsonRpcResponseEnvelope(value);
}

const encodeJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const encodeWireMessage = (
  message: Record<string, unknown>,
): Effect.Effect<string, CodexError.CodexAppServerProtocolParseError> =>
  encodeJsonString(message).pipe(
    Effect.mapError((cause) => {
      const method = typeof message.method === "string" ? message.method : undefined;
      const requestId =
        typeof message.id === "string" || typeof message.id === "number"
          ? String(message.id)
          : undefined;
      return CodexError.CodexAppServerProtocolParseError.fromSchemaError(
        "encode-wire-message",
        cause,
        {
          ...(method === undefined ? {} : { method }),
          ...(requestId === undefined ? {} : { requestId }),
        },
      );
    }),
  );

const decodeWireMessage = (
  line: string,
): Effect.Effect<unknown, CodexError.CodexAppServerProtocolParseError> =>
  decodeJsonString(line).pipe(
    Effect.mapError((cause) =>
      CodexError.CodexAppServerProtocolParseError.fromSchemaError("decode-wire-message", cause),
    ),
  );

const normalizeTransportError = (
  error: unknown,
  operation: CodexError.CodexAppServerTransportOperation,
): CodexError.CodexAppServerError =>
  isCodexAppServerError(error)
    ? error
    : new CodexError.CodexAppServerTransportError({
        operation,
        cause: error,
      });

const toProtocolMessage = (
  requestId: string | number,
  fields: {
    readonly result?: unknown;
    readonly error?: CodexError.CodexAppServerProtocolErrorShape;
  },
): { readonly [key: string]: unknown } => ({
  id: requestId,
  ...(fields.result !== undefined ? { result: fields.result } : {}),
  ...(fields.error !== undefined ? { error: fields.error } : {}),
});

export const makeCodexAppServerFramedProtocol = Effect.fn("makeCodexAppServerFramedProtocol")(
  function* (
    options: CodexAppServerFramedProtocolOptions,
  ): Effect.fn.Return<CodexAppServerPatchedProtocol, never, Scope.Scope> {
    const outgoing = yield* Queue.bounded<string, Cause.Done<void>>(
      DEFAULT_OUTGOING_FRAME_CAPACITY,
    );
    const maxInFlightRequests = finitePositiveIntegerOr(
      options.clientRequests?.maxInFlight,
      DEFAULT_CODEX_APP_SERVER_MAX_IN_FLIGHT_REQUESTS,
    );
    const defaultRequestTimeoutMs = finitePositiveIntegerOr(
      options.clientRequests?.defaultTimeoutMs,
      DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
    );
    const maxConcurrentInboundRequests = finitePositiveIntegerOr(
      options.inboundRequests?.maxConcurrent,
      DEFAULT_CODEX_APP_SERVER_MAX_CONCURRENT_INBOUND_REQUESTS,
    );
    const inboundRequestQueueCapacity = finitePositiveIntegerOr(
      options.inboundRequests?.queueCapacity,
      DEFAULT_CODEX_APP_SERVER_INBOUND_REQUEST_QUEUE_CAPACITY,
    );
    const inboundRequestQueue = yield* Queue.dropping<CodexAppServerIncomingRequest>(
      inboundRequestQueueCapacity,
    );
    const rawObservationCapacity =
      options.rawObservation?.capacity ?? DEFAULT_RAW_OBSERVATION_CAPACITY;
    const incomingNotifications =
      yield* PubSub.dropping<CodexAppServerIncomingNotification>(rawObservationCapacity);
    const incomingRequests =
      yield* PubSub.dropping<CodexAppServerIncomingRequest>(rawObservationCapacity);
    yield* Effect.addFinalizer(() =>
      PubSub.shutdown(incomingNotifications).pipe(
        Effect.andThen(PubSub.shutdown(incomingRequests)),
      ),
    );
    const protocolState = yield* Ref.make<CodexAppServerProtocolState>({
      pending: new Map(),
    });
    const nextRequestId = yield* Ref.make(1);
    const requestHandlerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() =>
      Queue.shutdown(inboundRequestQueue).pipe(
        Effect.andThen(Scope.close(requestHandlerScope, Exit.void)),
      ),
    );

    const logProtocol = (event: CodexAppServerProtocolLogEvent) => {
      if (event.direction === "incoming" && !options.logIncoming) {
        return Effect.void;
      }
      if (event.direction === "outgoing" && !options.logOutgoing) {
        return Effect.void;
      }
      return (
        options.logger?.(event) ??
        Effect.logDebug("Codex App Server protocol event").pipe(Effect.annotateLogs({ event }))
      );
    };

    const terminateProtocol = (error: CodexError.CodexAppServerError) =>
      Ref.modify(protocolState, (current) => {
        if (current.terminalError) {
          return [undefined, current] as const;
        }
        return [
          [...current.pending.values()],
          { terminalError: error, pending: new Map() },
        ] as const;
      }).pipe(
        Effect.flatMap((pendingRequests) =>
          pendingRequests === undefined
            ? Effect.succeed(false)
            : Effect.forEach(pendingRequests, ({ deferred }) => Deferred.fail(deferred, error), {
                discard: true,
              }).pipe(Effect.as(true)),
        ),
        Effect.uninterruptible,
      );

    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Effect.gen(function* () {
        const error = yield* classify();
        const terminated = yield* terminateProtocol(error);
        if (terminated) {
          yield* Queue.shutdown(outgoing);
          yield* Queue.shutdown(inboundRequestQueue);
          yield* PubSub.shutdown(incomingNotifications);
          yield* PubSub.shutdown(incomingRequests);
          yield* Scope.close(requestHandlerScope, Exit.void);
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
        }
      });

    const ensureActive = Ref.get(protocolState).pipe(
      Effect.flatMap((state) =>
        state.terminalError ? Effect.fail(state.terminalError) : Effect.void,
      ),
    );

    const offerOutgoing = (message: Record<string, unknown>) =>
      Effect.gen(function* () {
        yield* ensureActive;
        yield* logProtocol({
          direction: "outgoing",
          stage: "decoded",
          payload: message,
        });
        const encoded = yield* encodeWireMessage(message);
        yield* logProtocol({
          direction: "outgoing",
          stage: "raw",
          payload: encoded,
        });
        const accepted = yield* Queue.offer(outgoing, encoded);
        if (!accepted) {
          const state = yield* Ref.get(protocolState);
          const error =
            state.terminalError ??
            new CodexError.CodexAppServerTransportError({
              operation: "write-output-stream",
              cause: new Error("Codex App Server output stream is unavailable."),
            });
          return yield* error;
        }
      });

    const registerPending = (
      requestId: string,
      pendingRequest: CodexAppServerPendingRequest,
    ): Effect.Effect<void, CodexError.CodexAppServerError> =>
      Ref.modify(protocolState, (current) => {
        if (current.terminalError) {
          return [current.terminalError, current] as const;
        }
        if (current.pending.size >= maxInFlightRequests) {
          return [
            new CodexError.CodexAppServerRequestCapacityError({
              method: pendingRequest.method,
              maxInFlight: maxInFlightRequests,
            }),
            current,
          ] as const;
        }
        const pending = new Map(current.pending);
        pending.set(requestId, pendingRequest);
        return [undefined, { ...current, pending }] as const;
      }).pipe(
        Effect.flatMap((registrationError) =>
          registrationError ? Effect.fail(registrationError) : Effect.void,
        ),
      );

    const removePending = (requestId: string) =>
      Ref.update(protocolState, (current) => {
        if (!current.pending.has(requestId)) {
          return current;
        }
        const pending = new Map(current.pending);
        pending.delete(requestId);
        return { ...current, pending };
      });

    const resolvePending = (
      requestId: string,
      handler: (pendingRequest: CodexAppServerPendingRequest) => Effect.Effect<void>,
    ) =>
      Ref.modify(protocolState, (current) => {
        const pendingRequest = current.pending.get(requestId);
        if (!pendingRequest) {
          return [Effect.void, current] as const;
        }
        const pending = new Map(current.pending);
        pending.delete(requestId);
        return [handler(pendingRequest), { ...current, pending }] as const;
      }).pipe(Effect.flatten);

    const respond = (requestId: string | number, result: unknown) =>
      offerOutgoing(toProtocolMessage(requestId, { result }));

    const respondError = (
      requestId: string | number,
      error: CodexError.CodexAppServerRequestError,
    ) => offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));

    const handleResponse = (response: typeof JsonRpcResponseEnvelope.Type) => {
      const requestId = String(response.id);
      const protocolError = response.error;
      if (protocolError !== undefined) {
        return resolvePending(requestId, ({ deferred, method }) =>
          Deferred.fail(
            deferred,
            CodexError.CodexAppServerRequestError.fromProtocolError(
              protocolError,
              method,
              requestId,
            ),
          ),
        );
      }
      return resolvePending(requestId, ({ deferred }) =>
        Deferred.succeed(deferred, response.result),
      );
    };

    const runRequestHandler = (request: CodexAppServerIncomingRequest) =>
      options.onRequest
        ? options.onRequest(request).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                respondError(
                  request.id,
                  CodexError.CodexAppServerRequestError.fromAppServerError(error, request.method),
                ),
              onSuccess: (result) => respond(request.id, result),
            }),
          )
        : Effect.void;

    const handleRequest = (request: CodexAppServerIncomingRequest) =>
      Effect.gen(function* () {
        yield* PubSub.publish(incomingRequests, request);
        if (options.onRequest) {
          const accepted = yield* Queue.offer(inboundRequestQueue, request);
          if (!accepted) {
            yield* respondError(
              request.id,
              CodexError.CodexAppServerRequestError.overloaded(
                "Codex App Server client is at its inbound request capacity.",
                {
                  maxConcurrent: maxConcurrentInboundRequests,
                  queueCapacity: inboundRequestQueueCapacity,
                },
              ),
            );
          }
        }
      });

    const handleNotification = (notification: CodexAppServerIncomingNotification) =>
      Effect.gen(function* () {
        yield* PubSub.publish(incomingNotifications, notification);
        if (options.onNotification) {
          yield* options.onNotification(notification);
        }
      });

    const routeMessage = (
      message: unknown,
    ): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (isIncomingRequest(message)) {
        return handleRequest(message);
      }
      if (isIncomingNotification(message)) {
        return handleNotification(message);
      }
      if (isIncomingResponse(message)) {
        return handleResponse(message);
      }
      return Effect.fail(
        CodexError.CodexAppServerProtocolParseError.fromUnroutableMessage(message),
      );
    };

    const handleFrame = (frame: string): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (frame.trim().length === 0) {
        return Effect.void;
      }
      return logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: frame,
      }).pipe(
        Effect.flatMap(() => decodeWireMessage(frame)),
        Effect.tap((decoded) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: decoded,
          }),
        ),
        Effect.tapErrorTag("CodexAppServerProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              operation: error.operation,
              ...(error.method === undefined ? {} : { method: error.method }),
              ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
              ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
              ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
              ...(error.maximumPathDepth === undefined
                ? {}
                : { maximumPathDepth: error.maximumPathDepth }),
            },
          }),
        ),
        Effect.flatMap(routeMessage),
      );
    };

    if (options.onRequest) {
      yield* Effect.forEach(
        Array.from({ length: maxConcurrentInboundRequests }),
        () =>
          Queue.take(inboundRequestQueue).pipe(
            Effect.flatMap(runRequestHandler),
            Effect.forever,
            Effect.forkIn(requestHandlerScope),
          ),
        { discard: true },
      );
    }

    yield* options.incoming.pipe(
      Stream.runForEach(handleFrame),
      Effect.matchEffect({
        onFailure: (error) => handleTermination(() => Effect.succeed(error)),
        onSuccess: () =>
          handleTermination(
            () =>
              options.terminationError ??
              Effect.succeed(new CodexError.CodexAppServerInputStreamEndedError({})),
          ),
      }),
      Effect.forkScoped,
    );

    yield* options.outgoing(Stream.fromQueue(outgoing)).pipe(
      Effect.matchEffect({
        onFailure: (error) => handleTermination(() => Effect.succeed(error)),
        onSuccess: () =>
          handleTermination(() =>
            Effect.succeed(
              new CodexError.CodexAppServerTransportError({
                operation: "write-output-stream",
                cause: new Error("Codex App Server output stream ended."),
              }),
            ),
          ),
      }),
      Effect.forkScoped,
    );

    const request = (
      method: string,
      payload?: unknown,
      requestOptions: CodexAppServerRequestOptions = {},
    ) =>
      Effect.gen(function* () {
        const requestId = yield* Ref.modify(
          nextRequestId,
          (current) => [current, current + 1] as const,
        );
        const deferred = yield* Deferred.make<unknown, CodexError.CodexAppServerError>();
        const correlationId = String(requestId);
        yield* registerPending(correlationId, { deferred, method });
        const timeoutMs =
          requestOptions.timeoutMs === null
            ? null
            : finitePositiveIntegerOr(requestOptions.timeoutMs, defaultRequestTimeoutMs);
        const sendAndAwait = offerOutgoing({
          id: requestId,
          method,
          ...(payload !== undefined ? { params: payload } : {}),
        }).pipe(Effect.andThen(Deferred.await(deferred)));
        return yield* (
          timeoutMs === null
            ? sendAndAwait
            : sendAndAwait.pipe(
                Effect.timeoutOrElse({
                  duration: Duration.millis(timeoutMs),
                  orElse: () =>
                    Effect.fail(
                      new CodexError.CodexAppServerRequestTimeoutError({
                        method,
                        requestId: correlationId,
                        timeoutMs,
                      }),
                    ),
                }),
              )
        ).pipe(Effect.ensuring(removePending(correlationId)));
      });

    const notify = (method: string, payload?: unknown) =>
      offerOutgoing({
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      });

    return {
      incomingNotifications: Stream.fromPubSub(incomingNotifications),
      incomingRequests: Stream.fromPubSub(incomingRequests),
      request,
      notify,
      respond,
      respondError,
    } satisfies CodexAppServerPatchedProtocol;
  },
);

export const makeCodexAppServerPatchedProtocol = Effect.fn("makeCodexAppServerPatchedProtocol")(
  function* (
    options: CodexAppServerPatchedProtocolOptions,
  ): Effect.fn.Return<CodexAppServerPatchedProtocol, never, Scope.Scope> {
    return yield* makeCodexAppServerFramedProtocol({
      incoming: options.stdio.stdin.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapError((error) => normalizeTransportError(error, "read-input-stream")),
      ),
      outgoing: (frames) =>
        frames.pipe(
          Stream.map((frame) => `${frame}\n`),
          Stream.run(options.stdio.stdout()),
          Effect.mapError((error) => normalizeTransportError(error, "write-output-stream")),
        ),
      ...(options.terminationError ? { terminationError: options.terminationError } : {}),
      ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
      ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
      ...(options.rawObservation ? { rawObservation: options.rawObservation } : {}),
      ...(options.clientRequests ? { clientRequests: options.clientRequests } : {}),
      ...(options.inboundRequests ? { inboundRequests: options.inboundRequests } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.onNotification ? { onNotification: options.onNotification } : {}),
      ...(options.onRequest ? { onRequest: options.onRequest } : {}),
      ...(options.onTermination ? { onTermination: options.onTermination } : {}),
    });
  },
);
