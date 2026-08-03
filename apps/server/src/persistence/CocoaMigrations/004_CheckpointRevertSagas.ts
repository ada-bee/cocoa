import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE checkpoint_revert_sagas (
      saga_id TEXT PRIMARY KEY
        CHECK (length(saga_id) = 64 AND saga_id NOT GLOB '*[^0-9a-f]*'),
      source_revert_event_id TEXT NOT NULL UNIQUE,
      source_command_id TEXT,
      provider_instance_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_driver_kind TEXT NOT NULL,
      continuation_identity_sha256 TEXT NOT NULL
        CHECK (
          length(continuation_identity_sha256) = 64
          AND continuation_identity_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      requested_turn_count INTEGER NOT NULL CHECK (requested_turn_count >= 0),
      preimage_turn_count INTEGER NOT NULL CHECK (preimage_turn_count >= requested_turn_count),
      preimage_digest_count INTEGER NOT NULL CHECK (preimage_digest_count = preimage_turn_count),
      preimage_digest_sha256 TEXT NOT NULL
        CHECK (length(preimage_digest_sha256) = 64 AND preimage_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      target_digest_count INTEGER NOT NULL CHECK (target_digest_count = requested_turn_count),
      target_digest_sha256 TEXT NOT NULL
        CHECK (length(target_digest_sha256) = 64 AND target_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      retained_logical_checkpoint_id TEXT NOT NULL,
      retained_expected_oid TEXT NOT NULL
        CHECK (
          length(retained_expected_oid) IN (40, 64)
          AND retained_expected_oid NOT GLOB '*[^0-9a-f]*'
        ),
      repository_fingerprint TEXT NOT NULL
        CHECK (length(repository_fingerprint) = 64 AND repository_fingerprint NOT GLOB '*[^0-9a-f]*'),
      repository_object_format TEXT NOT NULL CHECK (repository_object_format IN ('sha1', 'sha256')),
      restore_operation_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (
        state IN (
          'prepared',
          'rollback_in_flight',
          'rollback_completed',
          'restoring',
          'restored',
          'domain_finalized',
          'completed',
          'failed',
          'rollback_outcome_unknown',
          'indeterminate'
        )
      ),
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finalization_started_at TEXT,
      finalization_sequence INTEGER CHECK (finalization_sequence IS NULL OR finalization_sequence >= 0),
      completed_at TEXT,
      CHECK (
        (state IN (
          'prepared', 'rollback_in_flight', 'rollback_completed', 'restoring', 'restored',
          'domain_finalized', 'completed'
        ) AND error_json IS NULL)
        OR (state IN ('failed', 'rollback_outcome_unknown', 'indeterminate') AND error_json IS NOT NULL)
      ),
      CHECK (
        (state IN ('domain_finalized', 'completed')
          AND finalization_started_at IS NOT NULL
          AND finalization_sequence IS NOT NULL)
        OR state NOT IN ('domain_finalized', 'completed')
      ),
      CHECK (state = 'completed' OR completed_at IS NULL),
      CHECK (state <> 'completed' OR completed_at IS NOT NULL)
    )
  `;

  yield* sql`
    CREATE INDEX checkpoint_revert_sagas_recovery
    ON checkpoint_revert_sagas(created_at, saga_id)
    WHERE state NOT IN ('completed', 'failed', 'indeterminate')
  `;

  yield* sql`
    CREATE UNIQUE INDEX checkpoint_revert_sagas_one_active_per_thread
    ON checkpoint_revert_sagas(thread_id)
    WHERE state NOT IN ('completed', 'failed', 'indeterminate')
  `;

  yield* sql`
    CREATE INDEX checkpoint_revert_sagas_thread
    ON checkpoint_revert_sagas(thread_id, created_at, saga_id)
  `;

  yield* sql`
    CREATE TABLE checkpoint_revert_stale_targets (
      saga_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      batch_ordinal INTEGER NOT NULL CHECK (batch_ordinal = CAST(ordinal / 256 AS INTEGER)),
      checkpoint_turn_count INTEGER NOT NULL CHECK (checkpoint_turn_count >= 0),
      logical_checkpoint_id TEXT NOT NULL,
      expected_checkpoint_oid TEXT NOT NULL
        CHECK (
          length(expected_checkpoint_oid) IN (40, 64)
          AND expected_checkpoint_oid NOT GLOB '*[^0-9a-f]*'
        ),
      delete_operation_id TEXT NOT NULL,
      PRIMARY KEY (saga_id, ordinal),
      UNIQUE (saga_id, logical_checkpoint_id),
      FOREIGN KEY (saga_id) REFERENCES checkpoint_revert_sagas(saga_id) ON DELETE RESTRICT
    )
  `;

  yield* sql`
    CREATE INDEX checkpoint_revert_stale_targets_batches
    ON checkpoint_revert_stale_targets(saga_id, batch_ordinal, ordinal)
  `;

  yield* sql`
    ALTER TABLE checkpoint_operations
    ADD COLUMN safe_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (safe_retry_count >= 0)
  `;
});
