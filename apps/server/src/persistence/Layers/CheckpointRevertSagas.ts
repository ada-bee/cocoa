// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  makeDeleteCheckpointOperationId,
  makeRestoreCheckpointOperationId,
} from "../../checkpointing/CheckpointIds.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import {
  BeginCheckpointRevertFinalizationInput,
  CheckpointRevertActiveSagaConflictError,
  CheckpointRevertRecoveryCursor,
  CheckpointRevertSaga,
  CheckpointRevertSagaConflictError,
  CheckpointRevertSagaErrorTransitionInput,
  CheckpointRevertSagaId,
  CheckpointRevertSagaRepository,
  CheckpointRevertSagaState,
  CheckpointRevertSagaTransitionError,
  CheckpointRevertSagaTransitionInput,
  CheckpointRevertStaleTarget,
  CompleteCheckpointRevertSagaInput,
  CreateCheckpointRevertSagaInput,
  FinalizeCheckpointRevertDomainInput,
  GetActiveCheckpointRevertSagaByThreadInput,
  GetCheckpointRevertSagaBySourceInput,
  GetCheckpointRevertSagaInput,
  ListCheckpointRevertRecoveryInput,
  ListCheckpointRevertStaleTargetsInput,
  type CheckpointRevertSagaRepositoryShape,
  type CheckpointRevertStaleTargetInput,
  type CreateCheckpointRevertSagaInput as CreateInput,
} from "../Services/CheckpointRevertSagas.ts";
import { ProviderCheckpointOperationError } from "../Services/ProviderCheckpointOperations.ts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const SagaDbRow = strict(
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
    preimageDigestCount: NonNegativeInt,
    preimageDigestSha256: CodexCheckpointHelperSha256,
    targetDigestCount: NonNegativeInt,
    targetDigestSha256: CodexCheckpointHelperSha256,
    retainedLogicalCheckpointId: CodexCheckpointHelperCheckpointId,
    retainedExpectedCheckpointOid: CodexCheckpointHelperOid,
    repositoryFingerprint: CodexCheckpointHelperSha256,
    repositoryObjectFormat: CodexCheckpointHelperObjectFormat,
    restoreOperationId: CodexCheckpointHelperOperationId,
    state: CheckpointRevertSagaState,
    error: Schema.NullOr(Schema.fromJsonString(ProviderCheckpointOperationError)),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    finalizationStartedAt: Schema.NullOr(IsoDateTime),
    finalizationSequence: Schema.NullOr(NonNegativeInt),
    completedAt: Schema.NullOr(IsoDateTime),
  }),
);

const CreateSagaDbInput = CreateCheckpointRevertSagaInput.mapFields(
  Struct.assign({ staleTargets: Schema.Array(Schema.Unknown) }),
);

const ErrorTransitionDbInput = CheckpointRevertSagaErrorTransitionInput.mapFields(
  Struct.assign({ error: Schema.fromJsonString(ProviderCheckpointOperationError) }),
);

const StateRow = Schema.Struct({ state: CheckpointRevertSagaState });
const ChangesRow = Schema.Struct({ changes: Schema.Number });

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

