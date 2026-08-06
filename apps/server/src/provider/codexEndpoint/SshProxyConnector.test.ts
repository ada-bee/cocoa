// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { CodexSshProxyTransport } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildSshProxyArgs, makeSshProxyConnector } from "./SshProxyConnector.ts";

it("builds the exact noninteractive command for the rigatoni-alfredo SSH alias", () => {
  const transport = {
    type: "ssh-proxy",
    host: "rigatoni-alfredo",
  } satisfies CodexSshProxyTransport;

  expect(buildSshProxyArgs(transport)).toEqual([
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "--",
    "rigatoni-alfredo",
    "codex",
    "app-server",
    "proxy",
  ]);
});

it("renders only structured OpenSSH options for the MacBook Air address", () => {
  const transport = {
    type: "ssh-proxy",
    host: "192.168.20.99",
    port: 22,
    options: {
      identityFile: "/run/secrets/macbook-codex-key",
      connectTimeoutSeconds: 15,
      serverAliveIntervalSeconds: 30,
      serverAliveCountMax: 3,
      strictHostKeyChecking: "accept-new",
    },
  } satisfies CodexSshProxyTransport;

  expect(buildSshProxyArgs(transport)).toEqual([
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-p",
    "22",
    "-i",
    "/run/secrets/macbook-codex-key",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "--",
    "192.168.20.99",
    "codex",
    "app-server",
    "proxy",
  ]);
});

type StandardCommand = Extract<ChildProcess.Command, { readonly _tag: "StandardCommand" }>;

const serverTextFrame = (payload: string): Buffer => {
  const body = Buffer.from(payload);
  if (body.length >= 126) throw new Error("Test payload is too large");
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
};

const parseClientFrame = (
  buffer: Buffer,
): { readonly consumed: number; readonly opcode: number; readonly payload: string } | undefined => {
  if (buffer.length < 6) return undefined;
  const opcode = buffer[0]! & 0x0f;
  const encodedLength = buffer[1]! & 0x7f;
  if (encodedLength >= 126) throw new Error("Test client frame is too large");
  const masked = (buffer[1]! & 0x80) !== 0;
  const headerLength = masked ? 6 : 2;
  if (buffer.length < headerLength + encodedLength) return undefined;
  const body = Buffer.from(buffer.subarray(headerLength, headerLength + encodedLength));
  if (masked) {
    const mask = buffer.subarray(2, 6);
    for (let index = 0; index < body.length; index += 1) {
      body[index] = body[index]! ^ mask[index % 4]!;
    }
  }
  return {
    consumed: headerLength + encodedLength,
    opcode,
    payload: body.toString(),
  };
};

interface ProxyHarnessOptions {
  readonly completeHandshake?: boolean;
}

const makeProxyHarness = Effect.fn("test.makeProxyHarness")(function* (
  stderr = "",
  options: ProxyHarnessOptions = {},
) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const handshakeStarted = yield* Deferred.make<void>();
  const receivedFrames: string[] = [];
  let capturedCommand: StandardCommand | undefined;
  let running = true;
  let killCount = 0;
  let input = Buffer.alloc(0);
  let handshakeRequest = "";
  let upgraded = false;

  const consumeInput = (bytes: Uint8Array): void => {
    input = Buffer.concat([input, Buffer.from(bytes)]);
    if (!upgraded) {
      const headerEnd = input.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      handshakeRequest = input.subarray(0, headerEnd + 4).toString();
      input = input.subarray(headerEnd + 4);
      Deferred.doneUnsafe(handshakeStarted, Effect.void);
      if (options.completeHandshake === false) return;
      const key = /^sec-websocket-key:\s*(.+)$/imu.exec(handshakeRequest)?.[1]?.trim();
      if (!key) throw new Error("Missing Sec-WebSocket-Key in test handshake");
      const accept = NodeCrypto.createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      Queue.offerUnsafe(
        stdout,
        Buffer.from(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        ),
      );
      upgraded = true;
    }

    while (input.length > 0) {
      const frame = parseClientFrame(input);
      if (!frame) return;
      input = input.subarray(frame.consumed);
      if (frame.opcode === 1) {
        receivedFrames.push(frame.payload);
        Queue.offerUnsafe(stdout, serverTextFrame(`reply:${frame.payload}`));
      } else if (frame.opcode === 8) {
        Queue.offerUnsafe(stdout, Buffer.from([0x88, 0]));
      }
    }
  };

  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(7_001),
    exitCode: Deferred.await(exitCode),
    isRunning: Effect.sync(() => running),
    kill: () =>
      Effect.sync(() => {
        killCount += 1;
        running = false;
        Deferred.doneUnsafe(exitCode, Effect.succeed(ChildProcessSpawner.ExitCode(143)));
      }),
    stdin: Sink.forEach((bytes: Uint8Array) => Effect.sync(() => consumeInput(bytes))),
    stdout: Stream.fromQueue(stdout),
    stderr: stderr.length === 0 ? Stream.empty : Stream.encodeText(Stream.make(stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand") throw new Error("Expected a standard command");
      capturedCommand = command;
      return handle;
    }),
  );

  return {
    spawner,
    receivedFrames,
    get capturedCommand() {
      return capturedCommand;
    },
    get handshakeRequest() {
      return handshakeRequest;
    },
    get killCount() {
      return killCount;
    },
    handshakeStarted: Deferred.await(handshakeStarted),
    exit: (code: number) => {
      running = false;
      Deferred.doneUnsafe(exitCode, Effect.succeed(ChildProcessSpawner.ExitCode(code)));
    },
  };
});

