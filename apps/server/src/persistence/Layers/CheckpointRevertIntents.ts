import { CommandId, EventId, IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import {
  CheckpointRevertIntent,
  CheckpointRevertIntentConflictError,
  CheckpointRevertIntentRepository,
  CheckpointRevertIntentState,
  CheckpointRevertIntentTransitionError,
  CheckpointRevertTerminalOutcome,
  GetCheckpointRevertIntentInput,
  LinkCheckpointRevertIntentInput,
  ListCheckpointRevertIntentRecoveryInput,
  MarkCheckpointRevertIntentTerminalInput,
  ProjectCheckpointRevertIntentInput,
  type CheckpointRevertIntentRepositoryShape,
} from "../Services/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaId } from "../Services/CheckpointRevertSagas.ts";
import { checkpointRevertSagaId } from "./CheckpointRevertSagas.ts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const DbRow = strict(
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
  }),
);

const StateRow = Schema.Struct({
  state: CheckpointRevertIntentState,
  sagaId: Schema.NullOr(CheckpointRevertSagaId),
});

const ChangesRow = Schema.Struct({ changes: Schema.Number });

const selectIntent = `
  SELECT
    source_event_id AS "sourceEventId", source_sequence AS "sourceSequence",
    source_command_id AS "sourceCommandId", thread_id AS "threadId",
    requested_turn_count AS "requestedTurnCount", requested_at AS "requestedAt",
    created_at AS "createdAt", state, saga_id AS "sagaId",
    terminal_outcome AS "terminalOutcome", terminal_at AS "terminalAt"
  FROM checkpoint_revert_intents
`;

const decodeIntent = Schema.decodeUnknownEffect(CheckpointRevertIntent);

