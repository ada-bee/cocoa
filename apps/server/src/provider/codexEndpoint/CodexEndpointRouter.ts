/**
 * Routes one shared, initialized Codex app-server client to scoped Cocoa sessions.
 *
 * Notifications which arrive before a native thread is bound retain the newest
 * `unboundNotificationBacklogCapacity` entries for that native thread. Older entries are dropped.
 * The number of native-thread backlog buckets is also bounded; the oldest bucket is evicted first.
 * Once a route is bound, its finite mailbox applies lossless backpressure so a
 * slow session can never make the router silently discard provider state.
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

export interface CodexEndpointRouteCallbacks {
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

export type CodexEndpointSessionCallbacks = CodexEndpointRouteCallbacks;

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
  /** Per-session delivery mailbox. A slow callback applies lossless backpressure when full. */
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

export class CodexEndpointInternalOperationRegistrationError extends Schema.TaggedErrorClass<CodexEndpointInternalOperationRegistrationError>()(
  "CodexEndpointInternalOperationRegistrationError",
  {
    reason: Schema.Literals([
      "operation-not-registered",
      "operation-already-bound",
      "native-thread-already-bound",
    ]),
    nativeThreadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex endpoint internal-operation routing failed for native thread '${this.nativeThreadId}': ${this.reason}.`;
  }
}

interface RouteEntryBase {
  readonly callbacks: CodexEndpointRouteCallbacks;
  readonly notifications: Queue.Queue<RoutedNotification>;
  readonly childAliases: Set<string>;
  nativeThreadId: string | undefined;
}

interface SessionEntry extends RouteEntryBase {
  readonly _tag: "Session";
  readonly threadId: ThreadId;
}

interface InternalOperationEntry extends RouteEntryBase {
  readonly _tag: "InternalOperation";
}

type RouteEntry = SessionEntry | InternalOperationEntry;

interface RouterState {
  readonly sessions: Map<ThreadId, SessionEntry>;
  readonly internalOperations: Set<InternalOperationEntry>;
  readonly routesByNativeThreadId: Map<string, RouteEntry>;
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

export interface CodexEndpointInternalOperationRegistration {
  readonly bindNativeThreadId: (
    nativeThreadId: string,
  ) => Effect.Effect<void, CodexEndpointInternalOperationRegistrationError>;
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
  /**
   * Register one opaque provider-internal route. Scope cleanup releases only
   * local routing; the caller owns native lifecycle such as `thread/unsubscribe`.
   */
  readonly registerInternalOperation: (input: {
    readonly callbacks: CodexEndpointRouteCallbacks;
  }) => Effect.Effect<CodexEndpointInternalOperationRegistration, never, Scope.Scope>;
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
  route: RouteEntry,
  notification: RoutedNotification,
): Effect.Effect<void, CodexErrors.CodexAppServerError> {
  if (!notification.known) {
    return (
      route.callbacks.onUnknownNotification?.(notification.method, notification.params) ??
      Effect.void
    );
  }
  return route.callbacks.onNotification(notification.method as never, notification.params as never);
}

function deliverRequest<M extends CodexInteractiveServerRequestMethod>(
  route: RouteEntry,
  method: M,
  params: CodexRpc.ServerRequestParamsByMethod[M],
): Effect.Effect<CodexRpc.ServerRequestResponsesByMethod[M], CodexErrors.CodexAppServerError> {
  return route.callbacks.onRequest(method, params);
}

function requestRoutingError(
  method: CodexInteractiveServerRequestMethod,
  nativeThreadId: string,
  turnId: string,
): CodexErrors.CodexAppServerRequestError {
  return CodexErrors.CodexAppServerRequestError.internalError(
    `No active Codex endpoint route for request '${method}', native thread '${nativeThreadId}', and turn '${turnId}'.`,
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
    internalOperations: new Set(),
    routesByNativeThreadId: new Map(),
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

  const removeChildAlias = (route: RouteEntry, nativeThreadId: string): void => {
    if (!route.childAliases.delete(nativeThreadId)) return;
    if (state.routesByNativeThreadId.get(nativeThreadId) === route) {
      state.routesByNativeThreadId.delete(nativeThreadId);
    }
  };

  const routeLogContext = (route: RouteEntry) =>
    route._tag === "Session"
      ? { routeKind: "cocoa-session", threadId: route.threadId }
      : { routeKind: "internal-operation" };

  const aliasCollaborationChild = Effect.fn("CodexEndpointRouter.aliasCollaborationChild")(
    function* (
      childNativeThreadId: string,
      parentNativeThreadId: string,
    ): Effect.fn.Return<RouteEntry | undefined> {
      const childOwner = state.routesByNativeThreadId.get(childNativeThreadId);
      if (childOwner !== undefined) {
        const parentOwner = state.routesByNativeThreadId.get(parentNativeThreadId);
        if (parentOwner !== undefined && parentOwner !== childOwner) {
          yield* Effect.logWarning("ignored conflicting Codex collaboration-child alias", {
            childNativeThreadId,
            parentNativeThreadId,
            childOwner: routeLogContext(childOwner),
            parentOwner: routeLogContext(parentOwner),
          });
        }
        return childOwner;
      }
      const parentOwner = state.routesByNativeThreadId.get(parentNativeThreadId);
      if (parentOwner === undefined || collaborationChildAliasCapacity === 0) return undefined;
      if (parentOwner.childAliases.size >= collaborationChildAliasCapacity) {
        const oldestAlias = parentOwner.childAliases.values().next().value;
        if (oldestAlias !== undefined) {
          removeChildAlias(parentOwner, oldestAlias);
          yield* Effect.logWarning("evicted oldest Codex collaboration-child alias", {
            ...routeLogContext(parentOwner),
            nativeThreadId: oldestAlias,
            capacity: collaborationChildAliasCapacity,
          });
        }
      }
      parentOwner.childAliases.add(childNativeThreadId);
      state.routesByNativeThreadId.set(childNativeThreadId, parentOwner);
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
        const route =
          parentNativeThreadId === undefined
            ? state.routesByNativeThreadId.get(nativeThreadId)
            : yield* aliasCollaborationChild(nativeThreadId, parentNativeThreadId);
        if (!route) {
          appendNotificationBacklog(nativeThreadId, notification);
          return;
        }
        yield* Queue.offer(route.notifications, notification);
        if (method === "thread/closed" && route.childAliases.has(nativeThreadId)) {
          removeChildAlias(route, nativeThreadId);
        }
      }),
    );

  const routeUnknownNotification = (method: string, params: unknown): Effect.Effect<void> =>
    routingLock.withPermits(1)(
      Effect.gen(function* () {
        const notification: RoutedNotification = { method, params, known: false };
        const nativeThreadId = readNotificationThreadId(notification);
        if (nativeThreadId === undefined) return;
        const route = state.routesByNativeThreadId.get(nativeThreadId);
        if (!route) {
          appendNotificationBacklog(nativeThreadId, notification);
          return;
        }
        yield* Queue.offer(route.notifications, notification);
      }),
    );

  const routeRequest = <M extends CodexInteractiveServerRequestMethod>(
    method: M,
    params: CodexRpc.ServerRequestParamsByMethod[M],
  ): Effect.Effect<CodexRpc.ServerRequestResponsesByMethod[M], CodexErrors.CodexAppServerError> =>
    routingLock
      .withPermits(1)(Effect.sync(() => state.routesByNativeThreadId.get(params.threadId)))
      .pipe(
        Effect.flatMap((route) =>
          route
            ? deliverRequest(route, method, params)
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
          if (
            nativeThreadId !== undefined &&
            state.routesByNativeThreadId.get(nativeThreadId) === session
          ) {
            state.routesByNativeThreadId.delete(nativeThreadId);
          }
          for (const childAlias of session.childAliases) {
            if (state.routesByNativeThreadId.get(childAlias) === session) {
              state.routesByNativeThreadId.delete(childAlias);
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
    const notifications = yield* Queue.bounded<RoutedNotification>(sessionNotificationCapacity);
    const session: SessionEntry = {
      _tag: "Session",
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
          const existing = state.routesByNativeThreadId.get(nativeThreadId);
          if (existing !== undefined && existing !== session) {
            return yield* new CodexEndpointRouterRegistrationError({
              reason: "native-thread-already-bound",
              threadId: session.threadId,
              nativeThreadId,
            });
          }
          const previousNativeThreadId = session.nativeThreadId;
          if (previousNativeThreadId !== undefined && previousNativeThreadId !== nativeThreadId) {
            state.routesByNativeThreadId.delete(previousNativeThreadId);
          }
          removeChildAlias(session, nativeThreadId);
          session.nativeThreadId = nativeThreadId;
          state.routesByNativeThreadId.set(nativeThreadId, session);
          const backlog = state.notificationBacklogs.get(nativeThreadId) ?? [];
          state.notificationBacklogs.delete(nativeThreadId);
          for (const notification of backlog) {
            yield* Queue.offer(session.notifications, notification);
          }
        }),
      );

    return {
      bindNativeThreadId: (nativeThreadId) => bindNativeThreadIdInternal(nativeThreadId, false),
      rebindNativeThreadId: (nativeThreadId) => bindNativeThreadIdInternal(nativeThreadId, true),
    };
  });

  const unregisterInternalOperation = (operation: InternalOperationEntry): Effect.Effect<void> =>
    routingLock
      .withPermits(1)(
        Effect.sync(() => {
          if (!state.internalOperations.delete(operation)) return;
          const nativeThreadId = operation.nativeThreadId;
          if (
            nativeThreadId !== undefined &&
            state.routesByNativeThreadId.get(nativeThreadId) === operation
          ) {
            state.routesByNativeThreadId.delete(nativeThreadId);
          }
          for (const childAlias of operation.childAliases) {
            if (state.routesByNativeThreadId.get(childAlias) === operation) {
              state.routesByNativeThreadId.delete(childAlias);
            }
          }
          operation.childAliases.clear();
        }),
      )
      .pipe(Effect.andThen(Queue.shutdown(operation.notifications)), Effect.asVoid);

  const registerInternalOperation = Effect.fn("CodexEndpointRouter.registerInternalOperation")(
    function* (input: {
      readonly callbacks: CodexEndpointRouteCallbacks;
    }): Effect.fn.Return<CodexEndpointInternalOperationRegistration, never, Scope.Scope> {
      const notifications = yield* Queue.bounded<RoutedNotification>(sessionNotificationCapacity);
      const operation: InternalOperationEntry = {
        _tag: "InternalOperation",
        callbacks: input.callbacks,
        notifications,
        childAliases: new Set(),
        nativeThreadId: undefined,
      };

      yield* Effect.acquireRelease(
        routingLock.withPermits(1)(
          Effect.sync(() => {
            state.internalOperations.add(operation);
          }),
        ),
        () => unregisterInternalOperation(operation),
      );

      yield* Stream.fromQueue(notifications).pipe(
        Stream.runForEach((notification) =>
          deliverNotification(operation, notification).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Codex internal-operation notification callback failed", {
                method: notification.method,
                cause: error,
              }),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      const bindNativeThreadId = (nativeThreadId: string) =>
        routingLock.withPermits(1)(
          Effect.gen(function* () {
            if (!state.internalOperations.has(operation)) {
              return yield* new CodexEndpointInternalOperationRegistrationError({
                reason: "operation-not-registered",
                nativeThreadId,
              });
            }
            if (
              operation.nativeThreadId !== undefined &&
              operation.nativeThreadId !== nativeThreadId
            ) {
              return yield* new CodexEndpointInternalOperationRegistrationError({
                reason: "operation-already-bound",
                nativeThreadId,
              });
            }
            const existing = state.routesByNativeThreadId.get(nativeThreadId);
            if (existing !== undefined && existing !== operation) {
              return yield* new CodexEndpointInternalOperationRegistrationError({
                reason: "native-thread-already-bound",
                nativeThreadId,
              });
            }
            removeChildAlias(operation, nativeThreadId);
            operation.nativeThreadId = nativeThreadId;
            state.routesByNativeThreadId.set(nativeThreadId, operation);
            const backlog = state.notificationBacklogs.get(nativeThreadId) ?? [];
            state.notificationBacklogs.delete(nativeThreadId);
            for (const notification of backlog) {
              yield* Queue.offer(operation.notifications, notification);
            }
          }),
        );

      return { bindNativeThreadId };
    },
  );

  return { registerSession, registerInternalOperation };
});
