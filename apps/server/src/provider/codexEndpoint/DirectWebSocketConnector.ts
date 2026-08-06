// @effect-diagnostics nodeBuiltinImport:off
import type { CodexDirectWebSocketTransport } from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import type * as NodeHttp from "node:http";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";
import type { CodexAppServerFramedProtocolOptions } from "effect-codex-app-server/protocol";

import {
  CODEX_SIGNED_BEARER_MINIMUM_SECRET_BYTES,
  type CodexSignedBearerTokenInput,
  mintCodexSignedBearerToken,
} from "./SignedBearerToken.ts";

export const DEFAULT_INCOMING_FRAME_CAPACITY = 256;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export class CodexEndpointCredentialReadError extends Schema.TaggedErrorClass<CodexEndpointCredentialReadError>()(
  "CodexEndpointCredentialReadError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the Codex endpoint credential at '${this.path}'.`;
  }
}

export class CodexEndpointInvalidCredentialError extends Schema.TaggedErrorClass<CodexEndpointInvalidCredentialError>()(
  "CodexEndpointInvalidCredentialError",
  {
    path: Schema.String,
    reason: Schema.Literals(["empty", "contains-newline", "too-short"]),
  },
) {
  override get message(): string {
    return `The Codex endpoint credential at '${this.path}' is invalid (${this.reason}).`;
  }
}

export class CodexEndpointCredentialSigningError extends Schema.TaggedErrorClass<CodexEndpointCredentialSigningError>()(
  "CodexEndpointCredentialSigningError",
  {
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to sign a bearer token with the Codex endpoint credential at '${this.path}'.`;
  }
}

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

export type CodexDirectWebSocketConnectorError =
  | CodexEndpointCredentialReadError
  | CodexEndpointInvalidCredentialError
  | CodexEndpointCredentialSigningError
  | CodexEndpointWebSocketOpenError;

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

export interface DirectWebSocketConnectorOptions {
  readonly incomingFrameCapacity?: number;
  readonly handshakeTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly makeWebSocket?: CodexEndpointWebSocketFactory;
  readonly nowEpochSeconds?: () => number;
  readonly mintSignedBearerToken?: (input: CodexSignedBearerTokenInput) => string;
}

const defaultWebSocketFactory: CodexEndpointWebSocketFactory = (url, options) =>
  new NodeSocket.NodeWS.WebSocket(url, options) as CodexEndpointWebSocket;

const readAuthorizationHeader = Effect.fn("CodexEndpoint.readAuthorizationHeader")(function* (
  transport: CodexDirectWebSocketTransport,
  options: Pick<DirectWebSocketConnectorOptions, "nowEpochSeconds" | "mintSignedBearerToken">,
) {
  const authentication = transport.authentication;
  if (authentication.type === "none") return undefined;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = authentication.credential.path;
  const contents = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(
      (cause) =>
        new CodexEndpointCredentialReadError({
          path,
          cause,
        }),
    ),
  );
  const token = contents.trim();
  if (token.length === 0) {
    return yield* new CodexEndpointInvalidCredentialError({ path, reason: "empty" });
  }
  if (token.includes("\n") || token.includes("\r")) {
    return yield* new CodexEndpointInvalidCredentialError({
      path,
      reason: "contains-newline",
    });
  }
  if (
    authentication.type === "signed-bearer-token" &&
    new TextEncoder().encode(token).byteLength < CODEX_SIGNED_BEARER_MINIMUM_SECRET_BYTES
  ) {
    return yield* new CodexEndpointInvalidCredentialError({ path, reason: "too-short" });
  }
  if (authentication.type === "signed-bearer-token") {
    const nowEpochSeconds = yield* options.nowEpochSeconds === undefined
      ? Clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1_000)))
      : Effect.try({
          try: options.nowEpochSeconds,
          catch: () => new CodexEndpointCredentialSigningError({ path }),
        }).pipe(Effect.map(Math.floor));
    if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) {
      return yield* new CodexEndpointCredentialSigningError({
        path,
      });
    }
    return yield* Effect.try({
      try: () =>
        `Bearer ${(options.mintSignedBearerToken ?? mintCodexSignedBearerToken)({
          secret: token,
          issuer: authentication.issuer,
          audience: authentication.audience,
          nowEpochSeconds,
        })}`,
      catch: () => new CodexEndpointCredentialSigningError({ path }),
    });
  }
  return `Bearer ${token}`;
});

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
        const statusMatch = /^Unexpected server response: (401|403)(?:\D|$)/u.exec(cause.message);
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

export const makeDirectWebSocketConnector = Effect.fn("CodexEndpoint.makeDirectWebSocketConnector")(
  function* (
    transport: CodexDirectWebSocketTransport,
    options: DirectWebSocketConnectorOptions = {},
  ): Effect.fn.Return<
    CodexEndpointFramedTransport,
    CodexDirectWebSocketConnectorError,
    FileSystem.FileSystem | Scope.Scope
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
    if (!Number.isSafeInteger(maxPayload) || maxPayload <= 0) {
      return yield* Effect.die(new RangeError("maxPayloadBytes must be a positive integer"));
    }

    const authorization = yield* readAuthorizationHeader(transport, options);
    const headers = authorization === undefined ? {} : { Authorization: authorization };
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

    const incomingQueue = yield* Queue.bounded<
      string,
      CodexErrors.CodexAppServerError | Cause.Done
    >(capacity);
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
  },
);
