/**
 * Durable, path-free intent journal for provider turn dispatch.
 *
 * Message bodies and attachments remain in the orchestration event store. The
 * journal identifies that immutable input by message/event id and persists the
 * bounded provider settings needed to reject drift during recovery.
 */
import {
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperOperationId,
  CodexCheckpointHelperSha256,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const BOUNDED_MODEL_SELECTION_BYTES = 8_192;
const MAX_RECOVERY_PAGE = 500;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

const BoundedModelSelection = ModelSelection.check(
  Schema.makeFilter(
    (selection) =>
      Buffer.byteLength(stableJson(selection), "utf8") <= BOUNDED_MODEL_SELECTION_BYTES ||
      `Model selection exceeds ${BOUNDED_MODEL_SELECTION_BYTES} bytes.`,
  ),
);

export const TurnDispatchId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9:._-]+$/),
).pipe(Schema.brand("TurnDispatchId"));
export type TurnDispatchId = typeof TurnDispatchId.Type;

export const TurnDispatchState = Schema.Literals([
  "awaiting_baseline",
  "baseline_ready",
  "baseline_not_applicable",
  "provider_in_flight",
  "started",
  "failed",
  "indeterminate",
]);
export type TurnDispatchState = typeof TurnDispatchState.Type;

export const TurnDispatchBaselineNotApplicableReason = Schema.Literals([
  "not_repository",
  "capability_unavailable",
]);
export type TurnDispatchBaselineNotApplicableReason =
  typeof TurnDispatchBaselineNotApplicableReason.Type;

const SafeSummary = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => {
    const hasControl = Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
    return (
      (!hasControl && !value.includes("/") && !value.includes("\\")) ||
      "Turn dispatch error summaries must be single-line and path-free."
    );
  }),
);

/** Deliberately excludes causes, stderr, request payloads, credentials, and paths. */
export const TurnDispatchError = strict(
  Schema.Struct({
    code: Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(64),
      Schema.isPattern(/^[a-z0-9_]+$/),
    ),
    summary: Schema.optionalKey(SafeSummary),
  }),
);
export type TurnDispatchError = typeof TurnDispatchError.Type;

export const TurnDispatchProviderTurnId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => {
    const hasControl = Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
    return (
      (!hasControl && !value.includes("/") && !value.includes("\\")) ||
      "Provider turn ids must be single-line and path-free."
    );
  }),
);
export type TurnDispatchProviderTurnId = typeof TurnDispatchProviderTurnId.Type;

