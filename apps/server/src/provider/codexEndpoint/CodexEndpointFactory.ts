import {
  type CodexDirectWebSocketTransport,
  type CodexEndpointTransport,
  type CodexSshProxyTransport,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexEndpointConnection from "./CodexEndpointConnection.ts";
import {
  type CodexDirectWebSocketConnectorError,
  makeDirectWebSocketConnector,
} from "./DirectWebSocketConnector.ts";
import { type CodexSshProxyConnectorError, makeSshProxyConnector } from "./SshProxyConnector.ts";

export interface MakeCodexEndpointOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly transport: CodexEndpointTransport;
}

export interface CodexEndpointConnectorConstructors {
  readonly directWebSocket: (
    transport: CodexDirectWebSocketTransport,
  ) => Effect.Effect<
    CodexEndpointConnection.CodexEndpointFramedTransport,
    CodexDirectWebSocketConnectorError,
    FileSystem.FileSystem | Scope.Scope
  >;
  readonly sshProxy: (
    transport: CodexSshProxyTransport,
  ) => Effect.Effect<
    CodexEndpointConnection.CodexEndpointFramedTransport,
    CodexSshProxyConnectorError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
  >;
}

export type CodexEndpointFactoryError =
  | CodexDirectWebSocketConnectorError
  | CodexSshProxyConnectorError
  | CodexEndpointConnection.CodexEndpointConnectionError;

export const defaultConnectorConstructors: CodexEndpointConnectorConstructors = {
  directWebSocket: makeDirectWebSocketConnector,
  sshProxy: makeSshProxyConnector,
};

const acquireFramedTransport = (
  transport: CodexEndpointTransport,
  constructors: CodexEndpointConnectorConstructors,
) =>
  transport.type === "direct-websocket"
    ? constructors.directWebSocket(transport)
    : constructors.sshProxy(transport);

export const make = Effect.fn("CodexEndpointFactory.make")(function* (
  options: MakeCodexEndpointOptions,
  constructors: CodexEndpointConnectorConstructors = defaultConnectorConstructors,
): Effect.fn.Return<
  CodexEndpointConnection.CodexEndpointConnection["Service"],
  CodexEndpointFactoryError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> {
  const parentScope = yield* Effect.scope;

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const acquisitionScope = yield* Scope.make("sequential");
      const acquire = Effect.gen(function* () {
        const framedTransport = yield* acquireFramedTransport(options.transport, constructors);
        return yield* CodexEndpointConnection.make({
          providerInstanceId: options.providerInstanceId,
          framedTransport,
        });
      }).pipe(Effect.provideService(Scope.Scope, acquisitionScope));

      const connection = yield* restore(acquire).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Scope.close(acquisitionScope, Exit.void) : Effect.void,
        ),
      );
      yield* Scope.addFinalizer(
        parentScope,
        Scope.close(acquisitionScope, Exit.void).pipe(Effect.ignore),
      );
      return connection;
    }),
  );
});
