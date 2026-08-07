import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  type ProviderConversationCatalog,
  ProviderConversationCatalogError,
  type ProviderConversationInvalidation,
  type ProviderConversationThread,
  type ProviderConversationTurn,
} from "../ProviderConversationCatalog.ts";
import type {
  CodexEndpointBorrowUnavailableError,
  CodexEndpointConnectionBorrow,
} from "./CodexEndpointSupervisor.ts";
import type { CodexEndpointNotification } from "./CodexEndpointRouter.ts";

const INTERACTIVE_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
] as const satisfies ReadonlyArray<CodexSchema.V2ThreadListParams__ThreadSourceKind>;

export interface MakeCodexConversationCatalogOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly borrowConnection: Effect.Effect<
    CodexEndpointConnectionBorrow,
    CodexEndpointBorrowUnavailableError
  >;
}

export interface CodexConversationCatalogRuntime {
  readonly catalog: ProviderConversationCatalog;
  readonly ingestNotification: (notification: CodexEndpointNotification) => Effect.Effect<void>;
  readonly invalidateCatalog: Effect.Effect<void>;
}

function normalizeTurnStatus(
  status: CodexSchema.V2ThreadReadResponse__TurnStatus,
): ProviderConversationTurn["status"] {
  switch (status) {
    case "inProgress":
      return "in-progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
  }
}

function normalizeItemsView(
  value: "notLoaded" | "summary" | "full" | null | undefined,
): ProviderConversationTurn["itemsView"] {
  switch (value) {
    case "notLoaded":
      return "not-loaded";
    case "summary":
      return "summary";
    case "full":
    case null:
    case undefined:
      return "full";
  }
}

function normalizeThreadStatus(
  status: CodexSchema.V2ThreadReadResponse__ThreadStatus,
): Pick<ProviderConversationThread, "status" | "activeFlags"> {
  switch (status.type) {
    case "notLoaded":
      return { status: "not-loaded", activeFlags: [] };
    case "idle":
      return { status: "idle", activeFlags: [] };
    case "systemError":
      return { status: "system-error", activeFlags: [] };
    case "active":
      return {
        status: "active",
        activeFlags: status.activeFlags.map((flag) =>
          flag === "waitingOnApproval" ? "waiting-on-approval" : "waiting-on-user-input",
        ),
      };
  }
}

function normalizeThread(
  thread: CodexSchema.V2ThreadReadResponse["thread"],
): ProviderConversationThread {
  return {
    providerThreadId: thread.id,
    cwd: thread.cwd,
    title: thread.name ?? null,
    preview: thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.recencyAt ?? null,
    ...normalizeThreadStatus(thread.status),
    source: thread.source,
    modelProvider: thread.modelProvider,
    ephemeral: thread.ephemeral,
    parentProviderThreadId: thread.parentThreadId ?? null,
    turns: thread.turns.map((turn) => ({
      id: turn.id,
      status: normalizeTurnStatus(turn.status),
      startedAt: turn.startedAt ?? null,
      completedAt: turn.completedAt ?? null,
      items: turn.items,
      itemsView: normalizeItemsView(turn.itemsView),
    })),
  };
}

function mapCodexError(
  providerInstanceId: ProviderInstanceId,
  operation: string,
  error: CodexErrors.CodexAppServerError,
): ProviderConversationCatalogError {
  switch (error._tag) {
    case "CodexAppServerTransportError":
    case "CodexAppServerInputStreamEndedError":
    case "CodexAppServerProcessExitedError":
    case "CodexAppServerSpawnError":
      return new ProviderConversationCatalogError({
        providerInstanceId,
        operation,
        reason: "disconnected",
        detail: "The provider endpoint disconnected.",
        cause: error,
      });
    case "CodexAppServerProtocolParseError":
    case "CodexAppServerIdentifierGenerationError":
      return new ProviderConversationCatalogError({
        providerInstanceId,
        operation,
        reason: "protocol",
        detail: "The provider returned a malformed conversation response.",
        cause: error,
      });
    case "CodexAppServerRequestError":
      return new ProviderConversationCatalogError({
        providerInstanceId,
        operation,
        reason:
          error.code === -32601
            ? "unsupported"
            : [-32700, -32600, -32602].includes(error.code)
              ? "protocol"
              : "operation-failed",
        detail:
          error.code === -32601
            ? "The provider does not support this conversation operation."
            : "The provider rejected the conversation operation.",
        cause: error,
      });
    case "CodexAppServerRequestCapacityError":
    case "CodexAppServerRequestTimeoutError":
      return new ProviderConversationCatalogError({
        providerInstanceId,
        operation,
        reason: "operation-failed",
        detail: "The provider conversation operation could not be completed.",
        cause: error,
      });
  }
}

function readNotificationThreadId(notification: CodexEndpointNotification): string | undefined {
  if (notification.method === "thread/started") return notification.params.thread.id;
  const params: unknown = notification.params;
  if (!Predicate.isObject(params) || !("threadId" in params)) return undefined;
  return Predicate.isString(params.threadId) ? params.threadId : undefined;
}

