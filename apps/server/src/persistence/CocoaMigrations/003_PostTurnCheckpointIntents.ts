import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE post_turn_checkpoint_intents (
      source_event_id TEXT PRIMARY KEY,
      source_sequence INTEGER NOT NULL UNIQUE CHECK (source_sequence >= 0),
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_turn_id TEXT
        CHECK (
          provider_turn_id IS NULL
          OR (
            length(provider_turn_id) BETWEEN 1 AND 256
            AND provider_turn_id = trim(provider_turn_id)
            AND instr(provider_turn_id, '/') = 0
            AND instr(provider_turn_id, char(92)) = 0
          )
        ),
      outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'interrupted', 'failed')),
      completed_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('awaiting_dispatch', 'bound', 'uncorrelatable')),
      provider_instance_id TEXT,
      project_id TEXT,
      baseline_checkpoint_turn_count INTEGER
        CHECK (baseline_checkpoint_turn_count IS NULL OR baseline_checkpoint_turn_count >= 0),
      checkpoint_turn_count INTEGER
        CHECK (checkpoint_turn_count IS NULL OR checkpoint_turn_count >= 1),
      baseline_logical_checkpoint_id TEXT,
      baseline_not_applicable_reason TEXT
        CHECK (
          baseline_not_applicable_reason IS NULL
          OR baseline_not_applicable_reason IN ('not_repository', 'capability_unavailable')
        ),
      operation_id TEXT UNIQUE,
      logical_checkpoint_id TEXT UNIQUE,
      finalized_sequence INTEGER CHECK (finalized_sequence IS NULL OR finalized_sequence >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'awaiting_dispatch'
          AND provider_turn_id IS NOT NULL
          AND provider_instance_id IS NULL
          AND project_id IS NULL
          AND baseline_checkpoint_turn_count IS NULL
          AND checkpoint_turn_count IS NULL
          AND baseline_logical_checkpoint_id IS NULL
          AND baseline_not_applicable_reason IS NULL
          AND operation_id IS NULL
          AND logical_checkpoint_id IS NULL
          AND finalized_sequence IS NULL)
        OR (state = 'bound'
          AND provider_turn_id IS NOT NULL
          AND provider_instance_id IS NOT NULL
          AND project_id IS NOT NULL
          AND baseline_checkpoint_turn_count IS NOT NULL
          AND checkpoint_turn_count = baseline_checkpoint_turn_count + 1
          AND operation_id IS NOT NULL
          AND logical_checkpoint_id IS NOT NULL
          AND (
            (baseline_logical_checkpoint_id IS NOT NULL
              AND baseline_not_applicable_reason IS NULL)
            OR (baseline_logical_checkpoint_id IS NULL
              AND baseline_not_applicable_reason IS NOT NULL)
          ))
        OR (state = 'uncorrelatable'
          AND provider_turn_id IS NULL
          AND provider_instance_id IS NULL
          AND project_id IS NULL
          AND baseline_checkpoint_turn_count IS NULL
          AND checkpoint_turn_count IS NULL
          AND baseline_logical_checkpoint_id IS NULL
          AND baseline_not_applicable_reason IS NULL
          AND operation_id IS NULL
          AND logical_checkpoint_id IS NULL
          AND finalized_sequence = 0)
      )
    )
  `;

  yield* sql`
    CREATE INDEX post_turn_checkpoint_intents_recovery
    ON post_turn_checkpoint_intents(finalized_sequence, source_sequence, source_event_id)
  `;

  yield* sql`
    CREATE INDEX post_turn_checkpoint_intents_provider_recovery
    ON post_turn_checkpoint_intents(provider_instance_id, finalized_sequence, source_sequence)
  `;
});
