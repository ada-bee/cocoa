/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.bounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * Maximum number of items retained by a worker before producers are
 * backpressured. The active item is not counted against this capacity.
 */
export const DEFAULT_DRAINABLE_WORKER_CAPACITY = 256;

export interface DrainableWorkerOptions {
  /**
   * Queue capacity. Tests may lower this to exercise overload behavior without
   * changing the lossless, backpressured production strategy.
   */
  readonly capacity?: number;
}

/**
 * Create a drainable worker that processes items from a bounded, lossless
 * queue. Once the queue reaches capacity, `enqueue` waits for the consumer to
 * make room instead of dropping an item or buffering without limit.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options?: DrainableWorkerOptions,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(
      TxQueue.bounded<A>(options?.capacity ?? DEFAULT_DRAINABLE_WORKER_CAPACITY),
      TxQueue.shutdown,
    );
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<void> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap((accepted) =>
          accepted ? TxRef.update(outstanding, (n) => n + 1) : Effect.void,
        ),
        Effect.tx,
        Effect.asVoid,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
