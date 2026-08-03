/** Durable, path-free persistence contract for provider checkpoint revert sagas. */
import {
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperObjectFormat,
  CodexCheckpointHelperOid,
  CodexCheckpointHelperOperationId,
  CodexCheckpointHelperSha256,
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import { ProviderCheckpointOperationError } from "./ProviderCheckpointOperations.ts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

export const CheckpointRevertSagaId = CodexCheckpointHelperSha256;
export type CheckpointRevertSagaId = typeof CheckpointRevertSagaId.Type;

export const CheckpointRevertSagaState = Schema.Literals([
  "prepared",
  "rollback_in_flight",
  "rollback_completed",
  "restoring",
  "restored",
  "domain_finalized",
  "completed",
  "failed",
  "rollback_outcome_unknown",
  "indeterminate",
]);
export type CheckpointRevertSagaState = typeof CheckpointRevertSagaState.Type;

export const CheckpointRevertTurnDigest = strict(
  Schema.Struct({
    count: NonNegativeInt.check(Schema.isLessThanOrEqualTo(100_000)),
    sha256: CodexCheckpointHelperSha256,
  }),
);
export type CheckpointRevertTurnDigest = typeof CheckpointRevertTurnDigest.Type;

export const CheckpointRevertStaleTarget = strict(
  Schema.Struct({
    sagaId: CheckpointRevertSagaId,
    ordinal: NonNegativeInt,
    batchOrdinal: NonNegativeInt,
    checkpointTurnCount: NonNegativeInt,
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    expectedCheckpointOid: CodexCheckpointHelperOid,
    deleteOperationId: CodexCheckpointHelperOperationId,
  }).check(
    Schema.makeFilter(
      (target) =>
        target.batchOrdinal === Math.floor(target.ordinal / 256) ||
        "Stale target batchOrdinal must be floor(ordinal / 256).",
    ),
  ),
);
export type CheckpointRevertStaleTarget = typeof CheckpointRevertStaleTarget.Type;

export const CheckpointRevertStaleTargetInput = strict(
  Schema.Struct({
    checkpointTurnCount: NonNegativeInt,
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    expectedCheckpointOid: CodexCheckpointHelperOid,
  }),
);
export type CheckpointRevertStaleTargetInput = typeof CheckpointRevertStaleTargetInput.Type;

export const CheckpointRevertSaga = strict(
  Schema.Struct({
    sagaId: CheckpointRevertSagaId,
    sourceRevertEventId: EventId,
    sourceCommandId: Schema.NullOr(CommandId),
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    threadId: ThreadId,
    providerDriverKind: ProviderDriverKind,
    continuationIdentitySha256: CodexCheckpointHelperSha256,
    requestedTurnCount: NonNegativeInt,
    preimageTurnCount: NonNegativeInt,
    preimage: CheckpointRevertTurnDigest,
    target: CheckpointRevertTurnDigest,
    retainedLogicalCheckpointId: CodexCheckpointHelperCheckpointId,
    retainedExpectedCheckpointOid: CodexCheckpointHelperOid,
    repositoryFingerprint: CodexCheckpointHelperSha256,
    repositoryObjectFormat: CodexCheckpointHelperObjectFormat,
    restoreOperationId: CodexCheckpointHelperOperationId,
    state: CheckpointRevertSagaState,
    error: Schema.NullOr(ProviderCheckpointOperationError),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    finalizationStartedAt: Schema.NullOr(IsoDateTime),
    finalizationSequence: Schema.NullOr(NonNegativeInt),
    completedAt: Schema.NullOr(IsoDateTime),
  }).check(
    Schema.makeFilter(
      (saga) =>
        saga.preimage.count === saga.preimageTurnCount ||
        "Preimage digest count must equal preimageTurnCount.",
    ),
    Schema.makeFilter(
      (saga) =>
        saga.target.count === saga.requestedTurnCount ||
        "Target digest count must equal requestedTurnCount.",
    ),
    Schema.makeFilter(
      (saga) =>
        saga.requestedTurnCount <= saga.preimageTurnCount ||
        "requestedTurnCount must not exceed preimageTurnCount.",
    ),
  ),
);
export type CheckpointRevertSaga = typeof CheckpointRevertSaga.Type;

export const CreateCheckpointRevertSagaInput = strict(
  Schema.Struct({
    sourceRevertEventId: EventId,
    sourceCommandId: Schema.NullOr(CommandId),
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    threadId: ThreadId,
    providerDriverKind: ProviderDriverKind,
    continuationIdentitySha256: CodexCheckpointHelperSha256,
    requestedTurnCount: NonNegativeInt,
    preimageTurnCount: NonNegativeInt,
    preimage: CheckpointRevertTurnDigest,
    target: CheckpointRevertTurnDigest,
    retainedLogicalCheckpointId: CodexCheckpointHelperCheckpointId,
    retainedExpectedCheckpointOid: CodexCheckpointHelperOid,
    repositoryFingerprint: CodexCheckpointHelperSha256,
    repositoryObjectFormat: CodexCheckpointHelperObjectFormat,
    restoreOperationId: CodexCheckpointHelperOperationId,
    staleTargets: Schema.Array(CheckpointRevertStaleTargetInput).check(Schema.isMaxLength(100_000)),
    createdAt: IsoDateTime,
  }).check(
    Schema.makeFilter(
      (input) =>
        input.preimage.count === input.preimageTurnCount ||
        "Preimage digest count must equal preimageTurnCount.",
    ),
    Schema.makeFilter(
      (input) =>
        input.target.count === input.requestedTurnCount ||
        "Target digest count must equal requestedTurnCount.",
    ),
    Schema.makeFilter(
      (input) =>
        input.requestedTurnCount <= input.preimageTurnCount ||
        "requestedTurnCount must not exceed preimageTurnCount.",
    ),
    Schema.makeFilter(
      (input) =>
        input.staleTargets.every(
          (target) =>
            target.logicalCheckpointId !== input.retainedLogicalCheckpointId &&
            target.checkpointTurnCount > input.requestedTurnCount &&
            target.checkpointTurnCount <= input.preimageTurnCount,
        ) || "Stale targets must follow and exclude the retained checkpoint.",
    ),
    Schema.makeFilter(
      (input) =>
        new Set(input.staleTargets.map((target) => target.logicalCheckpointId)).size ===
          input.staleTargets.length || "Stale logical checkpoint ids must be unique.",
    ),
  ),
);
export type CreateCheckpointRevertSagaInput = typeof CreateCheckpointRevertSagaInput.Type;

export interface GetOrCreateCheckpointRevertSagaResult {
  readonly saga: CheckpointRevertSaga;
  readonly staleTargets: ReadonlyArray<CheckpointRevertStaleTarget>;
  readonly inserted: boolean;
}

export const GetCheckpointRevertSagaInput = strict(
  Schema.Struct({ sagaId: CheckpointRevertSagaId }),
);
export type GetCheckpointRevertSagaInput = typeof GetCheckpointRevertSagaInput.Type;

export const GetCheckpointRevertSagaBySourceInput = strict(
  Schema.Struct({ sourceRevertEventId: EventId }),
);
export type GetCheckpointRevertSagaBySourceInput = typeof GetCheckpointRevertSagaBySourceInput.Type;

export const GetActiveCheckpointRevertSagaByThreadInput = strict(
  Schema.Struct({ threadId: ThreadId }),
);
export type GetActiveCheckpointRevertSagaByThreadInput =
  typeof GetActiveCheckpointRevertSagaByThreadInput.Type;

export const ListCheckpointRevertStaleTargetsInput = GetCheckpointRevertSagaInput;
export type ListCheckpointRevertStaleTargetsInput =
  typeof ListCheckpointRevertStaleTargetsInput.Type;

export const CheckpointRevertRecoveryCursor = strict(
  Schema.Struct({ createdAt: IsoDateTime, sagaId: CheckpointRevertSagaId }),
);
export type CheckpointRevertRecoveryCursor = typeof CheckpointRevertRecoveryCursor.Type;

export const ListCheckpointRevertRecoveryInput = strict(
  Schema.Struct({
    after: Schema.NullOr(CheckpointRevertRecoveryCursor),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
  }),
);
export type ListCheckpointRevertRecoveryInput = typeof ListCheckpointRevertRecoveryInput.Type;

export interface ListCheckpointRevertRecoveryResult {
  readonly items: ReadonlyArray<CheckpointRevertSaga>;
  readonly nextCursor: CheckpointRevertRecoveryCursor | null;
}

const SagaTransitionInput = strict(
  Schema.Struct({ sagaId: CheckpointRevertSagaId, updatedAt: IsoDateTime }),
);

export const CheckpointRevertSagaTransitionInput = SagaTransitionInput;
export type CheckpointRevertSagaTransitionInput = typeof CheckpointRevertSagaTransitionInput.Type;

export const CheckpointRevertSagaErrorTransitionInput = strict(
  Schema.Struct({
    ...SagaTransitionInput.fields,
    error: ProviderCheckpointOperationError,
  }),
);
export type CheckpointRevertSagaErrorTransitionInput =
  typeof CheckpointRevertSagaErrorTransitionInput.Type;

export const BeginCheckpointRevertFinalizationInput = strict(
  Schema.Struct({
    sagaId: CheckpointRevertSagaId,
    finalizationStartedAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
);
export type BeginCheckpointRevertFinalizationInput =
  typeof BeginCheckpointRevertFinalizationInput.Type;

export const FinalizeCheckpointRevertDomainInput = strict(
  Schema.Struct({
    sagaId: CheckpointRevertSagaId,
    sequence: NonNegativeInt,
    updatedAt: IsoDateTime,
  }),
);
export type FinalizeCheckpointRevertDomainInput = typeof FinalizeCheckpointRevertDomainInput.Type;

export const CompleteCheckpointRevertSagaInput = strict(
  Schema.Struct({
    sagaId: CheckpointRevertSagaId,
    completedAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
);
export type CompleteCheckpointRevertSagaInput = typeof CompleteCheckpointRevertSagaInput.Type;

export class CheckpointRevertSagaConflictError extends Schema.TaggedErrorClass<CheckpointRevertSagaConflictError>()(
  "CheckpointRevertSagaConflictError",
  { sourceRevertEventId: EventId, sagaId: CheckpointRevertSagaId },
) {
  override get message(): string {
    return `Checkpoint revert intent '${this.sourceRevertEventId}' conflicts with saga '${this.sagaId}'.`;
  }
}

export class CheckpointRevertSagaTransitionError extends Schema.TaggedErrorClass<CheckpointRevertSagaTransitionError>()(
  "CheckpointRevertSagaTransitionError",
  {
    sagaId: CheckpointRevertSagaId,
    requestedState: CheckpointRevertSagaState,
    currentState: Schema.NullOr(CheckpointRevertSagaState),
  },
) {
  override get message(): string {
    return this.currentState === null
      ? `Checkpoint revert saga '${this.sagaId}' does not exist.`
      : `Checkpoint revert saga '${this.sagaId}' cannot transition from ${this.currentState} to ${this.requestedState}.`;
  }
}

export class CheckpointRevertActiveSagaConflictError extends Schema.TaggedErrorClass<CheckpointRevertActiveSagaConflictError>()(
  "CheckpointRevertActiveSagaConflictError",
  { threadId: ThreadId, activeSagaId: CheckpointRevertSagaId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' already has active checkpoint revert saga '${this.activeSagaId}'.`;
  }
}

export type CheckpointRevertSagaRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | CheckpointRevertSagaConflictError
  | CheckpointRevertActiveSagaConflictError
  | CheckpointRevertSagaTransitionError;

export interface CheckpointRevertSagaRepositoryShape {
  readonly getOrCreate: (
    input: CreateCheckpointRevertSagaInput,
  ) => Effect.Effect<GetOrCreateCheckpointRevertSagaResult, CheckpointRevertSagaRepositoryError>;
  readonly getBySagaId: (
    input: GetCheckpointRevertSagaInput,
  ) => Effect.Effect<Option.Option<CheckpointRevertSaga>, CheckpointRevertSagaRepositoryError>;
  readonly getBySourceEventId: (
    input: GetCheckpointRevertSagaBySourceInput,
  ) => Effect.Effect<Option.Option<CheckpointRevertSaga>, CheckpointRevertSagaRepositoryError>;
  readonly getActiveByThread: (
    input: GetActiveCheckpointRevertSagaByThreadInput,
  ) => Effect.Effect<Option.Option<CheckpointRevertSaga>, CheckpointRevertSagaRepositoryError>;
  readonly listStaleTargets: (
    input: ListCheckpointRevertStaleTargetsInput,
  ) => Effect.Effect<
    ReadonlyArray<CheckpointRevertStaleTarget>,
    CheckpointRevertSagaRepositoryError
  >;
  readonly listRecoveryPage: (
    input: ListCheckpointRevertRecoveryInput,
  ) => Effect.Effect<ListCheckpointRevertRecoveryResult, CheckpointRevertSagaRepositoryError>;
  readonly markRollbackInFlight: (
    input: CheckpointRevertSagaTransitionInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
  readonly markRollbackCompleted: (
    input: CheckpointRevertSagaTransitionInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
  readonly markRestoring: (
    input: CheckpointRevertSagaTransitionInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
  readonly markRestored: (
    input: CheckpointRevertSagaTransitionInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
  readonly failBeforeRollback: (
    input: CheckpointRevertSagaErrorTransitionInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
  readonly markRollbackOutcomeUnknown: (
    input: CheckpointRevertSagaErrorTransitionInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
  readonly markIndeterminate: (
    input: CheckpointRevertSagaErrorTransitionInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
  readonly beginDomainFinalization: (
    input: BeginCheckpointRevertFinalizationInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
  readonly markDomainFinalized: (
    input: FinalizeCheckpointRevertDomainInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
  readonly complete: (
    input: CompleteCheckpointRevertSagaInput,
  ) => Effect.Effect<void, CheckpointRevertSagaRepositoryError>;
}

export class CheckpointRevertSagaRepository extends Context.Service<
  CheckpointRevertSagaRepository,
  CheckpointRevertSagaRepositoryShape
>()("t3/persistence/Services/CheckpointRevertSagas/CheckpointRevertSagaRepository") {}
