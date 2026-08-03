import { CommandId, EventId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const CHECKPOINT_UNSUPPORTED_DETAIL =
  "Checkpoint revert is unavailable until the bound provider supplies checkpoint operations.";

type RevertRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.checkpoint-revert-requested" }
>;

/**
 * Checkpoint side effects are intentionally fail-closed for remote workspaces.
 * Until the provider contract owns capture/diff/revert, this reactor must not
 * interpret a provider workspace path on the gateway host.
 */
const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const appendUnsupportedRevertActivity = Effect.fn(
    "CheckpointReactor.appendUnsupportedRevertActivity",
  )(function* (event: RevertRequestedEvent) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const commandId = CommandId.make(
      `server:checkpoint-revert-unsupported:${yield* crypto.randomUUIDv4}`,
    );
    const activityId = EventId.make(yield* crypto.randomUUIDv4);

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId,
      threadId: event.payload.threadId,
      activity: {
        id: activityId,
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert unavailable",
        payload: {
          turnCount: event.payload.turnCount,
          detail: CHECKPOINT_UNSUPPORTED_DETAIL,
        },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });

  const processEventSafely = (event: RevertRequestedEvent) =>
    appendUnsupportedRevertActivity(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("checkpoint reactor failed to report unsupported revert", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.checkpoint-revert-requested" ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