export const TurnDispatchJournalEntry = strict(
  Schema.Struct({
    dispatchId: TurnDispatchId,
    intentKey: CodexCheckpointHelperSha256,
    sourceEventId: EventId,
    sourceCommandId: Schema.NullOr(CommandId),
    threadId: ThreadId,
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    messageId: MessageId,
    checkpointTurnCount: NonNegativeInt,
    modelSelection: BoundedModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    titleSeedSha256: Schema.NullOr(CodexCheckpointHelperSha256),
    baselineLogicalCheckpointId: Schema.NullOr(CodexCheckpointHelperCheckpointId),
    baselineOperationId: Schema.NullOr(CodexCheckpointHelperOperationId),
    baselineNotApplicableReason: Schema.NullOr(TurnDispatchBaselineNotApplicableReason),
    state: TurnDispatchState,
    providerTurnId: Schema.NullOr(TurnDispatchProviderTurnId),
    error: Schema.NullOr(TurnDispatchError),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    finalizedSequence: Schema.NullOr(NonNegativeInt),
  }).check(
    Schema.makeFilter(
      (row) =>
        (row.baselineLogicalCheckpointId === null) === (row.baselineOperationId === null) ||
        "Baseline checkpoint identity must be stored as a pair.",
    ),
    Schema.makeFilter(
      (row) =>
        row.baselineNotApplicableReason === null ||
        row.baselineLogicalCheckpointId === null ||
        "A checkpoint baseline and not-applicable reason are mutually exclusive.",
    ),
    Schema.makeFilter((row) => {
      switch (row.state) {
        case "awaiting_baseline":
          return (
            (row.baselineLogicalCheckpointId === null &&
              row.providerTurnId === null &&
              row.baselineNotApplicableReason === null &&
              row.error === null) ||
            "An awaiting dispatch cannot contain baseline, provider-turn, or error state."
          );
        case "baseline_ready":
          return (
            (row.baselineLogicalCheckpointId !== null &&
              row.baselineNotApplicableReason === null &&
              row.providerTurnId === null &&
              row.error === null) ||
            "A ready dispatch requires a baseline and no result state."
          );
        case "baseline_not_applicable":
          return (
            (row.baselineLogicalCheckpointId === null &&
              row.baselineNotApplicableReason !== null &&
              row.providerTurnId === null &&
              row.error === null) ||
            "A not-applicable dispatch requires an explicit bounded reason."
          );
        case "provider_in_flight":
          return (
            (((row.baselineLogicalCheckpointId !== null &&
              row.baselineNotApplicableReason === null) ||
              (row.baselineLogicalCheckpointId === null &&
                row.baselineNotApplicableReason !== null)) &&
              row.providerTurnId === null &&
              row.error === null) ||
            "An in-flight dispatch requires a proven baseline disposition."
          );
        case "started":
          return (
            (((row.baselineLogicalCheckpointId !== null &&
              row.baselineNotApplicableReason === null) ||
              (row.baselineLogicalCheckpointId === null &&
                row.baselineNotApplicableReason !== null)) &&
              row.providerTurnId !== null &&
              row.error === null) ||
            "A started dispatch requires a baseline disposition and provider turn identity."
          );
        case "failed":
          return (
            (row.providerTurnId === null && row.error !== null) ||
            "A failed dispatch requires a sanitized error and no provider turn id."
          );
        case "indeterminate":
          return (
            (((row.baselineLogicalCheckpointId !== null &&
              row.baselineNotApplicableReason === null) ||
              (row.baselineLogicalCheckpointId === null &&
                row.baselineNotApplicableReason !== null)) &&
              row.error !== null) ||
            "An indeterminate dispatch requires a baseline disposition and sanitized error."
          );
      }
    }),
    Schema.makeFilter(
      (row) =>
        row.finalizedSequence === null ||
        row.state === "started" ||
        row.state === "failed" ||
        row.state === "indeterminate" ||
        "Only terminal dispatches may be finalized.",
    ),
  ),
);
export type TurnDispatchJournalEntry = typeof TurnDispatchJournalEntry.Type;

export const PrepareTurnDispatchInput = strict(
  Schema.Struct({
    dispatchId: TurnDispatchId,
    sourceEventId: EventId,
    sourceCommandId: Schema.NullOr(CommandId),
    threadId: ThreadId,
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    messageId: MessageId,
    checkpointTurnCount: NonNegativeInt,
    modelSelection: BoundedModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    /** Hash of the exact title seed; the possibly user-authored title is not journaled. */
    titleSeedSha256: Schema.NullOr(CodexCheckpointHelperSha256),
    createdAt: IsoDateTime,
  }),
);
export type PrepareTurnDispatchInput = typeof PrepareTurnDispatchInput.Type;

export const GetTurnDispatchInput = strict(Schema.Struct({ dispatchId: TurnDispatchId }));
export type GetTurnDispatchInput = typeof GetTurnDispatchInput.Type;

export const GetTurnDispatchByIntentInput = strict(Schema.Struct({ sourceEventId: EventId }));
export type GetTurnDispatchByIntentInput = typeof GetTurnDispatchByIntentInput.Type;

export const GetStartedTurnDispatchInput = strict(
  Schema.Struct({ threadId: ThreadId, providerTurnId: TurnDispatchProviderTurnId }),
);
export type GetStartedTurnDispatchInput = typeof GetStartedTurnDispatchInput.Type;

const TransitionInput = strict(
  Schema.Struct({ dispatchId: TurnDispatchId, updatedAt: IsoDateTime }),
);

