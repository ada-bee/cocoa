import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  TerminalNotRunningError,
  type TerminalEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  ProjectTerminalCapabilityUnavailableError,
  type ProjectTerminalError,
  type ProjectTerminalShape,
  type ProjectTerminalStartForThreadInput,
} from "../project/ProjectTerminal.ts";
import {
  ProviderTerminalDisconnectedError,
  ProviderTerminalColumns,
  type ProviderTerminalError,
  type ProviderTerminalEvent,
  type ProviderTerminalEventHandler,
  ProviderTerminalOutputByteLimit,
  ProviderTerminalRows,
  type ProviderTerminalSession,
} from "../provider/ProviderTerminalAdapter.ts";
import { makeProviderTerminalManager } from "./ProviderManager.ts";

const projectId = ProjectId.make("project-a");
const providerInstanceId = ProviderInstanceId.make("provider-a");
const threadId = ThreadId.make("thread-a");
const terminalId = "term-1";

class FakeProviderSession implements ProviderTerminalSession {
  readonly writes: Uint8Array[] = [];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
  terminateCalls = 0;
  writeError: ProviderTerminalError | undefined;

  readonly write: ProviderTerminalSession["write"] = (bytes) => {
    if (this.writeError !== undefined) return Effect.fail(this.writeError);
    return Effect.sync(() => this.writes.push(bytes.slice()));
  };

  readonly resize: ProviderTerminalSession["resize"] = (input) =>
    Effect.sync(() => this.resizes.push(input));

  readonly terminate = Effect.sync(() => {
    this.terminateCalls += 1;
  });
}

interface FakeProjectTerminal {
  readonly service: ProjectTerminalShape;
  readonly starts: Array<ProjectTerminalStartForThreadInput>;
  readonly sessions: Array<FakeProviderSession>;
  readonly emit: (index: number, event: ProviderTerminalEvent) => Effect.Effect<void>;
}

function fakeProjectTerminal(failure?: ProjectTerminalError): FakeProjectTerminal {
  const starts: Array<ProjectTerminalStartForThreadInput> = [];
  const sessions: Array<FakeProviderSession> = [];
  const handlers: Array<ProviderTerminalEventHandler> = [];
  return {
    starts,
    sessions,
    emit: (index, event) => handlers[index]?.(event) ?? Effect.die("missing terminal handler"),
    service: {
      start: () => Effect.die("project-id terminal start must not be used"),
      startForThread: (input, onEvent) => {
        starts.push(input);
        handlers.push(onEvent);
        if (failure !== undefined) return Effect.fail(failure);
        const session = new FakeProviderSession();
        sessions.push(session);
        return Effect.succeed({
          projectId,
          providerInstanceId,
          cwd: "/remote/worktrees/a",
          worktreePath: "/remote/worktrees/a",
          session,
        });
      },
    },
  };
}

const openInput = {
  threadId,
  terminalId,
  cwd: "/gateway/path/that/must/not/be/read",
  worktreePath: "/caller/worktree/that/must/not/be-used",
  cols: 100,
  rows: 30,
  env: { TERM: "xterm-256color" },
} as const;

