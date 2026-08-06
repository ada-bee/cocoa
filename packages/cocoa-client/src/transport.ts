import {
  COCOA_CLIENT_V1_METHODS,
  CocoaClientProtocolVersionMismatch,
  CocoaClientV1RequestError,
  CocoaClientV1RpcGroup,
  type CocoaClientV1ShellStreamItem,
  type CocoaClientV1SubscribeShellInput,
  type CocoaClientV1SubscribeThreadInput,
  type CocoaClientV1ThreadStreamItem,
} from "@t3tools/contracts/client/v1";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { CocoaClientError, CocoaClientProtocolError, CocoaClientRequestError } from "./errors.ts";
import type {
  CocoaClientConnectionState,
  CocoaClientUnaryMethod,
  CocoaClientUnaryMethodMap,
} from "./public-types.ts";

export interface CocoaClientTransport {
  readonly state: CocoaClientConnectionState;
  request<Method extends CocoaClientUnaryMethod>(
    method: Method,
    input: CocoaClientUnaryMethodMap[Method]["input"],
  ): Promise<CocoaClientUnaryMethodMap[Method]["output"]>;
  subscribeShell(
    input: CocoaClientV1SubscribeShellInput,
  ): AsyncIterable<CocoaClientV1ShellStreamItem>;
  subscribeThread(
    input: CocoaClientV1SubscribeThreadInput,
  ): AsyncIterable<CocoaClientV1ThreadStreamItem>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
}

export interface CocoaClientTransportOptions {
  readonly issueWebSocketUrl: () => Promise<string>;
  readonly WebSocket: typeof globalThis.WebSocket;
  readonly onConnectionStateChange?: (state: CocoaClientConnectionState) => void;
}

const isProtocolMismatch = Schema.is(CocoaClientProtocolVersionMismatch);
const isRequestError = Schema.is(CocoaClientV1RequestError);
const isRpcClientError = Schema.is(RpcClientError);

export function mapCocoaRpcError(error: unknown): CocoaClientError {
  if (error instanceof CocoaClientError) return error;
  if (isProtocolMismatch(error)) {
    return new CocoaClientProtocolError({
      clientRange: error.clientRange,
      serverRange: error.serverRange,
      message: error.message,
    });
  }
  if (isRequestError(error)) return new CocoaClientRequestError(error);
  if (isRpcClientError(error)) {
    return new CocoaClientError("transport", "The Cocoa RPC transport failed.", { cause: error });
  }
  return new CocoaClientError("transport", "The Cocoa RPC request failed.", { cause: error });
}

const makeRpcClient = RpcClient.make(CocoaClientV1RpcGroup);
type Rpc = Effect.Success<typeof makeRpcClient>;

interface Session {
  readonly rpc: Rpc;
  readonly scope: Scope.Closeable;
  readonly disconnected: boolean;
}

