import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_INTERACTIVE_SERVER_REQUEST_METHODS,
  type CodexEndpointRouter,
  type CodexEndpointRouterClient,
  type CodexEndpointSessionCallbacks,
  makeCodexEndpointRouter,
} from "./CodexEndpointRouter.ts";

type UntypedNotificationHandler = (
  params: unknown,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
type UntypedRequestHandler = (
  params: unknown,
) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;

function makeFakeClient() {
  const notificationHandlers = new Map<string, Array<UntypedNotificationHandler>>();
  const requestHandlers = new Map<string, Array<UntypedRequestHandler>>();
  const unknownNotificationHandlers: Array<
    (method: string, params: unknown) => Effect.Effect<void, CodexErrors.CodexAppServerError>
  > = [];
  const client = {
    handleServerNotification: (method: string, handler: UntypedNotificationHandler) =>
      Effect.sync(() => {
        const handlers = notificationHandlers.get(method) ?? [];
        handlers.push(handler);
        notificationHandlers.set(method, handlers);
      }),
    handleServerRequest: (method: string, handler: UntypedRequestHandler) =>
      Effect.sync(() => {
        const handlers = requestHandlers.get(method) ?? [];
        handlers.push(handler);
        requestHandlers.set(method, handlers);
      }),
    handleUnknownServerNotification: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<void, CodexErrors.CodexAppServerError>,
    ) => Effect.sync(() => unknownNotificationHandlers.push(handler)),
  } as unknown as CodexEndpointRouterClient;

  return {
    client,
    notificationHandlers,
    requestHandlers,
    unknownNotificationHandlers,
    emitNotification: (method: string, params: unknown) =>
      Effect.forEach(notificationHandlers.get(method) ?? [], (handler) => handler(params), {
        discard: true,
      }),
    emitUnknownNotification: (method: string, params: unknown) =>
      Effect.forEach(unknownNotificationHandlers, (handler) => handler(method, params), {
        discard: true,
      }),
    request: (method: string, params: unknown) => {
      const handlers = requestHandlers.get(method) ?? [];
      assert.lengthOf(handlers, 1);
      return handlers[0]!(params);
    },
  };
}

function makeCallbacks(
  input: {
    readonly onNotification?: (method: string, params: unknown) => Effect.Effect<void>;
    readonly onRequest?: (method: string, params: unknown) => Effect.Effect<unknown>;
  } = {},
): CodexEndpointSessionCallbacks {
  return {
    onNotification: ((method: string, params: unknown) =>
      input.onNotification?.(method, params) ??
      Effect.void) as CodexEndpointSessionCallbacks["onNotification"],
    onUnknownNotification: (method, params) =>
      input.onNotification?.(method, params) ?? Effect.void,
    onRequest: ((method: string, params: unknown) => {
      if (input.onRequest) return input.onRequest(method, params);
      return Effect.succeed(
        method === "item/tool/requestUserInput" ? { answers: {} } : { decision: "decline" },
      );
    }) as CodexEndpointSessionCallbacks["onRequest"],
  };
}

const registerInScope = (
  router: CodexEndpointRouter,
  input: Parameters<CodexEndpointRouter["registerSession"]>[0],
  scope: Scope.Closeable,
) => router.registerSession(input).pipe(Effect.provideService(Scope.Scope, scope));

it.effect("installs one shared handler for every notification and interactive request", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    yield* makeCodexEndpointRouter(fake.client);

    assert.equal(
      fake.notificationHandlers.size,
      Object.keys(CodexRpc.SERVER_NOTIFICATION_METHODS).length,
    );
    for (const handlers of fake.notificationHandlers.values()) {
      assert.lengthOf(handlers, 1);
    }
    assert.lengthOf(fake.unknownNotificationHandlers, 1);
    assert.deepEqual(
      [...fake.requestHandlers.keys()],
      [...CODEX_INTERACTIVE_SERVER_REQUEST_METHODS],
    );
    for (const handlers of fake.requestHandlers.values()) {
      assert.lengthOf(handlers, 1);
    }
  }),
);

