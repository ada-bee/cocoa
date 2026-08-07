// @effect-diagnostics nodeBuiltinImport:off - CLI tests use isolated host configuration and Unix socket fixtures.

import { afterEach, describe, expect, test } from "bun:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { diagnoseHostd, parseHostdCli, runHostdCli } from "./cli.ts";
import { loadHostdConfig, updateHostdConfig } from "./config.ts";
import { decodePairingToken } from "./pairing.ts";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).toReversed()) await action();
});

const fixture = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-hostd-cli-"));
  cleanup.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  return { directory, configPath: NodePath.join(directory, "hostd.json") };
};

const captureIo = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
};

describe("hostd CLI", () => {
  test("parses explicit config and network updates", () => {
    expect(
      parseHostdCli([
        "config",
        "--config",
        "/tmp/hostd.json",
        "--bind-host",
        "10.0.0.4",
        "--port",
        "8443",
      ]),
    ).toMatchObject({
      command: "config",
      store: { configPath: "/tmp/hostd.json" },
      configOverrides: { bindHost: "10.0.0.4", port: 8443 },
    });
  });

  test("pairing remains stable until an explicit rotation", async () => {
    const { configPath } = await fixture();
    const firstOutput = captureIo();
    const secondOutput = captureIo();
    const rotationOutput = captureIo();

    expect(await runHostdCli(["pair", "--config", configPath], firstOutput.io)).toBe(0);
    expect(await runHostdCli(["pair", "--config", configPath], secondOutput.io)).toBe(0);
    expect(firstOutput.stdout.at(-1)).toBe(secondOutput.stdout.at(-1));
    expect(await runHostdCli(["rotate-key", "--config", configPath], rotationOutput.io)).toBe(0);
    expect(rotationOutput.stdout.at(-1)).not.toBe(firstOutput.stdout.at(-1));

    const before = decodePairingToken(firstOutput.stdout.at(-1)!);
    const after = decodePairingToken(rotationOutput.stdout.at(-1)!);
    expect(after.url).toBe(before.url);
    expect(after.key).not.toBe(before.key);
  });

  test("status and config output never expose the persisted key", async () => {
    const { configPath } = await fixture();
    const config = await loadHostdConfig({ configPath });
    for (const command of ["config", "status"] as const) {
      const output = captureIo();
      expect(await runHostdCli([command, "--config", configPath], output.io)).toBe(0);
      expect(output.stdout.join("\n")).not.toContain(config.key);
      expect(output.stdout.join("\n")).toContain(config.installationId);
    }
  });

  test("config updates the default advertised port together", async () => {
    const { configPath } = await fixture();
    const output = captureIo();
    expect(await runHostdCli(["config", "--config", configPath, "--port", "4600"], output.io)).toBe(
      0,
    );
    const config = await loadHostdConfig({ configPath });
    expect(config.port).toBe(4600);
    expect(config.advertiseUrl).toBe("ws://127.0.0.1:4600/");
  });

  test("doctor flags a missing socket and unsafe plaintext exposure", async () => {
    const { configPath } = await fixture();
    const initial = await loadHostdConfig({ configPath });
    const config = await updateHostdConfig(
      {
        bindHost: "0.0.0.0",
        advertiseUrl: "ws://host.example:4501/",
        socketPath: NodePath.join(NodePath.dirname(configPath), "missing.sock"),
      },
      { configPath },
    );
    const findings = await diagnoseHostd(config, { configPath });

    expect(initial.key).toBe(config.key);
    expect(findings).toContainEqual({
      level: "error",
      check: "codex-socket",
      message: "Codex control socket is missing.",
    });
    expect(
      findings.some(({ check, level }) => check === "transport-security" && level === "warning"),
    ).toBe(true);
  });

  test("rejects network overrides on serve instead of creating ephemeral credentials", async () => {
    const { configPath } = await fixture();
    const output = captureIo();
    expect(await runHostdCli(["serve", "--config", configPath, "--port", "4502"], output.io)).toBe(
      1,
    );
    expect(output.stderr.join("\n")).toContain("config command");
  });
});
