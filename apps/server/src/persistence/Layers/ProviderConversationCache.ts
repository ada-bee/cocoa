import { IsoDateTime, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ProviderConversationThread } from "../../provider/ProviderConversationCatalog.ts";
import { providerConversationThreadId } from "../../provider/ProviderConversationIdentity.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import {
  BeginProviderConversationSyncInput,
  CompleteProviderConversationSyncInput,
  FailProviderConversationSyncInput,
  GetProviderConversationCacheThreadInput,
  GetProviderConversationCacheThreadByIdInput,
  ProviderConversationCacheMeta,
  ProviderConversationCacheRepository,
  type ProviderConversationCacheRepositoryShape,
  ProviderConversationCacheSyncState,
  type ProviderConversationCacheThread,
  ProviderConversationSyncEpoch,
} from "../Services/ProviderConversationCache.ts";

const ThreadJson = Schema.fromJsonString(ProviderConversationThread);
const UpsertCatalogDbInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: Schema.String,
  cwd: Schema.String,
  title: Schema.NullOr(Schema.String),
  preview: Schema.String,
  providerCreatedAt: Schema.Int,
  providerUpdatedAt: Schema.Int,
  providerRecencyAt: Schema.NullOr(Schema.Int),
  archived: Schema.Number,
  summary: ThreadJson,
  syncEpoch: ProviderConversationSyncEpoch,
  observedAt: IsoDateTime,
});
const UpsertDetailDbInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerThreadId: Schema.String,
  cwd: Schema.String,
  title: Schema.NullOr(Schema.String),
  preview: Schema.String,
  providerCreatedAt: Schema.Int,
  providerUpdatedAt: Schema.Int,
  providerRecencyAt: Schema.NullOr(Schema.Int),
  summary: ThreadJson,
  detail: ThreadJson,
  observedAt: IsoDateTime,
});
const CacheThreadDbRow = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: Schema.String,
  archived: Schema.Number,
  summary: ThreadJson,
  detail: Schema.NullOr(ThreadJson),
  syncEpoch: ProviderConversationSyncEpoch,
  observedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
const SyncStateDbRow = ProviderConversationCacheSyncState;
const ListDbInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cwd: Schema.NullOr(Schema.String),
  archived: Schema.NullOr(Schema.Number),
  includeDeleted: Schema.Number,
});
const ChangesRow = Schema.Struct({ changes: Schema.Number });
const SearchDbInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cwd: Schema.String,
  pattern: Schema.String,
  limit: Schema.Int,
});

const escapeLikePattern = (value: string) => value.replace(/[!%_]/g, (match) => `!${match}`);

const mapError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