const transport = {
  type: "ssh-proxy",
  host: "rigatoni-alfredo",
} satisfies CodexSshProxyTransport;

const dependencies = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Layer.merge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    FileSystem.layerNoop({}),
  );

it.effect("performs the HTTP upgrade and exchanges framed WebSocket messages", () =>
  Effect.gen(function* () {
    const harness = yield* makeProxyHarness();
    yield* Effect.gen(function* () {
      const connection = yield* makeSshProxyConnector(transport);
      yield* connection.outgoing(Stream.make('{"id":1}'));
      const response = yield* Stream.runHead(connection.incoming);

      expect(Option.getOrUndefined(response)).toBe('reply:{"id":1}');
      expect(harness.receivedFrames).toEqual(['{"id":1}']);
      expect(harness.handshakeRequest).toContain("GET / HTTP/1.1");
      expect(harness.handshakeRequest).toContain("Host: localhost");
      expect(harness.capturedCommand?.command).toBe("ssh");
      expect(harness.capturedCommand?.options.shell).toBe(false);
      expect(harness.capturedCommand?.options.stdin).toBe("pipe");
    }).pipe(Effect.scoped, Effect.provide(dependencies(harness.spawner)));
  }),
);

it.effect("surfaces process exit with bounded redacted stderr diagnostics", () =>
  Effect.gen(function* () {
    const harness = yield* makeProxyHarness("auth failed: Bearer do-not-leak-this");
    yield* Effect.gen(function* () {
      const connection = yield* makeSshProxyConnector(transport);
      const failedRead = yield* Stream.runHead(connection.incoming).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      harness.exit(23);

      const error = yield* Fiber.join(failedRead).pipe(Effect.timeout("1 second"));
      expect(error._tag).toBe("CodexAppServerTransportError");
      const processError = error.cause as {
        readonly _tag?: string;
        readonly exitCode?: number;
        readonly diagnostics?: string;
      };
      expect(processError._tag).toBe("CodexSshProxyProcessExitedError");
      expect(processError.exitCode).toBe(23);
      expect(processError.diagnostics).toContain("Bearer [redacted]");
      expect(processError.diagnostics).not.toContain("do-not-leak-this");
    }).pipe(Effect.scoped, Effect.provide(dependencies(harness.spawner)));
  }),
);

it.effect("surfaces process exit while the WebSocket handshake bridge is active", () =>
  Effect.gen(function* () {
    const harness = yield* makeProxyHarness("ssh: connect failed", {
      completeHandshake: false,
    });
    yield* Effect.gen(function* () {
      const opening = yield* makeSshProxyConnector(transport).pipe(Effect.flip, Effect.forkChild);
      yield* harness.handshakeStarted.pipe(Effect.timeout("1 second"));
      harness.exit(255);

      const error = yield* Fiber.join(opening).pipe(Effect.timeout("1 second"));
      expect(error._tag).toBe("CodexSshProxyProcessExitedError");
      if (error._tag !== "CodexSshProxyProcessExitedError") return;
      expect(error.exitCode).toBe(255);
      expect(error.diagnostics).toContain("ssh: connect failed");

      // `Duplex.destroy(error)` emits asynchronously. Drain the Node event
      // loop so this test also proves bridge teardown has no unhandled stream
      // error after the typed connector failure has been observed.
      yield* Effect.promise(() => new Promise<void>((resolve) => globalThis.setImmediate(resolve)));
    }).pipe(Effect.scoped, Effect.provide(dependencies(harness.spawner)));
  }),
);

it.effect("kills only the captured SSH child when the connector scope closes", () =>
  Effect.gen(function* () {
    const harness = yield* makeProxyHarness();
    yield* makeSshProxyConnector(transport).pipe(
      Effect.scoped,
      Effect.provide(dependencies(harness.spawner)),
    );

    expect(harness.killCount).toBe(1);
  }),
);
