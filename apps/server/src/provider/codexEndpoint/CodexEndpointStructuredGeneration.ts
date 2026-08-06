import {
  type ModelSelection,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import { CodexEndpointTerminationError } from "./CodexEndpointConnection.ts";
import {
  CodexEndpointInternalOperationRegistrationError,
  type CodexEndpointRouteCallbacks,
} from "./CodexEndpointRouter.ts";
import {
  CodexEndpointBorrowUnavailableError,
  type CodexEndpointRoutedConnectionBorrow,
  type CodexEndpointSupervisor,
} from "./CodexEndpointSupervisor.ts";

export const CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_PROMPT_CHARS = 128_000;
export const CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_PROMPT_BYTES = 256 * 1024;
export const CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024;
export const CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_OUTPUT_BYTES = 256 * 1024;
export const CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_REMOTE_PATH_BYTES = 4096;
const IMAGE_DATA_URL_PATTERN = /^data:image\/[a-zA-Z0-9.+-]+;base64,([a-zA-Z0-9+/]+={0,2})$/;
const UTF8_ENCODER = new TextEncoder();

/*
 * App-server 0.146 keeps unsubscribed ephemeral threads in memory until its
 * idle unload delay elapses. Cleanup deliberately detaches with
 * `thread/unsubscribe`; `thread/delete` rejects loaded ephemeral threads.
 */
const DEFAULT_TIMEOUT = Duration.seconds(180);
const DEFAULT_TERMINAL_GRACE = Duration.seconds(1);
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_REASONING_EFFORT = "low";

interface ValidatedStructuredGenerationInput extends Omit<
  CodexEndpointStructuredGenerationInput,
  "outputSchema"
> {
  readonly outputSchema: Schema.Json;
}

/*
 * Input validation happens before borrowing, and the immutable borrow is never
 * replayed on reconnect. This component accepts only in-memory image data URLs
 * and does not touch Cocoa conversations, local files, or processes.
 */

export interface CodexEndpointStructuredGenerationInput {
  readonly workspace: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly remotePath: string;
  };
  readonly modelSelection: ModelSelection;
  readonly prompt: string;
  readonly outputSchema: unknown;
  readonly imageDataUrls: ReadonlyArray<string>;
}

export interface CodexEndpointStructuredGenerationResult {
  readonly text: string;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
}

export const CodexEndpointStructuredGenerationFailureReason = Schema.Literals([
  "instance-mismatch",
  "invalid-input",
  "endpoint-unavailable",
  "endpoint-disconnected",
  "route-failed",
  "request-failed",
  "turn-failed",
  "turn-interrupted",
  "missing-final-response",
  "malformed-final-response",
  "timeout",
]);
export type CodexEndpointStructuredGenerationFailureReason =
  typeof CodexEndpointStructuredGenerationFailureReason.Type;

