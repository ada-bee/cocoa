import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  CodexEndpointConnection,
  CodexEndpointTerminationError,
} from "./CodexEndpointConnection.ts";
import {
  CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_OUTPUT_BYTES,
  CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_REMOTE_PATH_BYTES,
  CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_OUTPUT_SCHEMA_BYTES,
  CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_PROMPT_CHARS,
  makeCodexEndpointStructuredGeneration,
  type CodexEndpointStructuredGenerationInput,
} from "./CodexEndpointStructuredGeneration.ts";
import { makeCodexEndpointRouter, type CodexEndpointRouterClient } from "./CodexEndpointRouter.ts";
import type { CodexEndpointRoutedConnectionBorrow } from "./CodexEndpointSupervisor.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const OTHER_INSTANCE_ID = ProviderInstanceId.make("codex_other");
const REMOTE_PATH = "/srv/workspaces/cocoa";
const OUTPUT_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
} as const;
const IMAGE_DATA_URL = "data:image/png;base64,YQ==";

const BASE_INPUT: CodexEndpointStructuredGenerationInput = {
  workspace: { providerInstanceId: INSTANCE_ID, remotePath: REMOTE_PATH },
  modelSelection: {
    instanceId: INSTANCE_ID,
    model: "gpt-5.6",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ],
  },
  prompt: "Return a concise title as JSON.",
  outputSchema: OUTPUT_SCHEMA,
  imageDataUrls: [IMAGE_DATA_URL],
};

