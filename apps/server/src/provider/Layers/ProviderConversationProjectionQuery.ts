import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  MessageId,
  OrchestrationThread,
  OrchestrationThreadShell,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationProposedPlan,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadDetailWindow,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  ProviderConversationCacheMeta,
  ProviderConversationCacheThread,
} from "../../persistence/Services/ProviderConversationCache.ts";
import { ProviderConversationCacheRepository } from "../../persistence/Services/ProviderConversationCache.ts";
import { ProviderConversationCacheSync } from "../Services/ProviderConversationCacheSync.ts";
import { ProviderConversationProjectionQuery } from "../Services/ProviderConversationProjectionQuery.ts";
import {
  decodeProviderConversationDetailCursor,
  encodeProviderConversationDetailCursor,
} from "../ProviderConversationDetailCursor.ts";
import type { ProviderConversationTurn } from "../ProviderConversationCatalog.ts";

const epochSecondsIso = (seconds: number | null, fallback: string): string => {
  if (seconds === null) return fallback;
  return Option.match(DateTime.make(seconds * 1_000), {
    onNone: () => fallback,
    onSome: DateTime.formatIso,
  });
};

const itemRecord = (item: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(item) ? (item as Record<string, unknown>) : undefined;

const itemId = (threadId: string, turnId: string, index: number, item: unknown): string => {
  const record = itemRecord(item);
  return `${threadId}:${turnId}:${Predicate.isString(record?.id) ? record.id : index}`;
};

const userMessageText = (item: Record<string, unknown>): string => {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .flatMap((part) => {
      const record = itemRecord(part);
      return record?.type === "text" && Predicate.isString(record.text) ? [record.text] : [];
    })
    .join("\n");
};

const turnHasUserMessage = (turn: ProviderConversationTurn): boolean =>
  turn.items.some((item) => itemRecord(item)?.type === "userMessage");

interface ProviderTurnWindow {
  readonly turns: ReadonlyArray<ProviderConversationTurn>;
  readonly beforeCursor: string | null;
  readonly hasMore: boolean;
  readonly isFirstPage: boolean;
}

interface LoadedThreadDetail {
  readonly thread: OrchestrationThread;
  readonly turnWindow: ProviderTurnWindow | undefined;
  readonly cacheMeta: ProviderConversationCacheMeta | undefined;
  readonly cacheThread: ProviderConversationCacheThread | undefined;
}

function selectProviderTurnWindow(
  entry: ProviderConversationCacheThread,
  window: OrchestrationThreadDetailWindow,
): ProviderTurnWindow {
  const allTurns = entry.thread.turns;
  let endExclusive = allTurns.length;
  let isFirstPage = true;
  if (window.beforeCursor !== undefined) {
    const cursor = decodeProviderConversationDetailCursor(window.beforeCursor);
    if (cursor !== null && cursor.threadId === entry.threadId) {
      const boundaryIndex = allTurns.findIndex((turn) => turn.id === cursor.beforeTurnId);
      if (boundaryIndex >= 0) {
        endExclusive = boundaryIndex;
        isFirstPage = false;
      }
    }
  }

  let start = endExclusive;
  let userTurnCount = 0;
  for (let index = endExclusive - 1; index >= 0; index--) {
    start = index;
    if (turnHasUserMessage(allTurns[index]!)) {
      userTurnCount += 1;
      if (userTurnCount >= window.turnLimit) break;
    }
  }

  const hasMore = start > 0;
  return {
    turns: allTurns.slice(start, endExclusive),
    beforeCursor: hasMore
      ? encodeProviderConversationDetailCursor({
          threadId: entry.threadId,
          beforeTurnId: allTurns[start]!.id,
        })
      : null,
    hasMore,
    isFirstPage,
  };
}

function providerHistoryVersion(entry: ProviderConversationCacheThread): string {
  return Buffer.from(
    JSON.stringify({ thread: entry.providerThreadId, updatedAt: entry.thread.updatedAt }),
  ).toString("base64url");
}

function projectLatestProviderTurn(
  entry: ProviderConversationCacheThread,
): OrchestrationLatestTurn | null {
  const turn = entry.thread.turns.at(-1);
  if (turn === undefined) return null;
  const turnId = TurnId.make(`${entry.threadId}:${turn.id}`);
  const startedAt = epochSecondsIso(
    turn.startedAt,
    epochSecondsIso(entry.thread.createdAt, entry.observedAt),
  );
  const completedAt =
    turn.completedAt === null ? null : epochSecondsIso(turn.completedAt, startedAt);
  let assistantMessageId: ReturnType<typeof MessageId.make> | null = null;
  for (let index = 0; index < turn.items.length; index++) {
    const item = turn.items[index];
    if (itemRecord(item)?.type === "agentMessage") {
      assistantMessageId = MessageId.make(itemId(entry.threadId, turn.id, index, item));
    }
  }
  return {
    turnId,
    state:
      turn.status === "in-progress"
        ? "running"
        : turn.status === "interrupted"
          ? "interrupted"
          : turn.status === "failed"
            ? "error"
            : "completed",
    requestedAt: startedAt,
    startedAt,
    completedAt,
    assistantMessageId,
  };
}

function projectProviderHistory(
  entry: ProviderConversationCacheThread,
  turns: ReadonlyArray<ProviderConversationTurn> = entry.thread.turns,
) {
  const messages: Array<OrchestrationMessage> = [];
  const proposedPlans: Array<OrchestrationProposedPlan> = [];
  const activities: Array<OrchestrationThreadActivity> = [];

  for (const turn of turns) {
    const turnId = TurnId.make(`${entry.threadId}:${turn.id}`);
    const startedAt = epochSecondsIso(
      turn.startedAt,
      epochSecondsIso(entry.thread.createdAt, entry.observedAt),
    );
    const completedAt =
      turn.completedAt === null ? null : epochSecondsIso(turn.completedAt, startedAt);
    for (let index = 0; index < turn.items.length; index++) {
      const item = turn.items[index];
      const record = itemRecord(item);
      if (!record || !Predicate.isString(record.type)) continue;
      const nativeItemId = itemId(entry.threadId, turn.id, index, item);
      if (record.type === "userMessage") {
        const text = userMessageText(record);
        if (text.length === 0) continue;
        messages.push({
          id: MessageId.make(nativeItemId),
          role: "user",
          text,
          turnId,
          streaming: false,
          createdAt: startedAt,
          updatedAt: startedAt,
        });
        continue;
      }
      if (record.type === "agentMessage" && Predicate.isString(record.text)) {
        const id = MessageId.make(nativeItemId);
        messages.push({
          id,
          role: "assistant",
          text: record.text,
          turnId,
          streaming: turn.status === "in-progress",
          createdAt: startedAt,
          updatedAt: completedAt ?? startedAt,
        });
        continue;
      }
      if (record.type === "plan" && Predicate.isString(record.text) && record.text.trim() !== "") {
        proposedPlans.push({
          id: nativeItemId,
          turnId,
          planMarkdown: record.text,
          implementedAt: null,
          implementationThreadId: null,
          createdAt: startedAt,
          updatedAt: completedAt ?? startedAt,
        });
        continue;
      }
      if (record.type === "reasoning") continue;
      const summary =
        record.type === "commandExecution" && Predicate.isString(record.command)
          ? record.command
          : record.type === "mcpToolCall" && Predicate.isString(record.tool)
            ? `${Predicate.isString(record.server) ? `${record.server}: ` : ""}${record.tool}`
            : record.type === "dynamicToolCall" && Predicate.isString(record.tool)
              ? record.tool
              : record.type;
      activities.push({
        id: EventId.make(nativeItemId),
        tone: record.status === "failed" || record.status === "declined" ? "error" : "tool",
        kind: `provider.${record.type}`,
        summary: summary.trim() === "" ? record.type : summary,
        payload: item,
        turnId,
        createdAt: completedAt ?? startedAt,
      });
    }
  }
  return {
    messages,
    proposedPlans,
    activities,
    latestTurn: projectLatestProviderTurn(entry),
  };
}

const providerSession = (entry: ProviderConversationCacheThread): OrchestrationSession => ({
  threadId: entry.threadId,
  status:
    entry.thread.status === "active"
      ? "running"
      : entry.thread.status === "idle"
        ? "ready"
        : entry.thread.status === "system-error"
          ? "error"
          : "stopped",
  providerName: entry.thread.modelProvider.trim() === "" ? null : entry.thread.modelProvider,
  providerInstanceId: entry.providerInstanceId,
  runtimeMode: DEFAULT_RUNTIME_MODE,
  activeTurnId:
    entry.thread.turns.at(-1)?.status === "in-progress"
      ? TurnId.make(`${entry.threadId}:${entry.thread.turns.at(-1)!.id}`)
      : null,
  lastError: entry.thread.status === "system-error" ? "Provider reported a thread error." : null,
  updatedAt: entry.observedAt,
});

function selectProject(
  projects: ReadonlyArray<OrchestrationProject>,
  entry: ProviderConversationCacheThread,
): OrchestrationProject | undefined {
  return projects.find(
    (project) =>
      project.deletedAt === null &&
      project.providerInstanceId === entry.providerInstanceId &&
      project.workspaceRoot === entry.thread.cwd,
  );
}

function providerTitle(entry: ProviderConversationCacheThread): string {
  const title = entry.thread.title?.trim() || entry.thread.preview.trim();
  return title === "" ? "Untitled thread" : title;
}

const buildSearchSnippet = (text: string, query: string): string => {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) return normalizedText;
  const normalizedQuery = query.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const matchIndex = normalizedText.toLocaleLowerCase().indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
};

