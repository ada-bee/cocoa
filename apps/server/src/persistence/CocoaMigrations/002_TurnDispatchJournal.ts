import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE turn_dispatch_journal (
      dispatch_id TEXT PRIMARY KEY,
      intent_key TEXT NOT NULL UNIQUE
        CHECK (length(intent_key) = 64 AND intent_key NOT GLOB '*[^0-9a-f]*'),
      source_event_id TEXT NOT NULL UNIQUE,
      source_command_id TEXT,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      checkpoint_turn_count INTEGER NOT NULL CHECK (checkpoint_turn_count >= 0),
      model_selection_json TEXT NOT NULL
        CHECK (
          json_valid(model_selection_json)
          AND length(CAST(model_selection_json AS BLOB)) <= 8192
        ),
      runtime_mode TEXT NOT NULL
        CHECK (runtime_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')),
      interaction_mode TEXT NOT NULL CHECK (interaction_mode IN ('default', 'plan')),
      title_seed_sha256 TEXT
        CHECK (
          title_seed_sha256 IS NULL
          OR (length(title_seed_sha256) = 64 AND title_seed_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
      baseline_logical_checkpoint_id TEXT,
      baseline_operation_id TEXT,
      baseline_not_applicable_reason TEXT
        CHECK (
          baseline_not_applicable_reason IS NULL
          OR baseline_not_applicable_reason IN ('not_repository', 'capability_unavailable')
        ),
      state TEXT NOT NULL
        CHECK (
          state IN (
            'awaiting_baseline', 'baseline_ready', 'baseline_not_applicable', 'provider_in_flight',
            'started', 'failed', 'indeterminate'
          )
        ),
      provider_turn_id TEXT
        CHECK (
          provider_turn_id IS NULL
          OR (
            length(provider_turn_id) BETWEEN 1 AND 256
            AND provider_turn_id = trim(provider_turn_id)
            AND instr(provider_turn_id, '/') = 0
            AND instr(provider_turn_id, char(92)) = 0
            AND provider_turn_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
          )
        ),
      error_json TEXT
        CHECK (
          error_json IS NULL
          OR (json_valid(error_json) AND length(CAST(error_json AS BLOB)) <= 1024)
        ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finalized_sequence INTEGER CHECK (finalized_sequence IS NULL OR finalized_sequence >= 0),
      CHECK (
        (baseline_logical_checkpoint_id IS NULL AND baseline_operation_id IS NULL)
        OR (baseline_logical_checkpoint_id IS NOT NULL AND baseline_operation_id IS NOT NULL)
      ),
      CHECK (
        baseline_not_applicable_reason IS NULL
        OR baseline_logical_checkpoint_id IS NULL
      ),
      CHECK (
        (state = 'awaiting_baseline'
          AND baseline_logical_checkpoint_id IS NULL
          AND baseline_not_applicable_reason IS NULL
          AND provider_turn_id IS NULL
          AND error_json IS NULL)
        OR (state = 'baseline_ready'
          AND baseline_logical_checkpoint_id IS NOT NULL
          AND baseline_not_applicable_reason IS NULL
          AND provider_turn_id IS NULL
          AND error_json IS NULL)
        OR (state = 'baseline_not_applicable'
          AND baseline_logical_checkpoint_id IS NULL
          AND baseline_not_applicable_reason IS NOT NULL
          AND provider_turn_id IS NULL
          AND error_json IS NULL)
        OR (state = 'provider_in_flight'
          AND (
            (baseline_logical_checkpoint_id IS NOT NULL AND baseline_not_applicable_reason IS NULL)
            OR (baseline_logical_checkpoint_id IS NULL AND baseline_not_applicable_reason IS NOT NULL)
          )
          AND provider_turn_id IS NULL
          AND error_json IS NULL)
        OR (state = 'started'
          AND (
            (baseline_logical_checkpoint_id IS NOT NULL AND baseline_not_applicable_reason IS NULL)
            OR (baseline_logical_checkpoint_id IS NULL AND baseline_not_applicable_reason IS NOT NULL)
          )
          AND provider_turn_id IS NOT NULL
          AND error_json IS NULL)
        OR (state = 'failed'
          AND provider_turn_id IS NULL
          AND error_json IS NOT NULL)
        OR (state = 'indeterminate'
          AND (
            (baseline_logical_checkpoint_id IS NOT NULL AND baseline_not_applicable_reason IS NULL)
            OR (baseline_logical_checkpoint_id IS NULL AND baseline_not_applicable_reason IS NOT NULL)
          )
          AND error_json IS NOT NULL)
      ),
      CHECK (
        finalized_sequence IS NULL
        OR state IN ('started', 'failed', 'indeterminate')
      )
    )
  `;

  yield* sql`
    CREATE INDEX turn_dispatch_journal_recovery
    ON turn_dispatch_journal(finalized_sequence, created_at, dispatch_id)
  `;

  yield* sql`
    CREATE INDEX turn_dispatch_journal_thread
    ON turn_dispatch_journal(provider_instance_id, project_id, thread_id, created_at, dispatch_id)
  `;

  yield* sql`
    CREATE UNIQUE INDEX turn_dispatch_journal_started_provider_turn
    ON turn_dispatch_journal(thread_id, provider_turn_id)
    WHERE state = 'started'
  `;
});
