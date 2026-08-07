import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as CodexClient from "effect-codex-app-server/client";

import { makeCodexConversationCatalog } from "./CodexConversationCatalog.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_remote");

const providerThread = {
  id: "019-provider-thread",
  cliVersion: "0.200.0",
  createdAt: 10,
  cwd: "/provider/workspace",
  ephemeral: false,
  modelProvider: "openai",
  name: "Provider-owned title",
  preview: "First user message",
  sessionId: "provider-session",
  source: "appServer" as const,
  status: {
    type: "active" as const,
    activeFlags: ["waitingOnApproval" as const],
  },
  turns: [
    {
      id: "provider-turn-1",
      status: "completed" as const,
      startedAt: 11,
      completedAt: 12,
      items: [],
      itemsView: "full" as const,
    },
  ],
  updatedAt: 12,
};

it.effect("lists, reads, mutates, and invalidates provider-native conversations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
      const client = {
        request: (method: string, params: unknown) =>
          Effect.sync(() => {
            requests.push({ method, params });
            switch (method) {
              case "thread/list":
                return { data: [{ ...providerThread, turns: [] }], nextCursor: "next-page" };
              case "thread/read":
                return { thread: providerThread };
              default:
                return {};
            }
          }),
      } as unknown as CodexClient.CodexAppServerClient["Service"];
      const runtime = yield* makeCodexConversationCatalog({
        providerInstanceId: INSTANCE_ID,
        borrowConnection: Effect.succeed({
          generationId: 1,
          connection: { client } as never,
          ensureCurrent: Effect.void,
        }),
      });

      const page = yield* runtime.catalog.listThreads({
        archived: false,
        cwd: "/provider/workspace",
        useStateDbOnly: true,
      });
      assert.equal(page.nextCursor, "next-page");
      assert.equal(page.threads[0]?.providerThreadId, providerThread.id);
      assert.equal(page.threads[0]?.cwd, providerThread.cwd);
      assert.deepEqual(page.threads[0]?.activeFlags, ["waiting-on-approval"]);

      const detail = yield* runtime.catalog.readThread(providerThread.id);
      assert.equal(detail.turns[0]?.id, "provider-turn-1");
      assert.equal(detail.turns[0]?.status, "completed");

      const invalidations = yield* runtime.catalog.subscribeInvalidations;
      yield* runtime.catalog.setThreadName(providerThread.id, "Renamed by Cocoa");
      assert.deepEqual(yield* PubSub.take(invalidations), {
        type: "catalog-changed",
        providerThreadId: providerThread.id,
      });

      yield* runtime.ingestNotification({
        method: "thread/deleted",
        params: { threadId: providerThread.id },
      });
      assert.deepEqual(yield* PubSub.take(invalidations), {
        type: "thread-deleted",
        providerThreadId: providerThread.id,
      });

      yield* runtime.ingestNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: providerThread.id,
          turnId: "provider-turn-1",
          itemId: "agent-1",
          delta: "streaming",
        },
      });
      assert.isEmpty(yield* PubSub.takeUpTo(invalidations, 1));
      yield* runtime.ingestNotification({
        method: "thread/status/changed",
        params: { threadId: providerThread.id, status: { type: "idle" } },
      });
      assert.deepEqual(yield* PubSub.take(invalidations), {
        type: "thread-changed",
        providerThreadId: providerThread.id,
      });

      assert.deepInclude(requests[0]?.params, {
        archived: false,
        cwd: "/provider/workspace",
        useStateDbOnly: true,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      assert.deepEqual(
        requests.map((request) => request.method),
        ["thread/list", "thread/read", "thread/name/set"],
      );
    }),
  ),
);
