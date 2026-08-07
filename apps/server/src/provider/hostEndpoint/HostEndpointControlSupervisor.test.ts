import {
  CocoaHostControlHandshakeResponse,
  CocoaHostControlRequestId,
  CocoaHostTransport,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { HostEndpointControlClient } from "./HostEndpointControlClient.ts";
import {
  HostEndpointRpcAuthenticationError,
  HostEndpointRpcDisconnectedError,
  HostEndpointRpcOpenError,
  HostEndpointRpcRemoteError,
  type HostEndpointRpcRequestError,
} from "./HostEndpointRpcClient.ts";
import {
  calculateHostEndpointControlRetryDelay,
  classifyHostEndpointControlError,
  makeHostEndpointControlSupervisor,
  type HostEndpointControlSupervisor,
  type HostEndpointControlSupervisorDependencies,
  type HostEndpointControlSupervisorState,
} from "./HostEndpointControlSupervisor.ts";

const TRANSPORT = Schema.decodeSync(CocoaHostTransport)({
  type: "cocoa-host",
  url: "wss://host.example.test:4500",
  key: "test_host_key",
});
const CLIENT_INFO = { name: "cocoa-gateway", version: "test" } as const;
const decodeHandshake = Schema.decodeSync(CocoaHostControlHandshakeResponse);

const makeHandshake = (hostGenerationId: string) =>
  decodeHandshake({
    protocol: "cocoa-host-control",
    requestId: "gateway:1",
    selectedVersion: 1,
    host: {
      generationId: hostGenerationId,
      implementation: "cocoa-hostd",
      version: "test",
      platformFamily: "unix",
      platformOs: "linux",
    },
    capabilities: [
      {
        kind: "workspace",
        version: 1,
        operations: ["browse", "read"],
        maxEntries: 100,
        maxReadBytes: 1024,
      },
    ],
    providerRelays: [],
  });

interface TestClient {
  readonly client: HostEndpointControlClient;
  readonly terminate: Effect.Effect<boolean>;
  readonly closed: Effect.Effect<void>;
  readonly requestCalls: () => number;
}

const makeTestClient = Effect.fn("HostEndpointControlSupervisorTest.makeClient")(function* (
  hostGenerationId: string,
) {
  const handshake = makeHandshake(hostGenerationId);
  const termination = yield* Deferred.make<HostEndpointRpcDisconnectedError>();
  const requestResult = yield* Deferred.make<unknown, HostEndpointRpcRequestError>();
  const closed = yield* Deferred.make<void>();
  let requests = 0;
  let isClosed = false;
  const disconnected = () =>
    new HostEndpointRpcDisconnectedError({ generationId: handshake.host.generationId });
  const close = Effect.gen(function* () {
    if (isClosed) return;
    isClosed = true;
    const error = disconnected();
    yield* Deferred.fail(requestResult, error);
    yield* Deferred.succeed(termination, error);
    yield* Deferred.succeed(closed, undefined);
  });
  const client = {
    generationId: handshake.host.generationId,
    handshake,
    request: () => {
      requests += 1;
      return Deferred.await(requestResult);
    },
    subscribeEvents: Effect.die("unused subscribeEvents"),
    awaitTermination: Deferred.await(termination).pipe(Effect.flatMap(Effect.fail)),
    close,
  } as HostEndpointControlClient;
  return {
    client,
    terminate: Deferred.succeed(termination, disconnected()),
    closed: Deferred.await(closed),
    requestCalls: () => requests,
  } satisfies TestClient;
});

const transientError = (label: string) =>
  new HostEndpointRpcOpenError({ url: TRANSPORT.url, cause: new Error(label) });

const makeSupervisor = (
  dependencies: Partial<HostEndpointControlSupervisorDependencies>,
  scope?: Scope.Scope,
) =>
  makeHostEndpointControlSupervisor({
    transport: TRANSPORT,
    clientInfo: CLIENT_INFO,
    dependencies: {
      retryDelay: () => Effect.succeed(Duration.seconds(1)),
      ...dependencies,
    },
  }).pipe(scope ? Effect.provideService(Scope.Scope, scope) : (effect) => effect);

const awaitState = Effect.fn("HostEndpointControlSupervisorTest.awaitState")(function* (
  supervisor: HostEndpointControlSupervisor,
  predicate: (state: HostEndpointControlSupervisorState) => boolean,
) {
  const subscription = yield* supervisor.subscribeChanges;
  const current = yield* supervisor.getState;
  if (predicate(current)) return current;
  return Option.getOrThrow(
    yield* Stream.fromSubscription(subscription).pipe(Stream.filter(predicate), Stream.runHead),
  );
});

const startAndAwait = (
  supervisor: HostEndpointControlSupervisor,
  predicate: (state: HostEndpointControlSupervisorState) => boolean,
) =>
  Effect.gen(function* () {
    const state = yield* awaitState(supervisor, predicate).pipe(Effect.forkChild);
    yield* supervisor.start;
    return yield* Fiber.join(state);
  });

it("calculates bounded exponential jitter and classifies blocked handshakes", () => {
  assert.strictEqual(Duration.toMillis(calculateHostEndpointControlRetryDelay(0, 0)), 800);
  assert.strictEqual(Duration.toMillis(calculateHostEndpointControlRetryDelay(0, 0.5)), 1_000);
  assert.strictEqual(Duration.toMillis(calculateHostEndpointControlRetryDelay(1, 1)), 2_400);
  assert.strictEqual(Duration.toMillis(calculateHostEndpointControlRetryDelay(100, 1)), 30_000);

  assert.strictEqual(
    classifyHostEndpointControlError(new HostEndpointRpcAuthenticationError({ reason: "empty" })),
    "authentication",
  );
  assert.strictEqual(
    classifyHostEndpointControlError(
      new HostEndpointRpcOpenError({
        url: TRANSPORT.url,
        cause: { httpStatus: 401 },
      }),
    ),
    "authentication",
  );
  assert.strictEqual(
    classifyHostEndpointControlError(
      new HostEndpointRpcRemoteError({
        requestId: CocoaHostControlRequestId.make("gateway:1"),
        operation: "handshake",
        code: "unsupportedProtocol",
        remoteMessage: "No mutually supported version.",
        retryable: false,
      }),
    ),
    "version",
  );
  assert.strictEqual(classifyHostEndpointControlError(transientError("offline")), "transient");
});

it.effect("retries transient acquisition with TestClock and publishes handshake capabilities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const attemptReceipt = yield* Deferred.make<number>();
      const readyClient = yield* makeTestClient("host-process-1");
      let attempts = 0;
      const supervisor = yield* makeSupervisor({
        connect: () => {
          attempts += 1;
          return attempts === 1
            ? Deferred.succeed(attemptReceipt, attempts).pipe(
                Effect.andThen(Effect.fail(transientError("offline"))),
              )
            : Effect.succeed(readyClient.client);
        },
      });

      const retrying = yield* startAndAwait(
        supervisor,
        (state) => state._tag === "Retrying" && state.delay !== null,
      );
      assert.strictEqual(yield* Deferred.await(attemptReceipt), 1);
      assert.strictEqual(retrying._tag, "Retrying");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const ready = yield* awaitState(supervisor, (state) => state._tag === "Ready");

      assert.strictEqual(attempts, 2);
      assert.strictEqual(ready._tag, "Ready");
      if (ready._tag === "Ready") {
        assert.strictEqual(ready.generationId, 1);
        assert.strictEqual(ready.hostGenerationId, "host-process-1");
        assert.strictEqual(ready.capabilities[0]?.kind, "workspace");
      }
      assert.strictEqual((yield* supervisor.getCapabilities)?.[0]?.kind, "workspace");
    }),
  ),
);

