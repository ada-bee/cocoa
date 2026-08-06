// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";
import { Receiver, Sender } from "ws-rfc6455";

import {
  CodexEndpointBinaryFrameError,
  type CodexEndpointFramedTransport,
  CodexEndpointIncomingFrameOverflowError,
  CodexEndpointWebSocketClosedError,
  CodexEndpointWebSocketError,
  CodexEndpointWebSocketSendError,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_INCOMING_FRAME_CAPACITY,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from "./DirectWebSocketConnector.ts";

export const SSH_PROXY_WEBSOCKET_HEADER_LIMIT = 16 * 1_024;

const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class CodexSshProxyWebSocketHandshakeFailure extends Schema.TaggedErrorClass<CodexSshProxyWebSocketHandshakeFailure>()(
  "CodexSshProxyWebSocketHandshakeFailure",
  {
    reason: Schema.String,
    httpStatus: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.httpStatus === undefined
      ? `The SSH proxy WebSocket upgrade failed: ${this.reason}.`
      : `The SSH proxy WebSocket upgrade failed with HTTP status ${this.httpStatus}.`;
  }
}

export class CodexSshProxyWebSocketProtocolError extends Schema.TaggedErrorClass<CodexSshProxyWebSocketProtocolError>()(
  "CodexSshProxyWebSocketProtocolError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The SSH proxy sent an invalid WebSocket frame.";
  }
}

const isHandshakeFailure = Schema.is(CodexSshProxyWebSocketHandshakeFailure);

export interface SshProxyWebSocketFramingOptions {
  readonly handshakeTimeoutMs?: number;
  readonly incomingFrameCapacity?: number;
  readonly maxPayloadBytes?: number;
}

interface HandshakeResult {
  readonly remainder: Buffer;
}

const handshakeFailure = (
  reason: string,
  fields: { readonly httpStatus?: number; readonly cause?: unknown } = {},
) =>
  new CodexSshProxyWebSocketHandshakeFailure({
    reason,
    ...(fields.httpStatus === undefined ? {} : { httpStatus: fields.httpStatus }),
    ...(fields.cause === undefined ? {} : { cause: fields.cause }),
  });

const parseHeaders = (headerBlock: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const headers = new Map<string, Array<string>>();
  const lines = headerBlock.split("\r\n");
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw handshakeFailure("malformed response header");
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name.length === 0) throw handshakeFailure("malformed response header");
    const values = headers.get(name) ?? [];
    values.push(line.slice(colon + 1).trim());
    headers.set(name, values);
  }
  return headers;
};

const hasHeaderToken = (
  headers: ReadonlyMap<string, ReadonlyArray<string>>,
  name: string,
  token: string,
): boolean =>
  (headers.get(name) ?? []).some((value) =>
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .includes(token),
  );

const performHandshake = (
  socket: NodeStream.Duplex,
  timeoutMs: number,
): Effect.Effect<HandshakeResult, CodexSshProxyWebSocketHandshakeFailure> => {
  const key = NodeCrypto.randomBytes(16).toString("base64");
  const expectedAccept = NodeCrypto.createHash("sha1")
    .update(`${key}${WEBSOCKET_ACCEPT_GUID}`)
    .digest("base64");
  const request =
    "GET / HTTP/1.1\r\n" +
    "Host: localhost\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Key: ${key}\r\n` +
    "Sec-WebSocket-Version: 13\r\n\r\n";

  const handshake = Effect.callback<HandshakeResult, CodexSshProxyWebSocketHandshakeFailure>(
    (resume) => {
      let settled = false;
      let buffered = Buffer.alloc(0);
      const cleanup = () => {
        socket.off("data", handleData);
        socket.off("error", handleError);
        socket.off("end", handleEnd);
        socket.off("close", handleClose);
      };
      const finish = (
        result: Effect.Effect<HandshakeResult, CodexSshProxyWebSocketHandshakeFailure>,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(result);
      };
      const handleError = (cause: Error) =>
        finish(Effect.fail(handshakeFailure("stream error", { cause })));
      const handleEnd = () => finish(Effect.fail(handshakeFailure("unexpected end of stream")));
      const handleClose = () => finish(Effect.fail(handshakeFailure("stream closed")));
      const handleData = (chunk: Buffer | Uint8Array) => {
        if (settled) return;
        buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
        const headerEnd = buffered.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          if (buffered.length > SSH_PROXY_WEBSOCKET_HEADER_LIMIT) {
            finish(Effect.fail(handshakeFailure("response headers exceeded the bounded limit")));
          }
          return;
        }
        if (headerEnd + 4 > SSH_PROXY_WEBSOCKET_HEADER_LIMIT) {
          finish(Effect.fail(handshakeFailure("response headers exceeded the bounded limit")));
          return;
        }

        try {
          const headerBlock = buffered.subarray(0, headerEnd + 4).toString("latin1");
          const statusLine = headerBlock.slice(0, headerBlock.indexOf("\r\n"));
          const statusMatch = /^HTTP\/1\.[01]\s+([0-9]{3})(?:\s|$)/u.exec(statusLine);
          if (!statusMatch) throw handshakeFailure("malformed HTTP status line");
          const httpStatus = Number(statusMatch[1]);
          if (httpStatus !== 101) {
            throw handshakeFailure("upgrade rejected", { httpStatus });
          }
          const headers = parseHeaders(headerBlock);
          if (!hasHeaderToken(headers, "upgrade", "websocket")) {
            throw handshakeFailure("missing or invalid Upgrade header");
          }
          if (!hasHeaderToken(headers, "connection", "upgrade")) {
            throw handshakeFailure("missing or invalid Connection header");
          }
          const accepts = headers.get("sec-websocket-accept") ?? [];
          if (accepts.length !== 1 || accepts[0] !== expectedAccept) {
            throw handshakeFailure("invalid Sec-WebSocket-Accept header");
          }
          socket.pause();
          finish(Effect.succeed({ remainder: buffered.subarray(headerEnd + 4) }));
        } catch (cause) {
          finish(
            Effect.fail(
              isHandshakeFailure(cause)
                ? cause
                : handshakeFailure("malformed upgrade response", { cause }),
            ),
          );
        }
      };

      socket.on("data", handleData);
      socket.on("error", handleError);
      socket.on("end", handleEnd);
      socket.on("close", handleClose);
      socket.write(request, (cause) => {
        if (cause) handleError(cause);
      });

      return Effect.sync(cleanup);
    },
  );

  return Effect.timeoutOrElse(handshake, {
    duration: `${timeoutMs} millis`,
    orElse: () => Effect.fail(handshakeFailure("timed out")),
  });
};

