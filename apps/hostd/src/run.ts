import { type HostdConfig } from "./config.ts";
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

export const runHostd = (config: HostdConfig): RunningHostdWithPairing => {
  const running = startHostd(config);
  const token = pairingTokenForConfig(config);
  return { ...running, token };
};
