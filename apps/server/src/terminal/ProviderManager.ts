/**
 * Provider-routed implementation of the public terminal manager contract.
 *
 * Durable thread ownership selects the provider and provider-host cwd. Public
 * cwd/worktree fields remain compatibility inputs only and are never inspected
 * on the gateway host.
 */
import {
  TerminalNotRunningError,
  TerminalProviderError,
  TerminalSessionLookupError,
  ThreadId,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalProviderFailureReason,
  type TerminalProviderOperation,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import type {
  ProjectTerminalError,
  ProjectTerminalResolvedSession,
  ProjectTerminalShape,
} from "../project/ProjectTerminal.ts";
import {
  PROVIDER_TERMINAL_MAX_OUTPUT_BYTES,
  ProviderTerminalColumns,
  type ProviderTerminalEvent,
  ProviderTerminalOutputByteLimit,
  ProviderTerminalRows,
  type ProviderTerminalSession,
} from "../provider/ProviderTerminalAdapter.ts";
import type { TerminalManager } from "./TerminalManagerService.ts";
import { sanitizeTerminalHistoryChunk } from "./TerminalHistorySanitizer.ts";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_HISTORY_BYTE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const PROVIDER_SHELL_ARGV = ["/bin/sh"] as const;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface ProviderSessionState {
  readonly threadId: string;
  readonly terminalId: string;
  readonly eventLock: Semaphore.Semaphore;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  cols: number;
  rows: number;
  runtimeEnv: Readonly<Record<string, string>> | undefined;
  providerSession: ProviderTerminalSession | null;
  providerScope: Scope.Closeable | null;
  providerContext: ProjectTerminalResolvedSession | null;
  launchId: number;
  acceptingEvents: boolean;
  pendingEvents: Array<ProviderTerminalEvent>;
  decoder: TextDecoder;
  pendingHistoryControlSequence: string;
}

interface ProviderManagerState {
  readonly sessions: Map<string, ProviderSessionState>;
}

export interface MakeProviderTerminalManagerOptions {
  readonly projectTerminal: ProjectTerminalShape;
  readonly historyLineLimit?: number;
}

function sessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const trailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (trailingNewline) lines.pop();
  const lineCapped =
    lines.length <= maxLines
      ? history
      : `${lines.slice(lines.length - maxLines).join("\n")}${trailingNewline ? "\n" : ""}`;
  const bytes = new TextEncoder().encode(lineCapped);
  if (bytes.byteLength <= DEFAULT_HISTORY_BYTE_LIMIT) return lineCapped;
  let start = bytes.byteLength - DEFAULT_HISTORY_BYTE_LIMIT;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.slice(start));
}

function normalizedEnv(
  env: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (env === undefined || Object.keys(env).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(env).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshot(session: ProviderSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: null,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: getTerminalLabel(session.terminalId),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
  };
}

function summary(session: ProviderSessionState): TerminalSummary {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: null,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: false,
    label: getTerminalLabel(session.terminalId),
    updatedAt: session.updatedAt,
  };
}

function failureReason(error: ProjectTerminalError): TerminalProviderFailureReason {
  switch (error._tag) {
    case "ProjectTerminalProjectNotFoundError":
    case "ProjectTerminalThreadNotFoundError":
    case "ProjectTerminalProviderNotFoundError":
      return "notFound";
    case "ProjectTerminalProviderUnavailableError":
      return "disabled";
    case "ProjectTerminalCapabilityUnavailableError":
    case "ProviderTerminalUnsupportedError":
      return "unsupported";
    case "ProviderTerminalDisconnectedError":
      return "disconnected";
    case "ProviderTerminalCwdError":
      return "invalidCwd";
    case "ProviderTerminalProtocolError":
      return "protocol";
    case "ProjectTerminalThreadProjectMismatchError":
    case "ProjectTerminalResolveOperationError":
    case "ProviderTerminalOperationError":
      return "failed";
  }
}

