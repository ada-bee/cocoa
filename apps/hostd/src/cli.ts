// @effect-diagnostics globalConsole:off - The standalone CLI writes directly to its caller-provided output streams.
// @effect-diagnostics nodeBuiltinImport:off - Host diagnostics inspect the local config file and Codex Unix socket.
/* eslint-disable t3code/no-global-process-runtime -- standalone hostd diagnostics read the local platform directly. */

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import {
  defaultAdvertiseUrl,
  defaultHostdConfigPath,
  loadHostdConfig,
  rotateHostdKey,
  updateHostdConfig,
  type HostdConfig,
  type HostdConfigOverrides,
  type HostdConfigStoreOptions,
} from "./config.ts";
import { pairingTokenForConfig, runHostd } from "./run.ts";
import { installService, uninstallService } from "./service/index.ts";

export interface HostdCliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIo: HostdCliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export const HOSTD_USAGE = [
  "Usage: cocoa-hostd <command> [options]",
  "",
  "Commands:",
  "  serve                 Start the host daemon",
  "  pair                  Print a pairing token for this installation",
  "  rotate-key            Rotate the host secret and print a new pairing token",
  "  config                Show non-secret configuration",
  "  config [options]      Update host configuration",
  "  status                Show installation and Codex socket status",
  "  doctor                Diagnose unsafe or unavailable host configuration",
  "  install               Install the per-user background service",
  "  uninstall             Remove the per-user background service",
  "",
  "Options:",
  "  --config PATH         Use an explicit hostd config file",
  "  --bind-host HOST      Address on which hostd listens (config only)",
  "  --port PORT           TCP port on which hostd listens (config only)",
  "  --advertise-url URL   Gateway-reachable ws:// or wss:// URL (config only)",
  "  --socket-path PATH    Codex app-server-control Unix socket (config only)",
].join("\n");

interface ParsedCli {
  readonly command: string;
  readonly store: HostdConfigStoreOptions;
  readonly configOverrides: Omit<HostdConfigOverrides, "key" | "installationId">;
  readonly help: boolean;
}

const takeValue = (args: ReadonlyArray<string>, index: number, option: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
};

export const parseHostdCli = (argv: ReadonlyArray<string>): ParsedCli => {
  const command = argv[0] ?? "serve";
  let configPath: string | undefined;
  let bindHost: string | undefined;
  let port: number | undefined;
  let advertiseUrl: string | undefined;
  let socketPath: string | undefined;
  let help = command === "help";

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    const value = takeValue(argv, index, argument);
    index += 1;
    switch (argument) {
      case "--config":
        configPath = value;
        break;
      case "--bind-host":
        bindHost = value;
        break;
      case "--port":
        port = Number(value);
        break;
      case "--advertise-url":
        advertiseUrl = value;
        break;
      case "--socket-path":
        socketPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return {
    command,
    store: configPath === undefined ? {} : { configPath },
    configOverrides: {
      ...(bindHost === undefined ? {} : { bindHost }),
      ...(port === undefined ? {} : { port }),
      ...(advertiseUrl === undefined ? {} : { advertiseUrl }),
      ...(socketPath === undefined ? {} : { socketPath }),
    },
    help,
  };
};

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  const parts = normalized.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/u.test(part));
};

const configSummary = (config: HostdConfig, configPath: string) => ({
  version: config.version,
  installationId: config.installationId,
  configPath,
  bindHost: config.bindHost,
  port: config.port,
  advertiseUrl: config.advertiseUrl,
  socketPath: config.socketPath,
});

const pathStatus = async (path: string): Promise<"missing" | "socket" | "other"> => {
  try {
    const stat = await NodeFSP.stat(path);
    return stat.isSocket() ? "socket" : "other";
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "missing";
    return "other";
  }
};

export interface HostdDoctorFinding {
  readonly level: "ok" | "warning" | "error";
  readonly check: string;
  readonly message: string;
}

export const diagnoseHostd = async (
  config: HostdConfig,
  options: HostdConfigStoreOptions = {},
): Promise<ReadonlyArray<HostdDoctorFinding>> => {
  const findings: HostdDoctorFinding[] = [];
  const socketStatus = await pathStatus(config.socketPath);
  findings.push(
    socketStatus === "socket"
      ? { level: "ok", check: "codex-socket", message: "Codex control socket is available." }
      : socketStatus === "missing"
        ? { level: "error", check: "codex-socket", message: "Codex control socket is missing." }
        : {
            level: "error",
            check: "codex-socket",
            message: "Configured Codex control path is not a Unix socket.",
          },
  );

  const advertised = new URL(config.advertiseUrl);
  const bindLoopback = isLoopbackHost(config.bindHost);
  const advertiseLoopback = isLoopbackHost(advertised.hostname);
  if (!bindLoopback && advertised.protocol === "ws:") {
    findings.push({
      level: "warning",
      check: "transport-security",
      message:
        "Hostd is exposed beyond loopback over plaintext WebSocket; use TLS or a private trusted network.",
    });
  } else {
    findings.push({
      level: "ok",
      check: "transport-security",
      message: bindLoopback ? "Hostd is bound to loopback." : "The advertised endpoint uses TLS.",
    });
  }
  if (bindLoopback !== advertiseLoopback) {
    findings.push({
      level: "warning",
      check: "reachability",
      message:
        "Bind and advertised hosts have different loopback reachability; verify reverse-proxy routing.",
    });
  }

  if ((options.platform ?? NodeOS.platform()) !== "win32") {
    try {
      const mode = (await NodeFSP.stat(defaultHostdConfigPath(options))).mode & 0o777;
      findings.push(
        mode === 0o600
          ? { level: "ok", check: "config-permissions", message: "Config permissions are 0600." }
          : {
              level: "warning",
              check: "config-permissions",
              message: `Config permissions are ${mode.toString(8).padStart(3, "0")}; expected 600.`,
            },
      );
    } catch {
      findings.push({
        level: "error",
        check: "config-permissions",
        message: "Config file could not be inspected.",
      });
    }
  }
  return findings;
};

