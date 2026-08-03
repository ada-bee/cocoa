import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";

import {
  type CodexTerminalOutputDelta,
  makeCodexTerminalMultiplexer,
} from "./CodexTerminalMultiplexer.ts";

type NotificationHandler = (
  notification: CodexTerminalOutputDelta,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;

function makeFakeClient() {
  let installed = 0;
  let outputHandler: NotificationHandler | undefined;
  const handleServerNotification = ((method: string, handler: NotificationHandler) =>
    Effect.sync(() => {
      assert.strictEqual(method, "command/exec/outputDelta");
      installed += 1;
      outputHandler = handler;
    })) as CodexClient.CodexAppServerClient["Service"]["handleServerNotification"];

  return {
    client: { handleServerNotification },
    installed: () => installed,
    emit: (notification: CodexTerminalOutputDelta) => {
      assert.isDefined(outputHandler);
      return outputHandler(notification);
    },
  };
}

function notification(processId: string, deltaBase64: string): CodexTerminalOutputDelta {
  return { processId, deltaBase64, stream: "stdout", capReached: false };
}

it.effect("routes interleaved endpoint-global process ids to isolated registrations", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const multiplexer = yield* makeCodexTerminalMultiplexer(fake.client);
    const first: Array<string> = [];
    const second: Array<string> = [];

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* multiplexer.register("process-a", (event) =>
          Effect.sync(() => first.push(event.deltaBase64)),
        );
        yield* multiplexer.register("process-b", (event) =>
          Effect.sync(() => second.push(event.deltaBase64)),
        );

        yield* fake.emit(notification("process-b", "b1"));
        yield* fake.emit(notification("process-a", "a1"));
        yield* fake.emit(notification("unknown", "ignored"));
        yield* fake.emit(notification("process-b", "b2"));
      }),
    );

    assert.strictEqual(fake.installed(), 1);
    assert.deepStrictEqual(first, ["a1"]);
    assert.deepStrictEqual(second, ["b1", "b2"]);
  }),
);

it.effect("rejects duplicate live process ids and unregisters routes with their scope", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const multiplexer = yield* makeCodexTerminalMultiplexer(fake.client);
    const delivered: Array<string> = [];

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* multiplexer.register("process-a", (event) =>
          Effect.sync(() => delivered.push(event.deltaBase64)),
        );
        const conflict = yield* multiplexer
          .register("process-a", () => Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(conflict._tag, "CodexTerminalProcessIdConflictError");
        assert.strictEqual(conflict.processId, "process-a");
        yield* fake.emit(notification("process-a", "before-close"));
      }),
    );

    yield* fake.emit(notification("process-a", "after-close"));
    assert.deepStrictEqual(delivered, ["before-close"]);
  }),
);

it.effect("serializes output delivery for one process route", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const multiplexer = yield* makeCodexTerminalMultiplexer(fake.client);
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const delivered: Array<string> = [];

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* multiplexer.register("process-a", (event) =>
          Effect.gen(function* () {
            delivered.push(event.deltaBase64);
            if (event.deltaBase64 === "first") {
              yield* Deferred.succeed(firstEntered, undefined);
              yield* Deferred.await(releaseFirst);
            }
          }),
        );

        const first = yield* fake
          .emit(notification("process-a", "first"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(firstEntered);
        const second = yield* fake
          .emit(notification("process-a", "second"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.deepStrictEqual(delivered, ["first"]);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );

    assert.deepStrictEqual(delivered, ["first", "second"]);
  }),
);
