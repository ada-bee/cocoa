import {
  COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES,
  type CocoaHostControlEvent,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  type ProviderTerminalAdapter,
  ProviderTerminalCwdError,
  ProviderTerminalDisconnectedError,
  type ProviderTerminalError,
  ProviderTerminalOperationError,
  type ProviderTerminalOperation,
  ProviderTerminalProtocolError,
  type ProviderTerminalSession,
  ProviderTerminalUnsupportedError,
} from "../ProviderTerminalAdapter.ts";
import {
  requestHostEndpoint,
  type HostEndpointControlClient,
} from "./HostEndpointControlClient.ts";
import type { HostEndpointRpcRequestError } from "./HostEndpointRpcClient.ts";

export interface MakeHostEndpointTerminalAdapterOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly client: HostEndpointControlClient;
}

export const mapHostEndpointTerminalError = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderTerminalOperation,
  cwd: string,
  error: HostEndpointRpcRequestError,
): ProviderTerminalError => {
  if (error._tag === "HostEndpointRpcRemoteError") {
    switch (error.code) {
      case "unsupportedProtocol":
      case "unsupportedOperation":
        return new ProviderTerminalUnsupportedError({
          providerInstanceId,
          operation,
          cause: error,
        });
      case "invalidPath":
        return new ProviderTerminalCwdError({
          providerInstanceId,
          operation,
          cwd,
          issue: error.remoteMessage,
          cause: error,
        });
      case "disconnected":
      case "staleHandle":
        return new ProviderTerminalDisconnectedError({
          providerInstanceId,
          operation,
          cause: error,
        });
      case "invalidRequest":
        return new ProviderTerminalProtocolError({
          providerInstanceId,
          operation,
          detail: error.remoteMessage,
          cause: error,
        });
      case "outcomeUnknown":
        return new ProviderTerminalOperationError({
          providerInstanceId,
          operation,
          detail: "terminal mutation outcome unknown; do not retry automatically",
          cause: error,
        });
      default:
        return new ProviderTerminalOperationError({
          providerInstanceId,
          operation,
          detail: error.remoteMessage,
          cause: error,
        });
    }
  }
  switch (error._tag) {
    case "HostEndpointRpcDisconnectedError":
    case "HostEndpointRpcSendError":
    case "HostEndpointRpcTimeoutError":
      return new ProviderTerminalDisconnectedError({ providerInstanceId, operation, cause: error });
    case "HostEndpointRpcProtocolError":
    case "HostEndpointRpcResponseDecodeError":
    case "HostEndpointRpcSerializationError":
    case "HostEndpointRpcInvalidPayloadError":
      return new ProviderTerminalProtocolError({
        providerInstanceId,
        operation,
        detail: "cocoa-hostd terminal protocol failed validation",
        cause: error,
      });
    case "HostEndpointRpcCapacityError":
      return new ProviderTerminalOperationError({
        providerInstanceId,
        operation,
        detail: "cocoa-hostd terminal request capacity was exhausted",
        cause: error,
      });
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

interface SessionState {
  deliveredBytes: number;
  finished: boolean;
  remoteExited: boolean;
  sequence: number;
}

const decodeOutput = (
  providerInstanceId: ProviderInstanceId,
  dataBase64: string,
): Effect.Effect<Uint8Array, ProviderTerminalProtocolError> =>
  Effect.fromResult(Encoding.decodeBase64(dataBase64)).pipe(
    Effect.mapError(
      () =>
        new ProviderTerminalProtocolError({
          providerInstanceId,
          operation: "start",
          detail: "cocoa-hostd returned invalid base64 terminal output",
        }),
    ),
  );

export const makeHostEndpointTerminalAdapter = (
  options: MakeHostEndpointTerminalAdapterOptions,
): ProviderTerminalAdapter => {
  const capability = options.client.handshake.capabilities.find(
    (candidate) => candidate.kind === "terminal",
  );
  const supports = (operation: "start" | "attach" | "write" | "resize" | "terminate") =>
    capability?.operations.includes(operation) === true;
  const unsupported = (operation: ProviderTerminalOperation) =>
    new ProviderTerminalUnsupportedError({
      providerInstanceId: options.providerInstanceId,
      operation,
    });

  const start: ProviderTerminalAdapter["start"] = Effect.fn("HostEndpointTerminalAdapter.start")(
    function* (input, onEvent) {
      if (!supports("start")) return yield* unsupported("start");
      const parentScope = yield* Effect.scope;
      const sessionScope = yield* Scope.make("sequential");
      const acquire = Effect.gen(function* () {
        const subscription = yield* options.client.subscribeEvents;
        const response = yield* requestHostEndpoint(options.client, "terminal.start", {
          cwd: input.cwd,
          shellArgv: [...input.shellArgv],
          cols: input.cols,
          rows: input.rows,
          ...(input.env === undefined ? {} : { env: input.env }),
          outputByteLimit: Math.min(input.outputByteLimit, capability!.maxOutputBytes),
        }).pipe(
          Effect.mapError((error) =>
            mapHostEndpointTerminalError(options.providerInstanceId, "start", input.cwd, error),
          ),
        );
        const snapshot = response.snapshot;
        if (snapshot.generationId !== options.client.generationId) {
          return yield* new ProviderTerminalProtocolError({
            providerInstanceId: options.providerInstanceId,
            operation: "start",
            detail: "cocoa-hostd returned a terminal for a different host generation",
          });
        }
        const binding = {
          generationId: snapshot.generationId,
          sessionId: snapshot.sessionId,
        } as const;
        const state: SessionState = {
          deliveredBytes: 0,
          finished: false,
          remoteExited: false,
          sequence: snapshot.sequence,
        };
        const lock = yield* Semaphore.make(1);

        const emitExitLocked = Effect.fn("HostEndpointTerminalAdapter.emitExitLocked")(function* (
          reason: "completed" | "terminated" | "disconnected" | "outputLimit" | "failed",
          exitCode: number | null,
          exitSignal: number | null,
        ) {
          if (state.finished) return;
          state.finished = true;
          yield* onEvent({ type: "exited", exitCode, exitSignal, reason });
        });

        const emitOutputLocked = Effect.fn("HostEndpointTerminalAdapter.emitOutputLocked")(
          function* (bytes: Uint8Array) {
            if (state.finished || bytes.byteLength === 0) return;
            const remaining = input.outputByteLimit - state.deliveredBytes;
            const accepted = Math.max(0, Math.min(remaining, bytes.byteLength));
            if (accepted > 0) {
              yield* onEvent({ type: "output", bytes: bytes.slice(0, accepted) });
              state.deliveredBytes += accepted;
            }
            if (accepted < bytes.byteLength) {
              yield* emitExitLocked("outputLimit", null, null);
            }
          },
        );

        const terminateRemote = requestHostEndpoint(options.client, "terminal.terminate", {
          ...binding,
        }).pipe(Effect.asVoid);

        yield* Scope.addFinalizer(
          sessionScope,
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (state.remoteExited) return;
              yield* terminateRemote.pipe(Effect.ignore);
              yield* emitExitLocked("terminated", null, null);
            }),
          ),
        );

        const handleEvent = Effect.fn("HostEndpointTerminalAdapter.handleEvent")(function* (
          event: CocoaHostControlEvent,
        ) {
          if (event.event === "providerRelay.changed" || event.sessionId !== binding.sessionId)
            return;
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (state.finished || event.sequence <= state.sequence) return;
              if (event.generationId !== binding.generationId) {
                yield* emitExitLocked("disconnected", null, null);
                return;
              }
              if (event.sequence !== state.sequence + 1) {
                yield* emitExitLocked("failed", null, null);
                return;
              }
              state.sequence = event.sequence;
              if (event.event === "terminal.output") {
                yield* emitOutputLocked(
                  yield* decodeOutput(options.providerInstanceId, event.dataBase64),
                );
                return;
              }
              state.remoteExited = true;
              yield* emitExitLocked(event.reason, event.exitCode, event.exitSignal);
            }),
          );
        });

        const initial = yield* decodeOutput(options.providerInstanceId, snapshot.historyBase64);
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            yield* emitOutputLocked(initial);
            if (snapshot.status === "running") {
              if (snapshot.exitReason !== null || snapshot.historyTruncated) {
                return yield* new ProviderTerminalProtocolError({
                  providerInstanceId: options.providerInstanceId,
                  operation: "start",
                  detail: "cocoa-hostd returned inconsistent running terminal state",
                });
              }
            } else {
              if (snapshot.exitReason === null) {
                return yield* new ProviderTerminalProtocolError({
                  providerInstanceId: options.providerInstanceId,
                  operation: "start",
                  detail: "cocoa-hostd omitted the retained terminal exit reason",
                });
              }
              state.remoteExited = true;
              yield* emitExitLocked(snapshot.exitReason, snapshot.exitCode, snapshot.exitSignal);
            }
          }),
        );

        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach(handleEvent),
          Effect.forkScoped,
        );
        yield* options.client.awaitTermination.pipe(
          Effect.catch(() => lock.withPermits(1)(emitExitLocked("disconnected", null, null))),
          Effect.forkScoped,
        );

        const control = <Operation extends "write" | "resize" | "terminate">(
          operation: Operation,
          effect: Effect.Effect<void, HostEndpointRpcRequestError>,
        ): Effect.Effect<void, ProviderTerminalError> =>
          effect.pipe(
            Effect.mapError((error) =>
              mapHostEndpointTerminalError(options.providerInstanceId, operation, input.cwd, error),
            ),
          );

        const session: ProviderTerminalSession = {
          write: Effect.fn("HostEndpointTerminalAdapter.write")(function* (bytes) {
            if (!supports("write")) return yield* unsupported("write");
            yield* lock.withPermits(1)(
              Effect.gen(function* () {
                if (state.finished) {
                  return yield* new ProviderTerminalOperationError({
                    providerInstanceId: options.providerInstanceId,
                    operation: "write",
                    detail: "terminal session has exited",
                  });
                }
                for (
                  let offset = 0;
                  offset < bytes.byteLength;
                  offset += COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES
                ) {
                  const chunk = bytes.slice(
                    offset,
                    Math.min(
                      bytes.byteLength,
                      offset + COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES,
                    ),
                  );
                  yield* control(
                    "write",
                    requestHostEndpoint(options.client, "terminal.write", {
                      ...binding,
                      dataBase64: Encoding.encodeBase64(chunk),
                    }).pipe(Effect.asVoid),
                  );
                }
              }),
            );
          }),
          resize: Effect.fn("HostEndpointTerminalAdapter.resize")(function* (size) {
            if (!supports("resize")) return yield* unsupported("resize");
            yield* lock.withPermits(1)(
              state.finished
                ? Effect.fail(
                    new ProviderTerminalOperationError({
                      providerInstanceId: options.providerInstanceId,
                      operation: "resize",
                      detail: "terminal session has exited",
                    }),
                  )
                : control(
                    "resize",
                    requestHostEndpoint(options.client, "terminal.resize", {
                      ...binding,
                      cols: size.cols,
                      rows: size.rows,
                    }).pipe(Effect.asVoid),
                  ),
            );
          }),
          terminate: lock.withPermits(1)(
            Effect.gen(function* () {
              if (state.finished) return;
              if (!supports("terminate")) return yield* unsupported("terminate");
              const result = yield* control("terminate", terminateRemote).pipe(Effect.result);
              if (result._tag === "Failure") {
                yield* emitExitLocked(
                  result.failure._tag === "ProviderTerminalDisconnectedError"
                    ? "disconnected"
                    : "failed",
                  null,
                  null,
                );
                return yield* result.failure;
              }
              state.remoteExited = true;
              yield* emitExitLocked("terminated", null, null);
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
    },
  );

  return { start };
};
