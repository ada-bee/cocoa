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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import {
  GetTurnDispatchInput,
  MarkTurnDispatchBaselineNotApplicableInput,
  MarkTurnDispatchBaselineReadyInput,
  MarkTurnDispatchFailedInput,
  MarkTurnDispatchFinalizedInput,
  MarkTurnDispatchIndeterminateInput,
  MarkTurnDispatchProviderInFlightInput,
  MarkTurnDispatchStartedInput,
  PrepareTurnDispatchInput,
  TurnDispatchBaselineNotApplicableReason,
  TurnDispatchError,
  TurnDispatchFinalizationError,
  TurnDispatchId,
  TurnDispatchIntentConflictError,
  TurnDispatchJournalEntry,
  TurnDispatchJournalRepository,
  type TurnDispatchJournalRepositoryShape,
  TurnDispatchState,
  type TurnDispatchState as TurnDispatchStateValue,
  TurnDispatchTransitionError,
} from "../Services/TurnDispatchJournal.ts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

const BoundedModelSelectionDb = Schema.fromJsonString(ModelSelection).check(
  Schema.makeFilter(
    (selection) =>
      Buffer.byteLength(stableJson(selection), "utf8") <= 8_192 ||
      "Model selection exceeds 8192 bytes.",
  ),
);

const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

/** The source event is the immutable, globally unique accepted-turn intent. */
export const turnDispatchIntentKey = (sourceEventId: EventId) => sha256(String(sourceEventId));

/** Hash user-authored title intent without storing it in the dispatch journal. */
export const turnDispatchTitleSeedSha256 = (titleSeed: string | null | undefined) =>
  titleSeed === null || titleSeed === undefined ? null : sha256(titleSeed);

const DbRow = strict(
  Schema.Struct({
    dispatchId: TurnDispatchId,
    intentKey: CodexCheckpointHelperSha256,
    sourceEventId: EventId,
    sourceCommandId: Schema.NullOr(CommandId),
    threadId: ThreadId,
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    messageId: MessageId,
    modelSelection: Schema.NullOr(BoundedModelSelectionDb),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    titleSeedSha256: Schema.NullOr(CodexCheckpointHelperSha256),
    baselineLogicalCheckpointId: Schema.NullOr(CodexCheckpointHelperCheckpointId),
    baselineOperationId: Schema.NullOr(CodexCheckpointHelperOperationId),
    baselineNotApplicableReason: Schema.NullOr(TurnDispatchBaselineNotApplicableReason),
    state: TurnDispatchState,
    providerTurnId: Schema.NullOr(Schema.String),
    error: Schema.NullOr(Schema.fromJsonString(TurnDispatchError)),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    finalizedSequence: Schema.NullOr(NonNegativeInt),
  }),
);

const PrepareDbInput = PrepareTurnDispatchInput.mapFields(
  Struct.assign({
    modelSelection: Schema.NullOr(BoundedModelSelectionDb),
  }),
);

const PrepareWithKeyDbInput = Schema.Struct({
  ...PrepareDbInput.fields,
  intentKey: CodexCheckpointHelperSha256,
});

const ErrorTransitionDbInput = MarkTurnDispatchFailedInput.mapFields(
  Struct.assign({ error: Schema.fromJsonString(TurnDispatchError) }),
);

const IndeterminateTransitionDbInput = MarkTurnDispatchIndeterminateInput.mapFields(
  Struct.assign({ error: Schema.fromJsonString(TurnDispatchError) }),
);

const ChangesRow = Schema.Struct({ changes: Schema.Number });
const StateRow = Schema.Struct({
  state: TurnDispatchState,
  finalizedSequence: Schema.NullOr(NonNegativeInt),
});

const decodeEntry = Schema.decodeUnknownEffect(TurnDispatchJournalEntry);
const decodeDbRows = Schema.decodeUnknownEffect(Schema.Array(DbRow));