type RequestRecord = { readonly method: string; readonly payload: unknown };
type NotificationHandler = (
  params: unknown,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
type ServerRequestHandler = (
  params: unknown,
) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
type RequestHandler = (
  method: string,
  payload: unknown,
) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;

const makeHarness = Effect.fn("CodexEndpointStructuredGeneration.test.makeHarness")(function* () {
  const notificationHandlers = new Map<string, Array<NotificationHandler>>();
  const serverRequestHandlers = new Map<string, Array<ServerRequestHandler>>();
  const unknownNotificationHandlers: Array<
    (method: string, params: unknown) => Effect.Effect<void, CodexErrors.CodexAppServerError>
  > = [];
  const requestEvents = yield* Queue.unbounded<RequestRecord>();
  const requests: Array<RequestRecord> = [];
  const terminated = yield* Deferred.make<CodexEndpointTerminationError>();
  let borrowCount = 0;
  let requestHandler: RequestHandler = (method) => Effect.die(`Unhandled request: ${method}`);

  const client = {
    request: (method: string, payload: unknown) => {
      const record = { method, payload };
      return Effect.sync(() => requests.push(record)).pipe(
        Effect.andThen(Queue.offer(requestEvents, record)),
        Effect.andThen(requestHandler(method, payload)),
      );
    },
    handleServerNotification: (method: string, handler: NotificationHandler) =>
      Effect.sync(() => {
        const handlers = notificationHandlers.get(method) ?? [];
        handlers.push(handler);
        notificationHandlers.set(method, handlers);
      }),
    handleServerRequest: (method: string, handler: ServerRequestHandler) =>
      Effect.sync(() => {
        const handlers = serverRequestHandlers.get(method) ?? [];
        handlers.push(handler);
        serverRequestHandlers.set(method, handlers);
      }),
    handleUnknownServerNotification: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<void, CodexErrors.CodexAppServerError>,
    ) => Effect.sync(() => unknownNotificationHandlers.push(handler)),
  } as unknown as CodexClient.CodexAppServerClient["Service"];

  const router = yield* makeCodexEndpointRouter(client as CodexEndpointRouterClient);
  const connection = CodexEndpointConnection.of({
    identity: { providerInstanceId: INSTANCE_ID },
    client,
    compatibility: {
      userAgent: "codex-cli/0.146.0",
      serverVersion: "0.146.0",
      codexHome: "/remote/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    awaitTermination: Deferred.await(terminated).pipe(Effect.flatMap(Effect.fail)),
  });
  const borrow: CodexEndpointRoutedConnectionBorrow = {
    generationId: 1,
    connection,
    router,
    ensureCurrent: Effect.void,
  };

  const emitNotification = (method: string, params: unknown) =>
    Effect.forEach(notificationHandlers.get(method) ?? [], (handler) => handler(params), {
      discard: true,
    });
  const serverRequest = (method: string, params: unknown) => {
    const handlers = serverRequestHandlers.get(method) ?? [];
    assert.lengthOf(handlers, 1);
    return handlers[0]!(params);
  };

  return {
    requests,
    requestEvents,
    connection,
    router,
    emitNotification,
    serverRequest,
    setRequestHandler: (handler: RequestHandler) => {
      requestHandler = handler;
    },
    borrowRoutedConnection: Effect.sync(() => {
      borrowCount += 1;
      return borrow;
    }),
    getBorrowCount: () => borrowCount,
    terminate: (label = "disconnected") =>
      Deferred.succeed(
        terminated,
        new CodexEndpointTerminationError({
          providerInstanceId: INSTANCE_ID,
          cause: new CodexErrors.CodexAppServerTransportError({
            operation: "read-input-stream",
            cause: new Error(label),
          }),
        }),
      ).pipe(Effect.asVoid),
  };
});

function completedTurn(input: {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly text?: string;
  readonly includeMessage?: boolean;
  readonly phase?: "commentary" | "final_answer";
  readonly status?: "completed" | "failed" | "interrupted";
}) {
  const threadId = input.threadId ?? "native-thread";
  const turnId = input.turnId ?? "native-turn";
  const includeMessage = input.includeMessage ?? true;
  return {
    threadId,
    turn: {
      id: turnId,
      status: input.status ?? "completed",
      items: includeMessage
        ? [
            {
              id: "message-1",
              type: "agentMessage",
              text: input.text ?? '{"title":"Cocoa"}',
              ...(input.phase ? { phase: input.phase } : {}),
            },
          ]
        : [],
    },
  };
}

const takeRequest = Effect.fn("CodexEndpointStructuredGeneration.test.takeRequest")(function* (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  method: string,
) {
  while (true) {
    const request = yield* Queue.take(harness.requestEvents);
    if (request.method === method) return request;
  }
});

const installSuccessfulHandler = (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  options: {
    readonly threadId?: string;
    readonly turnId?: string;
    readonly text?: string;
    readonly includeMessage?: boolean;
    readonly status?: "completed" | "failed" | "interrupted";
  } = {},
) => {
  const threadId = options.threadId ?? "native-thread";
  const turnId = options.turnId ?? "native-turn";
  harness.setRequestHandler((method) => {
    switch (method) {
      case "thread/start":
        return Effect.succeed({ thread: { id: threadId } });
      case "turn/start":
        return harness
          .emitNotification("turn/completed", completedTurn({ threadId, turnId, ...options }))
          .pipe(Effect.as({ turn: { id: turnId } }));
      case "turn/interrupt":
        return Effect.succeed({});
      case "thread/unsubscribe":
        return Effect.succeed({ status: "unsubscribed" });
      default:
        return Effect.die(`Unexpected request: ${method}`);
    }
  });
};

it.effect("sends exact ephemeral structured-generation params and returns native identifiers", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    installSuccessfulHandler(harness);
    const generation = yield* makeCodexEndpointStructuredGeneration({
      providerInstanceId: INSTANCE_ID,
      borrowRoutedConnection: harness.borrowRoutedConnection,
      terminalGrace: 0,
    });

    const result = yield* generation.generate(BASE_INPUT);
    assert.deepStrictEqual(result, {
      text: '{"title":"Cocoa"}',
      nativeThreadId: "native-thread",
      nativeTurnId: "native-turn",
    });
    assert.deepStrictEqual(
      harness.requests.map((request) => request.method),
      ["thread/start", "turn/start", "thread/unsubscribe"],
    );
    assert.deepStrictEqual(harness.requests[0]!.payload, {
      cwd: REMOTE_PATH,
      ephemeral: true,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      model: "gpt-5.6",
      serviceTier: "priority",
    });
    assert.deepStrictEqual(harness.requests[1]!.payload, {
      threadId: "native-thread",
      input: [
        { type: "text", text: BASE_INPUT.prompt },
        { type: "image", url: IMAGE_DATA_URL },
      ],
      cwd: REMOTE_PATH,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: "gpt-5.6",
      effort: "high",
      serviceTier: "priority",
      outputSchema: OUTPUT_SCHEMA,
    });
    assert.notInclude(
      harness.requests.map((request) => request.method),
      "thread/delete",
    );
  }),
);

