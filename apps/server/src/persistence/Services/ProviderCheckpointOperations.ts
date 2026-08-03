/**
 * Durable journal and provider-native projection for remote checkpoint mutations.
 *
 * The journal stores the exact canonical provider-normal logical request. It
 * intentionally does not store the full CCH1 wire request: executable paths,
 * provider-host workspace paths, and path-bearing repository bindings remain
 * inside the provider adapter. `requestSha256` is the separately supplied
 * digest of that full request and is sufficient for receipt observation.
 */
import {
  CodexCheckpointHelperCaptureResult,
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperCheckpointRef,
  CodexCheckpointHelperDeleteItems,
  CodexCheckpointHelperDeleteResult,
  CodexCheckpointHelperMutationReceipt,
  CodexCheckpointHelperObjectFormat,
  CodexCheckpointHelperOid,
  CodexCheckpointHelperOperationId,
  CodexCheckpointHelperReceiptRef,
  CodexCheckpointHelperRestoreResult,
  CodexCheckpointHelperSha256,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

export const CheckpointOperationKind = Schema.Literals(["capture", "restore", "delete"]);
export type CheckpointOperationKind = typeof CheckpointOperationKind.Type;

export const CheckpointOperationState = Schema.Literals([
  "prepared",
  "in_flight",
  "outcome_unknown",
  "completed",
  "failed",
  "indeterminate",
]);
export type CheckpointOperationState = typeof CheckpointOperationState.Type;

const CanonicalCaptureRequest = strict(
  Schema.Struct({
    operation: Schema.Literal("capture"),
    operationId: CodexCheckpointHelperOperationId,
    checkpointId: CodexCheckpointHelperCheckpointId,
  }),
);

const CanonicalRestoreRequest = strict(
  Schema.Struct({
    operation: Schema.Literal("restore"),
    operationId: CodexCheckpointHelperOperationId,
    checkpointId: CodexCheckpointHelperCheckpointId,
    expectedCheckpointOid: CodexCheckpointHelperOid,
  }),
);

const CanonicalDeleteRequest = strict(
  Schema.Struct({
    operation: Schema.Literal("delete"),
    operationId: CodexCheckpointHelperOperationId,
    checkpoints: CodexCheckpointHelperDeleteItems,
  }),
);

/** Path-free, provider-normal logical request in its canonical JSON form. */
export const ProviderCheckpointCanonicalRequest = Schema.Union([
  CanonicalCaptureRequest,
  CanonicalRestoreRequest,
  CanonicalDeleteRequest,
]);
export type ProviderCheckpointCanonicalRequest = typeof ProviderCheckpointCanonicalRequest.Type;

/** Only non-path repository identity data may cross the persistence boundary. */
export const ProviderCheckpointRepositoryDiagnostic = strict(
  Schema.Struct({
    fingerprint: CodexCheckpointHelperSha256,
    objectFormat: CodexCheckpointHelperObjectFormat,
  }),
);
export type ProviderCheckpointRepositoryDiagnostic =
  typeof ProviderCheckpointRepositoryDiagnostic.Type;

/** Path-free domain intent needed to idempotently finish orchestration after restart. */
export const ProviderCheckpointIntentContext = Schema.Union([
  strict(
    Schema.Struct({
      kind: Schema.Literal("baseline"),
      sourceCommandId: Schema.NullOr(CommandId),
      sourceEventId: EventId,
      messageId: MessageId,
      checkpointTurnCount: NonNegativeInt,
    }),
  ),
  strict(
    Schema.Struct({
      kind: Schema.Literal("post_turn"),
      sourceEventId: EventId,
      turnId: TurnId,
      baselineCheckpointId: CodexCheckpointHelperCheckpointId,
      checkpointTurnCount: NonNegativeInt,
      completedAt: IsoDateTime,
      outcome: Schema.Literals(["completed", "failed", "interrupted"]),
    }),
  ),
  strict(
    Schema.Struct({
      kind: Schema.Literal("restore"),
      sourceRevertEventId: EventId,
      sourceCommandId: Schema.NullOr(CommandId),
      requestedTurnCount: NonNegativeInt,
    }),
  ),
  strict(
    Schema.Struct({
      kind: Schema.Literal("delete"),
      sourceRevertEventId: EventId,
      sourceCommandId: Schema.NullOr(CommandId),
      requestedTurnCount: NonNegativeInt,
      batchOrdinal: NonNegativeInt,
    }),
  ),
]);
export type ProviderCheckpointIntentContext = typeof ProviderCheckpointIntentContext.Type;

const SafeSummary = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      (!/[\u0000-\u001f\u007f]/u.test(value) && !value.includes("/") && !value.includes("\\")) ||
      "Checkpoint error summaries must be single-line and path-free.",
  ),
);

