/** Durable, path-free post-turn checkpoint work projected from completion events. */
import {
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperOperationId,
  EventId,
  IsoDateTime,
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
import {
  TurnDispatchBaselineNotApplicableReason,
  TurnDispatchProviderTurnId,
} from "./TurnDispatchJournal.ts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const MAX_RECOVERY_PAGE = 500;

export const PostTurnCheckpointIntentState = Schema.Literals([
  "awaiting_dispatch",
  "bound",
  "uncorrelatable",
]);
export type PostTurnCheckpointIntentState = typeof PostTurnCheckpointIntentState.Type;

export const PostTurnCheckpointOutcome = Schema.Literals(["completed", "interrupted", "failed"]);
export type PostTurnCheckpointOutcome = typeof PostTurnCheckpointOutcome.Type;

export const PostTurnCheckpointIntent = strict(
  Schema.Struct({
    sourceEventId: EventId,
    sourceSequence: NonNegativeInt,
    threadId: ThreadId,
    turnId: TurnId,
    providerTurnId: Schema.NullOr(TurnDispatchProviderTurnId),
    outcome: PostTurnCheckpointOutcome,
    completedAt: IsoDateTime,
    state: PostTurnCheckpointIntentState,
    providerInstanceId: Schema.NullOr(ProviderInstanceId),
    projectId: Schema.NullOr(ProjectId),
    baselineCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
    checkpointTurnCount: Schema.NullOr(NonNegativeInt),
    baselineLogicalCheckpointId: Schema.NullOr(CodexCheckpointHelperCheckpointId),
    baselineNotApplicableReason: Schema.NullOr(TurnDispatchBaselineNotApplicableReason),
    operationId: Schema.NullOr(CodexCheckpointHelperOperationId),
    logicalCheckpointId: Schema.NullOr(CodexCheckpointHelperCheckpointId),
    finalizedSequence: Schema.NullOr(NonNegativeInt),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).check(
    Schema.makeFilter((row) => {
      if (row.state === "uncorrelatable") {
        return (
          (row.providerTurnId === null &&
            row.providerInstanceId === null &&
            row.projectId === null &&
            row.baselineCheckpointTurnCount === null &&
            row.checkpointTurnCount === null &&
            row.operationId === null &&
            row.logicalCheckpointId === null &&
            row.finalizedSequence === 0) ||
          "An uncorrelatable completion must remain path-free and terminal."
        );
      }
      if (row.state === "awaiting_dispatch") {
        return (
          (row.providerTurnId !== null &&
            row.providerInstanceId === null &&
            row.projectId === null &&
            row.baselineCheckpointTurnCount === null &&
            row.checkpointTurnCount === null &&
            row.operationId === null &&
            row.logicalCheckpointId === null &&
            row.finalizedSequence === null) ||
          "An awaiting completion may contain only its provider turn identity."
        );
      }
      return (
        (row.providerTurnId !== null &&
          row.providerInstanceId !== null &&
          row.projectId !== null &&
          row.baselineCheckpointTurnCount !== null &&
          row.checkpointTurnCount === row.baselineCheckpointTurnCount + 1 &&
          row.operationId !== null &&
          row.logicalCheckpointId !== null &&
          ((row.baselineLogicalCheckpointId !== null && row.baselineNotApplicableReason === null) ||
            (row.baselineLogicalCheckpointId === null &&
              row.baselineNotApplicableReason !== null))) ||
        "A bound completion requires one exact baseline disposition and target identity."
      );
    }),
  ),
);
export type PostTurnCheckpointIntent = typeof PostTurnCheckpointIntent.Type;

export const ProjectPostTurnCheckpointIntentInput = strict(
  Schema.Struct({
    sourceEventId: EventId,
    sourceSequence: NonNegativeInt,
    threadId: ThreadId,
    turnId: TurnId,
    providerTurnId: Schema.NullOr(TurnDispatchProviderTurnId),
    outcome: PostTurnCheckpointOutcome,
    completedAt: IsoDateTime,
  }),
);
export type ProjectPostTurnCheckpointIntentInput = typeof ProjectPostTurnCheckpointIntentInput.Type;

export const GetPostTurnCheckpointIntentInput = strict(Schema.Struct({ sourceEventId: EventId }));
export type GetPostTurnCheckpointIntentInput = typeof GetPostTurnCheckpointIntentInput.Type;

export const BindPostTurnCheckpointIntentInput = strict(
  Schema.Struct({
    sourceEventId: EventId,
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    baselineCheckpointTurnCount: NonNegativeInt,
    checkpointTurnCount: NonNegativeInt,
    baselineLogicalCheckpointId: Schema.NullOr(CodexCheckpointHelperCheckpointId),
    baselineNotApplicableReason: Schema.NullOr(TurnDispatchBaselineNotApplicableReason),
    operationId: CodexCheckpointHelperOperationId,
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    updatedAt: IsoDateTime,
  }).check(
    Schema.makeFilter(
      (input) =>
        input.checkpointTurnCount === input.baselineCheckpointTurnCount + 1 ||
        "The target checkpoint count must be exactly baseline N + 1.",
    ),
    Schema.makeFilter(
      (input) =>
        (input.baselineLogicalCheckpointId !== null &&
          input.baselineNotApplicableReason === null) ||
        (input.baselineLogicalCheckpointId === null &&
          input.baselineNotApplicableReason !== null) ||
        "Binding requires exactly one baseline disposition.",
    ),
  ),
);
export type BindPostTurnCheckpointIntentInput = typeof BindPostTurnCheckpointIntentInput.Type;

export const FinalizePostTurnCheckpointIntentInput = strict(
  Schema.Struct({
    sourceEventId: EventId,
    sequence: NonNegativeInt,
    updatedAt: IsoDateTime,
  }),
);
export type FinalizePostTurnCheckpointIntentInput =
  typeof FinalizePostTurnCheckpointIntentInput.Type;

export const PostTurnCheckpointRecoveryCursor = strict(
  Schema.Struct({ sourceSequence: NonNegativeInt, sourceEventId: EventId }),
);
export type PostTurnCheckpointRecoveryCursor = typeof PostTurnCheckpointRecoveryCursor.Type;

export const ListPostTurnCheckpointRecoveryInput = strict(
  Schema.Struct({
    providerInstanceId: Schema.optionalKey(ProviderInstanceId),
    after: Schema.optionalKey(PostTurnCheckpointRecoveryCursor),
    limit: NonNegativeInt.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_RECOVERY_PAGE),
    ),
  }),
);
export type ListPostTurnCheckpointRecoveryInput = typeof ListPostTurnCheckpointRecoveryInput.Type;

