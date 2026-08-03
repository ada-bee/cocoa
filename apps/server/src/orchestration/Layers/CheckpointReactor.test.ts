import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-checkpoint-isolation");

function eventBase(sequence: number) {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread" as const,
    aggregateId: THREAD_ID,
    occurredAt: CREATED_AT,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

const forbidden = <A>(name: string): Effect.Effect<A> =>
  Effect.die(new Error(`${name} must not be called`));

const dieCheckpointStore: CheckpointStore.CheckpointStore["Service"] = {
  isGitRepository: () => forbidden("CheckpointStore.isGitRepository"),
  captureCheckpoint: () => forbidden("CheckpointStore.captureCheckpoint"),
  hasCheckpointRef: () => forbidden("CheckpointStore.hasCheckpointRef"),
  restoreCheckpoint: () => forbidden("CheckpointStore.restoreCheckpoint"),
  diffCheckpoints: () => forbidden("CheckpointStore.diffCheckpoints"),
  deleteCheckpointRefs: () => forbidden("CheckpointStore.deleteCheckpointRefs"),
};

const dieWorkspaceEntries: WorkspaceEntries.WorkspaceEntries["Service"] = {
  list: () => forbidden("WorkspaceEntries.list"),
  search: () => forbidden("WorkspaceEntries.search"),
  searchContents: () => forbidden("WorkspaceEntries.searchContents"),
  refresh: () => forbidden("WorkspaceEntries.refresh"),
};

const dieVcsStatusBroadcaster: VcsStatusBroadcaster["Service"] = {
  getStatus: () => forbidden("VcsStatusBroadcaster.getStatus"),
  refreshLocalStatus: () => forbidden("VcsStatusBroadcaster.refreshLocalStatus"),
  refreshStatus: () => forbidden("VcsStatusBroadcaster.refreshStatus"),
  streamStatus: () => Stream.fromEffect(forbidden("VcsStatusBroadcaster.streamStatus")),
};

it.effect("CheckpointReactor fails closed without gateway workspace operations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const domainEvents = yield* Queue.unbounded<OrchestrationEvent>();
      const revertReported = yield* Deferred.make<void>();
      const dispatched: Array<OrchestrationCommand> = [];
      const engine = OrchestrationEngineService.of({
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
          }).pipe(
            Effect.tap(() => Deferred.succeed(revertReported, undefined)),
            Effect.as({ sequence: dispatched.length }),
          ),
        streamDomainEvents: Stream.fromQueue(domainEvents),
        latestSequence: Effect.succeed(0),
      });

      const program = Effect.gen(function* () {
        const reactor = yield* CheckpointReactor;
        yield* reactor.start();

        yield* Queue.offer(domainEvents, {
          ...eventBase(1),
          type: "thread.turn-start-requested",
          payload: {
            threadId: THREAD_ID,
            messageId: MessageId.make("message-1"),
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: CREATED_AT,
          },
        } as unknown as OrchestrationEvent);
        yield* Queue.offer(domainEvents, {
          ...eventBase(2),
          type: "thread.turn-diff-completed",
          payload: {
            threadId: THREAD_ID,
            turnId: TurnId.make("turn-1"),
            completedAt: CREATED_AT,
            checkpointRef: "provider-owned-ref",
            status: "missing",
            files: [],
            assistantMessageId: null,
            checkpointTurnCount: 1,
          },
        } as unknown as OrchestrationEvent);
        yield* Queue.offer(domainEvents, {
          ...eventBase(3),
          type: "thread.checkpoint-revert-requested",
          payload: {
            threadId: THREAD_ID,
            turnCount: 1,
            createdAt: CREATED_AT,
          },
        } as unknown as OrchestrationEvent);

        yield* Deferred.await(revertReported);
        yield* reactor.drain;
      }).pipe(
        Effect.provide(CheckpointReactorLive),
        Effect.provideService(OrchestrationEngineService, engine),
        Effect.provideService(CheckpointStore.CheckpointStore, dieCheckpointStore),
        Effect.provideService(WorkspaceEntries.WorkspaceEntries, dieWorkspaceEntries),
        Effect.provideService(VcsStatusBroadcaster, dieVcsStatusBroadcaster),
        Effect.provide(NodeServices.layer),
      );

      yield* program;

      assert.lengthOf(dispatched, 1);
      const command = dispatched[0];
      assert.equal(command?.type, "thread.activity.append");
      if (command?.type !== "thread.activity.append") return;
      assert.equal(command.threadId, THREAD_ID);
      assert.deepStrictEqual(command.activity, {
        id: command.activity.id,
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert unavailable",
        payload: {
          turnCount: 1,
          detail:
            "Checkpoint revert is unavailable until the bound provider supplies checkpoint operations.",
        },
        turnId: null,
        createdAt: command.activity.createdAt,
      });
    }),
  ),
);
