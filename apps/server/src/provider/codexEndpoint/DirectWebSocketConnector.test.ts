import type { CodexDirectWebSocketTransport } from "@t3tools/contracts";
import type * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import { expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  type CodexEndpointWebSocket,
  type CodexEndpointWebSocketFactory,
  makeDirectWebSocketConnector,
} from "./DirectWebSocketConnector.ts";

type MessageListener = (data: NodeSocket.NodeWS.RawData, isBinary: boolean) => void;
type ErrorListener = (error: Error) => void;
type CloseListener = (code: number, reason: Buffer) => void;

class FakeWebSocket implements CodexEndpointWebSocket {
  public readyState = 0;
  public readonly sent: string[] = [];
  public pauseCount = 0;
  public resumeCount = 0;
  public closeCount = 0;
  public terminateCount = 0;

  private readonly openListeners = new Set<() => void>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly closeListeners = new Set<CloseListener>();

  on(event: "open", listener: () => void): this;
  on(event: "message", listener: MessageListener): this;
  on(event: "error", listener: ErrorListener): this;
  on(event: "close", listener: CloseListener): this;
  on(
    event: "open" | "message" | "error" | "close",
    listener: (() => void) | MessageListener | ErrorListener | CloseListener,
  ): this {
    this.listeners(event).add(listener as never);
    return this;
  }

  off(event: "open", listener: () => void): this;
  off(event: "message", listener: MessageListener): this;
  off(event: "error", listener: ErrorListener): this;
  off(event: "close", listener: CloseListener): this;
  off(
    event: "open" | "message" | "error" | "close",
    listener: (() => void) | MessageListener | ErrorListener | CloseListener,
  ): this {
    this.listeners(event).delete(listener as never);
    return this;
  }

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    callback();
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

  disconnect(code: number, reason: string): void {
    this.readyState = 3;
    for (const listener of this.closeListeners) listener(code, Buffer.from(reason));
  }

  private listeners(event: "open" | "message" | "error" | "close"): Set<never> {
    switch (event) {
      case "open":
        return this.openListeners as Set<never>;
      case "message":
        return this.messageListeners as Set<never>;
      case "error":
        return this.errorListeners as Set<never>;
      case "close":
        return this.closeListeners as Set<never>;
    }
  }
}

const noAuthentication = {
  type: "direct-websocket",
  url: "ws://192.168.20.99:4500",
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
    expect(harness.capturedOptions?.headers).toEqual({});
    expect(harness.socket.sent).toEqual(["first", "second"]);
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

it.effect("rejects signed bearer authentication before creating a WebSocket", () => {
  const harness = makeHarness();
  const signed = {
    type: "direct-websocket",
    url: "wss://codex.example.test",
    authentication: {
      type: "signed-bearer-token",
      credential: { source: "file", path: "/run/secrets/codex-signing-key" },
      issuer: "cocoa",
      audience: "codex",
    },
  } satisfies CodexDirectWebSocketTransport;

  return Effect.gen(function* () {
    const error = yield* makeDirectWebSocketConnector(signed, {
      makeWebSocket: harness.makeWebSocket,
    }).pipe(Effect.flip);

    expect(error._tag).toBe("CodexEndpointUnsupportedAuthenticationError");
    expect(harness.capturedUrl).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(noOpFileSystem));
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

    expect(harness.socket.closeCount).toBe(1);
    expect(harness.socket.readyState).toBe(3);
  }).pipe(Effect.provide(noOpFileSystem));
});
