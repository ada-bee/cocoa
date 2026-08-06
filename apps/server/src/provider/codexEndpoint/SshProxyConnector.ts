// @effect-diagnostics nodeBuiltinImport:off
import * as NodeStream from "node:stream";

import { CODEX_SSH_PROXY_REMOTE_COMMAND, type CodexSshProxyTransport } from "@t3tools/contracts";
import * as NodeSink from "@effect/platform-node-shared/NodeSink";
import * as EffectNodeStream from "@effect/platform-node-shared/NodeStream";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { CodexEndpointFramedTransport } from "./DirectWebSocketConnector.ts";
import {
  type CodexSshProxyWebSocketHandshakeFailure,
  makeSshProxyWebSocketFramedTransport,
} from "./SshProxyWebSocketFraming.ts";

export const SSH_PROXY_WEBSOCKET_URL = "ws://localhost/";
export const SSH_PROXY_BRIDGE_HIGH_WATER_MARK = 64 * 1_024;
export const SSH_PROXY_STDERR_DIAGNOSTIC_LIMIT = 4_096;

export class CodexSshProxySpawnError extends Schema.TaggedErrorClass<CodexSshProxySpawnError>()(
  "CodexSshProxySpawnError",
  {
    command: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to spawn the SSH helper for a Codex proxy endpoint.";
  }
}

export class CodexSshProxyHandshakeError extends Schema.TaggedErrorClass<CodexSshProxyHandshakeError>()(
  "CodexSshProxyHandshakeError",
  {
    cause: Schema.Defect(),
    diagnostics: Schema.optionalKey(Schema.String),
    httpStatus: Schema.optionalKey(Schema.Int),
  },
) {
  override get message(): string {
    return "The Codex SSH proxy did not complete its WebSocket handshake.";
  }
}

export class CodexSshProxyProcessExitedError extends Schema.TaggedErrorClass<CodexSshProxyProcessExitedError>()(
  "CodexSshProxyProcessExitedError",
  {
    exitCode: Schema.Int,
    diagnostics: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return `The Codex SSH proxy exited with code ${this.exitCode}.`;
  }
}

export class CodexSshProxyProcessStatusError extends Schema.TaggedErrorClass<CodexSshProxyProcessStatusError>()(
  "CodexSshProxyProcessStatusError",
  {
    cause: Schema.Defect(),
    diagnostics: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return "Failed to read the Codex SSH proxy process status.";
  }
}

export class CodexSshProxyStdoutError extends Schema.TaggedErrorClass<CodexSshProxyStdoutError>()(
  "CodexSshProxyStdoutError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to read the Codex SSH proxy byte stream.";
  }
}

