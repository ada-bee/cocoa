import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import {
  ProviderConversationCacheRepository,
  ProviderConversationSyncEpoch,
} from "../../persistence/Services/ProviderConversationCache.ts";
import type { ProviderConversationCatalog } from "../ProviderConversationCatalog.ts";
import { ProviderConversationCatalogError } from "../ProviderConversationCatalog.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  ProviderConversationCacheSync,
  type ProviderConversationCacheSyncShape,
} from "../Services/ProviderConversationCacheSync.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";

const DEFAULT_REFRESH_INTERVAL = Duration.minutes(1);
const MAX_CATALOG_PAGES_PER_SWEEP = 10_000;

type WorkItem =
  | { readonly type: "full"; readonly providerInstanceId: ProviderInstanceId }
  | {
      readonly type: "thread";
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerThreadId: string;
    }
  | {
      readonly type: "delete";
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerThreadId: string;
    };

interface ActiveCatalog {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
}

export interface ProviderConversationCacheSyncOptions {
  readonly refreshInterval?: Duration.Input;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function catalogFailureReason(error: ProviderConversationCatalogError) {
  return error.reason;
}

export const makeProviderConversationCacheSync = Effect.fn("ProviderConversationCacheSync.make")(
  function* (options: ProviderConversationCacheSyncOptions = {}) {
    const registry = yield* ProviderInstanceRegistry;
    const repository = yield* ProviderConversationCacheRepository;
    const crypto = yield* Crypto.Crypto;
    const sessionDirectory = yield* ProviderSessionDirectory;
    const startedRef = yield* Ref.make(false);
    const changes = yield* PubSub.sliding<void>(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

    const readCatalog = Effect.fn("ProviderConversationCacheSync.readCatalog")(function* (
      catalog: ProviderConversationCatalog,
      archived: boolean,
      syncEpoch: ProviderConversationSyncEpoch,
      observedAt: string,
    ) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (let pageNumber = 0; pageNumber < MAX_CATALOG_PAGES_PER_SWEEP; pageNumber++) {
        const page = yield* catalog.listThreads({
          archived,
          ...(cursor === undefined ? {} : { cursor }),
          limit: 100,
        });
        // Resolve bindings after the provider response. A thread/started notification
        // and the session runtime's durable binding race the catalog invalidation;
        // reading here gives the binding path time to settle without sleeps/polling.
        const bindings = yield* sessionDirectory
          .listBindings()
          .pipe(Effect.orElseSucceed(() => []));
        const threadIdsByProviderId = new Map<string, ThreadId>(
          bindings.flatMap((binding) => {
            if (
              binding.providerInstanceId !== catalog.providerInstanceId ||
              !Predicate.isObject(binding.resumeCursor) ||
              !("threadId" in binding.resumeCursor) ||
              !Predicate.isString(binding.resumeCursor.threadId)
            ) {
              return [];
            }
            return [[binding.resumeCursor.threadId, binding.threadId] as const];
          }),
        );
        yield* Effect.forEach(
          page.threads,
          (thread) =>
            repository.upsertCatalogThread({
              ...(threadIdsByProviderId.get(thread.providerThreadId) === undefined
                ? {}
                : { threadId: threadIdsByProviderId.get(thread.providerThreadId)! }),
              providerInstanceId: catalog.providerInstanceId,
              thread,
              archived,
              syncEpoch,
              observedAt,
            }),
          { concurrency: 8, discard: true },
        );
        if (page.nextCursor === null) return;
        if (seenCursors.has(page.nextCursor)) {
          return yield* new ProviderConversationCatalogError({
            providerInstanceId: catalog.providerInstanceId,
            operation: "thread/list",
            reason: "protocol",
            detail: `Provider repeated catalog cursor '${page.nextCursor}'.`,
          });
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return yield* new ProviderConversationCatalogError({
        providerInstanceId: catalog.providerInstanceId,
        operation: "thread/list",
        reason: "protocol",
        detail: `Provider exceeded ${MAX_CATALOG_PAGES_PER_SWEEP} catalog pages.`,
      });
    });

    const fullSync = Effect.fn("ProviderConversationCacheSync.fullSync")(function* (
      providerInstanceId: ProviderInstanceId,
    ) {
      const instance = yield* registry.getInstance(providerInstanceId);
      const catalog = instance?.conversationCatalog;
      if (!catalog) return;

      const syncEpoch = ProviderConversationSyncEpoch.make(yield* crypto.randomUUIDv4);
      const startedAt = yield* nowIso;
      yield* repository.beginSync({ providerInstanceId, syncEpoch, startedAt });
      const result = yield* readCatalog(catalog, false, syncEpoch, startedAt).pipe(
        Effect.andThen(readCatalog(catalog, true, syncEpoch, startedAt)),
        Effect.result,
      );
      const completedAt = yield* nowIso;
      if (Result.isSuccess(result)) {
        yield* repository.completeSync({ providerInstanceId, syncEpoch, completedAt });
        return;
      }
      yield* repository.failSync({
        providerInstanceId,
        syncEpoch,
        failedAt: completedAt,
        reason:
          result.failure._tag === "ProviderConversationCatalogError"
            ? catalogFailureReason(result.failure)
            : "internal",
      });
      return yield* result.failure;
    });

    const refreshDetail = Effect.fn("ProviderConversationCacheSync.refreshDetail")(function* (
      providerInstanceId: ProviderInstanceId,
      providerThreadId: string,
    ) {
      const instance = yield* registry.getInstance(providerInstanceId);
      const catalog = instance?.conversationCatalog;
      if (!catalog) return;
      const thread = yield* catalog.readThread(providerThreadId);
      const observedAt = yield* nowIso;
      const updated = yield* repository.upsertThreadDetail({
        providerInstanceId,
        thread,
        observedAt,
      });
      if (updated) return;
      yield* fullSync(providerInstanceId);
      yield* repository.upsertThreadDetail({ providerInstanceId, thread, observedAt });
    });

    const process = (item: WorkItem) =>
      Effect.gen(function* () {
        switch (item.type) {
          case "full":
            yield* fullSync(item.providerInstanceId);
            break;
          case "thread":
            yield* refreshDetail(item.providerInstanceId, item.providerThreadId);
            break;
          case "delete":
            yield* repository.deleteThread(item);
            break;
        }
      }).pipe(Effect.withSpan("ProviderConversationCacheSync.process"));
    const processSafely = (item: WorkItem) =>
      process(item).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Provider conversation cache refresh failed", { cause }),
        ),
      );
    const locksRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, Semaphore.Semaphore>>(
      new Map(),
    );
    const getLock = Effect.fn("ProviderConversationCacheSync.getLock")(function* (
      providerInstanceId: ProviderInstanceId,
    ) {
      const existing = (yield* Ref.get(locksRef)).get(providerInstanceId);
      if (existing) return existing;
      const lock = yield* Semaphore.make(1);
      return yield* Ref.modify(locksRef, (locks) => {
        const current = locks.get(providerInstanceId);
        if (current) return [current, locks] as const;
        const next = new Map(locks);
        next.set(providerInstanceId, lock);
        return [lock, next] as const;
      });
    });
    const run = (item: WorkItem) =>
      getLock(item.providerInstanceId).pipe(
        Effect.flatMap((lock) =>
          lock.withPermits(1)(
            processSafely(item).pipe(
              Effect.andThen(PubSub.publish(changes, undefined)),
              Effect.asVoid,
            ),
          ),
        ),
      );
    const refreshInstance: ProviderConversationCacheSyncShape["refreshInstance"] = (
      providerInstanceId,
    ) => run({ type: "full", providerInstanceId });
    const refreshThread: ProviderConversationCacheSyncShape["refreshThread"] = (
      providerInstanceId,
      providerThreadId,
    ) => run({ type: "thread", providerInstanceId, providerThreadId });

    const attachCatalog = Effect.fn("ProviderConversationCacheSync.attachCatalog")(function* (
      instance: ProviderInstance,
      parentScope: Scope.Scope,
    ) {
      const catalog = instance.conversationCatalog;
      if (!catalog) return null;
      const childScope = yield* Scope.fork(parentScope, "sequential");
      const subscription = yield* catalog.subscribeInvalidations.pipe(
        Effect.provideService(Scope.Scope, childScope),
      );
      yield* refreshInstance(instance.instanceId).pipe(
        Effect.forkIn(childScope, { startImmediately: true }),
      );
      yield* Effect.forever(
        PubSub.take(subscription).pipe(
          Effect.flatMap((invalidation) => {
            switch (invalidation.type) {
              case "catalog-reset":
              case "catalog-changed":
                return refreshInstance(instance.instanceId);
              case "thread-changed":
                return refreshThread(instance.instanceId, invalidation.providerThreadId);
              case "thread-deleted":
                return run({
                  type: "delete",
                  providerInstanceId: instance.instanceId,
                  providerThreadId: invalidation.providerThreadId,
                });
            }
          }),
        ),
      ).pipe(Effect.forkIn(childScope, { startImmediately: true }));
      return { instance, scope: childScope } satisfies ActiveCatalog;
    });

    const start: ProviderConversationCacheSyncShape["start"] = Effect.fn(
      "ProviderConversationCacheSync.start",
    )(function* () {
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const alreadyStarted = yield* Ref.getAndSet(startedRef, true);
          if (alreadyStarted) return;
          const acquire = Effect.gen(function* () {
            const parentScope = yield* Effect.scope;
            const registryChanges = yield* registry.subscribeChanges;
            const active = new Map<ProviderInstanceId, ActiveCatalog>();

            const reconcile = Effect.fn("ProviderConversationCacheSync.reconcile")(function* () {
              const instances = yield* registry.listInstances;
              const nextById = new Map(
                instances.map((instance) => [instance.instanceId, instance]),
              );
              for (const [instanceId, current] of active) {
                const next = nextById.get(instanceId);
                if (next !== current.instance || !next.conversationCatalog) {
                  active.delete(instanceId);
                  yield* Scope.close(current.scope, Exit.void).pipe(Effect.ignore);
                }
              }
              for (const instance of instances) {
                if (
                  !instance.conversationCatalog ||
                  active.get(instance.instanceId)?.instance === instance
                ) {
                  continue;
                }
                const attached = yield* attachCatalog(instance, parentScope);
                if (attached) active.set(instance.instanceId, attached);
              }
            });

            yield* reconcile();
            yield* Effect.forever(
              PubSub.take(registryChanges).pipe(Effect.andThen(reconcile())),
            ).pipe(Effect.forkIn(parentScope, { startImmediately: true }));
            yield* Effect.repeat(
              registry.listInstances.pipe(
                Effect.flatMap((instances) =>
                  Effect.forEach(instances, (instance) => refreshInstance(instance.instanceId), {
                    concurrency: 8,
                    discard: true,
                  }),
                ),
              ),
              Schedule.spaced(options.refreshInterval ?? DEFAULT_REFRESH_INTERVAL),
            ).pipe(Effect.forkIn(parentScope, { startImmediately: true }));
          });
          yield* restore(acquire).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Ref.set(startedRef, false) : Effect.void,
            ),
          );
        }),
      );
    });

    return {
      start,
      refreshInstance,
      refreshThread,
      drain: Ref.get(locksRef).pipe(
        Effect.flatMap((locks) =>
          Effect.forEach(locks.values(), (lock) => lock.withPermits(1)(Effect.void), {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      ),
      subscribeChanges: PubSub.subscribe(changes),
    } satisfies ProviderConversationCacheSyncShape;
  },
);

export const ProviderConversationCacheSyncLive = Layer.effect(
  ProviderConversationCacheSync,
  Effect.gen(function* () {
    const service = yield* makeProviderConversationCacheSync();
    yield* service.start();
    return service;
  }),
);
