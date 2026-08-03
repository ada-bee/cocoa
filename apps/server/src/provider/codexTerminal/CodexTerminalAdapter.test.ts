import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";

import {
  ProviderTerminalColumns,
  type ProviderTerminalEvent,
  ProviderTerminalOutputByteLimit,
  ProviderTerminalRows,
} from "../ProviderTerminalAdapter.ts";
import { CodexEndpointConnection } from "../codexEndpoint/CodexEndpointConnection.ts";
import {
  CodexEndpointBorrowUnavailableError,
  type CodexEndpointConnectionBorrow,
} from "../codexEndpoint/CodexEndpointSupervisor.ts";
import {
  CODEX_TERMINAL_MAX_OUTPUT_CHUNK_BYTES,
  CODEX_TERMINAL_START_TIMEOUT,
  type CodexTerminalSandboxMode,
  makeCodexTerminalAdapter,
} from "./CodexTerminalAdapter.ts";
import type { CodexTerminalOutputDelta } from "./CodexTerminalMultiplexer.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex-terminal-test");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type CommandResponse = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
type RecordedRequest = { readonly method: string; readonly payload: Record<string, unknown> };
type NotificationHandler = (
  notification: CodexTerminalOutputDelta,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;

function concat(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function readyFrame(processId: string): Uint8Array {
  return textEncoder.encode(`\u001eCOCOA_TERMINAL_READY:${processId}\u001f`);
}

function makeHarness(sandboxMode: CodexTerminalSandboxMode) {
  return Effect.gen(function* () {
    const commandStarted = yield* Deferred.make<void>();
    const commandResponse = yield* Deferred.make<
      CommandResponse,
      CodexErrors.CodexAppServerError
    >();
    const requests: Array<RecordedRequest> = [];
    let notificationHandler: NotificationHandler | undefined;
    let current = true;
    let currentChecks = 0;

    const request = ((method: string, payload: Record<string, unknown>) =>
      Effect.gen(function* () {
        requests.push({ method, payload });
        if (method === "command/exec") {
          assert.isDefined(notificationHandler);
          yield* Deferred.succeed(commandStarted, undefined);
          return yield* Deferred.await(commandResponse);
        }
        return {};
      })) as CodexClient.CodexAppServerClient["Service"]["request"];
    const handleServerNotification = ((method: string, handler: NotificationHandler) =>
      Effect.sync(() => {
        assert.strictEqual(method, "command/exec/outputDelta");
        notificationHandler = handler;
      })) as CodexClient.CodexAppServerClient["Service"]["handleServerNotification"];
    const client = {
      request,
      handleServerNotification,
    } as CodexClient.CodexAppServerClient["Service"];
    const connection = CodexEndpointConnection.of({
      identity: { providerInstanceId: INSTANCE_ID },
      client,
      compatibility: {
        userAgent: "codex_cli_rs/0.146.0",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    });
    const borrow: CodexEndpointConnectionBorrow = {
      generationId: 7,
      connection,
      ensureCurrent: Effect.suspend(() => {
        currentChecks += 1;
        return current
          ? Effect.void
          : Effect.fail(
              new CodexEndpointBorrowUnavailableError({ providerInstanceId: INSTANCE_ID }),
            );
      }),
    };
    const adapter = yield* makeCodexTerminalAdapter({
      providerInstanceId: INSTANCE_ID,
      sandboxMode,
      borrowConnection: Effect.succeed(borrow),
    });

    return {
      adapter,
      commandStarted: Deferred.await(commandStarted),
      complete: (response: CommandResponse = { exitCode: 0, stdout: "", stderr: "" }) =>
        Deferred.succeed(commandResponse, response).pipe(Effect.asVoid),
      emit: (bytes: Uint8Array, input?: { readonly capReached?: boolean }) => {
        assert.isDefined(notificationHandler);
        const startRequest = requests.find((entry) => entry.method === "command/exec");
        assert.isDefined(startRequest);
        return notificationHandler({
          processId: startRequest.payload.processId as string,
          stream: "stdout",
          deltaBase64: Encoding.encodeBase64(bytes),
          capReached: input?.capReached ?? false,
        });
      },
      emitBase64: (deltaBase64: string) => {
        assert.isDefined(notificationHandler);
        const startRequest = requests.find((entry) => entry.method === "command/exec");
        assert.isDefined(startRequest);
        return notificationHandler({
          processId: startRequest.payload.processId as string,
          stream: "stdout",
          deltaBase64,
          capReached: false,
        });
      },
      getProcessId: () => {
        const startRequest = requests.find((entry) => entry.method === "command/exec");
        assert.isDefined(startRequest);
        return startRequest.payload.processId as string;
      },
      requests,
      setCurrent: (value: boolean) => {
        current = value;
      },
      currentChecks: () => currentChecks,
    };
  });
}

const startInput = (outputByteLimit = 4 * 1024 * 1024) => ({
  cwd: "/srv/project",
  shellArgv: ["/bin/zsh", "-l"] as const,
  cols: ProviderTerminalColumns.make(120),
  rows: ProviderTerminalRows.make(40),
  env: { TERM: "xterm-256color" },
  outputByteLimit: ProviderTerminalOutputByteLimit.make(outputByteLimit),
});

function makeEventCollector() {
  return Effect.gen(function* () {
    const events: Array<ProviderTerminalEvent> = [];
    const exited = yield* Deferred.make<void>();
    return {
      events,
      awaitExit: Deferred.await(exited),
      handler: (event: ProviderTerminalEvent) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "exited"
              ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
    };
  });
}

it.effect(
  "registers before dispatch, strips a split ready frame, rechunks output, and exits once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("workspaceWrite");
        const collected = yield* makeEventCollector();
        const untrustedStartInput = {
          ...startInput(),
          shellArgv: ["/bin/zsh", "-lc", 'printf "%s" "$(client-content)"'] as const,
          sandboxMode: "dangerFullAccess",
          sandboxPolicy: { type: "dangerFullAccess" },
        };
        const opening = yield* harness.adapter
          .start(untrustedStartInput, collected.handler)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* harness.commandStarted;

        const processId = harness.getProcessId();
        const marker = readyFrame(processId);
        const output = new Uint8Array(CODEX_TERMINAL_MAX_OUTPUT_CHUNK_BYTES + 17).fill(65);
        yield* harness.emit(marker.slice(0, 11));
        yield* harness.emit(concat([marker.slice(11), output]));
        yield* Fiber.join(opening);
        yield* harness.complete({ exitCode: 23, stdout: "", stderr: "" });
        yield* collected.awaitExit;

        const startRequest = harness.requests[0]!;
        assert.strictEqual(startRequest.method, "command/exec");
        assert.deepStrictEqual(Object.keys(startRequest.payload).sort(), [
          "command",
          "cwd",
          "disableTimeout",
          "env",
          "outputBytesCap",
          "processId",
          "sandboxPolicy",
          "size",
          "streamStdin",
          "streamStdoutStderr",
          "tty",
        ]);
        assert.deepStrictEqual(startRequest.payload.command, [
          "/bin/sh",
          "-c",
          'printf "\\036COCOA_TERMINAL_READY:%s\\037" "$1"; shift; exec "$@"',
          "cocoa-terminal-bootstrap",
          processId,
          "/bin/zsh",
          "-lc",
          'printf "%s" "$(client-content)"',
        ]);
        assert.deepStrictEqual(startRequest.payload.sandboxPolicy, {
          type: "workspaceWrite",
          writableRoots: ["/srv/project"],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        });
        assert.strictEqual(startRequest.payload.outputBytesCap, 4 * 1024 * 1024);

        const outputEvents = collected.events.filter(
          (event): event is Extract<ProviderTerminalEvent, { readonly type: "output" }> =>
            event.type === "output",
        );
        assert.deepStrictEqual(
          outputEvents.map((event) => event.bytes.byteLength),
          [CODEX_TERMINAL_MAX_OUTPUT_CHUNK_BYTES, 17],
        );
        assert.strictEqual(
          textDecoder.decode(concat(outputEvents.map((event) => event.bytes))),
          "A".repeat(output.byteLength),
        );
        assert.deepStrictEqual(collected.events.at(-1), {
          type: "exited",
          exitCode: 23,
          exitSignal: null,
          reason: "completed",
        });
        assert.strictEqual(collected.events.filter((event) => event.type === "exited").length, 1);
      }),
    ),
);

