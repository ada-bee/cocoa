// @effect-diagnostics nodeBuiltinImport:off - packaging tests exercise real filesystem artifacts.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  HOSTD_RELEASE_TARGETS,
  hostdReleaseBinaryName,
  parseSha256File,
  renderSha256File,
  requireHostdReleaseTarget,
  sha256File,
  stageHostdCandidate,
  verifyHostdReleaseArtifact,
} from "./hostd-release.ts";

const withTempDirectory = async <A>(run: (directory: string) => Promise<A>): Promise<A> => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hostd-release-test-"));
  try {
    return await run(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
};

describe("cocoa-hostd release packaging", () => {
  it("defines stable multi-platform Bun targets and asset names", () => {
    expect(HOSTD_RELEASE_TARGETS).toEqual({
      "darwin-arm64": { bunTarget: "bun-darwin-arm64", extension: "" },
      "darwin-x64": { bunTarget: "bun-darwin-x64", extension: "" },
      "linux-arm64": { bunTarget: "bun-linux-arm64", extension: "" },
      "linux-x64": { bunTarget: "bun-linux-x64", extension: "" },
      "windows-x64": { bunTarget: "bun-windows-x64", extension: ".exe" },
    });
    expect(hostdReleaseBinaryName("1.2.3", "linux-arm64")).toBe("cocoa-hostd-1.2.3-linux-arm64");
    expect(hostdReleaseBinaryName("1.2.3-beta.1", "windows-x64")).toBe(
      "cocoa-hostd-1.2.3-beta.1-windows-x64.exe",
    );
    expect(() => requireHostdReleaseTarget("plan9-x64")).toThrow(
      "Unsupported cocoa-hostd release target 'plan9-x64'.",
    );
  });

  it("renders, parses, and verifies portable SHA-256 records", async () =>
    withTempDirectory(async (directory) => {
      const binaryName = "cocoa-hostd-1.2.3-linux-x64";
      const binaryPath = NodePath.join(directory, binaryName);
      const checksumPath = `${binaryPath}.sha256`;
      await NodeFSP.writeFile(binaryPath, "hostd-binary");
      const sha256 = await sha256File(binaryPath);
      const record = renderSha256File(sha256, binaryName);
      await NodeFSP.writeFile(checksumPath, record);

      expect(parseSha256File(record, binaryName)).toBe(sha256);
      await expect(verifyHostdReleaseArtifact(binaryPath, checksumPath)).resolves.toBe(sha256);

      await NodeFSP.appendFile(binaryPath, "tampered");
      await expect(verifyHostdReleaseArtifact(binaryPath, checksumPath)).rejects.toThrow(
        `Checksum mismatch for '${binaryName}'.`,
      );
    }));

  it("stages a verified candidate atomically after a successful doctor hook", async () =>
    withTempDirectory(async (directory) => {
      const version = "1.2.3";
      const target = "linux-x64";
      const binaryName = hostdReleaseBinaryName(version, target);
      const sourceDirectory = NodePath.join(directory, "download");
      const installRoot = NodePath.join(directory, "install");
      await NodeFSP.mkdir(sourceDirectory);
      const binaryPath = NodePath.join(sourceDirectory, binaryName);
      const checksumPath = `${binaryPath}.sha256`;
      await NodeFSP.writeFile(binaryPath, '#!/bin/sh\ntest "$1" = doctor\n', { mode: 0o755 });
      const checksum = await sha256File(binaryPath);
      await NodeFSP.writeFile(checksumPath, renderSha256File(checksum, binaryName));

      const staged = await stageHostdCandidate({
        binaryPath,
        checksumPath,
        installRoot,
        version,
        target,
        doctorArgs: ["doctor"],
      });

      expect(staged).toBe(NodePath.join(installRoot, "candidates", version, target, binaryName));
      expect(await sha256File(staged)).toBe(checksum);
      await expect(verifyHostdReleaseArtifact(staged, `${staged}.sha256`)).resolves.toBe(checksum);
      expect((await NodeFSP.stat(staged)).mode & 0o111).not.toBe(0);
      expect(
        (await NodeFSP.readdir(NodePath.join(installRoot, "candidates"))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
      ).toEqual([]);
    }));

  it("treats staging the same artifact hash as an idempotent success", async () =>
    withTempDirectory(async (directory) => {
      const version = "1.2.3";
      const target = "linux-x64";
      const binaryName = hostdReleaseBinaryName(version, target);
      const binaryPath = NodePath.join(directory, binaryName);
      const checksumPath = `${binaryPath}.sha256`;
      const installRoot = NodePath.join(directory, "install");
      await NodeFSP.writeFile(binaryPath, "same-hostd-binary");
      const checksum = await sha256File(binaryPath);
      await NodeFSP.writeFile(checksumPath, renderSha256File(checksum, binaryName));

      const options = { binaryPath, checksumPath, installRoot, version, target } as const;
      const first = await stageHostdCandidate(options);
      const second = await stageHostdCandidate(options);

      expect(second).toBe(first);
      expect(await sha256File(second)).toBe(checksum);
      expect(
        (await NodeFSP.readdir(NodePath.join(installRoot, "candidates"))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
      ).toEqual([]);
    }));

  it("refuses to overwrite a published candidate with a different valid hash", async () =>
    withTempDirectory(async (directory) => {
      const version = "1.2.3";
      const target = "linux-x64";
      const binaryName = hostdReleaseBinaryName(version, target);
      const binaryPath = NodePath.join(directory, binaryName);
      const checksumPath = `${binaryPath}.sha256`;
      const installRoot = NodePath.join(directory, "install");
      await NodeFSP.writeFile(binaryPath, "original-hostd-binary");
      const originalChecksum = await sha256File(binaryPath);
      await NodeFSP.writeFile(checksumPath, renderSha256File(originalChecksum, binaryName));

      const options = { binaryPath, checksumPath, installRoot, version, target } as const;
      const staged = await stageHostdCandidate(options);
      await NodeFSP.writeFile(binaryPath, "conflicting-hostd-binary");
      await NodeFSP.writeFile(
        checksumPath,
        renderSha256File(await sha256File(binaryPath), binaryName),
      );

      await expect(stageHostdCandidate(options)).rejects.toThrow(
        "Refusing to overwrite immutable candidate '1.2.3/linux-x64'.",
      );
      expect(await sha256File(staged)).toBe(originalChecksum);
      await expect(verifyHostdReleaseArtifact(staged, `${staged}.sha256`)).resolves.toBe(
        originalChecksum,
      );
      expect(
        (await NodeFSP.readdir(NodePath.join(installRoot, "candidates"))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
      ).toEqual([]);
    }));

  it("publishes every supported target with checksums and immutable release assets", async () => {
    const workflow = await NodeFSP.readFile(
      new URL("../.github/workflows/publish-hostd.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("types: [published]");
    for (const target of Object.keys(HOSTD_RELEASE_TARGETS)) {
      expect(workflow).toContain(`- ${target}`);
    }
    expect(workflow).toContain("bun scripts/hostd-release.ts build");
    expect(workflow).toContain("bun scripts/hostd-release.ts verify");
    expect(workflow).toContain("cat ./*.sha256 | sort -k2 > SHA256SUMS");
    expect(workflow).toContain('gh release upload "$release_tag"');
    expect(workflow).toContain("cmp -s");
    expect(workflow).toContain("already exists with different content");
    expect(workflow).toContain("No new release assets to upload.");
    expect(workflow).not.toContain("--clobber");
  });

  it("does not publish a candidate when its doctor hook fails", async () =>
    withTempDirectory(async (directory) => {
      const version = "1.2.3";
      const target = "linux-x64";
      const binaryName = hostdReleaseBinaryName(version, target);
      const binaryPath = NodePath.join(directory, binaryName);
      const checksumPath = `${binaryPath}.sha256`;
      const installRoot = NodePath.join(directory, "install");
      await NodeFSP.writeFile(binaryPath, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
      await NodeFSP.writeFile(
        checksumPath,
        renderSha256File(await sha256File(binaryPath), binaryName),
      );

      await expect(
        stageHostdCandidate({
          binaryPath,
          checksumPath,
          installRoot,
          version,
          target,
          doctorArgs: ["doctor"],
        }),
      ).rejects.toThrow();
      await expect(
        NodeFSP.access(NodePath.join(installRoot, "candidates", version, target, binaryName)),
      ).rejects.toThrow();
      expect(
        (await NodeFSP.readdir(NodePath.join(installRoot, "candidates"))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
      ).toEqual([]);
    }));
});
