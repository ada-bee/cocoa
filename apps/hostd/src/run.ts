// @effect-diagnostics globalConsole:off - Pairing output must be printed directly when the standalone daemon launches.

import { makeHostdConfig, type HostdConfig, type HostdConfigOverrides } from "./config.ts";
import { encodePairingToken } from "./pairing.ts";
import { startHostd, type RunningHostd } from "./relay.ts";

export interface RunningHostdWithPairing extends RunningHostd {
  readonly token: string;
}

export const pairingTokenForConfig = (config: HostdConfig): string =>
  encodePairingToken({
    version: 1,
    url: config.advertiseUrl,
    key: config.key,
  });

export const runHostd = (overrides: HostdConfigOverrides = {}): RunningHostdWithPairing => {
  const config = makeHostdConfig(overrides);
  const running = startHostd(config);
  const token = pairingTokenForConfig(config);
  console.log("Pair this host from Cocoa Connections by pasting:");
  console.log(token);
  return { ...running, token };
};