export class CodexEndpointStructuredGenerationError extends Schema.TaggedErrorClass<CodexEndpointStructuredGenerationError>()(
  "CodexEndpointStructuredGenerationError",
  {
    providerInstanceId: ProviderInstanceId,
    reason: CodexEndpointStructuredGenerationFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Codex endpoint structured generation failed for provider instance '${this.providerInstanceId}': ${this.reason}.`;
  }
}

export interface CodexEndpointStructuredGeneration {
  readonly generate: (
    input: CodexEndpointStructuredGenerationInput,
  ) => Effect.Effect<
    CodexEndpointStructuredGenerationResult,
    CodexEndpointStructuredGenerationError
  >;
}

export interface MakeCodexEndpointStructuredGenerationOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly borrowRoutedConnection: CodexEndpointSupervisor["borrowRoutedConnection"];
  readonly concurrency?: number;
  readonly timeout?: Duration.Input;
  readonly terminalGrace?: Duration.Input;
}

interface NativeLifecycle {
  readonly threadId: string | undefined;
  readonly turnId: string | undefined;
  readonly turnActive: boolean;
  readonly terminalReceived: boolean;
}

type TurnCompleted = CodexRpc.ServerNotificationParamsByMethod["turn/completed"];

const decodeStructuredJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeJsonValue = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const isStructuredGenerationError = Schema.is(CodexEndpointStructuredGenerationError);
const isBorrowUnavailable = Schema.is(CodexEndpointBorrowUnavailableError);
const isEndpointTermination = Schema.is(CodexEndpointTerminationError);
const isRouteRegistrationError = Schema.is(CodexEndpointInternalOperationRegistrationError);
const isTransportError = Schema.is(CodexErrors.CodexAppServerTransportError);
const isInputEndedError = Schema.is(CodexErrors.CodexAppServerInputStreamEndedError);
const isProcessExitedError = Schema.is(CodexErrors.CodexAppServerProcessExitedError);

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

function isNormalizedAbsolutePosixPath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\")) return false;
  if (value === "/") return true;
  if (value.endsWith("/") || value.includes("//")) return false;
  return value
    .slice(1)
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

const validateInput = Effect.fn("CodexEndpointStructuredGeneration.validateInput")(function* (
  providerInstanceId: ProviderInstanceId,
  input: CodexEndpointStructuredGenerationInput,
): Effect.fn.Return<ValidatedStructuredGenerationInput, CodexEndpointStructuredGenerationError> {
  const remotePath = input.workspace.remotePath;
  if (
    !isNormalizedAbsolutePosixPath(remotePath) ||
    UTF8_ENCODER.encode(remotePath).byteLength >
      CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_REMOTE_PATH_BYTES
  ) {
    return yield* makeFailure(providerInstanceId, "invalid-input");
  }

  if (
    input.prompt.trim().length === 0 ||
    input.prompt.length > CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_PROMPT_CHARS ||
    UTF8_ENCODER.encode(input.prompt).byteLength >
      CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_PROMPT_BYTES
  ) {
    return yield* makeFailure(providerInstanceId, "invalid-input");
  }

  const encodedSchema = yield* encodeUnknownJson(input.outputSchema).pipe(
    Effect.mapError((cause) => makeFailure(providerInstanceId, "invalid-input", cause)),
  );
  if (
    UTF8_ENCODER.encode(encodedSchema).byteLength >
    CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_OUTPUT_SCHEMA_BYTES
  ) {
    return yield* makeFailure(providerInstanceId, "invalid-input");
  }
  const outputSchema = yield* decodeJsonValue(encodedSchema).pipe(
    Effect.mapError((cause) => makeFailure(providerInstanceId, "invalid-input", cause)),
  );

  if (input.imageDataUrls.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return yield* makeFailure(providerInstanceId, "invalid-input");
  }
  let aggregateImageBytes = 0;
  for (const imageDataUrl of input.imageDataUrls) {
    const match = imageDataUrl.match(IMAGE_DATA_URL_PATTERN);
    if (!match || match[1]!.length % 4 !== 0) {
      return yield* makeFailure(providerInstanceId, "invalid-input");
    }
    aggregateImageBytes += imageDataUrl.length;
    if (aggregateImageBytes > PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES) {
      return yield* makeFailure(providerInstanceId, "invalid-input");
    }
  }

  return { ...input, outputSchema };
});

function readFinalAgentMessage(completed: TurnCompleted): string | undefined {
  const messages = completed.turn.items.filter((item) => item.type === "agentMessage");
  const finalAnswer = messages.findLast((item) => item.phase === "final_answer");
  return finalAnswer?.text ?? messages.at(-1)?.text;
}

function makeFailure(
  providerInstanceId: ProviderInstanceId,
  reason: CodexEndpointStructuredGenerationFailureReason,
  cause?: unknown,
): CodexEndpointStructuredGenerationError {
  return new CodexEndpointStructuredGenerationError({
    providerInstanceId,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

function normalizeRuntimeError(
  providerInstanceId: ProviderInstanceId,
  error: unknown,
): CodexEndpointStructuredGenerationError {
  if (isStructuredGenerationError(error)) return error;
  if (isBorrowUnavailable(error)) {
    return makeFailure(providerInstanceId, "endpoint-unavailable", error);
  }
  if (
    isEndpointTermination(error) ||
    isTransportError(error) ||
    isInputEndedError(error) ||
    isProcessExitedError(error)
  ) {
    return makeFailure(providerInstanceId, "endpoint-disconnected", error);
  }
  if (isRouteRegistrationError(error)) {
    return makeFailure(providerInstanceId, "route-failed", error);
  }
  return makeFailure(providerInstanceId, "request-failed", error);
}

const rejectInteractiveRequest: CodexEndpointRouteCallbacks["onRequest"] = (method) => {
  switch (method) {
    case "item/tool/requestUserInput":
      return Effect.succeed({ answers: {} }) as never;
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return Effect.succeed({ decision: "decline" }) as never;
  }
};

export const makeCodexEndpointStructuredGeneration = Effect.fn(
  "CodexEndpointStructuredGeneration.make",
)(function* (
  options: MakeCodexEndpointStructuredGenerationOptions,
): Effect.fn.Return<CodexEndpointStructuredGeneration> {
  const concurrency = yield* Semaphore.make(normalizeConcurrency(options.concurrency));
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const terminalGrace = options.terminalGrace ?? DEFAULT_TERMINAL_GRACE;

  const runRequest = <A, E>(
    borrow: CodexEndpointRoutedConnectionBorrow,
    request: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | CodexEndpointStructuredGenerationError> =>
    Effect.raceFirst(
      request,
      borrow.connection.awaitTermination.pipe(
        Effect.mapError((error) =>
          makeFailure(options.providerInstanceId, "endpoint-disconnected", error),
        ),
      ),
    );

  const boundedCleanup = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
    effect.pipe(Effect.timeout(terminalGrace), Effect.ignore);

  const runOne = Effect.fn("CodexEndpointStructuredGeneration.runOne")(
    function* (input: ValidatedStructuredGenerationInput) {
      const borrow = yield* options.borrowRoutedConnection;
      yield* borrow.ensureCurrent;

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const terminal = yield* Deferred.make<TurnCompleted>();
          const lifecycle = yield* Ref.make<NativeLifecycle>({
            threadId: undefined,
            turnId: undefined,
            turnActive: false,
            terminalReceived: false,
          });

          const onNotification: CodexEndpointRouteCallbacks["onNotification"] = (
            method,
            params,
          ) => {
            switch (method) {
              case "turn/started": {
                const started = params as CodexRpc.ServerNotificationParamsByMethod["turn/started"];
                return Ref.update(lifecycle, (current) =>
                  current.threadId !== started.threadId ||
                  (current.turnId !== undefined && current.turnId !== started.turn.id)
                    ? current
                    : {
                        ...current,
                        turnId: started.turn.id,
                        turnActive: !current.terminalReceived,
                      },
                );
              }
              case "turn/completed": {
                const completed = params as TurnCompleted;
                return Ref.modify(lifecycle, (current) => {
                  if (
                    current.threadId !== completed.threadId ||
                    (current.turnId !== undefined && current.turnId !== completed.turn.id)
                  ) {
                    return [false, current] as const;
                  }
                  return [
                    true,
                    {
                      ...current,
                      turnId: completed.turn.id,
                      turnActive: false,
                      terminalReceived: true,
                    },
                  ] as const;
                }).pipe(
                  Effect.flatMap((matched) =>
                    matched
                      ? Deferred.succeed(terminal, completed).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                );
              }
              default:
                return Effect.void;
            }
          };

          const registration = yield* borrow.router.registerInternalOperation({
            callbacks: {
              onNotification,
              onRequest: rejectInteractiveRequest,
            },
          });

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const current = yield* Ref.get(lifecycle);
              if (current.threadId === undefined) return;
              if (current.turnActive && current.turnId !== undefined) {
                yield* boundedCleanup(
                  borrow.connection.client.request("turn/interrupt", {
                    threadId: current.threadId,
                    turnId: current.turnId,
                  }),
                );
                yield* Deferred.await(terminal).pipe(Effect.timeout(terminalGrace), Effect.ignore);
              }
              yield* boundedCleanup(
                borrow.connection.client.request("thread/unsubscribe", {
                  threadId: current.threadId,
                }),
              );
            }),
          );

          yield* borrow.ensureCurrent;
          const serviceTier = getCodexServiceTierOptionValue(input.modelSelection);
          const threadStarted = yield* runRequest(
            borrow,
            borrow.connection.client.request("thread/start", {
              cwd: input.workspace.remotePath,
              ephemeral: true,
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: "read-only",
              model: input.modelSelection.model,
              ...(serviceTier ? { serviceTier } : {}),
            }),
          );
          const nativeThreadId = threadStarted.thread.id;
          yield* Ref.update(lifecycle, (current) => ({ ...current, threadId: nativeThreadId }));
          yield* registration.bindNativeThreadId(nativeThreadId);

          yield* borrow.ensureCurrent;
          const reasoningEffort =
            getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
            DEFAULT_REASONING_EFFORT;
          const turnStarted = yield* runRequest(
            borrow,
            borrow.connection.client.request("turn/start", {
              threadId: nativeThreadId,
              input: [
                { type: "text", text: input.prompt },
                ...input.imageDataUrls.map((url) => ({ type: "image" as const, url })),
              ],
              cwd: input.workspace.remotePath,
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandboxPolicy: { type: "readOnly", networkAccess: false },
              model: input.modelSelection.model,
              effort: reasoningEffort,
              ...(serviceTier ? { serviceTier } : {}),
              outputSchema: input.outputSchema,
            }),
          );
          const nativeTurnId = turnStarted.turn.id;
          yield* Ref.update(lifecycle, (current) =>
            current.turnId !== undefined && current.turnId !== nativeTurnId
              ? current
              : {
                  ...current,
                  turnId: nativeTurnId,
                  turnActive: !current.terminalReceived,
                },
          );

          const completed = yield* runRequest(borrow, Deferred.await(terminal));
          yield* borrow.ensureCurrent;
          if (completed.turn.id !== nativeTurnId) {
            return yield* makeFailure(options.providerInstanceId, "turn-failed");
          }
          if (completed.turn.status === "failed") {
            return yield* makeFailure(
              options.providerInstanceId,
              "turn-failed",
              completed.turn.error,
            );
          }
          if (completed.turn.status === "interrupted") {
            return yield* makeFailure(options.providerInstanceId, "turn-interrupted");
          }
          if (completed.turn.status !== "completed") {
            return yield* makeFailure(options.providerInstanceId, "turn-failed");
          }

          const text = readFinalAgentMessage(completed);
          if (text === undefined || text.trim().length === 0) {
            return yield* makeFailure(options.providerInstanceId, "missing-final-response");
          }
          if (
            UTF8_ENCODER.encode(text).byteLength >
            CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_OUTPUT_BYTES
          ) {
            return yield* makeFailure(options.providerInstanceId, "malformed-final-response");
          }
          yield* decodeStructuredJson(text).pipe(
            Effect.mapError((cause) =>
              makeFailure(options.providerInstanceId, "malformed-final-response", cause),
            ),
          );
          return { text, nativeThreadId, nativeTurnId };
        }),
      );
    },
    Effect.mapError((error) => normalizeRuntimeError(options.providerInstanceId, error)),
  );

  const generate: CodexEndpointStructuredGeneration["generate"] = (input) => {
    if (
      input.workspace.providerInstanceId !== input.modelSelection.instanceId ||
      input.workspace.providerInstanceId !== options.providerInstanceId
    ) {
      return Effect.fail(makeFailure(options.providerInstanceId, "instance-mismatch"));
    }
    return validateInput(options.providerInstanceId, input).pipe(
      Effect.flatMap((validated) => concurrency.withPermits(1)(runOne(validated))),
      Effect.timeout(timeout),
      Effect.mapError((error) =>
        Cause.isTimeoutError(error)
          ? makeFailure(options.providerInstanceId, "timeout", error)
          : error,
      ),
    );
  };

  return { generate };
});
