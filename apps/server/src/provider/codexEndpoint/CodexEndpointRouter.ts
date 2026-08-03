/**
 * Routes one shared, initialized Codex app-server client to scoped Cocoa sessions.
 *
 * Notifications which arrive before a native thread is bound retain the newest
 * `unboundNotificationBacklogCapacity` entries for that native thread. Older entries are dropped.
 * The number of native-thread backlog buckets is also bounded; the oldest bucket is evicted first.
 *
 * @module CodexEndpointRouter
 */
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

const DEFAULT_UNBOUND_NOTIFICATION_BACKLOG_CAPACITY = 32;
const DEFAULT_UNBOUND_NATIVE_THREAD_CAPACITY = 128;
const DEFAULT_SESSION_NOTIFICATION_CAPACITY = 256;
const DEFAULT_COLLABORATION_CHILD_ALIAS_CAPACITY = 256;

export const CODEX_INTERACTIVE_SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
] as const satisfies ReadonlyArray<CodexRpc.ServerRequestMethod>;

export type CodexInteractiveServerRequestMethod =
  (typeof CODEX_INTERACTIVE_SERVER_REQUEST_METHODS)[number];

export type CodexEndpointNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

interface RoutedNotification {
  readonly method: string;
  readonly params: unknown;
  readonly known: boolean;
}

