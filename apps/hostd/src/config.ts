// @effect-diagnostics nodeBuiltinImport:off - The standalone host daemon resolves native host identity and Codex paths without an Effect runtime.

import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const DEFAULT_BIND_HOST = "0.0.0.0";
export const DEFAULT_PORT = 4501;

export interface HostdConfig {
  readonly bindHost: string;
  readonly port: number;
  readonly advertiseUrl: string;
  readonly socketPath: string;
  readonly key: string;
}

export interface HostdConfigOverrides {
  readonly bindHost?: string;
  readonly port?: number;
  readonly advertiseUrl?: string;
  readonly socketPath?: string;
  readonly key?: string;
}

export const defaultCodexSocketPath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const configuredHome = environment.CODEX_HOME?.trim();
  const codexHome =
    configuredHome === undefined || configuredHome.length === 0
      ? NodePath.join(NodeOS.homedir(), ".codex")
      : configuredHome;
  return NodePath.join(codexHome, "app-server-control", "app-server-control.sock");
};

export const defaultAdvertiseUrl = (port: number): string => `ws://${NodeOS.hostname()}:${port}/`;

export const defaultPairingKey = (advertiseUrl: string): string =>
  NodeCrypto.createHash("sha256")
    .update("cocoa-hostd/pairing-key/v1\0", "utf8")
    .update(advertiseUrl, "utf8")
    .digest("base64url");

export const makeHostdConfig = (overrides: HostdConfigOverrides = {}): HostdConfig => {
  const port = overrides.port ?? DEFAULT_PORT;
  const advertiseUrl = overrides.advertiseUrl ?? defaultAdvertiseUrl(port);
  return {
    bindHost: overrides.bindHost ?? DEFAULT_BIND_HOST,
    port,
    advertiseUrl,
    socketPath: overrides.socketPath ?? defaultCodexSocketPath(),
    key: overrides.key ?? defaultPairingKey(advertiseUrl),
  };
};
