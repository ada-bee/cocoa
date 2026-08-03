import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";

import { CodexEndpointConnection } from "../codexEndpoint/CodexEndpointConnection.ts";
import {
  type CodexEndpointRouterClient,
  makeCodexEndpointRouter,
} from "../codexEndpoint/CodexEndpointRouter.ts";
import {
  CodexSessionRuntimeEndpointInstanceMismatchError,
  CodexSessionRuntimeEndpointMcpConfigurationError,
  makeCodexEndpointSessionRuntime,
  type CodexEndpointSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
} from "./CodexSessionRuntime.ts";

type NotificationHandler = (
  params: unknown,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
type RequestHandler = (params: unknown) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function threadOpenResponse(threadId: string, cwd: string) {
  return {
    cwd,
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-08-03T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: { state: "idle", activeFlags: [] },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

const nativeThreadForCwd = (cwd: string) => `native-${cwd.replaceAll("/", "-")}`;

function makeEndpointHarness() {
  const notificationHandlers = new Map<string, Array<NotificationHandler>>();
  const requestHandlers = new Map<string, RequestHandler>();
  const unknownNotificationHandlers: Array<
    (method: string, params: unknown) => Effect.Effect<void, CodexErrors.CodexAppServerError>
  > = [];
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const notifications: Array<{ readonly method: string; readonly params: unknown }> = [];
  let beforeResponse:
    | ((method: string, params: unknown) => Effect.Effect<void, CodexErrors.CodexAppServerError>)
    | undefined;
  let failResume = false;
  let readTurns: ReadonlyArray<unknown> = [];

  const emitUnknownNotification = (method: string, params: unknown) =>
    Effect.forEach(unknownNotificationHandlers, (handler) => handler(method, params), {
      discard: true,
    });

  const request = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
    params: CodexRpc.ClientRequestParamsByMethod[M],
  ): Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError> =>
    Effect.gen(function* () {
      requests.push({ method, params });
      if (beforeResponse) yield* beforeResponse(method, params);
      if (method === "initialize") {
        return yield* CodexErrors.CodexAppServerRequestError.internalError(
          "endpoint runtime attempted to initialize an initialized connection",
        );
      }
      if (method === "thread/resume" && failResume) {
        return yield* CodexErrors.CodexAppServerRequestError.internalError("Thread not found");
      }
      if (method === "thread/start" || method === "thread/resume") {
        const input = params as { readonly cwd?: string; readonly threadId?: string };
        const cwd = input.cwd ?? "/workspace";
        const nativeThreadId =
          method === "thread/resume" ? input.threadId! : nativeThreadForCwd(cwd);
        return threadOpenResponse(nativeThreadId, cwd) as never;
      }
      if (method === "thread/read") {
        const input = params as { readonly threadId: string };
        return {
          thread: {
            id: input.threadId,
            createdAt: "2026-08-03T00:00:00.000Z",
            source: { session: "cli" },
            turns: readTurns,
            status: { state: "idle", activeFlags: [] },
          },
        } as never;
      }
      return {} as never;
    });

  const client = {
    request,
    notify: (method: string, params: unknown) =>
      Effect.sync(() => {
        notifications.push({ method, params });
      }),
    raw: { request },
    handleServerNotification: (method: string, handler: NotificationHandler) =>
      Effect.sync(() => {
        const current = notificationHandlers.get(method) ?? [];
        current.push(handler);
        notificationHandlers.set(method, current);
      }),
    handleServerRequest: (method: string, handler: RequestHandler) =>
      Effect.sync(() => {
        requestHandlers.set(method, handler);
      }),
    handleUnknownServerNotification: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<void, CodexErrors.CodexAppServerError>,
    ) => Effect.sync(() => unknownNotificationHandlers.push(handler)),
  } as unknown as CodexClient.CodexAppServerClient["Service"];

  return {
    client,
    requests,
    notifications,
    emitUnknownNotification,
    serverRequest: (method: string, params: unknown) => {
      const handler = requestHandlers.get(method);
      assert.isDefined(handler);
      return handler!(params);
    },
    setBeforeResponse: (handler: NonNullable<typeof beforeResponse>) => {
      beforeResponse = handler;
    },
    failResume: () => {
      failResume = true;
    },
    setReadTurns: (turns: ReadonlyArray<unknown>) => {
      readTurns = turns;
    },
  };
}

const runtimeOptions = (
  threadId: string,
  cwd: string,
  resumeThreadId?: string,
): CodexEndpointSessionRuntimeOptions => ({
  threadId: ThreadId.make(threadId),
  providerInstanceId: ProviderInstanceId.make("codex-remote"),
  cwd,
  runtimeMode: "full-access",
  ...(resumeThreadId ? { resumeCursor: { threadId: resumeThreadId } } : {}),
});

const makeRuntimeInScope = (
  connection: CodexEndpointConnection["Service"],
  router: Effect.Success<ReturnType<typeof makeCodexEndpointRouter>>,
  options: CodexEndpointSessionRuntimeOptions,
  scope: Scope.Closeable,
) =>
  makeCodexEndpointSessionRuntime({ connection, router, options }).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.provideService(Crypto.Crypto, testCrypto),
  );

