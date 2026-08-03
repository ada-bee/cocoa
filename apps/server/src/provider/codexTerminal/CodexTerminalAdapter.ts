/**
 * Codex `command/exec` implementation of the provider terminal capability.
 *
 * Each session captures one connection generation. Its endpoint-global
 * process id is registered before dispatch, and every later control targets
 * only that captured connection without reconnect, retry, or input replay.
 *
 * @module provider/codexTerminal/CodexTerminalAdapter
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  type ProviderTerminalAdapter,
  ProviderTerminalDisconnectedError,
  type ProviderTerminalError,
  type ProviderTerminalExitReason,
  ProviderTerminalOperationError,
  ProviderTerminalProtocolError,
  type ProviderTerminalSession,
  type ProviderTerminalStartInput,
  ProviderTerminalUnsupportedError,
} from "../ProviderTerminalAdapter.ts";
import type {
  CodexEndpointBorrowUnavailableError,
  CodexEndpointConnectionBorrow,
} from "../codexEndpoint/CodexEndpointSupervisor.ts";
import {
  type CodexTerminalMultiplexer,
  type CodexTerminalOutputDelta,
  makeCodexTerminalMultiplexer,
} from "./CodexTerminalMultiplexer.ts";

export const CODEX_TERMINAL_START_TIMEOUT = "10 seconds" as const;
export const CODEX_TERMINAL_CLEANUP_TIMEOUT = "2 seconds" as const;
export const CODEX_TERMINAL_MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;

const READY_FRAME_PREFIX = "\u001eCOCOA_TERMINAL_READY:";
const READY_FRAME_SUFFIX = "\u001f";
const textEncoder = new TextEncoder();

export interface MakeCodexTerminalAdapterOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly borrowConnection: Effect.Effect<
    CodexEndpointConnectionBorrow,
    CodexEndpointBorrowUnavailableError
  >;
}

interface SessionState {
  deliveredBytes: number;
  exitIntent: ProviderTerminalExitReason | undefined;
  finished: boolean;
  markerTail: Uint8Array;
  ready: boolean;
}

const disconnected = (
  providerInstanceId: ProviderInstanceId,
  operation: "start" | "write" | "resize" | "terminate",
) => new ProviderTerminalDisconnectedError({ providerInstanceId, operation });

const protocol = (
  providerInstanceId: ProviderInstanceId,
  operation: "start" | "write" | "resize" | "terminate",
  detail: string,
) => new ProviderTerminalProtocolError({ providerInstanceId, operation, detail });

const operationFailed = (
  providerInstanceId: ProviderInstanceId,
  operation: "start" | "write" | "resize" | "terminate",
  detail: string,
) => new ProviderTerminalOperationError({ providerInstanceId, operation, detail });

const isDisconnectedCodexError = (error: CodexErrors.CodexAppServerError): boolean =>
  error._tag === "CodexAppServerTransportError" ||
  error._tag === "CodexAppServerInputStreamEndedError" ||
  error._tag === "CodexAppServerProcessExitedError";

function mapCodexError(
  providerInstanceId: ProviderInstanceId,
  operation: "start" | "write" | "resize" | "terminate",
  error: CodexErrors.CodexAppServerError,
): ProviderTerminalError {
  if (isDisconnectedCodexError(error)) return disconnected(providerInstanceId, operation);
  if (error._tag === "CodexAppServerRequestError" && error.code === -32601) {
    return new ProviderTerminalUnsupportedError({ providerInstanceId, operation });
  }
  if (
    error._tag === "CodexAppServerProtocolParseError" ||
    (error._tag === "CodexAppServerRequestError" && [-32700, -32600, -32602].includes(error.code))
  ) {
    return protocol(providerInstanceId, operation, "Codex rejected the terminal protocol.");
  }
  return operationFailed(providerInstanceId, operation, "Codex terminal request failed.");
}

function mapCapturedConnectionError(
  providerInstanceId: ProviderInstanceId,
  operation: "start" | "write" | "resize" | "terminate",
  error: CodexErrors.CodexAppServerError | CodexEndpointBorrowUnavailableError,
): ProviderTerminalError {
  return error._tag === "CodexEndpointBorrowUnavailableError"
    ? disconnected(providerInstanceId, operation)
    : mapCodexError(providerInstanceId, operation, error);
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0) return 0;
  outer: for (let index = 0; index <= haystack.byteLength - needle.byteLength; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left.slice();
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function makeReadyFrame(processId: string): Uint8Array {
  return textEncoder.encode(`${READY_FRAME_PREFIX}${processId}${READY_FRAME_SUFFIX}`);
}

function makeCommand(input: ProviderTerminalStartInput, processId: string): ReadonlyArray<string> {
  return [
    "sh",
    "-c",
    'printf "\\036COCOA_TERMINAL_READY:%s\\037" "$1"; shift; exec "$@"',
    "cocoa-terminal-bootstrap",
    processId,
    ...input.shellArgv,
  ];
}

export const makeCodexTerminalAdapter = Effect.fn("CodexTerminalAdapter.make")(function* (
  options: MakeCodexTerminalAdapterOptions,
): Effect.fn.Return<ProviderTerminalAdapter> {
  const multiplexerLock = yield* Semaphore.make(1);
  const multiplexers = new WeakMap<object, CodexTerminalMultiplexer>();
  let nextProcessSequence = 1;

  const getMultiplexer = (
    client: CodexClient.CodexAppServerClient["Service"],
  ): Effect.Effect<CodexTerminalMultiplexer> =>
    multiplexerLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = multiplexers.get(client);
        if (existing !== undefined) return existing;
        const created = yield* makeCodexTerminalMultiplexer(client);
        multiplexers.set(client, created);
        return created;
      }),
    );

  const start: ProviderTerminalAdapter["start"] = Effect.fn("CodexTerminalAdapter.start")(
    function* (input, onEvent) {
      const parentScope = yield* Effect.scope;
      const borrowed = yield* options.borrowConnection.pipe(
        Effect.mapError(() => disconnected(options.providerInstanceId, "start")),
      );
      if (borrowed.connection.compatibility.platformFamily !== "unix") {
        return yield* new ProviderTerminalUnsupportedError({
          providerInstanceId: options.providerInstanceId,
          operation: "start",
        });
      }
      const multiplexer = yield* getMultiplexer(borrowed.connection.client);
      const processId = `cocoa-terminal:${options.providerInstanceId}:${borrowed.generationId}:${nextProcessSequence++}`;
      const readyFrame = makeReadyFrame(processId);

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const sessionScope = yield* Scope.make("sequential");
          const acquire = Effect.gen(function* () {
            const ready = yield* Deferred.make<void, ProviderTerminalError>();
            const sessionLock = yield* Semaphore.make(1);
            const state: SessionState = {
              deliveredBytes: 0,
              exitIntent: undefined,
              finished: false,
              markerTail: new Uint8Array(),
              ready: false,
            };
            let requestFiber: Fiber.Fiber<void, never> | undefined;

            const emitOutputLocked = Effect.fn("CodexTerminalAdapter.emitOutputLocked")(function* (
              bytes: Uint8Array,
            ) {
              const remaining = input.outputByteLimit - state.deliveredBytes;
              const acceptedLength = Math.max(0, Math.min(remaining, bytes.byteLength));
              for (
                let offset = 0;
                offset < acceptedLength;
                offset += CODEX_TERMINAL_MAX_OUTPUT_CHUNK_BYTES
              ) {
                const end = Math.min(
                  acceptedLength,
                  offset + CODEX_TERMINAL_MAX_OUTPUT_CHUNK_BYTES,
                );
                yield* onEvent({ type: "output", bytes: bytes.slice(offset, end) });
              }
              state.deliveredBytes += acceptedLength;
              return acceptedLength < bytes.byteLength;
            });

            const emitExitLocked = Effect.fn("CodexTerminalAdapter.emitExitLocked")(function* (
              reason: ProviderTerminalExitReason,
              exitCode: number | null,
              startupError?: ProviderTerminalError,
            ) {
              if (state.finished) return;
              state.finished = true;
              state.exitIntent = reason;
              yield* onEvent({
                type: "exited",
                exitCode,
                exitSignal: null,
                reason,
              });
              if (!state.ready) {
                yield* Deferred.fail(
                  ready,
                  startupError ??
                    protocol(
                      options.providerInstanceId,
                      "start",
                      "Codex terminal exited before its ready frame.",
                    ),
                ).pipe(Effect.asVoid);
              }
            });

            const terminateRemote = borrowed.connection.client
              .request("command/exec/terminate", { processId })
              .pipe(Effect.asVoid);
            const terminateRemoteBestEffort = terminateRemote.pipe(
              Effect.timeout(CODEX_TERMINAL_CLEANUP_TIMEOUT),
              Effect.ignore,
            );

            const abortLocked = Effect.fn("CodexTerminalAdapter.abortLocked")(function* (
              reason: ProviderTerminalExitReason,
              error: ProviderTerminalError,
            ) {
              if (state.finished) return;
              state.exitIntent = reason;
              yield* terminateRemoteBestEffort;
              yield* emitExitLocked(reason, null, error);
            });

            const handleDecodedOutputLocked = Effect.fn(
              "CodexTerminalAdapter.handleDecodedOutputLocked",
            )(function* (bytes: Uint8Array, capReached: boolean) {
              if (state.finished) return;
              if (state.ready) {
                const overflowed = yield* emitOutputLocked(bytes);
                if (overflowed || capReached) {
                  yield* abortLocked(
                    "outputLimit",
                    operationFailed(
                      options.providerInstanceId,
                      "start",
                      "Codex terminal output limit was reached.",
                    ),
                  );
                }
                return;
              }

              const combined = concatBytes(state.markerTail, bytes);
              const markerIndex = findBytes(combined, readyFrame);
              if (markerIndex >= 0) {
                const beforeMarker = combined.slice(0, markerIndex);
                const afterMarker = combined.slice(markerIndex + readyFrame.byteLength);
                state.markerTail = new Uint8Array();
                const prefixOverflowed = yield* emitOutputLocked(beforeMarker);
                if (prefixOverflowed) {
                  yield* abortLocked(
                    "outputLimit",
                    operationFailed(
                      options.providerInstanceId,
                      "start",
                      "Codex terminal output limit was reached before readiness.",
                    ),
                  );
                  return;
                }
                state.ready = true;
                yield* Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
                const suffixOverflowed = yield* emitOutputLocked(afterMarker);
                if (suffixOverflowed || capReached) {
                  yield* abortLocked(
                    "outputLimit",
                    operationFailed(
                      options.providerInstanceId,
                      "start",
                      "Codex terminal output limit was reached.",
                    ),
                  );
                }
                return;
              }

              const retainedLength = Math.min(readyFrame.byteLength - 1, combined.byteLength);
              const emittedLength = combined.byteLength - retainedLength;
              const overflowed = yield* emitOutputLocked(combined.slice(0, emittedLength));
              state.markerTail = combined.slice(emittedLength);
              if (overflowed || capReached) {
                yield* abortLocked(
                  "outputLimit",
                  operationFailed(
                    options.providerInstanceId,
                    "start",
                    "Codex terminal output limit was reached before readiness.",
                  ),
                );
              }
            });

            const onOutput = Effect.fn("CodexTerminalAdapter.onOutput")(function* (
              notification: CodexTerminalOutputDelta,
            ) {
              const decoded = yield* Effect.fromResult(
                Encoding.decodeBase64(notification.deltaBase64),
              ).pipe(
                Effect.mapError(() =>
                  protocol(
                    options.providerInstanceId,
                    "start",
                    "Codex terminal emitted invalid base64 output.",
                  ),
                ),
                Effect.result,
              );
              yield* sessionLock.withPermits(1)(
                decoded._tag === "Failure"
                  ? abortLocked("failed", decoded.failure)
                  : handleDecodedOutputLocked(decoded.success, notification.capReached),
              );
            });

            yield* multiplexer
              .register(processId, onOutput)
              .pipe(
                Effect.mapError(() =>
                  protocol(
                    options.providerInstanceId,
                    "start",
                    "Generated Codex terminal process id was already registered.",
                  ),
                ),
              );

            const finalizeSession = sessionLock
              .withPermits(1)(
                Effect.gen(function* () {
                  if (!state.finished) {
                    state.exitIntent = "terminated";
                    yield* terminateRemoteBestEffort;
                    yield* emitExitLocked("terminated", null);
                  }
                }),
              )
              .pipe(
                Effect.ensuring(
                  Effect.suspend(() =>
                    requestFiber === undefined
                      ? Effect.void
                      : Fiber.interrupt(requestFiber).pipe(Effect.ignore),
                  ),
                ),
              );
            yield* Scope.addFinalizer(sessionScope, finalizeSession);

            yield* borrowed.ensureCurrent.pipe(
              Effect.mapError(() => disconnected(options.providerInstanceId, "start")),
            );

            const commandRequest = borrowed.connection.client
              .request("command/exec", {
                command: makeCommand(input, processId),
                cwd: input.cwd,
                ...(input.env === undefined ? {} : { env: input.env }),
                outputBytesCap: input.outputByteLimit,
                processId,
                sandboxPolicy: { type: "dangerFullAccess" },
                size: { cols: input.cols, rows: input.rows },
                streamStdin: true,
                streamStdoutStderr: true,
                disableTimeout: true,
                tty: true,
              })
              .pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    sessionLock.withPermits(1)(
                      emitExitLocked(
                        isDisconnectedCodexError(error) ? "disconnected" : "failed",
                        null,
                        mapCodexError(options.providerInstanceId, "start", error),
                      ),
                    ),
                  onSuccess: (response) =>
                    sessionLock.withPermits(1)(
                      Effect.gen(function* () {
                        if (state.finished) return;
                        if (!state.ready && state.markerTail.byteLength > 0) {
                          const overflowed = yield* emitOutputLocked(state.markerTail);
                          state.markerTail = new Uint8Array();
                          if (overflowed) {
                            yield* emitExitLocked(
                              "outputLimit",
                              response.exitCode,
                              operationFailed(
                                options.providerInstanceId,
                                "start",
                                "Codex terminal output limit was reached before readiness.",
                              ),
                            );
                            return;
                          }
                        }
                        if (response.stdout !== "" || response.stderr !== "") {
                          yield* emitExitLocked(
                            "failed",
                            response.exitCode,
                            protocol(
                              options.providerInstanceId,
                              "start",
                              "Codex returned buffered output for a streaming terminal.",
                            ),
                          );
                          return;
                        }
                        yield* emitExitLocked(
                          state.ready ? (state.exitIntent ?? "completed") : "failed",
                          response.exitCode,
                        );
                      }),
                    ),
                }),
              );
            requestFiber = yield* commandRequest.pipe(
              Effect.forkDetach({ startImmediately: true }),
            );

            const awaitReady = Deferred.await(ready).pipe(
              Effect.timeout(CODEX_TERMINAL_START_TIMEOUT),
              Effect.mapError((error) =>
                Cause.isTimeoutError(error)
                  ? operationFailed(
                      options.providerInstanceId,
                      "start",
                      `Codex terminal did not become ready within ${CODEX_TERMINAL_START_TIMEOUT}.`,
                    )
                  : error,
              ),
              Effect.flatMap(() =>
                borrowed.ensureCurrent.pipe(
                  Effect.mapError(() => disconnected(options.providerInstanceId, "start")),
                ),
              ),
              Effect.catch((error) =>
                sessionLock
                  .withPermits(1)(
                    abortLocked(
                      error._tag === "ProviderTerminalDisconnectedError"
                        ? "disconnected"
                        : "failed",
                      error,
                    ),
                  )
                  .pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
            yield* restore(awaitReady);

            const runCapturedControl = <A>(
              operation: "write" | "resize" | "terminate",
              request: Effect.Effect<A, CodexErrors.CodexAppServerError>,
            ): Effect.Effect<A, ProviderTerminalError> =>
              borrowed.ensureCurrent.pipe(
                Effect.andThen(request),
                Effect.tap(() => borrowed.ensureCurrent),
                Effect.mapError((error) =>
                  mapCapturedConnectionError(options.providerInstanceId, operation, error),
                ),
              );

            const session: ProviderTerminalSession = {
              write: Effect.fn("CodexTerminalAdapter.write")(function* (bytes) {
                yield* sessionLock.withPermits(1)(
                  state.finished
                    ? Effect.fail(
                        operationFailed(
                          options.providerInstanceId,
                          "write",
                          "Codex terminal session has exited.",
                        ),
                      )
                    : runCapturedControl(
                        "write",
                        borrowed.connection.client.request("command/exec/write", {
                          processId,
                          deltaBase64: Encoding.encodeBase64(bytes),
                        }),
                      ).pipe(Effect.asVoid),
                );
              }),
              resize: Effect.fn("CodexTerminalAdapter.resize")(function* (size) {
                yield* sessionLock.withPermits(1)(
                  state.finished
                    ? Effect.fail(
                        operationFailed(
                          options.providerInstanceId,
                          "resize",
                          "Codex terminal session has exited.",
                        ),
                      )
                    : runCapturedControl(
                        "resize",
                        borrowed.connection.client.request("command/exec/resize", {
                          processId,
                          size,
                        }),
                      ).pipe(Effect.asVoid),
                );
              }),
              terminate: sessionLock.withPermits(1)(
                Effect.gen(function* () {
                  if (state.finished) return;
                  const result = yield* runCapturedControl(
                    "terminate",
                    borrowed.connection.client.request("command/exec/terminate", { processId }),
                  ).pipe(Effect.result);
                  if (result._tag === "Failure") {
                    yield* emitExitLocked(
                      result.failure._tag === "ProviderTerminalDisconnectedError"
                        ? "disconnected"
                        : "failed",
                      null,
                    );
                    return yield* result.failure;
                  }
                  yield* emitExitLocked("terminated", null);
                }),
              ),
            };
            return session;
          }).pipe(Effect.provideService(Scope.Scope, sessionScope));

          const session = yield* acquire.pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(sessionScope, Exit.void) : Effect.void,
            ),
          );
          yield* Scope.addFinalizer(
            parentScope,
            Scope.close(sessionScope, Exit.void).pipe(Effect.ignore),
          );
          return session;
        }),
      );
    },
  );

  return { start };
});
