import { assert, it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ProviderConversationCacheRepositoryLive } from "../../persistence/Layers/ProviderConversationCache.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderConversationCacheRepository } from "../../persistence/Services/ProviderConversationCache.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  updatedAt: 20,
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
      const readCalls: Array<string> = [];
      const projectCommands: Array<OrchestrationCommand> = [];
      const materializedWorkspaces = new Set<string>();
      let providerUpdatedAt = 20;
      let readItemsView: "full" | "summary" = "full";
      const catalog: ProviderConversationCatalog = {
        providerInstanceId: INSTANCE_ID,
        listThreads: ({ archived }) =>
          Effect.sync(() => {
            listCalls.push(archived);
            return {
              threads: (archived ? [thread("archived-thread")] : [thread("active-thread")]).map(
                (entry) => ({ ...entry, updatedAt: providerUpdatedAt }),
              ),
              nextCursor: null,
            };
          }),
        readThread: (providerThreadId) =>
          Effect.sync(() => {
            readCalls.push(providerThreadId);
            return {
              ...thread(providerThreadId, [
                {
                  id: "turn-1",
                  status: "completed",
                  startedAt: 11,
                  completedAt: 12,
                  items: [{ type: "userMessage", content: "hello" }],
                  itemsView: readItemsView,
                },
              ]),
              updatedAt: providerUpdatedAt,
            };
          }),
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
      const sync = yield* makeProviderConversationCacheSync({
        refreshInterval: "1 hour",
      }).pipe(
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
        Effect.provideService(
          ProjectionSnapshotQuery,
          ProjectionSnapshotQuery.of({
            getActiveProjectByWorkspaceRoot: ({
              workspaceRoot,
            }: {
              readonly workspaceRoot: string;
            }) =>
              Effect.succeed(
                materializedWorkspaces.has(workspaceRoot)
                  ? Option.some({ workspaceRoot })
                  : Option.none(),
              ),
          } as never),
        ),
        Effect.provideService(
          OrchestrationEngineService,
          OrchestrationEngineService.of({
            dispatch: (command: OrchestrationCommand) =>
              Effect.sync(() => {
                projectCommands.push(command);
                if (command.type === "project.create") {
                  materializedWorkspaces.add(command.workspaceRoot);
                }
                return { sequence: projectCommands.length };
              }),
          } as never),
        ),
      );
      const repository = yield* ProviderConversationCacheRepository;

      yield* sync.refreshInstance(INSTANCE_ID);
      assert.isTrue(Option.isSome(yield* repository.getSyncState(INSTANCE_ID)));
      assert.deepEqual(listCalls, [false, true]);
      assert.deepEqual(readCalls.toSorted(), ["active-thread", "archived-thread"]);
      assert.deepEqual(
        (yield* repository.listThreads({
          providerInstanceId: INSTANCE_ID,
        })).map((entry) => [entry.providerThreadId, entry.archived]),
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
      assert.equal(projectCommands.length, 1);
      const projectCommand = projectCommands[0];
      assert.equal(projectCommand?.type, "project.create");
      if (projectCommand?.type === "project.create") {
        assert.equal(projectCommand.workspaceRoot, "/provider/workspace");
        assert.equal(projectCommand.title, "workspace");
        assert.isFalse(projectCommand.createWorkspaceRootIfMissing ?? true);
      }

      assert.isTrue(
        Option.getOrThrow(
          yield* repository.getThread({
            providerInstanceId: INSTANCE_ID,
            providerThreadId: "archived-thread",
          }),
        ).detailLoaded,
      );

      yield* sync.start();
      yield* Effect.yieldNow;
      yield* sync.drain;
      assert.deepEqual(readCalls.toSorted(), ["active-thread", "archived-thread"]);
      assert.equal(projectCommands.length, 1);

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
      const retainedAfterProviderDeletion = Option.getOrThrow(
        yield* repository.getThread({
          providerInstanceId: INSTANCE_ID,
          providerThreadId: "archived-thread",
        }),
      );
      assert.isTrue(retainedAfterProviderDeletion.detailLoaded);
      assert.equal(retainedAfterProviderDeletion.thread.turns[0]?.id, "turn-1");

      providerUpdatedAt = 21;
      readItemsView = "summary";
      yield* sync.refreshInstance(INSTANCE_ID);
      const staleState = Option.getOrThrow(yield* repository.getSyncState(INSTANCE_ID));
      assert.equal(staleState.status, "stale");
      const retainedAfterIncompleteRefresh = Option.getOrThrow(
        yield* repository.getThread({
          providerInstanceId: INSTANCE_ID,
          providerThreadId: "active-thread",
        }),
      );
      assert.isTrue(retainedAfterIncompleteRefresh.detailLoaded);
      assert.equal(retainedAfterIncompleteRefresh.thread.updatedAt, 20);
      assert.equal(retainedAfterIncompleteRefresh.thread.turns[0]?.id, "turn-1");
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto), Effect.provide(persistenceLayer)),
  ),
);
