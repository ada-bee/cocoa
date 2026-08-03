/** Crash-safe, path-free projection of checkpoint revert requests. */
import { CommandId, EventId, IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import { CheckpointRevertSagaId } from "./CheckpointRevertSagas.ts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const MAX_RECOVERY_PAGE = 500;

export const CheckpointRevertIntentState = Schema.Literals(["awaiting_saga", "linked", "terminal"]);
export type CheckpointRevertIntentState = typeof CheckpointRevertIntentState.Type;

export const CheckpointRevertTerminalOutcome = Schema.Literals([
  "completed",
  "failed",
  "indeterminate",
]);
export type CheckpointRevertTerminalOutcome = typeof CheckpointRevertTerminalOutcome.Type;

export const CheckpointRevertIntent = strict(
  Schema.Struct({
    sourceEventId: EventId,
    sourceSequence: NonNegativeInt,
    sourceCommandId: Schema.NullOr(CommandId),
    threadId: ThreadId,
    requestedTurnCount: NonNegativeInt,
    requestedAt: IsoDateTime,
    createdAt: IsoDateTime,
    state: CheckpointRevertIntentState,
    sagaId: Schema.NullOr(CheckpointRevertSagaId),
    terminalOutcome: Schema.NullOr(CheckpointRevertTerminalOutcome),
    terminalAt: Schema.NullOr(IsoDateTime),
  }).check(
    Schema.makeFilter((row) => {
      if (row.state === "awaiting_saga") {
        return (
          (row.sagaId === null && row.terminalOutcome === null && row.terminalAt === null) ||
          "An awaiting revert intent cannot contain saga or terminal state."
        );
      }
      if (row.state === "linked") {
        return (
          (row.sagaId !== null && row.terminalOutcome === null && row.terminalAt === null) ||
          "A linked revert intent requires only its saga id."
        );
      }
      return (
        (row.terminalOutcome !== null &&
          row.terminalAt !== null &&
          (row.terminalOutcome === "failed" || row.sagaId !== null)) ||
        "A terminal revert intent requires an outcome/time and a saga unless it failed pre-saga."
      );
    }),
  ),
);
export type CheckpointRevertIntent = typeof CheckpointRevertIntent.Type;

export const ProjectCheckpointRevertIntentInput = strict(
  Schema.Struct({
    sourceEventId: EventId,
    sourceSequence: NonNegativeInt,
    sourceCommandId: Schema.NullOr(CommandId),
    threadId: ThreadId,
    requestedTurnCount: NonNegativeInt,
    requestedAt: IsoDateTime,
    createdAt: IsoDateTime,
  }),
);
export type ProjectCheckpointRevertIntentInput = typeof ProjectCheckpointRevertIntentInput.Type;

export const GetCheckpointRevertIntentInput = strict(Schema.Struct({ sourceEventId: EventId }));
export type GetCheckpointRevertIntentInput = typeof GetCheckpointRevertIntentInput.Type;

export const LinkCheckpointRevertIntentInput = strict(
  Schema.Struct({ sourceEventId: EventId, sagaId: CheckpointRevertSagaId }),
);
export type LinkCheckpointRevertIntentInput = typeof LinkCheckpointRevertIntentInput.Type;

export const MarkCheckpointRevertIntentTerminalInput = strict(
  Schema.Struct({
    sourceEventId: EventId,
    sagaId: Schema.NullOr(CheckpointRevertSagaId),
    outcome: CheckpointRevertTerminalOutcome,
    terminalAt: IsoDateTime,
  }).check(
    Schema.makeFilter(
      (input) =>
        input.outcome === "failed" ||
        input.sagaId !== null ||
        "Completed and indeterminate revert intents require a saga id.",
    ),
  ),
);
export type MarkCheckpointRevertIntentTerminalInput =
  typeof MarkCheckpointRevertIntentTerminalInput.Type;

export const CheckpointRevertIntentRecoveryCursor = strict(
  Schema.Struct({ sourceSequence: NonNegativeInt, sourceEventId: EventId }),
);
export type CheckpointRevertIntentRecoveryCursor = typeof CheckpointRevertIntentRecoveryCursor.Type;

export const ListCheckpointRevertIntentRecoveryInput = strict(
  Schema.Struct({
    after: Schema.NullOr(CheckpointRevertIntentRecoveryCursor),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RECOVERY_PAGE })),
  }),
);
export type ListCheckpointRevertIntentRecoveryInput =
  typeof ListCheckpointRevertIntentRecoveryInput.Type;

export class CheckpointRevertIntentConflictError extends Schema.TaggedErrorClass<CheckpointRevertIntentConflictError>()(
  "CheckpointRevertIntentConflictError",
  { sourceEventId: EventId },
) {
  override get message(): string {
    return `Checkpoint revert intent '${this.sourceEventId}' conflicts with durable state.`;
  }
}

export class CheckpointRevertIntentTransitionError extends Schema.TaggedErrorClass<CheckpointRevertIntentTransitionError>()(
  "CheckpointRevertIntentTransitionError",
  {
    sourceEventId: EventId,
    state: Schema.NullOr(CheckpointRevertIntentState),
    sagaId: Schema.NullOr(CheckpointRevertSagaId),
  },
) {
  override get message(): string {
    return `Checkpoint revert intent '${this.sourceEventId}' cannot transition from its current durable state.`;
  }
}

export type CheckpointRevertIntentRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | CheckpointRevertIntentConflictError
  | CheckpointRevertIntentTransitionError;

export interface CheckpointRevertIntentRepositoryShape {
  /** Exact idempotent insert inside the event projector transaction. */
  readonly projectInTransaction: (
    input: ProjectCheckpointRevertIntentInput,
  ) => Effect.Effect<CheckpointRevertIntent, CheckpointRevertIntentRepositoryError>;
  readonly getBySourceEventId: (
    input: GetCheckpointRevertIntentInput,
  ) => Effect.Effect<Option.Option<CheckpointRevertIntent>, CheckpointRevertIntentRepositoryError>;
  /** CAS-links the deterministic saga id; exact repeats are idempotent. */
  readonly linkSaga: (
    input: LinkCheckpointRevertIntentInput,
  ) => Effect.Effect<CheckpointRevertIntent, CheckpointRevertIntentRepositoryError>;
  /** CAS-terminalizes an exact saga, or records a deterministic pre-saga failure. */
  readonly markTerminal: (
    input: MarkCheckpointRevertIntentTerminalInput,
  ) => Effect.Effect<void, CheckpointRevertIntentRepositoryError>;
  /** Stable bounded recovery scan; terminal intents are excluded. */
  readonly listRecovery: (
    input: ListCheckpointRevertIntentRecoveryInput,
  ) => Effect.Effect<ReadonlyArray<CheckpointRevertIntent>, CheckpointRevertIntentRepositoryError>;
}

export class CheckpointRevertIntentRepository extends Context.Service<
  CheckpointRevertIntentRepository,
  CheckpointRevertIntentRepositoryShape
>()("t3/persistence/Services/CheckpointRevertIntents/CheckpointRevertIntentRepository") {}