/** Deliberately excludes arbitrary causes, stderr, command text, and paths. */
export const ProviderCheckpointOperationError = strict(
  Schema.Struct({
    code: Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(64),
      Schema.isPattern(/^[a-z0-9_]+$/),
    ),
    summary: Schema.optionalKey(SafeSummary),
  }),
);
export type ProviderCheckpointOperationError = typeof ProviderCheckpointOperationError.Type;

export const ProviderCheckpointOperationTarget = strict(
  Schema.Struct({
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    expectedCheckpointOid: Schema.NullOr(CodexCheckpointHelperOid),
  }),
);
export type ProviderCheckpointOperationTarget = typeof ProviderCheckpointOperationTarget.Type;

const ProviderCheckpointMutationResult = Schema.Union([
  CodexCheckpointHelperCaptureResult,
  CodexCheckpointHelperRestoreResult,
  CodexCheckpointHelperDeleteResult,
]);

export const ProviderCheckpointOperation = strict(
  Schema.Struct({
    operationId: CodexCheckpointHelperOperationId,
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    threadId: Schema.NullOr(ThreadId),
    turnId: Schema.NullOr(TurnId),
    operationKind: CheckpointOperationKind,
    intentKey: CodexCheckpointHelperSha256,
    intentContext: ProviderCheckpointIntentContext,
    canonicalRequest: ProviderCheckpointCanonicalRequest,
    targets: Schema.NonEmptyArray(ProviderCheckpointOperationTarget),
    /** Digest of the full, path-bearing helper request; not of canonicalRequest. */
    requestSha256: CodexCheckpointHelperSha256,
    repository: ProviderCheckpointRepositoryDiagnostic,
    providerGeneration: Schema.NullOr(NonNegativeInt),
    state: CheckpointOperationState,
    receipt: Schema.NullOr(CodexCheckpointHelperMutationReceipt),
    result: Schema.NullOr(ProviderCheckpointMutationResult),
    error: Schema.NullOr(ProviderCheckpointOperationError),
    preparedAt: IsoDateTime,
    updatedAt: IsoDateTime,
    finalizedSequence: Schema.NullOr(NonNegativeInt),
  }).check(
    Schema.makeFilter(
      (row) =>
        row.canonicalRequest.operationId === row.operationId || "Request operationId mismatch.",
    ),
    Schema.makeFilter(
      (row) =>
        row.canonicalRequest.operation === row.operationKind || "Request operation mismatch.",
    ),
    Schema.makeFilter(
      (row) =>
        (row.operationKind === "capture" &&
          (row.intentContext.kind === "baseline" || row.intentContext.kind === "post_turn")) ||
        row.operationKind === row.intentContext.kind ||
        "Intent kind is incompatible with the checkpoint operation.",
    ),
    Schema.makeFilter((row) => {
      const request = row.canonicalRequest;
      const containsLogicalId =
        request.operation === "delete"
          ? request.checkpoints.some((item) => item.checkpointId === row.logicalCheckpointId)
          : request.checkpointId === row.logicalCheckpointId;
      return containsLogicalId || "Request does not contain logicalCheckpointId.";
    }),
    Schema.makeFilter(
      (row) =>
        row.targets[0].logicalCheckpointId === row.logicalCheckpointId ||
        "The first target must be the primary logicalCheckpointId.",
    ),
    Schema.makeFilter((row) => {
      const request = row.canonicalRequest;
      const expected =
        request.operation === "capture"
          ? [{ logicalCheckpointId: request.checkpointId, expectedCheckpointOid: null }]
          : request.operation === "restore"
            ? [
                {
                  logicalCheckpointId: request.checkpointId,
                  expectedCheckpointOid: request.expectedCheckpointOid,
                },
              ]
            : request.checkpoints.map((target) => ({
                logicalCheckpointId: target.checkpointId,
                expectedCheckpointOid: target.expectedCheckpointOid,
              }));
      return (
        (expected.length === row.targets.length &&
          expected.every(
            (target, index) =>
              target.logicalCheckpointId === row.targets[index]?.logicalCheckpointId &&
              target.expectedCheckpointOid === row.targets[index]?.expectedCheckpointOid,
          )) ||
        "Persisted targets must exactly match the canonical request in order."
      );
    }),
    Schema.makeFilter(
      (row) => row.turnId === null || row.threadId !== null || "turnId requires threadId.",
    ),
    Schema.makeFilter(
      (row) =>
        row.receipt === null ||
        row.receipt.operation === row.operationKind ||
        "Receipt operation mismatch.",
    ),
    Schema.makeFilter(
      (row) =>
        row.result === null ||
        row.result.operation === row.operationKind ||
        "Result operation mismatch.",
    ),
  ),
);
export type ProviderCheckpointOperation = typeof ProviderCheckpointOperation.Type;

