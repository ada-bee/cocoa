// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";

import { expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { makeSshProxyWebSocketFramedTransport } from "./SshProxyWebSocketFraming.ts";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface FrameOptions {
  readonly fin?: boolean;
  readonly masked?: boolean;
}

const serverFrame = (
  opcode: number,
  payload: string | Uint8Array = "",
  options: FrameOptions = {},
): Buffer => {
  const body = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
  const masked = options.masked === true;
  const lengthBytes = body.length < 126 ? 0 : body.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (masked ? 4 : 0));
  header[0] = (options.fin === false ? 0 : 0x80) | opcode;
  header[1] =
    (masked ? 0x80 : 0) | (lengthBytes === 0 ? body.length : lengthBytes === 2 ? 126 : 127);
  let offset = 2;
  if (lengthBytes === 2) {
    header.writeUInt16BE(body.length, offset);
    offset += 2;
  } else if (lengthBytes === 8) {
    header.writeBigUInt64BE(BigInt(body.length), offset);
    offset += 8;
  }
  if (!masked) return Buffer.concat([header, body]);
  const mask = Buffer.from([1, 2, 3, 4]);
  mask.copy(header, offset);
  const encoded = Buffer.from(body);
  for (let index = 0; index < encoded.length; index += 1) {
    encoded[index] = encoded[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, encoded]);
};

interface ParsedFrame {
  readonly opcode: number;
  readonly masked: boolean;
  readonly payload: Buffer;
}

const parseFrame = (
  buffer: Buffer,
): { readonly consumed: number; readonly frame: ParsedFrame } | undefined => {
  if (buffer.length < 2) return undefined;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
  }
  return {
    consumed: offset + length,
    frame: { opcode: buffer[0]! & 0x0f, masked, payload },
  };
};

interface HarnessOptions {
  readonly responseStatus?: number;
  readonly responseRemainder?: Buffer;
}

