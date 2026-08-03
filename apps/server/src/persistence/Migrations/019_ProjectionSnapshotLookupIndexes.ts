import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_projects_active_location
    ON projection_projects(provider_instance_id, workspace_root)
    WHERE deleted_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_deleted_created
    ON projection_threads(project_id, deleted_at, created_at)
  `;
});