export const checkpointRevertSagaId = (sourceRevertEventId: EventId): CheckpointRevertSagaId => {
  const bytes = Buffer.from(sourceRevertEventId, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return CheckpointRevertSagaId.make(
    NodeCrypto.createHash("sha256")
      .update("cocoa.checkpoint-revert-saga\0v1\0", "utf8")
      .update(length)
      .update(bytes)
      .digest("hex"),
  );
};

const sortTargets = (targets: ReadonlyArray<CheckpointRevertStaleTargetInput>) =>
  targets.toSorted(
    (left, right) =>
      left.checkpointTurnCount - right.checkpointTurnCount ||
      left.logicalCheckpointId.localeCompare(right.logicalCheckpointId),
  );

const materializeTargets = (
  sagaId: CheckpointRevertSagaId,
  sourceRevertEventId: EventId,
  targets: ReadonlyArray<CheckpointRevertStaleTargetInput>,
): ReadonlyArray<CheckpointRevertStaleTarget> =>
  sortTargets(targets).map((target, ordinal) => {
    const batchOrdinal = Math.floor(ordinal / 256);
    return {
      sagaId,
      ordinal,
      batchOrdinal,
      checkpointTurnCount: target.checkpointTurnCount,
      logicalCheckpointId: target.logicalCheckpointId,
      expectedCheckpointOid: target.expectedCheckpointOid,
      deleteOperationId: makeDeleteCheckpointOperationId({
        revertEventId: sourceRevertEventId,
        batchOrdinal,
      }),
    };
  });

const toRepositoryError = (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError("CheckpointRevertSagaRepository.decode", cause)
    : new PersistenceSqlError({ operation: "CheckpointRevertSagaRepository.query", cause });

const decodeSaga = Schema.decodeUnknownEffect(CheckpointRevertSaga);
const isConflict = Schema.is(CheckpointRevertSagaConflictError);
const isActiveConflict = Schema.is(CheckpointRevertActiveSagaConflictError);
const isTransition = Schema.is(CheckpointRevertSagaTransitionError);
const mapError = (cause: unknown) =>
  isConflict(cause) || isActiveConflict(cause) || isTransition(cause)
    ? cause
    : toRepositoryError(cause);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertSaga = SqlSchema.void({
    Request: Schema.Struct({ ...CreateSagaDbInput.fields, sagaId: CheckpointRevertSagaId }),
    execute: (input) => sql`
      INSERT INTO checkpoint_revert_sagas (
        saga_id, source_revert_event_id, source_command_id, provider_instance_id,
        project_id, thread_id, provider_driver_kind, continuation_identity_sha256,
        requested_turn_count, preimage_turn_count, preimage_digest_count,
        preimage_digest_sha256, target_digest_count, target_digest_sha256,
        retained_logical_checkpoint_id, retained_expected_oid, repository_fingerprint,
        repository_object_format, restore_operation_id, state, error_json,
        created_at, updated_at, finalization_started_at, finalization_sequence, completed_at
      ) VALUES (
        ${input.sagaId}, ${input.sourceRevertEventId}, ${input.sourceCommandId}, ${input.providerInstanceId},
        ${input.projectId}, ${input.threadId}, ${input.providerDriverKind}, ${input.continuationIdentitySha256},
        ${input.requestedTurnCount}, ${input.preimageTurnCount}, ${input.preimage.count},
        ${input.preimage.sha256}, ${input.target.count}, ${input.target.sha256},
        ${input.retainedLogicalCheckpointId}, ${input.retainedExpectedCheckpointOid}, ${input.repositoryFingerprint},
        ${input.repositoryObjectFormat}, ${input.restoreOperationId}, 'prepared', NULL,
        ${input.createdAt}, ${input.createdAt}, NULL, NULL, NULL
      )
      ON CONFLICT DO NOTHING
    `,
  });

  const insertTarget = SqlSchema.void({
    Request: CheckpointRevertStaleTarget,
    execute: (target) => sql`
      INSERT INTO checkpoint_revert_stale_targets (
        saga_id, ordinal, batch_ordinal, checkpoint_turn_count,
        logical_checkpoint_id, expected_checkpoint_oid, delete_operation_id
      ) VALUES (
        ${target.sagaId}, ${target.ordinal}, ${target.batchOrdinal}, ${target.checkpointTurnCount},
        ${target.logicalCheckpointId}, ${target.expectedCheckpointOid}, ${target.deleteOperationId}
      )
    `,
  });

  const selectSaga = `
    SELECT
      saga_id AS "sagaId", source_revert_event_id AS "sourceRevertEventId",
      source_command_id AS "sourceCommandId", provider_instance_id AS "providerInstanceId",
      project_id AS "projectId", thread_id AS "threadId",
      provider_driver_kind AS "providerDriverKind",
      continuation_identity_sha256 AS "continuationIdentitySha256",
      requested_turn_count AS "requestedTurnCount", preimage_turn_count AS "preimageTurnCount",
      preimage_digest_count AS "preimageDigestCount",
      preimage_digest_sha256 AS "preimageDigestSha256",
      target_digest_count AS "targetDigestCount", target_digest_sha256 AS "targetDigestSha256",
      retained_logical_checkpoint_id AS "retainedLogicalCheckpointId",
      retained_expected_oid AS "retainedExpectedCheckpointOid",
      repository_fingerprint AS "repositoryFingerprint",
      repository_object_format AS "repositoryObjectFormat",
      restore_operation_id AS "restoreOperationId", state, error_json AS "error",
      created_at AS "createdAt", updated_at AS "updatedAt",
      finalization_started_at AS "finalizationStartedAt",
      finalization_sequence AS "finalizationSequence", completed_at AS "completedAt"
    FROM checkpoint_revert_sagas
  `;

  const findBySagaId = SqlSchema.findOneOption({
    Request: GetCheckpointRevertSagaInput,
    Result: SagaDbRow,
    execute: ({ sagaId }) => sql.unsafe(`${selectSaga} WHERE saga_id = ?`, [sagaId]),
  });

  const findBySource = SqlSchema.findOneOption({
    Request: GetCheckpointRevertSagaBySourceInput,
    Result: SagaDbRow,
    execute: ({ sourceRevertEventId }) =>
      sql.unsafe(`${selectSaga} WHERE source_revert_event_id = ?`, [sourceRevertEventId]),
  });

  const findActiveByThread = SqlSchema.findOneOption({
    Request: GetActiveCheckpointRevertSagaByThreadInput,
    Result: SagaDbRow,
    execute: ({ threadId }) =>
      sql.unsafe(
        `${selectSaga}
         WHERE thread_id = ?
           AND state NOT IN ('completed', 'failed', 'indeterminate')`,
        [threadId],
      ),
  });

  const listTargets = SqlSchema.findAll({
    Request: ListCheckpointRevertStaleTargetsInput,
    Result: CheckpointRevertStaleTarget,
    execute: ({ sagaId }) => sql`
      SELECT
        saga_id AS "sagaId", ordinal, batch_ordinal AS "batchOrdinal",
        checkpoint_turn_count AS "checkpointTurnCount",
        logical_checkpoint_id AS "logicalCheckpointId",
        expected_checkpoint_oid AS "expectedCheckpointOid",
        delete_operation_id AS "deleteOperationId"
      FROM checkpoint_revert_stale_targets
      WHERE saga_id = ${sagaId}
      ORDER BY ordinal
    `,
  });

  const listRecovery = SqlSchema.findAll({
    Request: ListCheckpointRevertRecoveryInput,
    Result: SagaDbRow,
    execute: ({ after, limit }) =>
      after === null
        ? sql.unsafe(
            `${selectSaga}
             WHERE state NOT IN ('completed', 'failed', 'indeterminate')
             ORDER BY created_at, saga_id
             LIMIT ?`,
            [limit + 1],
          )
        : sql.unsafe(
            `${selectSaga}
             WHERE state NOT IN ('completed', 'failed', 'indeterminate')
               AND (created_at > ? OR (created_at = ? AND saga_id > ?))
             ORDER BY created_at, saga_id
             LIMIT ?`,
            [after.createdAt, after.createdAt, after.sagaId, limit + 1],
          ),
  });

  const materializeSaga = (row: typeof SagaDbRow.Type) =>
    decodeSaga({
      sagaId: row.sagaId,
      sourceRevertEventId: row.sourceRevertEventId,
      sourceCommandId: row.sourceCommandId,
      providerInstanceId: row.providerInstanceId,
      projectId: row.projectId,
      threadId: row.threadId,
      providerDriverKind: row.providerDriverKind,
      continuationIdentitySha256: row.continuationIdentitySha256,
      requestedTurnCount: row.requestedTurnCount,
      preimageTurnCount: row.preimageTurnCount,
      preimage: { count: row.preimageDigestCount, sha256: row.preimageDigestSha256 },
      target: { count: row.targetDigestCount, sha256: row.targetDigestSha256 },
      retainedLogicalCheckpointId: row.retainedLogicalCheckpointId,
      retainedExpectedCheckpointOid: row.retainedExpectedCheckpointOid,
      repositoryFingerprint: row.repositoryFingerprint,
      repositoryObjectFormat: row.repositoryObjectFormat,
      restoreOperationId: row.restoreOperationId,
      state: row.state,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finalizationStartedAt: row.finalizationStartedAt,
      finalizationSequence: row.finalizationSequence,
      completedAt: row.completedAt,
    });

  const getChanges = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ChangesRow,
    execute: () => sql`SELECT changes() AS "changes"`,
  });

  const getState = SqlSchema.findOneOption({
    Request: GetCheckpointRevertSagaInput,
    Result: StateRow,
    execute: ({ sagaId }) => sql`
      SELECT state FROM checkpoint_revert_sagas WHERE saga_id = ${sagaId}
    `,
  });

  const transition = Effect.fn("CheckpointRevertSagaRepository.transition")(function* (
    sagaId: CheckpointRevertSagaId,
    requestedState: CheckpointRevertSagaState,
    update: Effect.Effect<void, Schema.SchemaError | SqlError>,
  ) {
    yield* update;
    const { changes } = yield* getChanges(undefined);
    if (changes === 1) return;
    const current = yield* getState({ sagaId });
    return yield* new CheckpointRevertSagaTransitionError({
      sagaId,
      requestedState,
      currentState: Option.match(current, { onNone: () => null, onSome: (row) => row.state }),
    });
  });

  const simpleTransition = (
    allowed: ReadonlyArray<CheckpointRevertSagaState>,
    requested: CheckpointRevertSagaState,
  ) =>
    SqlSchema.void({
      Request: CheckpointRevertSagaTransitionInput,
      execute: ({ sagaId, updatedAt }) => sql`
        UPDATE checkpoint_revert_sagas
        SET state = ${requested}, error_json = NULL, updated_at = ${updatedAt}
        WHERE saga_id = ${sagaId}
          AND state IN ${sql.in(allowed)}
      `,
    });

  const updateRollbackInFlight = simpleTransition(["prepared"], "rollback_in_flight");
  const updateRollbackCompleted = simpleTransition(
    ["rollback_in_flight", "rollback_outcome_unknown"],
    "rollback_completed",
  );
  const updateRestoring = simpleTransition(["rollback_completed"], "restoring");
  const updateRestored = simpleTransition(["restoring"], "restored");

  const errorTransition = (
    allowed: ReadonlyArray<CheckpointRevertSagaState>,
    requested: CheckpointRevertSagaState,
  ) =>
    SqlSchema.void({
      Request: ErrorTransitionDbInput,
      execute: ({ sagaId, updatedAt, error }) => sql`
        UPDATE checkpoint_revert_sagas
        SET state = ${requested}, error_json = ${error}, updated_at = ${updatedAt}
        WHERE saga_id = ${sagaId}
          AND state IN ${sql.in(allowed)}
      `,
    });

  const updateFailed = errorTransition(["prepared"], "failed");
  const updateRollbackUnknown = errorTransition(["rollback_in_flight"], "rollback_outcome_unknown");
  const updateIndeterminate = errorTransition(
    [
      "rollback_in_flight",
      "rollback_outcome_unknown",
      "rollback_completed",
      "restoring",
      "restored",
    ],
    "indeterminate",
  );

  const updateFinalizationStarted = SqlSchema.void({
    Request: BeginCheckpointRevertFinalizationInput,
    execute: ({ sagaId, finalizationStartedAt, updatedAt }) => sql`
      UPDATE checkpoint_revert_sagas
      SET finalization_started_at = ${finalizationStartedAt}, updated_at = ${updatedAt}
      WHERE saga_id = ${sagaId}
        AND state = 'restored'
        AND finalization_started_at IS NULL
    `,
  });

  const updateDomainFinalized = SqlSchema.void({
    Request: FinalizeCheckpointRevertDomainInput,
    execute: ({ sagaId, sequence, updatedAt }) => sql`
      UPDATE checkpoint_revert_sagas
      SET state = 'domain_finalized', finalization_sequence = ${sequence}, updated_at = ${updatedAt}
      WHERE saga_id = ${sagaId}
        AND state = 'restored'
        AND finalization_started_at IS NOT NULL
        AND finalization_sequence IS NULL
    `,
  });

  const updateCompleted = SqlSchema.void({
    Request: CompleteCheckpointRevertSagaInput,
    execute: ({ sagaId, completedAt, updatedAt }) => sql`
      UPDATE checkpoint_revert_sagas
      SET state = 'completed', completed_at = ${completedAt}, updated_at = ${updatedAt}
      WHERE saga_id = ${sagaId}
        AND state = 'domain_finalized'
        AND finalization_sequence IS NOT NULL
    `,
  });

  const runTransition = (
    sagaId: CheckpointRevertSagaId,
    requestedState: CheckpointRevertSagaState,
    update: Effect.Effect<void, Schema.SchemaError | SqlError>,
  ) =>
    sql.withTransaction(transition(sagaId, requestedState, update)).pipe(Effect.mapError(mapError));

  const getBySagaId: CheckpointRevertSagaRepositoryShape["getBySagaId"] = (input) =>
    findBySagaId(input).pipe(
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) => materializeSaga(value).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );

  const getBySourceEventId: CheckpointRevertSagaRepositoryShape["getBySourceEventId"] = (input) =>
    findBySource(input).pipe(
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) => materializeSaga(value).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );

  const getActiveByThread: CheckpointRevertSagaRepositoryShape["getActiveByThread"] = (input) =>
    findActiveByThread(input).pipe(
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) => materializeSaga(value).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );

  const listStaleTargets: CheckpointRevertSagaRepositoryShape["listStaleTargets"] = (input) =>
    listTargets(input).pipe(Effect.mapError(mapError));

  const getOrCreate: CheckpointRevertSagaRepositoryShape["getOrCreate"] = (input) => {
    const sagaId = checkpointRevertSagaId(input.sourceRevertEventId);
    const expectedRestoreOperationId = makeRestoreCheckpointOperationId({
      revertEventId: input.sourceRevertEventId,
    });
    return Schema.decodeUnknownEffect(CreateCheckpointRevertSagaInput)(input).pipe(
      Effect.flatMap((validated) => {
        const expectedTargets = materializeTargets(
          sagaId,
          validated.sourceRevertEventId,
          validated.staleTargets,
        );
        return validated.restoreOperationId !== expectedRestoreOperationId
          ? new CheckpointRevertSagaConflictError({
              sourceRevertEventId: validated.sourceRevertEventId,
              sagaId,
            })
          : sql.withTransaction(
              Effect.gen(function* () {
                yield* insertSaga({ ...validated, sagaId });
                const { changes } = yield* getChanges(undefined);
                const inserted = changes === 1;
                if (inserted) {
                  yield* Effect.forEach(expectedTargets, insertTarget, { discard: true });
                }
                const row = yield* findBySource({
                  sourceRevertEventId: validated.sourceRevertEventId,
                });
                if (Option.isNone(row)) {
                  const active = yield* findActiveByThread({ threadId: validated.threadId });
                  if (Option.isSome(active)) {
                    return yield* new CheckpointRevertActiveSagaConflictError({
                      threadId: validated.threadId,
                      activeSagaId: active.value.sagaId,
                    });
                  }
                  return yield* Effect.die("Checkpoint revert saga insert conflict had no owner.");
                }
                const saga = yield* materializeSaga(row.value);
                const staleTargets = yield* listTargets({ sagaId: saga.sagaId });
                const expectedImmutable = {
                  sagaId,
                  sourceRevertEventId: validated.sourceRevertEventId,
                  sourceCommandId: validated.sourceCommandId,
                  providerInstanceId: validated.providerInstanceId,
                  projectId: validated.projectId,
                  threadId: validated.threadId,
                  providerDriverKind: validated.providerDriverKind,
                  continuationIdentitySha256: validated.continuationIdentitySha256,
                  requestedTurnCount: validated.requestedTurnCount,
                  preimageTurnCount: validated.preimageTurnCount,
                  preimage: validated.preimage,
                  target: validated.target,
                  retainedLogicalCheckpointId: validated.retainedLogicalCheckpointId,
                  retainedExpectedCheckpointOid: validated.retainedExpectedCheckpointOid,
                  repositoryFingerprint: validated.repositoryFingerprint,
                  repositoryObjectFormat: validated.repositoryObjectFormat,
                  restoreOperationId: validated.restoreOperationId,
                  createdAt: validated.createdAt,
                };
                const actualImmutable = {
                  sagaId: saga.sagaId,
                  sourceRevertEventId: saga.sourceRevertEventId,
                  sourceCommandId: saga.sourceCommandId,
                  providerInstanceId: saga.providerInstanceId,
                  projectId: saga.projectId,
                  threadId: saga.threadId,
                  providerDriverKind: saga.providerDriverKind,
                  continuationIdentitySha256: saga.continuationIdentitySha256,
                  requestedTurnCount: saga.requestedTurnCount,
                  preimageTurnCount: saga.preimageTurnCount,
                  preimage: saga.preimage,
                  target: saga.target,
                  retainedLogicalCheckpointId: saga.retainedLogicalCheckpointId,
                  retainedExpectedCheckpointOid: saga.retainedExpectedCheckpointOid,
                  repositoryFingerprint: saga.repositoryFingerprint,
                  repositoryObjectFormat: saga.repositoryObjectFormat,
                  restoreOperationId: saga.restoreOperationId,
                  createdAt: saga.createdAt,
                };
                if (
                  stableJson(actualImmutable) !== stableJson(expectedImmutable) ||
                  stableJson(staleTargets) !== stableJson(expectedTargets)
                ) {
                  return yield* new CheckpointRevertSagaConflictError({
                    sourceRevertEventId: validated.sourceRevertEventId,
                    sagaId,
                  });
                }
                return { saga, staleTargets, inserted };
              }),
            );
      }),
      Effect.mapError(mapError),
    );
  };

  const listRecoveryPage: CheckpointRevertSagaRepositoryShape["listRecoveryPage"] = (input) =>
    listRecovery(input).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, materializeSaga)),
      Effect.map((rows) => {
        const items = rows.slice(0, input.limit);
        const last = rows.length > input.limit ? items.at(-1) : undefined;
        const nextCursor: CheckpointRevertRecoveryCursor | null =
          last === undefined ? null : { createdAt: last.createdAt, sagaId: last.sagaId };
        return { items, nextCursor };
      }),
      Effect.mapError(mapError),
    );

  const markRollbackInFlight: CheckpointRevertSagaRepositoryShape["markRollbackInFlight"] = (
    input,
  ) => runTransition(input.sagaId, "rollback_in_flight", updateRollbackInFlight(input));
  const markRollbackCompleted: CheckpointRevertSagaRepositoryShape["markRollbackCompleted"] = (
    input,
  ) => runTransition(input.sagaId, "rollback_completed", updateRollbackCompleted(input));
  const markRestoring: CheckpointRevertSagaRepositoryShape["markRestoring"] = (input) =>
    runTransition(input.sagaId, "restoring", updateRestoring(input));
  const markRestored: CheckpointRevertSagaRepositoryShape["markRestored"] = (input) =>
    runTransition(input.sagaId, "restored", updateRestored(input));
  const failBeforeRollback: CheckpointRevertSagaRepositoryShape["failBeforeRollback"] = (input) =>
    runTransition(input.sagaId, "failed", updateFailed(input));
  const markRollbackOutcomeUnknown: CheckpointRevertSagaRepositoryShape["markRollbackOutcomeUnknown"] =
    (input) =>
      runTransition(input.sagaId, "rollback_outcome_unknown", updateRollbackUnknown(input));
  const markIndeterminate: CheckpointRevertSagaRepositoryShape["markIndeterminate"] = (input) =>
    runTransition(input.sagaId, "indeterminate", updateIndeterminate(input));

  const beginDomainFinalization: CheckpointRevertSagaRepositoryShape["beginDomainFinalization"] = (
    input,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* updateFinalizationStarted(input);
          const { changes } = yield* getChanges(undefined);
          if (changes === 1) return;
          const current = yield* findBySagaId({ sagaId: input.sagaId });
          if (
            Option.isSome(current) &&
            current.value.state === "restored" &&
            current.value.finalizationStartedAt === input.finalizationStartedAt
          ) {
            return;
          }
          return yield* new CheckpointRevertSagaTransitionError({
            sagaId: input.sagaId,
            requestedState: "restored",
            currentState: Option.match(current, {
              onNone: () => null,
              onSome: (row) => row.state,
            }),
          });
        }),
      )
      .pipe(Effect.mapError(mapError));

  const markDomainFinalized: CheckpointRevertSagaRepositoryShape["markDomainFinalized"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* updateDomainFinalized(input);
          const { changes } = yield* getChanges(undefined);
          if (changes === 1) return;
          const current = yield* findBySagaId({ sagaId: input.sagaId });
          if (
            Option.isSome(current) &&
            current.value.state === "domain_finalized" &&
            current.value.finalizationSequence === input.sequence
          ) {
            return;
          }
          return yield* new CheckpointRevertSagaTransitionError({
            sagaId: input.sagaId,
            requestedState: "domain_finalized",
            currentState: Option.match(current, {
              onNone: () => null,
              onSome: (row) => row.state,
            }),
          });
        }),
      )
      .pipe(Effect.mapError(mapError));
  const complete: CheckpointRevertSagaRepositoryShape["complete"] = (input) =>
    runTransition(input.sagaId, "completed", updateCompleted(input));

  return {
    getOrCreate,
    getBySagaId,
    getBySourceEventId,
    getActiveByThread,
    listStaleTargets,
    listRecoveryPage,
    markRollbackInFlight,
    markRollbackCompleted,
    markRestoring,
    markRestored,
    failBeforeRollback,
    markRollbackOutcomeUnknown,
    markIndeterminate,
    beginDomainFinalization,
    markDomainFinalized,
    complete,
  } satisfies CheckpointRevertSagaRepositoryShape;
});

export const CheckpointRevertSagaRepositoryLive = Layer.effect(
  CheckpointRevertSagaRepository,
  make,
);