const makeHarness = Effect.fn("test.makeWebSocketFramingHarness")(function* (
  options: HarnessOptions = {},
) {
  const [client, server] = NodeStream.duplexPair({ allowHalfOpen: false });
  const clientFrames = yield* Queue.unbounded<ParsedFrame>();
  let input = Buffer.alloc(0);
  let upgraded = false;
  let request = "";

  const handleData = (chunk: Buffer | Uint8Array): void => {
    input = Buffer.concat([input, Buffer.from(chunk)]);
    if (!upgraded) {
      const headerEnd = input.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      request = input.subarray(0, headerEnd + 4).toString("latin1");
      input = input.subarray(headerEnd + 4);
      const status = options.responseStatus ?? 101;
      if (status === 101) {
        const key = /^sec-websocket-key:\s*(.+)$/imu.exec(request)?.[1]?.trim();
        if (!key) throw new Error("Missing Sec-WebSocket-Key");
        const accept = NodeCrypto.createHash("sha1")
          .update(`${key}${ACCEPT_GUID}`)
          .digest("base64");
        server.write(
          Buffer.concat([
            Buffer.from(
              "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: keep-alive, Upgrade\r\n" +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            ),
            options.responseRemainder ?? Buffer.alloc(0),
          ]),
        );
      } else {
        server.write(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\n\r\n`);
      }
      upgraded = true;
    }

    while (input.length > 0) {
      const parsed = parseFrame(input);
      if (!parsed) return;
      input = input.subarray(parsed.consumed);
      Queue.offerUnsafe(clientFrames, parsed.frame);
    }
  };
  server.on("data", handleData);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      server.off("data", handleData);
      client.destroy();
      server.destroy();
    }),
  );

  return {
    client,
    server,
    clientFrames,
    get request() {
      return request;
    },
  };
});

it.effect("preserves bytes following the HTTP upgrade and masks client text frames", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      responseRemainder: serverFrame(1, "from-remainder"),
    });
    const transport = yield* makeSshProxyWebSocketFramedTransport(harness.client);

    expect(Option.getOrUndefined(yield* Stream.runHead(transport.incoming))).toBe("from-remainder");
    yield* transport.outgoing(Stream.make("from-client"));
    const frame = yield* Queue.take(harness.clientFrames);
    expect(frame.opcode).toBe(1);
    expect(frame.masked).toBe(true);
    expect(frame.payload.toString()).toBe("from-client");
    expect(harness.request).toContain("Sec-WebSocket-Version: 13");
  }).pipe(Effect.scoped),
);

it.effect("reassembles fragmented text while replying to an interleaved ping", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const transport = yield* makeSshProxyWebSocketFramedTransport(harness.client);
    const read = yield* Stream.runHead(transport.incoming).pipe(Effect.forkChild);

    harness.server.write(serverFrame(1, "hel", { fin: false }));
    harness.server.write(serverFrame(9, "alive"));
    harness.server.write(serverFrame(0, "lo"));

    expect(Option.getOrUndefined(yield* Fiber.join(read))).toBe("hello");
    const pong = yield* Queue.take(harness.clientFrames);
    expect(pong.opcode).toBe(10);
    expect(pong.masked).toBe(true);
    expect(pong.payload.toString()).toBe("alive");
  }).pipe(Effect.scoped),
);

it.effect("echoes a clean close and completes the incoming stream", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const transport = yield* makeSshProxyWebSocketFramedTransport(harness.client);
    const collected = yield* Stream.runCollect(transport.incoming).pipe(Effect.forkChild);
    const closeBody = Buffer.alloc(2 + Buffer.byteLength("done"));
    closeBody.writeUInt16BE(1000, 0);
    closeBody.write("done", 2);
    harness.server.write(serverFrame(8, closeBody));

    expect(Array.from(yield* Fiber.join(collected))).toEqual([]);
    const close = yield* Queue.take(harness.clientFrames);
    expect(close.opcode).toBe(8);
    expect(close.masked).toBe(true);
    expect(close.payload.readUInt16BE(0)).toBe(1000);
    expect(close.payload.subarray(2).toString()).toBe("done");
    expect((yield* transport.terminationError).cause).toMatchObject({ code: 1000 });
  }).pipe(Effect.scoped),
);

it.effect("rejects masked server frames as a typed protocol failure", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const transport = yield* makeSshProxyWebSocketFramedTransport(harness.client);
    const failedRead = yield* Stream.runHead(transport.incoming).pipe(
      Effect.flip,
      Effect.forkChild,
    );
    harness.server.write(serverFrame(1, "invalid", { masked: true }));

    const failure = yield* Fiber.join(failedRead);
    expect(failure._tag).toBe("CodexAppServerTransportError");
    expect((failure.cause as { readonly _tag?: string })._tag).toBe(
      "CodexSshProxyWebSocketProtocolError",
    );
    const close = yield* Queue.take(harness.clientFrames);
    expect(close.opcode).toBe(8);
  }).pipe(Effect.scoped),
);

it.effect("enforces the aggregate payload limit across fragments", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const transport = yield* makeSshProxyWebSocketFramedTransport(harness.client, {
      maxPayloadBytes: 5,
    });
    const failedRead = yield* Stream.runHead(transport.incoming).pipe(
      Effect.flip,
      Effect.forkChild,
    );
    harness.server.write(
      Buffer.concat([serverFrame(1, "abc", { fin: false }), serverFrame(0, "def")]),
    );

    const failure = yield* Fiber.join(failedRead);
    expect((failure.cause as { readonly _tag?: string })._tag).toBe(
      "CodexSshProxyWebSocketProtocolError",
    );
  }).pipe(Effect.scoped),
);

it.effect("pauses at the bounded incoming capacity and resumes after consumption", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const transport = yield* makeSshProxyWebSocketFramedTransport(harness.client, {
      incomingFrameCapacity: 1,
    });
    harness.server.write(serverFrame(1, "one"));
    expect(harness.client.isPaused()).toBe(true);

    expect(Option.getOrUndefined(yield* Stream.runHead(transport.incoming))).toBe("one");
    expect(harness.client.isPaused()).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("fails rather than buffering messages beyond the configured bound", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const transport = yield* makeSshProxyWebSocketFramedTransport(harness.client, {
      incomingFrameCapacity: 1,
    });
    harness.server.write(Buffer.concat([serverFrame(1, "one"), serverFrame(1, "two")]));

    const failure = yield* transport.terminationError;
    expect((failure.cause as { readonly _tag?: string })._tag).toBe(
      "CodexEndpointIncomingFrameOverflowError",
    );
  }).pipe(Effect.scoped),
);

it.effect("preserves a rejected HTTP status", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const harness = yield* makeHarness({ responseStatus: 403 });
    const failure = yield* makeSshProxyWebSocketFramedTransport(harness.client).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.flip,
    );

    expect(failure.httpStatus).toBe(403);
    yield* Scope.close(scope, Exit.void);
  }).pipe(Effect.scoped),
);

it.effect("destroys the owned duplex when its successful scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const harness = yield* makeHarness();
    yield* makeSshProxyWebSocketFramedTransport(harness.client).pipe(
      Effect.provideService(Scope.Scope, scope),
    );

    expect(harness.client.destroyed).toBe(false);
    yield* Scope.close(scope, Exit.void);
    expect(harness.client.destroyed).toBe(true);
  }).pipe(Effect.scoped),
);