it.effect("routes by durable thread and keeps ordered bounded in-memory history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fakeProjectTerminal();
      const manager = yield* makeProviderTerminalManager({ projectTerminal: fake.service });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      yield* manager.subscribe((event) => Ref.update(eventsRef, (events) => [...events, event]));

      const opened = yield* manager.open(openInput);
      assert.strictEqual(opened.cwd, "/remote/worktrees/a");
      assert.strictEqual(opened.worktreePath, "/remote/worktrees/a");
      assert.isNull(opened.pid);
      assert.deepStrictEqual(fake.starts[0], {
        threadId,
        shellArgv: ["/bin/sh"],
        cols: ProviderTerminalColumns.make(100),
        rows: ProviderTerminalRows.make(30),
        env: { TERM: "xterm-256color" },
        outputByteLimit: ProviderTerminalOutputByteLimit.make(4 * 1024 * 1024),
      });

      yield* fake.emit(0, { type: "output", bytes: new Uint8Array([0xc3]) });
      yield* fake.emit(0, { type: "output", bytes: new Uint8Array([0xa9]) });
      const giantHistory = `${Array.from({ length: 5_099 }, (_, index) => `line-${index}`).join(
        "\n",
      )}\n${"x".repeat(4 * 1024 * 1024)}`;
      yield* fake.emit(0, {
        type: "output",
        bytes: new TextEncoder().encode(giantHistory),
      });

      const current = yield* manager.open({ ...openInput, cwd: "/another/ignored/path" });
      assert.strictEqual(fake.starts.length, 1);
      assert.isAtMost(new TextEncoder().encode(current.history).byteLength, 4 * 1024 * 1024);
      assert.isAtMost(current.history.split("\n").length, 5_001);
      const output = (yield* Ref.get(eventsRef)).filter((event) => event.type === "output");
      assert.strictEqual(output[0]?.data, "é");
      assert.isTrue(
        output.every(
          (event, index) => index === 0 || event.sequence! > output[index - 1]!.sequence!,
        ),
      );
    }),
  ),
);

it.effect("sanitizes replay history across chunks while preserving live provider output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fakeProjectTerminal();
      const manager = yield* makeProviderTerminalManager({ projectTerminal: fake.service });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      yield* manager.subscribe((event) => Ref.update(eventsRef, (events) => [...events, event]));
      yield* manager.open(openInput);

      const outputChunks = [
        "prompt ",
        "\u001b[?2026$",
        "p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u",
        "\u001b[6n\u001b[1;1R\u001b[>0c\u009b?31u",
        "\u001bP$q ",
        "m\u001b\\\u001bP1$r0m\u001b\\",
        "\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\",
        "\u0090$q m\u009c\u00901$r0m\u009c",
        "\u0090+q544e",
        "\u009c\u001b]11;rgb:ffff/ffff/ffff\u0007",
        // These setters share final bytes with query families but change
        // replayable terminal state and must remain in history.
        '\u001b[!p\u001b["p\u001b[4 q\u001b[u',
        "\u001b[32mdone\u001b[0m\n",
      ] as const;
      for (const chunk of outputChunks) {
        yield* fake.emit(0, { type: "output", bytes: new TextEncoder().encode(chunk) });
      }

      const current = yield* manager.open(openInput);
      assert.strictEqual(
        current.history,
        'prompt \u001b[!p\u001b["p\u001b[4 q\u001b[u\u001b[32mdone\u001b[0m\n',
      );
      const liveOutput = (yield* Ref.get(eventsRef))
        .filter(
          (event): event is Extract<TerminalEvent, { type: "output" }> => event.type === "output",
        )
        .map((event) => event.data)
        .join("");
      assert.strictEqual(liveOutput, outputChunks.join(""));
    }),
  ),
);

it.effect("sanitizes the decoder flush before completing a provider session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fakeProjectTerminal();
      const manager = yield* makeProviderTerminalManager({ projectTerminal: fake.service });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      yield* manager.subscribe((event) => Ref.update(eventsRef, (events) => [...events, event]));
      yield* manager.open(openInput);

      yield* fake.emit(0, {
        type: "output",
        bytes: new TextEncoder().encode("before "),
      });
      // An incomplete UTF-8 scalar is buffered by the streaming decoder. Its
      // replacement character is produced only by the exit-time decoder flush.
      yield* fake.emit(0, { type: "output", bytes: new Uint8Array([0xc3]) });
      yield* fake.emit(0, {
        type: "exited",
        exitCode: 0,
        exitSignal: null,
        reason: "completed",
      });

      const current = yield* manager.open(openInput);
      assert.strictEqual(current.history, "before �");
      const liveOutput = (yield* Ref.get(eventsRef))
        .filter(
          (event): event is Extract<TerminalEvent, { type: "output" }> => event.type === "output",
        )
        .map((event) => event.data)
        .join("");
      assert.strictEqual(liveOutput, "before �");
    }),
  ),
);

