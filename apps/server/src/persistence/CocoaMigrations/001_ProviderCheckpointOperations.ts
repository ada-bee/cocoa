import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE checkpoint_operations (
      operation_id TEXT PRIMARY KEY,
      logical_checkpoint_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT,
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('capture', 'restore', 'delete')),
      intent_key TEXT NOT NULL
        CHECK (length(intent_key) = 64 AND intent_key NOT GLOB '*[^0-9a-f]*'),
      intent_context_json TEXT NOT NULL CHECK (json_valid(intent_context_json)),
      canonical_request_json TEXT NOT NULL CHECK (json_valid(canonical_request_json)),
      request_sha256 TEXT NOT NULL
        CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      repository_fingerprint TEXT NOT NULL
        CHECK (length(repository_fingerprint) = 64 AND repository_fingerprint NOT GLOB '*[^0-9a-f]*'),
      repository_object_format TEXT NOT NULL CHECK (repository_object_format IN ('sha1', 'sha256')),
      provider_generation INTEGER CHECK (provider_generation IS NULL OR provider_generation >= 0),
      state TEXT NOT NULL
        CHECK (state IN ('prepared', 'in_flight', 'outcome_unknown', 'completed', 'failed', 'indeterminate')),
      receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      prepared_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finalized_sequence INTEGER CHECK (finalized_sequence IS NULL OR finalized_sequence >= 0),
      CHECK (turn_id IS NULL OR thread_id IS NOT NULL),
      CHECK (finalized_sequence IS NULL OR state IN ('completed', 'failed', 'indeterminate')),
      CHECK (json_type(canonical_request_json, '$.operationId') = 'text' AND json_extract(canonical_request_json, '$.operationId') = operation_id),
      CHECK (json_type(canonical_request_json, '$.operation') = 'text' AND json_extract(canonical_request_json, '$.operation') = operation_kind),
      CHECK (receipt_json IS NULL OR (json_type(receipt_json, '$.operation') = 'text' AND json_extract(receipt_json, '$.operation') = operation_kind)),
      CHECK (result_json IS NULL OR (json_type(result_json, '$.operation') = 'text' AND json_extract(result_json, '$.operation') = operation_kind)),
      CHECK (
        (state IN ('prepared', 'in_flight') AND receipt_json IS NULL AND result_json IS NULL AND error_json IS NULL)
        OR (state = 'outcome_unknown' AND receipt_json IS NULL AND result_json IS NULL AND error_json IS NOT NULL)
        OR (state = 'completed' AND (receipt_json IS NOT NULL OR result_json IS NOT NULL) AND error_json IS NULL)
        OR (state IN ('failed', 'indeterminate') AND receipt_json IS NULL AND result_json IS NULL AND error_json IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX checkpoint_operations_unique_intent
    ON checkpoint_operations(provider_instance_id, project_id, intent_key)
  `;

  yield* sql`
    CREATE UNIQUE INDEX checkpoint_operations_unique_capture
    ON checkpoint_operations(provider_instance_id, project_id, logical_checkpoint_id)
    WHERE operation_kind = 'capture'
  `;

  yield* sql`
    CREATE TABLE checkpoint_operation_targets (
      operation_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      logical_checkpoint_id TEXT NOT NULL,
      expected_checkpoint_oid TEXT
        CHECK (
          expected_checkpoint_oid IS NULL
          OR (length(expected_checkpoint_oid) IN (40, 64) AND expected_checkpoint_oid NOT GLOB '*[^0-9a-f]*')
        ),
      PRIMARY KEY (operation_id, ordinal),
      UNIQUE (operation_id, logical_checkpoint_id),
      FOREIGN KEY (operation_id) REFERENCES checkpoint_operations(operation_id) ON DELETE RESTRICT
    )
  `;

  yield* sql`
    CREATE INDEX checkpoint_operation_targets_logical
    ON checkpoint_operation_targets(logical_checkpoint_id, operation_id)
  `;

  yield* sql`
    CREATE INDEX checkpoint_operations_recovery
    ON checkpoint_operations(provider_instance_id, finalized_sequence, state, prepared_at, operation_id)
  `;

  yield* sql`
    CREATE INDEX checkpoint_operations_logical
    ON checkpoint_operations(logical_checkpoint_id, prepared_at, operation_id)
  `;

  yield* sql`
    CREATE TABLE provider_native_checkpoints (
      logical_checkpoint_id TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT,
      repository_fingerprint TEXT NOT NULL
        CHECK (length(repository_fingerprint) = 64 AND repository_fingerprint NOT GLOB '*[^0-9a-f]*'),
      repository_object_format TEXT NOT NULL CHECK (repository_object_format IN ('sha1', 'sha256')),
      capture_operation_id TEXT NOT NULL UNIQUE,
      checkpoint_ref TEXT NOT NULL,
      checkpoint_oid TEXT NOT NULL CHECK (length(checkpoint_oid) IN (40, 64) AND checkpoint_oid NOT GLOB '*[^0-9a-f]*'),
      tree_oid TEXT NOT NULL CHECK (length(tree_oid) IN (40, 64) AND tree_oid NOT GLOB '*[^0-9a-f]*'),
      receipt_ref TEXT NOT NULL,
      receipt_object_oid TEXT NOT NULL
        CHECK (length(receipt_object_oid) IN (40, 64) AND receipt_object_oid NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (turn_id IS NULL OR thread_id IS NOT NULL),
      CHECK (checkpoint_ref = 'refs/cocoa/checkpoints/v1/' || logical_checkpoint_id),
      CHECK (receipt_ref = 'refs/cocoa/checkpoint-receipts/v1/' || capture_operation_id),
      FOREIGN KEY (capture_operation_id) REFERENCES checkpoint_operations(operation_id) ON DELETE RESTRICT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX provider_native_checkpoints_native_ref
    ON provider_native_checkpoints(provider_instance_id, repository_fingerprint, checkpoint_ref)
  `;

  yield* sql`
    CREATE INDEX provider_native_checkpoints_thread
    ON provider_native_checkpoints(provider_instance_id, project_id, thread_id, created_at, logical_checkpoint_id)
  `;

  yield* sql`
    CREATE TRIGGER provider_native_checkpoints_validate_insert
    BEFORE INSERT ON provider_native_checkpoints
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM checkpoint_operations operation
        WHERE operation.operation_id = NEW.capture_operation_id
          AND operation.operation_kind = 'capture'
          AND operation.state = 'completed'
          AND operation.logical_checkpoint_id = NEW.logical_checkpoint_id
          AND operation.provider_instance_id = NEW.provider_instance_id
          AND operation.project_id = NEW.project_id
          AND operation.thread_id IS NEW.thread_id
          AND operation.turn_id IS NEW.turn_id
          AND operation.repository_fingerprint = NEW.repository_fingerprint
          AND operation.repository_object_format = NEW.repository_object_format
      ) THEN RAISE(ABORT, 'provider checkpoint requires matching completed capture') END;
    END
  `;

  yield* sql`
    CREATE TRIGGER provider_native_checkpoints_validate_update
    BEFORE UPDATE ON provider_native_checkpoints
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM checkpoint_operations operation
        WHERE operation.operation_id = NEW.capture_operation_id
          AND operation.operation_kind = 'capture'
          AND operation.state = 'completed'
          AND operation.logical_checkpoint_id = NEW.logical_checkpoint_id
          AND operation.provider_instance_id = NEW.provider_instance_id
          AND operation.project_id = NEW.project_id
          AND operation.thread_id IS NEW.thread_id
          AND operation.turn_id IS NEW.turn_id
          AND operation.repository_fingerprint = NEW.repository_fingerprint
          AND operation.repository_object_format = NEW.repository_object_format
      ) THEN RAISE(ABORT, 'provider checkpoint requires matching completed capture') END;
    END
  `;
});
