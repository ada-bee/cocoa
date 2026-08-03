import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";

export const MAX_REPORTED_PROVIDERS = 32;

export type GatewayStartupState = "pending" | "ready" | "failed";
export type GatewayProviderState = "ready" | "connecting" | "disconnected" | "blocked" | "disabled";

export interface GatewayProviderHealth {
  readonly instanceId: ProviderInstanceId;
  readonly state: GatewayProviderState;
}

export interface GatewayReadinessReport {
  readonly status: "ready" | "degraded" | "unready";
  readonly checks: {
    readonly startup: GatewayStartupState;
    readonly database: "ready" | "failed";
    readonly webIndex: "ready" | "failed";
    readonly providers: "ready" | "degraded";
  };
  readonly providerCount: number;
  readonly providers: ReadonlyArray<GatewayProviderHealth>;
}

export interface GatewayHealthSources<DatabaseR = never, WebIndexR = never, ProvidersR = never> {
  readonly startupState: Effect.Effect<GatewayStartupState>;
  readonly databaseReady: Effect.Effect<boolean, never, DatabaseR>;
  readonly webIndexReady: Effect.Effect<boolean, never, WebIndexR>;
  readonly providerSnapshots: Effect.Effect<ReadonlyArray<ServerProvider>, never, ProvidersR>;
}

const summarizeProvider = (provider: ServerProvider): GatewayProviderHealth => ({
  instanceId: provider.instanceId,
  state:
    !provider.enabled || provider.status === "disabled"
      ? "disabled"
      : provider.availability === "unavailable" || provider.auth.status === "unauthenticated"
        ? "blocked"
        : provider.status === "ready"
          ? "ready"
          : provider.status === "warning"
            ? "connecting"
            : "disconnected",
});

/** Evaluate independent health sources concurrently without exposing their failure details. */
export const evaluateGatewayReadiness = Effect.fn("GatewayHealth.evaluateReadiness")(function* <
  DatabaseR,
  WebIndexR,
  ProvidersR,
>(sources: GatewayHealthSources<DatabaseR, WebIndexR, ProvidersR>) {
  const [startupState, databaseReady, webIndexReady, providerSnapshots] = yield* Effect.all(
    [
      sources.startupState,
      sources.databaseReady,
      sources.webIndexReady,
      sources.providerSnapshots,
    ] as const,
    { concurrency: "unbounded" },
  );

  const providers = providerSnapshots.slice(0, MAX_REPORTED_PROVIDERS).map(summarizeProvider);
  const providersDegraded = providerSnapshots.some(
    (provider) => provider.enabled && summarizeProvider(provider).state !== "ready",
  );
  const coreReady = startupState === "ready" && databaseReady && webIndexReady;

  return {
    status: !coreReady ? "unready" : providersDegraded ? "degraded" : "ready",
    checks: {
      startup: startupState,
      database: databaseReady ? "ready" : "failed",
      webIndex: webIndexReady ? "ready" : "failed",
      providers: providersDegraded ? "degraded" : "ready",
    },
    providerCount: providerSnapshots.length,
    providers,
  } satisfies GatewayReadinessReport;
});

export class GatewayWebIndexProbeError extends Schema.TaggedErrorClass<GatewayWebIndexProbeError>()(
  "GatewayWebIndexProbeError",
  { reason: Schema.Literals(["not-configured", "not-a-file"]) },
) {}

/** Minimal SQLite round trip used by readiness. */
export const probeGatewayDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`SELECT 1`;
});

/** Verify the exact index file the server is configured to serve. */
export const probeGatewayWebIndex = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const staticDir =
    config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
  if (staticDir === undefined) {
    return yield* new GatewayWebIndexProbeError({ reason: "not-configured" });
  }
  const indexInfo = yield* fileSystem.stat(path.resolve(staticDir, "index.html"));
  if (indexInfo.type !== "File") {
    return yield* new GatewayWebIndexProbeError({ reason: "not-a-file" });
  }
});

export class GatewayHealth extends Context.Service<
  GatewayHealth,
  {
    readonly getReadiness: Effect.Effect<GatewayReadinessReport>;
  }
>()("t3/health/GatewayHealth") {}

const make = Effect.gen(function* () {
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const startupState =
    startup.getCommandReadinessState ?? Effect.succeed<GatewayStartupState>("ready");

  return GatewayHealth.of({
    getReadiness: evaluateGatewayReadiness({
      startupState,
      databaseReady: probeGatewayDatabase.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
      webIndexReady: probeGatewayWebIndex.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
      providerSnapshots: providerRegistry.getProviders,
    }),
  });
});

export const layer = Layer.effect(GatewayHealth, make);