it.effect("does not replay disconnected sessions and permits only explicit restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fakeProjectTerminal();
      const manager = yield* makeProviderTerminalManager({ projectTerminal: fake.service });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      yield* manager.subscribe((event) => Ref.update(eventsRef, (events) => [...events, event]));
      yield* manager.open(openInput);
      yield* fake.emit(0, {
        type: "exited",
        exitCode: null,
        exitSignal: null,
        reason: "disconnected",
      });

      const reopened = yield* manager.open(openInput);
      assert.strictEqual(reopened.status, "exited");
      assert.strictEqual(fake.starts.length, 1);
      const writeError = yield* manager
        .write({ threadId, terminalId, data: "must-not-replay" })
        .pipe(Effect.flip);
      assert.instanceOf(writeError, TerminalNotRunningError);

      const attached = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* manager.attachStream({ threadId, terminalId, restartIfNotRunning: true }, (event) =>
        Ref.update(attached, (events) => [...events, event.type]),
      );
      assert.strictEqual(fake.starts.length, 2);
      assert.deepStrictEqual(yield* Ref.get(attached), ["snapshot"]);
      assert.deepStrictEqual(
        (yield* Ref.get(eventsRef)).slice(-3).map((event) => event.type),
        ["error", "exited", "restarted"],
      );
    }),
  ),
);

it.effect("routes write, resize, close, and ignores late events from detached sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fakeProjectTerminal();
      const manager = yield* makeProviderTerminalManager({ projectTerminal: fake.service });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      yield* manager.subscribe((event) => Ref.update(eventsRef, (events) => [...events, event]));
      yield* manager.open(openInput);
      yield* manager.write({ threadId, terminalId, data: "hello" });
      yield* manager.resize({ threadId, terminalId, cols: 140, rows: 50 });
      yield* manager.close({ threadId, terminalId });
      yield* fake.emit(0, { type: "output", bytes: new TextEncoder().encode("late") });

      assert.strictEqual(new TextDecoder().decode(fake.sessions[0]!.writes[0]), "hello");
      assert.deepStrictEqual(fake.sessions[0]!.resizes, [{ cols: 140, rows: 50 }]);
      assert.strictEqual(fake.sessions[0]!.terminateCalls, 1);
      assert.deepStrictEqual(
        (yield* Ref.get(eventsRef)).map((event) => event.type),
        ["started", "closed"],
      );
    }),
  ),
);

it.effect("fails closed with a sanitized typed error when provider terminals are unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fakeProjectTerminal(
        new ProjectTerminalCapabilityUnavailableError({ projectId, providerInstanceId }),
      );
      const manager = yield* makeProviderTerminalManager({ projectTerminal: fake.service });
      const error = yield* manager.open(openInput).pipe(Effect.flip);
      assert.strictEqual(error._tag, "TerminalProviderError");
      if (error._tag === "TerminalProviderError") {
        assert.strictEqual(error.operation, "open");
        assert.strictEqual(error.reason, "unsupported");
        assert.notInclude(error.message, openInput.cwd);
      }
    }),
  ),
);

it.effect("maps provider write disconnection without exposing a synthetic pid", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fakeProjectTerminal();
      const manager = yield* makeProviderTerminalManager({ projectTerminal: fake.service });
      yield* manager.open(openInput);
      fake.sessions[0]!.writeError = new ProviderTerminalDisconnectedError({
        providerInstanceId,
        operation: "write",
      });
      const error = yield* manager.write({ threadId, terminalId, data: "hello" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "TerminalProviderError");
      if (error._tag === "TerminalProviderError") {
        assert.strictEqual(error.reason, "disconnected");
        assert.isFalse("terminalPid" in error);
      }
    }),
  ),
);

it.effect("terminates exact live sessions when the manager scope closes", () =>
  Effect.gen(function* () {
    const fake = fakeProjectTerminal();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* makeProviderTerminalManager({ projectTerminal: fake.service });
        yield* manager.open(openInput);
      }),
    );
    assert.strictEqual(fake.sessions[0]?.terminateCalls, 1);
  }),
);
