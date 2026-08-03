import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as CodexEndpointConnection from "./CodexEndpointConnection.ts";

const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const makeInMemoryTransport = Effect.fn("CodexEndpointConnectionTest.makeTransport")(function* () {
  const input = yield* Queue.unbounded<string, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const cleaned = yield* Deferred.make<void>();
  return {
    input,
    output,
    cleaned,
    framedTransport: {
      incoming: Stream.fromQueue(input),
      outgoing: (frames: Stream.Stream<string>) =>
        frames.pipe(
          Stream.runForEach((frame) => Queue.offer(output, frame)),
          Effect.asVoid,
          Effect.ensuring(Deferred.succeed(cleaned, undefined).pipe(Effect.asVoid)),
        ),
    },
  };
});

const initializeResult = (userAgent: string) => ({
  codexHome: "/srv/codex",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent,
});

const completeHandshake = Effect.fn("CodexEndpointConnectionTest.completeHandshake")(function* (
  transport: Effect.Success<ReturnType<typeof makeInMemoryTransport>>,
  userAgent: string,
) {
  const initialize = yield* decodeJson(yield* Queue.take(transport.output));
  yield* Queue.offer(
    transport.input,
    yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({
      id: 1,
      result: initializeResult(userAgent),
    }),
  );
  const initialized = yield* decodeJson(yield* Queue.take(transport.output));
  return { initialize, initialized };
});

const makeConnection = (transport: Effect.Success<ReturnType<typeof makeInMemoryTransport>>) =>
  CodexEndpointConnection.make({
    providerInstanceId: PROVIDER_INSTANCE_ID,
    framedTransport: transport.framedTransport,
  });

describe("CodexEndpointConnection", () => {
  it.effect("performs one initialize/initialized handshake and exposes termination", () =>
    Effect.gen(function* () {
      const transport = yield* makeInMemoryTransport();
      const peer = yield* completeHandshake(transport, "codex_cli_rs/0.146.0 extra-data").pipe(
        Effect.forkScoped,
      );

      const connection = yield* makeConnection(transport);
      const handshake = yield* Fiber.join(peer);

      assert.deepEqual(handshake.initialize, {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "cocoa_gateway",
            title: "Cocoa Gateway",
            version: "0.0.31",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
      });
      assert.deepEqual(handshake.initialized, { method: "initialized" });
      assert.equal(connection.identity.providerInstanceId, PROVIDER_INSTANCE_ID);
      assert.deepEqual(connection.compatibility, {
        userAgent: "codex_cli_rs/0.146.0 extra-data",
        serverVersion: "0.146.0",
        codexHome: "/srv/codex",
        platformFamily: "unix",
        platformOs: "linux",
      });

      yield* Queue.end(transport.input);
      const termination = yield* connection.awaitTermination.pipe(Effect.flip);
      assert.instanceOf(termination, CodexEndpointConnection.CodexEndpointTerminationError);
      assert.equal(termination.providerInstanceId, PROVIDER_INSTANCE_ID);
      assert.equal(termination.cause._tag, "CodexAppServerInputStreamEndedError");
    }),
  );

  it.effect("accepts additive and unknown reported versions as compatibility metadata", () =>
    Effect.gen(function* () {
      const cases = [
        ["codex_cli_rs/999.42.7 future-capability", "999.42.7"],
        ["codex_cli_rs/future-build additive-fields", "future-build"],
        ["custom-codex-daemon", undefined],
      ] as const;

      for (const [userAgent, expectedVersion] of cases) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* makeInMemoryTransport();
            yield* completeHandshake(transport, userAgent).pipe(Effect.forkScoped);
            const connection = yield* makeConnection(transport);
            assert.equal(connection.compatibility.userAgent, userAgent);
            assert.equal(connection.compatibility.serverVersion, expectedVersion);
          }),
        );
      }
    }),
  );

  it.effect("fails malformed and rejected initialize responses and closes their scopes", () =>
    Effect.gen(function* () {
      const responses = [
        { id: 1, result: { userAgent: "codex_cli_rs/0.146.0" } },
        { id: 1, error: { code: -32603, message: "initialize rejected" } },
      ];

      for (const response of responses) {
        const transport = yield* makeInMemoryTransport();
        const peer = yield* Effect.gen(function* () {
          yield* Queue.take(transport.output);
          yield* Queue.offer(
            transport.input,
            yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(response),
          );
        }).pipe(Effect.forkScoped);

        const error = yield* makeConnection(transport).pipe(Effect.flip);
        yield* Fiber.join(peer);
        assert.instanceOf(error, CodexEndpointConnection.CodexEndpointInitializationError);
        assert.equal(error.providerInstanceId, PROVIDER_INSTANCE_ID);
        assert.equal(error.cause._tag, "CodexAppServerRequestError");
        yield* Deferred.await(transport.cleaned);
        assert.equal(yield* Queue.size(transport.output), 0);
      }
    }),
  );

  it.effect("times out initialization and closes the incomplete connection", () =>
    Effect.gen(function* () {
      const transport = yield* makeInMemoryTransport();
      const pending = yield* makeConnection(transport).pipe(Effect.flip, Effect.forkScoped);

      const initialize = yield* decodeJson(yield* Queue.take(transport.output));
      assert.deepInclude(initialize, { method: "initialize" });
      yield* TestClock.adjust(CodexEndpointConnection.CODEX_ENDPOINT_INITIALIZE_TIMEOUT);

      const error = yield* Fiber.join(pending);
      assert.instanceOf(error, CodexEndpointConnection.CodexEndpointInitializationTimeoutError);
      assert.equal(error.providerInstanceId, PROVIDER_INSTANCE_ID);
      yield* Deferred.await(transport.cleaned);
      assert.equal(yield* Queue.size(transport.output), 0);
    }),
  );

  it.effect("keeps the owned transport alive until the parent connection scope closes", () =>
    Effect.gen(function* () {
      const transport = yield* makeInMemoryTransport();
      const parentScope = yield* Scope.make("sequential");
      const peer = yield* completeHandshake(transport, "codex_cli_rs/0.146.0").pipe(
        Effect.forkScoped,
      );

      yield* makeConnection(transport).pipe(Effect.provideService(Scope.Scope, parentScope));
      yield* Fiber.join(peer);
      assert.isFalse(yield* Deferred.isDone(transport.cleaned));

      yield* Scope.close(parentScope, Exit.void);
      yield* Deferred.await(transport.cleaned);
      assert.isTrue(yield* Deferred.isDone(transport.cleaned));
    }),
  );
});