export interface CodexEndpointSessionCallbacks {
  readonly onNotification: <M extends CodexRpc.ServerNotificationMethod>(
    method: M,
    params: CodexRpc.ServerNotificationParamsByMethod[M],
  ) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
  readonly onUnknownNotification?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
  readonly onRequest: <M extends CodexInteractiveServerRequestMethod>(
    method: M,
    params: CodexRpc.ServerRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ServerRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export interface CodexEndpointRouterClient {
  readonly handleServerNotification: CodexClient.CodexAppServerClient["Service"]["handleServerNotification"];
  readonly handleServerRequest: CodexClient.CodexAppServerClient["Service"]["handleServerRequest"];
  readonly handleUnknownServerNotification: CodexClient.CodexAppServerClient["Service"]["handleUnknownServerNotification"];
}

export interface CodexEndpointRouterOptions {
  /** Per-native-thread backlog. The newest entries win when full. */
  readonly unboundNotificationBacklogCapacity?: number;
  /** Maximum number of unbound native-thread backlog buckets. The oldest bucket is evicted. */
  readonly unboundNativeThreadCapacity?: number;
  /** Per-session delivery mailbox. New notifications are dropped when a slow callback fills it. */
  readonly sessionNotificationCapacity?: number;
  /**
   * Maximum collaboration-child aliases retained per session. The oldest alias is evicted when
   * full; the session's directly bound primary native thread is never evicted.
   */
  readonly collaborationChildAliasCapacity?: number;
}

export class CodexEndpointRouterRegistrationError extends Schema.TaggedErrorClass<CodexEndpointRouterRegistrationError>()(
  "CodexEndpointRouterRegistrationError",
  {
    reason: Schema.Literals([
      "duplicate-session",
      "session-not-registered",
      "session-already-bound",
      "native-thread-already-bound",
    ]),
    threadId: ThreadId,
    nativeThreadId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const nativeThread =
      this.nativeThreadId === undefined ? "" : ` and native thread '${this.nativeThreadId}'`;
    return `Codex endpoint session routing failed for Cocoa thread '${this.threadId}'${nativeThread}: ${this.reason}.`;
  }
}

interface SessionEntry {
  readonly threadId: ThreadId;
  readonly callbacks: CodexEndpointSessionCallbacks;
  readonly notifications: Queue.Queue<RoutedNotification>;
  readonly childAliases: Set<string>;
  nativeThreadId: string | undefined;
}

interface RouterState {
  readonly sessions: Map<ThreadId, SessionEntry>;
  readonly sessionsByNativeThreadId: Map<string, SessionEntry>;
  readonly notificationBacklogs: Map<string, Array<RoutedNotification>>;
}

export interface CodexEndpointSessionRegistration {
  readonly bindNativeThreadId: (
    nativeThreadId: string,
  ) => Effect.Effect<void, CodexEndpointRouterRegistrationError>;
  /** Atomically move this session from its current native thread to a fresh one. */
  readonly rebindNativeThreadId: (
    nativeThreadId: string,
  ) => Effect.Effect<void, CodexEndpointRouterRegistrationError>;
}

export interface CodexEndpointRouter {
  readonly registerSession: (input: {
    readonly threadId: ThreadId;
    readonly callbacks: CodexEndpointSessionCallbacks;
  }) => Effect.Effect<
    CodexEndpointSessionRegistration,
    CodexEndpointRouterRegistrationError,
    Scope.Scope
  >;
}

function normalizeCapacity(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function readNotificationThreadId(notification: RoutedNotification): string | undefined {
  const params = notification.params;
  if (typeof params !== "object" || params === null) return undefined;
  if (notification.method === "thread/started") {
    if (!("thread" in params) || typeof params.thread !== "object" || params.thread === null) {
      return undefined;
    }
    return "id" in params.thread && typeof params.thread.id === "string"
      ? params.thread.id
      : undefined;
  }
  return "threadId" in params && typeof params.threadId === "string" ? params.threadId : undefined;
}

function readThreadStartedParentId(notification: RoutedNotification): string | undefined {
  if (notification.method !== "thread/started") return undefined;
  const params = notification.params;
  if (
    typeof params !== "object" ||
    params === null ||
    !("thread" in params) ||
    typeof params.thread !== "object" ||
    params.thread === null
  ) {
    return undefined;
  }
  const thread = params.thread;
  if ("parentThreadId" in thread && typeof thread.parentThreadId === "string") {
    return thread.parentThreadId;
  }
  if (!("source" in thread) || typeof thread.source !== "object" || thread.source === null) {
    return undefined;
  }
  const source = thread.source;
  if (!("subAgent" in source) || typeof source.subAgent !== "object" || source.subAgent === null) {
    return undefined;
  }
  const subAgent = source.subAgent;
  if ("parent_thread_id" in subAgent && typeof subAgent.parent_thread_id === "string") {
    return subAgent.parent_thread_id;
  }
  if (
    "thread_spawn" in subAgent &&
    typeof subAgent.thread_spawn === "object" &&
    subAgent.thread_spawn !== null &&
    "parent_thread_id" in subAgent.thread_spawn &&
    typeof subAgent.thread_spawn.parent_thread_id === "string"
  ) {
    return subAgent.thread_spawn.parent_thread_id;
  }
  return undefined;
}

function makeNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexEndpointNotification {
  return { method, params } as CodexEndpointNotification;
}

function deliverNotification(
  session: SessionEntry,
  notification: RoutedNotification,
): Effect.Effect<void, CodexErrors.CodexAppServerError> {
  if (!notification.known) {
    return (
      session.callbacks.onUnknownNotification?.(notification.method, notification.params) ??
      Effect.void
    );
  }
  return session.callbacks.onNotification(
    notification.method as never,
    notification.params as never,
  );
}

function deliverRequest<M extends CodexInteractiveServerRequestMethod>(
  session: SessionEntry,
  method: M,
  params: CodexRpc.ServerRequestParamsByMethod[M],
): Effect.Effect<CodexRpc.ServerRequestResponsesByMethod[M], CodexErrors.CodexAppServerError> {
  return session.callbacks.onRequest(method, params);
}

function requestRoutingError(
  method: CodexInteractiveServerRequestMethod,
  nativeThreadId: string,
  turnId: string,
): CodexErrors.CodexAppServerRequestError {
  return CodexErrors.CodexAppServerRequestError.internalError(
    `No active Cocoa session route for Codex request '${method}', native thread '${nativeThreadId}', and turn '${turnId}'.`,
    { nativeThreadId, turnId },
    { method, operation: "handle-request" },
  );
}

export const makeCodexEndpointRouter = Effect.fn("CodexEndpointRouter.make")(function* (
  client: CodexEndpointRouterClient,
  options: CodexEndpointRouterOptions = {},
): Effect.fn.Return<CodexEndpointRouter> {
  const unboundNotificationBacklogCapacity = normalizeCapacity(
    options.unboundNotificationBacklogCapacity,
    DEFAULT_UNBOUND_NOTIFICATION_BACKLOG_CAPACITY,
    0,
  );
  const unboundNativeThreadCapacity = normalizeCapacity(
    options.unboundNativeThreadCapacity,
    DEFAULT_UNBOUND_NATIVE_THREAD_CAPACITY,
    1,
  );
  const sessionNotificationCapacity = normalizeCapacity(
    options.sessionNotificationCapacity,
    DEFAULT_SESSION_NOTIFICATION_CAPACITY,
    1,
  );
  const collaborationChildAliasCapacity = normalizeCapacity(
    options.collaborationChildAliasCapacity,
    DEFAULT_COLLABORATION_CHILD_ALIAS_CAPACITY,
    0,
  );
  const routingLock = yield* Semaphore.make(1);
  const state: RouterState = {
    sessions: new Map(),
    sessionsByNativeThreadId: new Map(),
    notificationBacklogs: new Map(),
  };

  const appendNotificationBacklog = (
    nativeThreadId: string,
    notification: RoutedNotification,
  ): void => {
    if (unboundNotificationBacklogCapacity === 0) return;
    let backlog = state.notificationBacklogs.get(nativeThreadId);
    if (!backlog) {
      if (state.notificationBacklogs.size >= unboundNativeThreadCapacity) {
        const oldestNativeThreadId = state.notificationBacklogs.keys().next().value;
        if (oldestNativeThreadId !== undefined) {
          state.notificationBacklogs.delete(oldestNativeThreadId);
        }
      }
      backlog = [];
      state.notificationBacklogs.set(nativeThreadId, backlog);
    }
    if (backlog.length >= unboundNotificationBacklogCapacity) {
      backlog.shift();
    }
    backlog.push(notification);
  };

  const removeChildAlias = (session: SessionEntry, nativeThreadId: string): void => {
    if (!session.childAliases.delete(nativeThreadId)) return;
    if (state.sessionsByNativeThreadId.get(nativeThreadId) === session) {
      state.sessionsByNativeThreadId.delete(nativeThreadId);
    }
  };

  const aliasCollaborationChild = Effect.fn("CodexEndpointRouter.aliasCollaborationChild")(
    function* (
      childNativeThreadId: string,
      parentNativeThreadId: string,
    ): Effect.fn.Return<SessionEntry | undefined> {
      const childOwner = state.sessionsByNativeThreadId.get(childNativeThreadId);
      if (childOwner !== undefined) {
        const parentOwner = state.sessionsByNativeThreadId.get(parentNativeThreadId);
        if (parentOwner !== undefined && parentOwner !== childOwner) {
          yield* Effect.logWarning("ignored conflicting Codex collaboration-child alias", {
            childNativeThreadId,
            parentNativeThreadId,
            childOwnerThreadId: childOwner.threadId,
            parentOwnerThreadId: parentOwner.threadId,
          });
        }
        return childOwner;
      }
      const parentOwner = state.sessionsByNativeThreadId.get(parentNativeThreadId);
      if (parentOwner === undefined || collaborationChildAliasCapacity === 0) return undefined;
      if (parentOwner.childAliases.size >= collaborationChildAliasCapacity) {
        const oldestAlias = parentOwner.childAliases.values().next().value;
        if (oldestAlias !== undefined) {
          removeChildAlias(parentOwner, oldestAlias);
          yield* Effect.logWarning("evicted oldest Codex collaboration-child alias", {
            threadId: parentOwner.threadId,
            nativeThreadId: oldestAlias,
            capacity: collaborationChildAliasCapacity,
          });
        }
      }
      parentOwner.childAliases.add(childNativeThreadId);
      state.sessionsByNativeThreadId.set(childNativeThreadId, parentOwner);
      const backlog = state.notificationBacklogs.get(childNativeThreadId) ?? [];
      state.notificationBacklogs.delete(childNativeThreadId);
      for (const notification of backlog) {
        yield* Queue.offer(parentOwner.notifications, notification);
      }
      return parentOwner;
    },
  );

  const routeNotification = <M extends CodexRpc.ServerNotificationMethod>(
    method: M,
    params: CodexRpc.ServerNotificationParamsByMethod[M],
  ): Effect.Effect<void> =>
    routingLock.withPermits(1)(
      Effect.gen(function* () {
        const notification: RoutedNotification = {
          ...makeNotification(method, params),
          known: true,
        };
        const nativeThreadId = readNotificationThreadId(notification);
        if (nativeThreadId === undefined) return;
        const parentNativeThreadId = readThreadStartedParentId(notification);
        const session =
          parentNativeThreadId === undefined
            ? state.sessionsByNativeThreadId.get(nativeThreadId)
            : yield* aliasCollaborationChild(nativeThreadId, parentNativeThreadId);
        if (!session) {
          appendNotificationBacklog(nativeThreadId, notification);
          return;
        }
        const accepted = yield* Queue.offer(session.notifications, notification);
        if (!accepted) {
          yield* Effect.logWarning("dropped Codex session notification from a full mailbox", {
            threadId: session.threadId,
            nativeThreadId,
            method,
          });
        }
        if (method === "thread/closed" && session.childAliases.has(nativeThreadId)) {
          removeChildAlias(session, nativeThreadId);
        }
      }),
    );

  const routeUnknownNotification = (method: string, params: unknown): Effect.Effect<void> =>
    routingLock.withPermits(1)(
      Effect.gen(function* () {
        const notification: RoutedNotification = { method, params, known: false };
        const nativeThreadId = readNotificationThreadId(notification);
        if (nativeThreadId === undefined) return;
        const session = state.sessionsByNativeThreadId.get(nativeThreadId);
        if (!session) {
          appendNotificationBacklog(nativeThreadId, notification);
          return;
        }
        yield* Queue.offer(session.notifications, notification);
      }),
    );

  const routeRequest = <M extends CodexInteractiveServerRequestMethod>(
    method: M,
    params: CodexRpc.ServerRequestParamsByMethod[M],
  ): Effect.Effect<CodexRpc.ServerRequestResponsesByMethod[M], CodexErrors.CodexAppServerError> =>
    routingLock
      .withPermits(1)(Effect.sync(() => state.sessionsByNativeThreadId.get(params.threadId)))
      .pipe(
        Effect.flatMap((session) =>
          session
            ? deliverRequest(session, method, params)
            : requestRoutingError(method, params.threadId, params.turnId),
        ),
      );

  const installNotificationHandler = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
    client.handleServerNotification(method, (params) => routeNotification(method, params));
  for (const method of Object.values(
    CodexRpc.SERVER_NOTIFICATION_METHODS,
  ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>) {
    yield* installNotificationHandler(method);
  }
  yield* client.handleUnknownServerNotification(routeUnknownNotification);

  const installRequestHandler = <M extends CodexInteractiveServerRequestMethod>(method: M) =>
    client.handleServerRequest(method, (params) => routeRequest(method, params));
  for (const method of CODEX_INTERACTIVE_SERVER_REQUEST_METHODS) {
    yield* installRequestHandler(method);
  }

  const unregisterSession = (session: SessionEntry): Effect.Effect<void> =>
    routingLock
      .withPermits(1)(
        Effect.sync(() => {
          if (state.sessions.get(session.threadId) !== session) return;
          state.sessions.delete(session.threadId);
          const nativeThreadId = session.nativeThreadId;
          if (nativeThreadId !== undefined) {
            state.sessionsByNativeThreadId.delete(nativeThreadId);
          }
          for (const childAlias of session.childAliases) {
            if (state.sessionsByNativeThreadId.get(childAlias) === session) {
              state.sessionsByNativeThreadId.delete(childAlias);
            }
          }
          session.childAliases.clear();
        }),
      )
      .pipe(Effect.andThen(Queue.shutdown(session.notifications)), Effect.asVoid);

  const registerSession = Effect.fn("CodexEndpointRouter.registerSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly callbacks: CodexEndpointSessionCallbacks;
  }): Effect.fn.Return<
    CodexEndpointSessionRegistration,
    CodexEndpointRouterRegistrationError,
    Scope.Scope
  > {
    const notifications = yield* Queue.dropping<RoutedNotification>(sessionNotificationCapacity);
    const session: SessionEntry = {
      threadId: input.threadId,
      callbacks: input.callbacks,
      notifications,
      childAliases: new Set(),
      nativeThreadId: undefined,
    };

    yield* Effect.acquireRelease(
      routingLock.withPermits(1)(
        Effect.suspend(() => {
          if (state.sessions.has(input.threadId)) {
            return Effect.fail(
              new CodexEndpointRouterRegistrationError({
                reason: "duplicate-session",
                threadId: input.threadId,
              }),
            );
          }
          state.sessions.set(input.threadId, session);
          return Effect.void;
        }),
      ),
      () => unregisterSession(session),
    );

    yield* Stream.fromQueue(notifications).pipe(
      Stream.runForEach((notification) =>
        deliverNotification(session, notification).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Codex session notification callback failed", {
              threadId: session.threadId,
              method: notification.method,
              cause: error,
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    const bindNativeThreadIdInternal = (nativeThreadId: string, allowRebind: boolean) =>
      routingLock.withPermits(1)(
        Effect.gen(function* () {
          if (state.sessions.get(session.threadId) !== session) {
            return yield* new CodexEndpointRouterRegistrationError({
              reason: "session-not-registered",
              threadId: session.threadId,
              nativeThreadId,
            });
          }
          if (
            !allowRebind &&
            session.nativeThreadId !== undefined &&
            session.nativeThreadId !== nativeThreadId
          ) {
            return yield* new CodexEndpointRouterRegistrationError({
              reason: "session-already-bound",
              threadId: session.threadId,
              nativeThreadId,
            });
          }
          const existing = state.sessionsByNativeThreadId.get(nativeThreadId);
          if (existing !== undefined && existing !== session) {
            return yield* new CodexEndpointRouterRegistrationError({
              reason: "native-thread-already-bound",
              threadId: session.threadId,
              nativeThreadId,
            });
          }
          const previousNativeThreadId = session.nativeThreadId;
          if (previousNativeThreadId !== undefined && previousNativeThreadId !== nativeThreadId) {
            state.sessionsByNativeThreadId.delete(previousNativeThreadId);
          }
          removeChildAlias(session, nativeThreadId);
          session.nativeThreadId = nativeThreadId;
          state.sessionsByNativeThreadId.set(nativeThreadId, session);
          const backlog = state.notificationBacklogs.get(nativeThreadId) ?? [];
          state.notificationBacklogs.delete(nativeThreadId);
          for (const notification of backlog) {
            const accepted = yield* Queue.offer(session.notifications, notification);
            if (!accepted) {
              yield* Effect.logWarning(
                "dropped backlogged Codex notification from a full session mailbox",
                {
                  threadId: session.threadId,
                  nativeThreadId,
                  method: notification.method,
                },
              );
            }
          }
        }),
      );

    return {
      bindNativeThreadId: (nativeThreadId) => bindNativeThreadIdInternal(nativeThreadId, false),
      rebindNativeThreadId: (nativeThreadId) => bindNativeThreadIdInternal(nativeThreadId, true),
    };
  });

  return { registerSession };
});
