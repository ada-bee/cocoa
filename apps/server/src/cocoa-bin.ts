import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Command, GlobalFlag } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { ServerConfig as ServerConfigService, type StartupPresentation } from "./config.ts";
import {
  cocoaGatewayCommandFlags,
  type CocoaGatewayCliFlags,
  resolveCocoaGatewayConfig,
} from "./cocoa/CocoaGatewayCliConfig.ts";
import { runCocoaGatewayServer } from "./cocoa/CocoaGatewayServer.ts";

const runCocoaGateway = (
  flags: CocoaGatewayCliFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCocoaGatewayConfig(flags, logLevel, options);
    if (config.cocoaPasswordGenerated && config.cocoaPassword) {
      yield* Console.log(`Generated Cocoa password: ${Redacted.value(config.cocoaPassword)}`);
    }
    return yield* runCocoaGatewayServer.pipe(Effect.provideService(ServerConfigService, config));
  });

const cocoaStartCommand = Command.make("start", cocoaGatewayCommandFlags).pipe(
  Command.withDescription("Run the Cocoa gateway."),
  Command.withHandler((flags) => runCocoaGateway(flags)),
);

const cocoaServeCommand = Command.make("serve", cocoaGatewayCommandFlags).pipe(
  Command.withDescription(
    "Run the Cocoa gateway without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runCocoaGateway(flags, {
      startupPresentation: "headless",
    }),
  ),
);

/**
 * Cocoa's deployment-only CLI. Keep this import graph deliberately narrower
 * than `bin.ts`: local service management, hosted connectivity, and their
 * Node-only preflight dependencies do not belong in the Bun gateway image.
 */
export const cocoaCli = Command.make("cocoa-gateway", cocoaGatewayCommandFlags).pipe(
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
