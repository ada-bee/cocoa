import { describe, expect, it } from "bun:test";

import {
  HOSTD_SERVICE_LABEL,
  HOSTD_SYSTEMD_UNIT,
  HOSTD_WINDOWS_TASK,
  installService,
  makeServicePlan,
  renderWindowsTaskCommand,
  uninstallService,
  type HostdServiceCommand,
  type HostdServiceIo,
} from "./service.ts";

const command = ["/Applications/Cocoa Host/cocoa-hostd", "serve"];

describe("cocoa-hostd service plans", () => {
  it("renders a launch agent with stable naming, logging, and escaped arguments", () => {
    const plan = makeServicePlan({
      platform: "darwin",
      homeDirectory: "/Users/test & user",
      uid: 501,
      command: ["/tmp/Cocoa & Host/cocoa-hostd", "serve"],
    });

    expect(plan.serviceName).toBe(HOSTD_SERVICE_LABEL);
    expect(plan.definitionPath).toBe(
      `/Users/test & user/Library/LaunchAgents/${HOSTD_SERVICE_LABEL}.plist`,
    );
    expect(plan.definition).toContain("<string>/tmp/Cocoa &amp; Host/cocoa-hostd</string>");
    expect(plan.definition).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plan.install.map(({ args }) => args[0])).toEqual(["bootstrap", "enable", "kickstart"]);
  });

  it("renders an idempotent systemd user service that survives login sessions", () => {
    const plan = makeServicePlan({
      platform: "linux",
      homeDirectory: "/home/test",
      command,
    });

    expect(plan.serviceName).toBe(HOSTD_SYSTEMD_UNIT);
    expect(plan.definitionPath).toBe("/home/test/.config/systemd/user/cocoa-hostd.service");
    expect(plan.definition).toContain('ExecStart="/Applications/Cocoa Host/cocoa-hostd" serve');
    expect(plan.definition).toContain("Restart=always");
    expect(plan.install).toContainEqual({
      executable: "loginctl",
      args: ["enable-linger"],
    });
  });

  it("uses a per-user scheduled task on Windows without a service wrapper dependency", () => {
    const plan = makeServicePlan({
      platform: "win32",
      homeDirectory: "C:\\Users\\test",
      command: ["C:\\Program Files\\Cocoa\\cocoa-hostd.exe", "serve"],
    });

    expect(plan.serviceName).toBe(HOSTD_WINDOWS_TASK);
    expect(plan.definitionPath).toBeUndefined();
    expect(plan.install[0]).toEqual({
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
        '"C:\\Program Files\\Cocoa\\cocoa-hostd.exe" serve',
        "/F",
      ],
    });
    expect(plan.status).toEqual({
      executable: "schtasks.exe",
      args: ["/Query", "/TN", HOSTD_WINDOWS_TASK],
    });
    expect(renderWindowsTaskCommand(["C:\\trailing path\\", 'say "hello"'])).toBe(
      '"C:\\trailing path\\\\" "say \\"hello\\""',
    );
  });

  it("installs and uninstalls definition-backed services idempotently", async () => {
    const files = new Map<string, string>();
    const commands: HostdServiceCommand[] = [];
    const io: HostdServiceIo = {
      exists: async (path) => files.has(path),
      makeDirectory: async () => undefined,
      writeFile: async (path, contents) => {
        files.set(path, contents);
      },
      removeFile: async (path) => {
        files.delete(path);
      },
      run: async (serviceCommand) => {
        commands.push(serviceCommand);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const options = {
      platform: "linux" as const,
      homeDirectory: "/home/test",
      command,
      io,
    };

    await installService(options);
    const unitPath = "/home/test/.config/systemd/user/cocoa-hostd.service";
    expect(files.has(unitPath)).toBe(true);
    expect(commands.some(({ args }) => args.includes("stop"))).toBe(true);

    commands.length = 0;
    await installService(options);
    expect(commands.some(({ args }) => args.includes("stop"))).toBe(true);
    expect(await uninstallService(options)).toBe(true);
    expect(commands.at(-1)).toEqual({
      executable: "systemctl",
      args: ["--user", "daemon-reload"],
    });
    expect(await uninstallService(options)).toBe(false);
  });

  it("reports Windows task absence and removes an installed task", async () => {
    let installed = false;
    const commands: HostdServiceCommand[] = [];
    const io: HostdServiceIo = {
      exists: async () => false,
      makeDirectory: async () => undefined,
      writeFile: async () => undefined,
      removeFile: async () => undefined,
      run: async (serviceCommand) => {
        commands.push(serviceCommand);
        if (serviceCommand.args[0] === "/Query") {
          return { exitCode: installed ? 0 : 1, stdout: "", stderr: "" };
        }
        if (serviceCommand.args[0] === "/Create") installed = true;
        if (serviceCommand.args[0] === "/Delete") installed = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const options = {
      platform: "win32" as const,
      homeDirectory: "C:\\Users\\test",
      command: ["C:\\Cocoa\\cocoa-hostd.exe", "serve"],
      io,
    };

    expect(await uninstallService(options)).toBe(false);
    await installService(options);
    expect(await uninstallService(options)).toBe(true);
    expect(commands.some(({ args }) => args[0] === "/Delete")).toBe(true);
  });
});
