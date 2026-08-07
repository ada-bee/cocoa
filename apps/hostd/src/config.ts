// @effect-diagnostics nodeBuiltinImport:off - The standalone daemon owns its small, host-local configuration without the gateway Effect runtime.
/* eslint-disable t3code/no-global-process-runtime -- standalone hostd configuration is intentionally outside the gateway Effect runtime. */

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const HOSTD_CONFIG_VERSION = 1 as const;
export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4501;

export interface HostdConfig {
  readonly version: typeof HOSTD_CONFIG_VERSION;
  readonly installationId: string;
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
  readonly installationId?: string;
}

export interface HostdConfigStoreOptions {
  readonly configPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

export class HostdConfigError extends Error {
  override readonly name = "HostdConfigError";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export const defaultCodexSocketPath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory = NodeOS.homedir(),
): string => {
  const configuredHome = environment.CODEX_HOME?.trim();
  const codexHome =
    configuredHome === undefined || configuredHome.length === 0
      ? NodePath.join(homeDirectory, ".codex")
      : configuredHome;
  return NodePath.join(codexHome, "app-server-control", "app-server-control.sock");
};

export const defaultAdvertiseUrl = (port: number): string => `ws://${DEFAULT_BIND_HOST}:${port}/`;

export const generateHostdKey = (): string => NodeCrypto.randomBytes(32).toString("base64url");

export const defaultHostdConfigPath = (options: HostdConfigStoreOptions = {}): string => {
  const environment = options.environment ?? process.env;
  const explicit = options.configPath ?? environment.COCOA_HOSTD_CONFIG_PATH?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    if (!NodePath.isAbsolute(explicit)) {
      throw new HostdConfigError("The cocoa-hostd config path must be absolute.");
    }
    return explicit;
  }

  const homeDirectory = options.homeDirectory ?? NodeOS.homedir();
  const platform = options.platform ?? NodeOS.platform();
  if (platform === "darwin") {
    return NodePath.join(homeDirectory, "Library", "Application Support", "Cocoa", "hostd.json");
  }
  if (platform === "win32") {
    const appData = environment.APPDATA?.trim();
    return NodePath.join(
      appData && NodePath.isAbsolute(appData) ? appData : homeDirectory,
      "Cocoa",
      "hostd.json",
    );
  }
  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
  const configHome =
    xdgConfigHome && NodePath.isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : NodePath.join(homeDirectory, ".config");
  return NodePath.join(configHome, "cocoa", "hostd.json");
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new HostdConfigError(`Invalid cocoa-hostd config field '${field}'.`);
  }
  return value;
};

const requirePort = (value: unknown, allowEphemeral = false): number => {
  const minimum = allowEphemeral ? 0 : 1;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 65_535) {
    throw new HostdConfigError("The cocoa-hostd port must be an integer between 1 and 65535.");
  }
  return value as number;
};

const requireAdvertiseUrl = (value: unknown): string => {
  const text = requireString(value, "advertiseUrl");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch (cause) {
    throw new HostdConfigError("The cocoa-hostd advertise URL is invalid.", cause);
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new HostdConfigError(
      "The cocoa-hostd advertise URL must be a ws:// or wss:// URL without credentials, query, or fragment.",
    );
  }
  return text;
};

const requireKey = (value: unknown, requireStrong = false): string => {
  const key = requireString(value, "key");
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
    throw new HostdConfigError("The cocoa-hostd key must contain only base64url characters.");
  }
  if (requireStrong && key.length !== 43) {
    throw new HostdConfigError("The persisted cocoa-hostd key must be a 256-bit base64url secret.");
  }
  return key;
};

