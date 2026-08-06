import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import type * as ServerConfig from "./config.ts";
import { type CliServerFlags, sharedServerCommandFlags } from "./cli/config.ts";
import { runServerCommand } from "./cli/server.ts";

const {
  runtimeProfile: _runtimeProfile,
  tailscaleServeEnabled: _tailscaleServe,
  tailscaleServePort: _tailscaleServePort,
  cwd: _cwd,
  autoBootstrapProjectFromCwd: _autoBootstrapProjectFromCwd,
  ...cocoaServerCommandFlags
} = sharedServerCommandFlags;

type CocoaServerFlags = Omit<
  CliServerFlags,
  | "runtimeProfile"
  | "tailscaleServeEnabled"
  | "tailscaleServePort"
  | "cwd"
  | "autoBootstrapProjectFromCwd"
>;

const runCocoaGateway = (
  flags: CocoaServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  runServerCommand(
    {
      ...flags,
      runtimeProfile: Option.some("cocoa-gateway"),
      tailscaleServeEnabled: Option.some(false),
      tailscaleServePort: Option.none(),
      cwd: Option.none(),
      autoBootstrapProjectFromCwd: Option.some(false),
    },
    options,
  );

const cocoaStartCommand = Command.make("start", cocoaServerCommandFlags).pipe(
  Command.withDescription("Run the Cocoa gateway."),
  Command.withHandler((flags) => runCocoaGateway(flags)),
);

const cocoaServeCommand = Command.make("serve", cocoaServerCommandFlags).pipe(
  Command.withDescription(
    "Run the Cocoa gateway without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runCocoaGateway(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);

/**
 * Cocoa's deployment-only CLI. Keep this import graph deliberately narrower
 * than `bin.ts`: local service management, hosted connectivity, and their
 * Node-only preflight dependencies do not belong in the Bun gateway image.
 */
export const cocoaCli = Command.make("cocoa-gateway", cocoaServerCommandFlags).pipe(
  Command.withDescription("Run the self-hosted Cocoa gateway."),
  Command.withHandler((flags) => runCocoaGateway(flags)),
  Command.withSubcommands([cocoaStartCommand, cocoaServeCommand]),
);

const CocoaCliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

if (import.meta.main) {
  Command.run(cocoaCli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CocoaCliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