it.effect("isolates notifications for two Cocoa sessions", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const router = yield* makeCodexEndpointRouter(fake.client);
    const firstNotifications = yield* Queue.unbounded<string>();
    const secondNotifications = yield* Queue.unbounded<string>();
    const first = yield* router.registerSession({
      threadId: ThreadId.make("cocoa-thread-1"),
      callbacks: makeCallbacks({
        onNotification: (_method, params) =>
          Queue.offer(firstNotifications, (params as { threadId: string }).threadId).pipe(
            Effect.asVoid,
          ),
      }),
    });
    const second = yield* router.registerSession({
      threadId: ThreadId.make("cocoa-thread-2"),
      callbacks: makeCallbacks({
        onNotification: (_method, params) =>
          Queue.offer(secondNotifications, (params as { threadId: string }).threadId).pipe(
            Effect.asVoid,
          ),
      }),
    });
    yield* first.bindNativeThreadId("native-thread-1");
    yield* second.bindNativeThreadId("native-thread-2");

    yield* fake.emitNotification("thread/status/changed", { threadId: "native-thread-1" });
    yield* fake.emitNotification("thread/status/changed", { threadId: "native-thread-2" });

    assert.equal(yield* Queue.take(firstNotifications), "native-thread-1");
    assert.equal(yield* Queue.take(secondNotifications), "native-thread-2");
    assert.equal(yield* Queue.size(firstNotifications), 0);
    assert.equal(yield* Queue.size(secondNotifications), 0);
  }),
);

it.effect("drains notifications which race native-thread binding in order", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const router = yield* makeCodexEndpointRouter(fake.client);
    const delivered = yield* Queue.unbounded<number>();
    const registration = yield* router.registerSession({
      threadId: ThreadId.make("cocoa-thread"),
      callbacks: makeCallbacks({
        onNotification: (_method, params) =>
          Queue.offer(delivered, (params as { sequence: number }).sequence).pipe(Effect.asVoid),
      }),
    });

    yield* fake.emitUnknownNotification("future/thread-event", {
      threadId: "native-thread",
      sequence: 1,
    });
    yield* fake.emitNotification("thread/status/changed", {
      threadId: "native-thread",
      sequence: 2,
    });
    yield* registration.bindNativeThreadId("native-thread");

    assert.equal(yield* Queue.take(delivered), 1);
    assert.equal(yield* Queue.take(delivered), 2);
  }),
);

it.effect("routes turn approval requests to the owning session", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const router = yield* makeCodexEndpointRouter(fake.client);
    const requestedTurns = yield* Queue.unbounded<string>();
    const registration = yield* router.registerSession({
      threadId: ThreadId.make("cocoa-thread"),
      callbacks: makeCallbacks({
        onRequest: (_method, params) =>
          Queue.offer(requestedTurns, (params as { turnId: string }).turnId).pipe(
            Effect.as({ decision: "accept" }),
          ),
      }),
    });
    yield* registration.bindNativeThreadId("native-thread");

    const response = yield* fake.request("item/commandExecution/requestApproval", {
      itemId: "item-1",
      startedAtMs: 1,
      threadId: "native-thread",
      turnId: "native-turn",
    });

    assert.deepEqual(response, { decision: "accept" });
    assert.equal(yield* Queue.take(requestedTurns), "native-turn");
  }),
);

it.effect("fails an unroutable interactive request with a typed request error", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    yield* makeCodexEndpointRouter(fake.client);

    const error = yield* fake
      .request("item/fileChange/requestApproval", {
        itemId: "item-1",
        startedAtMs: 1,
        threadId: "native-thread",
        turnId: "missing-turn",
      })
      .pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected an unroutable request to fail"),
        }),
      );

    assert.instanceOf(error, CodexErrors.CodexAppServerRequestError);
    assert.equal(error.code, -32603);
  }),
);

it.effect("unregisters native notification and request routes when the session scope closes", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const router = yield* makeCodexEndpointRouter(fake.client);
    const delivered = yield* Queue.unbounded<string>();
    const sessionScope = yield* Scope.make();
    const registration = yield* registerInScope(
      router,
      {
        threadId: ThreadId.make("cocoa-thread"),
        callbacks: makeCallbacks({
          onNotification: (method) => Queue.offer(delivered, method).pipe(Effect.asVoid),
        }),
      },
      sessionScope,
    );
    yield* registration.bindNativeThreadId("native-thread");
    yield* fake.emitNotification("thread/status/changed", { threadId: "native-thread" });
    yield* Queue.take(delivered);

    yield* Scope.close(sessionScope, Exit.void);
    yield* fake.emitNotification("thread/status/changed", { threadId: "native-thread" });
    assert.equal(yield* Queue.size(delivered), 0);

    const error = yield* fake
      .request("item/tool/requestUserInput", {
        itemId: "item-1",
        questions: [],
        threadId: "native-thread",
        turnId: "native-turn",
      })
      .pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the removed native-thread route to fail"),
        }),
      );
    assert.instanceOf(error, CodexErrors.CodexAppServerRequestError);
  }),
);

