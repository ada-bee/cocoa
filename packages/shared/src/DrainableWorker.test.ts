import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { makeDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );

  it.live("backpressures a burst at capacity and drains every accepted item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const capacity = 3;
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const capacityFilled = yield* Deferred.make<void>();
        const producerDone = yield* Deferred.make<void>();
        const accepted = yield* Ref.make(0);
        const processed = yield* Ref.make<number[]>([]);

        const worker = yield* makeDrainableWorker(
          (item: number) =>
            Effect.gen(function* () {
              if (item === 0) {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
              yield* Ref.update(processed, (items) => [...items, item]);
            }),
          { capacity },
        );

        yield* worker.enqueue(0);
        yield* Deferred.await(firstStarted);

        const producer = yield* Effect.forkChild(
          Effect.forEach(
            Array.from({ length: 20 }, (_, index) => index + 1),
            (item) =>
              worker
                .enqueue(item)
                .pipe(
                  Effect.andThen(
                    Ref.updateAndGet(accepted, (count) => count + 1).pipe(
                      Effect.tap((count) =>
                        count === capacity
                          ? Deferred.succeed(capacityFilled, undefined).pipe(Effect.orDie)
                          : Effect.void,
                      ),
                    ),
                  ),
                ),
          ).pipe(Effect.ensuring(Deferred.succeed(producerDone, undefined).pipe(Effect.orDie))),
        );

        yield* Deferred.await(capacityFilled);
        yield* Effect.yieldNow;

        expect(yield* Ref.get(accepted)).toBe(capacity);
        expect(yield* Deferred.isDone(producerDone)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(producer);
        yield* worker.drain;

        expect(yield* Ref.get(processed)).toEqual(Array.from({ length: 21 }, (_, index) => index));
      }),
    ),
  );
});
