// @effect-diagnostics nodeBuiltinImport:off - Service-manager integration needs direct host filesystem and path APIs and deliberately stays independent of the gateway Effect runtime.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

export const HOSTD_SERVICE_LABEL = "xyz.brbc.cocoa-hostd";
export const HOSTD_SYSTEMD_UNIT = "cocoa-hostd.service";
export const HOSTD_WINDOWS_TASK = "Cocoa Hostd";

export type HostdServicePlatform = "darwin" | "linux" | "win32";

export interface HostdServiceCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly allowFailure?: boolean;
}

export interface HostdServiceCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostdServiceIo {
  readonly exists: (path: string) => Promise<boolean>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly run: (command: HostdServiceCommand) => Promise<HostdServiceCommandResult>;
}

export interface HostdServiceOptions {
  /** The complete argv that should be launched by the service manager. */
  readonly command?: ReadonlyArray<string>;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly uid?: number;
  readonly io?: HostdServiceIo;
}

export interface HostdServiceInstallResult {
  readonly platform: HostdServicePlatform;
  readonly serviceName: string;
  readonly definitionPath?: string;
}

export interface HostdServicePlan extends HostdServiceInstallResult {
  readonly definition?: string;
  readonly directories: ReadonlyArray<string>;
  readonly beforeInstall: ReadonlyArray<HostdServiceCommand>;
  readonly install: ReadonlyArray<HostdServiceCommand>;
  readonly status?: HostdServiceCommand;
  readonly uninstall: ReadonlyArray<HostdServiceCommand>;
  readonly afterUninstall: ReadonlyArray<HostdServiceCommand>;
}