export const PrepareProviderCheckpointOperationInput = strict(
  Schema.Struct({
    operationId: CodexCheckpointHelperOperationId,
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    threadId: Schema.NullOr(ThreadId),
    turnId: Schema.NullOr(TurnId),
    operationKind: CheckpointOperationKind,
    intentContext: ProviderCheckpointIntentContext,
    canonicalRequest: ProviderCheckpointCanonicalRequest,
    requestSha256: CodexCheckpointHelperSha256,
    repository: ProviderCheckpointRepositoryDiagnostic,
    providerGeneration: Schema.NullOr(NonNegativeInt),
    preparedAt: IsoDateTime,
  }).check(
    Schema.makeFilter(
      (row) =>
        row.canonicalRequest.operationId === row.operationId || "Request operationId mismatch.",
    ),
    Schema.makeFilter(
      (row) =>
        row.canonicalRequest.operation === row.operationKind || "Request operation mismatch.",
    ),
    Schema.makeFilter(
      (row) =>
        (row.operationKind === "capture" &&
          (row.intentContext.kind === "baseline" || row.intentContext.kind === "post_turn")) ||
        row.operationKind === row.intentContext.kind ||
        "Intent kind is incompatible with the checkpoint operation.",
    ),
    Schema.makeFilter((row) => {
      const request = row.canonicalRequest;
      return (
        (request.operation === "delete"
          ? request.checkpoints[0]?.checkpointId === row.logicalCheckpointId
          : request.checkpointId === row.logicalCheckpointId) ||
        "logicalCheckpointId must be the canonical request's first target."
      );
    }),
    Schema.makeFilter(
      (row) => row.turnId === null || row.threadId !== null || "turnId requires threadId.",
    ),
  ),
);
export type PrepareProviderCheckpointOperationInput =
  typeof PrepareProviderCheckpointOperationInput.Type;

export const GetProviderCheckpointOperationByIntentInput = strict(
  Schema.Struct({
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    intentContext: ProviderCheckpointIntentContext,
  }),
);
export type GetProviderCheckpointOperationByIntentInput =
  typeof GetProviderCheckpointOperationByIntentInput.Type;

export const GetProviderCheckpointOperationInput = strict(
  Schema.Struct({ operationId: CodexCheckpointHelperOperationId }),
);
export type GetProviderCheckpointOperationInput = typeof GetProviderCheckpointOperationInput.Type;