interface RankedSearchMatch {
  readonly match: OrchestrationThreadSearchMatch;
  readonly updatedAt: string;
}

function toThread(
  entry: ProviderConversationCacheThread,
  project: OrchestrationProject,
  overlay: OrchestrationThread | undefined,
  window?: ProviderTurnWindow,
): OrchestrationThread {
  const history = projectProviderHistory(entry, window?.turns);
  const createdAt = epochSecondsIso(entry.thread.createdAt, entry.observedAt);
  const updatedAt = epochSecondsIso(entry.thread.updatedAt, entry.observedAt);
  return {
    id: entry.threadId,
    projectId: project.id,
    title: providerTitle(entry),
    modelSelection: overlay?.modelSelection ??
      project.defaultModelSelection ?? {
        instanceId: entry.providerInstanceId,
        model: DEFAULT_MODEL,
      },
    runtimeMode: overlay?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: overlay?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: overlay?.branch ?? null,
    worktreePath: overlay?.worktreePath ?? null,
    latestTurn: entry.detailLoaded ? history.latestTurn : (overlay?.latestTurn ?? null),
    createdAt,
    updatedAt,
    archivedAt: entry.archived ? entry.observedAt : null,
    settledOverride: overlay?.settledOverride ?? null,
    settledAt: overlay?.settledAt ?? null,
    snoozedUntil: overlay?.snoozedUntil ?? null,
    snoozedAt: overlay?.snoozedAt ?? null,
    titleRegeneration: overlay?.titleRegeneration ?? null,
    deletedAt: entry.deletedAt,
    messages: history.messages,
    proposedPlans: history.proposedPlans,
    activities: [
      ...history.activities,
      ...(window === undefined || window.isFirstPage ? (overlay?.activities ?? []) : []),
    ],
    checkpoints: window === undefined || window.isFirstPage ? (overlay?.checkpoints ?? []) : [],
    session: overlay?.session ?? providerSession(entry),
  };
}

