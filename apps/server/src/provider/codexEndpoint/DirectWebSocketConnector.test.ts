// @effect-diagnostics nodeBuiltinImport:off
import type { CodexDirectWebSocketTransport } from "@t3tools/contracts";
import type * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import type * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  type CodexEndpointWebSocket,
  type CodexEndpointWebSocketFactory,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  makeDirectWebSocketConnector,
} from "./DirectWebSocketConnector.ts";

type MessageListener = (data: NodeSocket.NodeWS.RawData, isBinary: boolean) => void;
type ErrorListener = (error: Error) => void;
type CloseListener = (code: number, reason: Buffer) => void;
type UnexpectedResponseListener = (
  request: NodeHttp.ClientRequest,
  response: NodeHttp.IncomingMessage,
) => void;

class FakeWebSocket implements CodexEndpointWebSocket {
  public readyState = 0;
  public readonly sent: string[] = [];
  public pauseCount = 0;
  public resumeCount = 0;
  public closeCount = 0;
  public terminateCount = 0;
  public sendError: Error | undefined;

  private readonly openListeners = new Set<() => void>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly unexpectedResponseListeners = new Set<UnexpectedResponseListener>();

  on(event: "open", listener: () => void): this;
  on(event: "message", listener: MessageListener): this;
  on(event: "error", listener: ErrorListener): this;
  on(event: "close", listener: CloseListener): this;
  on(event: "unexpected-response", listener: UnexpectedResponseListener): this;
  on(
    event: "open" | "message" | "error" | "close" | "unexpected-response",
    listener:
      | (() => void)
      | MessageListener
      | ErrorListener
      | CloseListener
      | UnexpectedResponseListener,
  ): this {
    this.listeners(event).add(listener as never);
    return this;
  }

  off(event: "open", listener: () => void): this;
  off(event: "message", listener: MessageListener): this;
  off(event: "error", listener: ErrorListener): this;
  off(event: "close", listener: CloseListener): this;
  off(event: "unexpected-response", listener: UnexpectedResponseListener): this;
  off(
    event: "open" | "message" | "error" | "close" | "unexpected-response",
    listener:
      | (() => void)
      | MessageListener
      | ErrorListener
      | CloseListener
      | UnexpectedResponseListener,
  ): this {
    this.listeners(event).delete(listener as never);
    return this;
  }

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    callback(this.sendError);
  }

  close(code = 1000, reason = ""): void {
    this.closeCount += 1;
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.closeListeners) listener(code, Buffer.from(reason));
  }

  terminate(): void {
    this.terminateCount += 1;
    this.readyState = 3;
  }

  pause(): void {
    this.pauseCount += 1;
  }

  resume(): void {
    this.resumeCount += 1;
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.openListeners) listener();
  }

  message(data: string | Buffer, isBinary = false): void {
    const rawData = typeof data === "string" ? Buffer.from(data) : data;
    for (const listener of this.messageListeners) listener(rawData, isBinary);
  }

  error(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  unexpectedResponse(statusCode: number): void {
    const request = { destroy: () => {} } as NodeHttp.ClientRequest;
    const response = { statusCode, resume: () => response } as NodeHttp.IncomingMessage;
    for (const listener of this.unexpectedResponseListeners) listener(request, response);
  }

  disconnect(code: number, reason: string): void {
    this.readyState = 3;
    for (const listener of this.closeListeners) listener(code, Buffer.from(reason));
  }

  private listeners(
    event: "open" | "message" | "error" | "close" | "unexpected-response",
  ): Set<never> {
    switch (event) {
      case "open":
        return this.openListeners as Set<never>;
      case "message":
        return this.messageListeners as Set<never>;
      case "error":
        return this.errorListeners as Set<never>;
      case "close":
        return this.closeListeners as Set<never>;
      case "unexpected-response":
        return this.unexpectedResponseListeners as Set<never>;
    }
  }
}

const noAuthentication = {
  type: "direct-websocket",
  url: "ws://127.0.0.1:4500",
  authentication: { type: "none" },
} satisfies CodexDirectWebSocketTransport;

const capabilityAuthentication = {
  type: "direct-websocket",
  url: "wss://codex.example.test",
  authentication: {
    type: "capability-token",
    credential: { source: "file", path: "/run/secrets/codex-token" },
  },
} satisfies CodexDirectWebSocketTransport;

const signedBearerAuthentication = {
  type: "direct-websocket",
  url: "wss://codex.example.test",
  authentication: {
    type: "signed-bearer-token",
    credential: { source: "file", path: "/run/secrets/codex-signing-key" },
    issuer: "cocoa",
    audience: "codex",
  },
} satisfies CodexDirectWebSocketTransport;

