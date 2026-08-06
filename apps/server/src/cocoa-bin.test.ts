// @effect-diagnostics nodeBuiltinImport:off - This is an executable-boundary regression test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

const packageRoot = NodePath.resolve(import.meta.dirname, "..");
const workspaceRoot = NodePath.resolve(packageRoot, "../..");
const vitePlusBin = NodePath.join(workspaceRoot, "node_modules/vite-plus/bin/vp");
const cocoaBinSource = NodeFS.readFileSync(NodePath.join(packageRoot, "src/cocoa-bin.ts"), "utf8");
const cloudEnvironment = {
  T3CODE_RELAY_URL: "https://relay.example.test",
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_cocoa",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_cocoa",
} as const;

const run = (command: string, args: ReadonlyArray<string>, cwd = packageRoot) =>
  NodeChildProcess.spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...cloudEnvironment },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const expectCocoaHelp = (result: NodeChildProcess.SpawnSyncReturns<string>) => {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toContain("node:sqlite");
  expect(result.stdout).toContain("Run the self-hosted Cocoa gateway.");
  expect(result.stdout).toMatch(/^\s+start\s+Run the Cocoa gateway\./mu);
  expect(result.stdout).toMatch(/^\s+serve\s+Run the Cocoa gateway/mu);
  expect(result.stdout).not.toMatch(
    /^\s+(?:connect|service|__service-preflight|pair|project|auth)\b/mu,
  );
  expect(result.stdout).not.toContain("--runtime-profile");
  expect(result.stdout).not.toContain("--tailscale-serve");
  expect(result.stdout).not.toContain("--auto-bootstrap-project-from-cwd");
  expect(result.stdout).not.toContain("Working directory for provider sessions");
};

describe("Cocoa Bun entrypoint", () => {
  it("keeps legacy hosted and service commands out of its static command graph", () => {
    expect(cocoaBinSource).toContain('runtimeProfile: Option.some("cocoa-gateway")');
    expect(cocoaBinSource).toContain(
      "Command.withSubcommands([cocoaStartCommand, cocoaServeCommand])",
    );
    expect(cocoaBinSource).not.toMatch(
      /(?:connectCommand|serviceCommand|servicePreflightCommand|hasCloudPublicConfig|node:sqlite)/,
    );
    expect(cocoaBinSource).not.toMatch(
      /(?:\.\/bin\.ts|\.\/cli\/(?:connect|service|servicePreflight)\.ts)/,
    );
  });

  it("starts the source CLI without loading Node-only or hosted commands", () => {
    expectCocoaHelp(run("bun", ["src/cocoa-bin.ts", "--help"]));
  });

  it("starts the production bundle without loading Node-only or hosted commands", () => {
    const outputDirectory = NodeFS.mkdtempSync(
      NodePath.join(packageRoot, ".cocoa-bin-bundle-test-"),
    );
    try {
      const build = run(process.execPath, [
        vitePlusBin,
        "pack",
        "src/cocoa-bin.ts",
        "--out-dir",
        outputDirectory,
        "--logLevel",
        "error",
      ]);
      expect(build.error).toBeUndefined();
      expect(build.status, build.stderr).toBe(0);
      expectCocoaHelp(run("bun", [NodePath.join(outputDirectory, "cocoa-bin.mjs"), "--help"]));
    } finally {
      NodeFS.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