function toShell(thread: OrchestrationThread): OrchestrationThreadShell {
  const latestUserMessageAt = thread.messages.reduce<string | null>(
    (latest, message) =>
      message.role !== "user" || (latest !== null && latest >= message.createdAt)
        ? latest
        : message.createdAt,
    null,
  );
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil,
    snoozedAt: thread.snoozedAt,
    titleRegeneration: thread.titleRegeneration,
    session: thread.session,
    latestUserMessageAt,
    hasPendingApprovals: thread.activities.some(
      (activity) => activity.kind.includes("approval") && activity.tone === "approval",
    ),
    hasPendingUserInput: thread.activities.some((activity) => activity.kind.includes("userInput")),
    hasActionableProposedPlan: thread.proposedPlans.some((plan) => plan.implementedAt === null),
  };
}

export const makeProviderConversationProjectionQuery = Effect.gen(function* () {
  const base = yield* ProjectionSnapshotQuery;
  const cache = yield* ProviderConversationCacheRepository;
  const sync = yield* ProviderConversationCacheSync;

  const providerShell = (archived: boolean) =>
    Effect.gen(function* () {
      const baseSnapshot = yield* archived
        ? base.getArchivedShellSnapshot()
        : base.getShellSnapshot();
      const baseDetails = yield* base.getCommandReadModel();
      const projects = baseDetails.projects;
      const overlays = new Map(baseDetails.threads.map((thread) => [thread.id, thread]));
      const entries = yield* Effect.forEach(
        projects,
        (project) =>
          cache.listThreads({
            providerInstanceId: project.providerInstanceId,
            cwd: project.workspaceRoot,
            archived,
          }),
        { concurrency: 8 },
      ).pipe(Effect.map((groups) => groups.flat()));
      const providerThreads = entries.flatMap((entry) => {
        const project = selectProject(projects, entry);
        return project === undefined
          ? []
          : [toShell(toThread(entry, project, overlays.get(entry.threadId)))];
      });
      const providerThreadIds = new Set(providerThreads.map((thread) => thread.id));
      const transientLocalThreads = baseSnapshot.threads.filter(
        (thread) =>
          !providerThreadIds.has(thread.id) &&
          (thread.latestTurn === null ||
            (thread.session !== null &&
              thread.session.status !== "stopped" &&
              thread.session.status !== "error")),
      );
      const threads = [...providerThreads, ...transientLocalThreads];
      const meta = yield* cache.getMeta;
      return {
        snapshotSequence: baseSnapshot.snapshotSequence,
        projects: baseSnapshot.projects,
        threads,
        updatedAt: threads.reduce(
          (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
          baseSnapshot.updatedAt,
        ),
        cacheEpoch: meta.cacheEpoch,
        cacheRevision: meta.revision,
      };
    });

  const loadThreadDetail = (
    threadId: Parameters<typeof base.getThreadDetailById>[0],
    window?: OrchestrationThreadDetailWindow,
  ) =>
    Effect.gen(function* () {
      let cachedSnapshot = yield* cache.getThreadByIdSnapshot({ threadId });
      let cached = cachedSnapshot.thread;
      if (Option.isNone(cached)) {
        const baseThread = yield* base.getThreadDetailById(threadId);
        if (Option.isNone(baseThread)) return Option.none<LoadedThreadDetail>();
        return Option.some<LoadedThreadDetail>({
          thread: baseThread.value,
          turnWindow: undefined,
          cacheMeta: undefined,
          cacheThread: undefined,
        });
      }
      if (!cached.value.detailLoaded) {
        yield* sync.refreshThread(cached.value.providerInstanceId, cached.value.providerThreadId);
        cachedSnapshot = yield* cache.getThreadByIdSnapshot({ threadId });
        cached = cachedSnapshot.thread;
      }
      if (Option.isNone(cached)) return Option.none<LoadedThreadDetail>();
      const projects = (yield* base.getCommandReadModel()).projects;
      const project = selectProject(projects, cached.value);
      if (project === undefined) return Option.none<LoadedThreadDetail>();
      const overlay = yield* base.getThreadDetailById(threadId);
      const turnWindow =
        window === undefined ? undefined : selectProviderTurnWindow(cached.value, window);
      return Option.some<LoadedThreadDetail>({
        thread: toThread(cached.value, project, Option.getOrUndefined(overlay), turnWindow),
        turnWindow,
        cacheMeta: cachedSnapshot.meta,
        cacheThread: cached.value,
      });
    });

  const getThreadDetailById = (threadId: Parameters<typeof base.getThreadDetailById>[0]) =>
    loadThreadDetail(threadId).pipe(Effect.map(Option.map(({ thread }) => thread)));

  const searchThreads: typeof base.searchThreads = Effect.fn(
    "ProviderConversationProjectionQuery.searchThreads",
  )(function* (input) {
    const baseShell = yield* base.getShellSnapshot();
    const limit = input.limit ?? 50;
    const candidateLimit = Math.min(200, limit * 4);
    const candidateGroups = yield* Effect.forEach(
      baseShell.projects,
      (project) =>
        cache
          .searchThreads({
            providerInstanceId: project.providerInstanceId,
            cwd: project.workspaceRoot,
            query: input.query,
            limit: candidateLimit,
          })
          .pipe(Effect.map((entries) => ({ project, entries }))),
      { concurrency: 8 },
    );
    const query = input.query.toLocaleLowerCase();
    const providerMatches: Array<RankedSearchMatch> = candidateGroups.flatMap(
      ({ project, entries }) =>
        entries.flatMap((entry): ReadonlyArray<RankedSearchMatch> => {
          const messages = projectProviderHistory(entry)
            .messages.flatMap((message) =>
              !message.streaming &&
              (message.role === "user" || message.role === "assistant") &&
              message.text.toLocaleLowerCase().includes(query)
                ? [message]
                : [],
            )
            .toSorted((left, right) => {
              if (left.role !== right.role) return left.role === "user" ? -1 : 1;
              return right.createdAt.localeCompare(left.createdAt);
            });
          const message = messages[0];
          if (message !== undefined) {
            return [
              {
                match: {
                  threadId: entry.threadId,
                  projectId: project.id,
                  source: message.role === "user" ? "user" : "assistant",
                  snippet: buildSearchSnippet(message.text, input.query),
                  messageCreatedAt: message.createdAt,
                },
                updatedAt: epochSecondsIso(entry.thread.updatedAt, entry.observedAt),
              },
            ];
          }
          if (!entry.thread.preview.toLocaleLowerCase().includes(query)) return [];
          return [
            {
              match: {
                threadId: entry.threadId,
                projectId: project.id,
                source: "user",
                snippet: buildSearchSnippet(entry.thread.preview, input.query),
                messageCreatedAt: null,
              },
              updatedAt: epochSecondsIso(entry.thread.updatedAt, entry.observedAt),
            },
          ];
        }),
    );
    const baseMatches: Array<RankedSearchMatch> = (yield* Effect.forEach(
      (yield* base.searchThreads(input)).matches,
      (match) =>
        cache.getThreadById({ threadId: match.threadId }).pipe(
          Effect.map((cached) =>
            Option.isSome(cached)
              ? null
              : {
                  match,
                  updatedAt:
                    baseShell.threads.find((thread) => thread.id === match.threadId)?.updatedAt ??
                    "",
                },
          ),
        ),
      { concurrency: 8 },
    )).flatMap((ranked) => (ranked === null ? [] : [ranked]));
    return {
      matches: [...providerMatches, ...baseMatches]
        .toSorted((left, right) => {
          if (left.match.source !== right.match.source) {
            return left.match.source === "user" ? -1 : 1;
          }
          const recency = right.updatedAt.localeCompare(left.updatedAt);
          return recency === 0 ? left.match.threadId.localeCompare(right.match.threadId) : recency;
        })
        .slice(0, limit)
        .map(({ match }) => match),
    };
  });

  return ProviderConversationProjectionQuery.of({
    ...base,
    getSnapshot: () => base.getSnapshot(),
    getCommandReadModel: () => base.getCommandReadModel(),
    getShellSnapshot: () => providerShell(false),
    getArchivedShellSnapshot: () => providerShell(true),
    getCounts: () =>
      Effect.gen(function* () {
        const shell = yield* providerShell(false);
        return { projectCount: shell.projects.length, threadCount: shell.threads.length };
      }),
    getFirstActiveThreadIdByProjectId: (projectId) =>
      providerShell(false).pipe(
        Effect.map((snapshot) =>
          Option.fromNullishOr(
            snapshot.threads.find((thread) => thread.projectId === projectId)?.id,
          ),
        ),
      ),
    getThreadShellById: (threadId) =>
      providerShell(false).pipe(
        Effect.map((snapshot) =>
          Option.fromNullishOr(snapshot.threads.find((thread) => thread.id === threadId)),
        ),
      ),
    getThreadDetailById,
    getThreadDetailSnapshot: (threadId, window) =>
      Effect.gen(function* () {
        const detail = yield* loadThreadDetail(threadId, window);
        if (Option.isNone(detail)) return Option.none<OrchestrationThreadDetailSnapshot>();
        const sequence = yield* base.getSnapshotSequence();
        const meta = detail.value.cacheMeta ?? (yield* cache.getMeta);
        let page:
          | {
              readonly beforeCursor: string | null;
              readonly hasMore: boolean;
              readonly snapshotSequence: number;
              readonly cacheEpoch: string;
              readonly cacheRevision: number;
              readonly historyVersion: string;
            }
          | undefined;
        if (detail.value.turnWindow !== undefined && detail.value.cacheThread !== undefined) {
          page = {
            beforeCursor: detail.value.turnWindow.beforeCursor,
            hasMore: detail.value.turnWindow.hasMore,
            snapshotSequence: sequence.snapshotSequence,
            cacheEpoch: meta.cacheEpoch,
            cacheRevision: meta.revision,
            historyVersion: providerHistoryVersion(detail.value.cacheThread),
          };
        }
        return Option.some({
          snapshotSequence: sequence.snapshotSequence,
          cacheEpoch: meta.cacheEpoch,
          cacheRevision: meta.revision,
          thread: detail.value.thread,
          ...(page === undefined ? {} : { page }),
        });
      }),
    searchThreads,
  });
});

export const ProviderConversationProjectionQueryLive = Layer.effect(
  ProviderConversationProjectionQuery,
  makeProviderConversationProjectionQuery,
);
