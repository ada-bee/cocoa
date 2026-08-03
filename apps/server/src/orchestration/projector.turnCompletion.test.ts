import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { projectEvent } from "./projector.ts";

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2026-01-01T00:00:01.000Z";

function makeReadModel(turnId = TurnId.make("turn-1")): OrchestrationReadModel {
  return {
    snapshotSequence: 3,
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
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: STARTED_AT,
          startedAt: STARTED_AT,
          completedAt: null,
          assistantMessageId: MessageId.make("assistant-1"),
        },
        createdAt: STARTED_AT,
        updatedAt: STARTED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [
          {
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-1"),
            completedAt: STARTED_AT,
          },
        ],
        session: null,
      },
    ],
    updatedAt: STARTED_AT,
  };
}

function completionEvent(turnId = TurnId.make("turn-1")): OrchestrationEvent {
  return {
    sequence: 4,
    eventId: EventId.make("event-complete"),
    type: "thread.turn-completed",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: COMPLETED_AT,
    commandId: CommandId.make("provider:event-1:thread-turn-complete"),
    causationEventId: null,
    correlationId: CommandId.make("provider:event-1:thread-turn-complete"),
    metadata: { providerTurnId: "native-turn-1" },
    payload: {
      threadId: ThreadId.make("thread-1"),
      turnId,
      providerTurnId: "native-turn-1",
      outcome: "interrupted",
      completedAt: COMPLETED_AT,
    },
  };
}

it.effect("projects an exact turn completion without changing checkpoint state", () =>
  Effect.gen(function* () {
    const before = makeReadModel();
    const after = yield* projectEvent(before, completionEvent());
    expect(after.threads[0]?.latestTurn).toEqual({
      ...before.threads[0]?.latestTurn,
      state: "interrupted",
      completedAt: COMPLETED_AT,
    });
    expect(after.threads[0]?.checkpoints).toEqual(before.threads[0]?.checkpoints);
  }),
);

it.effect("does not terminalize a different turn", () =>
  Effect.gen(function* () {
    const before = makeReadModel(TurnId.make("turn-other"));
    const after = yield* projectEvent(before, completionEvent());
    expect(after.threads[0]?.latestTurn).toEqual(before.threads[0]?.latestTurn);
    expect(after.snapshotSequence).toBe(4);
  }),
);