const transportError = (operation: "read-input-stream" | "write-output-stream", cause: unknown) =>
  new CodexErrors.CodexAppServerTransportError({ operation, cause });

export const makeSshProxyWebSocketFramedTransport = Effect.fn(
  "CodexEndpoint.makeSshProxyWebSocketFramedTransport",
)(function* (
  socket: NodeStream.Duplex,
  options: SshProxyWebSocketFramingOptions = {},
): Effect.fn.Return<
  CodexEndpointFramedTransport,
  CodexSshProxyWebSocketHandshakeFailure,
  Scope.Scope
> {
  const capacity = options.incomingFrameCapacity ?? DEFAULT_INCOMING_FRAME_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    return yield* Effect.die(new RangeError("incomingFrameCapacity must be a positive integer"));
  }
  const handshakeTimeout = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isSafeInteger(handshakeTimeout) || handshakeTimeout <= 0) {
    return yield* Effect.die(new RangeError("handshakeTimeoutMs must be a positive integer"));
  }
  const maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(maxPayload) || maxPayload <= 0 || maxPayload > 0x7fff_ffff) {
    return yield* Effect.die(new RangeError("maxPayloadBytes must be a positive 31-bit integer"));
  }

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      socket.destroy();
    }),
  );

  const { remainder } = yield* performHandshake(socket, handshakeTimeout);
  const receiver = new Receiver({
    allowSynchronousEvents: true,
    isServer: false,
    maxBufferedChunks: 64,
    maxFragments: 1_024,
    maxPayload,
    skipUTF8Validation: false,
  });
  const sender = new Sender(socket);
  const incomingQueue = yield* Queue.bounded<string, CodexErrors.CodexAppServerError | Cause.Done>(
    capacity,
  );
  const termination = yield* Deferred.make<CodexErrors.CodexAppServerError>();
  let finished = false;
  let closeSent = false;
  let queuePaused = false;
  let receiverPaused = false;

  const updatePause = (): void => {
    if (finished || queuePaused || receiverPaused) {
      socket.pause();
    } else {
      socket.resume();
    }
  };
  const complete = (error: CodexErrors.CodexAppServerError, endNormally = false): void => {
    if (finished) return;
    finished = true;
    Deferred.doneUnsafe(termination, Effect.succeed(error));
    if (endNormally) {
      Queue.endUnsafe(incomingQueue);
    } else {
      Queue.failCauseUnsafe(incomingQueue, Cause.fail(error));
    }
    updatePause();
  };
  const sendControl = (
    operation: "pong" | "close",
    invoke: (callback: (error?: Error) => void) => void,
  ): void => {
    try {
      invoke((cause) => {
        if (!cause) return;
        complete(
          transportError(
            "write-output-stream",
            new CodexEndpointWebSocketSendError({
              cause: new Error(`Failed to send WebSocket ${operation}`, { cause }),
            }),
          ),
        );
      });
    } catch (cause) {
      complete(
        transportError("write-output-stream", new CodexEndpointWebSocketSendError({ cause })),
      );
    }
  };

  const handleMessage = (data: Buffer, isBinary: boolean): void => {
    if (finished) return;
    if (isBinary) {
      complete(transportError("read-input-stream", new CodexEndpointBinaryFrameError({})));
      if (!closeSent) {
        closeSent = true;
        sendControl("close", (callback) =>
          sender.close(1003, "Binary frames unsupported", true, callback),
        );
      }
      return;
    }
    const accepted = Queue.offerUnsafe(incomingQueue, data.toString("utf8"));
    if (!accepted) {
      complete(
        transportError(
          "read-input-stream",
          new CodexEndpointIncomingFrameOverflowError({ capacity }),
        ),
      );
      if (!closeSent) {
        closeSent = true;
        sendControl("close", (callback) =>
          sender.close(1008, "Incoming frame capacity exceeded", true, callback),
        );
      }
      return;
    }
    if (Queue.isFullUnsafe(incomingQueue)) {
      queuePaused = true;
      updatePause();
    }
  };
  const handlePing = (data: Buffer): void => {
    if (finished) return;
    sendControl("pong", (callback) => sender.pong(data, true, callback));
  };
  const handleConclude = (code: number, reason: Buffer): void => {
    if (finished) return;
    if (!closeSent) {
      closeSent = true;
      sendControl("close", (callback) =>
        sender.close(code === 1005 ? undefined : code, reason, true, callback),
      );
    }
    const closeError = transportError(
      "read-input-stream",
      new CodexEndpointWebSocketClosedError({
        code,
        reason: reason.toString("utf8"),
        wasClean: code === 1000 || code === 1005,
      }),
    );
    complete(closeError, code === 1000 || code === 1005);
  };
  const handleReceiverError = (cause: Error): void => {
    complete(
      transportError("read-input-stream", new CodexSshProxyWebSocketProtocolError({ cause })),
    );
    if (!closeSent) {
      closeSent = true;
      sendControl("close", (callback) => sender.close(1002, undefined, true, callback));
    }
  };
  const handleSocketError = (cause: Error): void => {
    complete(transportError("read-input-stream", new CodexEndpointWebSocketError({ cause })));
  };
  const handleSocketEnd = (): void => {
    if (finished) return;
    complete(
      transportError(
        "read-input-stream",
        new CodexEndpointWebSocketClosedError({ code: 1006, reason: "", wasClean: false }),
      ),
    );
  };
  const handleData = (chunk: Buffer | Uint8Array): void => {
    if (finished) return;
    if (!receiver.write(Buffer.from(chunk))) {
      receiverPaused = true;
      updatePause();
    }
  };
  const handleDrain = (): void => {
    receiverPaused = false;
    updatePause();
  };

  receiver.on("message", handleMessage);
  receiver.on("ping", handlePing);
  receiver.on("conclude", handleConclude);
  receiver.on("error", handleReceiverError);
  receiver.on("drain", handleDrain);
  socket.on("data", handleData);
  socket.on("error", handleSocketError);
  socket.on("end", handleSocketEnd);
  socket.on("close", handleSocketEnd);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      socket.off("data", handleData);
      socket.off("error", handleSocketError);
      socket.off("end", handleSocketEnd);
      socket.off("close", handleSocketEnd);
      receiver.off("message", handleMessage);
      receiver.off("ping", handlePing);
      receiver.off("conclude", handleConclude);
      receiver.off("error", handleReceiverError);
      receiver.off("drain", handleDrain);
      receiver.destroy();
      Queue.endUnsafe(incomingQueue);
    }),
  );

  if (remainder.length > 0) handleData(remainder);
  updatePause();

  const incoming = Stream.fromQueue(incomingQueue).pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        if (queuePaused && !Queue.isFullUnsafe(incomingQueue)) {
          queuePaused = false;
          updatePause();
        }
      }),
    ),
  );
  const outgoing = (frames: Stream.Stream<string>) =>
    frames.pipe(
      Stream.runForEach((frame) =>
        Effect.callback<void, CodexErrors.CodexAppServerError>((resume) => {
          if (finished || socket.destroyed || !socket.writable) {
            const error = transportError(
              "write-output-stream",
              new CodexEndpointWebSocketSendError({ cause: new Error("WebSocket is not open") }),
            );
            complete(error);
            resume(Effect.fail(error));
            return;
          }
          try {
            sender.send(
              frame,
              { binary: false, compress: false, fin: true, mask: true },
              (cause) => {
                if (cause) {
                  const error = transportError(
                    "write-output-stream",
                    new CodexEndpointWebSocketSendError({ cause }),
                  );
                  complete(error);
                  resume(Effect.fail(error));
                } else {
                  resume(Effect.void);
                }
              },
            );
          } catch (cause) {
            const error = transportError(
              "write-output-stream",
              new CodexEndpointWebSocketSendError({ cause }),
            );
            complete(error);
            resume(Effect.fail(error));
          }
        }),
      ),
    );

  return { incoming, outgoing, terminationError: Deferred.await(termination) };
});
