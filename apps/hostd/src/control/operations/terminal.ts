/**
 * Generation-pinned terminal session policy for the host control protocol.
 *
 * The PTY adapter owns process mechanics. This manager owns bounded output,
 * replayable terminal events, session handles, and the exactly-once exit edge.
 */
import {
  COCOA_HOST_CONTROL_MAX_TERMINAL_OUTPUT_BYTES,
  COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES,
  CocoaHostControlResourceId,
  type CocoaHostControlErrorResponse,
  type CocoaHostControlEvent,
  type CocoaHostControlGenerationId,
  type CocoaHostControlProtocolVersion,
  type CocoaHostTerminalExitReason,
  type CocoaHostTerminalRequest,
  type CocoaHostTerminalResponse,
} from "@t3tools/contracts";
import type {
  PtyAdapter,
  PtyExitEvent,
  PtyProcess,
  PtySpawnInput,
} from "@t3tools/host-runtime/pty";
import * as Effect from "effect/Effect";

export const HOST_TERMINAL_DEFAULT_MAX_SESSIONS = 32;
export const HOST_TERMINAL_MAX_REPLAY_EVENTS = 1_024;

type TerminalEvent = Extract<
  CocoaHostControlEvent,
  { readonly event: "terminal.output" | "terminal.exited" }
>;
type TerminalControlResponse = CocoaHostTerminalResponse | CocoaHostControlErrorResponse;
type SessionRequest = Exclude<CocoaHostTerminalRequest, { readonly operation: "terminal.start" }>;

export interface HostTerminalControlDispatch {
  readonly response: TerminalControlResponse;
  /** Ordered output/exit catch-up only. Mutation requests are never replayed. */
  readonly replayEvents: ReadonlyArray<TerminalEvent>;
}

export interface HostTerminalControlOptions {
  readonly generationId: CocoaHostControlGenerationId;
  readonly spawn: PtyAdapter["Service"]["spawn"];
  readonly emit: (event: TerminalEvent) => void;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeSessionId?: () => CocoaHostControlResourceId;
  readonly maxSessions?: number;
  readonly maxOutputBytes?: number;
}

export interface HostTerminalControlManager {
  readonly generationId: CocoaHostControlGenerationId;
  readonly handle: (
    request: CocoaHostTerminalRequest,
  ) => Effect.Effect<HostTerminalControlDispatch>;
  /** Ends every live process without reconnecting or retrying a mutation. */
  readonly close: () => void;
  readonly sessionCount: () => number;
}

interface TerminalSession {
  readonly protocolVersion: CocoaHostControlProtocolVersion;
  readonly id: CocoaHostControlResourceId;
  readonly cwd: string;
  readonly outputByteLimit: number;
  readonly process: PtyProcess;
  readonly history: Array<Uint8Array>;
  readonly events: Array<TerminalEvent>;
  historyBytes: number;
  historyTruncated: boolean;
  sequence: number;
  finished: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  exitReason: CocoaHostTerminalExitReason | null;
  removeDataListener: () => void;
  removeExitListener: () => void;
}

const responseBase = <Request extends CocoaHostTerminalRequest>(
  request: Request,
): Pick<Request, "protocolVersion" | "requestId" | "operation"> =>
  ({
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    operation: request.operation,
  }) as Pick<Request, "protocolVersion" | "requestId" | "operation">;

const controlError = (
  request: CocoaHostTerminalRequest,
  code: CocoaHostControlErrorResponse["error"]["code"],
  message: string,
): CocoaHostControlErrorResponse => ({
  ...responseBase(request),
  error: { code, message, retryable: false },
});

const emptyDispatch = (response: TerminalControlResponse): HostTerminalControlDispatch => ({
  response,
  replayEvents: [],
});

const sessionSnapshot = (generationId: CocoaHostControlGenerationId, session: TerminalSession) => ({
  generationId,
  sessionId: session.id,
  cwd: session.cwd,
  status: session.finished ? ("exited" as const) : ("running" as const),
  sequence: session.sequence,
  historyBase64: Buffer.concat(session.history, session.historyBytes).toString("base64"),
  historyTruncated: session.historyTruncated,
  exitCode: session.exitCode,
  exitSignal: session.exitSignal,
  exitReason: session.exitReason,
});

const makeSpawnInput = (
  request: Extract<CocoaHostTerminalRequest, { readonly operation: "terminal.start" }>,
  environment: NodeJS.ProcessEnv,
): PtySpawnInput => ({
  shell: request.shellArgv[0],
  args: request.shellArgv.slice(1),
  cwd: request.cwd,
  cols: request.cols,
  rows: request.rows,
  env: { ...environment, ...request.env },
});