it.effect("drains a terminal notification which arrives before native-thread binding", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    harness.setRequestHandler((method) => {
      switch (method) {
        case "thread/start":
          return harness
            .emitNotification("turn/completed", completedTurn({}))
            .pipe(Effect.as({ thread: { id: "native-thread" } }));
        case "turn/start":
          return Effect.succeed({ turn: { id: "native-turn" } });
        case "thread/unsubscribe":
          return Effect.succeed({ status: "unsubscribed" });
        default:
          return Effect.die(`Unexpected request: ${method}`);
      }
    });
    const generation = yield* makeCodexEndpointStructuredGeneration({
      providerInstanceId: INSTANCE_ID,
      borrowRoutedConnection: harness.borrowRoutedConnection,
      terminalGrace: 0,
    });

    const result = yield* generation.generate(BASE_INPUT);
    assert.equal(result.text, '{"title":"Cocoa"}');
    assert.deepStrictEqual(
      harness.requests.map((request) => request.method),
      ["thread/start", "turn/start", "thread/unsubscribe"],
    );
  }),
);

it.effect("fails closed for absent and malformed final structured output", () =>
  Effect.gen(function* () {
    for (const testCase of [
      { options: { includeMessage: false }, reason: "missing-final-response" },
      { options: { text: "not-json" }, reason: "malformed-final-response" },
      {
        options: {
          text: `{"value":"${"界".repeat(
            Math.ceil(CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_OUTPUT_BYTES / 3),
          )}"}`,
        },
        reason: "malformed-final-response",
      },
    ] as const) {
      const harness = yield* makeHarness();
      installSuccessfulHandler(harness, testCase.options);
      const generation = yield* makeCodexEndpointStructuredGeneration({
        providerInstanceId: INSTANCE_ID,
        borrowRoutedConnection: harness.borrowRoutedConnection,
        terminalGrace: 0,
      });

      const result = yield* generation.generate(BASE_INPUT).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, testCase.reason);
      assert.equal(
        harness.requests.filter((request) => request.method === "thread/unsubscribe").length,
        1,
      );
    }
  }),
);

it.effect("maps transport termination errors to endpoint-disconnected without replay", () =>
  Effect.gen(function* () {
    const errors: ReadonlyArray<CodexErrors.CodexAppServerError> = [
      new CodexErrors.CodexAppServerTransportError({
        operation: "write-output-stream",
        cause: new Error("socket closed"),
      }),
      new CodexErrors.CodexAppServerInputStreamEndedError({}),
      new CodexErrors.CodexAppServerProcessExitedError({ code: 1 }),
    ];

    for (const error of errors) {
      const harness = yield* makeHarness();
      harness.setRequestHandler((method) => {
        switch (method) {
          case "thread/start":
            return Effect.succeed({ thread: { id: "native-thread" } });
          case "turn/start":
            return Effect.fail(error);
          case "thread/unsubscribe":
            return Effect.succeed({ status: "unsubscribed" });
          default:
            return Effect.die(`Unexpected request: ${method}`);
        }
      });
      const generation = yield* makeCodexEndpointStructuredGeneration({
        providerInstanceId: INSTANCE_ID,
        borrowRoutedConnection: harness.borrowRoutedConnection,
        terminalGrace: 0,
      });

      const result = yield* generation.generate(BASE_INPUT).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "endpoint-disconnected");
      }
      assert.equal(harness.getBorrowCount(), 1);
      assert.deepStrictEqual(
        harness.requests.map((request) => request.method),
        ["thread/start", "turn/start", "thread/unsubscribe"],
      );
    }
  }),
);

it.effect(
  "rejects instance mismatches and invalid bounded input before borrowing or requesting",
  () =>
    Effect.gen(function* () {
      const cyclicSchema: Record<string, unknown> = {};
      cyclicSchema.self = cyclicSchema;
      const aggregatePayload = "A".repeat(
        Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES / 4 / 4) * 4 + 4,
      );
      const oversizedImage = `data:image/png;base64,${aggregatePayload}`;
      const cases: ReadonlyArray<CodexEndpointStructuredGenerationInput> = [
        {
          ...BASE_INPUT,
          modelSelection: { ...BASE_INPUT.modelSelection, instanceId: OTHER_INSTANCE_ID },
        },
        { ...BASE_INPUT, workspace: { ...BASE_INPUT.workspace, remotePath: "/srv/../tmp" } },
        {
          ...BASE_INPUT,
          workspace: {
            ...BASE_INPUT.workspace,
            remotePath: `/${"a".repeat(CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_REMOTE_PATH_BYTES)}`,
          },
        },
        {
          ...BASE_INPUT,
          prompt: "x".repeat(CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_PROMPT_CHARS + 1),
        },
        { ...BASE_INPUT, prompt: "界".repeat(100_000) },
        {
          ...BASE_INPUT,
          outputSchema: {
            description: "x".repeat(CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_OUTPUT_SCHEMA_BYTES),
          },
        },
        { ...BASE_INPUT, outputSchema: cyclicSchema },
        { ...BASE_INPUT, imageDataUrls: ["https://example.com/image.png"] },
        {
          ...BASE_INPUT,
          imageDataUrls: Array.from(
            { length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 },
            () => IMAGE_DATA_URL,
          ),
        },
        { ...BASE_INPUT, imageDataUrls: Array.from({ length: 4 }, () => oversizedImage) },
      ];

      for (const input of cases) {
        const harness = yield* makeHarness();
        const generation = yield* makeCodexEndpointStructuredGeneration({
          providerInstanceId: INSTANCE_ID,
          borrowRoutedConnection: harness.borrowRoutedConnection,
        });
        const result = yield* generation.generate(input).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(harness.getBorrowCount(), 0);
        assert.lengthOf(harness.requests, 0);
      }
    }),
);

