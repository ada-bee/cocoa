import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { cocoaMigrationManifest, runCocoaMigrations } from "./CocoaMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("Cocoa migrations", (it) => {
  it.effect("runs in a separate migration chain and leaves room for upstream id 36", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runCocoaMigrations();

      assert.equal(migrationManifest.at(-1)?.[0], 35);
      assert.deepStrictEqual(cocoaMigrationManifest, [
        [1, "ProviderCheckpointOperations"],
        [2, "TurnDispatchJournal"],
        [3, "PostTurnCheckpointIntents"],
        [4, "CheckpointRevertSagas"],
        [5, "CheckpointRevertIntents"],
        [6, "CheckpointRevertIntentActiveThread"],
      ]);

      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (36, 'FutureUpstreamMigration')
      `;

      const upstream = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 36
      `;
      const cocoa = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM cocoa_sql_migrations
        ORDER BY migration_id
      `;

      assert.deepStrictEqual(upstream, [{ migrationId: 36, name: "FutureUpstreamMigration" }]);
      assert.deepStrictEqual(cocoa, [
        { migrationId: 1, name: "ProviderCheckpointOperations" },
        { migrationId: 2, name: "TurnDispatchJournal" },
        { migrationId: 3, name: "PostTurnCheckpointIntents" },
        { migrationId: 4, name: "CheckpointRevertSagas" },
        { migrationId: 5, name: "CheckpointRevertIntents" },
        { migrationId: 6, name: "CheckpointRevertIntentActiveThread" },
      ]);
    }),
  );
});
