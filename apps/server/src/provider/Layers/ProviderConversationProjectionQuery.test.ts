import { assert, it } from "@effect/vitest";
import {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRepositoryIdentityResolver } from "../../project/ProviderRepositoryIdentityResolver.ts";
import { ProviderConversationCacheRepositoryLive } from "../../persistence/Layers/ProviderConversationCache.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderConversationCacheRepository,
  ProviderConversationSyncEpoch,
} from "../../persistence/Services/ProviderConversationCache.ts";
import type { ProviderConversationThread } from "../ProviderConversationCatalog.ts";
import { ProviderConversationCacheSync } from "../Services/ProviderConversationCacheSync.ts";
import { makeProviderConversationProjectionQuery } from "./ProviderConversationProjectionQuery.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const PROJECT_ID = ProjectId.make("project-1");
const NOW = "2026-08-07T10:00:00.000Z";
const SYNC = ProviderConversationSyncEpoch.make("sync-1");

const project: OrchestrationProject = {
  id: PROJECT_ID,
  providerInstanceId: INSTANCE_ID,
  title: "Remote project",
  workspaceRoot: "/provider/workspace",
  repositoryIdentity: null,
  defaultModelSelection: ModelSelection.make({ instanceId: INSTANCE_ID, model: "gpt-5.6-sol" }),
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const providerThread: ProviderConversationThread = {
  providerThreadId: "provider-thread-1",
  cwd: project.workspaceRoot,
  title: "Provider-owned title",
  preview: "hello",
  createdAt: 10,
  updatedAt: 12,
  recencyAt: 12,
  status: "idle",
  activeFlags: [],
  source: "appServer",
  modelProvider: "openai",
  ephemeral: false,
  parentProviderThreadId: null,
  turns: [
    {
      id: "provider-turn-1",
      status: "completed",
      startedAt: 11,
      completedAt: 12,
      itemsView: "full",
      items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "hello" }] },
        { id: "agent-1", type: "agentMessage", text: "hi from provider" },
        {
          id: "command-1",
          type: "commandExecution",
          command: "pwd",
          status: "completed",
        },
      ],
    },
  ],
};

const paginatedProviderThread: ProviderConversationThread = {
  ...providerThread,
  providerThreadId: "provider-thread-paginated",
  title: "Paginated provider history",
  turns: [
    {
      id: "turn-1",
      status: "completed",
      startedAt: 11,
      completedAt: 12,
      itemsView: "full",
      items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "prompt 1" }] },
        { id: "agent-1", type: "agentMessage", text: "reply 1" },
      ],
    },
    {
      id: "turn-2",
      status: "completed",
      startedAt: 13,
      completedAt: 14,
      itemsView: "full",
      items: [{ id: "agent-2", type: "agentMessage", text: "subagent 2" }],
    },
    {
      id: "turn-3",
      status: "completed",
      startedAt: 15,
      completedAt: 16,
      itemsView: "full",
      items: [{ id: "agent-3", type: "agentMessage", text: "subagent 3" }],
    },
    {
      id: "turn-4",
      status: "completed",
      startedAt: 17,
      completedAt: 18,
      itemsView: "full",
      items: [
        { id: "user-4", type: "userMessage", content: [{ type: "text", text: "prompt 4" }] },
        { id: "agent-4", type: "agentMessage", text: "reply 4" },
      ],
    },
    {
      id: "turn-5",
      status: "completed",
      startedAt: 19,
      completedAt: 20,
      itemsView: "full",
      items: [
        { id: "user-5", type: "userMessage", content: [{ type: "text", text: "prompt 5" }] },
        { id: "agent-5", type: "agentMessage", text: "reply 5" },
      ],
    },
  ],
};

const emptyShell: OrchestrationShellSnapshot = {
  snapshotSequence: 7,
  projects: [
    {
      ...project,
    },
  ],
  threads: [],
  updatedAt: NOW,
};
const readModel: OrchestrationReadModel = {
  snapshotSequence: 7,
  projects: [project],
  threads: [],
  updatedAt: NOW,
};

const base = ProjectionSnapshotQuery.of({
  getSnapshot: () => Effect.succeed(readModel),
  getCommandReadModel: () => Effect.succeed(readModel),
  getShellSnapshot: () => Effect.succeed(emptyShell),
  getArchivedShellSnapshot: () => Effect.succeed({ ...emptyShell, threads: [] }),
  searchThreads: () => Effect.succeed({ matches: [] }),
  getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 7 }),
  getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 0 }),
  getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
  getProjectShellById: () => Effect.succeed(Option.some(emptyShell.projects[0]!)),
  getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
  getCheckpointDiffContext: () => Effect.succeed(Option.none()),
  getThreadShellById: () => Effect.succeed(Option.none()),
  getThreadDetailById: () => Effect.succeed(Option.none()),
  getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
});