export const runHostdCli = async (
  argv: ReadonlyArray<string>,
  io: HostdCliIo = defaultIo,
): Promise<number> => {
  let parsed: ParsedCli;
  try {
    parsed = parseHostdCli(argv);
  } catch (cause) {
    io.stderr(cause instanceof Error ? cause.message : String(cause));
    io.stderr(HOSTD_USAGE);
    return 1;
  }
  if (parsed.help) {
    io.stdout(HOSTD_USAGE);
    return 0;
  }

  if (parsed.command !== "config" && Object.keys(parsed.configOverrides).length > 0) {
    io.stderr("Network options may only be changed with the config command.");
    return 1;
  }

  const configOptions = parsed.store;
  try {
    switch (parsed.command) {
      case "serve": {
        const config = await loadHostdConfig(configOptions);
        const hostd = runHostd(config);
        io.stdout(`cocoa-hostd installation ${config.installationId} is running.`);
        io.stdout("Run 'cocoa-hostd pair' to print a pairing token.");
        let shuttingDown = false;
        const shutdown = async (): Promise<void> => {
          if (shuttingDown) return;
          shuttingDown = true;
          await hostd.stop();
          process.exit(0);
        };
        process.once("SIGINT", () => void shutdown());
        process.once("SIGTERM", () => void shutdown());
        return 0;
      }
      case "pair": {
        const config = await loadHostdConfig(configOptions);
        io.stdout("Pair this host from Cocoa Connections by pasting:");
        io.stdout(pairingTokenForConfig(config));
        return 0;
      }
      case "rotate-key": {
        const config = await rotateHostdKey(configOptions);
        io.stdout("Rotated the host secret. Existing gateway connections must be paired again:");
        io.stdout(pairingTokenForConfig(config));
        return 0;
      }
      case "config": {
        const current = await loadHostdConfig(configOptions);
        const hasUpdates = Object.keys(parsed.configOverrides).length > 0;
        const overrides = { ...parsed.configOverrides };
        if (
          overrides.port !== undefined &&
          overrides.advertiseUrl === undefined &&
          current.advertiseUrl === defaultAdvertiseUrl(current.port)
        ) {
          overrides.advertiseUrl = defaultAdvertiseUrl(overrides.port);
        }
        const config = hasUpdates ? await updateHostdConfig(overrides, configOptions) : current;
        io.stdout(
          JSON.stringify(configSummary(config, defaultHostdConfigPath(configOptions)), null, 2),
        );
        return 0;
      }
      case "status": {
        const config = await loadHostdConfig(configOptions);
        io.stdout(
          JSON.stringify(
            {
              ...configSummary(config, defaultHostdConfigPath(configOptions)),
              codexSocket: await pathStatus(config.socketPath),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      case "doctor": {
        const config = await loadHostdConfig(configOptions);
        const findings = await diagnoseHostd(config, configOptions);
        for (const finding of findings) {
          io.stdout(`${finding.level.toUpperCase()} ${finding.check}: ${finding.message}`);
        }
        return findings.some(({ level }) => level === "error") ? 1 : 0;
      }
      case "install": {
        const config = await loadHostdConfig(configOptions);
        const configPath = defaultHostdConfigPath(configOptions);
        const installed = await installService({
          command: [process.execPath, "serve", "--config", configPath],
        });
        const location =
          installed.definitionPath === undefined ? "" : ` at ${installed.definitionPath}`;
        io.stdout(`Installed ${installed.serviceName}${location}`);
        io.stdout(`Host installation: ${config.installationId}`);
        io.stdout("Run 'cocoa-hostd pair' to print its pairing token.");
        return 0;
      }
      case "uninstall": {
        const removed = await uninstallService();
        io.stdout(removed ? "Uninstalled cocoa-hostd" : "cocoa-hostd is not installed");
        return 0;
      }
      default:
        io.stderr(`Unknown command: ${parsed.command}`);
        io.stderr(HOSTD_USAGE);
        return 1;
    }
  } catch (cause) {
    io.stderr(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
};
