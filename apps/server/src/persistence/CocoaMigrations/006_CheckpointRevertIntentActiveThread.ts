import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE UNIQUE INDEX checkpoint_revert_intents_one_active_per_thread
    ON checkpoint_revert_intents(thread_id)
    WHERE state IN ('awaiting_saga', 'linked')
  `;
});
