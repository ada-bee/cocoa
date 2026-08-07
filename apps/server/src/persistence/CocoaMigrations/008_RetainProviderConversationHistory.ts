import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Provider absence is not Cocoa deletion. Restore rows tombstoned by the
  // former mirror-cache behavior so they remain part of the durable archive.
  yield* sql`
    UPDATE provider_conversation_cache_threads
    SET deleted_at = NULL
    WHERE deleted_at IS NOT NULL
  `;
});
