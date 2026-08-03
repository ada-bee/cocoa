/** Target-keyed status snapshots for public provider repository reads. */
import {
  type RepositoryReadError,
  type RepositoryStatusInput,
  type RepositoryStatusResult,
  type RepositoryStatusStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as RepositoryReadService from "./RepositoryReadService.ts";

const DEFAULT_REPOSITORY_STATUS_REFRESH_INTERVAL = Duration.seconds(30);

export function repositoryStatusKey(input: RepositoryStatusInput): string {
  return `${input.target.projectId}\0${input.target.threadId ?? ""}\0${input.maxChangedPaths}`;
}

interface RepositoryStatusChange {
  readonly key: string;
  readonly status: RepositoryStatusResult;
}

interface ActivePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
}

export interface RepositoryStatusStreamOptions {
  readonly refreshInterval?: Effect.Effect<Duration.Duration, never>;
}

export interface RepositoryStatusBroadcasterShape {
  readonly refreshStatus: (
    input: RepositoryStatusInput,
  ) => Effect.Effect<RepositoryStatusResult, RepositoryReadError>;
  readonly streamStatus: (
    input: RepositoryStatusInput,
    options?: RepositoryStatusStreamOptions,
  ) => Stream.Stream<RepositoryStatusStreamEvent, RepositoryReadError>;
}

export class RepositoryStatusBroadcaster extends Context.Service<
  RepositoryStatusBroadcaster,
  RepositoryStatusBroadcasterShape
>()("t3/project/RepositoryStatusBroadcaster") {}

export const make = Effect.gen(function* () {
  const reads = yield* RepositoryReadService.RepositoryReadService;
  const changes = yield* Effect.acquireRelease(
    PubSub.sliding<RepositoryStatusChange>(32),
    PubSub.shutdown,
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const pollers = yield* SynchronizedRef.make(new Map<string, ActivePoller>());

  const update = Effect.fn("RepositoryStatusBroadcaster.update")(function* (
    input: RepositoryStatusInput,
    status: RepositoryStatusResult,
    publish: boolean,
  ) {
    if (publish) {
      yield* PubSub.publish(changes, { key: repositoryStatusKey(input), status });
    }
    return status;
  });

  const refreshStatus: RepositoryStatusBroadcasterShape["refreshStatus"] = Effect.fn(
    "RepositoryStatusBroadcaster.refreshStatus",
  )(function* (input) {
    const status = yield* reads.status(input);
    return yield* update(input, status, true);
  });

  const makePoller = (
    input: RepositoryStatusInput,
    refreshInterval: Effect.Effect<Duration.Duration, never>,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const configured = yield* refreshInterval;
      yield* Effect.sleep(
        Duration.isZero(configured) ? DEFAULT_REPOSITORY_STATUS_REFRESH_INTERVAL : configured,
      );
      yield* refreshStatus(input).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Provider repository status refresh failed", {
            operation: error.operation,
            code: error.code,
            retryable: error.retryable,
          }),
        ),
      );
    }).pipe(Effect.forever);

  const retainPoller = Effect.fn("RepositoryStatusBroadcaster.retainPoller")(function* (
    input: RepositoryStatusInput,
    refreshInterval: Effect.Effect<Duration.Duration, never>,
  ) {
    const key = repositoryStatusKey(input);
    yield* SynchronizedRef.modifyEffect(pollers, (current) => {
      const existing = current.get(key);
      if (existing !== undefined) {
        const next = new Map(current);
        next.set(key, { ...existing, subscriberCount: existing.subscriberCount + 1 });
        return Effect.succeed([undefined, next] as const);
      }
      return makePoller(input, refreshInterval).pipe(
        Effect.forkIn(broadcasterScope),
        Effect.map((fiber) => {
          const next = new Map(current);
          next.set(key, { fiber, subscriberCount: 1 });
          return [undefined, next] as const;
        }),
      );
    });
  });

  const releasePoller = Effect.fn("RepositoryStatusBroadcaster.releasePoller")(function* (
    input: RepositoryStatusInput,
  ) {
    const key = repositoryStatusKey(input);
    const fiber = yield* SynchronizedRef.modify(pollers, (current) => {
      const existing = current.get(key);
      if (existing === undefined) return [null, current] as const;
      const next = new Map(current);
      if (existing.subscriberCount > 1) {
        next.set(key, { ...existing, subscriberCount: existing.subscriberCount - 1 });
        return [null, next] as const;
      }
      next.delete(key);
      return [existing.fiber, next] as const;
    });
    if (fiber !== null) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
  });

  const streamStatus: RepositoryStatusBroadcasterShape["streamStatus"] = (input, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const key = repositoryStatusKey(input);
        const subscription = yield* PubSub.subscribe(changes);
        // Always re-resolve on subscription. A cache entry can belong to an
        // invalidated endpoint generation and must never seed a new stream.
        const initial = yield* reads.status(input);
        yield* update(input, initial, false);
        yield* retainPoller(
          input,
          options?.refreshInterval ?? Effect.succeed(DEFAULT_REPOSITORY_STATUS_REFRESH_INTERVAL),
        );
        return Stream.concat(
          Stream.make({ _tag: "snapshot" as const, status: initial }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.key === key),
            Stream.map(
              (change): RepositoryStatusStreamEvent => ({
                _tag: "snapshot",
                status: change.status,
              }),
            ),
          ),
        ).pipe(Stream.ensuring(releasePoller(input).pipe(Effect.ignore, Effect.asVoid)));
      }),
    );

  return RepositoryStatusBroadcaster.of({ refreshStatus, streamStatus });
});

export const layer = Layer.effect(RepositoryStatusBroadcaster, make);
