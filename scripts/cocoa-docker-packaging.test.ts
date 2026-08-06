// @effect-diagnostics nodeBuiltinImport:off - packaging policy reads repository artifacts.
import { describe, expect, it } from "@effect/vitest";
import { existsSync, readFileSync } from "node:fs";

const rootFile = (path: string) => new URL(`../${path}`, import.meta.url);
const readRootFile = (path: string) => readFileSync(rootFile(path), "utf8");

describe("Cocoa Docker packaging policy", () => {
  it("uses a conventional build stage and a Bun-only runtime stage", () => {
    const dockerfile = readRootFile("Dockerfile");

    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim AS build");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends ca-certificates");
    expect(dockerfile).toContain("corepack prepare pnpm@11.10.0 --activate");
    expect(dockerfile).toContain("--ignore-scripts");
    expect(dockerfile).toContain("--filter '@cocoa/gateway-runtime...'");
    expect(dockerfile).toContain("pnpm --filter t3 build:cocoa-bundle");
    expect(dockerfile).toContain("pnpm --filter @t3tools/web build");
    expect(dockerfile).toContain("--filter @cocoa/gateway-runtime");
    expect(dockerfile).toContain("FROM oven/bun:${BUN_VERSION}-debian AS runtime");
    expect(dockerfile).toContain("COPY --from=build --chown=10001:10001 /opt/cocoa /opt/cocoa");
    expect(dockerfile).not.toContain("rebuild node-pty");
    expect(dockerfile).not.toMatch(/FROM[^\n]+\b(nix|nixos)\b/i);
  });

  it("preserves the hardened ARM64 gateway runtime contract", () => {
    const dockerfile = readRootFile("Dockerfile");
    const compose = readRootFile("deploy/raspberry-pi/compose.yaml");

    for (const required of [
      "ARG COCOA_BUILD_IDENTITY",
      "LABEL xyz.brbc.cocoa.build-identity=${COCOA_BUILD_IDENTITY}",
      "USER 10001:10001",
      "T3CODE_RUNTIME_PROFILE=cocoa-gateway",
      "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false",
      'VOLUME [\"/data\"]',
      "http://127.0.0.1:7331/readyz",
      '[\"/usr/bin/tini\", \"--\", \"bun\", \"/opt/cocoa/dist/cocoa-bin.mjs\"]',
    ]) {
      expect(dockerfile).toContain(required);
    }

    expect(compose).toContain("platform: linux/arm64");
    expect(compose).toContain("pull_policy: never");
    expect(compose).toContain("COCOA_GATEWAY_IMAGE_REFERENCE");
    expect(compose).not.toContain("cocoa-gateway:latest");
    expect(compose).not.toContain("/var/run/docker.sock");

    const verifier = readRootFile("deploy/raspberry-pi/verify-image.sh");
    expect(verifier).toContain("forbidden provider-host or build executable");
    expect(verifier).toContain("node-compatibility-target /usr/local/bin/bun");
    expect(verifier).toContain("runtime credential material found in gateway image");
  });

  it("keeps credentials, local state, and build products out of the context", () => {
    const dockerignore = readRootFile(".dockerignore");

    for (const excluded of [
      ".git",
      ".repos",
      "**/node_modules",
      ".env.*",
      "userdata",
      "worktrees",
      "caches",
      "deploy/raspberry-pi/secrets",
    ]) {
      expect(dockerignore).toContain(excluded);
    }
  });

  it("retains Nix only for provider-host helper packaging", () => {
    const flake = readRootFile("flake.nix");

    expect(flake).toContain("cocoa-provider-host-helper");
    expect(flake).toContain("native/cocoa-workspace-helper/package.nix");
    expect(flake).not.toContain("cocoa-gateway-image");
    expect(flake).not.toContain("cocoaGateway");
    expect(existsSync(rootFile("nix/cocoa-gateway.nix"))).toBe(false);
    expect(existsSync(rootFile("nix/cocoa-gateway-image.nix"))).toBe(false);
  });
});
