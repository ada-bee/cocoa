// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
/** Authenticated WebSocket connector for a paired cocoa-hostd endpoint. */
import type { CocoaHostTransport } from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import type * as NodeHttp from "node:http";
import * as NodeTimers from "node:timers";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";
import type { CodexAppServerFramedProtocolOptions } from "effect-codex-app-server/protocol";

export const DEFAULT_INCOMING_FRAME_CAPACITY = 256;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export class CodexEndpointWebSocketOpenError extends Schema.TaggedErrorClass<CodexEndpointWebSocketOpenError>()(
  "CodexEndpointWebSocketOpenError",
  {
    url: Schema.String,
    cause: Schema.Defect(),
    httpStatus: Schema.optionalKey(Schema.Int),
  },
) {
  override get message(): string {
    return `Failed to open the Codex endpoint WebSocket at '${this.url}'.`;
  }
}

export class CodexEndpointBinaryFrameError extends Schema.TaggedErrorClass<CodexEndpointBinaryFrameError>()(
  "CodexEndpointBinaryFrameError",
  {},
) {
  override get message(): string {
    return "The Codex endpoint sent a binary WebSocket frame; only text frames are supported.";
  }
}

export class CodexEndpointIncomingFrameOverflowError extends Schema.TaggedErrorClass<CodexEndpointIncomingFrameOverflowError>()(
  "CodexEndpointIncomingFrameOverflowError",
  {
    capacity: Schema.Int,
  },
) {
  override get message(): string {
    return `The Codex endpoint exceeded the bounded incoming frame capacity (${this.capacity}).`;
  }
}

export class CodexEndpointWebSocketClosedError extends Schema.TaggedErrorClass<CodexEndpointWebSocketClosedError>()(
  "CodexEndpointWebSocketClosedError",
  {
    code: Schema.Int,
    reason: Schema.String,
    wasClean: Schema.Boolean,
  },
) {
  override get message(): string {
    const reason = this.reason.length > 0 ? `: ${this.reason}` : "";
    return `The Codex endpoint WebSocket closed with code ${this.code}${reason}.`;
  }
}

export class CodexEndpointWebSocketError extends Schema.TaggedErrorClass<CodexEndpointWebSocketError>()(
  "CodexEndpointWebSocketError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The Codex endpoint WebSocket emitted an error.";
  }
}

export class CodexEndpointWebSocketSendError extends Schema.TaggedErrorClass<CodexEndpointWebSocketSendError>()(
  "CodexEndpointWebSocketSendError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to send a frame to the Codex endpoint WebSocket.";
  }
}

export type CocoaHostConnectorError = CodexEndpointWebSocketOpenError;

type MessageListener = (data: NodeSocket.NodeWS.RawData, isBinary: boolean) => void;
type ErrorListener = (error: Error) => void;
type CloseListener = (code: number, reason: Buffer) => void;
type UnexpectedResponseListener = (
  request: NodeHttp.ClientRequest,
  response: NodeHttp.IncomingMessage,
) => void;

