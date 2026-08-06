import {
  EnvironmentAuthHttpApi,
  EnvironmentMetadataHttpApi,
  EnvironmentOrchestrationHttpApi,
  ServerSelfUpdateError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import { cocoaClientV1WebSocketRouteLayer } from "../clientApi/v1/Route.ts";
import * as ServerConfig from "../config.ts";
import * as GatewayHealth from "../health/GatewayHealth.ts";
import {
  assetRouteLayer,
  browserApiCorsLayer,
  gatewayHealthRouteLayer,
  httpCompressionLayer,
  serverEnvironmentHttpApiLayer,
  staticAndDevRouteLayer,
} from "../http.ts";
import * as HttpResponseCompression from "../httpCompression/HttpResponseCompression.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { orchestrationHttpApiLayer } from "../orchestration/http.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerLoggerLive } from "../serverLogger.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServiceLauncherClient from "../cloud/ServiceLauncherClientService.ts";
import { websocketRpcRouteLayer } from "../ws.ts";
import * as WsRuntimeServices from "../ws/WsRuntimeServices.ts";
import { CocoaRuntimeDependenciesLive } from "./CocoaGatewayRuntime.ts";

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// Long-lived WebSocket scopes already close themselves gracefully during layer
// finalization, so the gateway must not insert another drain before that happens.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;

const CocoaHttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        hostname: config.host ?? "127.0.0.1",
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
      });
    }

    const [NodeHttpServer, NodeHttp] = yield* Effect.all([
      Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
      Effect.promise(() => import("node:http")),
    ]);
    return NodeHttpServer.layer(NodeHttp.createServer, {
      host: config.host ?? "127.0.0.1",
      port: config.port,
      gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
    });
  }),
);

const CocoaHttpResponseCompressionLive =
  typeof Bun !== "undefined" ? HttpResponseCompression.layerBun : HttpResponseCompression.layerNode;

const CocoaPlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    }

    const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
    return layer;
  }),
);

const CocoaServerSelfUpdateLayerLive = Layer.succeed(
  WsRuntimeServices.ServerSelfUpdate,
  WsRuntimeServices.ServerSelfUpdate.of({
    update: () =>
      Effect.fail(
        new ServerSelfUpdateError({
          reason: "Cocoa gateway updates are administrator-managed.",
        }),
      ),
  }),
);

const commandReadinessLayer = HttpRouter.middleware()(
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    return (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect));
  }),
).layer;

class CocoaGatewayEnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi) {}

const cocoaGatewayEnvironmentHttpApiLayer = HttpApiBuilder.layer(
  CocoaGatewayEnvironmentHttpApi,
).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(orchestrationHttpApiLayer),
  Layer.provide(serverEnvironmentHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
);

const cocoaCommandReadyRoutesLayer = Layer.mergeAll(
  Layer.mergeAll(
    cocoaGatewayEnvironmentHttpApiLayer,
    assetRouteLayer,
    staticAndDevRouteLayer,
    websocketRpcRouteLayer,
    cocoaClientV1WebSocketRouteLayer,
  ),
  McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)),
).pipe(
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(CocoaServerSelfUpdateLayerLive),
  Layer.provide(commandReadinessLayer),
);

/** HTTP, static, legacy RPC, Cocoa v1 RPC, health, auth, and pairing routes. */
export const CocoaGatewayRoutesLive = Layer.mergeAll(
  cocoaCommandReadyRoutesLayer,
  gatewayHealthRouteLayer.pipe(Layer.provide(GatewayHealth.layer)),
).pipe(Layer.provide(browserApiCorsLayer), Layer.provide(httpCompressionLayer));

/**
 * Cocoa-only server composition.
 *
 * This intentionally contains no runtime-profile branch. Callers must supply a
 * Cocoa configuration and the layer fails closed before acquiring listeners if
 * that invariant is violated.
 */
export const CocoaGatewayServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.runtimeProfile !== "cocoa-gateway") {
      return yield* Effect.die(
        new Error("CocoaGatewayServer requires runtimeProfile 'cocoa-gateway'."),
      );
    }

    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const activationLayer = Layer.succeed(ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );

    const runtimeStateLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
          yield* awaitActivation;
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) return;

          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
        }),
        () =>
          clearPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to clear server runtime state", { cause }),
            ),
          ),
      ),
    );

    const runtimeServicesLive = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [Deferred.await(runtimeStateParked), Deferred.await(routesReady)],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(
      Layer.provideMerge(CocoaRuntimeDependenciesLive),
      Layer.provide(ServiceLauncherClient.cocoaGatewayLayer),
    );

    const routesLayer = HttpRouter.serve(
      CocoaGatewayRoutesLive.pipe(Layer.provide(ServiceLauncherClient.cocoaGatewayLayer)),
      { disableLogger: !config.logWebSocketEvents },
    ).pipe(Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)));

    return Layer.mergeAll(routesLayer, httpListeningLayer, runtimeStateLayer).pipe(
      Layer.provideMerge(runtimeServicesLive),
      Layer.provide(activationLayer),
      Layer.provideMerge(CocoaHttpResponseCompressionLive),
      Layer.provideMerge(CocoaHttpServerLive),
      Layer.provide(ServerLoggerLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(CocoaPlatformServicesLive),
    );
  }),
);

// The Cocoa CLI supplies configuration.
export const runCocoaGatewayServer = Layer.launch(CocoaGatewayServerLive);
