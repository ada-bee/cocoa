import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  Event as OpenCodeEvent,
  GlobalEvent as OpenCodeGlobalEvent,
  Message as OpenCodeMessage,
  OpencodeClient,
  Part as OpenCodePart,
  Session as OpenCodeSession,
} from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  type ProviderConversationCatalog,
  ProviderConversationCatalogError,
  type ProviderConversationInvalidation,
  type ProviderConversationThread,
  type ProviderConversationTurn,
} from "../ProviderConversationCatalog.ts";
import { openCodeRuntimeErrorDetail } from "../OpenCodeEndpointRuntime.ts";

const OPENCODE_CATALOG_PAGE_SIZE = 1_000;

interface OpenCodeCatalogCursor {
  readonly updatedAt: number;
  readonly providerThreadId: string;
}

interface OpenCodeMessageEntry {
  readonly info: OpenCodeMessage;
  readonly parts: ReadonlyArray<OpenCodePart>;
}

interface MutableTurn {
  readonly id: string;
  status: ProviderConversationTurn["status"];
  readonly startedAt: number | null;
  completedAt: number | null;
  readonly items: Array<unknown>;
}

export interface MakeOpenCodeConversationCatalogOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly client: OpencodeClient;
  /** Tests and transports which relay events separately can disable the native SSE pump. */
  readonly startEventPump?: boolean;
}

export interface OpenCodeConversationCatalogRuntime {
  readonly catalog: ProviderConversationCatalog;
  readonly ingestEvent: (event: OpenCodeEvent | OpenCodeGlobalEvent) => Effect.Effect<void>;
  readonly invalidateCatalog: Effect.Effect<void>;
}

const epochSeconds = (milliseconds: number | undefined): number | null =>
  milliseconds === undefined ? null : Math.floor(milliseconds / 1_000);

function encodeCursor(cursor: OpenCodeCatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): OpenCodeCatalogCursor | null {
  if (value === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("updatedAt" in decoded) ||
      !("providerThreadId" in decoded) ||
      typeof decoded.updatedAt !== "number" ||
      !Number.isFinite(decoded.updatedAt) ||
      typeof decoded.providerThreadId !== "string"
    ) {
      return null;
    }
    return {
      updatedAt: decoded.updatedAt,
      providerThreadId: decoded.providerThreadId,
    };
  } catch {
    return null;
  }
}

function statusCode(cause: unknown): number | undefined {
  const seen = new Set<unknown>();
  const pending: Array<unknown> = [cause];
  for (let index = 0; pending.length > 0 && index < 24; index += 1) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.status === "number") return record.status;
    if (typeof record.statusCode === "number") return record.statusCode;
    const response = record.response;
    if (typeof response === "object" && response !== null) {
      const responseStatus = (response as { readonly status?: unknown }).status;
      if (typeof responseStatus === "number") return responseStatus;
    }
    for (const key of ["cause", "error", "data", "body"] as const) {
      if (record[key] !== undefined) pending.push(record[key]);
    }
  }
  return undefined;
}

function mapSdkError(
  providerInstanceId: ProviderInstanceId,
  operation: string,
  cause: unknown,
): ProviderConversationCatalogError {
  const status = statusCode(cause);
  const disconnected =
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (cause instanceof TypeError && status === undefined) ||
    (cause instanceof Error && cause.name === "AbortError");
  return new ProviderConversationCatalogError({
    providerInstanceId,
    operation,
    reason: disconnected ? "disconnected" : "operation-failed",
    detail: disconnected
      ? "The OpenCode provider endpoint disconnected."
      : `OpenCode rejected the conversation operation: ${openCodeRuntimeErrorDetail(cause)}`,
    cause,
  });
}

function protocolError(
  providerInstanceId: ProviderInstanceId,
  operation: string,
  detail: string,
): ProviderConversationCatalogError {
  return new ProviderConversationCatalogError({
    providerInstanceId,
    operation,
    reason: "protocol",
    detail,
  });
}

function unsupportedError(
  providerInstanceId: ProviderInstanceId,
  operation: string,
  detail: string,
): ProviderConversationCatalogError {
  return new ProviderConversationCatalogError({
    providerInstanceId,
    operation,
    reason: "unsupported",
    detail,
  });
}

function compareSessions(left: OpenCodeSession, right: OpenCodeSession): number {
  return right.time.updated - left.time.updated || right.id.localeCompare(left.id);
}