it.effect("uses danger-full-access only when the adapter factory explicitly selects it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("dangerFullAccess");
      const collected = yield* makeEventCollector();
      const untrustedStartInput = {
        ...startInput(),
        sandboxMode: "workspaceWrite",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/client/chosen"],
          networkAccess: true,
        },
      };
      const opening = yield* harness.adapter
        .start(untrustedStartInput, collected.handler)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* harness.commandStarted;
      yield* harness.emit(readyFrame(harness.getProcessId()));
      yield* Fiber.join(opening);

      assert.deepStrictEqual(harness.requests[0]!.payload.sandboxPolicy, {
        type: "dangerFullAccess",
      });
    }),
  ),
);

it.effect("pins write and resize controls to the captured generation without replay", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("workspaceWrite");
      const collected = yield* makeEventCollector();
      const opening = yield* harness.adapter
        .start(startInput(), collected.handler)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* harness.commandStarted;
      yield* harness.emit(readyFrame(harness.getProcessId()));
      const session = yield* Fiber.join(opening);

      yield* session.write(Uint8Array.from([0, 1, 255]));
      yield* session.resize({
        cols: ProviderTerminalColumns.make(90),
        rows: ProviderTerminalRows.make(30),
      });
      assert.deepStrictEqual(harness.requests.slice(1, 3), [
        {
          method: "command/exec/write",
          payload: {
            processId: harness.getProcessId(),
            deltaBase64: "AAH/",
          },
        },
        {
          method: "command/exec/resize",
          payload: {
            processId: harness.getProcessId(),
            size: { cols: 90, rows: 30 },
          },
        },
      ]);

      harness.setCurrent(false);
      const requestCount = harness.requests.length;
      const error = yield* session.write(Uint8Array.from([7])).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderTerminalDisconnectedError");
      assert.strictEqual(harness.requests.length, requestCount);
      assert.isAtLeast(harness.currentChecks(), 6);
    }),
  ),
);

