import * as Deferred from "effect/Deferred";
import type * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  HOST_ENDPOINT_CONTROL_PROTOCOL,
  HOST_ENDPOINT_CONTROL_SUPPORTED_VERSIONS,
  decodeHostEndpointControlRequest,
  decodeHostEndpointCorrelatedFrame,
  decodeHostEndpointEventFrame,
  decodeHostEndpointHandshakeRequest,
  decodeHostEndpointHandshakeResponse,
  decodeHostEndpointJson,
  decodeHostEndpointRemoteErrorFrame,
  encodeHostEndpointJson,
  type HostEndpointHandshakeResponse,
} from "./HostEndpointRpcWire.ts";

export const HOST_ENDPOINT_DEFAULT_MAX_PENDING_REQUESTS = 256;
export const HOST_ENDPOINT_DEFAULT_EVENT_CAPACITY = 256;
export const HOST_ENDPOINT_DEFAULT_HANDSHAKE_TIMEOUT = "10 seconds" as const;
export const HOST_ENDPOINT_DEFAULT_REQUEST_TIMEOUT = "150 seconds" as const;

export interface HostEndpointRpcMethodSpec<Request = unknown, Response = unknown> {
  readonly request: Request;
  readonly response: Response;
}

export type HostEndpointRpcRequestOf<Spec> =
  Spec extends HostEndpointRpcMethodSpec<infer Request, unknown> ? Request : never;

export type HostEndpointRpcResponseOf<Spec> =
  Spec extends HostEndpointRpcMethodSpec<unknown, infer Response> ? Response : never;

export type HostEndpointRpcDecoder<Value> = (
  input: unknown,
) => Effect.Effect<Value, Schema.SchemaError>;

export class HostEndpointRpcTransportFailure extends Schema.TaggedErrorClass<HostEndpointRpcTransportFailure>()(
  "HostEndpointRpcTransportFailure",
  {
    operation: Schema.Literals(["open", "read", "send", "close"]),
    cause: Schema.Defect(),
  },
) {}

export interface HostEndpointRpcTransport {
  readonly incoming: Stream.Stream<string, HostEndpointRpcTransportFailure | Cause.Done<void>>;
  readonly send: (frame: string) => Effect.Effect<void, HostEndpointRpcTransportFailure>;
  readonly close: Effect.Effect<void, HostEndpointRpcTransportFailure>;
}

export interface HostEndpointRpcTransportOpenOptions {
  readonly url: string;
  readonly headers: Readonly<{ Authorization: string }>;
}

export type HostEndpointRpcTransportOpener = (
  options: HostEndpointRpcTransportOpenOptions,
) => Effect.Effect<HostEndpointRpcTransport, HostEndpointRpcTransportFailure, Scope.Scope>;

export interface HostEndpointRpcClientInfo {
  readonly name: string;
  readonly version: string;
}

export class HostEndpointRpcAuthenticationError extends Schema.TaggedErrorClass<HostEndpointRpcAuthenticationError>()(
  "HostEndpointRpcAuthenticationError",
  { reason: Schema.Literals(["empty", "invalid-characters"]) },
) {
  override get message(): string {
    return "The cocoa-hostd bearer credential is invalid.";
  }
}

export class HostEndpointRpcOpenError extends Schema.TaggedErrorClass<HostEndpointRpcOpenError>()(
  "HostEndpointRpcOpenError",
  { url: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to open cocoa-hostd control endpoint '${this.url}'.`;
  }
}

export class HostEndpointRpcCapacityError extends Schema.TaggedErrorClass<HostEndpointRpcCapacityError>()(
  "HostEndpointRpcCapacityError",
  {
    generationId: Schema.String,
    capacity: Schema.Int,
  },
) {
  override get message(): string {
    return `cocoa-hostd generation '${this.generationId}' reached its ${this.capacity}-request pending limit.`;
  }
}

export class HostEndpointRpcSerializationError extends Schema.TaggedErrorClass<HostEndpointRpcSerializationError>()(
  "HostEndpointRpcSerializationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not serialize cocoa-hostd operation '${this.operation}'.`;
  }
}

export class HostEndpointRpcInvalidPayloadError extends Schema.TaggedErrorClass<HostEndpointRpcInvalidPayloadError>()(
  "HostEndpointRpcInvalidPayloadError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid payload for cocoa-hostd operation '${this.operation}': ${this.reason}.`;
  }
}

