// @effect-diagnostics nodeBuiltinImport:off - The relay integration test uses isolated native Unix sockets and temporary paths.

import { afterEach, describe, expect, test } from "bun:test";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  COCOA_HOST_CONTROL_PROTOCOL,
  COCOA_HOST_CONTROL_LEGACY_PROTOCOL_VERSION,
  COCOA_HOST_CONTROL_PROTOCOL_VERSION,
  CocoaHostControlGenerationId,
  CocoaHostControlErrorResponse,
  CocoaHostControlHandshakeErrorResponse,
  CocoaHostControlHandshakeResponse,
  CocoaHostControlResourceId,
  CocoaHostWorkspaceResponse,
  type CocoaHostControlErrorResponse as CocoaHostControlErrorResponseType,
  type CocoaHostControlHandshakeErrorResponse as CocoaHostControlHandshakeErrorResponseType,
  type CocoaHostControlHandshakeResponse as CocoaHostControlHandshakeResponseType,
  type CocoaHostWorkspaceResponse as CocoaHostWorkspaceResponseType,
} from "@t3tools/contracts";
import NodeWebSocket from "ws-rfc6455";

import type { HostControlRuntime } from "./control/runtime.ts";
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

const connectAuthorizedWebSocket = async (
  hostd: RunningHostd,
  route: string,
): Promise<WebSocket> => {
  const BunWebSocket = globalThis.WebSocket as unknown as {
    new (url: string, options: Bun.WebSocketOptions): WebSocket;
  };
  const client = new BunWebSocket(`ws://127.0.0.1:${hostd.port}${route}`, {
    headers: { Authorization: "Bearer expected-key" },
  });
  cleanup.push(async () => client.close());
  await new Promise<void>((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true });
    client.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });
  return client;
};

const receiveJson = async (client: WebSocket): Promise<unknown> => {
  const event = await new Promise<MessageEvent>((resolve) => {
    client.addEventListener("message", resolve, { once: true });
  });
  if (typeof event.data !== "string") throw new Error("Expected a text control frame");
  return JSON.parse(event.data) as unknown;
};