function providerError(input: {
  readonly session: Pick<ProviderSessionState, "threadId" | "terminalId">;
  readonly operation: TerminalProviderOperation;
  readonly error: ProjectTerminalError;
}): TerminalProviderError {
  return new TerminalProviderError({
    threadId: input.session.threadId,
    terminalId: input.session.terminalId,
    operation: input.operation,
    reason: failureReason(input.error),
  });
}

function providerExitMessage(reason: ProviderTerminalEvent & { readonly type: "exited" }): string {
  switch (reason.reason) {
    case "disconnected":
      return "Provider terminal disconnected.";
    case "outputLimit":
      return "Provider terminal output limit was reached.";
    case "failed":
      return "Provider terminal failed.";
    case "completed":
    case "terminated":
      return "Provider terminal exited.";
  }
}

function attachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return { type: "snapshot", snapshot: event.snapshot };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

export const makeProviderTerminalManager = Effect.fn("TerminalManager.makeProvider")(function* (
  options: MakeProviderTerminalManagerOptions,
): Effect.fn.Return<TerminalManager["Service"], never, Scope.Scope> {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;

  const stateRef = yield* SynchronizedRef.make<ProviderManagerState>({ sessions: new Map() });
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();

  const publish = Effect.fn("terminal.provider.publish")(function* (event: TerminalEvent) {
    for (const listener of listeners) {
      yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
    }
  });

  const getThreadLock = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (locks) => {
      const existing = locks.get(threadId);
      if (existing !== undefined) return Effect.succeed([existing, locks] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => {
          const next = new Map(locks);
          next.set(threadId, lock);
          return [lock, next] as const;
        }),
      );
    });

  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));

  const getSession = (threadId: string, terminalId: string) =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.map((state) =>
        Option.fromNullishOr(state.sessions.get(sessionKey(threadId, terminalId))),
      ),
    );

  const putSession = (session: ProviderSessionState) =>
    SynchronizedRef.update(stateRef, (state) => {
      const sessions = new Map(state.sessions);
      sessions.set(sessionKey(session.threadId, session.terminalId), session);
      return { sessions };
    });

  const removeSession = (threadId: string, terminalId: string) =>
    SynchronizedRef.modify(stateRef, (state) => {
      const key = sessionKey(threadId, terminalId);
      const existing = state.sessions.get(key);
      if (existing === undefined) return [undefined, state] as const;
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [existing, { sessions }] as const;
    });

  const advance = (session: ProviderSessionState) => {
    session.eventSequence += 1;
    session.updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
    return session.eventSequence;
  };

  const emitOutputLocked = Effect.fn("terminal.provider.emitOutputLocked")(function* (
    session: ProviderSessionState,
    data: string,
  ) {
    if (data.length === 0) return;
    const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, data);
    session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
    if (sanitized.visibleText.length > 0) {
      session.history = capHistory(`${session.history}${sanitized.visibleText}`, historyLineLimit);
    }
    const sequence = advance(session);
    yield* publish({
      type: "output",
      threadId: session.threadId,
      terminalId: session.terminalId,
      sequence,
      data,
    });
  });

  const handleProviderEventLocked = Effect.fn("terminal.provider.handleProviderEventLocked")(
    function* (session: ProviderSessionState, launchId: number, event: ProviderTerminalEvent) {
      if (session.launchId !== launchId) return;
      if (!session.acceptingEvents) {
        session.pendingEvents.push(event);
        return;
      }
      if (event.type === "output") {
        yield* emitOutputLocked(session, session.decoder.decode(event.bytes, { stream: true }));
        return;
      }

      yield* emitOutputLocked(session, session.decoder.decode());
      session.pendingHistoryControlSequence = "";
      session.acceptingEvents = false;
      session.status = "exited";
      session.exitCode = event.exitCode;
      session.exitSignal = event.exitSignal;
      session.providerSession = null;
      session.providerContext = null;
      const scope = session.providerScope;
      session.providerScope = null;
      if (
        event.reason === "disconnected" ||
        event.reason === "outputLimit" ||
        event.reason === "failed"
      ) {
        yield* publish({
          type: "error",
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: advance(session),
          message: providerExitMessage(event),
        });
      }
      yield* publish({
        type: "exited",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: advance(session),
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
      });
      if (scope !== null) {
        runFork(Scope.close(scope, Exit.void).pipe(Effect.ignore));
      }
    },
  );

  const stopProviderSession = Effect.fn("terminal.provider.stopSession")(function* (
    session: ProviderSessionState,
  ) {
    const detached = yield* session.eventLock.withPermit(
      Effect.sync(() => {
        session.launchId += 1;
        session.acceptingEvents = false;
        session.pendingEvents = [];
        const providerSession = session.providerSession;
        const providerScope = session.providerScope;
        session.providerSession = null;
        session.providerScope = null;
        session.providerContext = null;
        session.status = "exited";
        session.exitCode = null;
        session.exitSignal = null;
        session.decoder = new TextDecoder();
        session.pendingHistoryControlSequence = "";
        advance(session);
        return { providerSession, providerScope };
      }),
    );
    const termination: Effect.Effect<void, ProjectTerminalError> =
      detached.providerSession === null ? Effect.void : detached.providerSession.terminate;
    const result = yield* Effect.result(termination);
    if (detached.providerScope !== null) {
      yield* Scope.close(detached.providerScope, Exit.void).pipe(Effect.ignore);
    }
    return result;
  });

  const startSession = Effect.fn("terminal.provider.startSession")(function* (
    session: ProviderSessionState,
    eventType: "started" | "restarted",
    operation: "open" | "restart",
  ): Effect.fn.Return<void, TerminalProviderError> {
    const launchId = session.launchId + 1;
    session.launchId = launchId;
    session.status = "starting";
    session.exitCode = null;
    session.exitSignal = null;
    session.acceptingEvents = false;
    session.pendingEvents = [];
    session.decoder = new TextDecoder();
    session.pendingHistoryControlSequence = "";
    session.updatedAt = yield* nowIso;
    const providerScope = yield* Scope.make("sequential");

    const onEvent = (event: ProviderTerminalEvent) =>
      session.eventLock.withPermit(handleProviderEventLocked(session, launchId, event));
    const started = yield* options.projectTerminal
      .startForThread(
        {
          threadId: ThreadId.make(session.threadId),
          shellArgv: PROVIDER_SHELL_ARGV,
          cols: ProviderTerminalColumns.make(session.cols),
          rows: ProviderTerminalRows.make(session.rows),
          ...(session.runtimeEnv === undefined ? {} : { env: session.runtimeEnv }),
          outputByteLimit: ProviderTerminalOutputByteLimit.make(PROVIDER_TERMINAL_MAX_OUTPUT_BYTES),
        },
        onEvent,
      )
      .pipe(Effect.provideService(Scope.Scope, providerScope), Effect.result);

    if (started._tag === "Failure") {
      session.launchId += 1;
      session.acceptingEvents = false;
      session.pendingEvents = [];
      session.status = "error";
      session.updatedAt = yield* nowIso;
      yield* Scope.close(providerScope, Exit.void).pipe(Effect.ignore);
      const error = providerError({ session, operation, error: started.failure });
      yield* publish({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: advance(session),
        message: error.message,
      });
      return yield* error;
    }

    yield* session.eventLock.withPermit(
      Effect.gen(function* () {
        session.providerSession = started.success.session;
        session.providerScope = providerScope;
        session.providerContext = started.success;
        session.cwd = started.success.cwd;
        session.worktreePath = started.success.worktreePath;
        session.status = "running";
        session.acceptingEvents = true;
        const pending = session.pendingEvents;
        session.pendingEvents = [];
        yield* publish({
          type: eventType,
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: advance(session),
          snapshot: snapshot(session),
        });
        for (const event of pending) {
          yield* handleProviderEventLocked(session, launchId, event);
        }
      }),
    );
    yield* increment(terminalSessionsTotal, { lifecycle: eventType });
  });

  const newSession = Effect.fn("terminal.provider.newSession")(function* (
    input: TerminalOpenInput,
  ) {
    return {
      threadId: input.threadId,
      terminalId: input.terminalId,
      eventLock: yield* Semaphore.make(1),
      cwd: "<provider-host>",
      worktreePath: null,
      status: "starting" as const,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: yield* nowIso,
      eventSequence: 0,
      cols: input.cols ?? DEFAULT_OPEN_COLS,
      rows: input.rows ?? DEFAULT_OPEN_ROWS,
      runtimeEnv: normalizedEnv(input.env),
      providerSession: null,
      providerScope: null,
      providerContext: null,
      launchId: 0,
      acceptingEvents: false,
      pendingEvents: [],
      decoder: new TextDecoder(),
      pendingHistoryControlSequence: "",
    } satisfies ProviderSessionState;
  });

  const resizeSession = Effect.fn("terminal.provider.resizeSession")(function* (
    session: ProviderSessionState,
    cols: number,
    rows: number,
  ): Effect.fn.Return<void, TerminalProviderError> {
    if (session.providerSession === null || session.status !== "running") return;
    const result = yield* session.providerSession
      .resize({ cols: ProviderTerminalColumns.make(cols), rows: ProviderTerminalRows.make(rows) })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      return yield* providerError({ session, operation: "resize", error: result.failure });
    }
    session.cols = cols;
    session.rows = rows;
    session.updatedAt = yield* nowIso;
  });

  const openLocked = Effect.fn("terminal.provider.openLocked")(function* (
    input: TerminalOpenInput,
  ): Effect.fn.Return<TerminalSessionSnapshot, TerminalError> {
    const existing = yield* getSession(input.threadId, input.terminalId);
    if (Option.isSome(existing)) {
      const session = existing.value;
      const cols = input.cols ?? session.cols;
      const rows = input.rows ?? session.rows;
      if (session.status === "running" && (cols !== session.cols || rows !== session.rows)) {
        yield* resizeSession(session, cols, rows);
      }
      return snapshot(session);
    }

    const session = yield* newSession(input);
    yield* putSession(session);
    const started = yield* Effect.result(startSession(session, "started", "open"));
    if (started._tag === "Failure") {
      yield* removeSession(session.threadId, session.terminalId);
      return yield* started.failure;
    }
    return snapshot(session);
  });

  const open: TerminalManager["Service"]["open"] = (input) =>
    withThreadLock(input.threadId, openLocked(input));

  const openOrAttach = (input: TerminalAttachInput) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const existing = yield* getSession(input.threadId, input.terminalId);
        if (Option.isNone(existing)) {
          if (input.cwd === undefined && input.restartIfNotRunning !== true) {
            return yield* new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId: input.terminalId,
            });
          }
          return yield* openLocked({ ...input, cwd: input.cwd ?? "<provider-host>" });
        }
        const session = existing.value;
        if (session.status !== "running" && input.restartIfNotRunning === true) {
          session.history = "";
          session.runtimeEnv = normalizedEnv(input.env);
          session.cols = input.cols ?? session.cols;
          session.rows = input.rows ?? session.rows;
          yield* startSession(session, "restarted", "restart");
        } else if (session.status === "running") {
          yield* resizeSession(session, input.cols ?? session.cols, input.rows ?? session.rows);
        }
        return snapshot(session);
      }),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });

  const attachStream: TerminalManager["Service"]["attachStream"] = (input, listener) => {
    let unsubscribe: (() => void) | null = null;
    return Effect.gen(function* () {
      const buffered: TerminalEvent[] = [];
      let live = false;
      unsubscribe = yield* subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }
        if (!live) {
          buffered.push(event);
          return Effect.void;
        }
        const converted = attachEvent(event);
        return converted === null ? Effect.void : listener(converted);
      });
      const initial = yield* openOrAttach(input);
      yield* listener({ type: "snapshot", snapshot: initial });
      for (const event of buffered) {
        if (event.sequence !== undefined && event.sequence <= (initial.sequence ?? 0)) continue;
        const converted = attachEvent(event);
        if (converted !== null) yield* listener(converted);
      }
      live = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => unsubscribe?.()).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );
  };

  const write: TerminalManager["Service"]["write"] = Effect.fn("terminal.provider.write")(
    function* (input) {
      const found = yield* getSession(input.threadId, input.terminalId);
      if (Option.isNone(found)) {
        return yield* new TerminalSessionLookupError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        });
      }
      const session = found.value;
      if (session.providerSession === null || session.status !== "running") {
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        });
      }
      const result = yield* session.providerSession
        .write(new TextEncoder().encode(input.data))
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        return yield* providerError({ session, operation: "write", error: result.failure });
      }
    },
  );

  const resize: TerminalManager["Service"]["resize"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const found = yield* getSession(input.threadId, input.terminalId);
        if (Option.isNone(found)) return;
        yield* resizeSession(found.value, input.cols, input.rows);
      }),
    );

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const found = yield* getSession(input.threadId, input.terminalId);
        if (Option.isNone(found)) {
          return yield* new TerminalSessionLookupError({
            threadId: input.threadId,
            terminalId: input.terminalId,
          });
        }
        const session = found.value;
        session.history = "";
        session.pendingHistoryControlSequence = "";
        yield* publish({
          type: "cleared",
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: advance(session),
        });
      }),
    );

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        yield* increment(terminalRestartsTotal, { scope: "thread" });
        const existing = yield* getSession(input.threadId, input.terminalId);
        const session = Option.isSome(existing)
          ? existing.value
          : yield* newSession({ ...input, cwd: input.cwd });
        if (Option.isNone(existing)) yield* putSession(session);
        else yield* stopProviderSession(session);
        session.history = "";
        session.runtimeEnv = normalizedEnv(input.env);
        session.cols = input.cols;
        session.rows = input.rows;
        yield* startSession(session, "restarted", "restart");
        return snapshot(session);
      }),
    );

  const closeOne = Effect.fn("terminal.provider.closeOne")(function* (
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ): Effect.fn.Return<void, TerminalError> {
    const session = yield* removeSession(threadId, terminalId);
    if (session === undefined) return;
    const termination = yield* stopProviderSession(session);
    if (deleteHistory) session.history = "";
    yield* publish({
      type: "closed",
      threadId,
      terminalId,
      sequence: session.eventSequence + 1,
    });
    if (termination._tag === "Failure") {
      return yield* providerError({ session, operation: "close", error: termination.failure });
    }
  });

  const close: TerminalManager["Service"]["close"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.terminalId !== undefined) {
          return yield* closeOne(input.threadId, input.terminalId, input.deleteHistory === true);
        }
        const state = yield* SynchronizedRef.get(stateRef);
        const sessions = [...state.sessions.values()].filter(
          (session) => session.threadId === input.threadId,
        );
        const results = yield* Effect.forEach(sessions, (session) =>
          Effect.result(closeOne(input.threadId, session.terminalId, false)),
        );
        for (const result of results) {
          if (result._tag === "Failure") return yield* result.failure;
        }
      }),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;
    const offer = (event: TerminalEvent): Effect.Effect<void> => {
      if (event.type === "output" || event.type === "cleared") return Effect.void;
      if (event.type === "closed") {
        return listener({
          type: "remove",
          threadId: event.threadId,
          terminalId: event.terminalId,
        });
      }
      return getSession(event.threadId, event.terminalId).pipe(
        Effect.flatMap((session) =>
          Option.isSome(session)
            ? listener({ type: "upsert", terminal: summary(session.value) })
            : Effect.void,
        ),
      );
    };
    return Effect.gen(function* () {
      const buffered: TerminalEvent[] = [];
      let live = false;
      unsubscribe = yield* subscribe((event) => {
        if (!live) {
          buffered.push(event);
          return Effect.void;
        }
        return offer(event);
      });
      const state = yield* SynchronizedRef.get(stateRef);
      yield* listener({
        type: "snapshot",
        terminals: [...state.sessions.values()]
          .map(summary)
          .toSorted(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          ),
      });
      for (const event of buffered) yield* offer(event);
      live = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => unsubscribe?.()).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* SynchronizedRef.modify(stateRef, (state) => [
        [...state.sessions.values()],
        { sessions: new Map() },
      ]);
      yield* Effect.forEach(sessions, stopProviderSession, {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  return {
    open,
    attachStream,
    write,
    resize,
    clear,
    restart,
    close,
    subscribe,
    subscribeMetadata,
  };
});