const takeNotification = (runtime: CodexSessionRuntimeShape, method: string) =>
  runtime.events.pipe(
    Stream.filter((event) => event.kind === "notification" && event.method === method),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect("opens a fresh endpoint thread without initialize and drains raced notifications", () =>
  Effect.gen(function* () {
    const harness = makeEndpointHarness();
    const router = yield* makeCodexEndpointRouter(harness.client as CodexEndpointRouterClient);
    const connection = CodexEndpointConnection.of({
      identity: { providerInstanceId: ProviderInstanceId.make("codex-remote") },
      client: harness.client,
      compatibility: {
        userAgent: "codex_cli_rs/0.146.0",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    });
    const sessionScope = yield* Scope.make("sequential");
    const runtime = yield* makeRuntimeInScope(
      connection,
      router,
      runtimeOptions("cocoa-1", "/workspace/one"),
      sessionScope,
    );
    const raced = yield* takeNotification(runtime, "future/thread-event").pipe(Effect.forkChild);
    harness.setBeforeResponse((method) =>
      method === "thread/start"
        ? harness.emitUnknownNotification("future/thread-event", {
            threadId: nativeThreadForCwd("/workspace/one"),
            sequence: 1,
          })
        : Effect.void,
    );

    const session = yield* runtime.start();
    const event = yield* Fiber.join(raced);
    assert.equal(session.providerInstanceId, ProviderInstanceId.make("codex-remote"));
    assert.equal(event.providerInstanceId, ProviderInstanceId.make("codex-remote"));
    assert.equal(event.threadId, ThreadId.make("cocoa-1"));
    assert.deepEqual(
      harness.requests.map(({ method }) => method),
      ["thread/start"],
    );
    assert.deepEqual(harness.notifications, []);
  }),
);

it.effect("binds a resume cursor before issuing thread/resume", () =>
  Effect.gen(function* () {
    const harness = makeEndpointHarness();
    const router = yield* makeCodexEndpointRouter(harness.client as CodexEndpointRouterClient);
    const connection = CodexEndpointConnection.of({
      identity: { providerInstanceId: ProviderInstanceId.make("codex-remote") },
      client: harness.client,
      compatibility: {
        userAgent: "codex_cli_rs/0.146.0",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    });
    const sessionScope = yield* Scope.make("sequential");
    const runtime = yield* makeRuntimeInScope(
      connection,
      router,
      runtimeOptions("cocoa-resume", "/workspace/resume", "native-resume"),
      sessionScope,
    );
    const observed = yield* takeNotification(runtime, "future/resume-event").pipe(
      Effect.asVoid,
      Effect.forkChild,
    );
    harness.setBeforeResponse((method) =>
      method === "thread/resume"
        ? harness
            .emitUnknownNotification("future/resume-event", { threadId: "native-resume" })
            .pipe(Effect.andThen(Fiber.join(observed)))
        : Effect.void,
    );

    yield* runtime.start().pipe(Effect.timeout("1 second"));
    assert.deepEqual(
      harness.requests.map(({ method }) => method),
      ["thread/resume"],
    );
  }),
);

it.effect("rehydrates the active native turn on each fresh endpoint reconnect", () =>
  Effect.gen(function* () {
    const harness = makeEndpointHarness();
    harness.setReadTurns([
      {
        id: "native-running-turn",
        status: "inProgress",
        completedAt: null,
        itemsView: "full",
        items: [],
      },
    ]);
    const router = yield* makeCodexEndpointRouter(harness.client as CodexEndpointRouterClient);
    const connection = CodexEndpointConnection.of({
      identity: { providerInstanceId: ProviderInstanceId.make("codex-remote") },
      client: harness.client,
      compatibility: {
        userAgent: "codex_cli_rs/0.146.0",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    });

    for (const suffix of ["first", "second"]) {
      const sessionScope = yield* Scope.make("sequential");
      const runtime = yield* makeRuntimeInScope(
        connection,
        router,
        runtimeOptions(`cocoa-reconnect-${suffix}`, "/workspace/reconnect", "native-reconnect"),
        sessionScope,
      );
      yield* runtime.start();
      yield* runtime.readThread;
      const session = yield* runtime.getSession;
      assert.equal(session.status, "running");
      assert.equal(session.activeTurnId, TurnId.make("native-running-turn"));
      yield* runtime.close;
    }
    assert.deepEqual(
      harness.requests.map(({ method }) => method),
      ["thread/resume", "thread/read", "thread/resume", "thread/read"],
    );
  }),
);

it.effect("rebinds a missing resume cursor to the fresh fallback thread", () =>
  Effect.gen(function* () {
    const harness = makeEndpointHarness();
    harness.failResume();
    const router = yield* makeCodexEndpointRouter(harness.client as CodexEndpointRouterClient);
    const connection = CodexEndpointConnection.of({
      identity: { providerInstanceId: ProviderInstanceId.make("codex-remote") },
      client: harness.client,
      compatibility: {
        userAgent: "codex_cli_rs/0.146.0",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    });
    const sessionScope = yield* Scope.make("sequential");
    const runtime = yield* makeRuntimeInScope(
      connection,
      router,
      runtimeOptions("cocoa-fallback", "/workspace/fallback", "missing-native-thread"),
      sessionScope,
    );

    const session = yield* runtime.start();
    const freshNativeThreadId = nativeThreadForCwd("/workspace/fallback");
    assert.deepEqual(session.resumeCursor, { threadId: freshNativeThreadId });
    assert.deepEqual(
      harness.requests.map(({ method }) => method),
      ["thread/resume", "thread/start"],
    );

    const delivered = yield* takeNotification(runtime, "future/rebound").pipe(Effect.forkChild);
    yield* harness.emitUnknownNotification("future/rebound", {
      threadId: "missing-native-thread",
      source: "old",
    });
    yield* harness.emitUnknownNotification("future/rebound", {
      threadId: freshNativeThreadId,
      source: "fresh",
    });
    assert.deepEqual((yield* Fiber.join(delivered)).payload, {
      threadId: freshNativeThreadId,
      source: "fresh",
    });
    yield* runtime.close;
  }),
);

it.effect("keeps two endpoint sessions isolated when one session closes", () =>
  Effect.gen(function* () {
    const harness = makeEndpointHarness();
    const router = yield* makeCodexEndpointRouter(harness.client as CodexEndpointRouterClient);
    const connection = CodexEndpointConnection.of({
      identity: { providerInstanceId: ProviderInstanceId.make("codex-remote") },
      client: harness.client,
      compatibility: {
        userAgent: "codex_cli_rs/0.146.0",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    });
    const firstScope = yield* Scope.make("sequential");
    const secondScope = yield* Scope.make("sequential");
    const first = yield* makeRuntimeInScope(
      connection,
      router,
      runtimeOptions("cocoa-1", "/workspace/one"),
      firstScope,
    );
    const second = yield* makeRuntimeInScope(
      connection,
      router,
      runtimeOptions("cocoa-2", "/workspace/two"),
      secondScope,
    );
    yield* first.start();
    yield* second.start();
    const secondEvent = yield* takeNotification(second, "future/isolated").pipe(Effect.forkChild);

    yield* first.close;
    yield* harness.emitUnknownNotification("future/isolated", {
      threadId: nativeThreadForCwd("/workspace/one"),
    });
    yield* harness.emitUnknownNotification("future/isolated", {
      threadId: nativeThreadForCwd("/workspace/two"),
    });

    assert.equal((yield* Fiber.join(secondEvent)).threadId, ThreadId.make("cocoa-2"));
    assert.equal((yield* second.readThread).threadId, nativeThreadForCwd("/workspace/two"));
    assert.deepEqual(harness.notifications, []);
    yield* second.close;
    yield* Scope.close(firstScope, Exit.void);
    yield* Scope.close(secondScope, Exit.void);
  }),
);

it.effect("preserves approval and user-input request handling through the shared router", () =>
  Effect.gen(function* () {
    const harness = makeEndpointHarness();
    const router = yield* makeCodexEndpointRouter(harness.client as CodexEndpointRouterClient);
    const connection = CodexEndpointConnection.of({
      identity: { providerInstanceId: ProviderInstanceId.make("codex-remote") },
      client: harness.client,
      compatibility: {
        userAgent: "codex_cli_rs/0.146.0",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    });
    const sessionScope = yield* Scope.make("sequential");
    const runtime = yield* makeRuntimeInScope(
      connection,
      router,
      runtimeOptions("cocoa-interactions", "/workspace/interactions"),
      sessionScope,
    );
    yield* runtime.start();
    const nativeThreadId = nativeThreadForCwd("/workspace/interactions");

    const approvalEvent = yield* runtime.events.pipe(
      Stream.filter((event) => event.kind === "request" && event.requestKind === "command"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.forkChild,
    );
    const approvalResponse = yield* harness
      .serverRequest("item/commandExecution/requestApproval", {
        itemId: "command-item",
        startedAtMs: 1,
        threadId: nativeThreadId,
        turnId: "native-turn",
      })
      .pipe(Effect.forkChild);
    const approval = yield* Fiber.join(approvalEvent);
    yield* runtime.respondToRequest(approval.requestId!, "accept");
    assert.deepEqual(yield* Fiber.join(approvalResponse), { decision: "accept" });

    const userInputEvent = yield* runtime.events.pipe(
      Stream.filter(
        (event) => event.kind === "request" && event.method === "item/tool/requestUserInput",
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.forkChild,
    );
    const userInputResponse = yield* harness
      .serverRequest("item/tool/requestUserInput", {
        itemId: "input-item",
        questions: [
          {
            id: "answer",
            header: "Answer",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue." }],
          },
        ],
        threadId: nativeThreadId,
        turnId: "native-turn",
      })
      .pipe(Effect.forkChild);
    const userInput = yield* Fiber.join(userInputEvent);
    yield* runtime.respondToUserInput(userInput.requestId!, { answer: "Yes" });
    assert.deepEqual(yield* Fiber.join(userInputResponse), {
      answers: { answer: { answers: ["Yes"] } },
    });
    yield* runtime.close;
  }),
);

it.effect("rejects per-session MCP launch arguments in endpoint mode", () =>
  Effect.gen(function* () {
    const harness = makeEndpointHarness();
    const router = yield* makeCodexEndpointRouter(harness.client as CodexEndpointRouterClient);
    const connection = CodexEndpointConnection.of({
      identity: { providerInstanceId: ProviderInstanceId.make("codex-remote") },
      client: harness.client,
      compatibility: {
        userAgent: "codex_cli_rs/0.146.0",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    });
    const result = yield* makeCodexEndpointSessionRuntime({
      connection,
      router,
      options: {
        ...runtimeOptions("cocoa-mcp", "/workspace/mcp"),
        appServerArgs: ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
      },
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto), Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.instanceOf(result.failure, CodexSessionRuntimeEndpointMcpConfigurationError);
    }
    assert.deepEqual(harness.requests, []);
  }),
);

it.effect("rejects a provider instance that does not own the initialized connection", () =>
  Effect.gen(function* () {
    const harness = makeEndpointHarness();
    const router = yield* makeCodexEndpointRouter(harness.client as CodexEndpointRouterClient);
    const connection = CodexEndpointConnection.of({
      identity: { providerInstanceId: ProviderInstanceId.make("connection-owner") },
      client: harness.client,
      compatibility: {
        userAgent: "codex_cli_rs/0.146.0",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    });
    const result = yield* makeCodexEndpointSessionRuntime({
      connection,
      router,
      options: runtimeOptions("cocoa-mismatch", "/workspace/mismatch"),
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto), Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.instanceOf(result.failure, CodexSessionRuntimeEndpointInstanceMismatchError);
    }
    assert.deepEqual(harness.requests, []);
  }),
);
