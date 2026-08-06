import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import * as CodexRpc from "./rpc.ts";
import * as CodexSchema from "./schema.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

const decodeJson = Schema.decodeEffect(Schema.UnknownFromJsonString);
const decodeAccountTokenUsageResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
);
const decodeAccountRateLimitsResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
);
const decodeConsumeRateLimitResetCreditParams = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_PARAMS["account/rateLimitResetCredit/consume"],
);
const decodeConsumeRateLimitResetCreditResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimitResetCredit/consume"],
);

const makeInMemoryFramedTransport = Effect.fn("makeInMemoryFramedTransport")(function* () {
  const input = yield* Queue.unbounded<string, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  return {
    input,
    output,
    incoming: Stream.fromQueue(input),
    outgoing: (frames: Stream.Stream<string>) =>
      frames.pipe(
        Stream.runForEach((frame) => Queue.offer(output, frame)),
        Effect.asVoid,
      ),
  };
});

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect("maps account usage responses to the upstream token usage schema", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
        CodexSchema.V2GetAccountTokenUsageResponse,
      );
      const decoded = yield* decodeAccountTokenUsageResponse({
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
      assert.deepEqual(decoded, {
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
    }),
  );

  it.effect("maps earned rate-limit reset credits from account rate-limit snapshots", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
        CodexSchema.V2GetAccountRateLimitsResponse,
      );

      const response = {
        rateLimits: {},
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              id: "RateLimitResetCredit_1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_781_654_400,
              expiresAt: 1_784_246_400,
              title: "Full reset",
              description: "Ready to redeem",
            },
            {
              id: "RateLimitResetCredit_2",
              resetType: "unknown",
              status: "unknown",
              grantedAt: 1_781_654_401,
              expiresAt: null,
            },
          ],
        },
      } as const;

      assert.deepEqual(yield* decodeAccountRateLimitsResponse(response), response);
      assert.deepEqual(
        yield* decodeAccountRateLimitsResponse({
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        }),
        {
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        },
      );
    }),
  );

  it.effect("maps the earned rate-limit reset consume request and response", () =>
    Effect.gen(function* () {
      assert.equal(
        CodexRpc.CLIENT_REQUEST_METHODS["account/rateLimitResetCredit/consume"],
        "account/rateLimitResetCredit/consume",
      );
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_PARAMS["account/rateLimitResetCredit/consume"],
        CodexSchema.V2ConsumeAccountRateLimitResetCreditParams,
      );
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimitResetCredit/consume"],
        CodexSchema.V2ConsumeAccountRateLimitResetCreditResponse,
      );

      assert.deepEqual(
        yield* decodeConsumeRateLimitResetCreditParams({
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          creditId: "RateLimitResetCredit_1",
        }),
        {
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          creditId: "RateLimitResetCredit_1",
        },
      );
      assert.deepEqual(yield* decodeConsumeRateLimitResetCreditResponse({ outcome: "reset" }), {
        outcome: "reset",
      });
    }),
  );

  it.effect(
    "encodes requests without a jsonrpc field and routes inbound requests and notifications",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

        const notificationDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingNotification>>();
        const requestDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingRequest>>();

        yield* transport.incomingNotifications.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((notifications) => Deferred.succeed(notificationDeferred, notifications)),
          Effect.forkScoped,
        );

        yield* transport.incomingRequests.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((requests) => Deferred.succeed(requestDeferred, requests)),
          Effect.forkScoped,
        );

        yield* transport.notify("initialized");
        assert.equal(yield* Queue.take(output), '{"method":"initialized"}\n');

        const initializeParams = {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        };

        const pendingInitialize = yield* transport
          .request("initialize", initializeParams)
          .pipe(Effect.forkScoped);
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 1,
          method: "initialize",
          params: initializeParams,
        });

        yield* Queue.offer(
          input,
          encodeJsonl({
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 1,
            result: {
              userAgent: "mock-codex-app-server",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );

        assert.deepEqual(yield* Fiber.join(pendingInitialize), {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        assert.deepEqual(yield* Deferred.await(notificationDeferred), [
          {
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        ]);
        assert.deepEqual(yield* Deferred.await(requestDeferred), [
          {
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          },
        ]);

        yield* transport.respond(77, {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        });
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 77,
          result: {
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          },
        });

        yield* transport.respondError(
          78,
          CodexError.CodexAppServerRequestError.methodNotFound("x/test"),
        );
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 78,
          error: {
            code: -32601,
            message: "Method not found: x/test",
          },
        });
      }),
  );

  it.effect("surfaces JSON encoding failures as protocol parse errors", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(bigintError.operation, "encode-wire-message");
      assert.equal(bigintError.method, "x/test");
      assert.exists(bigintError.cause);
      assert.equal(
        bigintError.message,
        "Codex App Server protocol operation 'encode-wire-message' failed for method 'x/test'.",
      );

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(circularError.operation, "encode-wire-message");
      assert.equal(circularError.method, "x/test");
      assert.exists(circularError.cause);

      const requestError = yield* transport.request("x/request", 1n).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected request encoding to fail"),
        }),
      );
      assert.instanceOf(requestError, CodexError.CodexAppServerProtocolParseError);
      assert.deepInclude(requestError, {
        operation: "encode-wire-message",
        method: "x/request",
        requestId: "1",
      });
    }),
  );

  it.effect("correlates response errors with the originating request", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const response = yield* transport.request("thread/start", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          error: {
            code: -32602,
            message: "Invalid params",
            data: { field: "cwd" },
          },
        }),
      );

      const error = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected Codex App Server request to fail"),
        }),
      );
      assert.instanceOf(error, CodexError.CodexAppServerRequestError);
      assert.deepInclude(error, {
        code: -32602,
        errorMessage: "Invalid params",
        method: "thread/start",
        requestId: "1",
        operation: "receive-response",
      });
    }),
  );

  it.effect("logs decode failures without copying the cause or wire payload", () =>
    Effect.gen(function* () {
      const secret = "codex-wire-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const events: Array<CodexProtocol.CodexAppServerProtocolLogEvent> = [];
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        logIncoming: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(input, encoder.encode(`{"secret":"${secret}"\n`));
      yield* Deferred.await(termination);

      const event = events.find(({ stage }) => stage === "decode_failed");
      assert.exists(event);
      assert.equal(event.direction, "incoming");
      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.operation, "decode-wire-message");
      assert.isNumber(payload.issueCount);
      assert.isArray(payload.issueKinds);
      assert.isNumber(payload.maximumPathDepth);
      assert.equal("cause" in payload, false);
      assert.equal("detail" in payload, false);
      assert.notInclude(encodeUnknownJsonString(event), secret);
    }),
  );

  it.effect("describes unroutable messages with safe structural diagnostics", () =>
    Effect.gen(function* () {
      const secret = "codex-unroutable-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encodeJsonl({ id: true, method: "thread/start", params: { token: secret } }),
      );

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerProtocolParseError);
      assert.deepInclude(error, {
        operation: "route-wire-message",
        method: "thread/start",
        payloadKind: "object",
        presentFields: ["id", "method", "params"],
      });
      assert.isUndefined(error.requestId);
      assert.notProperty(error, "detail");
      assert.notProperty(error, "cause");
      assert.notInclude(error.message, secret);
    }),
  );

  it.effect("classifies an input stream ending without inventing a cause", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.end(input);

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerInputStreamEndedError);
      assert.equal(error.message, "Codex App Server input stream ended.");
      assert.equal("cause" in error, false);
    }),
  );

  it.effect("exchanges whole JSON messages without adding JSONL delimiters", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol(frames);

      const pending = yield* transport
        .request("initialize", { clientInfo: {} })
        .pipe(Effect.forkScoped);
      assert.equal(
        yield* Queue.take(frames.output),
        '{"id":1,"method":"initialize","params":{"clientInfo":{}}}',
      );

      yield* Queue.offer(frames.input, '{"id":1,"result":{"userAgent":"framed-codex-app-server"}}');
      assert.deepEqual(yield* Fiber.join(pending), {
        userAgent: "framed-codex-app-server",
      });

      yield* transport.notify("initialized");
      assert.equal(yield* Queue.take(frames.output), '{"method":"initialized"}');
    }),
  );

  it.effect("backpressures a full outgoing frame buffer without losing frames", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const startConsuming = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        incoming: frames.incoming,
        outgoing: (outgoing) =>
          Deferred.await(startConsuming).pipe(
            Effect.flatMap(() =>
              outgoing.pipe(
                Stream.runForEach((frame) => Queue.offer(frames.output, frame)),
                Effect.asVoid,
              ),
            ),
          ),
      });

      const bufferedFrameCount = 256;
      for (let index = 0; index < bufferedFrameCount; index += 1) {
        yield* transport.notify(`message-${index}`);
      }

      const backpressured = yield* transport
        .notify(`message-${bufferedFrameCount}`)
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(backpressured.pollUnsafe());

      yield* Deferred.succeed(startConsuming, undefined);
      yield* Fiber.join(backpressured);

      const emitted = yield* Effect.forEach(Array.from({ length: bufferedFrameCount + 1 }), () =>
        Queue.take(frames.output),
      );
      assert.deepEqual(
        emitted,
        Array.from(
          { length: bufferedFrameCount + 1 },
          (_, index) => `{"method":"message-${index}"}`,
        ),
      );
    }),
  );

  it.effect("rejects requests beyond the finite in-flight correlation limit", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        clientRequests: { maxInFlight: 1 },
      });

      const first = yield* transport
        .request("thread/read", { threadId: "thread-1" }, { timeoutMs: null })
        .pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(frames.output)), {
        id: 1,
        method: "thread/read",
        params: { threadId: "thread-1" },
      });

      const error = yield* transport
        .request("thread/read", { threadId: "thread-2" }, { timeoutMs: null })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => assert.fail("Expected the saturated request to fail"),
          }),
        );
      assert.instanceOf(error, CodexError.CodexAppServerRequestCapacityError);
      assert.deepInclude(error, {
        method: "thread/read",
        maxInFlight: 1,
      });
      assert.equal(yield* Queue.size(frames.output), 0);

      yield* Queue.offer(frames.input, '{"id":1,"result":{"thread":{"id":"thread-1"}}}');
      assert.deepEqual(yield* Fiber.join(first), { thread: { id: "thread-1" } });
    }),
  );

  it.effect("removes timed-out correlations and ignores their late responses", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        clientRequests: { maxInFlight: 1 },
      });

      const timedOut = yield* transport
        .request("thread/read", { threadId: "thread-1" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(frames.output);
      yield* TestClock.adjust(
        Duration.millis(CodexProtocol.DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS),
      );

      const error = yield* Fiber.join(timedOut).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the request to time out"),
        }),
      );
      assert.instanceOf(error, CodexError.CodexAppServerRequestTimeoutError);
      assert.deepInclude(error, {
        method: "thread/read",
        requestId: "1",
        timeoutMs: CodexProtocol.DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
      });

      yield* Queue.offer(frames.input, '{"id":1,"result":{"thread":{"id":"late"}}}');
      const next = yield* transport
        .request("thread/read", { threadId: "thread-2" }, { timeoutMs: null })
        .pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(frames.output)), {
        id: 2,
        method: "thread/read",
        params: { threadId: "thread-2" },
      });
      yield* Queue.offer(frames.input, '{"id":2,"result":{"thread":{"id":"thread-2"}}}');
      assert.deepEqual(yield* Fiber.join(next), { thread: { id: "thread-2" } });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("never replays a mutating request after its response deadline", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        clientRequests: { defaultTimeoutMs: 1_000 },
      });

      const request = yield* transport
        .request("turn/start", { threadId: "thread-1", input: [] })
        .pipe(Effect.forkScoped);
      const onlyFrame = yield* Queue.take(frames.output);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(request).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the mutating request to time out"),
        }),
      );

      assert.instanceOf(error, CodexError.CodexAppServerRequestTimeoutError);
      assert.deepEqual(yield* decodeJson(onlyFrame), {
        id: 1,
        method: "turn/start",
        params: { threadId: "thread-1", input: [] },
      });
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.size(frames.output), 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("allows an explicit no-timeout override only at the request callsite", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        clientRequests: { defaultTimeoutMs: 1_000 },
      });

      const longLived = yield* transport
        .request("command/exec", { disableTimeout: true }, { timeoutMs: null })
        .pipe(Effect.forkScoped);
      yield* Queue.take(frames.output);
      yield* TestClock.adjust("1 hour");
      assert.isUndefined(longLived.pollUnsafe());

      yield* Queue.offer(frames.input, '{"id":1,"result":{"exitCode":0}}');
      assert.deepEqual(yield* Fiber.join(longLived), { exitCode: 0 });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("continues reading frames while a server-request handler is waiting", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const handlerStarted = yield* Deferred.make<void>();
      const releaseHandler = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        onRequest: () =>
          Deferred.succeed(handlerStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseHandler)),
            Effect.as({ approved: true }),
          ),
      });

      const pending = yield* transport
        .request("thread/read", { threadId: "thread-1" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(frames.output);

      yield* Queue.offer(
        frames.input,
        '{"id":77,"method":"item/tool/requestUserInput","params":{}}',
      );
      yield* Deferred.await(handlerStarted);
      yield* Queue.offer(frames.input, '{"id":1,"result":{"thread":{"id":"thread-1"}}}');

      assert.deepEqual(yield* Fiber.join(pending), {
        thread: { id: "thread-1" },
      });

      yield* Deferred.succeed(releaseHandler, undefined);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(frames.output)), {
        id: 77,
        result: { approved: true },
      });
    }),
  );

  it.effect("bounds inbound server-request admission and reports overflow", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const started = yield* Queue.unbounded<string | number>();
      const release = yield* Queue.unbounded<void>();
      yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        inboundRequests: { maxConcurrent: 1, queueCapacity: 1 },
        onRequest: (request) =>
          Queue.offer(started, request.id).pipe(
            Effect.andThen(Queue.take(release)),
            Effect.as({ approved: true }),
          ),
      });

      yield* Queue.offer(frames.input, '{"id":71,"method":"approval/one"}');
      assert.equal(yield* Queue.take(started), 71);
      yield* Queue.offer(frames.input, '{"id":72,"method":"approval/two"}');
      yield* Queue.offer(frames.input, '{"id":73,"method":"approval/three"}');

      assert.deepEqual(yield* decodeJson(yield* Queue.take(frames.output)), {
        id: 73,
        error: {
          code: -32001,
          message: "Codex App Server client is at its inbound request capacity.",
          data: { maxConcurrent: 1, queueCapacity: 1 },
        },
      });

      yield* Queue.offer(release, undefined);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(frames.output)), {
        id: 71,
        result: { approved: true },
      });
      assert.equal(yield* Queue.take(started), 72);
      yield* Queue.offer(release, undefined);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(frames.output)), {
        id: 72,
        result: { approved: true },
      });
    }),
  );

  it.effect("interrupts active inbound handlers when the transport terminates", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const handlerStarted = yield* Deferred.make<void>();
      const handlerInterrupted = yield* Deferred.make<void>();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        inboundRequests: { maxConcurrent: 1, queueCapacity: 1 },
        onRequest: () =>
          Deferred.succeed(handlerStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(handlerInterrupted, undefined)),
          ),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(frames.input, '{"id":77,"method":"approval/wait"}');
      yield* Deferred.await(handlerStarted);
      yield* Queue.end(frames.input);

      assert.instanceOf(
        yield* Deferred.await(termination),
        CodexError.CodexAppServerInputStreamEndedError,
      );
      yield* Deferred.await(handlerInterrupted);
      assert.equal(yield* Queue.size(frames.output), 0);
    }),
  );

  it.effect("fails pending requests when a framed transport disconnects", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol(frames);
      const pending = yield* transport
        .request("thread/read", { threadId: "thread-1" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(frames.output);

      yield* Queue.end(frames.input);

      const error = yield* Fiber.join(pending).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the pending request to fail"),
        }),
      );
      assert.instanceOf(error, CodexError.CodexAppServerInputStreamEndedError);
    }),
  );

  it.effect("fails new requests and notifications after transport termination", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.end(frames.input);
      const terminalError = yield* Deferred.await(termination);

      const requestError = yield* transport.request("thread/read", { threadId: "thread-1" }).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the post-termination request to fail"),
        }),
      );
      const notificationError = yield* transport.notify("initialized").pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the post-termination notification to fail"),
        }),
      );

      assert.strictEqual(requestError, terminalError);
      assert.strictEqual(notificationError, terminalError);
    }),
  );

  it.effect("terminates when the framed output sink completes", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const outputCompleted = yield* Deferred.make<void>();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        incoming: frames.incoming,
        outgoing: () => Deferred.await(outputCompleted),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      const pending = yield* transport
        .request("thread/read", { threadId: "thread-1" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(outputCompleted, undefined);

      const terminalError = yield* Deferred.await(termination);
      assert.instanceOf(terminalError, CodexError.CodexAppServerTransportError);
      assert.equal(terminalError.operation, "write-output-stream");

      const requestError = yield* Fiber.join(pending).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the pending request to fail"),
        }),
      );
      assert.strictEqual(requestError, terminalError);
    }),
  );

  it.effect("observes raw messages with the bounded default capacity", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const handled = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        onNotification: () => Deferred.succeed(handled, undefined).pipe(Effect.asVoid),
      });

      const observed = yield* transport.incomingNotifications.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* Queue.offer(frames.input, '{"method":"thread/started","params":{}}');
      yield* Deferred.await(handled);

      assert.deepEqual(
        (yield* Fiber.join(observed)).map(({ method }) => method),
        ["thread/started"],
      );
    }),
  );

  it.effect("drops raw observations beyond the configured per-observer capacity", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const firstObserved = yield* Deferred.make<void>();
      const releaseObserver = yield* Deferred.make<void>();
      const thirdHandled = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerFramedProtocol({
        ...frames,
        rawObservation: { capacity: 1 },
        onNotification: (notification) =>
          notification.method === "three"
            ? Deferred.succeed(thirdHandled, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });

      const observed = yield* transport.incomingNotifications.pipe(
        Stream.take(2),
        Stream.mapEffect((notification) =>
          notification.method === "one"
            ? Deferred.succeed(firstObserved, undefined).pipe(
                Effect.andThen(Deferred.await(releaseObserver)),
                Effect.as(notification),
              )
            : Effect.succeed(notification),
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(frames.input, '{"method":"one"}');
      yield* Deferred.await(firstObserved);
      yield* Queue.offer(frames.input, '{"method":"two"}');
      yield* Queue.offer(frames.input, '{"method":"three"}');
      yield* Deferred.await(thirdHandled);
      yield* Deferred.succeed(releaseObserver, undefined);

      assert.deepEqual(
        (yield* Fiber.join(observed)).map(({ method }) => method),
        ["one", "two"],
      );
    }),
  );
});
