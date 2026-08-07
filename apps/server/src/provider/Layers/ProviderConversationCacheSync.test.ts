import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ProviderConversationCacheRepositoryLive } from "../../persistence/Layers/ProviderConversationCache.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderConversationCacheRepository } from "../../persistence/Services/ProviderConversationCache.ts";
import type {
  ProviderConversationCatalog,
  ProviderConversationInvalidation,
  ProviderConversationThread,
} from "../ProviderConversationCatalog.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../Services/ProviderInstanceRegistry.ts";
import { makeProviderConversationCacheSync } from "./ProviderConversationCacheSync.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const EXISTING_THREAD_ID = ThreadId.make("existing-cocoa-thread");
const NOW = "2026-08-07T10:00:00.000Z";

const thread = (
  providerThreadId: string,
  turns: ProviderConversationThread["turns"] = [],
): ProviderConversationThread => ({
  providerThreadId,
  cwd: "/provider/workspace",
  title: `Title ${providerThreadId}`,
  preview: `Preview ${providerThreadId}`,
  createdAt: 10,
  updatedAt: turns.length === 0 ? 20 : 30,
  recencyAt: 20,
  status: "idle",
  activeFlags: [],
  source: "appServer",
  modelProvider: "openai",
  ephemeral: false,
  parentProviderThreadId: null,
  turns,
});

let randomByte = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => {
    randomByte = (randomByte + 1) % 255;
    return new Uint8Array(size).fill(randomByte);
  },
  digest: (_algorithm, data) => Effect.succeed(data),
});

const persistenceLayer = ProviderConversationCacheRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect("sweeps active and archived provider catalogs and refreshes details", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const invalidations = yield* PubSub.unbounded<ProviderConversationInvalidation>();
      const registryChanges = yield* PubSub.unbounded<void>();
      const listCalls: Array<boolean> = [];
      const catalog: ProviderConversationCatalog = {
        providerInstanceId: INSTANCE_ID,
        listThreads: ({ archived }) =>
          Effect.sync(() => {
            listCalls.push(archived);
            return {
              threads: archived ? [thread("archived-thread")] : [thread("active-thread")],
              nextCursor: null,
            };
          }),
        readThread: (providerThreadId) =>
          Effect.succeed(
            thread(providerThreadId, [
              {
                id: "turn-1",
                status: "completed",
                startedAt: 11,
                completedAt: 12,
                items: [{ type: "userMessage", content: "hello" }],
                itemsView: "full",
              },
            ]),
          ),
        setThreadName: () => Effect.void,
        archiveThread: () => Effect.void,
        unarchiveThread: () => Effect.void,
        deleteThread: () => Effect.void,
        subscribeInvalidations: PubSub.subscribe(invalidations),
      };
      const instance = {
        instanceId: INSTANCE_ID,
        conversationCatalog: catalog,
      } as ProviderInstance;
      const registry: ProviderInstanceRegistryShape = {
        getInstance: (instanceId) =>
          Effect.succeed(instanceId === INSTANCE_ID ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.fromPubSub(registryChanges),
        subscribeChanges: PubSub.subscribe(registryChanges),
      };
      const sync = yield* makeProviderConversationCacheSync({ refreshInterval: "1 hour" }).pipe(
        Effect.provideService(ProviderInstanceRegistry, registry),
        Effect.provideService(
          ProviderSessionDirectory,
          ProviderSessionDirectory.of({
            listBindings: () =>
              Effect.succeed([
                {
                  threadId: EXISTING_THREAD_ID,
                  provider: ProviderDriverKind.make("codex"),
                  providerInstanceId: INSTANCE_ID,
                  resumeCursor: { threadId: "active-thread" },
                  lastSeenAt: NOW,
                },
              ]),
          } as never),
        ),
      );
      const repository = yield* ProviderConversationCacheRepository;

      yield* sync.refreshInstance(INSTANCE_ID);
      assert.isTrue(Option.isSome(yield* repository.getSyncState(INSTANCE_ID)));
      assert.deepEqual(listCalls, [false, true]);
      assert.deepEqual(
        (yield* repository.listThreads({ providerInstanceId: INSTANCE_ID })).map((entry) => [
          entry.providerThreadId,
          entry.archived,
        ]),
        [
          ["active-thread", false],
          ["archived-thread", true],
        ],
      );
      assert.equal(
        Option.getOrThrow(
          yield* repository.getThread({
            providerInstanceId: INSTANCE_ID,
            providerThreadId: "active-thread",
          }),
        ).threadId,
        EXISTING_THREAD_ID,
      );

      yield* sync.start();
      yield* Effect.yieldNow;
      yield* sync.drain;

      yield* sync.refreshThread(INSTANCE_ID, "active-thread");
      yield* sync.drain;
      const detail = Option.getOrThrow(
        yield* repository.getThread({
          providerInstanceId: INSTANCE_ID,
          providerThreadId: "active-thread",
        }),
      );
      assert.isTrue(detail.detailLoaded);
      assert.equal(detail.thread.turns[0]?.id, "turn-1");

      yield* PubSub.publish(invalidations, {
        type: "thread-deleted",
        providerThreadId: "archived-thread",
      });
      yield* Effect.yieldNow;
      yield* sync.drain;
      assert.isTrue(
        Option.isNone(
          yield* repository.getThread({
            providerInstanceId: INSTANCE_ID,
            providerThreadId: "archived-thread",
          }),
        ),
      );
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto), Effect.provide(persistenceLayer)),
  ),
);
