import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
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

interface CodexAppServerProtocolOptions {
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  /**
   * Enables live, non-replaying raw message streams. Messages are dropped for a slow observer once
   * its bounded buffer reaches this capacity. Typed handlers are not affected.
   */
  readonly rawObservation?: CodexAppServerRawObservationOptions;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
    const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
    const incomingNotifications = options.rawObservation
      ? yield* PubSub.dropping<CodexAppServerIncomingNotification>(options.rawObservation.capacity)
      : undefined;
    const incomingRequests = options.rawObservation
      ? yield* PubSub.dropping<CodexAppServerIncomingRequest>(options.rawObservation.capacity)
      : undefined;
    if (incomingNotifications && incomingRequests) {
      yield* Effect.addFinalizer(() =>
        PubSub.shutdown(incomingNotifications).pipe(
          Effect.andThen(PubSub.shutdown(incomingRequests)),
        ),
      );
    }
    const pending = yield* Ref.make(new Map<string, CodexAppServerPendingRequest>());
    const nextRequestId = yield* Ref.make(1);
    const terminationHandled = yield* Ref.make(false);
    const requestHandlerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(requestHandlerScope, Exit.void));

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

    const failAllPending = (error: CodexError.CodexAppServerError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((current) =>
          Effect.forEach([...current.values()], ({ deferred }) => Deferred.fail(deferred, error), {
            discard: true,
          }),
        ),
        Effect.andThen(Ref.set(pending, new Map())),
      );

    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Ref.modify(terminationHandled, (handled) => {
        if (handled) {
          return [Effect.void, true] as const;
        }
        return [
          Effect.gen(function* () {
            const error = yield* classify();
            yield* failAllPending(error);
            yield* Queue.end(outgoing);
            if (incomingNotifications && incomingRequests) {
              yield* PubSub.shutdown(incomingNotifications);
              yield* PubSub.shutdown(incomingRequests);
            }
            yield* Scope.close(requestHandlerScope, Exit.void);
            if (options.onTermination) {
              yield* options.onTermination(error);
            }
          }),
          true,
        ] as const;
      }).pipe(Effect.flatten);

    const offerOutgoing = (message: Record<string, unknown>) =>
      Effect.gen(function* () {
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
        yield* Queue.offer(outgoing, encoded).pipe(Effect.asVoid);
      });

    const removePending = (requestId: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(requestId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(requestId);
        return next;
      });

    const resolvePending = (
      requestId: string,
      handler: (pendingRequest: CodexAppServerPendingRequest) => Effect.Effect<void>,
    ) =>
      Ref.modify(pending, (current) => {
        const pendingRequest = current.get(requestId);
        if (!pendingRequest) {
          return [Effect.void, current] as const;
        }
        const next = new Map(current);
        next.delete(requestId);
        return [handler(pendingRequest), next] as const;
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

    const handleRequest = (request: CodexAppServerIncomingRequest) =>
      Effect.gen(function* () {
        if (incomingRequests) {
          yield* PubSub.publish(incomingRequests, request);
        }
        if (options.onRequest) {
          yield* options.onRequest(request).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                respondError(
                  request.id,
                  CodexError.CodexAppServerRequestError.fromAppServerError(error, request.method),
                ),
              onSuccess: (result) => respond(request.id, result),
            }),
            Effect.forkIn(requestHandlerScope),
          );
        }
      });

    const handleNotification = (notification: CodexAppServerIncomingNotification) =>
      Effect.gen(function* () {
        if (incomingNotifications) {
          yield* PubSub.publish(incomingNotifications, notification);
        }
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
        onSuccess: () => Effect.void,
      }),
      Effect.forkScoped,
    );

    const request = (method: string, payload?: unknown) =>
      Effect.gen(function* () {
        const requestId = yield* Ref.modify(
          nextRequestId,
          (current) => [current, current + 1] as const,
        );
        const deferred = yield* Deferred.make<unknown, CodexError.CodexAppServerError>();
        yield* Ref.update(pending, (current) =>
          new Map(current).set(String(requestId), { deferred, method }),
        );
        yield* offerOutgoing({
          id: requestId,
          method,
          ...(payload !== undefined ? { params: payload } : {}),
        }).pipe(Effect.tapError(() => removePending(String(requestId))));
        return yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() => removePending(String(requestId))),
        );
      });

    const notify = (method: string, payload?: unknown) =>
      offerOutgoing({
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      });

    return {
      incomingNotifications: incomingNotifications
        ? Stream.fromPubSub(incomingNotifications)
        : Stream.empty,
      incomingRequests: incomingRequests ? Stream.fromPubSub(incomingRequests) : Stream.empty,
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
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.onNotification ? { onNotification: options.onNotification } : {}),
      ...(options.onRequest ? { onRequest: options.onRequest } : {}),
      ...(options.onTermination ? { onTermination: options.onTermination } : {}),
    });
  },
);
