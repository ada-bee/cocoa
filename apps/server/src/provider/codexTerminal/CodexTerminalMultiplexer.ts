/**
 * Connection-scoped routing for streaming `command/exec` processes.
 *
 * Codex process ids are endpoint-global rather than Cocoa-thread scoped. One
 * multiplexer is installed per Codex connection and routes notifications to
 * registrations that are acquired before their command request is dispatched.
 *
 * @module provider/codexTerminal/CodexTerminalMultiplexer
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexRpc from "effect-codex-app-server/rpc";

export type CodexTerminalOutputDelta =
  CodexRpc.ServerNotificationParamsByMethod["command/exec/outputDelta"];

export type CodexTerminalOutputHandler = (
  notification: CodexTerminalOutputDelta,
) => Effect.Effect<void>;

export class CodexTerminalProcessIdConflictError extends Schema.TaggedErrorClass<CodexTerminalProcessIdConflictError>()(
  "CodexTerminalProcessIdConflictError",
  { processId: Schema.String },
) {
  override get message(): string {
    return `Codex terminal process id '${this.processId}' is already registered.`;
  }
}

export interface CodexTerminalMultiplexerClient {
  readonly handleServerNotification: CodexClient.CodexAppServerClient["Service"]["handleServerNotification"];
}

export interface CodexTerminalMultiplexer {
  readonly register: (
    processId: string,
    handler: CodexTerminalOutputHandler,
  ) => Effect.Effect<void, CodexTerminalProcessIdConflictError, Scope.Scope>;
}

interface ProcessRoute {
  readonly handler: CodexTerminalOutputHandler;
  readonly deliveryLock: Semaphore.Semaphore;
  active: boolean;
}

export const makeCodexTerminalMultiplexer = Effect.fn("CodexTerminalMultiplexer.make")(function* (
  client: CodexTerminalMultiplexerClient,
): Effect.fn.Return<CodexTerminalMultiplexer> {
  const routingLock = yield* Semaphore.make(1);
  const routes = new Map<string, ProcessRoute>();

  const routeNotification = Effect.fn("CodexTerminalMultiplexer.routeNotification")(function* (
    notification: CodexTerminalOutputDelta,
  ) {
    const route = yield* routingLock.withPermits(1)(
      Effect.sync(() => routes.get(notification.processId)),
    );
    if (route === undefined) return;
    yield* route.deliveryLock.withPermits(1)(
      Effect.suspend(() => (route.active ? route.handler(notification) : Effect.void)),
    );
  });

  yield* client.handleServerNotification("command/exec/outputDelta", routeNotification);

  const register: CodexTerminalMultiplexer["register"] = Effect.fn(
    "CodexTerminalMultiplexer.register",
  )(function* (processId, handler) {
    const route: ProcessRoute = {
      handler,
      deliveryLock: yield* Semaphore.make(1),
      active: true,
    };
    yield* Effect.acquireRelease(
      routingLock.withPermits(1)(
        Effect.gen(function* () {
          if (routes.has(processId)) {
            return yield* new CodexTerminalProcessIdConflictError({ processId });
          }
          routes.set(processId, route);
        }),
      ),
      () =>
        route.deliveryLock.withPermits(1)(
          routingLock.withPermits(1)(
            Effect.sync(() => {
              route.active = false;
              if (routes.get(processId) === route) routes.delete(processId);
            }),
          ),
        ),
    );
  });

  return { register };
});
