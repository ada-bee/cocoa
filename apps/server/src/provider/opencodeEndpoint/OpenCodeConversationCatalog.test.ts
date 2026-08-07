import { assert, it } from "@effect/vitest";
import type {
  GlobalEvent as OpenCodeGlobalEvent,
  OpencodeClient,
  Part as OpenCodePart,
  Session as OpenCodeSession,
} from "@opencode-ai/sdk/v2";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import { ProviderConversationCatalogError } from "../ProviderConversationCatalog.ts";
import { makeOpenCodeConversationCatalog } from "./OpenCodeConversationCatalog.ts";

const INSTANCE_ID = ProviderInstanceId.make("opencode_remote");
const isProviderConversationCatalogError = Schema.is(ProviderConversationCatalogError);

const activeSession = {
  id: "ses_active",
  slug: "active",
  projectID: "project-1",
  directory: "/provider/workspace",
  parentID: "ses_parent",
  title: "Provider-owned title",
  version: "1.15.13",
  model: { id: "claude-sonnet", providerID: "anthropic" },
  time: { created: 10_000, updated: 30_000 },
} satisfies OpenCodeSession;

const sessionWithoutParent = {
  id: activeSession.id,
  slug: activeSession.slug,
  projectID: activeSession.projectID,
  directory: activeSession.directory,
  title: activeSession.title,
  version: activeSession.version,
  model: activeSession.model,
  time: activeSession.time,
};

const secondSession = {
  ...sessionWithoutParent,
  id: "ses_second",
  slug: "second",
  title: "Second session",
  time: { created: 9_000, updated: 20_000 },
} satisfies OpenCodeSession;

const thirdSession = {
  ...sessionWithoutParent,
  id: "ses_third",
  slug: "third",
  title: "Third session",
  time: { created: 8_000, updated: 10_000 },
} satisfies OpenCodeSession;

const archivedSession = {
  ...sessionWithoutParent,
  id: "ses_archived",
  slug: "archived",
  title: "Archived session",
  time: { created: 7_000, updated: 7_000, archived: 7_500 },
} satisfies OpenCodeSession;

const userParts = [
  {
    id: "part-user-1",
    sessionID: activeSession.id,
    messageID: "message-user-1",
    type: "text",
    text: "Hello from another client",
  },
] satisfies Array<OpenCodePart>;

const assistantParts = [
  {
    id: "part-assistant-1",
    sessionID: activeSession.id,
    messageID: "message-assistant-1",
    type: "text",
    text: "Hello from OpenCode",
    time: { start: 11_100, end: 11_900 },
  },
  {
    id: "part-reasoning-1",
    sessionID: activeSession.id,
    messageID: "message-assistant-1",
    type: "reasoning",
    text: "Internal reasoning",
    time: { start: 11_050, end: 11_090 },
  },
  {
    id: "part-tool-1",
    sessionID: activeSession.id,
    messageID: "message-assistant-1",
    type: "tool",
    callID: "call-1",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: "/provider/workspace/README.md" },
      output: "contents",
      title: "Read README.md",
      metadata: {},
      time: { start: 11_200, end: 11_300 },
    },
  },
] satisfies Array<OpenCodePart>;

