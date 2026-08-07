import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ProviderConversationCacheRepositoryLive } from "../../persistence/Layers/ProviderConversationCache.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderConversationCacheRepository,
  ProviderConversationSyncEpoch,
} from "../../persistence/Services/ProviderConversationCache.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import type { ProviderConversationCatalog } from "../ProviderConversationCatalog.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { makeProviderConversationAuthority } from "./ProviderConversationAuthority.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const THREAD_ID = ThreadId.make("cocoa-thread");
const BOUND_THREAD_ID = ThreadId.make("bound-before-cache");
const RECEIPTED_COMMAND_ID = CommandId.make("already-accepted-command");
const NOW = "2026-08-07T10:00:00.000Z";

const persistenceLayer = ProviderConversationCacheRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect("applies provider-owned mutations before Cocoa records local consequences", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderConversationCacheRepository;
    const syncEpoch = ProviderConversationSyncEpoch.make("sync-1");
    yield* repository.beginSync({ providerInstanceId: INSTANCE_ID, syncEpoch, startedAt: NOW });
    yield* repository.upsertCatalogThread({
      threadId: THREAD_ID,
      providerInstanceId: INSTANCE_ID,
      archived: false,
      syncEpoch,
      observedAt: NOW,
      thread: {
        providerThreadId: "provider-thread",
        cwd: "/provider/workspace",
        title: "Title",
        preview: "Preview",
        createdAt: 10,
        updatedAt: 20,
        recencyAt: 20,
        status: "idle",
        activeFlags: [],
        source: "appServer",
        modelProvider: "openai",
        ephemeral: false,
        parentProviderThreadId: null,
        turns: [],
      },
    });

    const calls: Array<string> = [];
    const invalidations = yield* PubSub.unbounded<never>();
    const catalog: ProviderConversationCatalog = {
      providerInstanceId: INSTANCE_ID,
      listThreads: () => Effect.succeed({ threads: [], nextCursor: null }),
      readThread: () => Effect.die("unused"),
      setThreadName: (providerThreadId, title) =>
        Effect.sync(() => calls.push(`name:${providerThreadId}:${title}`)).pipe(Effect.asVoid),
      archiveThread: (providerThreadId) =>
        Effect.sync(() => calls.push(`archive:${providerThreadId}`)).pipe(Effect.asVoid),
      unarchiveThread: () => Effect.void,
      deleteThread: () => Effect.void,
      subscribeInvalidations: PubSub.subscribe(invalidations),
    };
    const instance = { instanceId: INSTANCE_ID, conversationCatalog: catalog } as ProviderInstance;
    const registryChanges = yield* PubSub.unbounded<void>();
    const registry: ProviderInstanceRegistryShape = {
      getInstance: () => Effect.succeed(instance),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.fromPubSub(registryChanges),
      subscribeChanges: PubSub.subscribe(registryChanges),
    };
    const sessionDirectory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => Effect.succeed(ProviderDriverKind.make("codex")),
      getBinding: (threadId) =>
        Effect.succeed(
          threadId === BOUND_THREAD_ID
            ? Option.some({
                threadId,
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: INSTANCE_ID,
                resumeCursor: { threadId: "bound-provider-thread" },
              })
            : Option.none(),
        ),
      listThreadIds: () => Effect.succeed([BOUND_THREAD_ID]),
      listBindings: () => Effect.succeed([]),
    };
    const commandReceipts: OrchestrationCommandReceiptRepositoryShape = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }) =>
        Effect.succeed(
          commandId === RECEIPTED_COMMAND_ID
            ? Option.some({
                commandId,
                aggregateKind: "thread",
                aggregateId: THREAD_ID,
                acceptedAt: NOW,
                resultSequence: 1,
                status: "accepted",
                error: null,
              })
            : Option.none(),
        ),
    };
    const authority = yield* makeProviderConversationAuthority.pipe(
      Effect.provideService(ProviderInstanceRegistry, registry),
      Effect.provideService(ProviderSessionDirectory, sessionDirectory),
      Effect.provideService(OrchestrationCommandReceiptRepository, commandReceipts),
    );

    const archive: OrchestrationCommand = {
      type: "thread.archive",
      commandId: CommandId.make("archive-command"),
      threadId: THREAD_ID,
    };
    assert.isTrue(yield* authority.apply(archive));
    assert.isTrue(
      yield* authority.apply({
        type: "thread.meta.update",
        commandId: CommandId.make("rename-command"),
        threadId: THREAD_ID,
        title: "Provider title",
      }),
    );
    assert.deepEqual(calls, ["archive:provider-thread", "name:provider-thread:Provider title"]);

    assert.isTrue(
      yield* authority.apply({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("bound-rename-command"),
        threadId: BOUND_THREAD_ID,
        requestId: CommandId.make("bound-rename-request"),
        title: "Bound provider title",
      }),
    );
    assert.strictEqual(calls.at(-1), "name:bound-provider-thread:Bound provider title");

    const callCountBeforeRetry = calls.length;
    assert.isTrue(
      yield* authority.apply({
        type: "thread.archive",
        commandId: RECEIPTED_COMMAND_ID,
        threadId: THREAD_ID,
      }),
    );
    assert.lengthOf(calls, callCountBeforeRetry);

    assert.isFalse(
      yield* authority.apply({
        type: "thread.delete",
        commandId: CommandId.make("draft-delete"),
        threadId: ThreadId.make("provider-unbound-draft"),
      }),
    );
  }).pipe(Effect.provide(persistenceLayer)),
);