const cacheSync = ProviderConversationCacheSync.of({
  start: () => Effect.void,
  refreshInstance: () => Effect.void,
  refreshThread: () => Effect.void,
  drain: Effect.void,
  subscribeChanges: Effect.never,
});

const persistenceLayer = ProviderConversationCacheRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect("enriches Cocoa shell projects with provider-host repository identities", () =>
  Effect.gen(function* () {
    const query = yield* makeProviderConversationProjectionQuery.pipe(
      Effect.provideService(ProjectionSnapshotQuery, base),
      Effect.provideService(ProviderConversationCacheSync, cacheSync),
      Effect.provideService(
        ProviderRepositoryIdentityResolver,
        ProviderRepositoryIdentityResolver.of({
          resolve: ({ workspaceRoot }) =>
            Effect.succeed({
              canonicalKey: "github.com/ada-bee/cocoa",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "git@github.com:ada-bee/cocoa.git",
              },
              rootPath: workspaceRoot,
              displayName: "ada-bee/cocoa",
              provider: "github",
              owner: "ada-bee",
              name: "cocoa",
            }),
        }),
      ),
    );

    const shell = yield* query.getShellSnapshot();
    assert.equal(shell.projects[0]?.repositoryIdentity?.canonicalKey, "github.com/ada-bee/cocoa");
  }).pipe(Effect.provide(persistenceLayer)),
);

it.effect("projects provider-owned catalog and history into Cocoa shell/detail contracts", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderConversationCacheRepository;
    yield* repository.beginSync({
      providerInstanceId: INSTANCE_ID,
      syncEpoch: SYNC,
      startedAt: NOW,
    });
    yield* repository.upsertCatalogThread({
      providerInstanceId: INSTANCE_ID,
      thread: { ...providerThread, turns: [] },
      archived: false,
      syncEpoch: SYNC,
      observedAt: NOW,
    });
    yield* repository.completeSync({
      providerInstanceId: INSTANCE_ID,
      syncEpoch: SYNC,
      completedAt: NOW,
    });
    yield* repository.upsertThreadDetail({
      providerInstanceId: INSTANCE_ID,
      thread: providerThread,
      observedAt: NOW,
    });

    const query = yield* makeProviderConversationProjectionQuery.pipe(
      Effect.provideService(ProjectionSnapshotQuery, base),
      Effect.provideService(ProviderConversationCacheSync, cacheSync),
    );
    const shell = yield* query.getShellSnapshot();
    assert.lengthOf(shell.threads, 1);
    assert.equal(shell.threads[0]?.title, "Provider-owned title");
    assert.equal(shell.threads[0]?.projectId, PROJECT_ID);
    assert.equal(shell.cacheRevision, 4);

    const detail = yield* query.getThreadDetailSnapshot(shell.threads[0]!.id);
    assert.isTrue(Option.isSome(detail));
    if (Option.isNone(detail)) return;
    assert.deepEqual(
      detail.value.thread.messages.map((message) => [message.role, message.text]),
      [
        ["user", "hello"],
        ["assistant", "hi from provider"],
      ],
    );
    assert.equal(detail.value.thread.activities[0]?.summary, "pwd");
    assert.equal(detail.value.cacheEpoch, shell.cacheEpoch);

    const userSearch = yield* query.searchThreads({ query: "hello" });
    assert.equal(userSearch.matches[0]?.source, "user");
    assert.equal(userSearch.matches[0]?.snippet, "hello");
    const assistantSearch = yield* query.searchThreads({ query: "from provider" });
    assert.equal(assistantSearch.matches[0]?.source, "assistant");
    assert.equal(assistantSearch.matches[0]?.snippet, "hi from provider");
  }).pipe(Effect.provide(persistenceLayer)),
);