export class PostTurnCheckpointIntentConflictError extends Schema.TaggedErrorClass<PostTurnCheckpointIntentConflictError>()(
  "PostTurnCheckpointIntentConflictError",
  { sourceEventId: EventId },
) {
  override get message(): string {
    return `Post-turn checkpoint intent '${this.sourceEventId}' conflicts with durable state.`;
  }
}

export class PostTurnCheckpointIntentFinalizationError extends Schema.TaggedErrorClass<PostTurnCheckpointIntentFinalizationError>()(
  "PostTurnCheckpointIntentFinalizationError",
  {
    sourceEventId: EventId,
    state: Schema.NullOr(PostTurnCheckpointIntentState),
    finalizedSequence: Schema.NullOr(NonNegativeInt),
  },
) {
  override get message(): string {
    return `Post-turn checkpoint intent '${this.sourceEventId}' cannot be finalized from its current state.`;
  }
}

export type PostTurnCheckpointIntentRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | PostTurnCheckpointIntentConflictError
  | PostTurnCheckpointIntentFinalizationError;

export interface PostTurnCheckpointIntentRepositoryShape {
  /** Idempotent ambient-transaction insert used by the checkpoint projector. */
  readonly projectInTransaction: (
    input: ProjectPostTurnCheckpointIntentInput,
  ) => Effect.Effect<PostTurnCheckpointIntent, PostTurnCheckpointIntentRepositoryError>;
  readonly getBySourceEventId: (
    input: GetPostTurnCheckpointIntentInput,
  ) => Effect.Effect<
    Option.Option<PostTurnCheckpointIntent>,
    PostTurnCheckpointIntentRepositoryError
  >;
  /** CAS-binds the completion to the immutable exact started-dispatch identity. */
  readonly bind: (
    input: BindPostTurnCheckpointIntentInput,
  ) => Effect.Effect<PostTurnCheckpointIntent, PostTurnCheckpointIntentRepositoryError>;
  /** Idempotent only for the exact same domain-event sequence. */
  readonly markFinalized: (
    input: FinalizePostTurnCheckpointIntentInput,
  ) => Effect.Effect<void, PostTurnCheckpointIntentRepositoryError>;
  /** Keyset-paginated deterministic scan of every unfinished completion. */
  readonly listRecovery: (
    input: ListPostTurnCheckpointRecoveryInput,
  ) => Effect.Effect<
    ReadonlyArray<PostTurnCheckpointIntent>,
    PostTurnCheckpointIntentRepositoryError
  >;
}

export class PostTurnCheckpointIntentRepository extends Context.Service<
  PostTurnCheckpointIntentRepository,
  PostTurnCheckpointIntentRepositoryShape
>()("t3/persistence/Services/PostTurnCheckpointIntents/PostTurnCheckpointIntentRepository") {}