export class HostdServiceError extends Error {
  override readonly name = "HostdServiceError";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const escapeSystemdSpecifier = (value: string): string => value.replaceAll("%", "%%");

const quoteSystemdArgument = (value: string): string => {
  const escaped = escapeSystemdSpecifier(value);
  if (!/[\s"'\\]/.test(escaped)) return escaped;
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};

/** Quote one argv item for the command-line string stored by Windows Task Scheduler. */
const quoteWindowsArgument = (value: string): string => {
  if (value !== "" && !/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
};

export const renderLaunchAgent = (input: {
  readonly command: ReadonlyArray<string>;
  readonly logPath: string;
}): string => {
  const argumentsXml = input.command
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${HOSTD_SERVICE_LABEL}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    argumentsXml,
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>ProcessType</key>",
    "    <string>Background</string>",
    "    <key>StandardOutPath</key>",
    `    <string>${escapeXml(input.logPath)}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${escapeXml(input.logPath)}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
};

export const renderSystemdUnit = (command: ReadonlyArray<string>): string =>
  [
    "[Unit]",
    "Description=Cocoa host daemon",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${command.map(quoteSystemdArgument).join(" ")}`,
    "Restart=always",
    "RestartSec=3",
    "KillMode=control-group",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

export const renderWindowsTaskCommand = (command: ReadonlyArray<string>): string =>
  command.map(quoteWindowsArgument).join(" ");

const requireCommand = (command: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (command.length === 0 || command[0]?.trim() === "") {
    throw new HostdServiceError("A cocoa-hostd executable is required to install the service.");
  }
  return command;
};

/** Service installation is a distribution-binary operation; source runs can inject command. */
const defaultCommand = (): ReadonlyArray<string> => [NodeProcess.execPath, "serve"];

const requirePlatform = (platform: NodeJS.Platform): HostdServicePlatform => {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new HostdServiceError(
    `cocoa-hostd service installation is not supported on '${platform}'.`,
  );
};

export function makeServicePlan(options: HostdServiceOptions = {}): HostdServicePlan {
  const platform = requirePlatform(options.platform ?? NodeProcess.platform);
  const homeDirectory = options.homeDirectory ?? NodeOS.homedir();
  const command = requireCommand(options.command ?? defaultCommand());

  if (platform === "darwin") {
    const uid = options.uid ?? NodeProcess.getuid?.();
    if (uid === undefined) {
      throw new HostdServiceError("The current user id is required to install a launch agent.");
    }
    const definitionPath = NodePath.join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${HOSTD_SERVICE_LABEL}.plist`,
    );
    const logDirectory = NodePath.join(homeDirectory, "Library", "Logs", "Cocoa");
    const logPath = NodePath.join(logDirectory, "hostd.log");
    const domain = `gui/${uid}`;
    const serviceTarget = `${domain}/${HOSTD_SERVICE_LABEL}`;
    return {
      platform,
      serviceName: HOSTD_SERVICE_LABEL,
      definitionPath,
      definition: renderLaunchAgent({ command, logPath }),
      directories: [NodePath.dirname(definitionPath), logDirectory],
      beforeInstall: [
        {
          executable: "/bin/launchctl",
          args: ["bootout", domain, definitionPath],
          allowFailure: true,
        },
      ],
      install: [
        { executable: "/bin/launchctl", args: ["bootstrap", domain, definitionPath] },
        { executable: "/bin/launchctl", args: ["enable", serviceTarget] },
        { executable: "/bin/launchctl", args: ["kickstart", "-k", serviceTarget] },
      ],
      uninstall: [
        {
          executable: "/bin/launchctl",
          args: ["bootout", domain, definitionPath],
          allowFailure: true,
        },
      ],
      afterUninstall: [],
    };
  }

  if (platform === "linux") {
    const definitionPath = NodePath.join(
      homeDirectory,
      ".config",
      "systemd",
      "user",
      HOSTD_SYSTEMD_UNIT,
    );
    return {
      platform,
      serviceName: HOSTD_SYSTEMD_UNIT,
      definitionPath,
      definition: renderSystemdUnit(command),
      directories: [NodePath.dirname(definitionPath)],
      beforeInstall: [
        {
          executable: "systemctl",
          args: ["--user", "stop", HOSTD_SYSTEMD_UNIT],
          allowFailure: true,
        },
      ],
      install: [
        { executable: "systemctl", args: ["--user", "daemon-reload"] },
        { executable: "systemctl", args: ["--user", "enable", "--now", HOSTD_SYSTEMD_UNIT] },
        { executable: "loginctl", args: ["enable-linger"] },
      ],
      uninstall: [
        {
          executable: "systemctl",
          args: ["--user", "disable", "--now", HOSTD_SYSTEMD_UNIT],
          allowFailure: true,
        },
      ],
      afterUninstall: [{ executable: "systemctl", args: ["--user", "daemon-reload"] }],
    };
  }

  const taskCommand = renderWindowsTaskCommand(command);
  return {
    platform,
    serviceName: HOSTD_WINDOWS_TASK,
    directories: [],
    beforeInstall: [],
    install: [
      {
        executable: "schtasks.exe",
        args: [
          "/Create",
          "/TN",
          HOSTD_WINDOWS_TASK,
          "/SC",
          "ONLOGON",
          "/RL",
          "LIMITED",
          "/TR",
          taskCommand,
          "/F",
        ],
      },
      { executable: "schtasks.exe", args: ["/Run", "/TN", HOSTD_WINDOWS_TASK] },
    ],
    status: {
      executable: "schtasks.exe",
      args: ["/Query", "/TN", HOSTD_WINDOWS_TASK],
    },
    uninstall: [
      {
        executable: "schtasks.exe",
        args: ["/End", "/TN", HOSTD_WINDOWS_TASK],
        allowFailure: true,
      },
      {
        executable: "schtasks.exe",
        args: ["/Delete", "/TN", HOSTD_WINDOWS_TASK, "/F"],
      },
    ],
    afterUninstall: [],
  };
}

const defaultIo: HostdServiceIo = {
  exists: async (path) => {
    try {
      await NodeFSP.access(path);
      return true;
    } catch {
      return false;
    }
  },
  makeDirectory: async (path) => {
    await NodeFSP.mkdir(path, { recursive: true });
  },
  writeFile: async (path, contents) => {
    await NodeFSP.writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  },
  removeFile: async (path) => {
    await NodeFSP.rm(path, { force: true });
  },
  run: async ({ executable, args }) => {
    const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  },
};

const runCommand = async (io: HostdServiceIo, command: HostdServiceCommand): Promise<void> => {
  let result: HostdServiceCommandResult;
  try {
    result = await io.run(command);
  } catch (cause) {
    if (command.allowFailure === true) return;
    throw new HostdServiceError(`Could not run ${command.executable}.`, cause);
  }
  if (result.exitCode !== 0 && command.allowFailure !== true) {
    throw new HostdServiceError(
      `${command.executable} exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
};

export async function installService(
  options: HostdServiceOptions = {},
): Promise<HostdServiceInstallResult> {
  const plan = makeServicePlan(options);
  const io = options.io ?? defaultIo;
  try {
    for (const directory of plan.directories) await io.makeDirectory(directory);
    for (const command of plan.beforeInstall) await runCommand(io, command);
    if (plan.definitionPath !== undefined && plan.definition !== undefined) {
      await io.writeFile(plan.definitionPath, plan.definition);
    }
    for (const command of plan.install) await runCommand(io, command);
    return {
      platform: plan.platform,
      serviceName: plan.serviceName,
      ...(plan.definitionPath === undefined ? {} : { definitionPath: plan.definitionPath }),
    };
  } catch (cause) {
    if (cause instanceof HostdServiceError) throw cause;
    throw new HostdServiceError("Could not install the cocoa-hostd service.", cause);
  }
}

export async function uninstallService(options: HostdServiceOptions = {}): Promise<boolean> {
  const plan = makeServicePlan(options);
  const io = options.io ?? defaultIo;
  try {
    if (plan.definitionPath !== undefined && !(await io.exists(plan.definitionPath))) return false;
    if (plan.status !== undefined) {
      const result = await io.run(plan.status);
      if (result.exitCode !== 0) return false;
    }
    for (const command of plan.uninstall) await runCommand(io, command);
    if (plan.definitionPath !== undefined) await io.removeFile(plan.definitionPath);
    for (const command of plan.afterUninstall) await runCommand(io, command);
    return true;
  } catch (cause) {
    if (cause instanceof HostdServiceError) throw cause;
    throw new HostdServiceError("Could not uninstall the cocoa-hostd service.", cause);
  }
}