function toCacheThread(row: typeof CacheThreadDbRow.Type): ProviderConversationCacheThread {
  return {
    threadId: row.threadId,
    providerInstanceId: row.providerInstanceId,
    providerThreadId: row.providerThreadId,
    archived: row.archived === 1,
    thread: row.detail ?? row.summary,
    detailLoaded: row.detail !== null,
    syncEpoch: row.syncEpoch,
    observedAt: row.observedAt,
    deletedAt: row.deletedAt,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectThreadColumns = `
    SELECT provider_instance_id AS "providerInstanceId",
      provider_thread_id AS "providerThreadId",
      cocoa_thread_id AS "threadId",
      archived,
      summary_json AS "summary",
      detail_json AS "detail",
      sync_epoch AS "syncEpoch",
      observed_at AS "observedAt",
      deleted_at AS "deletedAt"
    FROM provider_conversation_cache_threads
  `;

  const readMeta = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProviderConversationCacheMeta,
    execute: () => sql`
      SELECT cache_epoch AS "cacheEpoch", revision
      FROM provider_conversation_cache_meta
      WHERE singleton = 1
    `,
  });

  const readSyncState = SqlSchema.findOneOption({
    Request: Schema.Struct({ providerInstanceId: ProviderInstanceId }),
    Result: SyncStateDbRow,
    execute: ({ providerInstanceId }) => sql`
      SELECT provider_instance_id AS "providerInstanceId", status,
        active_sync_epoch AS "activeSyncEpoch",
        last_attempt_at AS "lastAttemptAt",
        last_success_at AS "lastSuccessAt",
        failure_reason AS "failureReason"
      FROM provider_conversation_cache_sync
      WHERE provider_instance_id = ${providerInstanceId}
    `,
  });

  const bumpRevision = sql`
    UPDATE provider_conversation_cache_meta
    SET revision = revision + 1
    WHERE singleton = 1
  `;

  const beginSyncRow = SqlSchema.void({
    Request: BeginProviderConversationSyncInput,
    execute: (input) => sql`
      INSERT INTO provider_conversation_cache_sync (
        provider_instance_id, status, active_sync_epoch,
        last_attempt_at, last_success_at, failure_reason
      ) VALUES (
        ${input.providerInstanceId}, 'syncing', ${input.syncEpoch},
        ${input.startedAt}, NULL, NULL
      )
      ON CONFLICT(provider_instance_id) DO UPDATE SET
        status = 'syncing',
        active_sync_epoch = excluded.active_sync_epoch,
        last_attempt_at = excluded.last_attempt_at,
        failure_reason = NULL
    `,
  });

  const upsertCatalogRow = SqlSchema.void({
    Request: UpsertCatalogDbInput,
    execute: (input) => sql`
      INSERT INTO provider_conversation_cache_threads (
        provider_instance_id, provider_thread_id, cocoa_thread_id, cwd, title, preview,
        provider_created_at, provider_updated_at, provider_recency_at,
        archived, summary_json, detail_json, sync_epoch, observed_at, deleted_at
      ) VALUES (
        ${input.providerInstanceId}, ${input.providerThreadId}, ${input.threadId}, ${input.cwd},
        ${input.title}, ${input.preview}, ${input.providerCreatedAt},
        ${input.providerUpdatedAt}, ${input.providerRecencyAt}, ${input.archived},
        ${input.summary}, NULL, ${input.syncEpoch}, ${input.observedAt}, NULL
      )
      ON CONFLICT(provider_instance_id, provider_thread_id) DO UPDATE SET
        cocoa_thread_id = excluded.cocoa_thread_id,
        cwd = excluded.cwd,
        title = excluded.title,
        preview = excluded.preview,
        provider_created_at = excluded.provider_created_at,
        provider_recency_at = excluded.provider_recency_at,
        archived = excluded.archived,
        summary_json = excluded.summary_json,
        detail_json = provider_conversation_cache_threads.detail_json,
        provider_updated_at = excluded.provider_updated_at,
        sync_epoch = excluded.sync_epoch,
        observed_at = excluded.observed_at,
        deleted_at = NULL
    `,
  });

  const upsertDetailRow = SqlSchema.void({
    Request: UpsertDetailDbInput,
    execute: (input) => sql`
        UPDATE provider_conversation_cache_threads
        SET cwd = ${input.cwd},
          title = ${input.title},
          preview = ${input.preview},
          provider_created_at = ${input.providerCreatedAt},
          provider_updated_at = ${input.providerUpdatedAt},
          provider_recency_at = ${input.providerRecencyAt},
          summary_json = ${input.summary},
          detail_json = ${input.detail},
          observed_at = ${input.observedAt},
          deleted_at = NULL
        WHERE provider_instance_id = ${input.providerInstanceId}
          AND provider_thread_id = ${input.providerThreadId}
      `,
  });

  const completeSyncState = SqlSchema.void({
    Request: CompleteProviderConversationSyncInput,
    execute: (input) => sql`
      UPDATE provider_conversation_cache_sync
      SET status = 'fresh', active_sync_epoch = NULL,
        last_success_at = ${input.completedAt}, failure_reason = NULL
      WHERE provider_instance_id = ${input.providerInstanceId}
        AND status = 'syncing'
        AND active_sync_epoch = ${input.syncEpoch}
    `,
  });

  const failSyncState = SqlSchema.void({
    Request: FailProviderConversationSyncInput,
    execute: (input) => sql`
      UPDATE provider_conversation_cache_sync
      SET status = 'stale', active_sync_epoch = NULL,
        last_attempt_at = ${input.failedAt}, failure_reason = ${input.reason}
      WHERE provider_instance_id = ${input.providerInstanceId}
        AND status = 'syncing'
        AND active_sync_epoch = ${input.syncEpoch}
    `,
  });

  const getThreadRow = SqlSchema.findOneOption({
    Request: GetProviderConversationCacheThreadInput,
    Result: CacheThreadDbRow,
    execute: (input) =>
      sql.unsafe(
        `${selectThreadColumns}
         WHERE provider_instance_id = ? AND provider_thread_id = ?`,
        [input.providerInstanceId, input.providerThreadId],
      ),
  });

  const getThreadByIdRow = SqlSchema.findOneOption({
    Request: GetProviderConversationCacheThreadByIdInput,
    Result: CacheThreadDbRow,
    execute: (input) =>
      sql.unsafe(
        `${selectThreadColumns}
         WHERE cocoa_thread_id = ?`,
        [input.threadId],
      ),
  });

  const listThreadRows = SqlSchema.findAll({
    Request: ListDbInput,
    Result: CacheThreadDbRow,
    execute: (input) =>
      sql.unsafe(
        `${selectThreadColumns}
         WHERE provider_instance_id = ?
           AND (? IS NULL OR cwd = ?)
           AND (? IS NULL OR archived = ?)
           AND (? = 1 OR deleted_at IS NULL)
         ORDER BY COALESCE(provider_recency_at, provider_updated_at) DESC,
           provider_updated_at DESC, provider_thread_id`,
        [
          input.providerInstanceId,
          input.cwd,
          input.cwd,
          input.archived,
          input.archived,
          input.includeDeleted,
        ],
      ),
  });

  const searchThreadRows = SqlSchema.findAll({
    Request: SearchDbInput,
    Result: CacheThreadDbRow,
    execute: (input) =>
      sql.unsafe(
        `${selectThreadColumns}
         WHERE provider_instance_id = ?
           AND cwd = ?
           AND archived = 0
           AND deleted_at IS NULL
           AND (preview LIKE ? ESCAPE '!' OR detail_json LIKE ? ESCAPE '!')
         ORDER BY COALESCE(provider_recency_at, provider_updated_at) DESC,
           provider_updated_at DESC, provider_thread_id
         LIMIT ?`,
        [input.providerInstanceId, input.cwd, input.pattern, input.pattern, input.limit],
      ),
  });

  const getChanges = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ChangesRow,
    execute: () => sql`SELECT changes() AS "changes"`,
  });

  const getMeta: ProviderConversationCacheRepositoryShape["getMeta"] = readMeta().pipe(
    Effect.mapError(mapError("ProviderConversationCacheRepository.getMeta")),
  );

  const getSyncState: ProviderConversationCacheRepositoryShape["getSyncState"] = (
    providerInstanceId,
  ) =>
    readSyncState({ providerInstanceId }).pipe(
      Effect.mapError(mapError("ProviderConversationCacheRepository.getSyncState")),
    );

  const beginSync: ProviderConversationCacheRepositoryShape["beginSync"] = (input) =>
    sql
      .withTransaction(beginSyncRow(input).pipe(Effect.andThen(bumpRevision)))
      .pipe(Effect.mapError(mapError("ProviderConversationCacheRepository.beginSync")));

  const upsertCatalogThread: ProviderConversationCacheRepositoryShape["upsertCatalogThread"] = (
    input,
  ) =>
    sql
      .withTransaction(
        upsertCatalogRow({
          threadId:
            input.threadId ??
            providerConversationThreadId(input.providerInstanceId, input.thread.providerThreadId),
          providerInstanceId: input.providerInstanceId,
          providerThreadId: input.thread.providerThreadId,
          cwd: input.thread.cwd,
          title: input.thread.title,
          preview: input.thread.preview,
          providerCreatedAt: input.thread.createdAt,
          providerUpdatedAt: input.thread.updatedAt,
          providerRecencyAt: input.thread.recencyAt,
          archived: input.archived ? 1 : 0,
          summary: { ...input.thread, turns: [] },
          syncEpoch: input.syncEpoch,
          observedAt: input.observedAt,
        }).pipe(Effect.andThen(bumpRevision)),
      )
      .pipe(Effect.mapError(mapError("ProviderConversationCacheRepository.upsertCatalogThread")));

  const upsertThreadDetail: ProviderConversationCacheRepositoryShape["upsertThreadDetail"] = (
    input,
  ) =>
    sql
      .withTransaction(
        upsertDetailRow({
          providerInstanceId: input.providerInstanceId,
          providerThreadId: input.thread.providerThreadId,
          cwd: input.thread.cwd,
          title: input.thread.title,
          preview: input.thread.preview,
          providerCreatedAt: input.thread.createdAt,
          providerUpdatedAt: input.thread.updatedAt,
          providerRecencyAt: input.thread.recencyAt,
          summary: { ...input.thread, turns: [] },
          detail: input.thread,
          observedAt: input.observedAt,
        }).pipe(
          Effect.andThen(getChanges()),
          Effect.flatMap(({ changes }) =>
            changes === 0 ? Effect.succeed(false) : bumpRevision.pipe(Effect.as(true)),
          ),
        ),
      )
      .pipe(Effect.mapError(mapError("ProviderConversationCacheRepository.upsertThreadDetail")));

  const completeSync: ProviderConversationCacheRepositoryShape["completeSync"] = (input) =>
    sql
      .withTransaction(completeSyncState(input).pipe(Effect.andThen(bumpRevision)))
      .pipe(Effect.mapError(mapError("ProviderConversationCacheRepository.completeSync")));

  const failSync: ProviderConversationCacheRepositoryShape["failSync"] = (input) =>
    sql
      .withTransaction(failSyncState(input).pipe(Effect.andThen(bumpRevision)))
      .pipe(Effect.mapError(mapError("ProviderConversationCacheRepository.failSync")));

  const getThread: ProviderConversationCacheRepositoryShape["getThread"] = (input) =>
    getThreadRow(input).pipe(
      Effect.map(Option.map(toCacheThread)),
      Effect.mapError(mapError("ProviderConversationCacheRepository.getThread")),
    );

  const getThreadById: ProviderConversationCacheRepositoryShape["getThreadById"] = (input) =>
    getThreadByIdRow(input).pipe(
      Effect.map(Option.map(toCacheThread)),
      Effect.mapError(mapError("ProviderConversationCacheRepository.getThreadById")),
    );

  const getThreadByIdSnapshot: ProviderConversationCacheRepositoryShape["getThreadByIdSnapshot"] = (
    input,
  ) =>
    sql
      .withTransaction(
        Effect.all({
          meta: readMeta(),
          thread: getThreadByIdRow(input).pipe(Effect.map(Option.map(toCacheThread))),
        }),
      )
      .pipe(Effect.mapError(mapError("ProviderConversationCacheRepository.getThreadByIdSnapshot")));

  const listThreads: ProviderConversationCacheRepositoryShape["listThreads"] = (input) =>
    listThreadRows({
      providerInstanceId: input.providerInstanceId,
      cwd: input.cwd ?? null,
      archived: input.archived === undefined ? null : input.archived ? 1 : 0,
      includeDeleted: input.includeDeleted === true ? 1 : 0,
    }).pipe(
      Effect.map((rows) => rows.map(toCacheThread)),
      Effect.mapError(mapError("ProviderConversationCacheRepository.listThreads")),
    );

  const searchThreads: ProviderConversationCacheRepositoryShape["searchThreads"] = (input) =>
    searchThreadRows({
      providerInstanceId: input.providerInstanceId,
      cwd: input.cwd,
      pattern: `%${escapeLikePattern(input.query)}%`,
      limit: input.limit,
    }).pipe(
      Effect.map((rows) => rows.map(toCacheThread)),
      Effect.mapError(mapError("ProviderConversationCacheRepository.searchThreads")),
    );

  return {
    getMeta,
    getSyncState,
    beginSync,
    upsertCatalogThread,
    upsertThreadDetail,
    completeSync,
    failSync,
    getThread,
    getThreadById,
    getThreadByIdSnapshot,
    listThreads,
    searchThreads,
  } satisfies ProviderConversationCacheRepositoryShape;
});

export const ProviderConversationCacheRepositoryLive = Layer.effect(
  ProviderConversationCacheRepository,
  make,
);
