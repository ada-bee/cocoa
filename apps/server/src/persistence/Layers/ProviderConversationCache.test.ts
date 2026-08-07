import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ProviderConversationThread } from "../../provider/ProviderConversationCatalog.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderConversationCacheRepositoryLive } from "./ProviderConversationCache.ts";
import {
  ProviderConversationCacheRepository,
  ProviderConversationSyncEpoch,
} from "../Services/ProviderConversationCache.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const FIRST_SYNC = ProviderConversationSyncEpoch.make("sync-1");
const SECOND_SYNC = ProviderConversationSyncEpoch.make("sync-2");
const NOW = "2026-08-07T10:00:00.000Z";
const LATER = "2026-08-07T10:01:00.000Z";

const thread = (
  providerThreadId: string,
  updatedAt: number,
  turns: ProviderConversationThread["turns"] = [],
): ProviderConversationThread => ({
  providerThreadId,
  cwd: "/provider/workspace",
  title: `Title ${providerThreadId}`,
  preview: `Preview ${providerThreadId}`,
  createdAt: 10,
  updatedAt,
  recencyAt: updatedAt,
  status: "idle",
  activeFlags: [],
  source: "appServer",
  modelProvider: "openai",
  ephemeral: false,
  parentProviderThreadId: null,
  turns,
});

const layer = ProviderConversationCacheRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.layer(layer)("ProviderConversationCacheRepository", (it) => {
  it.effect("rebuilds catalog state, retains details, and tombstones absent provider threads", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderConversationCacheRepository;
      const initialMeta = yield* repository.getMeta;
      assert.equal(initialMeta.cacheEpoch.length, 32);
      assert.equal(initialMeta.revision, 0);

      yield* repository.beginSync({
        providerInstanceId: INSTANCE_ID,
        syncEpoch: FIRST_SYNC,
        startedAt: NOW,
      });
      for (const providerThreadId of ["provider-thread-1", "provider-thread-2"]) {
        yield* repository.upsertCatalogThread({
          providerInstanceId: INSTANCE_ID,
          thread: thread(providerThreadId, 20),
          archived: false,
          syncEpoch: FIRST_SYNC,
          observedAt: NOW,
        });
      }
      yield* repository.completeSync({
        providerInstanceId: INSTANCE_ID,
        syncEpoch: FIRST_SYNC,
        completedAt: NOW,
      });

      const detail = thread("provider-thread-1", 20, [
        {
          id: "provider-turn-1",
          status: "completed",
          startedAt: 11,
          completedAt: 12,
          items: [{ type: "userMessage", content: "hello" }],
          itemsView: "full",
        },
      ]);
      assert.isTrue(
        yield* repository.upsertThreadDetail({
          providerInstanceId: INSTANCE_ID,
          thread: detail,
          observedAt: NOW,
        }),
      );
      const loaded = Option.getOrThrow(
        yield* repository.getThread({
          providerInstanceId: INSTANCE_ID,
          providerThreadId: "provider-thread-1",
        }),
      );
      assert.isTrue(loaded.detailLoaded);
      assert.equal(loaded.thread.turns[0]?.id, "provider-turn-1");
      const detailSnapshot = yield* repository.getThreadByIdSnapshot({
        threadId: loaded.threadId,
      });
      assert.equal(detailSnapshot.meta.revision, (yield* repository.getMeta).revision);
      assert.equal(Option.getOrThrow(detailSnapshot.thread).thread.turns[0]?.id, "provider-turn-1");

      yield* repository.beginSync({
        providerInstanceId: INSTANCE_ID,
        syncEpoch: SECOND_SYNC,
        startedAt: LATER,
      });
      yield* repository.upsertCatalogThread({
        providerInstanceId: INSTANCE_ID,
        thread: thread("provider-thread-1", 20),
        archived: true,
        syncEpoch: SECOND_SYNC,
        observedAt: LATER,
      });
      yield* repository.completeSync({
        providerInstanceId: INSTANCE_ID,
        syncEpoch: SECOND_SYNC,
        completedAt: LATER,
      });

      const retained = Option.getOrThrow(
        yield* repository.getThread({
          providerInstanceId: INSTANCE_ID,
          providerThreadId: "provider-thread-1",
        }),
      );
      assert.isTrue(retained.archived);
      assert.isTrue(retained.detailLoaded);
      assert.equal(retained.deletedAt, null);

      const tombstoned = Option.getOrThrow(
        yield* repository.getThread({
          providerInstanceId: INSTANCE_ID,
          providerThreadId: "provider-thread-2",
        }),
      );
      assert.equal(tombstoned.deletedAt, LATER);
      assert.deepEqual(
        (yield* repository.listThreads({ providerInstanceId: INSTANCE_ID })).map(
          (entry) => entry.providerThreadId,
        ),
        ["provider-thread-1"],
      );

      const syncState = Option.getOrThrow(yield* repository.getSyncState(INSTANCE_ID));
      assert.equal(syncState.status, "fresh");
      assert.equal(syncState.lastSuccessAt, LATER);
      assert.isAbove((yield* repository.getMeta).revision, initialMeta.revision);
    }),
  );

  it.effect("marks a failed catalog sweep stale without deleting cached history", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderConversationCacheRepository;
      yield* repository.beginSync({
        providerInstanceId: INSTANCE_ID,
        syncEpoch: FIRST_SYNC,
        startedAt: NOW,
      });
      yield* repository.upsertCatalogThread({
        providerInstanceId: INSTANCE_ID,
        thread: thread("provider-thread-1", 20),
        archived: false,
        syncEpoch: FIRST_SYNC,
        observedAt: NOW,
      });
      yield* repository.completeSync({
        providerInstanceId: INSTANCE_ID,
        syncEpoch: FIRST_SYNC,
        completedAt: NOW,
      });

      yield* repository.beginSync({
        providerInstanceId: INSTANCE_ID,
        syncEpoch: SECOND_SYNC,
        startedAt: LATER,
      });
      yield* repository.failSync({
        providerInstanceId: INSTANCE_ID,
        syncEpoch: SECOND_SYNC,
        failedAt: LATER,
        reason: "disconnected",
      });

      assert.equal(Option.getOrThrow(yield* repository.getSyncState(INSTANCE_ID)).status, "stale");
      assert.lengthOf(yield* repository.listThreads({ providerInstanceId: INSTANCE_ID }), 1);
    }),
  );
});
