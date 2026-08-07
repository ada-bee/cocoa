/* eslint-disable t3code/no-manual-effect-runtime-in-tests -- cocoa-hostd's standalone Bun test suite exercises the promise-facing control runtime directly. */

import { describe, expect, test } from "bun:test";

import {
  COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES,
  COCOA_HOST_CONTROL_PROTOCOL_VERSION,
  CocoaHostControlGenerationId,
  CocoaHostControlRequestId,
  CocoaHostControlResourceId,
  type CocoaHostControlEvent,
  type CocoaHostTerminalRequest,
} from "@t3tools/contracts";
import type { PtyExitEvent, PtyProcess, PtySpawnInput } from "@t3tools/host-runtime/pty";
import * as Effect from "effect/Effect";

import { HOST_TERMINAL_MAX_REPLAY_EVENTS, makeHostTerminalControlManager } from "./terminal.ts";

type TerminalEvent = Extract<
  CocoaHostControlEvent,
  { readonly event: "terminal.output" | "terminal.exited" }
>;

const generationId = CocoaHostControlGenerationId.make("host:test-generation");
const requestId = (value: string) => CocoaHostControlRequestId.make(value);
const sessionId = CocoaHostControlResourceId.make("terminal:test-session");

class TestPtyProcess implements PtyProcess {
  readonly pid = 1234;
  readonly writes: Array<Uint8Array> = [];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
  readonly kills: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(data: Uint8Array): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.kills.push(signal);
  }

  onData(callback: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  emitData(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    for (const listener of this.dataListeners) listener(bytes);
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

const startRequest = (
  outputByteLimit: number,
): Extract<CocoaHostTerminalRequest, { readonly operation: "terminal.start" }> => ({
  protocolVersion: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
  requestId: requestId("start-1"),
  operation: "terminal.start",
  cwd: "/srv/project",
  shellArgv: ["/bin/zsh", "-l"],
  cols: 120,
  rows: 40,
  env: { TERM: "xterm-256color" },
  outputByteLimit,
});

const sessionRequest = <
  Operation extends "terminal.attach" | "terminal.write" | "terminal.resize" | "terminal.terminate",
>(
  operation: Operation,
  fields: Omit<
    Extract<CocoaHostTerminalRequest, { readonly operation: Operation }>,
    "protocolVersion" | "requestId" | "operation" | "generationId" | "sessionId"
  >,
): Extract<CocoaHostTerminalRequest, { readonly operation: Operation }> =>
  ({
    protocolVersion: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
    requestId: requestId(operation),
    operation,
    generationId,
    sessionId,
    ...fields,
  }) as Extract<CocoaHostTerminalRequest, { readonly operation: Operation }>;

const makeHarness = (options: { readonly maxSessions?: number } = {}) => {
  const process = new TestPtyProcess();
  const events: Array<TerminalEvent> = [];
  const spawnInputs: Array<PtySpawnInput> = [];
  const manager = makeHostTerminalControlManager({
    generationId,
    spawn: (input) => {
      spawnInputs.push(input);
      return Effect.succeed(process);
    },
    emit: (event) => events.push(event),
    environment: { PATH: "/usr/bin" },
    makeSessionId: () => sessionId,
    ...options,
  });
  return { process, events, spawnInputs, manager };
};

describe("host terminal control manager", () => {
  test("starts a pinned PTY and replays only ordered terminal events", async () => {
    const harness = makeHarness();
    const started = await Effect.runPromise(harness.manager.handle(startRequest(200_000)));
    expect(started.response.operation).toBe("terminal.start");
    expect(started.replayEvents).toEqual([]);
    expect(harness.spawnInputs).toEqual([
      {
        shell: "/bin/zsh",
        args: ["-l"],
        cwd: "/srv/project",
        cols: 120,
        rows: 40,
        env: { PATH: "/usr/bin", TERM: "xterm-256color" },
      },
    ]);

    harness.process.emitData("A".repeat(COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES + 17));
    expect(harness.events.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(harness.events.map((event) => event.event)).toEqual([
      "terminal.output",
      "terminal.output",
    ]);

    const attached = await Effect.runPromise(
      harness.manager.handle(sessionRequest("terminal.attach", { afterSequence: 1 })),
    );
    expect(attached.replayEvents.map(({ sequence }) => sequence)).toEqual([2]);
    if (attached.response.operation !== "terminal.attach" || !("snapshot" in attached.response)) {
      throw new Error("Expected terminal attach snapshot");
    }
    expect(attached.response.snapshot.sequence).toBe(2);
    expect(Buffer.from(attached.response.snapshot.historyBase64, "base64").toString()).toBe(
      "A".repeat(COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES + 17),
    );

    harness.process.emitExit({ exitCode: 23, signal: 15 });
    harness.process.emitExit({ exitCode: 99, signal: null });
    expect(harness.events.at(-1)).toMatchObject({
      event: "terminal.exited",
      sequence: 3,
      exitCode: 23,
      exitSignal: 15,
      reason: "completed",
    });
    expect(harness.events.filter(({ event }) => event === "terminal.exited")).toHaveLength(1);
  });

  test("caps cumulative output, terminates once, and ignores late process callbacks", async () => {
    const harness = makeHarness();
    await Effect.runPromise(harness.manager.handle(startRequest(5)));

    harness.process.emitData("123456789");
    harness.process.emitData("late");
    harness.process.emitExit({ exitCode: 0, signal: null });

    expect(harness.events).toHaveLength(2);
    expect(harness.events[0]).toMatchObject({
      event: "terminal.output",
      sequence: 1,
      dataBase64: Buffer.from("12345").toString("base64"),
    });
    expect(harness.events[1]).toMatchObject({
      event: "terminal.exited",
      sequence: 2,
      reason: "outputLimit",
      exitCode: null,
      exitSignal: null,
    });
    expect(harness.process.kills).toEqual([undefined]);

    const attached = await Effect.runPromise(
      harness.manager.handle(sessionRequest("terminal.attach", {})),
    );
    if (attached.response.operation !== "terminal.attach" || !("snapshot" in attached.response)) {
      throw new Error("Expected terminal attach snapshot");
    }
    expect(attached.response.snapshot).toMatchObject({
      status: "exited",
      sequence: 2,
      historyBase64: Buffer.from("12345").toString("base64"),
      historyTruncated: true,
      exitReason: "outputLimit",
    });
  });

  test("allows exactly the output limit and preserves binary terminal writes", async () => {
    const harness = makeHarness();
    await Effect.runPromise(harness.manager.handle(startRequest(5)));

    harness.process.emitData("12345");
    expect(harness.events).toHaveLength(1);
    expect(harness.process.kills).toEqual([]);

    const binary = Uint8Array.from([0, 0xff, 0x41]);
    await Effect.runPromise(
      harness.manager.handle(
        sessionRequest("terminal.write", { dataBase64: Buffer.from(binary).toString("base64") }),
      ),
    );
    expect(harness.process.writes).toEqual([binary]);

    harness.process.emitExit({ exitCode: 0, signal: null });
    expect(harness.events.at(-1)).toMatchObject({
      event: "terminal.exited",
      reason: "completed",
    });
  });

  test("pins mutations to generation and session without retries", async () => {
    const harness = makeHarness();
    await Effect.runPromise(harness.manager.handle(startRequest(1_024)));

    const stale = await Effect.runPromise(
      harness.manager.handle({
        ...sessionRequest("terminal.write", {
          dataBase64: Buffer.from("ignored").toString("base64"),
        }),
        generationId: CocoaHostControlGenerationId.make("host:stale"),
      }),
    );
    expect(stale.response).toMatchObject({ error: { code: "staleHandle" } });
    expect(harness.process.writes).toEqual([]);

    await Effect.runPromise(
      harness.manager.handle(
        sessionRequest("terminal.write", { dataBase64: Buffer.from("hello").toString("base64") }),
      ),
    );
    await Effect.runPromise(
      harness.manager.handle(sessionRequest("terminal.resize", { cols: 90, rows: 30 })),
    );
    await Effect.runPromise(harness.manager.handle(sessionRequest("terminal.terminate", {})));
    await Effect.runPromise(harness.manager.handle(sessionRequest("terminal.terminate", {})));

    expect(harness.process.writes.map((bytes) => Buffer.from(bytes).toString())).toEqual(["hello"]);
    expect(harness.process.resizes).toEqual([{ cols: 90, rows: 30 }]);
    expect(harness.process.kills).toEqual([undefined]);
    expect(harness.events.filter(({ event }) => event === "terminal.exited")).toHaveLength(1);
  });

  test("maps a throwing mutation to one failure without retrying it", async () => {
    const harness = makeHarness();
    await Effect.runPromise(harness.manager.handle(startRequest(1_024)));
    let attempts = 0;
    harness.process.write = () => {
      attempts += 1;
      throw new Error("write failed");
    };

    const result = await Effect.runPromise(
      harness.manager.handle(
        sessionRequest("terminal.write", { dataBase64: Buffer.from("hello").toString("base64") }),
      ),
    );
    expect(result.response).toMatchObject({ error: { code: "operationFailed" } });
    expect(attempts).toBe(1);
  });

  test("bounds retained replay events and falls back to the bounded snapshot on a gap", async () => {
    const harness = makeHarness();
    const outputBytes = HOST_TERMINAL_MAX_REPLAY_EVENTS + 10;
    await Effect.runPromise(harness.manager.handle(startRequest(outputBytes + 1)));
    for (let index = 0; index < outputBytes; index += 1) harness.process.emitData("x");

    const attached = await Effect.runPromise(
      harness.manager.handle(sessionRequest("terminal.attach", { afterSequence: 0 })),
    );
    expect(attached.replayEvents).toEqual([]);
    if (attached.response.operation !== "terminal.attach" || !("snapshot" in attached.response)) {
      throw new Error("Expected terminal attach snapshot");
    }
    expect(attached.response.snapshot.sequence).toBe(outputBytes);
    expect(Buffer.from(attached.response.snapshot.historyBase64, "base64")).toHaveLength(
      outputBytes,
    );

    const warmAttach = await Effect.runPromise(
      harness.manager.handle(sessionRequest("terminal.attach", { afterSequence: outputBytes - 2 })),
    );
    expect(warmAttach.replayEvents.map(({ sequence }) => sequence)).toEqual([
      outputBytes - 1,
      outputBytes,
    ]);
  });

  test("bounds the session table and only reclaims completed sessions", async () => {
    const harness = makeHarness({ maxSessions: 1 });
    await Effect.runPromise(harness.manager.handle(startRequest(1_024)));

    const blocked = await Effect.runPromise(harness.manager.handle(startRequest(1_024)));
    expect(blocked.response).toMatchObject({ error: { code: "limitExceeded" } });
    expect(harness.spawnInputs).toHaveLength(1);

    harness.process.emitExit({ exitCode: 0, signal: null });
    const restarted = await Effect.runPromise(harness.manager.handle(startRequest(1_024)));
    expect(restarted.response.operation).toBe("terminal.start");
    expect(harness.spawnInputs).toHaveLength(2);
    expect(harness.manager.sessionCount()).toBe(1);
  });

  test("closes live sessions once and rejects later controls as disconnected", async () => {
    const harness = makeHarness();
    await Effect.runPromise(harness.manager.handle(startRequest(1_024)));
    harness.manager.close();
    harness.manager.close();

    expect(harness.process.kills).toEqual([undefined]);
    expect(harness.events.filter(({ event }) => event === "terminal.exited")).toEqual([
      expect.objectContaining({ reason: "disconnected", sequence: 1 }),
    ]);
    const afterClose = await Effect.runPromise(
      harness.manager.handle(
        sessionRequest("terminal.write", { dataBase64: Buffer.from("late").toString("base64") }),
      ),
    );
    expect(afterClose.response).toMatchObject({ error: { code: "disconnected" } });
    expect(harness.process.writes).toEqual([]);
  });
});