it.effect("defensively declines every interactive request on the internal route", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const responses: Array<unknown> = [];
    harness.setRequestHandler((method) => {
      switch (method) {
        case "thread/start":
          return Effect.succeed({ thread: { id: "native-thread" } });
        case "turn/start":
          return Effect.gen(function* () {
            responses.push(
              yield* harness.serverRequest("item/commandExecution/requestApproval", {
                itemId: "command",
                startedAtMs: 1,
                threadId: "native-thread",
                turnId: "native-turn",
              }),
              yield* harness.serverRequest("item/fileChange/requestApproval", {
                itemId: "file",
                startedAtMs: 1,
                threadId: "native-thread",
                turnId: "native-turn",
              }),
              yield* harness.serverRequest("item/tool/requestUserInput", {
                itemId: "input",
                questions: [],
                threadId: "native-thread",
                turnId: "native-turn",
              }),
            );
            yield* harness.emitNotification("turn/completed", completedTurn({}));
            return { turn: { id: "native-turn" } };
          });
        case "thread/unsubscribe":
          return Effect.succeed({ status: "unsubscribed" });
        default:
          return Effect.die(`Unexpected request: ${method}`);
      }
    });
    const generation = yield* makeCodexEndpointStructuredGeneration({
      providerInstanceId: INSTANCE_ID,
      borrowRoutedConnection: harness.borrowRoutedConnection,
      terminalGrace: 0,
    });

    yield* generation.generate(BASE_INPUT);
    assert.deepStrictEqual(responses, [
      { decision: "decline" },
      { decision: "decline" },
      { answers: {} },
    ]);
  }),
);

it.effect("interrupts and unsubscribes a known active turn on deadline", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    harness.setRequestHandler((method) => {
      switch (method) {
        case "thread/start":
          return Effect.succeed({ thread: { id: "native-thread" } });
        case "turn/start":
          return Effect.succeed({ turn: { id: "native-turn" } });
        case "turn/interrupt":
          return Effect.succeed({});
        case "thread/unsubscribe":
          return Effect.succeed({ status: "unsubscribed" });
        default:
          return Effect.die(`Unexpected request: ${method}`);
      }
    });
    const generation = yield* makeCodexEndpointStructuredGeneration({
      providerInstanceId: INSTANCE_ID,
      borrowRoutedConnection: harness.borrowRoutedConnection,
      timeout: "1 second",
      terminalGrace: 0,
    });
    const fiber = yield* generation.generate(BASE_INPUT).pipe(Effect.forkChild);
    yield* takeRequest(harness, "turn/start");
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber).pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "timeout");
    assert.deepStrictEqual(
      harness.requests.map((request) => request.method),
      ["thread/start", "turn/start", "turn/interrupt", "thread/unsubscribe"],
    );
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("interrupts and unsubscribes when the caller interrupts the generation fiber", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    harness.setRequestHandler((method) => {
      switch (method) {
        case "thread/start":
          return Effect.succeed({ thread: { id: "native-thread" } });
        case "turn/start":
          return Effect.succeed({ turn: { id: "native-turn" } });
        case "turn/interrupt":
          return Effect.succeed({});
        case "thread/unsubscribe":
          return Effect.succeed({ status: "unsubscribed" });
        default:
          return Effect.die(`Unexpected request: ${method}`);
      }
    });
    const generation = yield* makeCodexEndpointStructuredGeneration({
      providerInstanceId: INSTANCE_ID,
      borrowRoutedConnection: harness.borrowRoutedConnection,
      terminalGrace: 0,
    });
    const fiber = yield* generation.generate(BASE_INPUT).pipe(Effect.forkChild);
    yield* takeRequest(harness, "turn/start");
    yield* Fiber.interrupt(fiber);

    assert.deepStrictEqual(
      harness.requests.map((request) => request.method),
      ["thread/start", "turn/start", "turn/interrupt", "thread/unsubscribe"],
    );
  }),
);