export interface CodexEndpointWebSocket {
  readonly readyState: number;
  on(event: "message", listener: MessageListener): this;
  on(event: "error", listener: ErrorListener): this;
  on(event: "close", listener: CloseListener): this;
  on(event: "open", listener: () => void): this;
  on(event: "unexpected-response", listener: UnexpectedResponseListener): this;
  off(event: "message", listener: MessageListener): this;
  off(event: "error", listener: ErrorListener): this;
  off(event: "close", listener: CloseListener): this;
  off(event: "open", listener: () => void): this;
  off(event: "unexpected-response", listener: UnexpectedResponseListener): this;
  send(data: string, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  pause(): void;
  resume(): void;
}

export type CodexEndpointWebSocketFactory = (
  url: string,
  options: NodeSocket.NodeWS.ClientOptions,
) => CodexEndpointWebSocket;

export interface CodexEndpointFramedTransport extends Pick<
  CodexAppServerFramedProtocolOptions,
  "incoming" | "outgoing"
> {
  readonly terminationError: NonNullable<CodexAppServerFramedProtocolOptions["terminationError"]>;
}

export interface CocoaHostConnectorOptions {
  readonly incomingFrameCapacity?: number;
  readonly handshakeTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly makeWebSocket?: CodexEndpointWebSocketFactory;
}

type BunClientEventName = "open" | "message" | "error" | "close";
type BunClientEventListener = (event: unknown) => void;

export interface BunClientWebSocket {
  readonly readyState: number;
  binaryType: string;
  addEventListener(event: BunClientEventName, listener: BunClientEventListener): void;
  removeEventListener(event: BunClientEventName, listener: BunClientEventListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type BunClientWebSocketConstructor = new (
  url: string,
  options: {
    readonly headers?: NodeHttp.OutgoingHttpHeaders;
    readonly perMessageDeflate?: boolean;
  },
) => BunClientWebSocket;

type AnyListener =
  | MessageListener
  | ErrorListener
  | CloseListener
  | UnexpectedResponseListener
  | (() => void);

const eventProperty = (event: unknown, property: string): unknown =>
  typeof event === "object" && event !== null ? Reflect.get(event, property) : undefined;

const errorFromBunEvent = (event: unknown): Error => {
  const nested = eventProperty(event, "error");
  if (nested instanceof Error) return nested;
  if (event instanceof Error) return event;
  const message = eventProperty(event, "message");
  return new Error(typeof message === "string" ? message : "Bun WebSocket emitted an error");
};

const bunMessageData = (
  event: unknown,
): { readonly data: Buffer; readonly isBinary: boolean; readonly byteLength: number } | Error => {
  const data = eventProperty(event, "data");
  if (typeof data === "string") {
    const buffer = Buffer.from(data);
    return { data: buffer, isBinary: false, byteLength: buffer.byteLength };
  }
  if (Buffer.isBuffer(data)) {
    return { data, isBinary: true, byteLength: data.byteLength };
  }
  if (data instanceof ArrayBuffer) {
    const buffer = Buffer.from(data);
    return { data: buffer, isBinary: true, byteLength: buffer.byteLength };
  }
  if (ArrayBuffer.isView(data)) {
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return { data: buffer, isBinary: true, byteLength: buffer.byteLength };
  }
  return new Error("Bun WebSocket received an unsupported message payload");
};

/** Adapts Bun's EventTarget WebSocket client to the connector's `ws`-shaped seam. */
export class BunCodexEndpointWebSocket implements CodexEndpointWebSocket {
  private readonly openListeners = new Set<() => void>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly unexpectedResponseListeners = new Set<UnexpectedResponseListener>();
  private readonly handshakeTimer: ReturnType<typeof NodeTimers.setTimeout>;
  private readonly socket: BunClientWebSocket;
  private readonly maxPayloadBytes: number;

  private readonly handleOpenEvent = (): void => {
    NodeTimers.clearTimeout(this.handshakeTimer);
    for (const listener of this.openListeners) listener();
  };

  private readonly handleMessageEvent = (event: unknown): void => {
    const normalized = bunMessageData(event);
    if (normalized instanceof Error) {
      this.emitError(normalized);
      this.close(1003, "Unsupported WebSocket payload");
      return;
    }
    if (normalized.byteLength > this.maxPayloadBytes) {
      this.emitError(
        new Error(
          `Bun WebSocket payload exceeded the configured ${this.maxPayloadBytes} byte limit`,
        ),
      );
      this.close(1009, "WebSocket payload limit exceeded");
      return;
    }
    for (const listener of this.messageListeners) {
      listener(normalized.data, normalized.isBinary);
    }
  };

  private readonly handleErrorEvent = (event: unknown): void => {
    NodeTimers.clearTimeout(this.handshakeTimer);
    this.emitError(errorFromBunEvent(event));
  };

  private readonly handleCloseEvent = (event: unknown): void => {
    NodeTimers.clearTimeout(this.handshakeTimer);
    const rawCode = eventProperty(event, "code");
    const rawReason = eventProperty(event, "reason");
    const code = typeof rawCode === "number" ? rawCode : 1006;
    const reason = typeof rawReason === "string" ? rawReason : "";
    for (const listener of this.closeListeners) listener(code, Buffer.from(reason));
  };

  constructor(socket: BunClientWebSocket, handshakeTimeoutMs: number, maxPayloadBytes: number) {
    this.socket = socket;
    this.maxPayloadBytes = maxPayloadBytes;
    socket.binaryType = "nodebuffer";
    socket.addEventListener("open", this.handleOpenEvent);
    socket.addEventListener("message", this.handleMessageEvent);
    socket.addEventListener("error", this.handleErrorEvent);
    socket.addEventListener("close", this.handleCloseEvent);
    this.handshakeTimer = NodeTimers.setTimeout(() => {
      this.emitError(new Error(`Opening handshake timed out after ${handshakeTimeoutMs}ms`));
      this.terminate();
    }, handshakeTimeoutMs);
    this.handshakeTimer.unref();
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  on(event: "message", listener: MessageListener): this;
  on(event: "error", listener: ErrorListener): this;
  on(event: "close", listener: CloseListener): this;
  on(event: "open", listener: () => void): this;
  on(event: "unexpected-response", listener: UnexpectedResponseListener): this;
  on(
    event: "message" | "error" | "close" | "open" | "unexpected-response",
    listener: AnyListener,
  ): this {
    this.listeners(event).add(listener as never);
    return this;
  }

  off(event: "message", listener: MessageListener): this;
  off(event: "error", listener: ErrorListener): this;
  off(event: "close", listener: CloseListener): this;
  off(event: "open", listener: () => void): this;
  off(event: "unexpected-response", listener: UnexpectedResponseListener): this;
  off(
    event: "message" | "error" | "close" | "open" | "unexpected-response",
    listener: AnyListener,
  ): this {
    this.listeners(event).delete(listener as never);
    return this;
  }

  send(data: string, callback: (error?: Error) => void): void {
    try {
      this.socket.send(data);
      callback();
    } catch (cause) {
      callback(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  close(code?: number, reason?: string): void {
    NodeTimers.clearTimeout(this.handshakeTimer);
    this.socket.close(code, reason);
  }

  terminate(): void {
    NodeTimers.clearTimeout(this.handshakeTimer);
    this.socket.terminate();
  }

  pause(): void {
    // Bun does not expose read pausing. The connector's bounded queue closes
    // this socket on the first frame that cannot be offered while it is full.
  }

  resume(): void {
    // Paired no-op for `pause`; see the bounded overflow behavior above.
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  private listeners(
    event: "message" | "error" | "close" | "open" | "unexpected-response",
  ): Set<never> {
    switch (event) {
      case "message":
        return this.messageListeners as Set<never>;
      case "error":
        return this.errorListeners as Set<never>;
      case "close":
        return this.closeListeners as Set<never>;
      case "open":
        return this.openListeners as Set<never>;
      case "unexpected-response":
        // Bun reports rejected upgrades through its generic error event.
        return this.unexpectedResponseListeners as Set<never>;
    }
  }
}

export const makeBunWebSocketFactory =
  (WebSocketConstructor: BunClientWebSocketConstructor): CodexEndpointWebSocketFactory =>
  (url, options) =>
    new BunCodexEndpointWebSocket(
      new WebSocketConstructor(url, {
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(typeof options.perMessageDeflate === "boolean"
          ? { perMessageDeflate: options.perMessageDeflate }
          : {}),
      }),
      options.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      options.maxPayload ?? DEFAULT_MAX_PAYLOAD_BYTES,
    );

const defaultWebSocketFactory: CodexEndpointWebSocketFactory = (url, options) => {
  if (Reflect.has(globalThis, "Bun")) {
    const WebSocketConstructor = Reflect.get(globalThis, "WebSocket");
    if (typeof WebSocketConstructor !== "function") {
      throw new Error("Bun runtime does not provide a WebSocket client");
    }
    return makeBunWebSocketFactory(WebSocketConstructor as BunClientWebSocketConstructor)(
      url,
      options,
    );
  }
  return new NodeSocket.NodeWS.WebSocket(url, options) as CodexEndpointWebSocket;
};

const openWebSocket = Effect.fn("CodexEndpoint.openWebSocket")(function* (
  url: string,
  options: NodeSocket.NodeWS.ClientOptions,
  makeWebSocket: CodexEndpointWebSocketFactory,
) {
  const socket = yield* Effect.try({
    try: () => makeWebSocket(url, options),
    catch: (cause) => new CodexEndpointWebSocketOpenError({ url, cause }),
  });

  return yield* Effect.callback<CodexEndpointWebSocket, CodexEndpointWebSocketOpenError>(
    (resume) => {
      let settled = false;
      const cleanup = () => {
        socket.off("open", handleOpen);
        socket.off("error", handleError);
        socket.off("close", handleClose);
        socket.off("unexpected-response", handleUnexpectedResponse);
      };
      const finish = (
        result: Effect.Effect<CodexEndpointWebSocket, CodexEndpointWebSocketOpenError>,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(result);
      };
      const handleOpen = () => finish(Effect.succeed(socket));
      const handleError = (cause: Error) => {
        try {
          socket.terminate();
        } catch {
          // Preserve the original connection error.
        }
        const statusMatch = /\b(401|403)\b/u.exec(cause.message);
        finish(
          Effect.fail(
            new CodexEndpointWebSocketOpenError({
              url,
              cause,
              ...(statusMatch === null ? {} : { httpStatus: Number(statusMatch[1]) }),
            }),
          ),
        );
      };
      const handleClose = (code: number, reason: Buffer) =>
        finish(
          Effect.fail(
            new CodexEndpointWebSocketOpenError({
              url,
              cause: new CodexEndpointWebSocketClosedError({
                code,
                reason: reason.toString(),
                wasClean: code === 1000,
              }),
            }),
          ),
        );
      const handleUnexpectedResponse: UnexpectedResponseListener = (_request, response) => {
        const httpStatus = response.statusCode;
        response.resume();
        finish(
          Effect.fail(
            new CodexEndpointWebSocketOpenError({
              url,
              cause: new Error(
                httpStatus === undefined
                  ? "WebSocket upgrade rejected"
                  : `WebSocket upgrade rejected with HTTP status ${httpStatus}`,
              ),
              ...(httpStatus === undefined ? {} : { httpStatus }),
            }),
          ),
        );
      };

      socket.on("open", handleOpen);
      socket.on("error", handleError);
      socket.on("close", handleClose);
      socket.on("unexpected-response", handleUnexpectedResponse);
      return Effect.sync(() => {
        if (settled) {
          cleanup();
          return;
        }
        settled = true;
        cleanup();

        // `ws` emits an asynchronous error while aborting a CONNECTING socket.
        // Keep a sink installed until the paired close event so interruption
        // cannot turn that expected abort into an uncaught EventEmitter error.
        const handleAbortError = () => {};
        const cleanupAbort = () => {
          socket.off("error", handleAbortError);
          socket.off("close", cleanupAbort);
        };
        socket.on("error", handleAbortError);
        socket.on("close", cleanupAbort);
        try {
          socket.terminate();
        } catch {
          cleanupAbort();
        }
      });
    },
  );
});

const closeWebSocket = (socket: CodexEndpointWebSocket) =>
  Effect.try(() => {
    if (
      socket.readyState === NodeSocket.NodeWS.WebSocket.CONNECTING ||
      socket.readyState === NodeSocket.NodeWS.WebSocket.OPEN ||
      socket.readyState === NodeSocket.NodeWS.WebSocket.CLOSING
    ) {
      // Scope release must finish synchronously. `close()` can retain the TCP
      // socket and its close timer for 30 seconds, so use the hard close here.
      socket.terminate();
    }
  }).pipe(Effect.ignore);

const transportError = (operation: "read-input-stream" | "write-output-stream", cause: unknown) =>
  new CodexErrors.CodexAppServerTransportError({ operation, cause });

export const makeCocoaHostConnector = Effect.fn("CodexEndpoint.makeCocoaHostConnector")(function* (
  transport: CocoaHostTransport,
  options: CocoaHostConnectorOptions = {},
): Effect.fn.Return<CodexEndpointFramedTransport, CocoaHostConnectorError, Scope.Scope> {
  const capacity = options.incomingFrameCapacity ?? DEFAULT_INCOMING_FRAME_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    return yield* Effect.die(new RangeError("incomingFrameCapacity must be a positive integer"));
  }
  const handshakeTimeout = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isSafeInteger(handshakeTimeout) || handshakeTimeout <= 0) {
    return yield* Effect.die(new RangeError("handshakeTimeoutMs must be a positive integer"));
  }
  const maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(maxPayload) || maxPayload <= 0) {
    return yield* Effect.die(new RangeError("maxPayloadBytes must be a positive integer"));
  }

  const headers = { Authorization: `Bearer ${transport.key}` };
  const makeWebSocket = options.makeWebSocket ?? defaultWebSocketFactory;
  const socket = yield* Effect.acquireRelease(
    openWebSocket(
      transport.url,
      {
        headers,
        handshakeTimeout,
        maxPayload,
        perMessageDeflate: false,
      },
      makeWebSocket,
    ),
    closeWebSocket,
    { interruptible: true },
  );

  const incomingQueue = yield* Queue.bounded<string, CodexErrors.CodexAppServerError | Cause.Done>(
    capacity,
  );
  const termination = yield* Deferred.make<CodexErrors.CodexAppServerError>();
  let finished = false;
  let paused = false;

  const complete = (error: CodexErrors.CodexAppServerError, endNormally = false): void => {
    if (finished) return;
    finished = true;
    Deferred.doneUnsafe(termination, Effect.succeed(error));
    if (endNormally) {
      Queue.endUnsafe(incomingQueue);
    } else {
      Queue.failCauseUnsafe(incomingQueue, Cause.fail(error));
    }
  };

  const handleMessage: MessageListener = (data, isBinary) => {
    if (finished) return;
    if (isBinary) {
      complete(transportError("read-input-stream", new CodexEndpointBinaryFrameError({})));
      socket.close(1003, "Binary frames are not supported");
      return;
    }

    const accepted = Queue.offerUnsafe(incomingQueue, data.toString());
    if (!accepted) {
      complete(
        transportError(
          "read-input-stream",
          new CodexEndpointIncomingFrameOverflowError({ capacity }),
        ),
      );
      socket.close(1008, "Incoming frame capacity exceeded");
      return;
    }
    if (!paused && Queue.isFullUnsafe(incomingQueue)) {
      paused = true;
      socket.pause();
    }
  };
  const handleError: ErrorListener = (cause) => {
    complete(transportError("read-input-stream", new CodexEndpointWebSocketError({ cause })));
  };
  const handleClose: CloseListener = (code, reason) => {
    const closeError = transportError(
      "read-input-stream",
      new CodexEndpointWebSocketClosedError({
        code,
        reason: reason.toString(),
        wasClean: code === 1000,
      }),
    );
    complete(closeError, code === 1000);
  };

  socket.on("message", handleMessage);
  socket.on("error", handleError);
  socket.on("close", handleClose);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      socket.off("message", handleMessage);
      socket.off("error", handleError);
      socket.off("close", handleClose);
      if (paused) socket.resume();
      Queue.endUnsafe(incomingQueue);
    }),
  );

  const incoming = Stream.fromQueue(incomingQueue).pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        if (paused && !Queue.isFullUnsafe(incomingQueue)) {
          paused = false;
          socket.resume();
        }
      }),
    ),
  );

  const outgoing = (frames: Stream.Stream<string>) =>
    frames.pipe(
      Stream.runForEach((frame) =>
        Effect.callback<void, CodexErrors.CodexAppServerError>((resume) => {
          const failSend = (cause: unknown) => {
            const error = transportError(
              "write-output-stream",
              new CodexEndpointWebSocketSendError({ cause }),
            );
            complete(error);
            try {
              socket.terminate();
            } catch {
              // The typed transport error remains the observable failure.
            }
            resume(Effect.fail(error));
          };
          if (socket.readyState !== NodeSocket.NodeWS.WebSocket.OPEN) {
            failSend(new Error("WebSocket is not open"));
            return;
          }
          try {
            socket.send(frame, (cause) => {
              if (cause) {
                failSend(cause);
              } else {
                resume(Effect.void);
              }
            });
          } catch (cause) {
            failSend(cause);
          }
        }),
      ),
    );

  return {
    incoming,
    outgoing,
    terminationError: Deferred.await(termination),
  };
});