function isAfterCursor(session: OpenCodeSession, cursor: OpenCodeCatalogCursor | null): boolean {
  if (cursor === null) return true;
  return (
    session.time.updated < cursor.updatedAt ||
    (session.time.updated === cursor.updatedAt &&
      session.id.localeCompare(cursor.providerThreadId) < 0)
  );
}

function sessionMatchesCwd(
  session: OpenCodeSession,
  cwd: string | ReadonlyArray<string> | undefined,
): boolean {
  if (cwd === undefined) return true;
  return typeof cwd === "string" ? session.directory === cwd : cwd.includes(session.directory);
}

function normalizedModelProvider(
  session: OpenCodeSession,
  messages: ReadonlyArray<OpenCodeMessageEntry> = [],
): string {
  if (session.model?.providerID) return session.model.providerID;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!.info;
    if (message.role === "assistant" && message.providerID.trim() !== "") {
      return message.providerID;
    }
    if (message.role === "user" && message.model.providerID.trim() !== "") {
      return message.model.providerID;
    }
  }
  return "opencode";
}

function textParts(
  parts: ReadonlyArray<OpenCodePart>,
): ReadonlyArray<{ type: "text"; text: string }> {
  return parts.flatMap((part) =>
    part.type === "text" ? [{ type: "text" as const, text: part.text }] : [],
  );
}

function assistantText(parts: ReadonlyArray<OpenCodePart>): string {
  return textParts(parts)
    .map((part) => part.text)
    .join("");
}

function additionalItems(parts: ReadonlyArray<OpenCodePart>): ReadonlyArray<unknown> {
  const items: Array<unknown> = [];
  for (const part of parts) {
    if (part.type === "reasoning") {
      items.push({ ...part, source: part });
      continue;
    }
    if (part.type === "tool") {
      items.push({
        id: part.id,
        type: "dynamicToolCall",
        tool: part.tool,
        status: part.state.status === "error" ? "failed" : part.state.status,
        source: part,
      });
    }
  }
  return items;
}

function assistantStatus(
  message: Extract<OpenCodeMessage, { role: "assistant" }>,
): ProviderConversationTurn["status"] {
  if (message.error?.name === "MessageAbortedError") return "interrupted";
  if (message.error !== undefined) return "failed";
  return message.time.completed === undefined ? "in-progress" : "completed";
}

function appendAssistant(
  turn: MutableTurn,
  entry: OpenCodeMessageEntry,
  message: Extract<OpenCodeMessage, { role: "assistant" }>,
): void {
  turn.items.push(
    {
      id: message.id,
      type: "agentMessage",
      text: assistantText(entry.parts),
      source: { info: message, parts: entry.parts },
    },
    ...additionalItems(entry.parts),
  );
  turn.status = assistantStatus(message);
  turn.completedAt = turn.status === "in-progress" ? null : epochSeconds(message.time.completed);
}

function normalizeTurns(
  messages: ReadonlyArray<OpenCodeMessageEntry>,
): ReadonlyArray<ProviderConversationTurn> {
  const turns: Array<MutableTurn> = [];
  const turnsByUserMessage = new Map<string, MutableTurn>();
  let current: MutableTurn | undefined;

  for (const entry of messages) {
    if (entry.info.role === "user") {
      current = {
        id: entry.info.id,
        status: "in-progress",
        startedAt: epochSeconds(entry.info.time.created),
        completedAt: null,
        items: [
          {
            id: entry.info.id,
            type: "userMessage",
            content: textParts(entry.parts),
            source: { info: entry.info, parts: entry.parts },
          },
        ],
      };
      turns.push(current);
      turnsByUserMessage.set(entry.info.id, current);
      continue;
    }

    const target = turnsByUserMessage.get(entry.info.parentID) ?? current;
    if (target !== undefined) {
      appendAssistant(target, entry, entry.info);
      continue;
    }

    current = {
      id: entry.info.parentID || entry.info.id,
      status: assistantStatus(entry.info),
      startedAt: epochSeconds(entry.info.time.created),
      completedAt: epochSeconds(entry.info.time.completed),
      items: [],
    };
    appendAssistant(current, entry, entry.info);
    turns.push(current);
  }

  return turns.map((turn) => ({ ...turn, itemsView: "full" as const }));
}

type OpenCodeEventPayload = OpenCodeEvent | OpenCodeGlobalEvent["payload"];

function eventPayload(event: OpenCodeEvent | OpenCodeGlobalEvent): OpenCodeEventPayload {
  return "payload" in event ? event.payload : event;
}

