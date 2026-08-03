import { CocoaClientV1RpcGroup } from "@t3tools/contracts/client/v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../../auth/http.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { cocoaClientV1HandlersLayer } from "./Handlers.ts";

export const COCOA_CLIENT_V1_WEBSOCKET_PATH = "/api/client/v1/ws";

export const cocoaClientV1WebSocketRouteLayer = HttpRouter.add(
  "GET",
  COCOA_CLIENT_V1_WEBSOCKET_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(CocoaClientV1RpcGroup, {
      disableTracing: true,
    }).pipe(
      Effect.provide(
        cocoaClientV1HandlersLayer(session).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
      ),
    );
    return yield* Effect.acquireUseRelease(
      sessions.markConnected(session.sessionId),
      () => rpcWebSocketHttpEffect,
      () => sessions.markDisconnected(session.sessionId),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);