it.effect("uses Cocoa archive state while retaining history after provider deletion", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderConversationCacheRepository;
    yield* repository.beginSync({
      providerInstanceId: INSTANCE_ID,
      syncEpoch: SYNC,
      startedAt: NOW,
    });
    yield* repository.upsertCatalogThread({
      providerInstanceId: INSTANCE_ID,
      thread: { ...providerThread, turns: [] },
      archived: false,
      syncEpoch: SYNC,
      observedAt: NOW,
    });
    yield* repository.completeSync({
      providerInstanceId: INSTANCE_ID,
      syncEpoch: SYNC,
      completedAt: NOW,
    });
    yield* repository.upsertThreadDetail({
      providerInstanceId: INSTANCE_ID,
      thread: providerThread,
      observedAt: NOW,
    });
    const cached = Option.getOrThrow(
      yield* repository.getThread({
        providerInstanceId: INSTANCE_ID,
        providerThreadId: providerThread.providerThreadId,
      }),
    );
    const archivedReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: [
        {
          id: cached.threadId,
          projectId: PROJECT_ID,
          title: "Cocoa overlay",
          modelSelection: ModelSelection.make({ instanceId: INSTANCE_ID, model: "gpt-5.6-sol" }),
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: NOW,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          titleRegeneration: null,
          session: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
        },
      ],
    };
    const archivedBase = ProjectionSnapshotQuery.of({
      ...base,
      getCommandReadModel: () => Effect.succeed(archivedReadModel),
    });
    const query = yield* makeProviderConversationProjectionQuery.pipe(
      Effect.provideService(ProjectionSnapshotQuery, archivedBase),
      Effect.provideService(ProviderConversationCacheSync, cacheSync),
    );

    assert.isEmpty((yield* query.getShellSnapshot()).threads);
    assert.lengthOf((yield* query.getArchivedShellSnapshot()).threads, 1);
    assert.isEmpty((yield* query.searchThreads({ query: "hello" })).matches);

    yield* repository.markProviderDeleted({ threadId: cached.threadId, deletedAt: NOW });
    const retained = Option.getOrThrow(yield* query.getThreadDetailById(cached.threadId));
    assert.equal(retained.session?.status, "stopped");
    assert.equal(retained.messages[0]?.text, "hello");
  }).pipe(Effect.provide(persistenceLayer)),
);

it.effect("pages provider history by user-anchored turn windows without changing full reads", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderConversationCacheRepository;
    yield* repository.beginSync({
      providerInstanceId: INSTANCE_ID,
      syncEpoch: SYNC,
      startedAt: NOW,
    });
    yield* repository.upsertCatalogThread({
      providerInstanceId: INSTANCE_ID,
      thread: { ...paginatedProviderThread, turns: [] },
      archived: false,
      syncEpoch: SYNC,
      observedAt: NOW,
    });
    yield* repository.completeSync({
      providerInstanceId: INSTANCE_ID,
      syncEpoch: SYNC,
      completedAt: NOW,
    });
    yield* repository.upsertThreadDetail({
      providerInstanceId: INSTANCE_ID,
      thread: paginatedProviderThread,
      observedAt: NOW,
    });

    const query = yield* makeProviderConversationProjectionQuery.pipe(
      Effect.provideService(ProjectionSnapshotQuery, base),
      Effect.provideService(ProviderConversationCacheSync, cacheSync),
    );
    const threadId = (yield* query.getShellSnapshot()).threads[0]!.id;

    const full = Option.getOrThrow(yield* query.getThreadDetailSnapshot(threadId));
    assert.isUndefined(full.page);
    assert.deepEqual(
      full.thread.messages.map((message) => message.text),
      [
        "prompt 1",
        "reply 1",
        "subagent 2",
        "subagent 3",
        "prompt 4",
        "reply 4",
        "prompt 5",
        "reply 5",
      ],
    );

    const recent = Option.getOrThrow(
      yield* query.getThreadDetailSnapshot(threadId, { turnLimit: 2 }),
    );
    assert.deepEqual(
      recent.thread.messages.map((message) => message.text),
      ["prompt 4", "reply 4", "prompt 5", "reply 5"],
    );
    assert.isTrue(recent.page?.hasMore);
    assert.isString(recent.page?.beforeCursor);
    assert.equal(recent.page?.cacheEpoch, recent.cacheEpoch);
    assert.equal(recent.page?.cacheRevision, recent.cacheRevision);
    assert.isString(recent.page?.historyVersion);
    assert.equal(recent.thread.latestTurn?.turnId, `${threadId}:turn-5`);

    const older = Option.getOrThrow(
      yield* query.getThreadDetailSnapshot(threadId, {
        turnLimit: 1,
        beforeCursor: recent.page!.beforeCursor!,
      }),
    );
    assert.deepEqual(
      older.thread.messages.map((message) => message.text),
      ["prompt 1", "reply 1", "subagent 2", "subagent 3"],
    );
    assert.isFalse(older.page?.hasMore);
    assert.equal(older.page?.beforeCursor, null);

    const malformed = Option.getOrThrow(
      yield* query.getThreadDetailSnapshot(threadId, {
        turnLimit: 2,
        beforeCursor: "not-a-provider-cursor",
      }),
    );
    assert.deepEqual(
      malformed.thread.messages.map((message) => message.text),
      recent.thread.messages.map((message) => message.text),
    );
  }).pipe(Effect.provide(persistenceLayer)),
);