const receiveJsonFrames = async (
  client: WebSocket,
  count: number,
): Promise<ReadonlyArray<unknown>> =>
  new Promise((resolve, reject) => {
    const frames: Array<unknown> = [];
    const onMessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") {
        client.removeEventListener("message", onMessage);
        reject(new Error("Expected a text control frame"));
        return;
      }
      frames.push(JSON.parse(event.data) as unknown);
      if (frames.length < count) return;
      client.removeEventListener("message", onMessage);
      resolve(frames);
    };
    client.addEventListener("message", onMessage);
  });

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

    const client = await connectAuthorizedWebSocket(hostd, "/");
    const messageReceived = new Promise<MessageEvent>((resolve) => {
      client.addEventListener("message", resolve, { once: true });
    });
    client.send("hello from the gateway");

    const message = await messageReceived;
    expect(message.data).toBe("hello from the gateway");
  });

  test("handshakes on the versioned control route and advertises the Codex relay", async () => {
    const socketPath = await startUnixEchoServer();
    const hostd = startHostd({
      bindHost: "127.0.0.1",
      port: 0,
      socketPath,
      key: "expected-key",
      logger: { info: () => undefined, error: () => undefined },
    });
    trackHostd(hostd);

    const client = await connectAuthorizedWebSocket(hostd, "/control/v1");
    const responseReceived = receiveJson(client);
    client.send(
      JSON.stringify({
        protocol: COCOA_HOST_CONTROL_PROTOCOL,
        requestId: "handshake-1",
        supportedVersions: [COCOA_HOST_CONTROL_PROTOCOL_VERSION],
        client: { name: "cocoa-gateway", version: "test" },
      }),
    );

    const response = CocoaHostControlHandshakeResponse.make(
      (await responseReceived) as CocoaHostControlHandshakeResponseType,
    );
    expect(String(response.requestId)).toBe("handshake-1");
    expect(response.selectedVersion).toBe(COCOA_HOST_CONTROL_PROTOCOL_VERSION);
    expect(response.host.implementation).toBe("cocoa-hostd");
    expect(response.host.generationId).toStartWith("host:");
    expect(response.capabilities.map(({ kind }) => kind)).toEqual([
      "workspace",
      "vcs",
      "reviewDiff",
      "terminal",
      "usage",
      "providerRelay",
    ]);
    expect(response.capabilities.find(({ kind }) => kind === "terminal")).toMatchObject({
      operations: ["start", "attach", "write", "resize", "terminate"],
      supportsReconnect: true,
    });
    expect(response.providerRelays).toHaveLength(1);
    expect(String(response.providerRelays[0]?.relayId)).toBe("codex");
    expect(response.providerRelays[0]?.provider).toBe("codex");
    expect(response.providerRelays[0]?.route).toBe("/");
    expect(response.providerRelays[0]?.transport).toBe("websocket-json-rpc");
    expect(response.providerRelays[0]?.status).toBe("available");
    expect(response.providerRelays[0]?.generationId).toBeNull();
  });

  test("downgrades for a v1 gateway without advertising v2-only usage", async () => {
    const socketPath = await startUnixEchoServer();
    const workspacePath = NodePath.dirname(socketPath);
    const hostd = startHostd({
      bindHost: "127.0.0.1",
      port: 0,
      socketPath,
      key: "expected-key",
      logger: { info: () => undefined, error: () => undefined },
    });
    trackHostd(hostd);

    const client = await connectAuthorizedWebSocket(hostd, "/control/v1");
    const handshakeReceived = receiveJson(client);
    client.send(
      JSON.stringify({
        protocol: COCOA_HOST_CONTROL_PROTOCOL,
        requestId: "handshake-v1",
        supportedVersions: [COCOA_HOST_CONTROL_LEGACY_PROTOCOL_VERSION],
        client: { name: "old-cocoa-gateway", version: "test" },
      }),
    );

    const handshake = CocoaHostControlHandshakeResponse.make(
      (await handshakeReceived) as CocoaHostControlHandshakeResponseType,
    );
    expect(handshake.selectedVersion).toBe(COCOA_HOST_CONTROL_LEGACY_PROTOCOL_VERSION);
    expect(handshake.capabilities.map(({ kind }) => kind)).not.toContain("usage");
    expect(handshake.capabilities.every(({ version }) => version === 1)).toBeTrue();

    const responseReceived = receiveJson(client);
    client.send(
      JSON.stringify({
        protocolVersion: COCOA_HOST_CONTROL_LEGACY_PROTOCOL_VERSION,
        requestId: "workspace-open-v1",
        operation: "workspace.open",
        path: workspacePath,
      }),
    );
    const response = CocoaHostWorkspaceResponse.make(
      (await responseReceived) as CocoaHostWorkspaceResponseType,
    );
    expect(response.protocolVersion).toBe(COCOA_HOST_CONTROL_LEGACY_PROTOCOL_VERSION);
  });

  test("dispatches typed workspace operations after the control handshake", async () => {
    const socketPath = await startUnixEchoServer();
    const workspacePath = NodePath.dirname(socketPath);
    const canonicalWorkspacePath = await NodeFSP.realpath(workspacePath);
    const hostd = startHostd({
      bindHost: "127.0.0.1",
      port: 0,
      socketPath,
      key: "expected-key",
      logger: { info: () => undefined, error: () => undefined },
    });
    trackHostd(hostd);

    const client = await connectAuthorizedWebSocket(hostd, "/control/v1");
    const handshakeReceived = receiveJson(client);
    client.send(
      JSON.stringify({
        protocol: COCOA_HOST_CONTROL_PROTOCOL,
        requestId: "handshake-1",
        supportedVersions: [COCOA_HOST_CONTROL_PROTOCOL_VERSION],
        client: { name: "cocoa-gateway", version: "test" },
      }),
    );
    CocoaHostControlHandshakeResponse.make(
      (await handshakeReceived) as CocoaHostControlHandshakeResponseType,
    );

    const responseReceived = receiveJson(client);
    client.send(
      JSON.stringify({
        protocolVersion: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
        requestId: "workspace-open-1",
        operation: "workspace.open",
        path: workspacePath,
      }),
    );
    const response = CocoaHostWorkspaceResponse.make(
      (await responseReceived) as CocoaHostWorkspaceResponseType,
    );
    expect(response.protocolVersion).toBe(COCOA_HOST_CONTROL_PROTOCOL_VERSION);
    expect(String(response.requestId)).toBe("workspace-open-1");
    expect(response.operation).toBe("workspace.open");
    if (response.operation !== "workspace.open") throw new Error("Expected workspace open");
    expect(response.canonicalRoot).toBe(canonicalWorkspacePath);
    expect(response.generationId).toStartWith("host:");
    expect(response.metadata.kind).toBe("directory");
  });

  test("rejects an invalid nested control payload before dispatch", async () => {
    const socketPath = await startUnixEchoServer();
    const hostd = startHostd({
      bindHost: "127.0.0.1",
      port: 0,
      socketPath,
      key: "expected-key",
      logger: { info: () => undefined, error: () => undefined },
    });
    trackHostd(hostd);

    const client = await connectAuthorizedWebSocket(hostd, "/control/v1");
    const handshakeReceived = receiveJson(client);
    client.send(
      JSON.stringify({
        protocol: COCOA_HOST_CONTROL_PROTOCOL,
        requestId: "handshake-1",
        supportedVersions: [COCOA_HOST_CONTROL_PROTOCOL_VERSION],
        client: { name: "cocoa-gateway", version: "test" },
      }),
    );
    await handshakeReceived;

    const responseReceived = receiveJson(client);
    client.send(
      JSON.stringify({
        protocolVersion: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
        requestId: "workspace-open-invalid",
        operation: "workspace.open",
        path: { absolute: "/workspace" },
      }),
    );
    const response = CocoaHostControlErrorResponse.make(
      (await responseReceived) as CocoaHostControlErrorResponseType,
    );
    expect(String(response.requestId)).toBe("workspace-open-invalid");
    expect(response.operation).toBe("workspace.open");
    expect(response.error.code).toBe("invalidRequest");
  });

  test("sends terminal replay and live events on the authenticated control connection", async () => {
    const socketPath = await startUnixEchoServer();
    const generationId = CocoaHostControlGenerationId.make("host:test-runtime");
    const terminalSessionId = CocoaHostControlResourceId.make("terminal:test-runtime");
    let liveListener: Parameters<HostControlRuntime["subscribe"]>[0] | undefined;
    const controlRuntime: HostControlRuntime = {
      generationId,
      platformFamily: "unix",
      platformOs: "darwin",
      capabilities: [],
      dispatch: async (request) => {
        if (request.operation !== "terminal.attach") throw new Error("Unexpected request");
        return {
          response: {
            protocolVersion: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
            requestId: request.requestId,
            operation: "terminal.attach",
            snapshot: {
              generationId,
              sessionId: terminalSessionId,
              cwd: "/workspace",
              status: "running",
              sequence: 1,
              historyBase64: Buffer.from("replay").toString("base64"),
              historyTruncated: false,
              exitCode: null,
              exitSignal: null,
              exitReason: null,
            },
          },
          replayEvents: [
            {
              protocolVersion: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
              event: "terminal.output",
              generationId,
              sessionId: terminalSessionId,
              sequence: 1,
              dataBase64: Buffer.from("replay").toString("base64"),
            },
          ],
        };
      },
      subscribe: (listener) => {
        liveListener = listener;
        return () => {
          liveListener = undefined;
        };
      },
      close: async () => undefined,
    };
    const hostd = startHostd({
      bindHost: "127.0.0.1",
      port: 0,
      socketPath,
      key: "expected-key",
      controlRuntime,
      logger: { info: () => undefined, error: () => undefined },
    });
    trackHostd(hostd);

    const client = await connectAuthorizedWebSocket(hostd, "/control/v1");
    const handshakeReceived = receiveJson(client);
    client.send(
      JSON.stringify({
        protocol: COCOA_HOST_CONTROL_PROTOCOL,
        requestId: "handshake-1",
        supportedVersions: [COCOA_HOST_CONTROL_PROTOCOL_VERSION],
        client: { name: "cocoa-gateway", version: "test" },
      }),
    );
    await handshakeReceived;

    const framesReceived = receiveJsonFrames(client, 2);
    client.send(
      JSON.stringify({
        protocolVersion: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
        requestId: "attach-1",
        operation: "terminal.attach",
        generationId,
        sessionId: terminalSessionId,
        afterSequence: 0,
      }),
    );
    const [replay, response] = await framesReceived;
    expect(replay).toMatchObject({ event: "terminal.output", sequence: 1 });
    expect(response).toMatchObject({ operation: "terminal.attach" });

    const liveReceived = receiveJson(client);
    liveListener?.({
      protocolVersion: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
      event: "terminal.output",
      generationId,
      sessionId: terminalSessionId,
      sequence: 2,
      dataBase64: Buffer.from("live").toString("base64"),
    });
    expect(await liveReceived).toMatchObject({ event: "terminal.output", sequence: 2 });
  });

  test("rejects unsupported control protocol versions with a typed handshake error", async () => {
    const socketPath = await startUnixEchoServer();
    const hostd = startHostd({
      bindHost: "127.0.0.1",
      port: 0,
      socketPath,
      key: "expected-key",
      logger: { info: () => undefined, error: () => undefined },
    });
    trackHostd(hostd);

    const client = await connectAuthorizedWebSocket(hostd, "/control/v1");
    const responseReceived = receiveJson(client);
    client.send(
      JSON.stringify({
        protocol: COCOA_HOST_CONTROL_PROTOCOL,
        requestId: "handshake-unsupported",
        supportedVersions: [3],
        client: { name: "cocoa-gateway", version: "test" },
      }),
    );

    const response = CocoaHostControlHandshakeErrorResponse.make(
      (await responseReceived) as CocoaHostControlHandshakeErrorResponseType,
    );
    expect(String(response.requestId)).toBe("handshake-unsupported");
    expect(response.error.code).toBe("unsupportedProtocol");
    expect(response.error.retryable).toBeFalse();
  });
});
