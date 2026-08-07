import { assert, describe, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  HostEndpointRpcAuthenticationError,
  HostEndpointRpcCapacityError,
  HostEndpointRpcDisconnectedError,
  HostEndpointRpcTimeoutError,
  type HostEndpointRpcMethodSpec,
  type HostEndpointRpcTransportOpenOptions,
  HostEndpointRpcTransportFailure,
  makeHostEndpointRpcClient,
} from "./HostEndpointRpcClient.ts";
import { decodeHostEndpointJson, encodeHostEndpointJson } from "./HostEndpointRpcWire.ts";

const WorkspaceOpenResponse = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  requestId: Schema.String,
  operation: Schema.Literal("workspace.open"),
  generationId: Schema.String,
  rootId: Schema.String,
  canonicalRoot: Schema.String,
  metadata: Schema.Struct({ kind: Schema.Literal("directory") }),
});
type WorkspaceOpenResponse = typeof WorkspaceOpenResponse.Type;

interface TestContract {
  readonly "workspace.open": HostEndpointRpcMethodSpec<
    { readonly path: string },
    WorkspaceOpenResponse
  >;
}

const decodeWorkspaceOpenResponse = Schema.decodeUnknownEffect(WorkspaceOpenResponse);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  assert.isObject(value);
  assert.isNotArray(value);
  return value as Readonly<Record<string, unknown>>;
};