export class HostEndpointRpcSendError extends Schema.TaggedErrorClass<HostEndpointRpcSendError>()(
  "HostEndpointRpcSendError",
  {
    generationId: Schema.optionalKey(Schema.String),
    requestId: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to send cocoa-hostd operation '${this.operation}' (${this.requestId}).`;
  }
}

export class HostEndpointRpcDisconnectedError extends Schema.TaggedErrorClass<HostEndpointRpcDisconnectedError>()(
  "HostEndpointRpcDisconnectedError",
  {
    generationId: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const generation = this.generationId === undefined ? "before handshake" : this.generationId;
    return `cocoa-hostd control connection disconnected (${generation}).`;
  }
}

export class HostEndpointRpcProtocolError extends Schema.TaggedErrorClass<HostEndpointRpcProtocolError>()(
  "HostEndpointRpcProtocolError",
  {
    generationId: Schema.optionalKey(Schema.String),
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `cocoa-hostd sent an invalid control frame: ${this.reason}.`;
  }
}

export class HostEndpointRpcRemoteError extends Schema.TaggedErrorClass<HostEndpointRpcRemoteError>()(
  "HostEndpointRpcRemoteError",
  {
    generationId: Schema.optionalKey(Schema.String),
    requestId: Schema.String,
    operation: Schema.String,
    code: Schema.String,
    remoteMessage: Schema.String,
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `cocoa-hostd rejected operation '${this.operation}' with '${this.code}': ${this.remoteMessage}`;
  }
}

export class HostEndpointRpcResponseDecodeError extends Schema.TaggedErrorClass<HostEndpointRpcResponseDecodeError>()(
  "HostEndpointRpcResponseDecodeError",
  {
    generationId: Schema.optionalKey(Schema.String),
    requestId: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not decode cocoa-hostd response for '${this.operation}' (${this.requestId}).`;
  }
}

export class HostEndpointRpcTimeoutError extends Schema.TaggedErrorClass<HostEndpointRpcTimeoutError>()(
  "HostEndpointRpcTimeoutError",
  {
    generationId: Schema.optionalKey(Schema.String),
    requestId: Schema.String,
    operation: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `cocoa-hostd operation '${this.operation}' timed out after ${this.timeoutMs}ms.`;
  }
}

export type HostEndpointRpcConnectionError =
  | HostEndpointRpcDisconnectedError
  | HostEndpointRpcProtocolError;

export type HostEndpointRpcRequestError =
  | HostEndpointRpcCapacityError
  | HostEndpointRpcSerializationError
  | HostEndpointRpcInvalidPayloadError
  | HostEndpointRpcSendError
  | HostEndpointRpcConnectionError
  | HostEndpointRpcRemoteError
  | HostEndpointRpcResponseDecodeError
  | HostEndpointRpcTimeoutError;

export interface HostEndpointRpcClient<Contract, Event = unknown> {
  readonly generationId: string;
  readonly handshake: HostEndpointHandshakeResponse;
  readonly request: <Method extends Extract<keyof Contract, string>>(
    operation: Method,
    payload: HostEndpointRpcRequestOf<Contract[Method]>,
    decodeResponse: HostEndpointRpcDecoder<HostEndpointRpcResponseOf<Contract[Method]>>,
  ) => Effect.Effect<HostEndpointRpcResponseOf<Contract[Method]>, HostEndpointRpcRequestError>;
  readonly subscribeEvents: Effect.Effect<PubSub.Subscription<Event>, never, Scope.Scope>;
  readonly awaitTermination: Effect.Effect<never, HostEndpointRpcConnectionError>;
  readonly close: Effect.Effect<void>;
}

export interface MakeHostEndpointRpcClientOptions<Event = unknown> {
  readonly url: string;
  readonly key: string;
  readonly client: HostEndpointRpcClientInfo;
  readonly openTransport: HostEndpointRpcTransportOpener;
  readonly decodeEvent?: HostEndpointRpcDecoder<Event>;
  readonly maxPendingRequests?: number;
  readonly eventCapacity?: number;
  readonly handshakeTimeout?: Duration.Input;
  readonly requestTimeout?: Duration.Input;
}

interface PendingRequest {
  readonly operation: string;
  readonly deferred: Deferred.Deferred<unknown, HostEndpointRpcRequestError>;
  readonly decodeResponse: HostEndpointRpcDecoder<unknown>;
}

interface ConnectionState {
  readonly generationId: string | undefined;
  readonly closed: HostEndpointRpcConnectionError | undefined;
  readonly pending: ReadonlyMap<string, PendingRequest>;
}

const validPositiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
};

const bearerAuthorization = (
  key: string,
): Effect.Effect<string, HostEndpointRpcAuthenticationError> => {
  if (key.length === 0) {
    return Effect.fail(new HostEndpointRpcAuthenticationError({ reason: "empty" }));
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
    return Effect.fail(new HostEndpointRpcAuthenticationError({ reason: "invalid-characters" }));
  }
  return Effect.succeed(`Bearer ${key}`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const makeOperationFrame = (
  operation: string,
  requestId: string,
  payload: unknown,
  protocolVersion: (typeof HOST_ENDPOINT_CONTROL_SUPPORTED_VERSIONS)[number],
): Effect.Effect<Readonly<Record<string, unknown>>, HostEndpointRpcInvalidPayloadError> => {
  if (!isRecord(payload)) {
    return Effect.fail(
      new HostEndpointRpcInvalidPayloadError({ operation, reason: "payload must be an object" }),
    );
  }
  const reserved = ["protocolVersion", "requestId", "operation"].find((field) => field in payload);
  if (reserved !== undefined) {
    return Effect.fail(
      new HostEndpointRpcInvalidPayloadError({
        operation,
        reason: `payload must not contain reserved field '${reserved}'`,
      }),
    );
  }
  return Effect.succeed({
    protocolVersion,
    requestId,
    operation,
    ...payload,
  });
};

export const makeHostEndpointRpcClient = <Contract, Event = unknown>(
  options: MakeHostEndpointRpcClientOptions<Event>,
): Effect.Effect<
  HostEndpointRpcClient<Contract, Event>,
  HostEndpointRpcAuthenticationError | HostEndpointRpcOpenError | HostEndpointRpcRequestError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const maxPending = options.maxPendingRequests ?? HOST_ENDPOINT_DEFAULT_MAX_PENDING_REQUESTS;
    const eventCapacity = options.eventCapacity ?? HOST_ENDPOINT_DEFAULT_EVENT_CAPACITY;
    validPositiveInteger(maxPending, "maxPendingRequests");
    validPositiveInteger(eventCapacity, "eventCapacity");

    const authorization = yield* bearerAuthorization(options.key);
    const transport = yield* options
      .openTransport({
        url: options.url,
        headers: { Authorization: authorization },
      })
      .pipe(Effect.mapError((cause) => new HostEndpointRpcOpenError({ url: options.url, cause })));

    const state = yield* Ref.make<ConnectionState>({
      generationId: undefined,
      closed: undefined,
      pending: new Map(),
    });
    const termination = yield* Deferred.make<HostEndpointRpcConnectionError>();
    const events = yield* PubSub.bounded<Event>(eventCapacity);
    const transportClosed = yield* Ref.make(false);
    let requestSequence = 0;

    const closeTransport = Ref.getAndSet(transportClosed, true).pipe(
      Effect.flatMap((alreadyClosed) =>
        alreadyClosed ? Effect.void : transport.close.pipe(Effect.ignore),
      ),
    );

    const terminate = Effect.fn("HostEndpointRpcClient.terminate")(function* (
      error: HostEndpointRpcConnectionError,
      closeUnderlyingTransport: boolean,
    ) {
      const pending = yield* Ref.modify(state, (current) => {
        if (current.closed !== undefined) return [undefined, current] as const;
        return [
          current.pending,
          { ...current, closed: error, pending: new Map<string, PendingRequest>() },
        ] as const;
      });
      if (pending === undefined) {
        if (closeUnderlyingTransport) yield* closeTransport;
        return;
      }
      yield* Effect.forEach(pending.values(), (request) => Deferred.fail(request.deferred, error), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Deferred.succeed(termination, error);
      yield* PubSub.shutdown(events);
      if (closeUnderlyingTransport) yield* closeTransport;
    });

    const removePending = (
      requestId: string,
      deferred: Deferred.Deferred<unknown, HostEndpointRpcRequestError>,
    ) =>
      Ref.update(state, (current) => {
        if (current.pending.get(requestId)?.deferred !== deferred) return current;
        const pending = new Map(current.pending);
        pending.delete(requestId);
        return { ...current, pending };
      });

    const handleIncoming = Effect.fn("HostEndpointRpcClient.handleIncoming")(function* (
      text: string,
    ) {
      const decodedJson = yield* decodeHostEndpointJson(text).pipe(Effect.result);
      if (decodedJson._tag === "Failure") {
        const current = yield* Ref.get(state);
        yield* terminate(
          new HostEndpointRpcProtocolError({
            ...(current.generationId === undefined ? {} : { generationId: current.generationId }),
            reason: "frame was not valid JSON",
            cause: decodedJson.failure,
          }),
          true,
        );
        return;
      }

      const value = decodedJson.success;
      const correlated = yield* decodeHostEndpointCorrelatedFrame(value).pipe(Effect.option);
      if (Option.isNone(correlated)) {
        const eventFrame = yield* decodeHostEndpointEventFrame(value).pipe(Effect.result);
        if (eventFrame._tag === "Failure") {
          const current = yield* Ref.get(state);
          yield* terminate(
            new HostEndpointRpcProtocolError({
              ...(current.generationId === undefined ? {} : { generationId: current.generationId }),
              reason: "frame was neither a correlated response nor an event",
              cause: eventFrame.failure,
            }),
            true,
          );
          return;
        }
        const event =
          options.decodeEvent === undefined
            ? (value as Event)
            : yield* options.decodeEvent(value).pipe(
                Effect.mapError(
                  (cause) =>
                    new HostEndpointRpcProtocolError({
                      reason: "event failed schema validation",
                      cause,
                    }),
                ),
                Effect.catch((error) => terminate(error, true).pipe(Effect.as(undefined))),
              );
        if (event !== undefined) yield* PubSub.publish(events, event);
        return;
      }

      const requestId = correlated.value.requestId;
      const pending = yield* Ref.modify(state, (current) => {
        const request = current.pending.get(requestId);
        if (request === undefined) return [undefined, current] as const;
        const next = new Map(current.pending);
        next.delete(requestId);
        return [request, { ...current, pending: next }] as const;
      });
      // A cancelled/timed-out request or an older generation can answer late.
      // Unknown IDs are intentionally ignored and never rebound to new work.
      if (pending === undefined) return;

      const remoteError = yield* decodeHostEndpointRemoteErrorFrame(value).pipe(Effect.option);
      const current = yield* Ref.get(state);
      const generationFields =
        current.generationId === undefined ? {} : { generationId: current.generationId };
      if (Option.isSome(remoteError)) {
        yield* Deferred.fail(
          pending.deferred,
          new HostEndpointRpcRemoteError({
            ...generationFields,
            requestId,
            operation: pending.operation,
            code: remoteError.value.error.code,
            remoteMessage: remoteError.value.error.message,
            retryable: remoteError.value.error.retryable,
          }),
        );
        return;
      }

      const response = yield* pending.decodeResponse(value).pipe(Effect.result);
      if (response._tag === "Failure") {
        yield* Deferred.fail(
          pending.deferred,
          new HostEndpointRpcResponseDecodeError({
            ...generationFields,
            requestId,
            operation: pending.operation,
            cause: response.failure,
          }),
        );
        return;
      }
      yield* Deferred.succeed(pending.deferred, response.success);
    });

    const incoming = transport.incoming.pipe(
      Stream.runForEach(handleIncoming),
      Effect.matchEffect({
        onFailure: (cause) =>
          Ref.get(state).pipe(
            Effect.flatMap((current) =>
              terminate(
                new HostEndpointRpcDisconnectedError({
                  ...(current.generationId === undefined
                    ? {}
                    : { generationId: current.generationId }),
                  cause,
                }),
                false,
              ),
            ),
          ),
        onSuccess: () =>
          Ref.get(state).pipe(
            Effect.flatMap((current) =>
              terminate(
                new HostEndpointRpcDisconnectedError(
                  current.generationId === undefined ? {} : { generationId: current.generationId },
                ),
                false,
              ),
            ),
          ),
      }),
    );
    yield* incoming.pipe(Effect.forkScoped);

    const requestFrame = Effect.fn("HostEndpointRpcClient.requestFrame")(function* <Response>(
      operation: string,
      frame: Readonly<Record<string, unknown>>,
      decodeResponse: HostEndpointRpcDecoder<Response>,
      timeout: Duration.Input,
    ): Effect.fn.Return<Response, HostEndpointRpcRequestError> {
      const requestId = String(frame.requestId);
      const encoded = yield* encodeHostEndpointJson(frame).pipe(
        Effect.mapError((cause) => new HostEndpointRpcSerializationError({ operation, cause })),
      );
      const deferred = yield* Deferred.make<unknown, HostEndpointRpcRequestError>();
      const registration = yield* Ref.modify(
        state,
        (current): readonly [HostEndpointRpcRequestError | undefined, ConnectionState] => {
          if (current.closed !== undefined) return [current.closed, current] as const;
          if (current.pending.size >= maxPending) {
            return [
              new HostEndpointRpcCapacityError({
                generationId: current.generationId ?? "handshake",
                capacity: maxPending,
              }),
              current,
            ] as const;
          }
          const pending = new Map(current.pending);
          pending.set(requestId, {
            operation,
            deferred,
            decodeResponse: (input) => decodeResponse(input),
          });
          return [undefined, { ...current, pending }] as const;
        },
      );
      if (registration !== undefined) return yield* registration;

      const sendExit = yield* transport.send(encoded).pipe(Effect.result);
      if (sendExit._tag === "Failure") {
        const current = yield* Ref.get(state);
        const sendError = new HostEndpointRpcSendError({
          ...(current.generationId === undefined ? {} : { generationId: current.generationId }),
          requestId,
          operation,
          cause: sendExit.failure,
        });
        yield* Deferred.fail(deferred, sendError);
        yield* terminate(
          new HostEndpointRpcDisconnectedError({
            ...(current.generationId === undefined ? {} : { generationId: current.generationId }),
            cause: sendError,
          }),
          true,
        );
      }

      const requestGeneration = (yield* Ref.get(state)).generationId;
      const result = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new HostEndpointRpcTimeoutError({
                  ...(requestGeneration === undefined ? {} : { generationId: requestGeneration }),
                  requestId,
                  operation,
                  timeoutMs: Duration.toMillis(Duration.fromInputUnsafe(timeout)),
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.ensuring(removePending(requestId, deferred)),
      );
      return result as Response;
    });

    const parentScope = yield* Effect.scope;
    yield* Scope.addFinalizer(
      parentScope,
      Ref.get(state).pipe(
        Effect.flatMap((current) =>
          terminate(
            new HostEndpointRpcDisconnectedError(
              current.generationId === undefined ? {} : { generationId: current.generationId },
            ),
            true,
          ),
        ),
      ),
    );

    requestSequence += 1;
    const handshakeRequestId = `gateway:${requestSequence}`;
    const handshakeRequest = yield* decodeHostEndpointHandshakeRequest({
      protocol: HOST_ENDPOINT_CONTROL_PROTOCOL,
      requestId: handshakeRequestId,
      supportedVersions: [...HOST_ENDPOINT_CONTROL_SUPPORTED_VERSIONS],
      client: options.client,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new HostEndpointRpcInvalidPayloadError({
            operation: "handshake",
            reason: "client handshake failed cocoa-host-control schema validation",
            cause,
          }),
      ),
    );
    const handshake = yield* requestFrame(
      "handshake",
      handshakeRequest,
      decodeHostEndpointHandshakeResponse,
      options.handshakeTimeout ?? HOST_ENDPOINT_DEFAULT_HANDSHAKE_TIMEOUT,
    );
    yield* Ref.update(state, (current) => ({
      ...current,
      generationId: handshake.host.generationId,
    }));

    const request: HostEndpointRpcClient<Contract, Event>["request"] = (
      operation,
      payload,
      decodeResponse,
    ) =>
      Effect.gen(function* () {
        requestSequence += 1;
        const requestId = `gateway:${requestSequence}`;
        const frame = yield* makeOperationFrame(
          operation,
          requestId,
          payload,
          handshake.selectedVersion,
        );
        const validatedFrame = yield* decodeHostEndpointControlRequest(frame).pipe(
          Effect.mapError(
            (cause) =>
              new HostEndpointRpcInvalidPayloadError({
                operation,
                reason: "payload failed cocoa-host-control schema validation",
                cause,
              }),
          ),
        );
        return yield* requestFrame(
          operation,
          validatedFrame,
          decodeResponse,
          options.requestTimeout ?? HOST_ENDPOINT_DEFAULT_REQUEST_TIMEOUT,
        );
      });

    return {
      generationId: handshake.host.generationId,
      handshake,
      request,
      subscribeEvents: PubSub.subscribe(events),
      awaitTermination: Deferred.await(termination).pipe(Effect.flatMap(Effect.fail)),
      close: Ref.get(state).pipe(
        Effect.flatMap((current) =>
          terminate(
            new HostEndpointRpcDisconnectedError(
              current.generationId === undefined ? {} : { generationId: current.generationId },
            ),
            true,
          ),
        ),
      ),
    } satisfies HostEndpointRpcClient<Contract, Event>;
  });
