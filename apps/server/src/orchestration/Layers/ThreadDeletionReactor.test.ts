import { EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  logCleanupCauseUnlessInterrupted,
  makeThreadDeletionReactor,
} from "./ThreadDeletionReactor.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("ThreadDeletionReactor backpressure", () => {
  type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

  const makeThreadDeletedEvent = (index: number): ThreadDeletedEvent => {
    const threadId = ThreadId.make(`thread-deletion-burst-${index}`);
    return {
      sequence: index,
      eventId: EventId.make(`event-thread-deletion-burst-${index}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-08-04T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.deleted",
      payload: {
        threadId,
        deletedAt: "2026-08-04T00:00:00.000Z",
      },
    };
  };

  it("propagates a bounded worker's pressure back to the orchestration event source", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const upstream = yield* Queue.bounded<OrchestrationEvent>(1);
          const firstStarted = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const allStopped = yield* Deferred.make<void>();
          const fifthPublished = yield* Deferred.make<void>();
          const stopped = yield* Ref.make<string[]>([]);
          const closed = yield* Ref.make<string[]>([]);
          const unsupported = () => Effect.die(new Error("unsupported test operation")) as never;

          const engine = OrchestrationEngineService.of({
            readEvents: () => Stream.empty,
            dispatch: () => unsupported(),
            streamDomainEvents: Stream.fromQueue(upstream),
            latestSequence: Effect.succeed(0),
          } satisfies OrchestrationEngineShape);
          const provider = ProviderService.of({
            startSession: () => unsupported(),
            recoverSession: () => unsupported(),
            sendTurn: () => unsupported(),
            interruptTurn: () => unsupported(),
            respondToRequest: () => unsupported(),
            respondToUserInput: () => unsupported(),
            stopSession: ({ threadId }) =>
              Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(stopped, (threadIds) => [
                  ...threadIds,
                  threadId,
                ]);
                if (count.length === 1) {
                  yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                  yield* Deferred.await(releaseFirst);
                }
                if (count.length === 5) {
                  yield* Deferred.succeed(allStopped, undefined).pipe(Effect.orDie);
                }
              }),
            listSessions: () => Effect.succeed([]),
            getCapabilities: () => unsupported(),
            getInstanceInfo: () => unsupported(),
            rollbackConversation: () => unsupported(),
            inspectConversation: () => unsupported(),
            readAuthoritativeConversation: () => unsupported(),
            rollbackConversationChecked: () => unsupported(),
            streamEvents: Stream.empty,
          } satisfies ProviderServiceShape);
          const terminals = TerminalManager.TerminalManager.of({
            open: () => unsupported(),
            attachStream: () => unsupported(),
            write: () => unsupported(),
            resize: () => unsupported(),
            clear: () => unsupported(),
            restart: () => unsupported(),
            close: ({ threadId }) => Ref.update(closed, (threadIds) => [...threadIds, threadId]),
            subscribe: () => Effect.succeed(() => {}),
            subscribeMetadata: () => Effect.succeed(() => {}),
          });

          const reactor = yield* makeThreadDeletionReactor({ workerCapacity: 1 }).pipe(
            Effect.provideService(OrchestrationEngineService, engine),
            Effect.provideService(ProviderService, provider),
            Effect.provideService(TerminalManager.TerminalManager, terminals),
          );
          yield* reactor.start();

          yield* Queue.offer(upstream, makeThreadDeletedEvent(1));
          yield* Deferred.await(firstStarted);
          yield* Queue.offer(upstream, makeThreadDeletedEvent(2));
          yield* Queue.offer(upstream, makeThreadDeletedEvent(3));
          yield* Queue.offer(upstream, makeThreadDeletedEvent(4));

          const fifthPublisher = yield* Effect.forkChild(
            Queue.offer(upstream, makeThreadDeletedEvent(5)).pipe(
              Effect.ensuring(Deferred.succeed(fifthPublished, undefined).pipe(Effect.orDie)),
            ),
          );
          yield* Effect.yieldNow;

          expect(yield* Queue.size(upstream)).toBe(1);
          expect(yield* Deferred.isDone(fifthPublished)).toBe(false);
          expect(yield* Ref.get(stopped)).toEqual(["thread-deletion-burst-1"]);

          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Fiber.join(fifthPublisher);
          yield* Deferred.await(allStopped);
          yield* reactor.drain;

          const expected = Array.from(
            { length: 5 },
            (_, index) => `thread-deletion-burst-${index + 1}`,
          );
          expect(yield* Ref.get(stopped)).toEqual(expected);
          expect(yield* Ref.get(closed)).toEqual(expected);
        }),
      ),
    );
  });
});
