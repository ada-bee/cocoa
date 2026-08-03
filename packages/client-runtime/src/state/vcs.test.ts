import {
  EnvironmentId,
  ProjectId,
  RepositoryRefLimit,
  RepositoryStatusPathLimit,
  WS_METHODS,
  type RepositoryListRefsInput,
  type RepositoryListRefsResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createVcsEnvironmentAtoms, makeCachedVcsRefsChanges } from "./vcs.ts";
import { invalidateVcsRefs, vcsRefsCacheStateAtom } from "./vcsRefInvalidation.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PROJECT_ID = ProjectId.make("project-1");
const REFS_INPUT: RepositoryListRefsInput = {
  target: { projectId: PROJECT_ID },
  scope: "all",
  query: "release",
  maxRefs: RepositoryRefLimit.make(20),
};
const LIVE_REFS: RepositoryListRefsResult = {
  _tag: "Repository",
  refs: [
    {
      kind: "local",
      name: "release",
      target: "commit-1",
      current: true,
      isDefault: true,
    },
  ],
  truncated: false,
};

const CONNECTED_CONNECTION_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function makeSupervisor(
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  client: WsRpcProtocolClient | null,
) {
  return Effect.gen(function* () {
    return EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state,
      session: yield* SubscriptionRef.make(
        client === null ? Option.none<RpcSession>() : Option.some(session(client)),
      ),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  });
}

function cacheStore(overrides: Partial<Persistence.EnvironmentCacheStore["Service"]> = {}) {
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
    ...overrides,
  });
}

describe("repository refs state", () => {
  it("invalidates all target-keyed ref streams in the mutated environment", () => {
    const registry = AtomRegistry.make();
    expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(0);
    invalidateVcsRefs(registry, TARGET);
    expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(1);
    registry.dispose();
  });

  it.effect("forwards the durable target and explicit bounds unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* Ref.make<ReadonlyArray<RepositoryListRefsInput>>([]);
        const client = {
          [WS_METHODS.vcsListRefs]: (input: RepositoryListRefsInput) =>
            Ref.update(requests, (current) => [...current, input]).pipe(Effect.as(LIVE_REFS)),
        } as unknown as WsRpcProtocolClient;
        const supervisor = yield* makeSupervisor(
          yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          client,
        );

        const result = yield* Stream.unwrap(
          makeCachedVcsRefsChanges(REFS_INPUT).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
        ).pipe(Stream.runHead);

        expect(Option.getOrThrow(result)).toEqual(LIVE_REFS);
        expect(yield* Ref.get(requests)).toEqual([REFS_INPUT]);
        expect("cwd" in (yield* Ref.get(requests))[0]!).toBe(false);
      }),
    ),
  );

  it.effect("does not hydrate cwd-keyed persisted refs while disconnected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const loads = yield* Ref.make(0);
        const supervisor = yield* makeSupervisor(
          yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          null,
        );
        const stream = Stream.unwrap(
          makeCachedVcsRefsChanges(REFS_INPUT).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(
              Persistence.EnvironmentCacheStore,
              cacheStore({
                loadVcsRefs: () =>
                  Ref.update(loads, (count) => count + 1).pipe(Effect.as(Option.none())),
              }),
            ),
          ),
        ).pipe(Stream.runDrain);
        const fiber = yield* Effect.forkChild(stream);
        yield* Effect.yieldNow;
        expect(yield* Ref.get(loads)).toBe(0);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("logs and retries a transient read failure without swallowing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const client = {
          [WS_METHODS.vcsListRefs]: () =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.fail(
                      new EnvironmentRpcUnavailableError({
                        environmentId: TARGET.environmentId,
                        message: "temporary failure",
                      }),
                    )
                  : Effect.succeed(LIVE_REFS),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = yield* makeSupervisor(
          yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          client,
        );
        const result = Stream.unwrap(
          makeCachedVcsRefsChanges(REFS_INPUT).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
        ).pipe(Stream.runHead);
        const fiber = yield* Effect.forkChild(result);

        while ((yield* Ref.get(calls)) < 1) yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");

        expect(Option.getOrThrow(yield* Fiber.join(fiber))).toEqual(LIVE_REFS);
        expect(yield* Ref.get(calls)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("cancels an in-flight read when the connection generation changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const interruptions = yield* Ref.make(0);
        const state = yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE);
        const client = {
          [WS_METHODS.vcsListRefs]: () =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.never.pipe(
                      Effect.onInterrupt(() => Ref.update(interruptions, (value) => value + 1)),
                    )
                  : Effect.succeed(LIVE_REFS),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = yield* makeSupervisor(state, client);
        const result = Stream.unwrap(
          makeCachedVcsRefsChanges(REFS_INPUT).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
        ).pipe(Stream.runHead);
        const fiber = yield* Effect.forkChild(result);

        while ((yield* Ref.get(calls)) < 1) yield* Effect.yieldNow;
        yield* SubscriptionRef.set(state, AVAILABLE_CONNECTION_STATE);
        while ((yield* Ref.get(interruptions)) < 1) yield* Effect.yieldNow;
        yield* SubscriptionRef.set(state, { ...CONNECTED_CONNECTION_STATE, generation: 2 });

        expect(Option.getOrThrow(yield* Fiber.join(fiber))).toEqual(LIVE_REFS);
        expect(yield* Ref.get(calls)).toBe(2);
      }),
    ),
  );

  it.effect("refresh status uses target identity without invalidating ref persistence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refreshes = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const clears = yield* Ref.make(0);
        const client = {
          [WS_METHODS.vcsRefreshStatus]: (input: unknown) =>
            Ref.update(refreshes, (current) => [...current, input]).pipe(
              Effect.as({ _tag: "NotRepository" as const }),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = yield* makeSupervisor(
          yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          client,
        );
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_environmentId, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(
              Persistence.EnvironmentCacheStore,
              cacheStore({ clearVcsRefs: () => Ref.update(clears, (count) => count + 1) }),
            ),
          ),
        );
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const atoms = createVcsEnvironmentAtoms(runtime);
        const refreshInput = {
          target: { projectId: PROJECT_ID },
          maxChangedPaths: RepositoryStatusPathLimit.make(1_000),
        };

        const result = yield* Effect.promise(() =>
          atoms.refreshStatus.run(registry, {
            environmentId: TARGET.environmentId,
            input: refreshInput,
          }),
        );

        expect(AsyncResult.isSuccess(result)).toBe(true);
        expect(yield* Ref.get(refreshes)).toEqual([refreshInput]);
        expect(yield* Ref.get(clears)).toBe(0);
      }),
    ),
  );
});
