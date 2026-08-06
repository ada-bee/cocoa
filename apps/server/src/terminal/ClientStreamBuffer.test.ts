import { describe, expect, it } from "@effect/vitest";
import { TerminalSubscriptionOverflowError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { makeTerminalClientStream } from "./ClientStreamBuffer.ts";

describe("makeTerminalClientStream", () => {
  it.effect(
    "drains admitted events in order and then fails a slow client with reset-required",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registered = yield* Deferred.make<(event: string) => Effect.Effect<void>>();
          const releaseConsumer = yield* Deferred.make<void>();
          const received = yield* Ref.make<ReadonlyArray<string>>([]);
          let unsubscribeCount = 0;

          const stream = makeTerminalClientStream<string, never, never>({
            subscription: "attach",
            capacity: 2,
            register: (listener) =>
              Deferred.succeed(registered, listener).pipe(
                Effect.as(() => {
                  unsubscribeCount += 1;
                }),
              ),
          });
          const consumer = yield* stream.pipe(
            Stream.runForEach((event) =>
              Deferred.await(releaseConsumer).pipe(
                Effect.andThen(Ref.update(received, (events) => [...events, event])),
              ),
            ),
            Effect.exit,
            Effect.forkChild,
          );
          const publish = yield* Deferred.await(registered);

          yield* publish("output-1");
          yield* publish("output-2");
          yield* publish("cleared-control");
          yield* Deferred.succeed(releaseConsumer, undefined);

          const exit = yield* Fiber.join(consumer);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
            expect(failure?._tag === "Fail" ? failure.error : null).toEqual(
              new TerminalSubscriptionOverflowError({
                subscription: "attach",
                code: "reset_required",
                retryable: true,
              }),
            );
          }
          expect(yield* Ref.get(received)).toEqual(["output-1", "output-2"]);
          expect(unsubscribeCount).toBe(1);
        }),
      ),
  );

  it.effect("allows a fresh snapshot subscription after an overloaded tail disconnects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registered = yield* Deferred.make<(event: string) => Effect.Effect<void>>();
        const releaseConsumer = yield* Deferred.make<void>();
        const overloaded = makeTerminalClientStream<string, never, never>({
          subscription: "metadata",
          capacity: 1,
          register: (listener) =>
            Deferred.succeed(registered, listener).pipe(Effect.as(() => undefined)),
        });
        const overloadedConsumer = yield* overloaded.pipe(
          Stream.runForEach(() => Deferred.await(releaseConsumer)),
          Effect.exit,
          Effect.forkChild,
        );
        const publish = yield* Deferred.await(registered);
        yield* publish("snapshot-1");
        yield* publish("upsert-1");
        yield* publish("upsert-2");
        yield* Deferred.succeed(releaseConsumer, undefined);
        expect(Exit.isFailure(yield* Fiber.join(overloadedConsumer))).toBe(true);

        const subscribe = (snapshot: string) =>
          makeTerminalClientStream<string, never, never>({
            subscription: "metadata",
            capacity: 1,
            register: (listener) => listener(snapshot).pipe(Effect.as(() => undefined)),
          });

        const recovered = yield* subscribe("snapshot-2").pipe(Stream.take(1), Stream.runCollect);

        expect(Array.from(recovered)).toEqual(["snapshot-2"]);
      }),
    ),
  );
});