export const ListPendingProviderCheckpointOperationsInput = strict(
  Schema.Struct({ providerInstanceId: Schema.optionalKey(ProviderInstanceId) }),
);
export type ListPendingProviderCheckpointOperationsInput =
  typeof ListPendingProviderCheckpointOperationsInput.Type;

const TransitionInput = strict(
  Schema.Struct({
    operationId: CodexCheckpointHelperOperationId,
    updatedAt: IsoDateTime,
  }),
);

export const MarkProviderCheckpointInFlightInput = strict(
  Schema.Struct({
    ...TransitionInput.fields,
    providerGeneration: Schema.optionalKey(NonNegativeInt),
  }),
);
export type MarkProviderCheckpointInFlightInput = typeof MarkProviderCheckpointInFlightInput.Type;

export const MarkProviderCheckpointOutcomeUnknownInput = strict(
  Schema.Struct({
    ...TransitionInput.fields,
    error: ProviderCheckpointOperationError,
  }),
);
export type MarkProviderCheckpointOutcomeUnknownInput =
  typeof MarkProviderCheckpointOutcomeUnknownInput.Type;

export const CompleteProviderCheckpointOperationInput = strict(
  Schema.Struct({
    ...TransitionInput.fields,
    receipt: Schema.NullOr(CodexCheckpointHelperMutationReceipt),
    result: Schema.NullOr(ProviderCheckpointMutationResult),
  }).check(
    Schema.makeFilter(
      (input) =>
        input.receipt !== null ||
        input.result !== null ||
        "Completion requires a receipt or result.",
    ),
    Schema.makeFilter(
      (input) =>
        input.receipt === null ||
        input.result === null ||
        (input.receipt.operation === input.result.operation &&
          input.receipt.operationId === input.result.receipt.operationId &&
          input.receipt.receiptRef === input.result.receipt.receiptRef &&
          input.receipt.requestSha256 === input.result.receipt.requestSha256 &&
          input.receipt.repositoryFingerprint === input.result.receipt.repositoryFingerprint) ||
        "Completion receipt and result receipt must identify the same mutation.",
    ),
  ),
);
export type CompleteProviderCheckpointOperationInput =
  typeof CompleteProviderCheckpointOperationInput.Type;

export const FailProviderCheckpointOperationInput = strict(
  Schema.Struct({ ...TransitionInput.fields, error: ProviderCheckpointOperationError }),
);
export type FailProviderCheckpointOperationInput = typeof FailProviderCheckpointOperationInput.Type;

export const IndeterminateProviderCheckpointOperationInput = FailProviderCheckpointOperationInput;
export type IndeterminateProviderCheckpointOperationInput =
  typeof IndeterminateProviderCheckpointOperationInput.Type;

export const MarkProviderCheckpointFinalizedInput = strict(
  Schema.Struct({
    ...TransitionInput.fields,
    sequence: NonNegativeInt,
  }),
);
export type MarkProviderCheckpointFinalizedInput = typeof MarkProviderCheckpointFinalizedInput.Type;

