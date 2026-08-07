import { IsoDateTime, NonNegativeInt, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProviderConversationThread } from "../../provider/ProviderConversationCatalog.ts";
import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const ProviderConversationSyncEpoch = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
);
export type ProviderConversationSyncEpoch = typeof ProviderConversationSyncEpoch.Type;

export const ProviderConversationCacheMeta = Schema.Struct({
  cacheEpoch: Schema.String,
  revision: NonNegativeInt,
});
export type ProviderConversationCacheMeta = typeof ProviderConversationCacheMeta.Type;

export const ProviderConversationCacheThread = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: Schema.String,
  archived: Schema.Boolean,
  thread: ProviderConversationThread,
  detailLoaded: Schema.Boolean,
  syncEpoch: ProviderConversationSyncEpoch,
  observedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  providerDeletedAt: Schema.NullOr(IsoDateTime),
});
export type ProviderConversationCacheThread = typeof ProviderConversationCacheThread.Type;

export interface ProviderConversationCacheThreadSnapshot {
  readonly meta: ProviderConversationCacheMeta;
  readonly thread: Option.Option<ProviderConversationCacheThread>;
}

export const ProviderConversationCacheSyncState = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  status: Schema.Literals(["never", "syncing", "fresh", "stale"]),
  activeSyncEpoch: Schema.NullOr(ProviderConversationSyncEpoch),
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  lastSuccessAt: Schema.NullOr(IsoDateTime),
  failureReason: Schema.NullOr(
    Schema.Literals(["disconnected", "unsupported", "protocol", "operation-failed", "internal"]),
  ),
});
export type ProviderConversationCacheSyncState = typeof ProviderConversationCacheSyncState.Type;

export const BeginProviderConversationSyncInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  syncEpoch: ProviderConversationSyncEpoch,
  startedAt: IsoDateTime,
});
export type BeginProviderConversationSyncInput = typeof BeginProviderConversationSyncInput.Type;

export const UpsertProviderConversationCatalogThreadInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  providerInstanceId: ProviderInstanceId,
  thread: ProviderConversationThread,
  archived: Schema.Boolean,
  syncEpoch: ProviderConversationSyncEpoch,
  observedAt: IsoDateTime,
});
export type UpsertProviderConversationCatalogThreadInput =
  typeof UpsertProviderConversationCatalogThreadInput.Type;

export const UpsertProviderConversationDetailInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  thread: ProviderConversationThread,
  observedAt: IsoDateTime,
});
export type UpsertProviderConversationDetailInput =
  typeof UpsertProviderConversationDetailInput.Type;

export const CompleteProviderConversationSyncInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  syncEpoch: ProviderConversationSyncEpoch,
  completedAt: IsoDateTime,
});
export type CompleteProviderConversationSyncInput =
  typeof CompleteProviderConversationSyncInput.Type;

export const FailProviderConversationSyncInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  syncEpoch: ProviderConversationSyncEpoch,
  failedAt: IsoDateTime,
  reason: Schema.Literals([
    "disconnected",
    "unsupported",
    "protocol",
    "operation-failed",
    "internal",
  ]),
});
export type FailProviderConversationSyncInput = typeof FailProviderConversationSyncInput.Type;

export const GetProviderConversationCacheThreadInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerThreadId: Schema.String,
});
export type GetProviderConversationCacheThreadInput =
  typeof GetProviderConversationCacheThreadInput.Type;

export const GetProviderConversationCacheThreadByIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProviderConversationCacheThreadByIdInput =
  typeof GetProviderConversationCacheThreadByIdInput.Type;

export const MarkProviderConversationDeletedInput = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});
export type MarkProviderConversationDeletedInput = typeof MarkProviderConversationDeletedInput.Type;

export const ListProviderConversationCacheThreadsInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cwd: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Boolean),
  includeDeleted: Schema.optional(Schema.Boolean),
});
export type ListProviderConversationCacheThreadsInput =
  typeof ListProviderConversationCacheThreadsInput.Type;

export const SearchProviderConversationCacheThreadsInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cwd: Schema.String,
  query: Schema.String,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
});
export type SearchProviderConversationCacheThreadsInput =
  typeof SearchProviderConversationCacheThreadsInput.Type;

export type ProviderConversationCacheRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface ProviderConversationCacheRepositoryShape {
  readonly getMeta: Effect.Effect<
    ProviderConversationCacheMeta,
    ProviderConversationCacheRepositoryError
  >;
  readonly getSyncState: (
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<
    Option.Option<ProviderConversationCacheSyncState>,
    ProviderConversationCacheRepositoryError
  >;
  readonly beginSync: (
    input: BeginProviderConversationSyncInput,
  ) => Effect.Effect<void, ProviderConversationCacheRepositoryError>;
  readonly upsertCatalogThread: (
    input: UpsertProviderConversationCatalogThreadInput,
  ) => Effect.Effect<void, ProviderConversationCacheRepositoryError>;
  readonly upsertThreadDetail: (
    input: UpsertProviderConversationDetailInput,
  ) => Effect.Effect<boolean, ProviderConversationCacheRepositoryError>;
  readonly completeSync: (
    input: CompleteProviderConversationSyncInput,
  ) => Effect.Effect<void, ProviderConversationCacheRepositoryError>;
  readonly failSync: (
    input: FailProviderConversationSyncInput,
  ) => Effect.Effect<void, ProviderConversationCacheRepositoryError>;
  readonly markProviderDeleted: (
    input: MarkProviderConversationDeletedInput,
  ) => Effect.Effect<void, ProviderConversationCacheRepositoryError>;
  readonly purgeThread: (
    input: GetProviderConversationCacheThreadByIdInput,
  ) => Effect.Effect<void, ProviderConversationCacheRepositoryError>;
  readonly getThread: (
    input: GetProviderConversationCacheThreadInput,
  ) => Effect.Effect<
    Option.Option<ProviderConversationCacheThread>,
    ProviderConversationCacheRepositoryError
  >;
  readonly getThreadById: (
    input: GetProviderConversationCacheThreadByIdInput,
  ) => Effect.Effect<
    Option.Option<ProviderConversationCacheThread>,
    ProviderConversationCacheRepositoryError
  >;
  /** Read detail and cache generation atomically for page consistency checks. */
  readonly getThreadByIdSnapshot: (
    input: GetProviderConversationCacheThreadByIdInput,
  ) => Effect.Effect<
    ProviderConversationCacheThreadSnapshot,
    ProviderConversationCacheRepositoryError
  >;
  readonly listThreads: (
    input: ListProviderConversationCacheThreadsInput,
  ) => Effect.Effect<
    ReadonlyArray<ProviderConversationCacheThread>,
    ProviderConversationCacheRepositoryError
  >;
  /**
   * Return a bounded set of active cache rows whose provider summary or
   * already-cached detail may contain the query. Callers perform the final
   * normalized-message match after decoding.
   */
  readonly searchThreads: (
    input: SearchProviderConversationCacheThreadsInput,
  ) => Effect.Effect<
    ReadonlyArray<ProviderConversationCacheThread>,
    ProviderConversationCacheRepositoryError
  >;
}

export class ProviderConversationCacheRepository extends Context.Service<
  ProviderConversationCacheRepository,
  ProviderConversationCacheRepositoryShape
>()("t3/persistence/Services/ProviderConversationCache/ProviderConversationCacheRepository") {}