export const makeHostTerminalControlManager = (
  options: HostTerminalControlOptions,
): HostTerminalControlManager => {
  const sessions = new Map<string, TerminalSession>();
  let pendingStarts = 0;
  let closed = false;
  const maxSessions = Math.max(1, options.maxSessions ?? HOST_TERMINAL_DEFAULT_MAX_SESSIONS);
  const maxOutputBytes = Math.min(
    options.maxOutputBytes ?? COCOA_HOST_CONTROL_MAX_TERMINAL_OUTPUT_BYTES,
    COCOA_HOST_CONTROL_MAX_TERMINAL_OUTPUT_BYTES,
  );
  const environment = options.environment ?? process.env;
  const makeSessionId =
    options.makeSessionId ??
    (() => CocoaHostControlResourceId.make(`terminal:${Bun.randomUUIDv7()}`));

  const emit = (session: TerminalSession, event: TerminalEvent): void => {
    session.events.push(event);
    if (session.events.length > HOST_TERMINAL_MAX_REPLAY_EVENTS) session.events.shift();
    try {
      options.emit(event);
    } catch {
      // Transport loss must not break process accounting or cause an event retry.
    }
  };

  const finish = (
    session: TerminalSession,
    reason: CocoaHostTerminalExitReason,
    exitCode: number | null,
    exitSignal: number | null,
    terminateProcess: boolean,
  ): void => {
    if (session.finished) return;
    session.finished = true;
    session.exitCode = exitCode;
    session.exitSignal = exitSignal;
    session.exitReason = reason;
    session.sequence += 1;
    emit(session, {
      protocolVersion: session.protocolVersion,
      event: "terminal.exited",
      generationId: options.generationId,
      sessionId: session.id,
      sequence: session.sequence,
      exitCode,
      exitSignal,
      reason,
    });
    session.removeDataListener();
    session.removeExitListener();
    if (terminateProcess) {
      try {
        session.process.kill();
      } catch {
        // Exit was already made authoritative; never synthesize a second edge.
      }
    }
  };

  const acceptOutput = (session: TerminalSession, data: Uint8Array): void => {
    if (session.finished || data.byteLength === 0) return;
    const bytes = Buffer.from(data);
    const remaining = session.outputByteLimit - session.historyBytes;
    const acceptedLength = Math.max(0, Math.min(remaining, bytes.byteLength));

    let historyOffset = 0;
    const previousHistory = session.history.at(-1);
    if (
      previousHistory !== undefined &&
      previousHistory.byteLength < COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES
    ) {
      const fillLength = Math.min(
        acceptedLength,
        COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES - previousHistory.byteLength,
      );
      if (fillLength > 0) {
        session.history[session.history.length - 1] = Buffer.concat([
          previousHistory,
          bytes.subarray(0, fillLength),
        ]);
        historyOffset = fillLength;
      }
    }
    while (historyOffset < acceptedLength) {
      const historyEnd = Math.min(
        acceptedLength,
        historyOffset + COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES,
      );
      session.history.push(Uint8Array.from(bytes.subarray(historyOffset, historyEnd)));
      historyOffset = historyEnd;
    }
    session.historyBytes += acceptedLength;

    for (
      let offset = 0;
      offset < acceptedLength;
      offset += COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES
    ) {
      const end = Math.min(acceptedLength, offset + COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES);
      const chunk = Uint8Array.from(bytes.subarray(offset, end));
      session.sequence += 1;
      emit(session, {
        protocolVersion: session.protocolVersion,
        event: "terminal.output",
        generationId: options.generationId,
        sessionId: session.id,
        sequence: session.sequence,
        dataBase64: Buffer.from(chunk).toString("base64"),
      });
    }

    if (acceptedLength < bytes.byteLength) {
      session.historyTruncated = true;
      finish(session, "outputLimit", null, null, true);
    }
  };

  const onProcessExit = (session: TerminalSession, event: PtyExitEvent): void => {
    finish(session, "completed", event.exitCode, event.signal, false);
  };

  const pruneExitedSession = (): boolean => {
    for (const [sessionId, session] of sessions) {
      if (!session.finished) continue;
      sessions.delete(sessionId);
      return true;
    }
    return false;
  };

  const resolveSession = (
    request: SessionRequest,
  ): TerminalSession | CocoaHostControlErrorResponse => {
    if (request.generationId !== options.generationId) {
      return controlError(
        request,
        "staleHandle",
        "Terminal handle belongs to a stale host generation.",
      );
    }
    return (
      sessions.get(request.sessionId) ??
      controlError(request, "notFound", "Terminal session was not found on this host.")
    );
  };

  const handle = Effect.fn("HostTerminalControl.handle")(function* (
    request: CocoaHostTerminalRequest,
  ): Effect.fn.Return<HostTerminalControlDispatch> {
    if (closed) {
      return emptyDispatch(
        controlError(request, "disconnected", "The host terminal runtime is shutting down."),
      );
    }
    if (request.operation === "terminal.start") {
      while (sessions.size + pendingStarts >= maxSessions && pruneExitedSession()) {
        // Keep pruning exited history until the bounded session table has room.
      }
      if (sessions.size + pendingStarts >= maxSessions) {
        return emptyDispatch(
          controlError(request, "limitExceeded", "The host terminal session limit was reached."),
        );
      }

      pendingStarts += 1;
      const processResult = yield* options.spawn(makeSpawnInput(request, environment)).pipe(
        Effect.result,
        Effect.ensuring(
          Effect.sync(() => {
            pendingStarts -= 1;
          }),
        ),
      );
      if (processResult._tag === "Failure") {
        return emptyDispatch(
          controlError(
            request,
            "operationFailed",
            "The host could not start the terminal process.",
          ),
        );
      }

      if (closed) {
        yield* Effect.try({
          try: () => processResult.success.kill(),
          catch: () => "terminalShutdownCleanupFailed" as const,
        }).pipe(Effect.ignore);
        return emptyDispatch(
          controlError(request, "disconnected", "The host terminal runtime is shutting down."),
        );
      }

      const allocatedSessionId = makeSessionId();
      if (sessions.has(allocatedSessionId)) {
        yield* Effect.try({
          try: () => processResult.success.kill(),
          catch: () => "terminalCollisionCleanupFailed" as const,
        }).pipe(Effect.ignore);
        return emptyDispatch(
          controlError(request, "operationFailed", "The host allocated a duplicate terminal id."),
        );
      }
      const session: TerminalSession = {
        protocolVersion: request.protocolVersion,
        id: allocatedSessionId,
        cwd: request.cwd,
        outputByteLimit: Math.min(request.outputByteLimit, maxOutputBytes),
        process: processResult.success,
        history: [],
        events: [],
        historyBytes: 0,
        historyTruncated: false,
        sequence: 0,
        finished: false,
        exitCode: null,
        exitSignal: null,
        exitReason: null,
        removeDataListener: () => undefined,
        removeExitListener: () => undefined,
      };
      sessions.set(session.id, session);
      session.removeDataListener = session.process.onData((data) => acceptOutput(session, data));
      session.removeExitListener = session.process.onExit((event) => onProcessExit(session, event));
      if (session.finished) {
        session.removeDataListener();
        session.removeExitListener();
      }
      return emptyDispatch({
        ...responseBase(request),
        snapshot: sessionSnapshot(options.generationId, session),
      });
    }

    const resolved = resolveSession(request);
    if (!("process" in resolved)) return emptyDispatch(resolved);
    const session = resolved;

    switch (request.operation) {
      case "terminal.attach": {
        const snapshot = sessionSnapshot(options.generationId, session);
        const oldestRetainedSequence = session.events[0]?.sequence;
        const afterSequence = request.afterSequence;
        const canReplay =
          afterSequence !== undefined &&
          afterSequence <= snapshot.sequence &&
          (oldestRetainedSequence === undefined || afterSequence >= oldestRetainedSequence - 1);
        const replayEvents =
          afterSequence !== undefined && canReplay
            ? session.events.filter(({ sequence }) => sequence > afterSequence)
            : [];
        return {
          response: { ...responseBase(request), snapshot },
          replayEvents,
        };
      }
      case "terminal.write": {
        if (session.finished) {
          return emptyDispatch(
            controlError(request, "operationFailed", "The terminal session has already exited."),
          );
        }
        const writeResult = yield* Effect.try({
          try: () => session.process.write(Buffer.from(request.dataBase64, "base64")),
          catch: () => "terminalWriteFailed" as const,
        }).pipe(Effect.result);
        return emptyDispatch(
          writeResult._tag === "Success"
            ? { ...responseBase(request) }
            : controlError(request, "operationFailed", "The host terminal write failed."),
        );
      }
      case "terminal.resize": {
        if (session.finished) {
          return emptyDispatch(
            controlError(request, "operationFailed", "The terminal session has already exited."),
          );
        }
        const resizeResult = yield* Effect.try({
          try: () => session.process.resize(request.cols, request.rows),
          catch: () => "terminalResizeFailed" as const,
        }).pipe(Effect.result);
        return emptyDispatch(
          resizeResult._tag === "Success"
            ? { ...responseBase(request) }
            : controlError(request, "operationFailed", "The host terminal resize failed."),
        );
      }
      case "terminal.terminate":
        finish(session, "terminated", null, null, true);
        return emptyDispatch({ ...responseBase(request) });
    }
  });

  return {
    generationId: options.generationId,
    handle,
    close: () => {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) {
        finish(session, "disconnected", null, null, true);
      }
    },
    sessionCount: () => sessions.size,
  };
};