export const MarkTurnDispatchBaselineReadyInput = strict(
  Schema.Struct({
    ...TransitionInput.fields,
    baselineLogicalCheckpointId: CodexCheckpointHelperCheckpointId,
    baselineOperationId: CodexCheckpointHelperOperationId,
  }),
);
export type MarkTurnDispatchBaselineReadyInput = typeof MarkTurnDispatchBaselineReadyInput.Type;

export const MarkTurnDispatchBaselineNotApplicableInput = strict(
  Schema.Struct({
    ...TransitionInput.fields,
    reason: TurnDispatchBaselineNotApplicableReason,
  }),
);
export type MarkTurnDispatchBaselineNotApplicableInput =
  typeof MarkTurnDispatchBaselineNotApplicableInput.Type;

export const MarkTurnDispatchProviderInFlightInput = TransitionInput;
export type MarkTurnDispatchProviderInFlightInput =
  typeof MarkTurnDispatchProviderInFlightInput.Type;

export const MarkTurnDispatchStartedInput = strict(
  Schema.Struct({ ...TransitionInput.fields, providerTurnId: TurnDispatchProviderTurnId }),
);
export type MarkTurnDispatchStartedInput = typeof MarkTurnDispatchStartedInput.Type;

export const MarkTurnDispatchFailedInput = strict(
  Schema.Struct({ ...TransitionInput.fields, error: TurnDispatchError }),
);
export type MarkTurnDispatchFailedInput = typeof MarkTurnDispatchFailedInput.Type;

export const MarkTurnDispatchIndeterminateInput = MarkTurnDispatchFailedInput;
export type MarkTurnDispatchIndeterminateInput = typeof MarkTurnDispatchIndeterminateInput.Type;

export const MarkTurnDispatchFinalizedInput = strict(
  Schema.Struct({ ...TransitionInput.fields, sequence: NonNegativeInt }),
);
export type MarkTurnDispatchFinalizedInput = typeof MarkTurnDispatchFinalizedInput.Type;

export const TurnDispatchRecoveryCursor = strict(
  Schema.Struct({ createdAt: IsoDateTime, dispatchId: TurnDispatchId }),
);
export type TurnDispatchRecoveryCursor = typeof TurnDispatchRecoveryCursor.Type;

export const ListTurnDispatchRecoveryInput = strict(
  Schema.Struct({
    providerInstanceId: Schema.optionalKey(ProviderInstanceId),
    after: Schema.optionalKey(TurnDispatchRecoveryCursor),
    limit: NonNegativeInt.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_RECOVERY_PAGE),
    ),
  }),
);
export type ListTurnDispatchRecoveryInput = typeof ListTurnDispatchRecoveryInput.Type;

export class TurnDispatchTransitionError extends Schema.TaggedErrorClass<TurnDispatchTransitionError>()(
  "TurnDispatchTransitionError",
  {
    dispatchId: TurnDispatchId,
    requestedState: TurnDispatchState,
    currentState: Schema.NullOr(TurnDispatchState),
  },
) {
  override get message(): string {
    return this.currentState === null
      ? `Turn dispatch '${this.dispatchId}' does not exist.`
      : `Turn dispatch '${this.dispatchId}' cannot transition from ${this.currentState} to ${this.requestedState}.`;
  }
}

export class TurnDispatchIntentConflictError extends Schema.TaggedErrorClass<TurnDispatchIntentConflictError>()(
  "TurnDispatchIntentConflictError",
  {
    intentKey: CodexCheckpointHelperSha256,
    existingDispatchId: TurnDispatchId,
  },
) {
  override get message(): string {
    return `Turn dispatch intent '${this.intentKey}' conflicts with '${this.existingDispatchId}'.`;
  }
}

