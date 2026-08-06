import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type CodexEndpointTransport, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";

import * as CodexEndpointConnection from "./CodexEndpointConnection.ts";
import type { CodexEndpointRouter } from "./CodexEndpointRouter.ts";
import {
  CodexEndpointInvalidCredentialError,
  CodexEndpointWebSocketOpenError,
} from "./DirectWebSocketConnector.ts";
import {
  calculateCodexEndpointRetryDelay,
  classifyCodexEndpointSupervisorError,
  make,
  type CodexEndpointSupervisor,
  type CodexEndpointSupervisorDependencies,
  type CodexEndpointSupervisorState,
  type StartCodexEndpointSupervisorOptions,
} from "./CodexEndpointSupervisor.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const THREAD_ID = ThreadId.make("thread_remote");
const TRANSPORT = {
  type: "direct-websocket",
  url: "ws://127.0.0.1:7777",
  authentication: { type: "none" },
} as const satisfies CodexEndpointTransport;
const ROUTER = {
  registerSession: () => Effect.die("unused"),
  registerInternalOperation: () => Effect.die("unused"),
} as CodexEndpointRouter;

const transientOpenError = (label: string) =>
  new CodexEndpointWebSocketOpenError({
    url: TRANSPORT.url,
    cause: new Error(label),
  });

const terminationError = (label: string) =>
  new CodexEndpointConnection.CodexEndpointTerminationError({
    providerInstanceId: INSTANCE_ID,
    cause: new CodexErrors.CodexAppServerTransportError({
      operation: "read-input-stream",
      cause: new Error(label),
    }),
  });

const makeConnection = (
  generation: number,
  awaitTermination: CodexEndpointConnection.CodexEndpointConnection["Service"]["awaitTermination"] = Effect.never,
) =>
  CodexEndpointConnection.CodexEndpointConnection.of({
    identity: { providerInstanceId: INSTANCE_ID },
    client: {
      generation,
    } as unknown as CodexEndpointConnection.CodexEndpointConnection["Service"]["client"],
    compatibility: {
      userAgent: `codex_cli_rs/0.${generation}.0`,
      serverVersion: `0.${generation}.0`,
      codexHome: `/remote/${generation}/.codex`,
      platformFamily: "unix",
      platformOs: "linux",
    },
    awaitTermination,
  });

const makeTerminationConnection = Effect.fn("test.makeTerminationConnection")(function* (
  generation: number,
) {
  const terminated = yield* Deferred.make<CodexEndpointConnection.CodexEndpointTerminationError>();
  return {
    connection: makeConnection(
      generation,
      Deferred.await(terminated).pipe(Effect.flatMap(Effect.fail)),
    ),
    terminate: (label = `generation-${generation}-terminated`) =>
      Deferred.succeed(terminated, terminationError(label)),
  };
});

interface SleepRequest {
  readonly delay: Duration.Duration;
  readonly release: Deferred.Deferred<void>;
}

const makeGatedSleep = Effect.fn("test.makeGatedSleep")(function* () {
  const requests = yield* Queue.unbounded<SleepRequest>();
  const sleep = (delay: Duration.Duration) =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      yield* Queue.offer(requests, { delay, release });
      yield* Deferred.await(release);
    });
  return { requests, sleep };
});

const constantRetryDelay =
  (milliseconds = 1_000) =>
  () =>
    Effect.succeed(Duration.millis(milliseconds));

const makeSupervisor = (
  dependencies: Partial<CodexEndpointSupervisorDependencies>,
  scope?: Scope.Scope,
) =>
  make({
    providerInstanceId: INSTANCE_ID,
    transport: TRANSPORT,
    dependencies,
  }).pipe(scope ? Effect.provideService(Scope.Scope, scope) : (effect) => effect);

const noopInvalidation = () => Effect.void;

const awaitState = Effect.fn("test.awaitSupervisorState")(function* (
  supervisor: CodexEndpointSupervisor,
  predicate: (state: CodexEndpointSupervisorState) => boolean,
) {
  const subscription = yield* supervisor.subscribeChanges;
  const current = yield* supervisor.getState;
  if (predicate(current)) return current;
  const matched = yield* Stream.fromSubscription(subscription).pipe(
    Stream.filter(predicate),
    Stream.runHead,
  );
  return Option.getOrThrow(matched);
});

