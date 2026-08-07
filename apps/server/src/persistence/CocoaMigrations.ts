/** Cocoa-owned migrations, deliberately isolated from the upstream T3 chain. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./CocoaMigrations/001_ProviderCheckpointOperations.ts";
import Migration0002 from "./CocoaMigrations/002_TurnDispatchJournal.ts";
import Migration0003 from "./CocoaMigrations/003_PostTurnCheckpointIntents.ts";
import Migration0004 from "./CocoaMigrations/004_CheckpointRevertSagas.ts";
import Migration0005 from "./CocoaMigrations/005_CheckpointRevertIntents.ts";
import Migration0006 from "./CocoaMigrations/006_CheckpointRevertIntentActiveThread.ts";
import Migration0007 from "./CocoaMigrations/007_ProviderConversationCache.ts";
import Migration0008 from "./CocoaMigrations/008_RetainProviderConversationHistory.ts";
import Migration0009 from "./CocoaMigrations/009_ProviderConversationPresence.ts";

export const cocoaMigrationEntries = [
  [1, "ProviderCheckpointOperations", Migration0001],
  [2, "TurnDispatchJournal", Migration0002],
  [3, "PostTurnCheckpointIntents", Migration0003],
  [4, "CheckpointRevertSagas", Migration0004],
  [5, "CheckpointRevertIntents", Migration0005],
  [6, "CheckpointRevertIntentActiveThread", Migration0006],
  [7, "ProviderConversationCache", Migration0007],
  [8, "RetainProviderConversationHistory", Migration0008],
  [9, "ProviderConversationPresence", Migration0009],
] as const;

export const cocoaMigrationManifest = cocoaMigrationEntries.map(
  ([id, name]) => [id, name] as const,
);

export const makeCocoaMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      cocoaMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export const runCocoaMigrations = Effect.fn("runCocoaMigrations")(function* (
  options: { readonly toMigrationInclusive?: number } = {},
) {
  const executed = yield* run({
    loader: makeCocoaMigrationLoader(options.toMigrationInclusive),
    table: "cocoa_sql_migrations",
  });
  yield* executed.length === 0
    ? Effect.logDebug("Cocoa database schema is current")
    : Effect.log("Cocoa migrations ran successfully").pipe(
        Effect.annotateLogs({
          migrations: executed.map(([id, name]) => `${id}_${name}`),
        }),
      );
  return executed;
});

export const CocoaMigrationsLive = Layer.effectDiscard(runCocoaMigrations());
