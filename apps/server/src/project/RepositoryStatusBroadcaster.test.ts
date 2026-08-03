import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  RepositoryReadError,
  RepositoryStatusPathLimit,
  type RepositoryStatusResult,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as RepositoryReadService from "./RepositoryReadService.ts";
import * as RepositoryStatusBroadcaster from "./RepositoryStatusBroadcaster.ts";

const input = {
  target: { projectId: ProjectId.make("project-a") },
  maxChangedPaths: RepositoryStatusPathLimit.make(10),
};

function status(sequence: number): RepositoryStatusResult {
  return {
    _tag: "Repository",
    head: { _tag: "Detached", commit: `commit-${sequence}` },
    defaultRef: null,
    upstreamRef: null,
    aheadCount: sequence,
    behindCount: 0,
    hasPrimaryRemote: false,
    hasWorkingTreeChanges: false,
    changedPaths: [],
    truncated: false,
  };
}

const makeBroadcaster = (readStatus: RepositoryReadService.RepositoryReadServiceShape["status"]) =>
  RepositoryStatusBroadcaster.make.pipe(
    Effect.provideService(
      RepositoryReadService.RepositoryReadService,
      RepositoryReadService.RepositoryReadService.of({
        status: readStatus,
        listRefs: () => Effect.die("unused"),
        listRemotes: () => Effect.die("unused"),
        getReviewDiff: () => Effect.die("unused"),
      }),
    ),
  );

it.effect("emits a freshly resolved initial snapshot for every subscription", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const broadcaster = yield* makeBroadcaster(() =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(Effect.map(status)),
      );

      const first = yield* broadcaster.streamStatus(input).pipe(Stream.runHead);
      const second = yield* broadcaster.streamStatus(input).pipe(Stream.runHead);

      assert.strictEqual(first._tag, "Some");
      assert.strictEqual(second._tag, "Some");
      if (first._tag === "Some" && second._tag === "Some") {
        assert.strictEqual(first.value.status._tag, "Repository");
        assert.strictEqual(second.value.status._tag, "Repository");
        if (first.value.status._tag === "Repository" && second.value.status._tag === "Repository") {
          assert.strictEqual(first.value.status.aheadCount, 1);
          assert.strictEqual(second.value.status.aheadCount, 2);
        }
      }
      assert.strictEqual(yield* Ref.get(calls), 2);
    }),
  ),
);

it.effect("shares one target poller and releases it after the final subscriber", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const broadcaster = yield* makeBroadcaster(() =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(Effect.map(status)),
      );
      const options = { refreshInterval: Effect.succeed(Duration.seconds(1)) };

      const left = yield* broadcaster
        .streamStatus(input, options)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
      const right = yield* broadcaster
        .streamStatus(input, options)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(calls), 2);

      yield* TestClock.adjust(Duration.seconds(1));
      assert.strictEqual((yield* Fiber.join(left)).length, 2);
      assert.strictEqual((yield* Fiber.join(right)).length, 2);
      assert.strictEqual(yield* Ref.get(calls), 3);

      yield* TestClock.adjust(Duration.seconds(2));
      assert.strictEqual(yield* Ref.get(calls), 3);
    }),
  ),
);

it.effect("publishes every explicit refresh even when snapshots are identical", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const constant = status(1);
      const broadcaster = yield* makeBroadcaster(() =>
        Ref.update(calls, (count) => count + 1).pipe(Effect.as(constant)),
      );
      const eventsFiber = yield* broadcaster
        .streamStatus(input)
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broadcaster.refreshStatus(input);
      yield* broadcaster.refreshStatus(input);

      const events = yield* Fiber.join(eventsFiber);
      assert.strictEqual(events.length, 3);
      assert.strictEqual(yield* Ref.get(calls), 3);
    }),
  ),
);

it.effect("continues polling after a sanitized read failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const broadcaster = yield* makeBroadcaster(() =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 2
              ? Effect.fail(
                  new RepositoryReadError({
                    operation: "status",
                    code: "disconnected",
                    detail: "The repository provider disconnected.",
                    retryable: true,
                  }),
                )
              : Effect.succeed(status(count)),
          ),
        ),
      );
      const eventsFiber = yield* broadcaster
        .streamStatus(input, { refreshInterval: Effect.succeed(Duration.seconds(1)) })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* TestClock.adjust(Duration.seconds(1));
      yield* TestClock.adjust(Duration.seconds(1));

      const events = yield* Fiber.join(eventsFiber);
      assert.strictEqual(events.length, 2);
      assert.strictEqual(yield* Ref.get(calls), 3);
      const final = [...events].at(-1);
      assert.notStrictEqual(final, undefined);
      if (final !== undefined && final.status._tag === "Repository") {
        assert.strictEqual(final.status.aheadCount, 3);
      }
    }),
  ),
);

it.effect("bounds slow subscribers with sliding delivery and retains no snapshot cache", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const broadcaster = yield* makeBroadcaster(() =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(Effect.map(status)),
      );
      const pull = yield* broadcaster.streamStatus(input).pipe(Stream.toPull);
      const initial = yield* pull;
      assert.strictEqual(initial.length, 1);

      for (let index = 0; index < 40; index += 1) {
        yield* broadcaster.refreshStatus(input);
      }

      const retained: Array<number> = [];
      const next = yield* pull;
      for (const event of next) {
        if (event.status._tag === "Repository") retained.push(event.status.aheadCount);
      }
      assert.strictEqual(retained.length, 32);
      assert.strictEqual(retained[0], 10);
      assert.strictEqual(retained[31], 41);

      const fresh = yield* broadcaster.streamStatus(input).pipe(Stream.runHead);
      assert.strictEqual(fresh._tag, "Some");
      if (fresh._tag === "Some" && fresh.value.status._tag === "Repository") {
        assert.strictEqual(fresh.value.status.aheadCount, 42);
      }
    }),
  ),
);