const startAndAwaitState = Effect.fn("test.startAndAwaitSupervisorState")(function* (
  supervisor: CodexEndpointSupervisor,
  options: StartCodexEndpointSupervisorOptions,
  predicate: (state: CodexEndpointSupervisorState) => boolean,
) {
  yield* supervisor.start(options);
  return yield* awaitState(supervisor, predicate);
});

it.layer(NodeServices.layer)("CodexEndpointSupervisor", (it) => {
  it.effect("returns in Connecting while a first connector attempt never settles", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make("sequential");
      const acquisitionStarted = yield* Deferred.make<void>();
      const acquisitionInterrupted = yield* Deferred.make<void>();
      const supervisor = yield* makeSupervisor(
        {
          makeEndpoint: (() =>
            Deferred.succeed(acquisitionStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(acquisitionInterrupted, undefined).pipe(Effect.asVoid),
              ),
            )) as CodexEndpointSupervisorDependencies["makeEndpoint"],
        },
        owner,
      );

      yield* supervisor.start({ onGenerationInvalidated: noopInvalidation });
      assert.deepStrictEqual(yield* supervisor.getState, { _tag: "Connecting", attempt: 1 });

      yield* Deferred.await(acquisitionStarted);
      assert.deepStrictEqual(yield* supervisor.getState, { _tag: "Connecting", attempt: 1 });

      yield* Scope.close(owner, Exit.void);
      yield* Deferred.await(acquisitionInterrupted);
      assert.deepStrictEqual(yield* supervisor.getState, { _tag: "Closed" });
    }),
  );

  it.effect("installs and borrows one successful initial immutable generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = makeConnection(1);
        let factoryCalls = 0;
        let routerClient: unknown;
        const supervisor = yield* makeSupervisor({
          makeEndpoint: (() => {
            factoryCalls += 1;
            return Effect.succeed(connection);
          }) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: ((client: unknown) => {
            routerClient = client;
            return Effect.succeed(ROUTER);
          }) as CodexEndpointSupervisorDependencies["makeRouter"],
        });

        const state = yield* startAndAwaitState(
          supervisor,
          { onGenerationInvalidated: noopInvalidation },
          (state) => state._tag === "Ready",
        );
        assert.equal(state._tag, "Ready");
        assert.equal(factoryCalls, 1);
        assert.equal(routerClient, connection.client);

        const borrow = yield* supervisor.borrow(THREAD_ID);
        assert.equal(borrow.generationId, 1);
        assert.equal(borrow.connection, connection);
        assert.equal(borrow.router, ROUTER);
        yield* borrow.ensureCurrent;

        const connectionBorrow = yield* supervisor.borrowConnection;
        assert.equal(connectionBorrow.generationId, 1);
        assert.equal(connectionBorrow.connection, connection);
        yield* connectionBorrow.ensureCurrent;

        const routedBorrow = yield* supervisor.borrowRoutedConnection;
        assert.equal(routedBorrow.generationId, 1);
        assert.equal(routedBorrow.connection, connection);
        assert.equal(routedBorrow.router, ROUTER);
        yield* routedBorrow.ensureCurrent;
      }),
    ),
  );

  it.effect("commits a Ready generation before publishing its transition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = makeConnection(1);
        const supervisor = yield* makeSupervisor({
          makeEndpoint: (() =>
            Effect.succeed(connection)) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: (() =>
            Effect.succeed(ROUTER)) as CodexEndpointSupervisorDependencies["makeRouter"],
        });
        const changes = yield* supervisor.subscribeChanges;
        const observed = yield* Deferred.make<{
          readonly current: CodexEndpointSupervisorState;
          readonly borrowAvailable: boolean;
          readonly generationId: number | null;
        }>();
        yield* Stream.fromSubscription(changes).pipe(
          Stream.runForEach((transition) =>
            transition._tag === "Ready"
              ? Effect.gen(function* () {
                  const current = yield* supervisor.getState;
                  const borrowResult = yield* supervisor.borrow(THREAD_ID).pipe(Effect.result);
                  yield* Deferred.succeed(observed, {
                    current,
                    borrowAvailable: borrowResult._tag === "Success",
                    generationId:
                      borrowResult._tag === "Success" ? borrowResult.success.generationId : null,
                  });
                })
              : Effect.void,
          ),
          Effect.forkScoped,
        );

        yield* supervisor.start({ onGenerationInvalidated: noopInvalidation });
        const value = yield* Deferred.await(observed);
        assert.equal(value.current._tag, "Ready");
        assert.isTrue(value.borrowAvailable);
        assert.equal(value.generationId, 1);
      }),
    ),
  );

  it.effect("keeps an initial transient failure live and recovers through a gated retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gated = yield* makeGatedSleep();
        const connection = makeConnection(2);
        let calls = 0;
        const supervisor = yield* makeSupervisor({
          makeEndpoint: (() => {
            calls += 1;
            return calls === 1
              ? Effect.fail(transientOpenError("initial-offline"))
              : Effect.succeed(connection);
          }) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: (() =>
            Effect.succeed(ROUTER)) as CodexEndpointSupervisorDependencies["makeRouter"],
          retryDelay: constantRetryDelay(),
          sleep: gated.sleep,
        });

        yield* startAndAwaitState(
          supervisor,
          { onGenerationInvalidated: noopInvalidation },
          (state) => state._tag === "Retrying",
        );
        assert.equal((yield* supervisor.getState)._tag, "Retrying");
        assert.equal((yield* supervisor.borrow(THREAD_ID).pipe(Effect.result))._tag, "Failure");
        const connectionBorrow = yield* supervisor.borrowConnection.pipe(Effect.result);
        assert.equal(connectionBorrow._tag, "Failure");
        if (connectionBorrow._tag === "Failure") {
          assert.equal(connectionBorrow.failure._tag, "CodexEndpointBorrowUnavailableError");
          assert.equal(connectionBorrow.failure.providerInstanceId, INSTANCE_ID);
          assert.isFalse("threadId" in connectionBorrow.failure);
        }

        const ready = yield* awaitState(supervisor, (state) => state._tag === "Ready").pipe(
          Effect.forkChild,
        );
        const request = yield* Queue.take(gated.requests);
        assert.equal(Duration.toMillis(request.delay), 1_000);
        yield* Deferred.succeed(request.release, undefined);
        assert.equal((yield* Fiber.join(ready))._tag, "Ready");
        assert.equal(calls, 2);
      }),
    ),
  );

  it.effect("blocks an initial permanent failure without scheduling a retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let sleepCalls = 0;
        let factoryCalls = 0;
        const permanent = new CodexEndpointInvalidCredentialError({
          path: "/run/secrets/codex-signing-key",
          reason: "too-short",
        });
        const supervisor = yield* makeSupervisor({
          makeEndpoint: (() => {
            factoryCalls += 1;
            return Effect.fail(permanent);
          }) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          sleep: () => Effect.sync(() => void (sleepCalls += 1)),
        });

        const state = yield* startAndAwaitState(
          supervisor,
          { onGenerationInvalidated: noopInvalidation },
          (state) => state._tag === "Blocked",
        );
        assert.equal(state._tag, "Blocked");
        assert.equal(factoryCalls, 1);
        assert.equal(sleepCalls, 0);
        assert.equal((yield* supervisor.borrow(THREAD_ID).pipe(Effect.result))._tag, "Failure");
      }),
    ),
  );

  it("calculates bounded exponential jitter without version-dependent policy", () => {
    assert.equal(Duration.toMillis(calculateCodexEndpointRetryDelay(0, 0)), 800);
    assert.equal(Duration.toMillis(calculateCodexEndpointRetryDelay(0, 0.5)), 1_000);
    assert.equal(Duration.toMillis(calculateCodexEndpointRetryDelay(1, 1)), 2_400);
    assert.equal(Duration.toMillis(calculateCodexEndpointRetryDelay(100, 1)), 30_000);

    const incompatible = new CodexEndpointConnection.CodexEndpointInitializationError({
      providerInstanceId: INSTANCE_ID,
      cause: CodexErrors.CodexAppServerRequestError.invalidParams("bad initialize"),
    });
    const overloaded = new CodexEndpointConnection.CodexEndpointInitializationError({
      providerInstanceId: INSTANCE_ID,
      cause: CodexErrors.CodexAppServerRequestError.overloaded(),
    });
    const missingRequiredMethod = new CodexEndpointConnection.CodexEndpointCompatibilityError({
      providerInstanceId: INSTANCE_ID,
      method: "thread/start",
      reason: "missing",
    });
    assert.equal(classifyCodexEndpointSupervisorError(incompatible), "permanent");
    assert.equal(classifyCodexEndpointSupervisorError(missingRequiredMethod), "permanent");
    assert.equal(classifyCodexEndpointSupervisorError(overloaded), "transient");
  });

  it.effect("invalidates a terminated exact generation once and closes its scope once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gated = yield* makeGatedSleep();
        const first = yield* makeTerminationConnection(1);
        const invalidated = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        let invalidationCalls = 0;
        let releases = 0;
        const supervisor = yield* makeSupervisor({
          makeEndpoint: (() =>
            Effect.addFinalizer(() =>
              Effect.sync(() => void (releases += 1)).pipe(
                Effect.andThen(Deferred.succeed(released, undefined)),
                Effect.asVoid,
              ),
            ).pipe(
              Effect.as(first.connection),
            )) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: (() =>
            Effect.succeed(ROUTER)) as CodexEndpointSupervisorDependencies["makeRouter"],
          retryDelay: constantRetryDelay(),
          sleep: gated.sleep,
        });
        yield* startAndAwaitState(
          supervisor,
          {
            onGenerationInvalidated: () =>
              Effect.sync(() => void (invalidationCalls += 1)).pipe(
                Effect.andThen(Deferred.succeed(invalidated, undefined)),
                Effect.asVoid,
              ),
          },
          (state) => state._tag === "Ready",
        );

        assert.isTrue(yield* first.terminate());
        assert.isFalse(yield* first.terminate("duplicate"));
        yield* Deferred.await(invalidated);
        yield* Deferred.await(released);
        assert.equal(invalidationCalls, 1);
        assert.equal(releases, 1);
        assert.equal((yield* supervisor.getState)._tag, "Retrying");
      }),
    ),
  );

  it.effect("rejects borrows during reconnect and serves only the recovered generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gated = yield* makeGatedSleep();
        const first = yield* makeTerminationConnection(1);
        const second = makeConnection(2);
        let calls = 0;
        const supervisor = yield* makeSupervisor({
          makeEndpoint: (() => {
            calls += 1;
            return Effect.succeed(calls === 1 ? first.connection : second);
          }) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: (() =>
            Effect.succeed(ROUTER)) as CodexEndpointSupervisorDependencies["makeRouter"],
          retryDelay: constantRetryDelay(),
          sleep: gated.sleep,
        });
        yield* startAndAwaitState(
          supervisor,
          { onGenerationInvalidated: noopInvalidation },
          (state) => state._tag === "Ready",
        );
        const oldBorrow = yield* supervisor.borrow(THREAD_ID);
        const oldConnectionBorrow = yield* supervisor.borrowConnection;
        const oldRoutedBorrow = yield* supervisor.borrowRoutedConnection;

        yield* first.terminate();
        const request = yield* Queue.take(gated.requests);
        assert.equal((yield* supervisor.borrow(THREAD_ID).pipe(Effect.result))._tag, "Failure");
        assert.equal((yield* supervisor.borrowConnection.pipe(Effect.result))._tag, "Failure");
        assert.equal(
          (yield* supervisor.borrowRoutedConnection.pipe(Effect.result))._tag,
          "Failure",
        );
        const ready = yield* awaitState(supervisor, (state) => state._tag === "Ready").pipe(
          Effect.forkChild,
        );
        yield* Deferred.succeed(request.release, undefined);
        yield* Fiber.join(ready);

        const nextBorrow = yield* supervisor.borrow(THREAD_ID);
        assert.equal(nextBorrow.generationId, 2);
        assert.equal(nextBorrow.connection, second);
        assert.equal((yield* oldBorrow.ensureCurrent.pipe(Effect.result))._tag, "Failure");
        const nextConnectionBorrow = yield* supervisor.borrowConnection;
        assert.equal(nextConnectionBorrow.generationId, 2);
        assert.equal(nextConnectionBorrow.connection, second);
        const nextRoutedBorrow = yield* supervisor.borrowRoutedConnection;
        assert.equal(nextRoutedBorrow.generationId, 2);
        assert.equal(nextRoutedBorrow.connection, second);
        assert.equal(nextRoutedBorrow.router, ROUTER);
        const staleConnectionBorrow = yield* oldConnectionBorrow.ensureCurrent.pipe(Effect.result);
        assert.equal(staleConnectionBorrow._tag, "Failure");
        if (staleConnectionBorrow._tag === "Failure") {
          assert.equal(staleConnectionBorrow.failure.providerInstanceId, INSTANCE_ID);
          assert.isFalse("threadId" in staleConnectionBorrow.failure);
        }
        const staleRoutedBorrow = yield* oldRoutedBorrow.ensureCurrent.pipe(Effect.result);
        assert.equal(staleRoutedBorrow._tag, "Failure");
        if (staleRoutedBorrow._tag === "Failure") {
          assert.equal(staleRoutedBorrow.failure.providerInstanceId, INSTANCE_ID);
          assert.isFalse("threadId" in staleRoutedBorrow.failure);
        }
      }),
    ),
  );

  it.effect("isolates invalidation callback defects and still reconnects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gated = yield* makeGatedSleep();
        const first = yield* makeTerminationConnection(1);
        const second = makeConnection(2);
        let calls = 0;
        const supervisor = yield* makeSupervisor({
          makeEndpoint: (() => {
            calls += 1;
            return Effect.succeed(calls === 1 ? first.connection : second);
          }) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: (() =>
            Effect.succeed(ROUTER)) as CodexEndpointSupervisorDependencies["makeRouter"],
          retryDelay: constantRetryDelay(),
          sleep: gated.sleep,
        });
        yield* startAndAwaitState(
          supervisor,
          { onGenerationInvalidated: () => Effect.die("callback-defect") },
          (state) => state._tag === "Ready",
        );
        yield* first.terminate();
        const request = yield* Queue.take(gated.requests);
        const ready = yield* awaitState(supervisor, (state) => state._tag === "Ready").pipe(
          Effect.forkChild,
        );
        yield* Deferred.succeed(request.release, undefined);
        yield* Fiber.join(ready);

        assert.equal(calls, 2);
        assert.equal((yield* supervisor.getState)._tag, "Ready");
        assert.equal((yield* supervisor.borrow(THREAD_ID)).connection, second);
      }),
    ),
  );

  it.effect("does not mutate or replay a borrow when a later generation becomes ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gated = yield* makeGatedSleep();
        const first = yield* makeTerminationConnection(1);
        const second = makeConnection(2);
        const firstRouter = { ...ROUTER } as CodexEndpointRouter;
        const secondRouter = { ...ROUTER } as CodexEndpointRouter;
        let calls = 0;
        const supervisor = yield* makeSupervisor({
          makeEndpoint: (() => {
            calls += 1;
            return Effect.succeed(calls === 1 ? first.connection : second);
          }) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: ((client: unknown) =>
            Effect.succeed(
              client === first.connection.client ? firstRouter : secondRouter,
            )) as CodexEndpointSupervisorDependencies["makeRouter"],
          retryDelay: constantRetryDelay(),
          sleep: gated.sleep,
        });
        yield* startAndAwaitState(
          supervisor,
          { onGenerationInvalidated: noopInvalidation },
          (state) => state._tag === "Ready",
        );
        const captured = yield* supervisor.borrow(THREAD_ID);
        yield* first.terminate();
        const request = yield* Queue.take(gated.requests);
        const ready = yield* awaitState(supervisor, (state) => state._tag === "Ready").pipe(
          Effect.forkChild,
        );
        yield* Deferred.succeed(request.release, undefined);
        yield* Fiber.join(ready);

        assert.equal(captured.connection, first.connection);
        assert.equal(captured.router, firstRouter);
        const current = yield* supervisor.borrow(THREAD_ID);
        assert.equal(current.connection, second);
        assert.equal(current.router, secondRouter);
      }),
    ),
  );

  it.effect("closes every failed candidate scope before a later retry succeeds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gated = yield* makeGatedSleep();
        let calls = 0;
        let releases = 0;
        const supervisor = yield* makeSupervisor({
          makeEndpoint: (() =>
            Effect.gen(function* () {
              calls += 1;
              yield* Effect.addFinalizer(() => Effect.sync(() => void (releases += 1)));
              if (calls < 3) return yield* transientOpenError(`failure-${calls}`);
              return makeConnection(3);
            })) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: (() =>
            Effect.succeed(ROUTER)) as CodexEndpointSupervisorDependencies["makeRouter"],
          retryDelay: constantRetryDelay(),
          sleep: gated.sleep,
        });
        yield* startAndAwaitState(
          supervisor,
          { onGenerationInvalidated: noopInvalidation },
          (state) => state._tag === "Retrying",
        );
        assert.equal(releases, 1);

        const firstRetry = yield* Queue.take(gated.requests);
        yield* Deferred.succeed(firstRetry.release, undefined);
        const secondRetry = yield* Queue.take(gated.requests);
        assert.equal(releases, 2);
        const ready = yield* awaitState(supervisor, (state) => state._tag === "Ready").pipe(
          Effect.forkChild,
        );
        yield* Deferred.succeed(secondRetry.release, undefined);
        yield* Fiber.join(ready);
        assert.equal(calls, 3);
        assert.equal(releases, 2);
      }),
    ),
  );

  it.effect("interrupts a pending backoff when its owner scope closes", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make("sequential");
      const gated = yield* makeGatedSleep();
      const sleepInterrupted = yield* Deferred.make<void>();
      let calls = 0;
      const supervisor = yield* makeSupervisor(
        {
          makeEndpoint: (() => {
            calls += 1;
            return Effect.fail(transientOpenError("offline"));
          }) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          retryDelay: constantRetryDelay(),
          sleep: (delay) =>
            gated
              .sleep(delay)
              .pipe(
                Effect.onInterrupt(() =>
                  Deferred.succeed(sleepInterrupted, undefined).pipe(Effect.asVoid),
                ),
              ),
        },
        owner,
      );
      yield* startAndAwaitState(
        supervisor,
        { onGenerationInvalidated: noopInvalidation },
        (state) => state._tag === "Retrying",
      );
      yield* Queue.take(gated.requests);
      yield* Scope.close(owner, Exit.void);
      yield* Deferred.await(sleepInterrupted);
      assert.equal(calls, 1);
      assert.equal((yield* supervisor.getState)._tag, "Closed");
    }),
  );

  it.effect("closes an interrupted acquisition candidate and prevents a late install", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make("sequential");
      const acquisitionStarted = yield* Deferred.make<void>();
      const releaseAcquisition = yield* Deferred.make<void>();
      const candidateClosed = yield* Deferred.make<void>();
      const supervisor = yield* makeSupervisor(
        {
          makeEndpoint: (() =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(candidateClosed, undefined).pipe(Effect.asVoid),
              );
              yield* Deferred.succeed(acquisitionStarted, undefined);
              yield* Deferred.await(releaseAcquisition);
              return makeConnection(1);
            })) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: (() =>
            Effect.succeed(ROUTER)) as CodexEndpointSupervisorDependencies["makeRouter"],
        },
        owner,
      );
      yield* supervisor.start({ onGenerationInvalidated: noopInvalidation });
      yield* Deferred.await(acquisitionStarted);
      yield* Scope.close(owner, Exit.void);
      yield* Deferred.await(candidateClosed);
      yield* Deferred.succeed(releaseAcquisition, undefined);
      assert.equal((yield* supervisor.getState)._tag, "Closed");
      assert.equal((yield* supervisor.borrow(THREAD_ID).pipe(Effect.result))._tag, "Failure");
    }),
  );

  it.effect("closes the current generation exactly once when its owner scope closes", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make("sequential");
      let releases = 0;
      let invalidations = 0;
      const supervisor = yield* makeSupervisor(
        {
          makeEndpoint: (() =>
            Effect.addFinalizer(() => Effect.sync(() => void (releases += 1))).pipe(
              Effect.as(makeConnection(1)),
            )) as CodexEndpointSupervisorDependencies["makeEndpoint"],
          makeRouter: (() =>
            Effect.succeed(ROUTER)) as CodexEndpointSupervisorDependencies["makeRouter"],
        },
        owner,
      );
      yield* startAndAwaitState(
        supervisor,
        { onGenerationInvalidated: () => Effect.sync(() => void (invalidations += 1)) },
        (state) => state._tag === "Ready",
      );
      yield* Scope.close(owner, Exit.void);
      yield* Scope.close(owner, Exit.void);
      assert.equal(releases, 1);
      assert.equal(invalidations, 0);
      assert.equal((yield* supervisor.getState)._tag, "Closed");
    }),
  );
});
