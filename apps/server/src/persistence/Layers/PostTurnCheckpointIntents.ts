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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import {
  BindPostTurnCheckpointIntentInput,
  FinalizePostTurnCheckpointIntentInput,
  GetPostTurnCheckpointIntentInput,
  ListPostTurnCheckpointRecoveryInput,
  PostTurnCheckpointIntent,
  PostTurnCheckpointIntentConflictError,
  PostTurnCheckpointIntentFinalizationError,
  PostTurnCheckpointIntentRepository,
  PostTurnCheckpointIntentState,
  PostTurnCheckpointOutcome,
  ProjectPostTurnCheckpointIntentInput,
  type PostTurnCheckpointIntentRepositoryShape,
} from "../Services/PostTurnCheckpointIntents.ts";
import {
  TurnDispatchBaselineNotApplicableReason,
  TurnDispatchProviderTurnId,
} from "../Services/TurnDispatchJournal.ts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const DbRow = strict(
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
  }),
);

const StateRow = Schema.Struct({
  state: PostTurnCheckpointIntentState,
  finalizedSequence: Schema.NullOr(NonNegativeInt),
});

const selectIntent = `
  SELECT
    source_event_id AS "sourceEventId", source_sequence AS "sourceSequence",
    thread_id AS "threadId", turn_id AS "turnId", provider_turn_id AS "providerTurnId",
    outcome, completed_at AS "completedAt", state,
    provider_instance_id AS "providerInstanceId", project_id AS "projectId",
    baseline_checkpoint_turn_count AS "baselineCheckpointTurnCount",
    checkpoint_turn_count AS "checkpointTurnCount",
    baseline_logical_checkpoint_id AS "baselineLogicalCheckpointId",
    baseline_not_applicable_reason AS "baselineNotApplicableReason",
    operation_id AS "operationId", logical_checkpoint_id AS "logicalCheckpointId",
    finalized_sequence AS "finalizedSequence",
    created_at AS "createdAt", updated_at AS "updatedAt"
  FROM post_turn_checkpoint_intents
`;

const decodeIntent = Schema.decodeUnknownEffect(PostTurnCheckpointIntent);
const decodeDbRows = Schema.decodeUnknownEffect(Schema.Array(DbRow));