const toRepositoryError = (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError("TurnDispatchJournalRepository.decode", cause)
    : new PersistenceSqlError({ operation: "TurnDispatchJournalRepository.query", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertAwaiting = SqlSchema.void({
    Request: PrepareWithKeyDbInput,
    execute: (input) => sql`
      INSERT INTO turn_dispatch_journal (
        dispatch_id, intent_key, source_event_id, source_command_id,
        thread_id, project_id, provider_instance_id, message_id,
        model_selection_json, runtime_mode, interaction_mode, title_seed_sha256,
        baseline_logical_checkpoint_id, baseline_operation_id,
        baseline_not_applicable_reason, state, provider_turn_id, error_json,
        created_at, updated_at, finalized_sequence
      ) VALUES (
        ${input.dispatchId}, ${input.intentKey}, ${input.sourceEventId}, ${input.sourceCommandId},
        ${input.threadId}, ${input.projectId}, ${input.providerInstanceId}, ${input.messageId},
        ${input.modelSelection}, ${input.runtimeMode}, ${input.interactionMode}, ${input.titleSeedSha256},
        NULL, NULL, NULL, 'awaiting_baseline', NULL, NULL,
        ${input.createdAt}, ${input.createdAt}, NULL
      )
      ON CONFLICT DO NOTHING
    `,
  });

  const selectEntry = `
    SELECT
      dispatch_id AS "dispatchId", intent_key AS "intentKey",
      source_event_id AS "sourceEventId", source_command_id AS "sourceCommandId",
      thread_id AS "threadId", project_id AS "projectId",
      provider_instance_id AS "providerInstanceId", message_id AS "messageId",
      model_selection_json AS "modelSelection", runtime_mode AS "runtimeMode",
      interaction_mode AS "interactionMode", title_seed_sha256 AS "titleSeedSha256",
      baseline_logical_checkpoint_id AS "baselineLogicalCheckpointId",
      baseline_operation_id AS "baselineOperationId",
      baseline_not_applicable_reason AS "baselineNotApplicableReason",
      state, provider_turn_id AS "providerTurnId", error_json AS "error",
      created_at AS "createdAt", updated_at AS "updatedAt",
      finalized_sequence AS "finalizedSequence"
    FROM turn_dispatch_journal
  `;

  const findByDispatchId = SqlSchema.findOneOption({
    Request: GetTurnDispatchInput,
    Result: DbRow,
    execute: ({ dispatchId }) => sql.unsafe(`${selectEntry} WHERE dispatch_id = ?`, [dispatchId]),
  });

  const findByIntentKey = SqlSchema.findOneOption({
    Request: Schema.Struct({ intentKey: CodexCheckpointHelperSha256 }),
    Result: DbRow,
    execute: ({ intentKey }) => sql.unsafe(`${selectEntry} WHERE intent_key = ?`, [intentKey]),
  });

  const getChanges = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ChangesRow,
    execute: () => sql`SELECT changes() AS "changes"`,
  });

  const getState = SqlSchema.findOneOption({
    Request: GetTurnDispatchInput,
    Result: StateRow,
    execute: ({ dispatchId }) => sql`
      SELECT state, finalized_sequence AS "finalizedSequence"
      FROM turn_dispatch_journal
      WHERE dispatch_id = ${dispatchId}
    `,
  });

  const updateBaselineReady = SqlSchema.void({
    Request: MarkTurnDispatchBaselineReadyInput,
    execute: (input) => sql`
      UPDATE turn_dispatch_journal
      SET state = 'baseline_ready',
          baseline_logical_checkpoint_id = ${input.baselineLogicalCheckpointId},
          baseline_operation_id = ${input.baselineOperationId},
          baseline_not_applicable_reason = NULL,
          updated_at = ${input.updatedAt}
      WHERE dispatch_id = ${input.dispatchId} AND state = 'awaiting_baseline'
    `,
  });

  const updateBaselineNotApplicable = SqlSchema.void({
    Request: MarkTurnDispatchBaselineNotApplicableInput,
    execute: (input) => sql`
      UPDATE turn_dispatch_journal
      SET state = 'baseline_not_applicable',
          baseline_logical_checkpoint_id = NULL,
          baseline_operation_id = NULL,
          baseline_not_applicable_reason = ${input.reason},
          updated_at = ${input.updatedAt}
      WHERE dispatch_id = ${input.dispatchId} AND state = 'awaiting_baseline'
    `,
  });

  const updateProviderInFlight = SqlSchema.void({
    Request: MarkTurnDispatchProviderInFlightInput,
    execute: (input) => sql`
      UPDATE turn_dispatch_journal
      SET state = 'provider_in_flight', updated_at = ${input.updatedAt}
      WHERE dispatch_id = ${input.dispatchId}
        AND state IN ('baseline_ready', 'baseline_not_applicable')
    `,
  });

  const updateStarted = SqlSchema.void({
    Request: MarkTurnDispatchStartedInput,
    execute: (input) => sql`
      UPDATE turn_dispatch_journal
      SET state = 'started', provider_turn_id = ${input.providerTurnId},
          error_json = NULL,
          -- Sequence zero is reserved for terminal states requiring no domain dispatch.
          finalized_sequence = 0,
          updated_at = ${input.updatedAt}
      WHERE dispatch_id = ${input.dispatchId}
        AND state IN ('provider_in_flight', 'indeterminate')
        AND finalized_sequence IS NULL
    `,
  });

  const updateFailed = SqlSchema.void({
    Request: ErrorTransitionDbInput,
    execute: (input) => sql`
      UPDATE turn_dispatch_journal
      SET state = 'failed', provider_turn_id = NULL,
          error_json = ${input.error}, updated_at = ${input.updatedAt}
      WHERE dispatch_id = ${input.dispatchId}
        AND state IN (
          'awaiting_baseline', 'baseline_ready', 'baseline_not_applicable',
          'provider_in_flight', 'indeterminate'
        )
        AND finalized_sequence IS NULL
    `,
  });

  const updateIndeterminate = SqlSchema.void({
    Request: IndeterminateTransitionDbInput,
    execute: (input) => sql`
      UPDATE turn_dispatch_journal
      SET state = 'indeterminate', error_json = ${input.error}, updated_at = ${input.updatedAt}
      WHERE dispatch_id = ${input.dispatchId} AND state = 'provider_in_flight'
    `,
  });

  const updateFinalized = SqlSchema.void({
    Request: MarkTurnDispatchFinalizedInput,
    execute: (input) => sql`
      UPDATE turn_dispatch_journal
      SET finalized_sequence = ${input.sequence}, updated_at = ${input.updatedAt}
      WHERE dispatch_id = ${input.dispatchId}
        AND state IN ('started', 'failed', 'indeterminate')
        AND finalized_sequence IS NULL
    `,
  });

  const isTransitionError = Schema.is(TurnDispatchTransitionError);
  const isIntentConflict = Schema.is(TurnDispatchIntentConflictError);
  const isFinalizationError = Schema.is(TurnDispatchFinalizationError);
  const mapError = (cause: unknown) =>
    isTransitionError(cause) || isIntentConflict(cause) || isFinalizationError(cause)
      ? cause
      : toRepositoryError(cause);

  const materialize = (row: typeof DbRow.Type) => decodeEntry(row);

  const transition = Effect.fn("TurnDispatchJournalRepository.transition")(function* (
    dispatchId: TurnDispatchId,
    requestedState: TurnDispatchStateValue,
    update: Effect.Effect<void, Schema.SchemaError | SqlError>,
  ) {
    yield* update;
    const { changes } = yield* getChanges(undefined);
    if (changes === 1) return;
    const current = yield* getState({ dispatchId });
    return yield* new TurnDispatchTransitionError({
      dispatchId,
      requestedState,
      currentState: Option.match(current, { onNone: () => null, onSome: (row) => row.state }),
    });
  });

  const runTransition = (
    dispatchId: TurnDispatchId,
    requestedState: TurnDispatchStateValue,
    update: Effect.Effect<void, Schema.SchemaError | SqlError>,
  ) =>
    sql
      .withTransaction(transition(dispatchId, requestedState, update))
      .pipe(Effect.mapError(mapError));

  const getOrCreate: TurnDispatchJournalRepositoryShape["getOrCreate"] = (input) => {
    const intentKey = turnDispatchIntentKey(input.sourceEventId);
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* insertAwaiting({ ...input, intentKey });
          const { changes } = yield* getChanges(undefined);
          const inserted = changes === 1;
          const existing = yield* findByIntentKey({ intentKey });
          if (Option.isNone(existing)) {
            const collision = yield* findByDispatchId({ dispatchId: input.dispatchId });
            return yield* new TurnDispatchIntentConflictError({
              intentKey,
              existingDispatchId: Option.match(collision, {
                onNone: () => input.dispatchId,
                onSome: (row) => row.dispatchId,
              }),
            });
          }
          const entry = yield* materialize(existing.value);
          const sameImmutable =
            entry.sourceEventId === input.sourceEventId &&
            entry.sourceCommandId === input.sourceCommandId &&
            entry.threadId === input.threadId &&
            entry.projectId === input.projectId &&
            entry.providerInstanceId === input.providerInstanceId &&
            entry.messageId === input.messageId &&
            stableJson(entry.modelSelection) === stableJson(input.modelSelection) &&
            entry.runtimeMode === input.runtimeMode &&
            entry.interactionMode === input.interactionMode &&
            entry.titleSeedSha256 === input.titleSeedSha256 &&
            entry.createdAt === input.createdAt;
          if (!sameImmutable) {
            return yield* new TurnDispatchIntentConflictError({
              intentKey,
              existingDispatchId: entry.dispatchId,
            });
          }
          return { entry, inserted };
        }),
      )
      .pipe(Effect.mapError(mapError));
  };

  const getByDispatchId: TurnDispatchJournalRepositoryShape["getByDispatchId"] = (input) =>
    findByDispatchId(input).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => materialize(row).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );

  const getByIntent: TurnDispatchJournalRepositoryShape["getByIntent"] = (input) =>
    findByIntentKey({ intentKey: turnDispatchIntentKey(input.sourceEventId) }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => materialize(row).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );

  const markBaselineReady: TurnDispatchJournalRepositoryShape["markBaselineReady"] = (input) =>
    runTransition(input.dispatchId, "baseline_ready", updateBaselineReady(input));
  const markBaselineNotApplicable: TurnDispatchJournalRepositoryShape["markBaselineNotApplicable"] =
    (input) =>
      runTransition(
        input.dispatchId,
        "baseline_not_applicable",
        updateBaselineNotApplicable(input),
      );
  const markProviderInFlight: TurnDispatchJournalRepositoryShape["markProviderInFlight"] = (
    input,
  ) => runTransition(input.dispatchId, "provider_in_flight", updateProviderInFlight(input));
  const markStarted: TurnDispatchJournalRepositoryShape["markStarted"] = (input) =>
    runTransition(input.dispatchId, "started", updateStarted(input));
  const markFailed: TurnDispatchJournalRepositoryShape["markFailed"] = (input) =>
    runTransition(input.dispatchId, "failed", updateFailed(input));
  const markIndeterminate: TurnDispatchJournalRepositoryShape["markIndeterminate"] = (input) =>
    runTransition(input.dispatchId, "indeterminate", updateIndeterminate(input));

  const markFinalized: TurnDispatchJournalRepositoryShape["markFinalized"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* updateFinalized(input);
          const { changes } = yield* getChanges(undefined);
          if (changes === 1) return;
          const current = yield* getState({ dispatchId: input.dispatchId });
          if (
            Option.isSome(current) &&
            current.value.finalizedSequence === input.sequence &&
            (current.value.state === "started" ||
              current.value.state === "failed" ||
              current.value.state === "indeterminate")
          ) {
            return;
          }
          return yield* new TurnDispatchFinalizationError({
            dispatchId: input.dispatchId,
            currentState: Option.match(current, {
              onNone: () => null,
              onSome: (row) => row.state,
            }),
            finalizedSequence: Option.match(current, {
              onNone: () => null,
              onSome: (row) => row.finalizedSequence,
            }),
          });
        }),
      )
      .pipe(Effect.mapError(mapError));

  const listRecovery: TurnDispatchJournalRepositoryShape["listRecovery"] = (input) => {
    const filters = ["finalized_sequence IS NULL"];
    const parameters: Array<string | number> = [];
    if (input.providerInstanceId !== undefined) {
      filters.push("provider_instance_id = ?");
      parameters.push(input.providerInstanceId);
    }
    if (input.after !== undefined) {
      filters.push("(created_at > ? OR (created_at = ? AND dispatch_id > ?))");
      parameters.push(input.after.createdAt, input.after.createdAt, input.after.dispatchId);
    }
    parameters.push(input.limit);
    return sql
      .unsafe(
        `${selectEntry} WHERE ${filters.join(" AND ")} ORDER BY created_at, dispatch_id LIMIT ?`,
        parameters,
      )
      .pipe(
        Effect.flatMap((rows) =>
          decodeDbRows(rows).pipe(
            Effect.flatMap((decoded) => Effect.forEach(decoded, materialize)),
          ),
        ),
        Effect.mapError(mapError),
      );
  };

  return {
    getOrCreate,
    getByDispatchId,
    getByIntent,
    markBaselineReady,
    markBaselineNotApplicable,
    markProviderInFlight,
    markStarted,
    markFailed,
    markIndeterminate,
    markFinalized,
    listRecovery,
  } satisfies TurnDispatchJournalRepositoryShape;
});

export const TurnDispatchJournalRepositoryLive = Layer.effect(TurnDispatchJournalRepository, make);
