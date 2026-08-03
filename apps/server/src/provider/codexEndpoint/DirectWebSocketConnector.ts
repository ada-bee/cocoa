import type { CodexDirectWebSocketTransport } from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";
import type { CodexAppServerFramedProtocolOptions } from "effect-codex-app-server/protocol";

export const DEFAULT_INCOMING_FRAME_CAPACITY = 256;

export class CodexEndpointUnsupportedAuthenticationError extends Schema.TaggedErrorClass<CodexEndpointUnsupportedAuthenticationError>()(
  "CodexEndpointUnsupportedAuthenticationError",
  {
    authenticationType: Schema.Literal("signed-bearer-token"),
  },
) {
  override get message(): string {
    return `Codex endpoint authentication '${this.authenticationType}' is not supported yet.`;
  }
}

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
    reason: Schema.Literals(["empty", "contains-newline"]),
  },
) {
  override get message(): string {
    return `The Codex endpoint credential at '${this.path}' is invalid (${this.reason}).`;
  }
}

export class CodexEndpointWebSocketOpenError extends Schema.TaggedErrorClass<CodexEndpointWebSocketOpenError>()(
  "CodexEndpointWebSocketOpenError",
  {
    url: Schema.String,
    cause: Schema.Defect(),
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
  | CodexEndpointUnsupportedAuthenticationError
  | CodexEndpointCredentialReadError
  | CodexEndpointInvalidCredentialError
  | CodexEndpointWebSocketOpenError;

type MessageListener = (data: NodeSocket.NodeWS.RawData, isBinary: boolean) => void;
type ErrorListener = (error: Error) => void;
type CloseListener = (code: number, reason: Buffer) => void;

export interface CodexEndpointWebSocket {
  readonly readyState: number;
  on(event: "message", listener: MessageListener): this;
  on(event: "error", listener: ErrorListener): this;
  on(event: "close", listener: CloseListener): this;
  on(event: "open", listener: () => void): this;
  off(event: "message", listener: MessageListener): this;
  off(event: "error", listener: ErrorListener): this;
  off(event: "close", listener: CloseListener): this;
  off(event: "open", listener: () => void): this;
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
  readonly makeWebSocket?: CodexEndpointWebSocketFactory;
}

const defaultWebSocketFactory: CodexEndpointWebSocketFactory = (url, options) =>
  new NodeSocket.NodeWS.WebSocket(url, options) as CodexEndpointWebSocket;

const readAuthorizationHeader = Effect.fn("CodexEndpoint.readAuthorizationHeader")(function* (
  transport: CodexDirectWebSocketTransport,
) {
  const authentication = transport.authentication;
  if (authentication.type === "none") return undefined;
  if (authentication.type === "signed-bearer-token") {
    return yield* new CodexEndpointUnsupportedAuthenticationError({
      authenticationType: authentication.type,
    });
  }

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
        finish(Effect.fail(new CodexEndpointWebSocketOpenError({ url, cause })));
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

      socket.on("open", handleOpen);
      socket.on("error", handleError);
      socket.on("close", handleClose);
      return Effect.sync(() => {
        cleanup();
        if (!settled) socket.terminate();
      });
    },
  );
});

const closeWebSocket = (socket: CodexEndpointWebSocket) =>
  Effect.try(() => {
    if (socket.readyState === NodeSocket.NodeWS.WebSocket.CONNECTING) {
      socket.terminate();
    } else if (
      socket.readyState === NodeSocket.NodeWS.WebSocket.OPEN ||
      socket.readyState === NodeSocket.NodeWS.WebSocket.CLOSING
    ) {
      socket.close(1000, "Cocoa endpoint scope closed");
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

    const authorization = yield* readAuthorizationHeader(transport);
    const headers = authorization === undefined ? {} : { Authorization: authorization };
    const makeWebSocket = options.makeWebSocket ?? defaultWebSocketFactory;
    const socket = yield* Effect.acquireRelease(
      openWebSocket(transport.url, { headers }, makeWebSocket),
      closeWebSocket,
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
            if (socket.readyState !== NodeSocket.NodeWS.WebSocket.OPEN) {
              resume(
                Effect.fail(
                  transportError(
                    "write-output-stream",
                    new CodexEndpointWebSocketSendError({
                      cause: new Error("WebSocket is not open"),
                    }),
                  ),
                ),
              );
              return;
            }
            try {
              socket.send(frame, (cause) => {
                if (cause) {
                  resume(
                    Effect.fail(
                      transportError(
                        "write-output-stream",
                        new CodexEndpointWebSocketSendError({ cause }),
                      ),
                    ),
                  );
                } else {
                  resume(Effect.void);
                }
              });
            } catch (cause) {
              resume(
                Effect.fail(
                  transportError(
                    "write-output-stream",
                    new CodexEndpointWebSocketSendError({ cause }),
                  ),
                ),
              );
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