export const makeCodexConversationCatalog = Effect.fn("CodexConversationCatalog.make")(function* (
  options: MakeCodexConversationCatalogOptions,
) {
  const invalidations = yield* PubSub.unbounded<ProviderConversationInvalidation>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(invalidations));

  const withConnection = <A>(
    operation: string,
    use: (
      client: CodexClient.CodexAppServerClient["Service"],
    ) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
  ): Effect.Effect<A, ProviderConversationCatalogError> =>
    Effect.gen(function* () {
      const borrowed = yield* options.borrowConnection.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderConversationCatalogError({
              providerInstanceId: options.providerInstanceId,
              operation,
              reason: "disconnected",
              detail: "The provider conversation catalog is unavailable.",
              cause,
            }),
        ),
      );
      yield* borrowed.ensureCurrent.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderConversationCatalogError({
              providerInstanceId: options.providerInstanceId,
              operation,
              reason: "disconnected",
              detail: "The provider connection generation changed.",
              cause,
            }),
        ),
      );
      const result = yield* use(borrowed.connection.client).pipe(
        Effect.mapError((error) => mapCodexError(options.providerInstanceId, operation, error)),
      );
      yield* borrowed.ensureCurrent.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderConversationCatalogError({
              providerInstanceId: options.providerInstanceId,
              operation,
              reason: "disconnected",
              detail: "The provider connection changed before the result could be accepted.",
              cause,
            }),
        ),
      );
      return result;
    });

  const publishThreadInvalidation = (
    type: "thread-changed" | "thread-deleted" | "catalog-changed",
    providerThreadId: string,
  ) => PubSub.publish(invalidations, { type, providerThreadId }).pipe(Effect.asVoid);

  const catalog: ProviderConversationCatalog = {
    providerInstanceId: options.providerInstanceId,
    listThreads: Effect.fn("CodexConversationCatalog.listThreads")(function* (input) {
      const response = yield* withConnection("thread/list", (client) =>
        client.request("thread/list", {
          archived: input.archived,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.useStateDbOnly === undefined ? {} : { useStateDbOnly: input.useStateDbOnly }),
          sourceKinds: INTERACTIVE_SOURCE_KINDS,
          sortKey: "updated_at",
          sortDirection: "desc",
        }),
      );
      return {
        threads: response.data.map((thread) => normalizeThread(thread)),
        nextCursor: response.nextCursor ?? null,
      };
    }),
    readThread: Effect.fn("CodexConversationCatalog.readThread")(function* (providerThreadId) {
      const response = yield* withConnection("thread/read", (client) =>
        client.request("thread/read", { threadId: providerThreadId, includeTurns: true }),
      );
      return normalizeThread(response.thread);
    }),
    setThreadName: Effect.fn("CodexConversationCatalog.setThreadName")(
      function* (providerThreadId, name) {
        yield* withConnection("thread/name/set", (client) =>
          client.request("thread/name/set", { threadId: providerThreadId, name }),
        );
        yield* publishThreadInvalidation("catalog-changed", providerThreadId);
      },
    ),
    archiveThread: Effect.fn("CodexConversationCatalog.archiveThread")(
      function* (providerThreadId) {
        yield* withConnection("thread/archive", (client) =>
          client.request("thread/archive", { threadId: providerThreadId }),
        );
        yield* publishThreadInvalidation("catalog-changed", providerThreadId);
      },
    ),
    unarchiveThread: Effect.fn("CodexConversationCatalog.unarchiveThread")(
      function* (providerThreadId) {
        yield* withConnection("thread/unarchive", (client) =>
          client.request("thread/unarchive", { threadId: providerThreadId }),
        );
        yield* publishThreadInvalidation("catalog-changed", providerThreadId);
      },
    ),
    deleteThread: Effect.fn("CodexConversationCatalog.deleteThread")(function* (providerThreadId) {
      yield* withConnection("thread/delete", (client) =>
        client.request("thread/delete", { threadId: providerThreadId }),
      );
      yield* publishThreadInvalidation("thread-deleted", providerThreadId);
    }),
    subscribeInvalidations: PubSub.subscribe(invalidations),
  };

  const ingestNotification = Effect.fn("CodexConversationCatalog.ingestNotification")(function* (
    notification: CodexEndpointNotification,
  ) {
    const providerThreadId = readNotificationThreadId(notification);
    if (providerThreadId === undefined) return;
    const type = (() => {
      switch (notification.method) {
        case "thread/deleted":
          return "thread-deleted" as const;
        case "thread/started":
        case "thread/archived":
        case "thread/unarchived":
        case "thread/name/updated":
          return "catalog-changed" as const;
        case "thread/status/changed":
        case "thread/compacted":
        case "turn/started":
        case "turn/completed":
          return "thread-changed" as const;
        default:
          // Delta and progress notifications can arrive hundreds of times per
          // turn. Cocoa's live orchestration stream carries them; one native
          // thread/read at durable lifecycle boundaries refreshes the cache.
          return undefined;
      }
    })();
    if (type === undefined) return;
    yield* publishThreadInvalidation(type, providerThreadId);
  });

  return {
    catalog,
    ingestNotification,
    invalidateCatalog: PubSub.publish(invalidations, { type: "catalog-reset" }).pipe(Effect.asVoid),
  } satisfies CodexConversationCatalogRuntime;
});
