import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE provider_conversation_cache_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cache_epoch TEXT NOT NULL CHECK (length(cache_epoch) = 32),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    )
  `;

  yield* sql`
    INSERT INTO provider_conversation_cache_meta (singleton, cache_epoch, revision)
    VALUES (1, lower(hex(randomblob(16))), 0)
  `;

  yield* sql`
    CREATE TABLE provider_conversation_cache_threads (
      provider_instance_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      cocoa_thread_id TEXT NOT NULL UNIQUE,
      cwd TEXT NOT NULL,
      title TEXT,
      preview TEXT NOT NULL,
      provider_created_at INTEGER NOT NULL CHECK (provider_created_at >= 0),
      provider_updated_at INTEGER NOT NULL CHECK (provider_updated_at >= 0),
      provider_recency_at INTEGER CHECK (provider_recency_at IS NULL OR provider_recency_at >= 0),
      archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
      summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
      detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
      sync_epoch TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (provider_instance_id, provider_thread_id)
    )
  `;

  yield* sql`
    CREATE INDEX provider_conversation_cache_navigation
    ON provider_conversation_cache_threads(
      provider_instance_id, cwd, archived, deleted_at,
      provider_recency_at DESC, provider_updated_at DESC, provider_thread_id
    )
  `;

  yield* sql`
    CREATE INDEX provider_conversation_cache_sweep
    ON provider_conversation_cache_threads(provider_instance_id, sync_epoch, deleted_at)
  `;

  yield* sql`
    CREATE INDEX provider_conversation_cache_cocoa_thread
    ON provider_conversation_cache_threads(cocoa_thread_id, deleted_at)
  `;

  yield* sql`
    CREATE TABLE provider_conversation_cache_sync (
      provider_instance_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('never', 'syncing', 'fresh', 'stale')),
      active_sync_epoch TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      failure_reason TEXT
        CHECK (failure_reason IS NULL OR failure_reason IN ('disconnected', 'unsupported', 'protocol', 'operation-failed', 'internal'))
    )
  `;
});