const messages = [
  {
    info: {
      id: "message-user-1",
      sessionID: activeSession.id,
      role: "user" as const,
      time: { created: 11_000 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    },
    parts: userParts,
  },
  {
    info: {
      id: "message-assistant-1",
      sessionID: activeSession.id,
      role: "assistant" as const,
      time: { created: 11_050, completed: 12_000 },
      parentID: "message-user-1",
      modelID: "claude-sonnet",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: activeSession.directory, root: activeSession.directory },
      cost: 0.01,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
    },
    parts: assistantParts,
  },
  {
    info: {
      id: "message-user-2",
      sessionID: activeSession.id,
      role: "user" as const,
      time: { created: 13_000 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    },
    parts: [
      {
        id: "part-user-2",
        sessionID: activeSession.id,
        messageID: "message-user-2",
        type: "text" as const,
        text: "Stop now",
      },
    ],
  },
  {
    info: {
      id: "message-assistant-2",
      sessionID: activeSession.id,
      role: "assistant" as const,
      time: { created: 13_100 },
      error: { name: "MessageAbortedError" as const, data: { message: "Interrupted" } },
      parentID: "message-user-2",
      modelID: "claude-sonnet",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: activeSession.directory, root: activeSession.directory },
      cost: 0.01,
      tokens: { input: 4, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  },
];

it.effect("lists, hydrates, mutates, and invalidates provider-owned OpenCode sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
      const client = {
        experimental: {
          session: {
            list: async (input: unknown) => {
              calls.push({ method: "experimental.session.list", input });
              return {
                data: [activeSession, secondSession, thirdSession, archivedSession],
              };
            },
          },
        },
        session: {
          get: async (input: unknown) => {
            calls.push({ method: "session.get", input });
            return { data: activeSession };
          },
          messages: async (input: unknown) => {
            calls.push({ method: "session.messages", input });
            return { data: messages };
          },
          update: async (input: unknown) => {
            calls.push({ method: "session.update", input });
            return { data: activeSession };
          },
          delete: async (input: unknown) => {
            calls.push({ method: "session.delete", input });
            return { data: true };
          },
        },
      } as unknown as OpencodeClient;
      const runtime = yield* makeOpenCodeConversationCatalog({
        providerInstanceId: INSTANCE_ID,
        client,
        startEventPump: false,
      });

      const firstPage = yield* runtime.catalog.listThreads({
        archived: false,
        cwd: activeSession.directory,
        limit: 2,
      });
      assert.deepEqual(
        firstPage.threads.map((thread) => thread.providerThreadId),
        [activeSession.id, secondSession.id],
      );
      assert.equal(firstPage.threads[0]?.cwd, activeSession.directory);
      assert.equal(firstPage.threads[0]?.parentProviderThreadId, activeSession.parentID);
      assert.equal(firstPage.threads[0]?.modelProvider, "anthropic");
      assert.isNotNull(firstPage.nextCursor);

      const secondPage = yield* runtime.catalog.listThreads({
        archived: false,
        cursor: firstPage.nextCursor!,
        limit: 2,
      });
      assert.deepEqual(
        secondPage.threads.map((thread) => thread.providerThreadId),
        [thirdSession.id],
      );
      assert.isNull(secondPage.nextCursor);

      const archived = yield* runtime.catalog.listThreads({ archived: true });
      assert.deepEqual(
        archived.threads.map((thread) => thread.providerThreadId),
        [archivedSession.id],
      );

      const detail = yield* runtime.catalog.readThread(activeSession.id);
      assert.equal(detail.preview, "Hello from another client");
      assert.equal(detail.turns.length, 2);
      assert.equal(detail.turns[0]?.status, "completed");
      assert.equal(detail.turns[1]?.status, "interrupted");
      assert.equal(detail.turns[0]?.itemsView, "full");
      assert.deepInclude(detail.turns[0]?.items[0], {
        id: "message-user-1",
        type: "userMessage",
        content: [{ type: "text", text: "Hello from another client" }],
      });
      assert.deepInclude(detail.turns[0]?.items[1], {
        id: "message-assistant-1",
        type: "agentMessage",
        text: "Hello from OpenCode",
      });
      assert.deepInclude(detail.turns[0]?.items[3], {
        id: "part-tool-1",
        type: "dynamicToolCall",
        tool: "read",
        status: "completed",
      });

      const invalidations = yield* runtime.catalog.subscribeInvalidations;
      yield* runtime.ingestEvent({
        directory: activeSession.directory,
        payload: {
          id: "event-question",
          type: "question.asked",
          properties: {
            id: "question-1",
            sessionID: activeSession.id,
            questions: [],
          },
        },
      } satisfies OpenCodeGlobalEvent);
      assert.deepEqual(yield* PubSub.take(invalidations), {
        type: "thread-changed",
        providerThreadId: activeSession.id,
      });
      assert.deepEqual((yield* runtime.catalog.readThread(activeSession.id)).activeFlags, [
        "waiting-on-user-input",
      ]);

      yield* runtime.ingestEvent({
        directory: activeSession.directory,
        payload: {
          id: "event-session-updated",
          type: "session.updated",
          properties: { sessionID: activeSession.id, info: activeSession },
        },
      } satisfies OpenCodeGlobalEvent);
      assert.deepEqual(yield* PubSub.take(invalidations), {
        type: "catalog-changed",
        providerThreadId: activeSession.id,
      });
      yield* runtime.ingestEvent({
        directory: activeSession.directory,
        payload: {
          id: "event-part-delta",
          type: "message.part.delta",
          properties: {
            sessionID: activeSession.id,
            messageID: "message-assistant-1",
            partID: "part-assistant-1",
            field: "text",
            delta: "streaming",
          },
        },
      } satisfies OpenCodeGlobalEvent);
      assert.isEmpty(yield* PubSub.takeUpTo(invalidations, 1));

      yield* runtime.catalog.setThreadName(activeSession.id, "Renamed by Cocoa");
      assert.deepEqual(yield* PubSub.take(invalidations), {
        type: "catalog-changed",
        providerThreadId: activeSession.id,
      });
      yield* runtime.catalog.archiveThread(activeSession.id);
      assert.deepEqual(yield* PubSub.take(invalidations), {
        type: "catalog-changed",
        providerThreadId: activeSession.id,
      });
      yield* runtime.catalog.deleteThread(activeSession.id);
      assert.deepEqual(yield* PubSub.take(invalidations), {
        type: "thread-deleted",
        providerThreadId: activeSession.id,
      });

      const unarchive = yield* Effect.exit(runtime.catalog.unarchiveThread(activeSession.id));
      assert(Exit.isFailure(unarchive));
      if (Exit.isFailure(unarchive)) {
        const error = Cause.squash(unarchive.cause);
        assert(isProviderConversationCatalogError(error));
        assert.equal(error.reason, "unsupported");
      }

      assert.deepInclude(calls.find((call) => call.method === "session.messages")?.input, {
        sessionID: activeSession.id,
        directory: activeSession.directory,
      });
      const archiveCall = calls.find(
        (call) =>
          call.method === "session.update" &&
          typeof call.input === "object" &&
          call.input !== null &&
          "time" in call.input,
      );
      assert(archiveCall !== undefined);
      assert.equal(
        typeof (archiveCall.input as { readonly time: { readonly archived: unknown } }).time
          .archived,
        "number",
      );
    }),
  ),
);

it.effect("rejects malformed cursors and classifies transport failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = {
        experimental: {
          session: {
            list: async () => {
              throw new TypeError("fetch failed");
            },
          },
        },
      } as unknown as OpencodeClient;
      const runtime = yield* makeOpenCodeConversationCatalog({
        providerInstanceId: INSTANCE_ID,
        client,
        startEventPump: false,
      });

      const malformed = yield* Effect.exit(
        runtime.catalog.listThreads({ archived: false, cursor: "not-a-cursor" }),
      );
      assert(Exit.isFailure(malformed));
      if (Exit.isFailure(malformed)) {
        const error = Cause.squash(malformed.cause);
        assert(isProviderConversationCatalogError(error));
        assert.equal(error.reason, "protocol");
      }

      const disconnected = yield* Effect.exit(runtime.catalog.listThreads({ archived: false }));
      assert(Exit.isFailure(disconnected));
      if (Exit.isFailure(disconnected)) {
        const error = Cause.squash(disconnected.cause);
        assert(isProviderConversationCatalogError(error));
        assert.equal(error.reason, "disconnected");
      }
    }),
  ),
);
