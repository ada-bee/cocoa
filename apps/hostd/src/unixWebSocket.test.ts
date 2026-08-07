// @effect-diagnostics nodeBuiltinImport:off - This handshake test uses isolated native Unix sockets and temporary paths.

import { afterEach, describe, expect, test } from "bun:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { connectUnixWebSocket } from "./unixWebSocket.ts";

interface HandshakeState {
  buffer: Buffer;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).toReversed()) await action();
});

const startInvalidHandshakeServer = async (): Promise<string> => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "cocoa-hostd-handshake-test-"),
  );
  const socketPath = NodePath.join(directory, "codex.sock");
  const listener = Bun.listen<HandshakeState>({
    unix: socketPath,
    data: { buffer: Buffer.alloc(0) },
    socket: {
      binaryType: "buffer",
      open(socket) {
        socket.data = { buffer: Buffer.alloc(0) };
      },
      data(socket, chunk) {
        socket.data.buffer = Buffer.concat([socket.data.buffer, chunk]);
        if (!socket.data.buffer.includes("\r\n\r\n")) return;
        socket.end(
          Buffer.from(
            [
              "HTTP/1.1 101 Switching Protocols",
              "Upgrade: websocket",
              "Connection: Upgrade",
              "Sec-WebSocket-Accept: deliberately-invalid",
              "",
              "",
            ].join("\r\n"),
          ),
        );
      },
    },
  });
  cleanup.push(
    () => NodeFSP.rm(directory, { recursive: true, force: true }),
    async () => listener.stop(true),
  );
  return socketPath;
};

describe("Unix WebSocket handshake", () => {
  test("rejects a server with an invalid WebSocket accept key", async () => {
    const socketPath = await startInvalidHandshakeServer();
    const socket = connectUnixWebSocket(socketPath);
    const cause = await new Promise<Error>((resolve) => socket.once("error", resolve));

    expect(cause.message).toContain("accept key is invalid");
  });
});