const toRepositoryError = (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError("PostTurnCheckpointIntentRepository.decode", cause)
    : new PersistenceSqlError({
        operation: "PostTurnCheckpointIntentRepository.query",
        cause,
      });

const isIntentConflict = Schema.is(PostTurnCheckpointIntentConflictError);
const isFinalizationError = Schema.is(PostTurnCheckpointIntentFinalizationError);
const mapError = (cause: unknown) =>
  isIntentConflict(cause) || isFinalizationError(cause) ? cause : toRepositoryError(cause);

const materialize = (row: typeof DbRow.Type) => decodeIntent(row);

const sameProjectedIdentity = (
  row: PostTurnCheckpointIntent,
  input: typeof ProjectPostTurnCheckpointIntentInput.Type,
) =>
  row.sourceEventId === input.sourceEventId &&
  row.sourceSequence === input.sourceSequence &&
  row.threadId === input.threadId &&
  row.turnId === input.turnId &&
  row.providerTurnId === input.providerTurnId &&
  row.outcome === input.outcome &&
  row.completedAt === input.completedAt;

const sameBinding = (
  row: PostTurnCheckpointIntent,
  input: typeof BindPostTurnCheckpointIntentInput.Type,
) =>
  row.state === "bound" &&
  row.providerInstanceId === input.providerInstanceId &&
  row.projectId === input.projectId &&
  row.baselineCheckpointTurnCount === input.baselineCheckpointTurnCount &&
  row.checkpointTurnCount === input.checkpointTurnCount &&
  row.baselineLogicalCheckpointId === input.baselineLogicalCheckpointId &&
  row.baselineNotApplicableReason === input.baselineNotApplicableReason &&
  row.operationId === input.operationId &&
  row.logicalCheckpointId === input.logicalCheckpointId;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertProjected = SqlSchema.void({
    Request: ProjectPostTurnCheckpointIntentInput,
    execute: (input) => sql`
      INSERT INTO post_turn_checkpoint_intents (
        source_event_id, source_sequence, thread_id, turn_id, provider_turn_id,
        outcome, completed_at, state,
        provider_instance_id, project_id,
        baseline_checkpoint_turn_count, checkpoint_turn_count,
        baseline_logical_checkpoint_id, baseline_not_applicable_reason,
        operation_id, logical_checkpoint_id, finalized_sequence,
        created_at, updated_at
      ) VALUES (
        ${input.sourceEventId}, ${input.sourceSequence}, ${input.threadId}, ${input.turnId},
        ${input.providerTurnId}, ${input.outcome}, ${input.completedAt},
        ${input.providerTurnId === null ? "uncorrelatable" : "awaiting_dispatch"},
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ${input.providerTurnId === null ? 0 : null},
        ${input.completedAt}, ${input.completedAt}
      )
      ON CONFLICT DO NOTHING
    `,
  });

  const findBySourceEventId = SqlSchema.findOneOption({
    Request: GetPostTurnCheckpointIntentInput,
    Result: DbRow,
    execute: ({ sourceEventId }) =>
      sql.unsafe(`${selectIntent} WHERE source_event_id = ?`, [sourceEventId]),
  });

  const updateBinding = SqlSchema.void({
    Request: BindPostTurnCheckpointIntentInput,
    execute: (input) => sql`
      UPDATE post_turn_checkpoint_intents
      SET state = 'bound',
          provider_instance_id = ${input.providerInstanceId},
          project_id = ${input.projectId},
          baseline_checkpoint_turn_count = ${input.baselineCheckpointTurnCount},
          checkpoint_turn_count = ${input.checkpointTurnCount},
          baseline_logical_checkpoint_id = ${input.baselineLogicalCheckpointId},
          baseline_not_applicable_reason = ${input.baselineNotApplicableReason},
          operation_id = ${input.operationId},
          logical_checkpoint_id = ${input.logicalCheckpointId},
          updated_at = ${input.updatedAt}
      WHERE source_event_id = ${input.sourceEventId}
        AND state = 'awaiting_dispatch'
        AND finalized_sequence IS NULL
    `,
  });

  const updateFinalized = SqlSchema.void({
    Request: FinalizePostTurnCheckpointIntentInput,
    execute: (input) => sql`
      UPDATE post_turn_checkpoint_intents
      SET finalized_sequence = ${input.sequence}, updated_at = ${input.updatedAt}
      WHERE source_event_id = ${input.sourceEventId}
        AND state = 'bound'
        AND finalized_sequence IS NULL
    `,
  });

  const getState = SqlSchema.findOneOption({
    Request: GetPostTurnCheckpointIntentInput,
    Result: StateRow,
    execute: ({ sourceEventId }) => sql`
      SELECT state, finalized_sequence AS "finalizedSequence"
      FROM post_turn_checkpoint_intents
      WHERE source_event_id = ${sourceEventId}
    `,
  });

  const projectInTransaction: PostTurnCheckpointIntentRepositoryShape["projectInTransaction"] = (
    input,
  ) =>
    Effect.gen(function* () {
      yield* insertProjected(input);
      const existing = yield* findBySourceEventId({ sourceEventId: input.sourceEventId });
      if (Option.isNone(existing)) {
        return yield* new PostTurnCheckpointIntentConflictError({
          sourceEventId: input.sourceEventId,
        });
      }
      const row = yield* materialize(existing.value);
      if (!sameProjectedIdentity(row, input)) {
        return yield* new PostTurnCheckpointIntentConflictError({
          sourceEventId: input.sourceEventId,
        });
      }
      return row;
    }).pipe(Effect.mapError(mapError));

  const getBySourceEventId: PostTurnCheckpointIntentRepositoryShape["getBySourceEventId"] = (
    input,
  ) =>
    findBySourceEventId(input).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => materialize(row).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );

  const bind: PostTurnCheckpointIntentRepositoryShape["bind"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* updateBinding(input);
          const existing = yield* findBySourceEventId({ sourceEventId: input.sourceEventId });
          if (Option.isNone(existing)) {
            return yield* new PostTurnCheckpointIntentConflictError({
              sourceEventId: input.sourceEventId,
            });
          }
          const row = yield* materialize(existing.value);
          if (!sameBinding(row, input)) {
            return yield* new PostTurnCheckpointIntentConflictError({
              sourceEventId: input.sourceEventId,
            });
          }
          return row;
        }),
      )
      .pipe(Effect.mapError(mapError));

  const markFinalized: PostTurnCheckpointIntentRepositoryShape["markFinalized"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* updateFinalized(input);
          const state = yield* getState({ sourceEventId: input.sourceEventId }).pipe(
            Effect.map(Option.getOrNull),
          );
          if (
            state === null ||
            state.state !== "bound" ||
            state.finalizedSequence !== input.sequence
          ) {
            return yield* new PostTurnCheckpointIntentFinalizationError({
              sourceEventId: input.sourceEventId,
              state: state?.state ?? null,
              finalizedSequence: state?.finalizedSequence ?? null,
            });
          }
        }),
      )
      .pipe(Effect.mapError(mapError));

  const listRecovery: PostTurnCheckpointIntentRepositoryShape["listRecovery"] = (input) => {
    const params: Array<unknown> = [];
    let where = "WHERE finalized_sequence IS NULL";
    if (input.providerInstanceId !== undefined) {
      where += " AND state = 'bound' AND provider_instance_id = ?";
      params.push(input.providerInstanceId);
    }
    if (input.after !== undefined) {
      where += " AND (source_sequence > ? OR (source_sequence = ? AND source_event_id > ?))";
      params.push(
        input.after.sourceSequence,
        input.after.sourceSequence,
        input.after.sourceEventId,
      );
    }
    params.push(input.limit);
    return sql
      .unsafe(
        `${selectIntent} ${where} ORDER BY source_sequence ASC, source_event_id ASC LIMIT ?`,
        params,
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

  return PostTurnCheckpointIntentRepository.of({
    projectInTransaction,
    getBySourceEventId,
    bind,
    markFinalized,
    listRecovery,
  });
});

export const PostTurnCheckpointIntentRepositoryLive = Layer.effect(
  PostTurnCheckpointIntentRepository,
  make,
);
