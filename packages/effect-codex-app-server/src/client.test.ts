import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const makeInMemoryFramedTransport = Effect.fn("makeInMemoryFramedClientTransport")(function* () {
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

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peerCwd = path.join(import.meta.dirname, "..");
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: peerCwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("runs typed requests and responses over whole-message frames", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const client = yield* CodexClient.makeFramed(frames);

      const pending = yield* client
        .request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-framed-test",
            title: "Effect Codex App Server Framed Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        })
        .pipe(Effect.forkScoped);

      assert.deepEqual(yield* decodeJson(yield* Queue.take(frames.output)), {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "effect-codex-app-server-framed-test",
            title: "Effect Codex App Server Framed Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        },
      });

      yield* Queue.offer(
        frames.input,
        '{"id":1,"result":{"codexHome":"/tmp/codex-home","platformFamily":"unix","platformOs":"linux","userAgent":"framed-codex-app-server"}}',
      );

      assert.deepEqual(yield* Fiber.join(pending), {
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "framed-codex-app-server",
      });
    }),
  );

  it.effect("dispatches typed notifications and server requests through the framed layer", () =>
    Effect.gen(function* () {
      const frames = yield* makeInMemoryFramedTransport();
      const notification = yield* Deferred.make<unknown>();
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(CodexClient.layerFramed(frames), scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Deferred.succeed(notification, payload).pipe(Effect.asVoid),
        );
        yield* client.handleServerRequest("item/tool/requestUserInput", () =>
          Effect.succeed({
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          }),
        );

        yield* Queue.offer(
          frames.input,
          '{"method":"item/agentMessage/delta","params":{"delta":"hello","itemId":"item-1","threadId":"thread-1","turnId":"turn-1"}}',
        );
        yield* Queue.offer(
          frames.input,
          '{"id":77,"method":"item/tool/requestUserInput","params":{"itemId":"item-approval-1","threadId":"thread-1","turnId":"turn-1","questions":[{"id":"approved","header":"Approve","question":"Continue?"}]}}',
        );

        return {
          observed: yield* Deferred.await(notification),
          response: yield* Queue.take(frames.output),
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.deepEqual(result.observed, {
        delta: "hello",
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
      });
      assert.deepEqual(yield* decodeJson(result.response), {
        id: 77,
        result: {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        },
      });
    }),
  );

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const path = yield* Path.Path;
        const peerCwd = path.join(import.meta.dirname, "..");
        const skills = yield* client.request("skills/list", { cwds: [peerCwd] });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, peerCwd);

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );
  it.effect("drains child stderr so large diagnostics cannot block protocol responses", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STDERR_BYTES: String(512 * 1024),
      });
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );
});
