#!/usr/bin/env bun
// @effect-diagnostics globalConsole:off - This standalone CLI writes launch and pairing output directly to its terminal or service log.

import { makeHostdConfig } from "./config.ts";
import { pairingTokenForConfig, runHostd } from "./run.ts";
import { installService, uninstallService } from "./service/index.ts";

const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve": {
    const hostd = runHostd();
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      await hostd.stop();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    break;
  }
  case "install": {
    try {
      const installed = await installService();
      const location =
        installed.definitionPath === undefined ? "" : ` at ${installed.definitionPath}`;
      console.log(`Installed ${installed.serviceName}${location}`);
      console.log("Pair this host from Cocoa Connections by pasting:");
      console.log(pairingTokenForConfig(makeHostdConfig()));
    } catch (cause) {
      console.error("Could not install cocoa-hostd", cause);
      process.exitCode = 1;
    }
    break;
  }
  case "uninstall": {
    try {
      const removed = await uninstallService();
      console.log(removed ? "Uninstalled cocoa-hostd" : "cocoa-hostd is not installed");
    } catch (cause) {
      console.error("Could not uninstall cocoa-hostd", cause);
      process.exitCode = 1;
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: cocoa-hostd [serve|install|uninstall]");
    process.exitCode = 1;
}
