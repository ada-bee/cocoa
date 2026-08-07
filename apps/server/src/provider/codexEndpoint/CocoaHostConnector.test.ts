// @effect-diagnostics nodeBuiltinImport:off
// Exercises the gateway-facing cocoa-hostd WebSocket boundary.
import { CocoaHostKey, type CocoaHostTransport } from "@t3tools/contracts";
import type * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import type * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  type BunClientWebSocket,
  type BunClientWebSocketConstructor,
  type CodexEndpointWebSocket,
  type CodexEndpointWebSocketFactory,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  makeBunWebSocketFactory,
  makeCocoaHostConnector,
} from "./CocoaHostConnector.ts";

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

type BunEventName = "open" | "message" | "error" | "close";
type BunEventListener = (event: unknown) => void;

class FakeBunClientWebSocket implements BunClientWebSocket {
  private static latest: FakeBunClientWebSocket | undefined;
  static capturedUrl: string | undefined;
  static capturedOptions:
    | {
        readonly headers?: NodeHttp.OutgoingHttpHeaders;
        readonly perMessageDeflate?: boolean;
      }
    | undefined;

  readyState = 0;
  binaryType = "arraybuffer";
  readonly sent: string[] = [];
  readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = [];
  terminateCount = 0;

  private readonly eventListeners = new Map<BunEventName, Set<BunEventListener>>();

  static reset(): void {
    FakeBunClientWebSocket.latest = undefined;
  }

  static current(): FakeBunClientWebSocket | undefined {
    return FakeBunClientWebSocket.latest;
  }

  constructor(
    url: string,
    options: {
      readonly headers?: NodeHttp.OutgoingHttpHeaders;
      readonly perMessageDeflate?: boolean;
    },
  ) {
    FakeBunClientWebSocket.latest = this;
    FakeBunClientWebSocket.capturedUrl = url;
    FakeBunClientWebSocket.capturedOptions = options;
  }

  addEventListener(event: BunEventName, listener: BunEventListener): void {
    let listeners = this.eventListeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(event: BunEventName, listener: BunEventListener): void {
    this.eventListeners.get(event)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closes.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  terminate(): void {
    this.terminateCount += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: string | Buffer): void {
    this.emit("message", { data });
  }

  private emit(event: BunEventName, detail: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) listener(detail);
  }
}

const BunWebSocketConstructor = FakeBunClientWebSocket as unknown as BunClientWebSocketConstructor;

const connectWithFakeBun = Effect.fn("CocoaHostConnectorTest.connectWithFakeBun")(function* (
  options: { readonly incomingFrameCapacity?: number; readonly maxPayloadBytes?: number } = {},
) {
  FakeBunClientWebSocket.reset();
  const connecting = yield* makeCocoaHostConnector(cocoaHost, {
    ...options,
    makeWebSocket: makeBunWebSocketFactory(BunWebSocketConstructor),
  }).pipe(Effect.forkChild);
  yield* Effect.yieldNow;
  const socket = FakeBunClientWebSocket.current();
  if (socket === undefined) return yield* Effect.die(new Error("Bun WebSocket was not created"));
  socket.open();
  const connection = yield* Fiber.join(connecting);
  return { connection, socket } as const;
});

const cocoaHost = {
  type: "cocoa-host",
  url: "ws://127.0.0.1:4510",
  key: CocoaHostKey.make("host_key_abc123"),
} satisfies CocoaHostTransport;

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

it.effect("opens the Cocoa host WebSocket with its pairing key", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeCocoaHostConnector(cocoaHost, {
      makeWebSocket: harness.makeWebSocket,
    });
    yield* connection.outgoing(Stream.make("first", "second"));

    expect(harness.capturedUrl).toBe(cocoaHost.url);
    expect(harness.capturedOptions).toMatchObject({
      headers: { Authorization: "Bearer host_key_abc123" },
      handshakeTimeout: DEFAULT_HANDSHAKE_TIMEOUT_MS,
      maxPayload: DEFAULT_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    expect(harness.socket.sent).toEqual(["first", "second"]);
  }).pipe(Effect.scoped);
});

it.effect("adapts Bun WebSocket events and preserves the Bearer handshake", () =>
  Effect.gen(function* () {
    const { connection, socket } = yield* connectWithFakeBun();
    const incoming = yield* Stream.runHead(connection.incoming).pipe(Effect.forkChild);
    socket.message("from-hostd");

    expect(FakeBunClientWebSocket.capturedUrl).toBe(cocoaHost.url);
    expect(FakeBunClientWebSocket.capturedOptions).toMatchObject({
      headers: { Authorization: "Bearer host_key_abc123" },
      perMessageDeflate: false,
    });
    expect(socket.binaryType).toBe("nodebuffer");
    expect(Option.getOrUndefined(yield* Fiber.join(incoming))).toBe("from-hostd");

    yield* connection.outgoing(Stream.make("to-hostd"));
    expect(socket.sent).toEqual(["to-hostd"]);
  }).pipe(Effect.scoped),
);

