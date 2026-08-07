// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import { PortSchema } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Flag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import { normalizeCocoaBuildIdentity } from "../health/CocoaDeploymentIdentity.ts";

const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Gateway HTTP port."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Gateway bind host/interface."),
  Flag.optional,
);
const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Gateway data directory (equivalent to T3CODE_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Development web URL (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Do not open a browser during startup."),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withAlias("log-ws-events"),
  Flag.withDescription("Log outbound WebSocket push traffic."),
  Flag.optional,
);

export const cocoaGatewayCommandFlags = {
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

export interface CocoaGatewayCliFlags {
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

const CocoaGatewayEnvConfig = Config.all({
  buildIdentity: Config.string("COCOA_BUILD_IDENTITY").pipe(Config.option),
  logLevel: Config.logLevel("T3CODE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  port: Config.port("T3CODE_PORT").pipe(Config.option),
  host: Config.string("T3CODE_HOST").pipe(Config.option),
  baseDir: Config.string("T3CODE_HOME").pipe(Config.option),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option),
  devAllowedOrigins: Config.string("T3CODE_DEV_ALLOWED_ORIGINS").pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ),
  noBrowser: Config.boolean("T3CODE_NO_BROWSER").pipe(Config.option),
  logWebSocketEvents: Config.boolean("T3CODE_LOG_WS_EVENTS").pipe(Config.option),
});

const first = <A>(...values: ReadonlyArray<Option.Option<A>>): Option.Option<A> =>
  Option.firstSomeOf(values);

const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const path = yield* Path.Path;
  if (raw === undefined || raw.trim().length === 0) {
    return path.join(NodeOS.homedir(), ".t3");
  }
  const trimmed = raw.trim();
  const expanded =
    trimmed === "~"
      ? NodeOS.homedir()
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? path.join(NodeOS.homedir(), trimmed.slice(2))
        : trimmed;
  return path.resolve(expanded);
});

export const resolveCocoaGatewayConfig = (
  flags: CocoaGatewayCliFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: { readonly startupPresentation?: ServerConfig.StartupPresentation },
) =>
  Effect.gen(function* () {
    const env = yield* CocoaGatewayEnvConfig;
    const net = yield* NetService.NetService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const port = yield* Option.match(first(flags.port, env.port), {
      onSome: Effect.succeed,
      onNone: () => net.findAvailablePort(ServerConfig.DEFAULT_PORT),
    });
    const baseDir = yield* resolveBaseDir(Option.getOrUndefined(first(flags.baseDir, env.baseDir)));
    const devUrl = Option.getOrUndefined(first(flags.devUrl, env.devUrl));
    const explicitBaseDir = Option.isSome(first(flags.baseDir, env.baseDir));
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
      baseDirIsExplicit: explicitBaseDir,
    });
    yield* ServerConfig.ensureServerDirectories(derivedPaths);
    yield* fs.makeDirectory(path.dirname(derivedPaths.serverRuntimeStatePath), {
      recursive: true,
    });
    const staticDir = devUrl === undefined ? yield* ServerConfig.resolveStaticDir() : undefined;
    const startupPresentation = options?.startupPresentation ?? "browser";
    const noBrowser = Option.getOrElse(
      first(
        startupPresentation === "headless" ? Option.some(true) : Option.none(),
        flags.noBrowser,
        env.noBrowser,
      ),
      () => false,
    );

    return ServerConfig.ServerConfig.of({
      ...derivedPaths,
      logLevel: Option.getOrElse(cliLogLevel, () => env.logLevel),
      traceMinLevel: "None",
      traceTimingEnabled: false,
      traceBatchWindowMs: 1_000,
      traceMaxBytes: 0,
      traceMaxFiles: 0,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "cocoa-gateway",
      mode: "web",
      runtimeProfile: "cocoa-gateway",
      buildIdentity: normalizeCocoaBuildIdentity(Option.getOrUndefined(env.buildIdentity)),
      port,
      host: Option.getOrUndefined(first(flags.host, env.host)),
      cwd: baseDir,
      baseDir,
      staticDir,
      devUrl,
      devAllowedOrigins: env.devAllowedOrigins,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken: undefined,
      desktopTelemetryFd: undefined,
      desktopTelemetryControlFd: undefined,
      resourceMonitorPath: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: Option.getOrElse(
        first(flags.logWebSocketEvents, env.logWebSocketEvents),
        () => devUrl !== undefined,
      ),
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    });
  });