it.effect("routes version-skewed notifications by their structural thread id", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const router = yield* makeCodexEndpointRouter(fake.client);
    const delivered = yield* Queue.unbounded<string>();
    const registration = yield* router.registerSession({
      threadId: ThreadId.make("cocoa-thread"),
      callbacks: makeCallbacks({
        onNotification: (method) => Queue.offer(delivered, method).pipe(Effect.asVoid),
      }),
    });
    yield* registration.bindNativeThreadId("native-thread");

    yield* fake.emitUnknownNotification("future/item/updated", {
      threadId: "native-thread",
    });

    assert.equal(yield* Queue.take(delivered), "future/item/updated");
  }),
);

it.effect("keeps the newest notifications when the pre-bind backlog is full", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const router = yield* makeCodexEndpointRouter(fake.client, {
      unboundNotificationBacklogCapacity: 2,
    });
    const delivered = yield* Queue.unbounded<number>();
    const registration = yield* router.registerSession({
      threadId: ThreadId.make("cocoa-thread"),
      callbacks: makeCallbacks({
        onNotification: (_method, params) =>
          Queue.offer(delivered, (params as { sequence: number }).sequence).pipe(Effect.asVoid),
      }),
    });

    for (const sequence of [1, 2, 3]) {
      yield* fake.emitNotification("thread/status/changed", {
        threadId: "native-thread",
        sequence,
      });
    }
    yield* registration.bindNativeThreadId("native-thread");

    assert.equal(yield* Queue.take(delivered), 2);
    assert.equal(yield* Queue.take(delivered), 3);
    assert.equal(yield* Queue.size(delivered), 0);
  }),
);

it.effect("atomically rebinds a session and drains only the new native-thread backlog", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const router = yield* makeCodexEndpointRouter(fake.client);
    const delivered = yield* Queue.unbounded<string>();
    const registration = yield* router.registerSession({
      threadId: ThreadId.make("cocoa-thread"),
      callbacks: makeCallbacks({
        onNotification: (_method, params) =>
          Queue.offer(delivered, (params as { threadId: string }).threadId).pipe(Effect.asVoid),
      }),
    });
    yield* registration.bindNativeThreadId("stale-native-thread");
    yield* fake.emitNotification("thread/status/changed", {
      threadId: "fresh-native-thread",
    });

    yield* registration.rebindNativeThreadId("fresh-native-thread");
    assert.equal(yield* Queue.take(delivered), "fresh-native-thread");

    yield* fake.emitNotification("thread/status/changed", {
      threadId: "stale-native-thread",
    });
    yield* fake.emitNotification("thread/status/changed", {
      threadId: "fresh-native-thread",
    });
    assert.equal(yield* Queue.take(delivered), "fresh-native-thread");
    assert.equal(yield* Queue.size(delivered), 0);
  }),
);

it.effect("rejects rebinding onto another session without disturbing either owner", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const router = yield* makeCodexEndpointRouter(fake.client);
    const firstDelivered = yield* Queue.unbounded<string>();
    const secondDelivered = yield* Queue.unbounded<string>();
    const first = yield* router.registerSession({
      threadId: ThreadId.make("cocoa-first"),
      callbacks: makeCallbacks({
        onNotification: (_method, params) =>
          Queue.offer(firstDelivered, (params as { threadId: string }).threadId).pipe(
            Effect.asVoid,
          ),
      }),
    });
    const second = yield* router.registerSession({
      threadId: ThreadId.make("cocoa-second"),
      callbacks: makeCallbacks({
        onNotification: (_method, params) =>
          Queue.offer(secondDelivered, (params as { threadId: string }).threadId).pipe(
            Effect.asVoid,
          ),
      }),
    });
    yield* first.bindNativeThreadId("native-first");
    yield* second.bindNativeThreadId("native-second");

    const result = yield* first.rebindNativeThreadId("native-second").pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.reason, "native-thread-already-bound");
    }

    yield* fake.emitNotification("thread/status/changed", { threadId: "native-first" });
    yield* fake.emitNotification("thread/status/changed", { threadId: "native-second" });
    assert.equal(yield* Queue.take(firstDelivered), "native-first");
    assert.equal(yield* Queue.take(secondDelivered), "native-second");
  }),
);