export const decodeHostdConfig = (value: unknown): HostdConfig => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostdConfigError("The cocoa-hostd config file must contain a JSON object.");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== HOSTD_CONFIG_VERSION) {
    throw new HostdConfigError(
      `Unsupported cocoa-hostd config version '${String(input.version)}'.`,
    );
  }
  return {
    version: HOSTD_CONFIG_VERSION,
    installationId: requireString(input.installationId, "installationId"),
    bindHost: requireString(input.bindHost, "bindHost"),
    port: requirePort(input.port),
    advertiseUrl: requireAdvertiseUrl(input.advertiseUrl),
    socketPath: requireString(input.socketPath, "socketPath"),
    key: requireKey(input.key, true),
  };
};

export const makeHostdConfig = (
  overrides: HostdConfigOverrides = {},
  options: Pick<HostdConfigStoreOptions, "environment" | "homeDirectory"> = {},
): HostdConfig => {
  const port = requirePort(overrides.port ?? DEFAULT_PORT, true);
  return {
    version: HOSTD_CONFIG_VERSION,
    installationId: overrides.installationId ?? NodeCrypto.randomUUID(),
    bindHost: overrides.bindHost ?? DEFAULT_BIND_HOST,
    port,
    advertiseUrl: requireAdvertiseUrl(overrides.advertiseUrl ?? defaultAdvertiseUrl(port)),
    socketPath:
      overrides.socketPath ??
      defaultCodexSocketPath(options.environment, options.homeDirectory ?? NodeOS.homedir()),
    key: requireKey(overrides.key ?? generateHostdKey()),
  };
};

const writeConfig = async (path: string, config: HostdConfig): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${NodeCrypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await NodeFSP.rename(temporaryPath, path);
    if (NodeOS.platform() !== "win32") await NodeFSP.chmod(path, 0o600);
  } catch (cause) {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new HostdConfigError(`Could not write cocoa-hostd config at '${path}'.`, cause);
  }
};

const createConfig = async (path: string, config: HostdConfig): Promise<HostdConfig> => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${NodeCrypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      // Same-directory hard-link creation is atomic and never replaces an
      // existing file, so concurrent first runs converge on one identity.
      await NodeFSP.link(temporaryPath, path);
      if (NodeOS.platform() !== "win32") await NodeFSP.chmod(path, 0o600);
      return config;
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
      return decodeHostdConfig(JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown);
    }
  } catch (cause) {
    if (cause instanceof HostdConfigError) throw cause;
    throw new HostdConfigError(`Could not create cocoa-hostd config at '${path}'.`, cause);
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

export const saveHostdConfig = async (
  config: HostdConfig,
  options: HostdConfigStoreOptions = {},
): Promise<void> => writeConfig(defaultHostdConfigPath(options), decodeHostdConfig(config));

export const loadHostdConfig = async (
  options: HostdConfigStoreOptions = {},
): Promise<HostdConfig> => {
  const path = defaultHostdConfigPath(options);
  try {
    const contents = await NodeFSP.readFile(path, "utf8");
    const config = decodeHostdConfig(JSON.parse(contents) as unknown);
    if ((options.platform ?? NodeOS.platform()) !== "win32") await NodeFSP.chmod(path, 0o600);
    return config;
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
      if (cause instanceof HostdConfigError) throw cause;
      throw new HostdConfigError(`Could not read cocoa-hostd config at '${path}'.`, cause);
    }
  }

  const config = makeHostdConfig({}, options);
  return createConfig(path, config);
};

export const updateHostdConfig = async (
  overrides: Omit<HostdConfigOverrides, "key" | "installationId">,
  options: HostdConfigStoreOptions = {},
): Promise<HostdConfig> => {
  const current = await loadHostdConfig(options);
  const next = decodeHostdConfig({ ...current, ...overrides });
  await saveHostdConfig(next, options);
  return next;
};

export const rotateHostdKey = async (
  options: HostdConfigStoreOptions = {},
): Promise<HostdConfig> => {
  const current = await loadHostdConfig(options);
  const next = { ...current, key: generateHostdKey() };
  await saveHostdConfig(next, options);
  return next;
};
