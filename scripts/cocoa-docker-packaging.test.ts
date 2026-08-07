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

  it("preserves the hardened gateway runtime contract", () => {
    const dockerfile = readRootFile("Dockerfile");
    const compose = readRootFile("compose.yaml");

    for (const required of [
      "ARG COCOA_BUILD_IDENTITY",
      "LABEL xyz.brbc.cocoa.build-identity=${COCOA_BUILD_IDENTITY}",
      "USER 10001:10001",
      "T3CODE_RUNTIME_PROFILE=cocoa-gateway",
      "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false",
      "RUN install -d -m 0755 -o cocoa -g cocoa /opt/cocoa/defaults",
      'VOLUME [\"/data\"]',
      "http://127.0.0.1:7331/readyz",
      '[\"/usr/bin/tini\", \"--\", \"/usr/local/bin/cocoa-entrypoint\"]',
    ]) {
      expect(dockerfile).toContain(required);
    }

    const entrypoint = readRootFile("docker/entrypoint.sh");
    expect(entrypoint).toContain("data_dir=${T3CODE_HOME:-/data}");
    expect(entrypoint).toContain('if [ ! -e "${settings_file}" ]');
    expect(entrypoint).toContain('cp /opt/cocoa/defaults/settings.json "${settings_file}"');
    expect(entrypoint).toContain('exec bun /opt/cocoa/dist/cocoa-bin.mjs "$@"');

    expect(compose).toContain("image: ghcr.io/ada-bee/cocoa:${COCOA_VERSION:-latest}");
    expect(compose).toContain("pull_policy: always");
    expect(compose).not.toContain("platform:");
    expect(compose).not.toContain("build:");
    expect(compose).not.toContain("/var/run/docker.sock");

    expect(readRootFile("docker/settings.json")).toBe("{}\n");
  });

  it("publishes each release as a multi-architecture GHCR image", () => {
    const workflow = readRootFile(".github/workflows/publish-container.yml");

    expect(workflow).toContain("types: [published]");
    expect(workflow).toContain("IMAGE_NAME: ghcr.io/${{ github.repository }}");
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
    expect(workflow).toContain("push: true");
    expect(workflow).toContain("value=${{ github.event.release.tag_name }}");
    expect(workflow).toContain("COCOA_BUILD_IDENTITY=git:${{ steps.source.outputs.sha }}");
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
      "**/secrets",
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