it.effect("closes a Bun WebSocket when its no-op pause reaches bounded overflow", () =>
  Effect.gen(function* () {
    const { connection, socket } = yield* connectWithFakeBun({ incomingFrameCapacity: 1 });
    socket.message("one");
    socket.message("two");

    const termination = yield* connection.terminationError;
    expect(termination._tag).toBe("CodexAppServerTransportError");
    expect((termination.cause as { _tag?: string })._tag).toBe(
      "CodexEndpointIncomingFrameOverflowError",
    );
    expect(socket.closes).toContainEqual({
      code: 1008,
      reason: "Incoming frame capacity exceeded",
    });
  }).pipe(Effect.scoped),
);

it.effect("enforces the configured payload limit for Bun WebSockets", () =>
  Effect.gen(function* () {
    const { connection, socket } = yield* connectWithFakeBun({ maxPayloadBytes: 3 });
    socket.message("four");

    const termination = yield* connection.terminationError;
    expect(termination._tag).toBe("CodexAppServerTransportError");
    expect((termination.cause as { _tag?: string })._tag).toBe("CodexEndpointWebSocketError");
    expect(socket.closes).toContainEqual({
      code: 1009,
      reason: "WebSocket payload limit exceeded",
    });
  }).pipe(Effect.scoped),
);

it.effect("terminates a connecting socket when opening is interrupted", () => {
  const socket = new FakeWebSocket();
  const makeWebSocket: CodexEndpointWebSocketFactory = () => socket;

  return Effect.gen(function* () {
    const opening = yield* makeCocoaHostConnector(cocoaHost, {
      makeWebSocket,
    }).pipe(Effect.scoped, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(opening);

    expect(socket.terminateCount).toBe(1);
  }).pipe(Effect.scoped);
});

it.effect("preserves an HTTP upgrade rejection status", () => {
  const socket = new FakeWebSocket();
  const makeWebSocket: CodexEndpointWebSocketFactory = () => {
    queueMicrotask(() => socket.unexpectedResponse(401));
    return socket;
  };

  return Effect.gen(function* () {
    const error = yield* makeCocoaHostConnector(cocoaHost, {
      makeWebSocket,
    }).pipe(Effect.flip);

    expect(error._tag).toBe("CodexEndpointWebSocketOpenError");
    if (error._tag !== "CodexEndpointWebSocketOpenError") return;
    expect(error.httpStatus).toBe(401);
  }).pipe(Effect.scoped);
});

it.effect("rejects binary frames as a typed transport failure", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeCocoaHostConnector(cocoaHost, {
      makeWebSocket: harness.makeWebSocket,
    });
    const failure = yield* Stream.runHead(connection.incoming).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    harness.socket.message(Buffer.from([1, 2, 3]), true);

    const error = yield* Fiber.join(failure);
    expect(error._tag).toBe("CodexAppServerTransportError");
    expect((error.cause as { _tag?: string })._tag).toBe("CodexEndpointBinaryFrameError");
    expect(harness.socket.closeCount).toBe(1);
  }).pipe(Effect.scoped);
});

it.effect("fails incoming frames when the socket emits an error", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeCocoaHostConnector(cocoaHost, {
      makeWebSocket: harness.makeWebSocket,
    });
    const failure = yield* Stream.runHead(connection.incoming).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    harness.socket.error(new Error("network lost"));

    const error = yield* Fiber.join(failure);
    expect(error._tag).toBe("CodexAppServerTransportError");
    expect((error.cause as { _tag?: string })._tag).toBe("CodexEndpointWebSocketError");
  }).pipe(Effect.scoped);
});

it.effect("converges both transport directions when a send fails", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeCocoaHostConnector(cocoaHost, {
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
  }).pipe(Effect.scoped);
});

it.effect("propagates abnormal disconnects through the incoming stream", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeCocoaHostConnector(cocoaHost, {
      makeWebSocket: harness.makeWebSocket,
    });
    const failure = yield* Stream.runHead(connection.incoming).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    harness.socket.disconnect(1006, "network lost");

    const error = yield* Fiber.join(failure);
    expect(error._tag).toBe("CodexAppServerTransportError");
    expect((error.cause as { code?: number }).code).toBe(1006);
  }).pipe(Effect.scoped);
});

it.effect("ends incoming normally while retaining the clean-close termination error", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeCocoaHostConnector(cocoaHost, {
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
  }).pipe(Effect.scoped);
});

it.effect("pauses a full bounded queue and resumes after consumption", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const connection = yield* makeCocoaHostConnector(cocoaHost, {
      incomingFrameCapacity: 1,
      makeWebSocket: harness.makeWebSocket,
    });
    harness.socket.message("one");
    expect(harness.socket.pauseCount).toBe(1);

    const value = yield* Stream.runHead(connection.incoming);
    expect(Option.getOrUndefined(value)).toBe("one");
    expect(harness.socket.resumeCount).toBe(1);
  }).pipe(Effect.scoped);
});

it.effect("closes the socket when its scope is finalized", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* makeCocoaHostConnector(cocoaHost, {
      makeWebSocket: harness.makeWebSocket,
    }).pipe(Effect.scoped);

    expect(harness.socket.terminateCount).toBe(1);
    expect(harness.socket.readyState).toBe(3);
  }).pipe(Effect.scoped);
});