export class CodexSshProxyBridgeError extends Schema.TaggedErrorClass<CodexSshProxyBridgeError>()(
  "CodexSshProxyBridgeError",
  {
    operation: Schema.Literals(["write-stdin", "read-stdout"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The Codex SSH proxy stream bridge failed while attempting to ${this.operation}.`;
  }
}

export type CodexSshProxyConnectorError =
  | CodexSshProxySpawnError
  | CodexSshProxyHandshakeError
  | CodexSshProxyProcessExitedError
  | CodexSshProxyProcessStatusError;

const isCodexSshProxyBridgeError = Schema.is(CodexSshProxyBridgeError);

const destination = (transport: CodexSshProxyTransport): string =>
  transport.user === undefined ? transport.host : `${transport.user}@${transport.host}`;

/** Builds argv without a shell or any caller-controlled remote command. */
export function buildSshProxyArgs(transport: CodexSshProxyTransport): ReadonlyArray<string> {
  const options = transport.options;
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    ...(transport.port === undefined ? [] : ["-p", String(transport.port)]),
    ...(options?.identityFile === undefined ? [] : ["-i", options.identityFile]),
    ...(options?.connectTimeoutSeconds === undefined
      ? []
      : ["-o", `ConnectTimeout=${options.connectTimeoutSeconds}`]),
    ...(options?.serverAliveIntervalSeconds === undefined
      ? []
      : ["-o", `ServerAliveInterval=${options.serverAliveIntervalSeconds}`]),
    ...(options?.serverAliveCountMax === undefined
      ? []
      : ["-o", `ServerAliveCountMax=${options.serverAliveCountMax}`]),
    ...(options?.strictHostKeyChecking === undefined
      ? []
      : ["-o", `StrictHostKeyChecking=${options.strictHostKeyChecking}`]),
    "--",
    destination(transport),
    ...CODEX_SSH_PROXY_REMOTE_COMMAND,
  ];
}

const redactDiagnostics = (value: string): string =>
  value
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(token|password|secret|credential)\b(\s*[:=]\s*)\S+/giu, "$1$2[redacted]")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
      "[redacted private key]",
    );

interface StderrDiagnostics {
  readonly append: (bytes: Uint8Array) => void;
  readonly finish: () => void;
  readonly read: () => string | undefined;
}

const makeStderrDiagnostics = (): StderrDiagnostics => {
  const decoder = new TextDecoder();
  let captured = "";
  const appendText = (text: string) => {
    if (captured.length >= SSH_PROXY_STDERR_DIAGNOSTIC_LIMIT) return;
    captured += text.slice(0, SSH_PROXY_STDERR_DIAGNOSTIC_LIMIT - captured.length);
  };
  return {
    append: (bytes) => appendText(decoder.decode(bytes, { stream: true })),
    finish: () => appendText(decoder.decode()),
    read: () => {
      const sanitized = redactDiagnostics(captured).trim();
      return sanitized.length === 0 ? undefined : sanitized;
    },
  };
};

const stopChild = (child: ChildProcessSpawner.ChildProcessHandle) =>
  child.isRunning.pipe(
    Effect.flatMap((running) => (running ? child.kill() : Effect.void)),
    Effect.catch(() => Effect.void),
  );

const asTransportError = (cause: unknown) =>
  new CodexErrors.CodexAppServerTransportError({
    operation: "read-input-stream",
    cause,
  });

/**
 * Node streams treat an `error` event with no listener as an uncaught exception.
 *
 * The Effect stream adapters still observe and propagate these errors through
 * their own listeners. This listener is only a lifetime guard for teardown
 * races where an adapter removes its listener before `destroy(error)` emits on
 * the next turn of the Node event loop.
 */
const guardDuplexErrorLifecycle = (duplex: NodeStream.Duplex): void => {
  const handleError = () => {};
  const handleClose = () => {
    duplex.off("error", handleError);
    duplex.off("close", handleClose);
  };
  duplex.on("error", handleError);
  duplex.on("close", handleClose);
};

export const makeSshProxyConnector = Effect.fn("CodexEndpoint.makeSshProxyConnector")(function* (
  transport: CodexSshProxyTransport,
): Effect.fn.Return<
  CodexEndpointFramedTransport,
  CodexSshProxyConnectorError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> {
  const [webSocketSide, sshSide] = NodeStream.duplexPair({
    allowHalfOpen: false,
    readableHighWaterMark: SSH_PROXY_BRIDGE_HIGH_WATER_MARK,
    writableHighWaterMark: SSH_PROXY_BRIDGE_HIGH_WATER_MARK,
  });
  guardDuplexErrorLifecycle(webSocketSide);
  guardDuplexErrorLifecycle(sshSide);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      webSocketSide.destroy();
      sshSide.destroy();
    }),
  );

  const args = buildSshProxyArgs(transport);
  const command = ChildProcess.make("ssh", args, {
    shell: false,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: "5 seconds",
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* Effect.acquireRelease(
    spawner.spawn(command).pipe(
      Effect.mapError(
        (cause) =>
          new CodexSshProxySpawnError({
            command: ["ssh", ...args],
            cause,
          }),
      ),
    ),
    stopChild,
  );

  const diagnostics = makeStderrDiagnostics();
  const diagnosticFields = () => {
    const value = diagnostics.read();
    return value === undefined ? {} : { diagnostics: value };
  };
  const stderrFiber = yield* child.stderr.pipe(
    Stream.runForEach((bytes) => Effect.sync(() => diagnostics.append(bytes))),
    Effect.ensuring(Effect.sync(() => diagnostics.finish())),
    Effect.catch(() => Effect.void),
    Effect.forkScoped,
  );

  let connectionFailure:
    | CodexSshProxyBridgeError
    | CodexSshProxyProcessExitedError
    | CodexSshProxyProcessStatusError
    | CodexSshProxyStdoutError
    | undefined;
  const recordConnectionFailure = (failure: NonNullable<typeof connectionFailure>) => {
    connectionFailure ??= failure;
  };
  const processExit = yield* Deferred.make<
    CodexSshProxyProcessExitedError | CodexSshProxyProcessStatusError
  >();

  yield* Stream.run(
    child.stdout,
    NodeSink.fromWritable({
      evaluate: () => sshSide,
      endOnDone: false,
      onError: (cause) => new CodexSshProxyBridgeError({ operation: "read-stdout", cause }),
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.sync(() => {
        const failure = isCodexSshProxyBridgeError(cause)
          ? cause
          : new CodexSshProxyStdoutError({ cause });
        recordConnectionFailure(failure);
        webSocketSide.destroy(failure);
        sshSide.destroy(failure);
      }),
    ),
    Effect.forkScoped,
  );

  yield* EffectNodeStream.fromReadable<Uint8Array, CodexSshProxyBridgeError>({
    evaluate: () => sshSide,
    closeOnDone: false,
    onError: (cause) => new CodexSshProxyBridgeError({ operation: "write-stdin", cause }),
  }).pipe(
    Stream.run(child.stdin),
    Effect.catch((cause) =>
      Effect.sync(() => {
        const failure = isCodexSshProxyBridgeError(cause)
          ? cause
          : new CodexSshProxyBridgeError({ operation: "write-stdin", cause });
        recordConnectionFailure(failure);
        webSocketSide.destroy(failure);
        sshSide.destroy(failure);
      }),
    ),
    Effect.forkScoped,
  );

  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.gen(function* () {
          yield* Fiber.join(stderrFiber);
          const failure = new CodexSshProxyProcessStatusError({
            cause,
            ...diagnosticFields(),
          });
          recordConnectionFailure(failure);
          Deferred.doneUnsafe(processExit, Effect.succeed(failure));
          webSocketSide.destroy(failure);
          sshSide.destroy(failure);
        }),
      onSuccess: (exitCode) =>
        Effect.gen(function* () {
          yield* Fiber.join(stderrFiber);
          const failure = new CodexSshProxyProcessExitedError({
            exitCode,
            ...diagnosticFields(),
          });
          recordConnectionFailure(failure);
          Deferred.doneUnsafe(processExit, Effect.succeed(failure));
          webSocketSide.destroy(failure);
          sshSide.destroy(failure);
        }),
    }),
    Effect.forkScoped,
  );

  const framed = yield* Effect.raceFirst(
    makeSshProxyWebSocketFramedTransport(webSocketSide).pipe(
      Effect.mapError(
        (cause: CodexSshProxyWebSocketHandshakeFailure) =>
          new CodexSshProxyHandshakeError({
            cause,
            ...diagnosticFields(),
            ...(cause.httpStatus === undefined ? {} : { httpStatus: cause.httpStatus }),
          }),
      ),
    ),
    Deferred.await(processExit).pipe(Effect.flatMap((failure) => Effect.fail(failure))),
  );

  const currentTransportError = (fallback: CodexErrors.CodexAppServerError) =>
    connectionFailure === undefined ? fallback : asTransportError(connectionFailure);

  return {
    incoming: framed.incoming.pipe(Stream.mapError(currentTransportError)),
    outgoing: (frames) => framed.outgoing(frames).pipe(Effect.mapError(currentTransportError)),
    terminationError: framed.terminationError.pipe(Effect.map(currentTransportError)),
  };
});