it.effect("pins borrows to one client and never replays a mutation after invalidation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* makeTestClient("same-host-process");
      const second = yield* makeTestClient("same-host-process");
      let attempts = 0;
      const supervisor = yield* makeSupervisor({
        connect: () => Effect.succeed(attempts++ === 0 ? first.client : second.client),
      });
      yield* startAndAwait(supervisor, (state) => state._tag === "Ready");
      const oldBorrow = yield* supervisor.borrow;
      const inFlight = yield* oldBorrow
        .request("workspace.browse", {
          locator: { kind: "absolute", path: "/workspace" },
          maxEntries: 10,
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(first.requestCalls(), 1);

      assert.isTrue(yield* first.terminate);
      const retrying = yield* awaitState(
        supervisor,
        (state) => state._tag === "Retrying" && state.delay !== null,
      );
      assert.strictEqual(retrying._tag, "Retrying");
      assert.strictEqual((yield* Fiber.join(inFlight))._tag, "Failure");
      yield* TestClock.adjust("1 second");
      yield* awaitState(supervisor, (state) => state._tag === "Ready");

      const nextBorrow = yield* supervisor.borrow;
      assert.strictEqual(nextBorrow.generationId, 2);
      assert.strictEqual(nextBorrow.hostGenerationId, oldBorrow.hostGenerationId);
      assert.notStrictEqual(nextBorrow.client, oldBorrow.client);
      assert.strictEqual((yield* oldBorrow.ensureCurrent.pipe(Effect.result))._tag, "Failure");
      const staleRequest = yield* oldBorrow
        .request("workspace.browse", {
          locator: { kind: "absolute", path: "/workspace" },
          maxEntries: 10,
        })
        .pipe(Effect.result);
      assert.strictEqual(staleRequest._tag, "Failure");
      assert.strictEqual(first.requestCalls(), 1);
      assert.strictEqual(second.requestCalls(), 0);
    }),
  ),
);

