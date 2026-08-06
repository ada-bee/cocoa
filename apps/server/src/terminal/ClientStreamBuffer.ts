import {
  type TerminalSubscriptionKind,
  TerminalSubscriptionOverflowError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { DEFAULT_RUNTIME_BUFFER_LIMITS } from "../RuntimeBufferLimits.ts";

export interface TerminalClientStreamOptions<A, E, R> {
  readonly subscription: TerminalSubscriptionKind;
  readonly register: (
    listener: (event: A) => Effect.Effect<void>,
  ) => Effect.Effect<() => void, E, R>;
  readonly capacity?: number;
}

/**
 * Isolates a callback-based terminal subscription behind a bounded, non-blocking
 * client queue. On the first refused offer the queue stops accepting events,
 * drains events that were already admitted in FIFO order, and then fails with a
 * typed reset-required error. Provider ingestion never waits for a slow client.
 */
export function makeTerminalClientStream<A, E, R>(
  options: TerminalClientStreamOptions<A, E, R>,
): Stream.Stream<A, E | TerminalSubscriptionOverflowError, Exclude<R, Scope.Scope>> {
  const overflowError = new TerminalSubscriptionOverflowError({
    subscription: options.subscription,
    code: "reset_required",
    retryable: true,
  });

  return Stream.callback<A, E | TerminalSubscriptionOverflowError, R>(
    (queue) =>
      Effect.acquireRelease(
        options.register((event) =>
          Queue.offer(queue, event).pipe(
            Effect.flatMap((accepted) =>
              accepted ? Effect.void : Queue.fail(queue, overflowError).pipe(Effect.asVoid),
            ),
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    {
      bufferSize: options.capacity ?? DEFAULT_RUNTIME_BUFFER_LIMITS.terminalClientEvents,
      strategy: "dropping",
    },
  );
}
