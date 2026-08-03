import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE checkpoint_revert_intents (
      source_event_id TEXT PRIMARY KEY,
      source_sequence INTEGER NOT NULL UNIQUE CHECK (source_sequence >= 0),
      source_command_id TEXT,
      thread_id TEXT NOT NULL,
      requested_turn_count INTEGER NOT NULL CHECK (requested_turn_count >= 0),
      requested_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('awaiting_saga', 'linked', 'terminal')),
      saga_id TEXT UNIQUE,
      terminal_outcome TEXT
        CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'failed', 'indeterminate')),
      terminal_at TEXT,
      FOREIGN KEY (saga_id) REFERENCES checkpoint_revert_sagas(saga_id) ON DELETE RESTRICT,
      CHECK (
        (state = 'awaiting_saga'
          AND saga_id IS NULL
          AND terminal_outcome IS NULL
          AND terminal_at IS NULL)
        OR (state = 'linked'
          AND saga_id IS NOT NULL
          AND terminal_outcome IS NULL
          AND terminal_at IS NULL)
        OR (state = 'terminal'
          AND terminal_outcome IS NOT NULL
          AND terminal_at IS NOT NULL
          AND (
            (terminal_outcome = 'failed')
            OR (terminal_outcome IN ('completed', 'indeterminate') AND saga_id IS NOT NULL)
          ))
      )
    )
  `;

  yield* sql`
    CREATE INDEX checkpoint_revert_intents_recovery
    ON checkpoint_revert_intents(source_sequence, source_event_id)
    WHERE state IN ('awaiting_saga', 'linked')
  `;
});
