// @effect-diagnostics nodeBuiltinImport:off - The relay integration test uses isolated native Unix sockets and temporary paths.

import { afterEach, describe, expect, test } from "bun:test";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import NodeWebSocket from "ws-rfc6455";

import { startHostd, type RunningHostd } from "./relay.ts";

const cleanup: Array<() => Promise<void>> = [];
type NodeWebSocketInstance = InstanceType<typeof NodeWebSocket>;

afterEach(async () => {
  for (const action of cleanup.splice(0).toReversed()) await action();
});

const waitForUnexpectedResponse = (
  target: NodeWebSocketInstance,
): Promise<NodeHttp.IncomingMessage> =>
  new Promise((resolve, reject) => {
    target.once(
      "unexpected-response",
      (_request: NodeHttp.ClientRequest, response: NodeHttp.IncomingMessage) => resolve(response),
    );
    target.once("error", reject);
  });

interface EchoSocketState {
  buffer: Buffer;
  upgraded: boolean;
}

const makeServerTextFrame = (payload: Buffer): Buffer => {
  if (payload.byteLength >= 126) throw new Error("Test echo payload is too large");
  return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
};

const echoCompleteClientFrames = (socket: Bun.Socket<EchoSocketState>): void => {
  while (socket.data.buffer.byteLength >= 6) {
    const firstLength = socket.data.buffer[1]! & 0x7f;
    if (firstLength >= 126) throw new Error("Test client payload is too large");
    const frameLength = 2 + 4 + firstLength;
    if (socket.data.buffer.byteLength < frameLength) return;
    const opcode = socket.data.buffer[0]! & 0x0f;
    const mask = socket.data.buffer.subarray(2, 6);
    const payload = Buffer.from(socket.data.buffer.subarray(6, frameLength));
    socket.data.buffer = socket.data.buffer.subarray(frameLength);
    for (let index = 0; index < payload.byteLength; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
    if (opcode === 0x1) socket.write(makeServerTextFrame(payload));
  }
};

const startUnixEchoServer = async (): Promise<string> => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-hostd-test-"));
  const socketPath = NodePath.join(directory, "codex.sock");
  const listener = Bun.listen<EchoSocketState>({
    unix: socketPath,
    data: { buffer: Buffer.alloc(0), upgraded: false },
    socket: {
      binaryType: "buffer",
      open(socket) {
        socket.data = { buffer: Buffer.alloc(0), upgraded: false };
      },
      data(socket, chunk) {
        socket.data.buffer = Buffer.concat([socket.data.buffer, chunk]);
        if (!socket.data.upgraded) {
          const headerEnd = socket.data.buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const request = socket.data.buffer.subarray(0, headerEnd).toString("latin1");
          const key = /(?:^|\r\n)Sec-WebSocket-Key:\s*([^\r\n]+)/iu.exec(request)?.[1]?.trim();
          if (key === undefined) throw new Error("Missing test WebSocket key");
          const accept = NodeCrypto.createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
            .digest("base64");
          socket.data.buffer = socket.data.buffer.subarray(headerEnd + 4);
          socket.data.upgraded = true;
          socket.write(
            Buffer.from(
              [
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${accept}`,
                "",
                "",
              ].join("\r\n"),
            ),
          );
        }
        echoCompleteClientFrames(socket);
      },
    },
  });
  cleanup.push(
    () => NodeFSP.rm(directory, { recursive: true, force: true }),
    async () => listener.stop(true),
  );
  return socketPath;
};

const trackHostd = (hostd: RunningHostd): void => {
  cleanup.push(() => hostd.stop());
};

describe("cocoa-hostd relay", () => {
  test("rejects WebSocket upgrades without the pairing bearer key", async () => {
    const socketPath = await startUnixEchoServer();
    const hostd = startHostd({
      bindHost: "127.0.0.1",
      port: 0,
      socketPath,
      key: "expected-key",
      logger: { info: () => undefined, error: () => undefined },
    });
    trackHostd(hostd);

    const client = new NodeWebSocket(`ws://127.0.0.1:${hostd.port}/`);
    const response = await waitForUnexpectedResponse(client);
    expect(response.statusCode).toBe(401);
    response.resume();
    client.terminate();
  });

  test("relays text messages through a fresh Unix-socket WebSocket", async () => {
    const socketPath = await startUnixEchoServer();
    const hostd = startHostd({
      bindHost: "127.0.0.1",
      port: 0,
      socketPath,
      key: "expected-key",
      logger: { info: () => undefined, error: () => undefined },
    });
    trackHostd(hostd);

    const BunWebSocket = globalThis.WebSocket as unknown as {
      new (url: string, options: Bun.WebSocketOptions): WebSocket;
    };
    const client = new BunWebSocket(`ws://127.0.0.1:${hostd.port}/`, {
      headers: { Authorization: "Bearer expected-key" },
    });
    cleanup.push(async () => client.close());
    await new Promise<void>((resolve, reject) => {
      client.addEventListener("open", () => resolve(), { once: true });
      client.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
        once: true,
      });
    });
    const messageReceived = new Promise<MessageEvent>((resolve) => {
      client.addEventListener("message", resolve, { once: true });
    });
    client.send("hello from the gateway");

    const message = await messageReceived;
    expect(message.data).toBe("hello from the gateway");
  });
});