it.effect("caps cumulative output, terminates remotely, and suppresses late output and exits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("workspaceWrite");
      const collected = yield* makeEventCollector();
      const opening = yield* harness.adapter
        .start(startInput(5), collected.handler)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* harness.commandStarted;
      yield* harness.emit(readyFrame(harness.getProcessId()));
      yield* Fiber.join(opening);

      yield* harness.emit(textEncoder.encode("123456789"));
      yield* collected.awaitExit;
      yield* harness.emit(textEncoder.encode("late"));
      yield* harness.complete();

      assert.deepStrictEqual(collected.events, [
        { type: "output", bytes: textEncoder.encode("12345") },
        {
          type: "exited",
          exitCode: null,
          exitSignal: null,
          reason: "outputLimit",
        },
      ]);
      assert.strictEqual(
        harness.requests.filter((request) => request.method === "command/exec/terminate").length,
        1,
      );
    }),
  ),
);

it.effect("terminates malformed base64 sessions and fails startup without waiting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("workspaceWrite");
      const collected = yield* makeEventCollector();
      const opening = yield* harness.adapter
        .start(startInput(), collected.handler)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* harness.commandStarted;
      yield* harness.emitBase64("%%%not-base64%%%");
      const error = yield* Fiber.join(opening).pipe(Effect.flip);

      assert.strictEqual(error._tag, "ProviderTerminalProtocolError");
      assert.deepStrictEqual(collected.events, [
        { type: "exited", exitCode: null, exitSignal: null, reason: "failed" },
      ]);
      assert.strictEqual(
        harness.requests.filter((request) => request.method === "command/exec/terminate").length,
        1,
      );
    }),
  ),
);

it.effect("treats buffered output in a streaming command response as a protocol failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("workspaceWrite");
      const collected = yield* makeEventCollector();
      const opening = yield* harness.adapter
        .start(startInput(), collected.handler)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* harness.commandStarted;
      yield* harness.emit(readyFrame(harness.getProcessId()));
      yield* Fiber.join(opening);
      yield* harness.complete({ exitCode: 0, stdout: "unexpected", stderr: "" });
      yield* collected.awaitExit;

      assert.deepStrictEqual(collected.events, [
        { type: "exited", exitCode: 0, exitSignal: null, reason: "failed" },
      ]);
    }),
  ),
);

it.effect("uses the test clock for ready timeout and terminates without polling or sleeps", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("workspaceWrite");
      const collected = yield* makeEventCollector();
      const opening = yield* harness.adapter
        .start(startInput(), collected.handler)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* harness.commandStarted;
      yield* TestClock.adjust(CODEX_TERMINAL_START_TIMEOUT);
      const error = yield* Fiber.join(opening).pipe(Effect.flip);

      assert.strictEqual(error._tag, "ProviderTerminalOperationError");
      if (error._tag !== "ProviderTerminalOperationError") return;
      assert.match(error.detail, /did not become ready/i);
      assert.deepStrictEqual(collected.events, [
        { type: "exited", exitCode: null, exitSignal: null, reason: "failed" },
      ]);
      assert.strictEqual(
        harness.requests.filter((request) => request.method === "command/exec/terminate").length,
        1,
      );
    }),
  ),
);

it.effect("scope finalization terminates the exact process and emits one terminal event", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness("workspaceWrite");
    const collected = yield* makeEventCollector();

    yield* Effect.scoped(
      Effect.gen(function* () {
        const opening = yield* harness.adapter
          .start(startInput(), collected.handler)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* harness.commandStarted;
        yield* harness.emit(readyFrame(harness.getProcessId()));
        yield* Fiber.join(opening);
      }),
    );

    assert.strictEqual(
      harness.requests.filter((request) => request.method === "command/exec/terminate").length,
      1,
    );
    assert.deepStrictEqual(collected.events.at(-1), {
      type: "exited",
      exitCode: null,
      exitSignal: null,
      reason: "terminated",
    });
    assert.strictEqual(collected.events.filter((event) => event.type === "exited").length, 1);
  }),
);