const signingSecret = "0123456789abcdef0123456789abcdef";
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

const makeHarness = () => {
  const socket = new FakeWebSocket();
  let capturedUrl: string | undefined;
  let capturedOptions: NodeSocket.NodeWS.ClientOptions | undefined;
  const makeWebSocket: CodexEndpointWebSocketFactory = (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    queueMicrotask(() => socket.open());
    return socket;
  };
  return {
    socket,
    makeWebSocket,
    get capturedUrl() {
      return capturedUrl;
    },
    get capturedOptions() {
      return capturedOptions;
    },
  };
};

const noOpFileSystem = FileSystem.layerNoop({});

it.effect("opens without Authorization when authentication is disabled", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeDirectWebSocketConnector(noAuthentication, {
      makeWebSocket: harness.makeWebSocket,
    });
    yield* connection.outgoing(Stream.make("first", "second"));

    expect(harness.capturedUrl).toBe(noAuthentication.url);
    expect(harness.capturedOptions).toMatchObject({
      headers: {},
      handshakeTimeout: DEFAULT_HANDSHAKE_TIMEOUT_MS,
      maxPayload: DEFAULT_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    expect(harness.socket.sent).toEqual(["first", "second"]);
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
});

it.effect("terminates a connecting socket when opening is interrupted", () => {
  const socket = new FakeWebSocket();
  const makeWebSocket: CodexEndpointWebSocketFactory = () => socket;

  return Effect.gen(function* () {
    const opening = yield* makeDirectWebSocketConnector(noAuthentication, {
      makeWebSocket,
    }).pipe(Effect.scoped, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(opening);

    expect(socket.terminateCount).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
});

it.effect("preserves an HTTP upgrade rejection status", () => {
  const socket = new FakeWebSocket();
  const makeWebSocket: CodexEndpointWebSocketFactory = () => {
    queueMicrotask(() => socket.unexpectedResponse(401));
    return socket;
  };

  return Effect.gen(function* () {
    const error = yield* makeDirectWebSocketConnector(noAuthentication, {
      makeWebSocket,
    }).pipe(Effect.flip);

    expect(error._tag).toBe("CodexEndpointWebSocketOpenError");
    if (error._tag !== "CodexEndpointWebSocketOpenError") return;
    expect(error.httpStatus).toBe(401);
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
});

it.effect("reads a capability token file and sends an explicit Authorization header", () => {
  const harness = makeHarness();
  const paths: string[] = [];
  const fileSystem = FileSystem.layerNoop({
    readFileString: (path) => {
      paths.push(path);
      return Effect.succeed("  secret-value\n");
    },
  });

  return Effect.gen(function* () {
    yield* makeDirectWebSocketConnector(capabilityAuthentication, {
      makeWebSocket: harness.makeWebSocket,
    });

    expect(paths).toEqual(["/run/secrets/codex-token"]);
    expect(harness.capturedOptions?.headers).toEqual({
      Authorization: "Bearer secret-value",
    });
  }).pipe(Effect.scoped, Effect.provide(fileSystem));
});

it.effect("mints a signed bearer token from the referenced shared secret", () => {
  const harness = makeHarness();
  const paths: string[] = [];
  const fileSystem = FileSystem.layerNoop({
    readFileString: (path) => {
      paths.push(path);
      return Effect.succeed(`  ${signingSecret}\n`);
    },
  });

  return Effect.gen(function* () {
    yield* makeDirectWebSocketConnector(signedBearerAuthentication, {
      makeWebSocket: harness.makeWebSocket,
      nowEpochSeconds: () => 1_700_000_000,
    });

    expect(paths).toEqual(["/run/secrets/codex-signing-key"]);
    expect(harness.capturedOptions?.headers).toEqual({
      Authorization:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjb2NvYSIsImF1ZCI6ImNvZGV4IiwiZXhwIjoxNzAwMDAwMDYwfQ.8vMM1DNvNDzxI-i8JyaZzvgIwKIYTJ9WcqTOnRGxCtg",
    });
  }).pipe(Effect.scoped, Effect.provide(fileSystem));
});

it.effect("mints a fresh signed bearer token for every connector call", () => {
  const first = makeHarness();
  const second = makeHarness();
  const times = [1_700_000_000, 1_700_000_001];
  let credentialReads = 0;
  const fileSystem = FileSystem.layerNoop({
    readFileString: () => {
      credentialReads += 1;
      return Effect.succeed(signingSecret);
    },
  });

  return Effect.gen(function* () {
    yield* makeDirectWebSocketConnector(signedBearerAuthentication, {
      makeWebSocket: first.makeWebSocket,
      nowEpochSeconds: () => times.shift()!,
    }).pipe(Effect.scoped);
    yield* makeDirectWebSocketConnector(signedBearerAuthentication, {
      makeWebSocket: second.makeWebSocket,
      nowEpochSeconds: () => times.shift()!,
    }).pipe(Effect.scoped);

    const firstToken = String(first.capturedOptions?.headers?.Authorization).slice(7);
    const secondToken = String(second.capturedOptions?.headers?.Authorization).slice(7);
    expect(credentialReads).toBe(2);
    expect(firstToken).not.toBe(secondToken);
    expect(
      decodeJson(Buffer.from(firstToken.split(".")[1]!, "base64url").toString("utf8")),
    ).toEqual({ iss: "cocoa", aud: "codex", exp: 1_700_000_060 });
    expect(
      decodeJson(Buffer.from(secondToken.split(".")[1]!, "base64url").toString("utf8")),
    ).toEqual({ iss: "cocoa", aud: "codex", exp: 1_700_000_061 });
  }).pipe(Effect.provide(fileSystem));
});

it.effect("keeps endpoint credentials and audiences isolated", () => {
  const macaroni = makeHarness();
  const alfredo = makeHarness();
  const macaroniSecret = "macaroni-0123456789abcdef0123456789abcdef";
  const alfredoSecret = "alfredo--0123456789abcdef0123456789abcdef";
  const reads: string[] = [];
  const fileSystem = FileSystem.layerNoop({
    readFileString: (path) => {
      reads.push(path);
      return Effect.succeed(path.endsWith("macaroni") ? macaroniSecret : alfredoSecret);
    },
  });
  const transport = (host: string, audience: string) =>
    ({
      type: "direct-websocket",
      url: `ws://${host}:4500`,
      allowInsecureTransport: true,
      authentication: {
        type: "signed-bearer-token",
        credential: { source: "file", path: `/run/secrets/${host}` },
        issuer: "cocoa-gateway",
        audience,
      },
    }) satisfies CodexDirectWebSocketTransport;

  return Effect.gen(function* () {
    yield* makeDirectWebSocketConnector(transport("macaroni", "codex-macaroni"), {
      makeWebSocket: macaroni.makeWebSocket,
      nowEpochSeconds: () => 1_700_000_000,
    }).pipe(Effect.scoped);
    yield* makeDirectWebSocketConnector(transport("rigatoni-alfredo", "codex-rigatoni-alfredo"), {
      makeWebSocket: alfredo.makeWebSocket,
      nowEpochSeconds: () => 1_700_000_000,
    }).pipe(Effect.scoped);

    const macaroniToken = String(macaroni.capturedOptions?.headers?.Authorization).slice(7);
    const alfredoToken = String(alfredo.capturedOptions?.headers?.Authorization).slice(7);
    expect(reads).toEqual(["/run/secrets/macaroni", "/run/secrets/rigatoni-alfredo"]);
    expect(macaroniToken).not.toBe(alfredoToken);
    expect(
      decodeJson(Buffer.from(macaroniToken.split(".")[1]!, "base64url").toString("utf8")),
    ).toEqual({ iss: "cocoa-gateway", aud: "codex-macaroni", exp: 1_700_000_060 });
    expect(
      decodeJson(Buffer.from(alfredoToken.split(".")[1]!, "base64url").toString("utf8")),
    ).toEqual({
      iss: "cocoa-gateway",
      aud: "codex-rigatoni-alfredo",
      exp: 1_700_000_060,
    });
  }).pipe(Effect.provide(fileSystem));
});

it.effect("rejects signed bearer secrets shorter than 32 bytes before creating a WebSocket", () => {
  const harness = makeHarness();
  const fileSystem = FileSystem.layerNoop({
    readFileString: () => Effect.succeed("short shared secret"),
  });

  return Effect.gen(function* () {
    const error = yield* makeDirectWebSocketConnector(signedBearerAuthentication, {
      makeWebSocket: harness.makeWebSocket,
    }).pipe(Effect.flip);

    expect(error._tag).toBe("CodexEndpointInvalidCredentialError");
    expect(error).toMatchObject({ reason: "too-short" });
    expect(harness.capturedUrl).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(fileSystem));
});

it.effect("does not create a WebSocket when signed bearer token signing fails", () => {
  const harness = makeHarness();
  const fileSystem = FileSystem.layerNoop({
    readFileString: () => Effect.succeed(signingSecret),
  });

  return Effect.gen(function* () {
    const error = yield* makeDirectWebSocketConnector(signedBearerAuthentication, {
      makeWebSocket: harness.makeWebSocket,
      mintSignedBearerToken: () => {
        throw new Error("signing unavailable");
      },
    }).pipe(Effect.flip);

    expect(error._tag).toBe("CodexEndpointCredentialSigningError");
    expect(harness.capturedUrl).toBeUndefined();
    expect(error).not.toHaveProperty("secret");
    expect(error).toMatchObject({ path: "/run/secrets/codex-signing-key" });
  }).pipe(Effect.scoped, Effect.provide(fileSystem));
});

it.effect("rejects binary frames as a typed transport failure", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeDirectWebSocketConnector(noAuthentication, {
      makeWebSocket: harness.makeWebSocket,
    });
    const failure = yield* Stream.runHead(connection.incoming).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    harness.socket.message(Buffer.from([1, 2, 3]), true);

    const error = yield* Fiber.join(failure);
    expect(error._tag).toBe("CodexAppServerTransportError");
    expect((error.cause as { _tag?: string })._tag).toBe("CodexEndpointBinaryFrameError");
    expect(harness.socket.closeCount).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
});

it.effect("fails incoming frames when the socket emits an error", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeDirectWebSocketConnector(noAuthentication, {
      makeWebSocket: harness.makeWebSocket,
    });
    const failure = yield* Stream.runHead(connection.incoming).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    harness.socket.error(new Error("network lost"));

    const error = yield* Fiber.join(failure);
    expect(error._tag).toBe("CodexAppServerTransportError");
    expect((error.cause as { _tag?: string })._tag).toBe("CodexEndpointWebSocketError");
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
});

it.effect("converges both transport directions when a send fails", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeDirectWebSocketConnector(noAuthentication, {
      makeWebSocket: harness.makeWebSocket,
    });
    const incomingFailure = yield* Stream.runHead(connection.incoming).pipe(
      Effect.flip,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    harness.socket.sendError = new Error("send failed");

    const outgoingError = yield* connection.outgoing(Stream.make("frame")).pipe(Effect.flip);
    const incomingError = yield* Fiber.join(incomingFailure);
    const terminationError = yield* connection.terminationError;

    expect(outgoingError._tag).toBe("CodexAppServerTransportError");
    expect(incomingError).toBe(outgoingError);
    expect(terminationError).toBe(outgoingError);
    expect(harness.socket.terminateCount).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
});

it.effect("propagates abnormal disconnects through the incoming stream", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeDirectWebSocketConnector(noAuthentication, {
      makeWebSocket: harness.makeWebSocket,
    });
    const failure = yield* Stream.runHead(connection.incoming).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    harness.socket.disconnect(1006, "network lost");

    const error = yield* Fiber.join(failure);
    expect(error._tag).toBe("CodexAppServerTransportError");
    expect((error.cause as { code?: number }).code).toBe(1006);
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
});

it.effect("ends incoming normally while retaining the clean-close termination error", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeDirectWebSocketConnector(noAuthentication, {
      makeWebSocket: harness.makeWebSocket,
    });
    const collected = yield* Stream.runCollect(connection.incoming).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    harness.socket.message("one");
    harness.socket.disconnect(1000, "normal shutdown");

    expect(Array.from(yield* Fiber.join(collected))).toEqual(["one"]);
    const termination = yield* connection.terminationError;
    expect(termination._tag).toBe("CodexAppServerTransportError");
    expect((termination.cause as { code?: number; wasClean?: boolean }).code).toBe(1000);
    expect((termination.cause as { wasClean?: boolean }).wasClean).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
});

it.effect("pauses a full bounded queue and resumes after consumption", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeDirectWebSocketConnector(noAuthentication, {
      incomingFrameCapacity: 1,
      makeWebSocket: harness.makeWebSocket,
    });
    harness.socket.message("one");
    expect(harness.socket.pauseCount).toBe(1);

    const value = yield* Stream.runHead(connection.incoming);
    expect(Option.getOrUndefined(value)).toBe("one");
    expect(harness.socket.resumeCount).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
});

it.effect("closes the socket when its scope is finalized", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* makeDirectWebSocketConnector(noAuthentication, {
      makeWebSocket: harness.makeWebSocket,
    }).pipe(Effect.scoped);

    expect(harness.socket.terminateCount).toBe(1);
    expect(harness.socket.readyState).toBe(3);
  }).pipe(Effect.provide(noOpFileSystem));
});
