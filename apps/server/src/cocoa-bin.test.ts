// @effect-diagnostics nodeBuiltinImport:off - This is an executable-boundary regression test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

const packageRoot = NodePath.resolve(import.meta.dirname, "..");
const workspaceRoot = NodePath.resolve(packageRoot, "../..");
const vitePlusBin = NodePath.join(workspaceRoot, "node_modules/vite-plus/bin/vp");
const cocoaBinSource = NodeFS.readFileSync(NodePath.join(packageRoot, "src/cocoa-bin.ts"), "utf8");
const cocoaServerSource = NodeFS.readFileSync(
  NodePath.join(packageRoot, "src/cocoa/CocoaGatewayServer.ts"),
  "utf8",
);
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
  expect(result.stdout).not.toContain("--bootstrap-fd");
  expect(result.stdout).not.toContain("Working directory for provider sessions");
};

describe("Cocoa Bun entrypoint", () => {
  it("keeps legacy hosted and service commands out of its static command graph", () => {
    expect(cocoaBinSource).toContain("resolveCocoaGatewayConfig");
    expect(cocoaBinSource).toContain('./cocoa/CocoaGatewayCliConfig.ts"');
    expect(cocoaBinSource).toContain(
      "Command.withSubcommands([cocoaStartCommand, cocoaServeCommand])",
    );
    expect(cocoaBinSource).not.toMatch(
      /(?:connectCommand|serviceCommand|servicePreflightCommand|hasCloudPublicConfig|node:sqlite)/,
    );
    expect(cocoaBinSource).not.toMatch(
      /(?:\.\/bin\.ts|\.\/server\.ts|\.\/cli\/(?:connect|server|service|servicePreflight)\.ts)/,
    );
    expect(cocoaBinSource).toContain('./cocoa/CocoaGatewayServer.ts"');
  });

  it("uses a dedicated Cocoa-only server composition", () => {
    expect(cocoaServerSource).toContain('config.runtimeProfile !== "cocoa-gateway"');
    expect(cocoaServerSource).toContain("websocketRpcRouteLayer");
    expect(cocoaServerSource).toContain("cocoaClientV1WebSocketRouteLayer");
    expect(cocoaServerSource).toContain("gatewayHealthRouteLayer");
    expect(cocoaServerSource).toContain("cocoaGatewayEnvironmentHttpApiLayer");
    expect(cocoaServerSource).toContain("CocoaRuntimeDependenciesLive");
    expect(cocoaServerSource).toContain("persistServerRuntimeState");
    expect(cocoaServerSource).not.toMatch(
      /(?:from "\.\.\/server\.ts"|LegacyRuntime|connectHttpApiLayer|tailscale|relayTracing|CloudManagedEndpointRuntime)/,
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
      const bundlePath = NodePath.join(outputDirectory, "cocoa-bin.mjs");
      const bundle = NodeFS.readFileSync(bundlePath, "utf8");
      for (const forbiddenRuntimeDependency of [
        "@anthropic-ai/claude-agent-sdk",
        "@opencode-ai/sdk",
        "node-pty",
        "@t3tools/tailscale",
        "effect-codex-app-server/child-process-client",
      ]) {
        expect(bundle, forbiddenRuntimeDependency).not.toContain(forbiddenRuntimeDependency);
      }
      expectCocoaHelp(run("bun", [bundlePath, "--help"]));
    } finally {
      NodeFS.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
