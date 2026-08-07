import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  makeCocoaHostConnector,
  type CocoaHostConnectorOptions,
} from "../codexEndpoint/CocoaHostConnector.ts";
import {
  type HostEndpointRpcTransportOpener,
  HostEndpointRpcTransportFailure,
} from "./HostEndpointRpcClient.ts";

export const COCOA_HOST_CONTROL_PATH = "/control/v1" as const;

export const cocoaHostControlUrl = (hostUrl: string): string => {
  const parsed = new URL(hostUrl);
  parsed.pathname = COCOA_HOST_CONTROL_PATH;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const bearerKey = (authorization: string): string => {
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix) || authorization.length === prefix.length) {
    throw new Error("Expected a non-empty Bearer authorization header");
  }
  return authorization.slice(prefix.length);
};

export interface CocoaHostControlTransportDependencies {
  readonly connect: typeof makeCocoaHostConnector;
}

export const makeCocoaHostControlTransportOpener = (
  connectorOptions: CocoaHostConnectorOptions = {},
  dependencies: CocoaHostControlTransportDependencies = { connect: makeCocoaHostConnector },
): HostEndpointRpcTransportOpener =>
  Effect.fn("CocoaHostControlTransport.open")(function* (options) {
    const parentScope = yield* Effect.scope;
    const connectionScope = yield* Scope.make("sequential");
    const transport = yield* Effect.try({
      try: () => ({
        url: cocoaHostControlUrl(options.url),
        key: bearerKey(options.headers.Authorization),
      }),
      catch: (cause) => new HostEndpointRpcTransportFailure({ operation: "open", cause }),
    }).pipe(
      Effect.flatMap((host) =>
        dependencies
          .connect(
            {
              type: "cocoa-host",
              url: host.url as never,
              key: host.key as never,
            },
            connectorOptions,
          )
          .pipe(
            Effect.provideService(Scope.Scope, connectionScope),
            Effect.mapError(
              (cause) => new HostEndpointRpcTransportFailure({ operation: "open", cause }),
            ),
          ),
      ),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Scope.close(connectionScope, Exit.void) : Effect.void,
      ),
    );
    yield* Scope.addFinalizer(
      parentScope,
      Scope.close(connectionScope, Exit.void).pipe(Effect.ignore),
    );
    const sendLock = yield* Semaphore.make(1);
    return {
      incoming: transport.incoming.pipe(
        Stream.mapError(
          (cause) => new HostEndpointRpcTransportFailure({ operation: "read", cause }),
        ),
      ),
      send: (frame: string) =>
        sendLock.withPermits(1)(
          transport
            .outgoing(Stream.make(frame))
            .pipe(
              Effect.mapError(
                (cause) => new HostEndpointRpcTransportFailure({ operation: "send", cause }),
              ),
            ),
        ),
      close: Scope.close(connectionScope, Exit.void).pipe(Effect.ignore),
    };
  });
