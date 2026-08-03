import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { GatewayHealth, type GatewayReadinessReport } from "./GatewayHealth.ts";
import { gatewayHealthRouteLayer } from "../http.ts";

const request = (report: GatewayReadinessReport, pathname: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        gatewayHealthRouteLayer.pipe(
          Layer.provide(
            Layer.succeed(
              GatewayHealth,
              GatewayHealth.of({ getReadiness: Effect.succeed(report) }),
            ),
          ),
        ),
        { disableLogger: true },
      ),
    ),
    ({ handler }) => Effect.promise(() => handler(new Request(`http://localhost${pathname}`))),
    ({ dispose }) => Effect.promise(dispose),
  );

const report = (status: GatewayReadinessReport["status"]): GatewayReadinessReport => ({
  status,
  checks: {
    startup: status === "unready" ? "failed" : "ready",
    database: "ready",
    webIndex: "ready",
    providers: status === "ready" ? "ready" : "degraded",
  },
  providerCount: 0,
  providers: [],
});

describe("gateway health HTTP routes", () => {
  it.effect("serves process liveness without evaluating readiness", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          gatewayHealthRouteLayer.pipe(
            Layer.provide(
              Layer.succeed(GatewayHealth, GatewayHealth.of({ getReadiness: Effect.never })),
            ),
          ),
          { disableLogger: true },
        ),
      ),
      ({ handler }) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(new Request("http://localhost/healthz")),
          );
          assert.strictEqual(response.status, 200);
          assert.deepEqual(yield* Effect.promise(() => response.json()), { status: "ok" });
          assert.strictEqual(response.headers.get("cache-control"), "no-store");
        }),
      ({ dispose }) => Effect.promise(dispose),
    ),
  );

  it.effect("returns 200 for ready and degraded gateways", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* request(report("ready"), "/readyz")).status, 200);
      assert.strictEqual((yield* request(report("degraded"), "/readyz")).status, 200);
    }),
  );

  it.effect("returns 503 for core readiness failures", () =>
    Effect.gen(function* () {
      const response = yield* request(report("unready"), "/readyz");
      assert.strictEqual(response.status, 503);
      assert.deepEqual(yield* Effect.promise(() => response.json()), report("unready"));
    }),
  );

  it.effect("keeps both health routes outside command-readiness middleware", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const commandReadinessLayer = HttpRouter.middleware(
          (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
            httpEffect.pipe(
              Effect.andThen(Effect.die("command-readiness middleware reached a health route")),
            ),
          { global: false },
        ).layer;
        const commandRoute = HttpRouter.add(
          "GET",
          "/command",
          HttpServerResponse.empty({ status: 204 }),
        ).pipe(Layer.provide(commandReadinessLayer));
        return HttpRouter.toWebHandler(
          Layer.mergeAll(
            commandRoute,
            gatewayHealthRouteLayer.pipe(
              Layer.provide(
                Layer.succeed(
                  GatewayHealth,
                  GatewayHealth.of({ getReadiness: Effect.succeed(report("ready")) }),
                ),
              ),
            ),
          ),
          { disableLogger: true },
        );
      }),
      ({ handler }) =>
        Effect.gen(function* () {
          const invoke = (pathname: string) =>
            Effect.promise(() => handler(new Request(`http://localhost${pathname}`)));
          const liveness = yield* invoke("/healthz");
          const readiness = yield* invoke("/readyz");
          assert.strictEqual(liveness.status, 200);
          assert.strictEqual(readiness.status, 200);
        }),
      ({ dispose }) => Effect.promise(dispose),
    ),
  );
});