it.effect("enters version/auth blocked states without scheduling reconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const versionError = new HostEndpointRpcRemoteError({
        requestId: CocoaHostControlRequestId.make("gateway:1"),
        operation: "handshake",
        code: "unsupportedProtocol",
        remoteMessage: "No mutually supported version.",
        retryable: false,
      });
      let attempts = 0;
      const versionSupervisor = yield* makeSupervisor({
        connect: () => {
          attempts += 1;
          return Effect.fail(versionError);
        },
      });
      const blocked = yield* startAndAwait(versionSupervisor, (state) => state._tag === "Blocked");
      assert.deepInclude(blocked, { _tag: "Blocked", reason: "version" });
      yield* TestClock.adjust("1 hour");
      assert.strictEqual(attempts, 1);
      assert.strictEqual((yield* versionSupervisor.borrow.pipe(Effect.result))._tag, "Failure");

      const authSupervisor = yield* makeSupervisor({
        connect: () => Effect.fail(new HostEndpointRpcAuthenticationError({ reason: "empty" })),
      });
      const authBlocked = yield* startAndAwait(authSupervisor, (state) => state._tag === "Blocked");
      assert.deepInclude(authBlocked, { _tag: "Blocked", reason: "authentication" });
    }),
  ),
);

it.effect("closes the exact current generation and invalidates its borrow on scope shutdown", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const client = yield* makeTestClient("host-process-close");
    const supervisor = yield* makeSupervisor(
      { connect: () => Effect.succeed(client.client) },
      scope,
    );
    yield* startAndAwait(supervisor, (state) => state._tag === "Ready");
    const borrow = yield* supervisor.borrow;

    yield* Scope.close(scope, Exit.void);
    yield* client.closed;

    assert.strictEqual((yield* supervisor.getState)._tag, "Closed");
    assert.strictEqual((yield* borrow.ensureCurrent.pipe(Effect.result))._tag, "Failure");
    assert.strictEqual((yield* supervisor.borrow.pipe(Effect.result))._tag, "Failure");
  }),
);