const toRepositoryError = (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError("CheckpointRevertIntentRepository.decode", cause)
    : new PersistenceSqlError({
        operation: "CheckpointRevertIntentRepository.query",
        cause,
      });

const isConflict = Schema.is(CheckpointRevertIntentConflictError);
const isTransition = Schema.is(CheckpointRevertIntentTransitionError);
const mapError = (cause: unknown) =>
  isConflict(cause) || isTransition(cause) ? cause : toRepositoryError(cause);

const sameProjectedIdentity = (
  row: CheckpointRevertIntent,
  input: typeof ProjectCheckpointRevertIntentInput.Type,
) =>
  row.sourceEventId === input.sourceEventId &&
  row.sourceSequence === input.sourceSequence &&
  row.sourceCommandId === input.sourceCommandId &&
  row.threadId === input.threadId &&
  row.requestedTurnCount === input.requestedTurnCount &&
  row.requestedAt === input.requestedAt &&
  row.createdAt === input.createdAt;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertProjected = SqlSchema.void({
    Request: ProjectCheckpointRevertIntentInput,
    execute: (input) => sql`
      INSERT INTO checkpoint_revert_intents (
        source_event_id, source_sequence, source_command_id, thread_id,
        requested_turn_count, requested_at, created_at, state,
        saga_id, terminal_outcome, terminal_at
      ) VALUES (
        ${input.sourceEventId}, ${input.sourceSequence}, ${input.sourceCommandId}, ${input.threadId},
        ${input.requestedTurnCount}, ${input.requestedAt}, ${input.createdAt}, 'awaiting_saga',
        NULL, NULL, NULL
      )
      ON CONFLICT DO NOTHING
    `,
  });

  const findBySourceEventId = SqlSchema.findOneOption({
    Request: GetCheckpointRevertIntentInput,
    Result: DbRow,
    execute: ({ sourceEventId }) =>
      sql.unsafe(`${selectIntent} WHERE source_event_id = ?`, [sourceEventId]),
  });

  const getChanges = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ChangesRow,
    execute: () => sql`SELECT changes() AS "changes"`,
  });

  const getState = SqlSchema.findOneOption({
    Request: GetCheckpointRevertIntentInput,
    Result: StateRow,
    execute: ({ sourceEventId }) => sql`
      SELECT state, saga_id AS "sagaId"
      FROM checkpoint_revert_intents
      WHERE source_event_id = ${sourceEventId}
    `,
  });

  const updateLink = SqlSchema.void({
    Request: LinkCheckpointRevertIntentInput,
    execute: ({ sourceEventId, sagaId }) => sql`
      UPDATE checkpoint_revert_intents
      SET state = 'linked', saga_id = ${sagaId}
      WHERE source_event_id = ${sourceEventId}
        AND state = 'awaiting_saga'
        AND saga_id IS NULL
    `,
  });

  const updateTerminal = SqlSchema.void({
    Request: MarkCheckpointRevertIntentTerminalInput,
    execute: (input) => sql`
      UPDATE checkpoint_revert_intents
      SET state = 'terminal', saga_id = ${input.sagaId},
          terminal_outcome = ${input.outcome}, terminal_at = ${input.terminalAt}
      WHERE source_event_id = ${input.sourceEventId}
        AND (
          (state = 'awaiting_saga'
            AND ${input.outcome} = 'failed'
            AND ${input.sagaId} IS NULL
            AND saga_id IS NULL)
          OR (state = 'linked'
            AND ${input.sagaId} IS NOT NULL
            AND saga_id = ${input.sagaId})
        )
    `,
  });

  const listRecoveryRows = SqlSchema.findAll({
    Request: ListCheckpointRevertIntentRecoveryInput,
    Result: DbRow,
    execute: ({ after, limit }) =>
      after === null
        ? sql.unsafe(
            `${selectIntent}
             WHERE state IN ('awaiting_saga', 'linked')
             ORDER BY source_sequence, source_event_id
             LIMIT ?`,
            [limit],
          )
        : sql.unsafe(
            `${selectIntent}
             WHERE state IN ('awaiting_saga', 'linked')
               AND (source_sequence > ? OR (source_sequence = ? AND source_event_id > ?))
             ORDER BY source_sequence, source_event_id
             LIMIT ?`,
            [after.sourceSequence, after.sourceSequence, after.sourceEventId, limit],
          ),
  });

  const materialize = (row: typeof DbRow.Type) => decodeIntent(row);

  const transitionError = Effect.fn("CheckpointRevertIntentRepository.transitionError")(function* (
    sourceEventId: EventId,
  ) {
    const current = yield* getState({ sourceEventId });
    return new CheckpointRevertIntentTransitionError({
      sourceEventId,
      state: Option.match(current, { onNone: () => null, onSome: (row) => row.state }),
      sagaId: Option.match(current, { onNone: () => null, onSome: (row) => row.sagaId }),
    });
  });

  const getBySourceEventId: CheckpointRevertIntentRepositoryShape["getBySourceEventId"] = (input) =>
    findBySourceEventId(input).pipe(
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) => materialize(value).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );

  const projectInTransaction: CheckpointRevertIntentRepositoryShape["projectInTransaction"] = (
    input,
  ) =>
    Effect.gen(function* () {
      yield* insertProjected(input);
      const existing = yield* findBySourceEventId({ sourceEventId: input.sourceEventId });
      if (Option.isNone(existing)) {
        return yield* new CheckpointRevertIntentConflictError({
          sourceEventId: input.sourceEventId,
        });
      }
      const row = yield* materialize(existing.value);
      if (!sameProjectedIdentity(row, input)) {
        return yield* new CheckpointRevertIntentConflictError({
          sourceEventId: input.sourceEventId,
        });
      }
      return row;
    }).pipe(Effect.mapError(mapError));

  const linkSaga: CheckpointRevertIntentRepositoryShape["linkSaga"] = (input) =>
    input.sagaId !== checkpointRevertSagaId(input.sourceEventId)
      ? new CheckpointRevertIntentConflictError({ sourceEventId: input.sourceEventId })
      : sql
          .withTransaction(
            Effect.gen(function* () {
              yield* updateLink(input);
              const { changes } = yield* getChanges(undefined);
              const existing = yield* findBySourceEventId({ sourceEventId: input.sourceEventId });
              if (Option.isNone(existing)) {
                const error = yield* transitionError(input.sourceEventId);
                return yield* error;
              }
              const row = yield* materialize(existing.value);
              if (
                changes === 1 ||
                ((row.state === "linked" || row.state === "terminal") &&
                  row.sagaId === input.sagaId)
              ) {
                return row;
              }
              const error = yield* transitionError(input.sourceEventId);
              return yield* error;
            }),
          )
          .pipe(Effect.mapError(mapError));

  const markTerminal: CheckpointRevertIntentRepositoryShape["markTerminal"] = (input) =>
    Schema.decodeUnknownEffect(MarkCheckpointRevertIntentTerminalInput)(input).pipe(
      Effect.flatMap((validated) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* updateTerminal(validated);
            const { changes } = yield* getChanges(undefined);
            if (changes === 1) return;
            const existing = yield* findBySourceEventId({
              sourceEventId: validated.sourceEventId,
            });
            if (Option.isSome(existing)) {
              const row = yield* materialize(existing.value);
              if (
                row.state === "terminal" &&
                row.sagaId === validated.sagaId &&
                row.terminalOutcome === validated.outcome &&
                row.terminalAt === validated.terminalAt
              ) {
                return;
              }
            }
            const error = yield* transitionError(validated.sourceEventId);
            return yield* error;
          }),
        ),
      ),
      Effect.mapError(mapError),
    );

  const listRecovery: CheckpointRevertIntentRepositoryShape["listRecovery"] = (input) =>
    listRecoveryRows(input).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, materialize)),
      Effect.mapError(mapError),
    );

  return {
    projectInTransaction,
    getBySourceEventId,
    linkSaga,
    markTerminal,
    listRecovery,
  } satisfies CheckpointRevertIntentRepositoryShape;
});

export const CheckpointRevertIntentRepositoryLive = Layer.effect(
  CheckpointRevertIntentRepository,
  make,
);