export const ProviderNativeCheckpoint = strict(
  Schema.Struct({
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    threadId: Schema.NullOr(ThreadId),
    turnId: Schema.NullOr(TurnId),
    repository: ProviderCheckpointRepositoryDiagnostic,
    captureOperationId: CodexCheckpointHelperOperationId,
    checkpointRef: CodexCheckpointHelperCheckpointRef,
    checkpointOid: CodexCheckpointHelperOid,
    treeOid: CodexCheckpointHelperOid,
    receiptRef: CodexCheckpointHelperReceiptRef,
    receiptObjectOid: CodexCheckpointHelperOid,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).check(
    Schema.makeFilter(
      (row) => row.turnId === null || row.threadId !== null || "turnId requires threadId.",
    ),
  ),
);
export type ProviderNativeCheckpoint = typeof ProviderNativeCheckpoint.Type;

export const FinalizeProviderCheckpointCaptureInput = strict(
  Schema.Struct({
    completion: CompleteProviderCheckpointOperationInput,
    checkpoint: ProviderNativeCheckpoint,
  }).check(
    Schema.makeFilter(
      (input) =>
        input.completion.operationId === input.checkpoint.captureOperationId ||
        "Capture operation mismatch.",
    ),
    Schema.makeFilter((input) => {
      const result = input.completion.result;
      if (result?.operation !== "capture") return "Capture finalization requires a capture result.";
      const receipt = result.receipt;
      return (
        (receipt.operationId === input.checkpoint.captureOperationId &&
          receipt.checkpointId === input.checkpoint.logicalCheckpointId &&
          receipt.checkpointRef === input.checkpoint.checkpointRef &&
          receipt.checkpointOid === input.checkpoint.checkpointOid &&
          receipt.treeOid === input.checkpoint.treeOid &&
          receipt.receiptRef === input.checkpoint.receiptRef &&
          result.receiptObjectOid === input.checkpoint.receiptObjectOid &&
          receipt.repositoryFingerprint === input.checkpoint.repository.fingerprint &&
          (input.completion.receipt === null ||
            (input.completion.receipt.operation === "capture" &&
              input.completion.receipt.operationId === receipt.operationId &&
              input.completion.receipt.receiptRef === receipt.receiptRef &&
              input.completion.receipt.requestSha256 === receipt.requestSha256))) ||
        "Capture result and native projection metadata must match exactly."
      );
    }),
  ),
);
export type FinalizeProviderCheckpointCaptureInput =
  typeof FinalizeProviderCheckpointCaptureInput.Type;

export const GetProviderNativeCheckpointInput = strict(
  Schema.Struct({ logicalCheckpointId: CodexCheckpointHelperCheckpointId }),
);
export type GetProviderNativeCheckpointInput = typeof GetProviderNativeCheckpointInput.Type;

export const ListProviderNativeCheckpointsInput = strict(
  Schema.Struct({
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    threadId: Schema.optionalKey(ThreadId),
  }),
);
export type ListProviderNativeCheckpointsInput = typeof ListProviderNativeCheckpointsInput.Type;

export class ProviderCheckpointOperationTransitionError extends Schema.TaggedErrorClass<ProviderCheckpointOperationTransitionError>()(
  "ProviderCheckpointOperationTransitionError",
  {
    operationId: CodexCheckpointHelperOperationId,
    requestedState: CheckpointOperationState,
    currentState: Schema.NullOr(CheckpointOperationState),
  },
) {
  override get message(): string {
    return this.currentState === null
      ? `Checkpoint operation '${this.operationId}' does not exist.`
      : `Checkpoint operation '${this.operationId}' cannot transition from ${this.currentState} to ${this.requestedState}.`;
  }
}

export class ProviderCheckpointIntentConflictError extends Schema.TaggedErrorClass<ProviderCheckpointIntentConflictError>()(
  "ProviderCheckpointIntentConflictError",
  {
    intentKey: CodexCheckpointHelperSha256,
    existingOperationId: CodexCheckpointHelperOperationId,
  },
) {
  override get message(): string {
    return `Checkpoint intent '${this.intentKey}' conflicts with existing operation '${this.existingOperationId}'.`;
  }
}

export class ProviderCheckpointFinalizationError extends Schema.TaggedErrorClass<ProviderCheckpointFinalizationError>()(
  "ProviderCheckpointFinalizationError",
  {
    operationId: CodexCheckpointHelperOperationId,
    currentState: Schema.NullOr(CheckpointOperationState),
    finalizedSequence: Schema.NullOr(NonNegativeInt),
  },
) {
  override get message(): string {
    return `Checkpoint operation '${this.operationId}' cannot be finalized from its current durable state.`;
  }
}

export class ProviderCheckpointProjectionConflictError extends Schema.TaggedErrorClass<ProviderCheckpointProjectionConflictError>()(
  "ProviderCheckpointProjectionConflictError",
  { logicalCheckpointId: CodexCheckpointHelperCheckpointId },
) {
  override get message(): string {
    return `Provider checkpoint projection '${this.logicalCheckpointId}' conflicts with immutable native metadata.`;
  }
}

export class ProviderCheckpointCompletionConflictError extends Schema.TaggedErrorClass<ProviderCheckpointCompletionConflictError>()(
  "ProviderCheckpointCompletionConflictError",
  { operationId: CodexCheckpointHelperOperationId },
) {
  override get message(): string {
    return `Checkpoint completion '${this.operationId}' conflicts with its durable request targets.`;
  }
}

export type ProviderCheckpointOperationRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | ProviderCheckpointOperationTransitionError
  | ProviderCheckpointIntentConflictError
  | ProviderCheckpointFinalizationError
  | ProviderCheckpointProjectionConflictError
  | ProviderCheckpointCompletionConflictError;

export interface GetOrPrepareProviderCheckpointOperationResult {
  readonly operation: ProviderCheckpointOperation;
  readonly inserted: boolean;
}

export interface ProviderCheckpointOperationRepositoryShape {
  readonly prepare: (
    input: PrepareProviderCheckpointOperationInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  /** Dedupe by stable intent and return the original provider/helper ids. */
  readonly getOrPrepare: (
    input: PrepareProviderCheckpointOperationInput,
  ) => Effect.Effect<
    GetOrPrepareProviderCheckpointOperationResult,
    ProviderCheckpointOperationRepositoryError
  >;
  readonly getByIntent: (
    input: GetProviderCheckpointOperationByIntentInput,
  ) => Effect.Effect<
    Option.Option<ProviderCheckpointOperation>,
    ProviderCheckpointOperationRepositoryError
  >;
  readonly markInFlight: (
    input: MarkProviderCheckpointInFlightInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  readonly markOutcomeUnknown: (
    input: MarkProviderCheckpointOutcomeUnknownInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  readonly complete: (
    input: CompleteProviderCheckpointOperationInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  /** Atomically completes capture and materializes its provider-native projection. */
  readonly finalizeCapture: (
    input: FinalizeProviderCheckpointCaptureInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  /** Atomically completes delete and removes every target projection. */
  readonly finalizeDelete: (
    input: CompleteProviderCheckpointOperationInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  readonly fail: (
    input: FailProviderCheckpointOperationInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  readonly markIndeterminate: (
    input: IndeterminateProviderCheckpointOperationInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  /** Marks terminal native state as durably reflected in domain events/projections. */
  readonly markFinalized: (
    input: MarkProviderCheckpointFinalizedInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  readonly getByOperationId: (
    input: GetProviderCheckpointOperationInput,
  ) => Effect.Effect<
    Option.Option<ProviderCheckpointOperation>,
    ProviderCheckpointOperationRepositoryError
  >;
  /** Lists prepared and ambiguous non-terminal rows without implying replay. */
  readonly listPendingRecovery: (
    input: ListPendingProviderCheckpointOperationsInput,
  ) => Effect.Effect<
    ReadonlyArray<ProviderCheckpointOperation>,
    ProviderCheckpointOperationRepositoryError
  >;
  readonly upsertLogicalCheckpoint: (
    checkpoint: ProviderNativeCheckpoint,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
  readonly getLogicalCheckpoint: (
    input: GetProviderNativeCheckpointInput,
  ) => Effect.Effect<
    Option.Option<ProviderNativeCheckpoint>,
    ProviderCheckpointOperationRepositoryError
  >;
  readonly listLogicalCheckpoints: (
    input: ListProviderNativeCheckpointsInput,
  ) => Effect.Effect<
    ReadonlyArray<ProviderNativeCheckpoint>,
    ProviderCheckpointOperationRepositoryError
  >;
  readonly deleteLogicalCheckpoint: (
    input: GetProviderNativeCheckpointInput,
  ) => Effect.Effect<void, ProviderCheckpointOperationRepositoryError>;
}

export class ProviderCheckpointOperationRepository extends Context.Service<
  ProviderCheckpointOperationRepository,
  ProviderCheckpointOperationRepositoryShape
>()("t3/persistence/Services/ProviderCheckpointOperations/ProviderCheckpointOperationRepository") {}
