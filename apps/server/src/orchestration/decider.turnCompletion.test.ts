import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2026-01-01T00:00:01.000Z";

function makeReadModel(latestTurn: OrchestrationThread["latestTurn"]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn,
        createdAt: STARTED_AT,
        updatedAt: STARTED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: STARTED_AT,
  };
}

function latestTurn(
  state: "running" | "completed" | "interrupted" | "error",
  completedAt: string | null,
): NonNullable<OrchestrationThread["latestTurn"]> {
  return {
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: STARTED_AT,
    startedAt: STARTED_AT,
    completedAt,
    assistantMessageId: MessageId.make("assistant-1"),
  };
}

const command = {
  type: "thread.turn.complete" as const,
  commandId: CommandId.make("provider:event-1:thread-turn-complete"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  providerTurnId: "native-turn-1",
  outcome: "failed" as const,
  completedAt: COMPLETED_AT,
};

it.layer(NodeServices.layer)("turn completion decider", (it) => {
  it.effect("emits a provider-normal durable completion for an existing running turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(latestTurn("running", null)),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event.type).toBe("thread.turn-completed");
      if (event.type === "thread.turn-completed") {
        expect(event.occurredAt).toBe(COMPLETED_AT);
        expect(event.metadata.providerTurnId).toBe("native-turn-1");
        expect(event.payload).toEqual({
          threadId: "thread-1",
          turnId: "turn-1",
          providerTurnId: "native-turn-1",
          outcome: "failed",
          completedAt: COMPLETED_AT,
        });
      }
    }),
  );

  it.effect("is state-idempotent for an equivalent terminal completion", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: { ...command, commandId: CommandId.make("provider:event-2:thread-turn-complete") },
        readModel: makeReadModel(latestTurn("error", COMPLETED_AT)),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event.type).toBe("thread.turn-completed");
      if (event.type === "thread.turn-completed") {
        expect(event.payload.outcome).toBe("failed");
        expect(event.payload.completedAt).toBe(COMPLETED_AT);
      }
    }),
  );

  it.effect("rejects missing, stale, and conflicting completions", () =>
    Effect.gen(function* () {
      for (const readModel of [
        makeReadModel(null),
        makeReadModel({ ...latestTurn("running", null), turnId: TurnId.make("turn-other") }),
        makeReadModel(latestTurn("completed", COMPLETED_AT)),
        makeReadModel(latestTurn("error", "2026-01-01T00:00:02.000Z")),
      ]) {
        const error = yield* decideOrchestrationCommand({ command, readModel }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
});
