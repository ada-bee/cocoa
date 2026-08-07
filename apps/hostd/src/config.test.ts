// @effect-diagnostics nodeBuiltinImport:off - These tests verify host-local config persistence in isolated temporary directories.
/* eslint-disable t3code/no-global-process-runtime -- standalone hostd config tests assert native file-mode behavior. */

import { afterEach, describe, expect, test } from "bun:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_BIND_HOST,
  defaultCodexSocketPath,
  defaultHostdConfigPath,
  loadHostdConfig,
  makeHostdConfig,
  rotateHostdKey,
  updateHostdConfig,
} from "./config.ts";

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0).toReversed()) {
    await NodeFSP.rm(path, { recursive: true, force: true });
  }
});

const temporaryConfig = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-hostd-config-"));
  cleanup.push(directory);
  return { directory, configPath: NodePath.join(directory, "config", "hostd.json") };
};

describe("hostd defaults", () => {
  test("resolves the Codex daemon control socket from CODEX_HOME", () => {
    expect(defaultCodexSocketPath({ CODEX_HOME: "/tmp/codex-test" })).toBe(
      NodePath.join("/tmp/codex-test", "app-server-control", "app-server-control.sock"),
    );
  });

  test("uses a loopback-only network default", () => {
    const config = makeHostdConfig();
    expect(config.bindHost).toBe(DEFAULT_BIND_HOST);
    expect(config.advertiseUrl).toBe("ws://127.0.0.1:4501/");
  });

  test("accepts explicit runtime values for isolated starts", () => {
    const config = makeHostdConfig({
      installationId: "test-installation",
      bindHost: "127.0.0.1",
      port: 0,
      advertiseUrl: "ws://test.invalid/",
      socketPath: "/tmp/codex.sock",
      key: "test-key",
    });
    expect(config).toEqual({
      version: 1,
      installationId: "test-installation",
      bindHost: "127.0.0.1",
      port: 0,
      advertiseUrl: "ws://test.invalid/",
      socketPath: "/tmp/codex.sock",
      key: "test-key",
    });
  });

  test("uses platform config locations and rejects relative overrides", () => {
    expect(defaultHostdConfigPath({ platform: "darwin", homeDirectory: "/Users/test" })).toBe(
      "/Users/test/Library/Application Support/Cocoa/hostd.json",
    );
    expect(
      defaultHostdConfigPath({
        platform: "linux",
        homeDirectory: "/home/test",
        environment: { XDG_CONFIG_HOME: "/srv/config" },
      }),
    ).toBe("/srv/config/cocoa/hostd.json");
    expect(() => defaultHostdConfigPath({ configPath: "relative.json" })).toThrow("absolute");
  });
});

describe("persisted host identity", () => {
  test("creates one random installation id and secret with private permissions", async () => {
    const { configPath } = await temporaryConfig();
    const first = await loadHostdConfig({ configPath });
    const second = await loadHostdConfig({ configPath });

    expect(second).toEqual(first);
    expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    if (NodeOS.platform() !== "win32") {
      expect((await NodeFSP.stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("different installations do not derive the same key from their URL", async () => {
    const firstPath = (await temporaryConfig()).configPath;
    const secondPath = (await temporaryConfig()).configPath;
    const first = await loadHostdConfig({ configPath: firstPath });
    const second = await loadHostdConfig({ configPath: secondPath });

    expect(first.advertiseUrl).toBe(second.advertiseUrl);
    expect(first.key).not.toBe(second.key);
    expect(first.installationId).not.toBe(second.installationId);
  });

  test("concurrent first loads converge on one persisted identity", async () => {
    const { configPath } = await temporaryConfig();
    const configs = await Promise.all(
      Array.from({ length: 8 }, () => loadHostdConfig({ configPath })),
    );

    expect(new Set(configs.map(({ installationId }) => installationId)).size).toBe(1);
    expect(new Set(configs.map(({ key }) => key)).size).toBe(1);
  });

  test("rotates only the secret and persists explicit network configuration", async () => {
    const { configPath } = await temporaryConfig();
    const initial = await loadHostdConfig({ configPath });
    const updated = await updateHostdConfig(
      {
        bindHost: "10.0.0.8",
        advertiseUrl: "wss://host.example/",
        socketPath: "/run/codex.sock",
      },
      { configPath },
    );
    const rotated = await rotateHostdKey({ configPath });

    expect(updated.installationId).toBe(initial.installationId);
    expect(rotated.installationId).toBe(initial.installationId);
    expect(rotated.key).not.toBe(initial.key);
    expect(rotated.bindHost).toBe("10.0.0.8");
    expect(rotated.advertiseUrl).toBe("wss://host.example/");
    expect(await loadHostdConfig({ configPath })).toEqual(rotated);
  });

  test("fails closed on malformed persisted configuration", async () => {
    const { configPath } = await temporaryConfig();
    await NodeFSP.mkdir(NodePath.dirname(configPath), { recursive: true });
    await NodeFSP.writeFile(configPath, '{"version":1,"key":"predictable"}\n');

    await expect(loadHostdConfig({ configPath })).rejects.toThrow("installationId");
  });
});
