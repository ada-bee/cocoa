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
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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

type ProbeResponse = "available" | "available-codex-0.146" | "missing" | "malformed";

const DEFAULT_PROBE_RESPONSES: Partial<
  Record<CodexEndpointConnection.CodexEndpointNativeMethod, ProbeResponse>
> = {};

const completeHandshake = Effect.fn("CodexEndpointConnectionTest.completeHandshake")(function* (
  transport: Effect.Success<ReturnType<typeof makeInMemoryTransport>>,
  userAgent: string,
  probeResponses: Partial<
    Record<CodexEndpointConnection.CodexEndpointNativeMethod, ProbeResponse>
  > = DEFAULT_PROBE_RESPONSES,
) {
  const initialize = yield* decodeJson(yield* Queue.take(transport.output));
  yield* Queue.offer(
    transport.input,
    yield* encodeJson({
      id: 1,
      result: initializeResult(userAgent),
    }),
  );
  const initialized = yield* decodeJson(yield* Queue.take(transport.output));
  const probes: Array<unknown> = [];
  for (let index = 0; index < 15; index += 1) {
    const probe = yield* decodeJson(yield* Queue.take(transport.output));
    probes.push(probe);
    const request = probe as {
      readonly id: number;
      readonly method: CodexEndpointConnection.CodexEndpointNativeMethod;
    };
    const response = probeResponses[request.method] ?? "available";
    yield* Queue.offer(
      transport.input,
      yield* encodeJson(
        response === "malformed"
          ? { id: request.id, result: {} }
          : {
              id: request.id,
              error: {
                code:
                  response === "missing"
                    ? -32601
                    : response === "available-codex-0.146"
                      ? -32600
                      : -32602,
                message: response === "missing" ? "method not found" : "invalid params",
              },
            },
      ),
    );
  }
  return { initialize, initialized, probes };
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
      assert.lengthOf(handshake.probes, 15);
      assert.equal(connection.identity.providerInstanceId, PROVIDER_INSTANCE_ID);
      assert.deepEqual(connection.compatibility, {
        userAgent: "codex_cli_rs/0.146.0 extra-data",
        serverVersion: "0.146.0",
        codexHome: "/srv/codex",
        platformFamily: "unix",
        platformOs: "linux",
        versionRelation: "baseline",
        capabilities: {
          conversation: true,
          conversationCatalog: true,
          conversationRead: true,
          conversationMutations: true,
          checkedConversationRollback: true,
          commandExec: true,
          commandExecControl: true,
          methods: {
            "thread/start": "available",
            "thread/resume": "available",
            "thread/list": "available",
            "turn/start": "available",
            "turn/interrupt": "available",
            "thread/read": "available",
            "thread/rollback": "available",
            "thread/archive": "available",
            "thread/unarchive": "available",
            "thread/delete": "available",
            "thread/name/set": "available",
            "command/exec": "available",
            "command/exec/write": "available",
            "command/exec/resize": "available",
            "command/exec/terminate": "available",
          },
        },
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
        ["codex_cli_rs/999.42.7 future-capability", "999.42.7", "newer"],
        ["codex_cli_rs/future-build additive-fields", "future-build", "unknown"],
        ["custom-codex-daemon", undefined, "unknown"],
      ] as const;

      for (const [userAgent, expectedVersion, expectedRelation] of cases) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* makeInMemoryTransport();
            yield* completeHandshake(transport, userAgent).pipe(Effect.forkScoped);
            const connection = yield* makeConnection(transport);
            assert.equal(connection.compatibility.userAgent, userAgent);
            assert.equal(connection.compatibility.serverVersion, expectedVersion);
            assert.equal(connection.compatibility.versionRelation, expectedRelation);
          }),
        );
      }
    }),
  );

  it.effect("keeps older endpoints ready while downgrading missing optional methods", () =>
    Effect.gen(function* () {
      const transport = yield* makeInMemoryTransport();
      yield* completeHandshake(transport, "codex_cli_rs/0.145.0", {
        "thread/rollback": "missing",
        "command/exec/resize": "missing",
      }).pipe(Effect.forkScoped);

      const connection = yield* makeConnection(transport);
      assert.equal(connection.compatibility.versionRelation, "older");
      assert.equal(connection.compatibility.capabilities?.conversationRead, true);
      assert.equal(connection.compatibility.capabilities?.checkedConversationRollback, false);
      assert.equal(connection.compatibility.capabilities?.commandExec, true);
      assert.equal(connection.compatibility.capabilities?.commandExecControl, false);
    }),
  );

  it.effect("accepts Codex 0.146 invalid-request responses as successful method probes", () =>
    Effect.gen(function* () {
      const transport = yield* makeInMemoryTransport();
      yield* completeHandshake(transport, "cocoa_gateway/0.146.0", {
        "thread/start": "available-codex-0.146",
        "thread/read": "available-codex-0.146",
      }).pipe(Effect.forkScoped);

      const connection = yield* makeConnection(transport);
      assert.equal(connection.compatibility.capabilities?.methods["thread/start"], "available");
      assert.equal(connection.compatibility.capabilities?.conversationRead, true);
    }),
  );

  it.effect("rejects generations missing a required thread primitive", () =>
    Effect.gen(function* () {
      const transport = yield* makeInMemoryTransport();
      yield* completeHandshake(transport, "codex_cli_rs/0.146.0", {
        "thread/resume": "missing",
      }).pipe(Effect.forkScoped);

      const error = yield* makeConnection(transport).pipe(Effect.flip);
      assert.instanceOf(error, CodexEndpointConnection.CodexEndpointCompatibilityError);
      assert.equal(error.method, "thread/resume");
      assert.equal(error.reason, "missing");
    }),
  );

  it.effect("rejects malformed required probes and downgrades malformed optional probes", () =>
    Effect.gen(function* () {
      const malformedRequired = yield* makeInMemoryTransport();
      yield* completeHandshake(malformedRequired, "codex_cli_rs/0.146.0", {
        "turn/start": "malformed",
      }).pipe(Effect.forkScoped);
      const requiredError = yield* makeConnection(malformedRequired).pipe(Effect.flip);
      assert.instanceOf(requiredError, CodexEndpointConnection.CodexEndpointCompatibilityError);
      assert.equal(requiredError.method, "turn/start");
      assert.equal(requiredError.reason, "malformed");

      const malformedOptional = yield* makeInMemoryTransport();
      yield* completeHandshake(malformedOptional, "codex_cli_rs/0.146.0", {
        "thread/rollback": "malformed",
        "command/exec": "malformed",
      }).pipe(Effect.forkScoped);
      const connection = yield* makeConnection(malformedOptional);
      assert.equal(connection.compatibility.capabilities?.conversationRead, true);
      assert.equal(connection.compatibility.capabilities?.checkedConversationRollback, false);
      assert.equal(connection.compatibility.capabilities?.commandExec, false);
      assert.equal(connection.compatibility.capabilities?.commandExecControl, false);
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
          yield* Queue.offer(transport.input, yield* encodeJson(response));
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