const makeHarness = Effect.fn("HostEndpointRpcClientTest.makeHarness")(function* () {
  const incoming = yield* Queue.unbounded<
    string,
    HostEndpointRpcTransportFailure | Cause.Done<void>
  >();
  const outgoing = yield* Queue.unbounded<string>();
  const closeCount = yield* Ref.make(0);
  const opens: Array<HostEndpointRpcTransportOpenOptions> = [];

  return {
    incoming,
    outgoing,
    closeCount,
    opens,
    openTransport: (options: HostEndpointRpcTransportOpenOptions) => {
      opens.push(options);
      return Effect.succeed({
        incoming: Stream.fromQueue(incoming),
        send: (frame: string) => Queue.offer(outgoing, frame),
        close: Ref.update(closeCount, (count) => count + 1),
      });
    },
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const offerJson = (harness: Harness, value: unknown) =>
  encodeHostEndpointJson(value).pipe(
    Effect.flatMap((encoded) => Queue.offer(harness.incoming, encoded)),
  );

const takeJson = Effect.fn("HostEndpointRpcClientTest.takeJson")(function* (harness: Harness) {
  return yield* decodeHostEndpointJson(yield* Queue.take(harness.outgoing));
});

const completeHandshake = Effect.fn("HostEndpointRpcClientTest.completeHandshake")(function* (
  harness: Harness,
  generationId = "host-generation-1",
) {
  const request = asRecord(yield* takeJson(harness));
  const requestId = String(request.requestId);
  yield* offerJson(harness, {
    protocol: "cocoa-host-control",
    requestId,
    selectedVersion: 1,
    host: {
      generationId,
      implementation: "cocoa-hostd",
      version: "0.0.32",
      platformFamily: "unix",
      platformOs: "linux",
    },
    capabilities: [],
    providerRelays: [],
  });
  return request;
});

const makeClient = Effect.fn("HostEndpointRpcClientTest.makeClient")(function* (
  harness: Harness,
  options: { readonly maxPendingRequests?: number; readonly requestTimeout?: number } = {},
) {
  const handshakeFiber = yield* completeHandshake(harness).pipe(Effect.forkScoped);
  const client = yield* makeHostEndpointRpcClient<TestContract>({
    url: "ws://host.example/control/v1",
    key: "persisted_random_key",
    client: { name: "cocoa_gateway", version: "0.0.32" },
    openTransport: harness.openTransport,
    ...(options.maxPendingRequests === undefined
      ? {}
      : { maxPendingRequests: options.maxPendingRequests }),
    ...(options.requestTimeout === undefined ? {} : { requestTimeout: options.requestTimeout }),
  });
  const handshake = yield* Fiber.join(handshakeFiber);
  return { client, handshake };
});

describe("HostEndpointRpcClient", () => {
  it.effect("authenticates, handshakes, correlates typed responses, and ignores stale IDs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { client, handshake } = yield* makeClient(harness);

        assert.deepEqual(harness.opens, [
          {
            url: "ws://host.example/control/v1",
            headers: { Authorization: "Bearer persisted_random_key" },
          },
        ]);
        assert.deepEqual(handshake, {
          protocol: "cocoa-host-control",
          requestId: "gateway:1",
          supportedVersions: [1],
          client: { name: "cocoa_gateway", version: "0.0.32" },
        });
        assert.equal(client.generationId, "host-generation-1");

        const responseFiber = yield* client
          .request("workspace.open", { path: "/srv/repo" }, decodeWorkspaceOpenResponse)
          .pipe(Effect.forkChild);
        const request = asRecord(yield* takeJson(harness));
        assert.deepEqual(request, {
          protocolVersion: 1,
          requestId: "gateway:2",
          operation: "workspace.open",
          path: "/srv/repo",
        });

        yield* offerJson(harness, {
          protocolVersion: 1,
          requestId: "gateway:stale",
          operation: "workspace.open",
          generationId: "old-generation",
          rootId: "old-root",
          canonicalRoot: "/old",
          metadata: { kind: "directory" },
        });
        yield* offerJson(harness, {
          protocolVersion: 1,
          requestId: request.requestId,
          operation: "workspace.open",
          generationId: "host-generation-1",
          rootId: "root-1",
          canonicalRoot: "/srv/repo",
          metadata: { kind: "directory" },
        });

        const response = yield* Fiber.join(responseFiber);
        assert.equal(response.rootId, "root-1");
        assert.equal(response.generationId, "host-generation-1");
      }),
    ),
  );

  it.effect("bounds pending requests and fails the exact generation on disconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { client } = yield* makeClient(harness, { maxPendingRequests: 2 });

        const first = yield* client
          .request("workspace.open", { path: "/srv/one" }, decodeWorkspaceOpenResponse)
          .pipe(Effect.forkChild);
        const second = yield* client
          .request("workspace.open", { path: "/srv/two" }, decodeWorkspaceOpenResponse)
          .pipe(Effect.forkChild);
        yield* Queue.take(harness.outgoing);
        yield* Queue.take(harness.outgoing);

        const overflow = yield* client
          .request("workspace.open", { path: "/srv/three" }, decodeWorkspaceOpenResponse)
          .pipe(Effect.result);
        assert.isTrue(overflow._tag === "Failure");
        if (overflow._tag === "Failure") {
          assert.instanceOf(overflow.failure, HostEndpointRpcCapacityError);
          assert.equal(overflow.failure.generationId, "host-generation-1");
          assert.equal(overflow.failure.capacity, 2);
        }

        yield* Queue.end(harness.incoming);
        const [firstExit, secondExit] = yield* Effect.all(
          [Fiber.join(first).pipe(Effect.result), Fiber.join(second).pipe(Effect.result)],
          { concurrency: "unbounded" },
        );
        for (const exit of [firstExit, secondExit]) {
          assert.isTrue(exit._tag === "Failure");
          if (exit._tag === "Failure") {
            assert.instanceOf(exit.failure, HostEndpointRpcDisconnectedError);
            assert.equal(exit.failure.generationId, "host-generation-1");
          }
        }
        assert.equal(yield* Queue.size(harness.outgoing), 0);

        yield* client.close;
        assert.equal(yield* Ref.get(harness.closeCount), 1);
      }),
    ),
  );

  it.effect("removes timed-out requests from the bounded pending set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { client } = yield* makeClient(harness, {
          maxPendingRequests: 1,
          requestTimeout: 10,
        });

        const first = yield* client
          .request("workspace.open", { path: "/srv/one" }, decodeWorkspaceOpenResponse)
          .pipe(Effect.forkChild);
        yield* Queue.take(harness.outgoing);
        yield* TestClock.adjust(11);
        const firstExit = yield* Fiber.join(first).pipe(Effect.result);
        assert.isTrue(firstExit._tag === "Failure");
        if (firstExit._tag === "Failure") {
          assert.instanceOf(firstExit.failure, HostEndpointRpcTimeoutError);
          assert.equal(firstExit.failure.generationId, "host-generation-1");
        }

        const second = yield* client
          .request("workspace.open", { path: "/srv/two" }, decodeWorkspaceOpenResponse)
          .pipe(Effect.forkChild);
        const secondRequest = asRecord(yield* takeJson(harness));
        assert.equal(secondRequest.requestId, "gateway:3");
        yield* Fiber.interrupt(second);
      }),
    ),
  );

  it.effect("rejects invalid bearer credentials before opening a transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opens = 0;
        const result = yield* makeHostEndpointRpcClient<TestContract>({
          url: "ws://host.example/control/v1",
          key: "bad credential",
          client: { name: "cocoa_gateway", version: "0.0.32" },
          openTransport: () => {
            opens += 1;
            return Effect.fail(
              new HostEndpointRpcTransportFailure({
                operation: "open",
                cause: new Error("should not open"),
              }),
            );
          },
        }).pipe(Effect.result);

        assert.equal(opens, 0);
        assert.isTrue(result._tag === "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, HostEndpointRpcAuthenticationError);
        }
      }),
    ),
  );
});