export function createCocoaClientTransport(
  options: CocoaClientTransportOptions,
): CocoaClientTransport {
  let current: Session | undefined;
  let connecting: Promise<Session> | undefined;
  let closed = false;
  let attempt = 0;
  let state: CocoaClientConnectionState = { status: "connecting", attempt };

  const publish = (next: CocoaClientConnectionState): void => {
    state = next;
    try {
      options.onConnectionStateChange?.(next);
    } catch {
      // User callbacks cannot break transport state transitions.
    }
  };

  const closeSession = async (session: Session | undefined): Promise<void> => {
    if (session === undefined) return;
    await Effect.runPromise(Scope.close(session.scope, Exit.void).pipe(Effect.ignore));
  };

  const open = async (): Promise<Session> => {
    if (closed) throw new CocoaClientError("closed", "The Cocoa client is closed.");
    if (current !== undefined && !current.disconnected) return current;
    if (connecting !== undefined) return connecting;

    attempt += 1;
    publish({ status: attempt === 1 ? "connecting" : "reconnecting", attempt });
    connecting = (async () => {
      await closeSession(current);
      current = undefined;
      const socketUrl = await options.issueWebSocketUrl();
      const scope = await Effect.runPromise(Scope.make("sequential"));
      let disconnected = false;
      try {
        const rpc = await Effect.runPromise(
          Effect.gen(function* () {
            const hooks = RpcClient.ConnectionHooks.of({
              onConnect: Effect.sync(() => publish({ status: "connected", attempt })),
              onDisconnect: Effect.sync(() => {
                disconnected = true;
                if (!closed) publish({ status: "disconnected", attempt });
              }),
            });
            const socketLayer = Socket.layerWebSocket(socketUrl, {
              openTimeout: "15 seconds",
            }).pipe(
              Layer.provide(
                Layer.succeed(
                  Socket.WebSocketConstructor,
                  (url, protocols) => new options.WebSocket(url, protocols),
                ),
              ),
            );
            const protocolLayer = Layer.effect(
              RpcClient.Protocol,
              RpcClient.makeProtocolSocket({
                retryTransientErrors: false,
                retryPolicy: Schedule.recurs(0),
              }),
            ).pipe(
              Layer.provide(
                Layer.mergeAll(
                  socketLayer,
                  RpcSerialization.layerJson,
                  Layer.succeed(RpcClient.ConnectionHooks, hooks),
                ),
              ),
            );
            const context = yield* Layer.buildWithScope(protocolLayer, scope);
            return yield* makeRpcClient.pipe(
              Effect.provide(context),
              Effect.provideService(Scope.Scope, scope),
            );
          }),
        );
        const session: Session = {
          rpc,
          scope,
          get disconnected() {
            return disconnected;
          },
        };
        current = session;
        return session;
      } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.ignore));
        const mapped = mapCocoaRpcError(error);
        publish({ status: "disconnected", attempt, error: mapped });
        throw mapped;
      }
    })();
    try {
      return await connecting;
    } finally {
      connecting = undefined;
    }
  };

  const run = async <A, E>(make: (rpc: Rpc) => Effect.Effect<A, E>): Promise<A> => {
    const session = await open();
    try {
      return await Effect.runPromise(make(session.rpc));
    } catch (error) {
      throw mapCocoaRpcError(error);
    }
  };

  const stream = <A, E>(make: (rpc: Rpc) => Stream.Stream<A, E>): AsyncIterable<A> => ({
    [Symbol.asyncIterator]() {
      let iterator: AsyncIterator<A> | undefined;
      return {
        async next() {
          try {
            if (iterator === undefined) {
              const session = await open();
              iterator = Stream.toAsyncIterable(make(session.rpc))[Symbol.asyncIterator]();
            }
            const activeIterator = iterator;
            return await activeIterator.next();
          } catch (error) {
            throw mapCocoaRpcError(error);
          }
        },
        async return() {
          if (iterator?.return !== undefined) await iterator.return();
          return { done: true, value: undefined };
        },
      };
    },
  });

  return {
    get state() {
      return state;
    },
    async request(method, input) {
      switch (method) {
        case "client.info":
          return (await run((rpc) =>
            rpc[COCOA_CLIENT_V1_METHODS.info](
              input as CocoaClientUnaryMethodMap["client.info"]["input"],
            ),
          )) as CocoaClientUnaryMethodMap[typeof method]["output"];
        case "client.probe":
          return (await run((rpc) =>
            rpc[COCOA_CLIENT_V1_METHODS.probe]({}),
          )) as CocoaClientUnaryMethodMap[typeof method]["output"];
        case "orchestration.dispatchCommand":
          return (await run((rpc) =>
            rpc[COCOA_CLIENT_V1_METHODS.dispatchCommand](
              input as CocoaClientUnaryMethodMap["orchestration.dispatchCommand"]["input"],
            ),
          )) as CocoaClientUnaryMethodMap[typeof method]["output"];
        case "workspace.executeCommand":
          return (await run((rpc) =>
            rpc[COCOA_CLIENT_V1_METHODS.executeCommand](
              input as CocoaClientUnaryMethodMap["workspace.executeCommand"]["input"],
            ),
          )) as CocoaClientUnaryMethodMap[typeof method]["output"];
        case "orchestration.getShellSnapshot":
          return (await run((rpc) =>
            rpc[COCOA_CLIENT_V1_METHODS.getShellSnapshot]({}),
          )) as CocoaClientUnaryMethodMap[typeof method]["output"];
        case "orchestration.getThreadSnapshot":
          return (await run((rpc) =>
            rpc[COCOA_CLIENT_V1_METHODS.getThreadSnapshot](
              input as CocoaClientUnaryMethodMap["orchestration.getThreadSnapshot"]["input"],
            ),
          )) as CocoaClientUnaryMethodMap[typeof method]["output"];
        case "orchestration.searchThreads":
          return (await run((rpc) =>
            rpc[COCOA_CLIENT_V1_METHODS.searchThreads](
              input as CocoaClientUnaryMethodMap["orchestration.searchThreads"]["input"],
            ),
          )) as CocoaClientUnaryMethodMap[typeof method]["output"];
        case "orchestration.getTurnDiff":
          return (await run((rpc) =>
            rpc[COCOA_CLIENT_V1_METHODS.getTurnDiff](
              input as CocoaClientUnaryMethodMap["orchestration.getTurnDiff"]["input"],
            ),
          )) as CocoaClientUnaryMethodMap[typeof method]["output"];
        case "orchestration.getFullThreadDiff":
          return (await run((rpc) =>
            rpc[COCOA_CLIENT_V1_METHODS.getFullThreadDiff](
              input as CocoaClientUnaryMethodMap["orchestration.getFullThreadDiff"]["input"],
            ),
          )) as CocoaClientUnaryMethodMap[typeof method]["output"];
      }
    },
    subscribeShell: (input) => stream((rpc) => rpc[COCOA_CLIENT_V1_METHODS.subscribeShell](input)),
    subscribeThread: (input) =>
      stream((rpc) => rpc[COCOA_CLIENT_V1_METHODS.subscribeThread](input)),
    async reconnect() {
      if (closed) throw new CocoaClientError("closed", "The Cocoa client is closed.");
      const previous = current;
      current = undefined;
      await closeSession(previous);
    },
    async close() {
      if (closed) return;
      closed = true;
      const previous = current;
      current = undefined;
      await closeSession(previous);
      publish({ status: "closed", attempt });
    },
  };
}
