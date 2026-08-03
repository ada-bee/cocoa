import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import {
  CheckpointOperationState,
  CompleteProviderCheckpointOperationInput,
  FailProviderCheckpointOperationInput,
  FinalizeProviderCheckpointCaptureInput,
  GetProviderCheckpointOperationInput,
  GetProviderCheckpointOperationByIntentInput,
  GetProviderNativeCheckpointInput,
  IndeterminateProviderCheckpointOperationInput,
  ListPendingProviderCheckpointOperationsInput,
  ListProviderNativeCheckpointsInput,
  MarkProviderCheckpointInFlightInput,
  MarkProviderCheckpointFinalizedInput,
  MarkProviderCheckpointOutcomeUnknownInput,
  PrepareProviderCheckpointOperationInput,
  ProviderCheckpointCanonicalRequest,
  ProviderCheckpointOperation,
  ProviderCheckpointOperationError,
  ProviderCheckpointFinalizationError,
  ProviderCheckpointCompletionConflictError,
  ProviderCheckpointIntentConflictError,
  ProviderCheckpointProjectionConflictError,
  ProviderCheckpointIntentContext,
  ProviderCheckpointOperationTarget,
  ProviderCheckpointOperationRepository,
  ProviderCheckpointOperationTransitionError,
  ProviderCheckpointRepositoryDiagnostic,
  ProviderNativeCheckpoint,
  type ProviderCheckpointOperationRepositoryShape,
} from "../Services/ProviderCheckpointOperations.ts";
import {
  CodexCheckpointHelperMutationReceipt,
  CodexCheckpointHelperObjectFormat,
  CodexCheckpointHelperSha256,
  CodexCheckpointHelperCaptureResult,
  CodexCheckpointHelperRestoreResult,
  CodexCheckpointHelperDeleteResult,
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperCheckpointRef,
  CodexCheckpointHelperOid,
  CodexCheckpointHelperOperationId,
  CodexCheckpointHelperReceiptRef,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const MutationResult = Schema.Union([
  CodexCheckpointHelperCaptureResult,
  CodexCheckpointHelperRestoreResult,
  CodexCheckpointHelperDeleteResult,
]);

const OperationDbRow = strict(
  Schema.Struct({
    operationId: CodexCheckpointHelperOperationId,
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    threadId: Schema.NullOr(ThreadId),
    turnId: Schema.NullOr(TurnId),
    operationKind: Schema.Literals(["capture", "restore", "delete"]),
    intentKey: CodexCheckpointHelperSha256,
    intentContext: Schema.fromJsonString(ProviderCheckpointIntentContext),
    canonicalRequest: Schema.fromJsonString(ProviderCheckpointCanonicalRequest),
    requestSha256: CodexCheckpointHelperSha256,
    repositoryFingerprint: CodexCheckpointHelperSha256,
    repositoryObjectFormat: CodexCheckpointHelperObjectFormat,
    providerGeneration: Schema.NullOr(NonNegativeInt),
    state: CheckpointOperationState,
    receipt: Schema.NullOr(Schema.fromJsonString(CodexCheckpointHelperMutationReceipt)),
    result: Schema.NullOr(Schema.fromJsonString(MutationResult)),
    error: Schema.NullOr(Schema.fromJsonString(ProviderCheckpointOperationError)),
    preparedAt: IsoDateTime,
    updatedAt: IsoDateTime,
    finalizedSequence: Schema.NullOr(NonNegativeInt),
  }),
);

const PrepareDbInput = PrepareProviderCheckpointOperationInput.mapFields(
  Struct.assign({
    intentContext: Schema.fromJsonString(ProviderCheckpointIntentContext),
    canonicalRequest: Schema.fromJsonString(ProviderCheckpointCanonicalRequest),
  }),
);

const PrepareWithIntentKeyDbInput = Schema.Struct({
  ...PrepareDbInput.fields,
  intentKey: CodexCheckpointHelperSha256,
});

const CompleteDbInput = CompleteProviderCheckpointOperationInput.mapFields(
  Struct.assign({
    receipt: Schema.NullOr(Schema.fromJsonString(CodexCheckpointHelperMutationReceipt)),
    result: Schema.NullOr(Schema.fromJsonString(MutationResult)),
  }),
);

const ErrorTransitionDbInput = FailProviderCheckpointOperationInput.mapFields(
  Struct.assign({ error: Schema.fromJsonString(ProviderCheckpointOperationError) }),
);

const OutcomeUnknownDbInput = MarkProviderCheckpointOutcomeUnknownInput.mapFields(
  Struct.assign({ error: Schema.fromJsonString(ProviderCheckpointOperationError) }),
);

const ProviderNativeCheckpointDbRow = strict(
  Schema.Struct({
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    providerInstanceId: ProviderInstanceId,
    projectId: ProjectId,
    threadId: Schema.NullOr(ThreadId),
    turnId: Schema.NullOr(TurnId),
    repositoryFingerprint: CodexCheckpointHelperSha256,
    repositoryObjectFormat: CodexCheckpointHelperObjectFormat,
    captureOperationId: CodexCheckpointHelperOperationId,
    checkpointRef: CodexCheckpointHelperCheckpointRef,
    checkpointOid: CodexCheckpointHelperOid,
    treeOid: CodexCheckpointHelperOid,
    receiptRef: CodexCheckpointHelperReceiptRef,
    receiptObjectOid: CodexCheckpointHelperOid,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
);

const ChangesRow = Schema.Struct({ changes: Schema.Number });
const StateRow = Schema.Struct({
  state: CheckpointOperationState,
  finalizedSequence: Schema.NullOr(NonNegativeInt),
});
const TargetDbRow = Schema.Struct({
  logicalCheckpointId: CodexCheckpointHelperCheckpointId,
  expectedCheckpointOid: Schema.NullOr(CodexCheckpointHelperOid),
});

const toRepositoryError = (sqlOperation: string, decodeOperation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
    : new PersistenceSqlError({ operation: sqlOperation, cause });

const decodeOperation = Schema.decodeUnknownEffect(ProviderCheckpointOperation);
const decodeCheckpoint = Schema.decodeUnknownEffect(ProviderNativeCheckpoint);
const isTransitionError = Schema.is(ProviderCheckpointOperationTransitionError);

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

export const checkpointIntentKey = (context: ProviderCheckpointIntentContext) =>
  NodeCrypto.createHash("sha256").update(stableJson(context), "utf8").digest("hex");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertPrepared = SqlSchema.void({
    Request: PrepareWithIntentKeyDbInput,
    execute: (input) => sql`
      INSERT INTO checkpoint_operations (
        operation_id, logical_checkpoint_id, provider_instance_id, project_id,
        thread_id, turn_id, operation_kind, intent_key, intent_context_json, canonical_request_json,
        request_sha256, repository_fingerprint, repository_object_format,
        provider_generation, state, receipt_json, result_json, error_json,
        prepared_at, updated_at
      ) VALUES (
        ${input.operationId}, ${input.logicalCheckpointId}, ${input.providerInstanceId}, ${input.projectId},
        ${input.threadId}, ${input.turnId}, ${input.operationKind}, ${input.intentKey}, ${input.intentContext}, ${input.canonicalRequest},
        ${input.requestSha256}, ${input.repository.fingerprint}, ${input.repository.objectFormat},
        ${input.providerGeneration}, 'prepared', NULL, NULL, NULL,
        ${input.preparedAt}, ${input.preparedAt}
      )
    `,
  });

  const insertPreparedByIntent = SqlSchema.void({
    Request: PrepareWithIntentKeyDbInput,
    execute: (input) => sql`
      INSERT INTO checkpoint_operations (
        operation_id, logical_checkpoint_id, provider_instance_id, project_id,
        thread_id, turn_id, operation_kind, intent_key, intent_context_json, canonical_request_json,
        request_sha256, repository_fingerprint, repository_object_format,
        provider_generation, state, receipt_json, result_json, error_json,
        prepared_at, updated_at
      ) VALUES (
        ${input.operationId}, ${input.logicalCheckpointId}, ${input.providerInstanceId}, ${input.projectId},
        ${input.threadId}, ${input.turnId}, ${input.operationKind}, ${input.intentKey}, ${input.intentContext}, ${input.canonicalRequest},
        ${input.requestSha256}, ${input.repository.fingerprint}, ${input.repository.objectFormat},
        ${input.providerGeneration}, 'prepared', NULL, NULL, NULL,
        ${input.preparedAt}, ${input.preparedAt}
      )
      ON CONFLICT (provider_instance_id, project_id, intent_key) DO NOTHING
    `,
  });

  const insertTarget = SqlSchema.void({
    Request: Schema.Struct({
      operationId: CodexCheckpointHelperOperationId,
      ordinal: Schema.Int,
      target: ProviderCheckpointOperationTarget,
    }),
    execute: ({ operationId, ordinal, target }) => sql`
      INSERT INTO checkpoint_operation_targets (
        operation_id, ordinal, logical_checkpoint_id, expected_checkpoint_oid
      ) VALUES (
        ${operationId}, ${ordinal}, ${target.logicalCheckpointId}, ${target.expectedCheckpointOid}
      )
    `,
  });

  const requestTargets = (input: PrepareProviderCheckpointOperationInput) => {
    const request = input.canonicalRequest;
    if (request.operation === "capture") {
      return [{ logicalCheckpointId: request.checkpointId, expectedCheckpointOid: null }] as const;
    }
    if (request.operation === "restore") {
      return [
        {
          logicalCheckpointId: request.checkpointId,
          expectedCheckpointOid: request.expectedCheckpointOid,
        },
      ] as const;
    }
    return request.checkpoints.map((target) => ({
      logicalCheckpointId: target.checkpointId,
      expectedCheckpointOid: target.expectedCheckpointOid,
    }));
  };

  const updateInFlight = SqlSchema.void({
    Request: MarkProviderCheckpointInFlightInput,
    execute: (input) => sql`
      UPDATE checkpoint_operations
      SET state = 'in_flight',
          provider_generation = COALESCE(${input.providerGeneration ?? null}, provider_generation),
          updated_at = ${input.updatedAt}
      WHERE operation_id = ${input.operationId}
        AND state = 'prepared'
    `,
  });

  const updateOutcomeUnknown = SqlSchema.void({
    Request: OutcomeUnknownDbInput,
    execute: (input) => sql`
      UPDATE checkpoint_operations
      SET state = 'outcome_unknown', error_json = ${input.error}, updated_at = ${input.updatedAt}
      WHERE operation_id = ${input.operationId}
        AND state = 'in_flight'
    `,
  });

  const updateCompleted = SqlSchema.void({
    Request: CompleteDbInput,
    execute: (input) => sql`
      UPDATE checkpoint_operations
      SET state = 'completed', receipt_json = ${input.receipt}, result_json = ${input.result},
          error_json = NULL, updated_at = ${input.updatedAt}
      WHERE operation_id = ${input.operationId}
        AND state IN ('in_flight', 'outcome_unknown')
        AND (${input.receipt} IS NULL OR json_extract(${input.receipt}, '$.operation') = operation_kind)
        AND (${input.result} IS NULL OR json_extract(${input.result}, '$.operation') = operation_kind)
    `,
  });

  const updateFailed = SqlSchema.void({
    Request: ErrorTransitionDbInput,
    execute: (input) => sql`
      UPDATE checkpoint_operations
      SET state = 'failed', receipt_json = NULL, result_json = NULL,
          error_json = ${input.error}, updated_at = ${input.updatedAt}
      WHERE operation_id = ${input.operationId}
        AND state IN ('prepared', 'in_flight', 'outcome_unknown')
    `,
  });

  const updateIndeterminate = SqlSchema.void({
    Request: ErrorTransitionDbInput,
    execute: (input) => sql`
      UPDATE checkpoint_operations
      SET state = 'indeterminate', receipt_json = NULL, result_json = NULL,
          error_json = ${input.error}, updated_at = ${input.updatedAt}
      WHERE operation_id = ${input.operationId}
        AND state IN ('in_flight', 'outcome_unknown')
    `,
  });

  const updateFinalized = SqlSchema.void({
    Request: MarkProviderCheckpointFinalizedInput,
    execute: (input) => sql`
      UPDATE checkpoint_operations
      SET finalized_sequence = ${input.sequence}, updated_at = ${input.updatedAt}
      WHERE operation_id = ${input.operationId}
        AND state IN ('completed', 'failed', 'indeterminate')
        AND finalized_sequence IS NULL
    `,
  });

  const getChanges = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ChangesRow,
    execute: () => sql`SELECT changes() AS "changes"`,
  });

  const getState = SqlSchema.findOneOption({
    Request: GetProviderCheckpointOperationInput,
    Result: StateRow,
    execute: ({ operationId }) => sql`
      SELECT state, finalized_sequence AS "finalizedSequence"
      FROM checkpoint_operations
      WHERE operation_id = ${operationId}
    `,
  });

  const transition = Effect.fn("ProviderCheckpointOperationRepository.transition")(function* (
    operationId: CodexCheckpointHelperOperationId,
    requestedState: CheckpointOperationState,
    update: Effect.Effect<void, Schema.SchemaError | SqlError>,
  ) {
    yield* update;
    const { changes } = yield* getChanges(undefined);
    if (changes === 1) return;
    const current = yield* getState({ operationId });
    return yield* new ProviderCheckpointOperationTransitionError({
      operationId,
      requestedState,
      currentState: Option.match(current, { onNone: () => null, onSome: (row) => row.state }),
    });
  });

  const selectOperation = `
    SELECT
      operation_id AS "operationId", logical_checkpoint_id AS "logicalCheckpointId",
      provider_instance_id AS "providerInstanceId", project_id AS "projectId",
      thread_id AS "threadId", turn_id AS "turnId", operation_kind AS "operationKind",
      intent_key AS "intentKey", intent_context_json AS "intentContext",
      canonical_request_json AS "canonicalRequest", request_sha256 AS "requestSha256",
      repository_fingerprint AS "repositoryFingerprint",
      repository_object_format AS "repositoryObjectFormat",
      provider_generation AS "providerGeneration", state, receipt_json AS "receipt",
      result_json AS "result", error_json AS "error", prepared_at AS "preparedAt",
      updated_at AS "updatedAt", finalized_sequence AS "finalizedSequence"
    FROM checkpoint_operations
  `;

  const findOperation = SqlSchema.findOneOption({
    Request: GetProviderCheckpointOperationInput,
    Result: OperationDbRow,
    execute: ({ operationId }) =>
      sql.unsafe(`${selectOperation} WHERE operation_id = ?`, [operationId]),
  });

  const listPending = SqlSchema.findAll({
    Request: ListPendingProviderCheckpointOperationsInput,
    Result: OperationDbRow,
    execute: ({ providerInstanceId }) =>
      providerInstanceId === undefined
        ? sql.unsafe(
            `${selectOperation} WHERE finalized_sequence IS NULL ORDER BY prepared_at, operation_id`,
          )
        : sql.unsafe(
            `${selectOperation} WHERE provider_instance_id = ? AND finalized_sequence IS NULL ORDER BY prepared_at, operation_id`,
            [providerInstanceId],
          ),
  });

  const findOperationByIntentKey = SqlSchema.findOneOption({
    Request: Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      projectId: ProjectId,
      intentKey: CodexCheckpointHelperSha256,
    }),
    Result: OperationDbRow,
    execute: ({ providerInstanceId, projectId, intentKey }) =>
      sql.unsafe(
        `${selectOperation} WHERE provider_instance_id = ? AND project_id = ? AND intent_key = ?`,
        [providerInstanceId, projectId, intentKey],
      ),
  });

  const listTargets = SqlSchema.findAll({
    Request: GetProviderCheckpointOperationInput,
    Result: TargetDbRow,
    execute: ({ operationId }) => sql`
      SELECT
        logical_checkpoint_id AS "logicalCheckpointId",
        expected_checkpoint_oid AS "expectedCheckpointOid"
      FROM checkpoint_operation_targets
      WHERE operation_id = ${operationId}
      ORDER BY ordinal
    `,
  });

  const materializeOperation = Effect.fn(
    "ProviderCheckpointOperationRepository.materializeOperation",
  )(function* (row: typeof OperationDbRow.Type) {
    const targets = yield* listTargets({ operationId: row.operationId });
    return yield* decodeOperation({
      operationId: row.operationId,
      logicalCheckpointId: row.logicalCheckpointId,
      providerInstanceId: row.providerInstanceId,
      projectId: row.projectId,
      threadId: row.threadId,
      turnId: row.turnId,
      operationKind: row.operationKind,
      intentKey: row.intentKey,
      intentContext: row.intentContext,
      canonicalRequest: row.canonicalRequest,
      targets,
      requestSha256: row.requestSha256,
      repository: {
        fingerprint: row.repositoryFingerprint,
        objectFormat: row.repositoryObjectFormat,
      },
      providerGeneration: row.providerGeneration,
      state: row.state,
      receipt: row.receipt,
      result: row.result,
      error: row.error,
      preparedAt: row.preparedAt,
      updatedAt: row.updatedAt,
      finalizedSequence: row.finalizedSequence,
    });
  });

  const upsertCheckpoint = SqlSchema.void({
    Request: ProviderNativeCheckpoint,
    execute: (row) => sql`
      INSERT INTO provider_native_checkpoints (
        logical_checkpoint_id, provider_instance_id, project_id, thread_id, turn_id,
        repository_fingerprint, repository_object_format, capture_operation_id,
        checkpoint_ref, checkpoint_oid, tree_oid, receipt_ref, receipt_object_oid,
        created_at, updated_at
      ) VALUES (
        ${row.logicalCheckpointId}, ${row.providerInstanceId}, ${row.projectId}, ${row.threadId}, ${row.turnId},
        ${row.repository.fingerprint}, ${row.repository.objectFormat}, ${row.captureOperationId},
        ${row.checkpointRef}, ${row.checkpointOid}, ${row.treeOid}, ${row.receiptRef}, ${row.receiptObjectOid},
        ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (logical_checkpoint_id) DO UPDATE SET
        updated_at = excluded.updated_at
      WHERE provider_native_checkpoints.provider_instance_id = excluded.provider_instance_id
        AND provider_native_checkpoints.project_id = excluded.project_id
        AND provider_native_checkpoints.thread_id IS excluded.thread_id
        AND provider_native_checkpoints.turn_id IS excluded.turn_id
        AND provider_native_checkpoints.repository_fingerprint = excluded.repository_fingerprint
        AND provider_native_checkpoints.repository_object_format = excluded.repository_object_format
        AND provider_native_checkpoints.capture_operation_id = excluded.capture_operation_id
        AND provider_native_checkpoints.checkpoint_ref = excluded.checkpoint_ref
        AND provider_native_checkpoints.checkpoint_oid = excluded.checkpoint_oid
        AND provider_native_checkpoints.tree_oid = excluded.tree_oid
        AND provider_native_checkpoints.receipt_ref = excluded.receipt_ref
        AND provider_native_checkpoints.receipt_object_oid = excluded.receipt_object_oid
        AND provider_native_checkpoints.created_at = excluded.created_at
    `,
  });

  const selectCheckpoint = `
    SELECT
      logical_checkpoint_id AS "logicalCheckpointId",
      provider_instance_id AS "providerInstanceId", project_id AS "projectId",
      thread_id AS "threadId", turn_id AS "turnId",
      repository_fingerprint AS "repositoryFingerprint",
      repository_object_format AS "repositoryObjectFormat",
      capture_operation_id AS "captureOperationId", checkpoint_ref AS "checkpointRef",
      checkpoint_oid AS "checkpointOid", tree_oid AS "treeOid", receipt_ref AS "receiptRef",
      receipt_object_oid AS "receiptObjectOid", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM provider_native_checkpoints
  `;

  const findCheckpoint = SqlSchema.findOneOption({
    Request: GetProviderNativeCheckpointInput,
    Result: ProviderNativeCheckpointDbRow,
    execute: ({ logicalCheckpointId }) =>
      sql.unsafe(`${selectCheckpoint} WHERE logical_checkpoint_id = ?`, [logicalCheckpointId]),
  });

  const listCheckpoints = SqlSchema.findAll({
    Request: ListProviderNativeCheckpointsInput,
    Result: ProviderNativeCheckpointDbRow,
    execute: ({ providerInstanceId, projectId, threadId }) =>
      threadId === undefined
        ? sql.unsafe(
            `${selectCheckpoint} WHERE provider_instance_id = ? AND project_id = ? ORDER BY created_at, logical_checkpoint_id`,
            [providerInstanceId, projectId],
          )
        : sql.unsafe(
            `${selectCheckpoint} WHERE provider_instance_id = ? AND project_id = ? AND thread_id = ? ORDER BY created_at, logical_checkpoint_id`,
            [providerInstanceId, projectId, threadId],
          ),
  });

  const deleteCheckpoint = SqlSchema.void({
    Request: GetProviderNativeCheckpointInput,
    execute: ({ logicalCheckpointId }) => sql`
      DELETE FROM provider_native_checkpoints WHERE logical_checkpoint_id = ${logicalCheckpointId}
    `,
  });

  const deleteTargetCheckpoints = SqlSchema.void({
    Request: GetProviderCheckpointOperationInput,
    execute: ({ operationId }) => sql`
      DELETE FROM provider_native_checkpoints
      WHERE logical_checkpoint_id IN (
        SELECT logical_checkpoint_id
        FROM checkpoint_operation_targets
        WHERE operation_id = ${operationId}
      )
    `,
  });

  const mapPersistenceError = toRepositoryError(
    "ProviderCheckpointOperationRepository.query",
    "ProviderCheckpointOperationRepository.decode",
  );
  const isIntentConflict = Schema.is(ProviderCheckpointIntentConflictError);
  const isFinalizationError = Schema.is(ProviderCheckpointFinalizationError);
  const isProjectionConflict = Schema.is(ProviderCheckpointProjectionConflictError);
  const isCompletionConflict = Schema.is(ProviderCheckpointCompletionConflictError);
  const mapError = (cause: unknown) =>
    isTransitionError(cause) ||
    isIntentConflict(cause) ||
    isFinalizationError(cause) ||
    isProjectionConflict(cause) ||
    isCompletionConflict(cause)
      ? cause
      : mapPersistenceError(cause);

  const prepare: ProviderCheckpointOperationRepositoryShape["prepare"] = (input) =>
    sql
      .withTransaction(
        insertPrepared({ ...input, intentKey: checkpointIntentKey(input.intentContext) }).pipe(
          Effect.andThen(
            Effect.forEach(requestTargets(input), (target, ordinal) =>
              insertTarget({ operationId: input.operationId, ordinal, target }),
            ),
          ),
          Effect.asVoid,
        ),
      )
      .pipe(Effect.mapError(mapError));

  const getByIntent: ProviderCheckpointOperationRepositoryShape["getByIntent"] = (input) =>
    findOperationByIntentKey({
      providerInstanceId: input.providerInstanceId,
      projectId: input.projectId,
      intentKey: checkpointIntentKey(input.intentContext),
    }).pipe(
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) => materializeOperation(value).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );

  const getOrPrepare: ProviderCheckpointOperationRepositoryShape["getOrPrepare"] = (input) => {
    const intentKey = checkpointIntentKey(input.intentContext);
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* insertPreparedByIntent({ ...input, intentKey });
          const { changes } = yield* getChanges(undefined);
          const inserted = changes === 1;
          if (inserted) {
            yield* Effect.forEach(requestTargets(input), (target, ordinal) =>
              insertTarget({ operationId: input.operationId, ordinal, target }),
            );
          }
          const row = yield* findOperationByIntentKey({
            providerInstanceId: input.providerInstanceId,
            projectId: input.projectId,
            intentKey,
          });
          if (Option.isNone(row))
            return yield* Effect.die("Intent row disappeared inside transaction.");
          const operation = yield* materializeOperation(row.value);
          const sameImmutable =
            operation.operationId === input.operationId &&
            operation.logicalCheckpointId === input.logicalCheckpointId &&
            operation.providerInstanceId === input.providerInstanceId &&
            operation.projectId === input.projectId &&
            operation.threadId === input.threadId &&
            operation.turnId === input.turnId &&
            operation.operationKind === input.operationKind &&
            operation.requestSha256 === input.requestSha256 &&
            operation.repository.fingerprint === input.repository.fingerprint &&
            operation.repository.objectFormat === input.repository.objectFormat &&
            stableJson(operation.intentContext) === stableJson(input.intentContext) &&
            stableJson(operation.canonicalRequest) === stableJson(input.canonicalRequest) &&
            stableJson(operation.targets) === stableJson(requestTargets(input));
          if (!sameImmutable) {
            return yield* new ProviderCheckpointIntentConflictError({
              intentKey,
              existingOperationId: operation.operationId,
            });
          }
          return { operation, inserted };
        }),
      )
      .pipe(Effect.mapError(mapError));
  };

  const runTransition = (
    operationId: CodexCheckpointHelperOperationId,
    requestedState: CheckpointOperationState,
    update: Effect.Effect<void, Schema.SchemaError | SqlError>,
  ) =>
    sql
      .withTransaction(transition(operationId, requestedState, update))
      .pipe(Effect.mapError(mapError));

  const markInFlight: ProviderCheckpointOperationRepositoryShape["markInFlight"] = (input) =>
    runTransition(input.operationId, "in_flight", updateInFlight(input));
  const markOutcomeUnknown: ProviderCheckpointOperationRepositoryShape["markOutcomeUnknown"] = (
    input,
  ) => runTransition(input.operationId, "outcome_unknown", updateOutcomeUnknown(input));
  const complete: ProviderCheckpointOperationRepositoryShape["complete"] = (input) =>
    runTransition(input.operationId, "completed", updateCompleted(input));
  const finalizeCapture: ProviderCheckpointOperationRepositoryShape["finalizeCapture"] = (input) =>
    Schema.decodeUnknownEffect(FinalizeProviderCheckpointCaptureInput)(input).pipe(
      Effect.flatMap((validated) =>
        sql.withTransaction(
          transition(
            validated.completion.operationId,
            "completed",
            updateCompleted(validated.completion),
          ).pipe(Effect.andThen(upsertCheckpointExact(validated.checkpoint))),
        ),
      ),
      Effect.mapError(mapError),
    );
  const finalizeDelete: ProviderCheckpointOperationRepositoryShape["finalizeDelete"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* findOperation({ operationId: input.operationId });
          if (Option.isNone(row)) {
            return yield* new ProviderCheckpointCompletionConflictError({
              operationId: input.operationId,
            });
          }
          const operation = yield* materializeOperation(row.value);
          const result = input.result;
          const receipt = result?.operation === "delete" ? result.receipt : null;
          const exactTargets =
            operation.operationKind === "delete" &&
            receipt !== null &&
            receipt.operationId === operation.operationId &&
            receipt.requestSha256 === operation.requestSha256 &&
            receipt.repositoryFingerprint === operation.repository.fingerprint &&
            (input.receipt === null || stableJson(input.receipt) === stableJson(receipt)) &&
            receipt.checkpoints.length === operation.targets.length &&
            receipt.checkpoints.every((item, index) => {
              const target = operation.targets[index];
              return (
                item.checkpointId === target?.logicalCheckpointId &&
                (item.status === "already_absent" ||
                  item.deletedCheckpointOid === target.expectedCheckpointOid)
              );
            });
          if (!exactTargets) {
            return yield* new ProviderCheckpointCompletionConflictError({
              operationId: input.operationId,
            });
          }
          yield* transition(input.operationId, "completed", updateCompleted(input));
          yield* deleteTargetCheckpoints({ operationId: input.operationId });
        }),
      )
      .pipe(Effect.mapError(mapError));
  const fail: ProviderCheckpointOperationRepositoryShape["fail"] = (input) =>
    runTransition(input.operationId, "failed", updateFailed(input));
  const markIndeterminate: ProviderCheckpointOperationRepositoryShape["markIndeterminate"] = (
    input,
  ) => runTransition(input.operationId, "indeterminate", updateIndeterminate(input));
  const markFinalized: ProviderCheckpointOperationRepositoryShape["markFinalized"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* updateFinalized(input);
          const { changes } = yield* getChanges(undefined);
          if (changes === 1) return;
          const current = yield* getState({ operationId: input.operationId });
          if (
            Option.isSome(current) &&
            current.value.finalizedSequence === input.sequence &&
            (current.value.state === "completed" ||
              current.value.state === "failed" ||
              current.value.state === "indeterminate")
          ) {
            return;
          }
          return yield* new ProviderCheckpointFinalizationError({
            operationId: input.operationId,
            currentState: Option.match(current, { onNone: () => null, onSome: (row) => row.state }),
            finalizedSequence: Option.match(current, {
              onNone: () => null,
              onSome: (row) => row.finalizedSequence,
            }),
          });
        }),
      )
      .pipe(Effect.mapError(mapError));

  const getByOperationId: ProviderCheckpointOperationRepositoryShape["getByOperationId"] = (
    input,
  ) =>
    findOperation(input).pipe(
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) => materializeOperation(value).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );

  const listPendingRecovery: ProviderCheckpointOperationRepositoryShape["listPendingRecovery"] = (
    input,
  ) =>
    listPending(input).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, materializeOperation)),
      Effect.mapError(mapError),
    );

  const materializeCheckpoint = (row: typeof ProviderNativeCheckpointDbRow.Type) => {
    const { repositoryFingerprint, repositoryObjectFormat, ...checkpoint } = row;
    return decodeCheckpoint({
      ...checkpoint,
      repository: {
        fingerprint: repositoryFingerprint,
        objectFormat: repositoryObjectFormat,
      },
    });
  };

  const upsertCheckpointExact = Effect.fn(
    "ProviderCheckpointOperationRepository.upsertCheckpointExact",
  )(function* (row: ProviderNativeCheckpoint) {
    yield* upsertCheckpoint(row);
    const { changes } = yield* getChanges(undefined);
    if (changes === 1) return;
    return yield* new ProviderCheckpointProjectionConflictError({
      logicalCheckpointId: row.logicalCheckpointId,
    });
  });

  const upsertLogicalCheckpoint: ProviderCheckpointOperationRepositoryShape["upsertLogicalCheckpoint"] =
    (row) => sql.withTransaction(upsertCheckpointExact(row)).pipe(Effect.mapError(mapError));
  const getLogicalCheckpoint: ProviderCheckpointOperationRepositoryShape["getLogicalCheckpoint"] = (
    input,
  ) =>
    findCheckpoint(input).pipe(
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) => materializeCheckpoint(value).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(mapError),
    );
  const listLogicalCheckpoints: ProviderCheckpointOperationRepositoryShape["listLogicalCheckpoints"] =
    (input) =>
      listCheckpoints(input).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, materializeCheckpoint)),
        Effect.mapError(mapError),
      );
  const deleteLogicalCheckpoint: ProviderCheckpointOperationRepositoryShape["deleteLogicalCheckpoint"] =
    (input) => deleteCheckpoint(input).pipe(Effect.mapError(mapError));

  return {
    prepare,
    getOrPrepare,
    getByIntent,
    markInFlight,
    markOutcomeUnknown,
    complete,
    finalizeCapture,
    finalizeDelete,
    fail,
    markIndeterminate,
    markFinalized,
    getByOperationId,
    listPendingRecovery,
    upsertLogicalCheckpoint,
    getLogicalCheckpoint,
    listLogicalCheckpoints,
    deleteLogicalCheckpoint,
  } satisfies ProviderCheckpointOperationRepositoryShape;
});

export const ProviderCheckpointOperationRepositoryLive = Layer.effect(
  ProviderCheckpointOperationRepository,
  make,
);
