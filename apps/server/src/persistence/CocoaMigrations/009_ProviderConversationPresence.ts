import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE provider_conversation_cache_threads
    ADD COLUMN provider_deleted_at TEXT
  `;

  yield* sql`
    CREATE INDEX provider_conversation_cache_provider_presence
    ON provider_conversation_cache_threads(provider_instance_id, provider_deleted_at)
  `;
});