export class TurnDispatchFinalizationError extends Schema.TaggedErrorClass<TurnDispatchFinalizationError>()(
  "TurnDispatchFinalizationError",
  {
    dispatchId: TurnDispatchId,
    currentState: Schema.NullOr(TurnDispatchState),
    finalizedSequence: Schema.NullOr(NonNegativeInt),
  },
) {
  override get message(): string {
    return `Turn dispatch '${this.dispatchId}' cannot be finalized from its current durable state.`;
  }
}

export type TurnDispatchJournalRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | TurnDispatchTransitionError
  | TurnDispatchIntentConflictError
  | TurnDispatchFinalizationError;

export interface GetOrCreateTurnDispatchResult {
  readonly entry: TurnDispatchJournalEntry;
  readonly inserted: boolean;
}

export interface TurnDispatchJournalRepositoryShape {
  /** Deduplicates by source event and returns the identity created by the first caller. */
  readonly getOrCreate: (
    input: PrepareTurnDispatchInput,
  ) => Effect.Effect<GetOrCreateTurnDispatchResult, TurnDispatchJournalRepositoryError>;
  /**
   * Same immutable insert as getOrCreate, but participates in the caller's
   * ambient SqlClient transaction. Reserved for projection/event acceptance.
   */
  readonly getOrCreateInTransaction: (
    input: PrepareTurnDispatchInput,
  ) => Effect.Effect<GetOrCreateTurnDispatchResult, TurnDispatchJournalRepositoryError>;
  readonly getByDispatchId: (
    input: GetTurnDispatchInput,
  ) => Effect.Effect<Option.Option<TurnDispatchJournalEntry>, TurnDispatchJournalRepositoryError>;
  readonly getByIntent: (
    input: GetTurnDispatchByIntentInput,
  ) => Effect.Effect<Option.Option<TurnDispatchJournalEntry>, TurnDispatchJournalRepositoryError>;
  /** Exact terminal lookup for post-turn checkpoint correlation. */
  readonly getStartedByProviderTurn: (
    input: GetStartedTurnDispatchInput,
  ) => Effect.Effect<Option.Option<TurnDispatchJournalEntry>, TurnDispatchJournalRepositoryError>;
  readonly markBaselineReady: (
    input: MarkTurnDispatchBaselineReadyInput,
  ) => Effect.Effect<void, TurnDispatchJournalRepositoryError>;
  readonly markBaselineNotApplicable: (
    input: MarkTurnDispatchBaselineNotApplicableInput,
  ) => Effect.Effect<void, TurnDispatchJournalRepositoryError>;
  /** Durable no-replay barrier; this must commit before invoking the provider. */
  readonly markProviderInFlight: (
    input: MarkTurnDispatchProviderInFlightInput,
  ) => Effect.Effect<void, TurnDispatchJournalRepositoryError>;
  /** Started is terminal and atomically self-finalizes with reserved sequence zero. */
  readonly markStarted: (
    input: MarkTurnDispatchStartedInput,
  ) => Effect.Effect<void, TurnDispatchJournalRepositoryError>;
  readonly markFailed: (
    input: MarkTurnDispatchFailedInput,
  ) => Effect.Effect<void, TurnDispatchJournalRepositoryError>;
  readonly markIndeterminate: (
    input: MarkTurnDispatchIndeterminateInput,
  ) => Effect.Effect<void, TurnDispatchJournalRepositoryError>;
  /** Idempotent only for the exact same terminal domain-event sequence. */
  readonly markFinalized: (
    input: MarkTurnDispatchFinalizedInput,
  ) => Effect.Effect<void, TurnDispatchJournalRepositoryError>;
  /** Keyset-paginated, deterministic recovery scan of every unfinalized row. */
  readonly listRecovery: (
    input: ListTurnDispatchRecoveryInput,
  ) => Effect.Effect<ReadonlyArray<TurnDispatchJournalEntry>, TurnDispatchJournalRepositoryError>;
}

export class TurnDispatchJournalRepository extends Context.Service<
  TurnDispatchJournalRepository,
  TurnDispatchJournalRepositoryShape
>()("t3/persistence/Services/TurnDispatchJournal/TurnDispatchJournalRepository") {}