it.effect("fails on disconnect without replaying and cleans up on the fixed borrow", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    harness.setRequestHandler((method) => {
      switch (method) {
        case "thread/start":
          return Effect.succeed({ thread: { id: "native-thread" } });
        case "turn/start":
          return Effect.succeed({ turn: { id: "native-turn" } });
        case "turn/interrupt":
          return Effect.succeed({});
        case "thread/unsubscribe":
          return Effect.succeed({ status: "unsubscribed" });
        default:
          return Effect.die(`Unexpected request: ${method}`);
      }
    });
    const generation = yield* makeCodexEndpointStructuredGeneration({
      providerInstanceId: INSTANCE_ID,
      borrowRoutedConnection: harness.borrowRoutedConnection,
      terminalGrace: 0,
    });
    const fiber = yield* generation.generate(BASE_INPUT).pipe(Effect.forkChild);
    yield* takeRequest(harness, "turn/start");
    yield* harness.terminate();
    const result = yield* Fiber.join(fiber).pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.reason, "endpoint-disconnected");
    }
    assert.equal(harness.getBorrowCount(), 1);
    assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, 1);
    assert.equal(harness.requests.filter((request) => request.method === "turn/start").length, 1);
  }),
);

it.effect("unsubscribes successful work and removes its interactive route", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    installSuccessfulHandler(harness);
    const generation = yield* makeCodexEndpointStructuredGeneration({
      providerInstanceId: INSTANCE_ID,
      borrowRoutedConnection: harness.borrowRoutedConnection,
      terminalGrace: 0,
    });
    yield* generation.generate(BASE_INPUT);

    const removed = yield* harness
      .serverRequest("item/commandExecution/requestApproval", {
        itemId: "late",
        startedAtMs: 1,
        threadId: "native-thread",
        turnId: "native-turn",
      })
      .pipe(Effect.result);
    assert.equal(removed._tag, "Failure");
    assert.equal(
      harness.requests.filter((request) => request.method === "thread/unsubscribe").length,
      1,
    );
  }),
);

it.effect("limits each factory to two simultaneous generations", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const gates: Array<Deferred.Deferred<void>> = [];
    let nextThread = 0;
    let activeThreadStarts = 0;
    let maximumActiveThreadStarts = 0;
    harness.setRequestHandler((method, payload) => {
      switch (method) {
        case "thread/start":
          return Effect.gen(function* () {
            const index = nextThread++;
            const gate = yield* Deferred.make<void>();
            gates.push(gate);
            activeThreadStarts += 1;
            maximumActiveThreadStarts = Math.max(maximumActiveThreadStarts, activeThreadStarts);
            yield* Deferred.await(gate);
            activeThreadStarts -= 1;
            return { thread: { id: `native-thread-${index}` } };
          });
        case "turn/start": {
          const threadId = (payload as { threadId: string }).threadId;
          const turnId = threadId.replace("thread", "turn");
          return harness
            .emitNotification(
              "turn/completed",
              completedTurn({ threadId, turnId, text: '{"title":"Done"}' }),
            )
            .pipe(Effect.as({ turn: { id: turnId } }));
        }
        case "thread/unsubscribe":
          return Effect.succeed({ status: "unsubscribed" });
        default:
          return Effect.die(`Unexpected request: ${method}`);
      }
    });
    const generation = yield* makeCodexEndpointStructuredGeneration({
      providerInstanceId: INSTANCE_ID,
      borrowRoutedConnection: harness.borrowRoutedConnection,
      concurrency: 2,
      terminalGrace: 0,
    });
    const fibers = yield* Effect.forEach([1, 2, 3], (index) =>
      generation
        .generate({ ...BASE_INPUT, prompt: `${BASE_INPUT.prompt} ${index}` })
        .pipe(Effect.forkChild),
    );

    yield* takeRequest(harness, "thread/start");
    yield* takeRequest(harness, "thread/start");
    assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, 2);
    assert.equal(maximumActiveThreadStarts, 2);
    yield* Effect.forEach(gates.slice(0, 2), (gate) => Deferred.succeed(gate, undefined), {
      discard: true,
    });
    yield* takeRequest(harness, "thread/start");
    yield* Deferred.succeed(gates[2]!, undefined);
    yield* Effect.forEach(fibers, Fiber.join, { discard: true });

    assert.equal(maximumActiveThreadStarts, 2);
    assert.equal(harness.getBorrowCount(), 3);
  }),
);