function eventSessionId(event: OpenCodeEventPayload): string | undefined {
  const properties: unknown = "properties" in event ? event.properties : undefined;
  if (typeof properties !== "object" || properties === null) return undefined;
  const record = properties as Record<string, unknown>;
  if (typeof record.sessionID === "string") return record.sessionID;
  const info = record.info;
  if (typeof info !== "object" || info === null) return undefined;
  const id = (info as { readonly id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

export const makeOpenCodeConversationCatalog = Effect.fn("OpenCodeConversationCatalog.make")(
  function* (
    options: MakeOpenCodeConversationCatalogOptions,
  ): Effect.fn.Return<OpenCodeConversationCatalogRuntime, never, Scope.Scope> {
    const invalidations = yield* PubSub.unbounded<ProviderConversationInvalidation>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(invalidations));
    const statusBySession = new Map<
      string,
      Pick<ProviderConversationThread, "status" | "activeFlags">
    >();
    const pendingApprovals = new Map<string, Set<string>>();
    const pendingQuestions = new Map<string, Set<string>>();
    const sessionDirectories = new Map<string, string>();

    const publish = (invalidation: ProviderConversationInvalidation) =>
      PubSub.publish(invalidations, invalidation).pipe(Effect.asVoid);

    const runSdk = <A>(operation: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => mapSdkError(options.providerInstanceId, operation, cause),
      });

    const normalizeThread = (
      session: OpenCodeSession,
      messages: ReadonlyArray<OpenCodeMessageEntry> = [],
    ): ProviderConversationThread => {
      sessionDirectories.set(session.id, session.directory);
      const turns = normalizeTurns(messages);
      const lastTurn = turns.at(-1);
      const cachedStatus = statusBySession.get(session.id);
      const derivedStatus: ProviderConversationThread["status"] =
        session.time.archived !== undefined
          ? "idle"
          : lastTurn?.status === "in-progress"
            ? "active"
            : lastTurn?.status === "failed"
              ? "system-error"
              : "idle";
      const firstUserText = turns
        .flatMap((turn) => turn.items)
        .flatMap((item) => {
          if (typeof item !== "object" || item === null || !("type" in item)) return [];
          const record = item as { readonly type?: unknown; readonly content?: unknown };
          if (record.type !== "userMessage" || !Array.isArray(record.content)) return [];
          return record.content.flatMap((part) =>
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            typeof part.text === "string"
              ? [part.text]
              : [],
          );
        })
        .find((text) => text.trim() !== "");
      const title = session.title.trim();
      const activeFlags = new Set(cachedStatus?.activeFlags ?? []);
      if ((pendingApprovals.get(session.id)?.size ?? 0) > 0) {
        activeFlags.add("waiting-on-approval");
      }
      if ((pendingQuestions.get(session.id)?.size ?? 0) > 0) {
        activeFlags.add("waiting-on-user-input");
      }
      return {
        providerThreadId: session.id,
        cwd: session.directory,
        title: title === "" ? null : title,
        preview: firstUserText?.trim() || title,
        createdAt: epochSeconds(session.time.created) ?? 0,
        updatedAt: epochSeconds(session.time.updated) ?? 0,
        recencyAt: epochSeconds(session.time.updated),
        status: activeFlags.size > 0 ? "active" : (cachedStatus?.status ?? derivedStatus),
        activeFlags: [...activeFlags],
        source: { provider: "opencode", session },
        modelProvider: normalizedModelProvider(session, messages),
        ephemeral: false,
        parentProviderThreadId: session.parentID ?? null,
        turns,
      };
    };

    const listMatchingSessions = Effect.fn("OpenCodeConversationCatalog.listMatchingSessions")(
      function* (input: Parameters<ProviderConversationCatalog["listThreads"]>[0]) {
        const cursor = decodeCursor(input.cursor);
        if (input.cursor !== undefined && cursor === null) {
          return yield* protocolError(
            options.providerInstanceId,
            "session/list",
            "Cocoa received an invalid OpenCode catalog cursor.",
          );
        }
        const requestedLimit = Math.max(1, input.limit ?? 100);
        const collected: Array<OpenCodeSession> = [];
        let providerCursor = cursor === null ? undefined : cursor.updatedAt + 1;
        const seenProviderCursors = new Set<number>();

        while (collected.length <= requestedLimit) {
          const response = yield* runSdk("session/list", () =>
            options.client.experimental.session.list({
              archived: input.archived,
              limit: OPENCODE_CATALOG_PAGE_SIZE,
              ...(providerCursor === undefined ? {} : { cursor: providerCursor }),
              ...(typeof input.cwd === "string" ? { directory: input.cwd } : {}),
            }),
          );
          if (!Array.isArray(response.data)) {
            return yield* protocolError(
              options.providerInstanceId,
              "session/list",
              "OpenCode returned no session list payload.",
            );
          }
          const page = [...response.data].sort(compareSessions);
          for (const session of page) {
            if (
              (session.time.archived !== undefined) === input.archived &&
              sessionMatchesCwd(session, input.cwd) &&
              isAfterCursor(session, cursor)
            ) {
              collected.push(session);
            }
          }
          if (page.length < OPENCODE_CATALOG_PAGE_SIZE || collected.length > requestedLimit) break;
          const nextProviderCursor = page.at(-1)?.time.updated;
          if (
            nextProviderCursor === undefined ||
            seenProviderCursors.has(nextProviderCursor) ||
            nextProviderCursor === providerCursor
          ) {
            return yield* protocolError(
              options.providerInstanceId,
              "session/list",
              "OpenCode repeated a session catalog cursor.",
            );
          }
          seenProviderCursors.add(nextProviderCursor);
          providerCursor = nextProviderCursor;
        }

        collected.sort(compareSessions);
        const selected = collected.slice(0, requestedLimit);
        const last = selected.at(-1);
        return {
          sessions: selected,
          nextCursor:
            collected.length > requestedLimit && last !== undefined
              ? encodeCursor({ updatedAt: last.time.updated, providerThreadId: last.id })
              : null,
        };
      },
    );

    const catalog: ProviderConversationCatalog = {
      providerInstanceId: options.providerInstanceId,
      listThreads: Effect.fn("OpenCodeConversationCatalog.listThreads")(function* (input) {
        const page = yield* listMatchingSessions(input);
        return {
          threads: page.sessions.map((session) => normalizeThread(session)),
          nextCursor: page.nextCursor,
        };
      }),
      readThread: Effect.fn("OpenCodeConversationCatalog.readThread")(function* (providerThreadId) {
        const sessionResponse = yield* runSdk("session/get", () =>
          options.client.session.get({ sessionID: providerThreadId }),
        );
        if (sessionResponse.data === undefined) {
          return yield* protocolError(
            options.providerInstanceId,
            "session/get",
            `OpenCode returned no session payload for '${providerThreadId}'.`,
          );
        }
        const messagesResponse = yield* runSdk("session/messages", () =>
          options.client.session.messages({
            sessionID: providerThreadId,
            directory: sessionResponse.data!.directory,
          }),
        );
        if (!Array.isArray(messagesResponse.data)) {
          return yield* protocolError(
            options.providerInstanceId,
            "session/messages",
            `OpenCode returned no message history for '${providerThreadId}'.`,
          );
        }
        return normalizeThread(sessionResponse.data, messagesResponse.data);
      }),
      setThreadName: Effect.fn("OpenCodeConversationCatalog.setThreadName")(
        function* (providerThreadId, name) {
          yield* runSdk("session/update", () =>
            options.client.session.update({
              sessionID: providerThreadId,
              ...(sessionDirectories.get(providerThreadId) === undefined
                ? {}
                : { directory: sessionDirectories.get(providerThreadId)! }),
              title: name,
            }),
          );
          yield* publish({ type: "catalog-changed", providerThreadId });
        },
      ),
      archiveThread: Effect.fn("OpenCodeConversationCatalog.archiveThread")(
        function* (providerThreadId) {
          const archived = yield* Effect.sync(Date.now);
          yield* runSdk("session/update", () =>
            options.client.session.update({
              sessionID: providerThreadId,
              ...(sessionDirectories.get(providerThreadId) === undefined
                ? {}
                : { directory: sessionDirectories.get(providerThreadId)! }),
              time: { archived },
            }),
          );
          yield* publish({ type: "catalog-changed", providerThreadId });
        },
      ),
      unarchiveThread: (providerThreadId) =>
        Effect.fail(
          unsupportedError(
            options.providerInstanceId,
            "session/unarchive",
            `OpenCode cannot clear the archive timestamp for session '${providerThreadId}'.`,
          ),
        ),
      deleteThread: Effect.fn("OpenCodeConversationCatalog.deleteThread")(
        function* (providerThreadId) {
          yield* runSdk("session/delete", () =>
            options.client.session.delete({
              sessionID: providerThreadId,
              ...(sessionDirectories.get(providerThreadId) === undefined
                ? {}
                : { directory: sessionDirectories.get(providerThreadId)! }),
            }),
          );
          statusBySession.delete(providerThreadId);
          pendingApprovals.delete(providerThreadId);
          pendingQuestions.delete(providerThreadId);
          sessionDirectories.delete(providerThreadId);
          yield* publish({ type: "thread-deleted", providerThreadId });
        },
      ),
      subscribeInvalidations: PubSub.subscribe(invalidations),
    };

    const ingestEvent = Effect.fn("OpenCodeConversationCatalog.ingestEvent")(function* (
      envelope: OpenCodeEvent | OpenCodeGlobalEvent,
    ) {
      const event = eventPayload(envelope);
      // The OpenCode global stream also carries its replication journal. The
      // corresponding public events arrive separately and are the catalog's
      // invalidation boundary, so consuming both would publish duplicates.
      if (event.type === "sync") return;
      const providerThreadId = eventSessionId(event);
      if (providerThreadId === undefined) return;
      if ("payload" in envelope) sessionDirectories.set(providerThreadId, envelope.directory);

      switch (event.type) {
        case "session.created":
        case "session.updated":
          yield* publish({ type: "catalog-changed", providerThreadId });
          return;
        case "session.deleted":
          statusBySession.delete(providerThreadId);
          pendingApprovals.delete(providerThreadId);
          pendingQuestions.delete(providerThreadId);
          sessionDirectories.delete(providerThreadId);
          yield* publish({ type: "thread-deleted", providerThreadId });
          return;
        case "session.status":
          statusBySession.set(providerThreadId, {
            status: event.properties.status.type === "idle" ? "idle" : "active",
            activeFlags: statusBySession.get(providerThreadId)?.activeFlags ?? [],
          });
          break;
        case "session.idle":
          statusBySession.set(providerThreadId, {
            status: "idle",
            activeFlags: statusBySession.get(providerThreadId)?.activeFlags ?? [],
          });
          break;
        case "session.error":
          statusBySession.set(providerThreadId, {
            status: "system-error",
            activeFlags: statusBySession.get(providerThreadId)?.activeFlags ?? [],
          });
          break;
        case "permission.asked": {
          const pending = pendingApprovals.get(providerThreadId) ?? new Set<string>();
          pending.add(event.properties.id);
          pendingApprovals.set(providerThreadId, pending);
          break;
        }
        case "permission.replied":
          pendingApprovals.get(providerThreadId)?.delete(event.properties.requestID);
          break;
        case "question.asked": {
          const pending = pendingQuestions.get(providerThreadId) ?? new Set<string>();
          pending.add(event.properties.id);
          pendingQuestions.set(providerThreadId, pending);
          break;
        }
        case "question.replied":
        case "question.rejected":
          pendingQuestions.get(providerThreadId)?.delete(event.properties.requestID);
          break;
        case "session.compacted":
        case "message.updated":
        case "message.removed":
          break;
        default:
          // Part deltas are intentionally omitted: the durable refresh happens
          // at message/session lifecycle boundaries instead of once per token.
          return;
      }
      yield* publish({ type: "thread-changed", providerThreadId });
    });

    const invalidateCatalog = publish({ type: "catalog-reset" });

    if (options.startEventPump !== false) {
      const abortController = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => abortController.abort()));
      const pumpOnce: Effect.Effect<void, ProviderConversationCatalogError> = Effect.gen(
        function* () {
          const subscription = yield* runSdk("global/event", () =>
            options.client.global.event({ signal: abortController.signal }),
          );
          yield* Stream.fromAsyncIterable(subscription.stream, (cause) =>
            mapSdkError(options.providerInstanceId, "global/event", cause),
          ).pipe(Stream.runForEach(ingestEvent));
        },
      );
      yield* pumpOnce.pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(`OpenCode conversation event stream disconnected: ${cause.detail}`),
        ),
        Effect.catch(() => Effect.void),
        Effect.andThen(invalidateCatalog),
        Effect.andThen(Effect.sleep("1 second")),
        Effect.forever,
        Effect.forkScoped,
      );
    }

    return { catalog, ingestEvent, invalidateCatalog } satisfies OpenCodeConversationCatalogRuntime;
  },
);
