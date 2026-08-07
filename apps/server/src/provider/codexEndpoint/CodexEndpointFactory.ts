import {
  type CocoaHostTransport,
  type CodexEndpointTransport,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import * as CodexEndpointConnection from "./CodexEndpointConnection.ts";
import { type CocoaHostConnectorError, makeCocoaHostConnector } from "./CocoaHostConnector.ts";

export interface MakeCodexEndpointOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly transport: CodexEndpointTransport;
}

export interface CodexEndpointConnectorConstructors {
  readonly cocoaHost: (
    transport: CocoaHostTransport,
  ) => Effect.Effect<
    CodexEndpointConnection.CodexEndpointFramedTransport,
    CocoaHostConnectorError,
    Scope.Scope
  >;
}

export type CodexEndpointFactoryError =
  | CocoaHostConnectorError
  | CodexEndpointConnection.CodexEndpointConnectionError;

export const defaultConnectorConstructors: CodexEndpointConnectorConstructors = {
  cocoaHost: makeCocoaHostConnector,
};

const acquireFramedTransport = (
  transport: CodexEndpointTransport,
  constructors: CodexEndpointConnectorConstructors,
) => constructors.cocoaHost(transport);

export const make = Effect.fn("CodexEndpointFactory.make")(function* (
  options: MakeCodexEndpointOptions,
  constructors: CodexEndpointConnectorConstructors = defaultConnectorConstructors,
): Effect.fn.Return<
  CodexEndpointConnection.CodexEndpointConnection["Service"],
  CodexEndpointFactoryError,
  Scope.Scope
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
