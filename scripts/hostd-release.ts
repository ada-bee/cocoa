// @effect-diagnostics nodeBuiltinImport:off - release packaging operates on executable artifacts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const HOSTD_RELEASE_TARGETS = {
  "darwin-arm64": { bunTarget: "bun-darwin-arm64", extension: "" },
  "darwin-x64": { bunTarget: "bun-darwin-x64", extension: "" },
  "linux-arm64": { bunTarget: "bun-linux-arm64", extension: "" },
  "linux-x64": { bunTarget: "bun-linux-x64", extension: "" },
  "windows-x64": { bunTarget: "bun-windows-x64", extension: ".exe" },
} as const;

export type HostdReleaseTarget = keyof typeof HOSTD_RELEASE_TARGETS;

export interface HostdReleaseArtifact {
  readonly target: HostdReleaseTarget;
  readonly version: string;
  readonly binaryName: string;
  readonly binaryPath: string;
  readonly checksumPath: string;
  readonly manifestPath: string;
  readonly sha256: string;
}

export interface StageHostdCandidateOptions {
  readonly binaryPath: string;
  readonly checksumPath: string;
  readonly installRoot: string;
  readonly version: string;
  readonly target: HostdReleaseTarget;
  /** Candidate-local health command. A failed hook leaves no published candidate. */
  readonly doctorArgs?: ReadonlyArray<string>;
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;

const requireVersion = (version: string): string => {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid cocoa-hostd release version '${version}'.`);
  }
  return version;
};

export const requireHostdReleaseTarget = (target: string): HostdReleaseTarget => {
  if (!Object.hasOwn(HOSTD_RELEASE_TARGETS, target)) {
    throw new Error(`Unsupported cocoa-hostd release target '${target}'.`);
  }
  return target as HostdReleaseTarget;
};

export const hostdReleaseBinaryName = (version: string, target: HostdReleaseTarget): string => {
  const checkedVersion = requireVersion(version);
  return `cocoa-hostd-${checkedVersion}-${target}${HOSTD_RELEASE_TARGETS[target].extension}`;
};

export const sha256File = async (filePath: string): Promise<string> => {
  const bytes = await NodeFSP.readFile(filePath);
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
};

export const renderSha256File = (sha256: string, binaryName: string): string =>
  `${sha256}  ${binaryName}\n`;

export const parseSha256File = (contents: string, expectedBinaryName: string): string => {
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\r?\n?$/u.exec(contents);
  if (match === null || match[2] !== expectedBinaryName) {
    throw new Error(`Invalid checksum record for '${expectedBinaryName}'.`);
  }
  return match[1] as string;
};

export async function verifyHostdReleaseArtifact(
  binaryPath: string,
  checksumPath: string,
): Promise<string> {
  const binaryName = NodePath.basename(binaryPath);
  const expected = parseSha256File(await NodeFSP.readFile(checksumPath, "utf8"), binaryName);
  const actual = await sha256File(binaryPath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for '${binaryName}'.`);
  }
  return actual;
}

export async function buildHostdReleaseArtifact(input: {
  readonly repositoryRoot: string;
  readonly outputDirectory: string;
  readonly version: string;
  readonly target: HostdReleaseTarget;
  readonly sourceRevision?: string;
}): Promise<HostdReleaseArtifact> {
  const version = requireVersion(input.version);
  const manifestPath = NodePath.join(input.repositoryRoot, "apps", "hostd", "package.json");
  const packageManifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as {
    readonly version?: unknown;
  };
  if (packageManifest.version !== version) {
    throw new Error(
      `cocoa-hostd package version '${String(packageManifest.version)}' does not match release '${version}'.`,
    );
  }

  const target = HOSTD_RELEASE_TARGETS[input.target];
  const binaryName = hostdReleaseBinaryName(version, input.target);
  const outputDirectory = NodePath.resolve(input.outputDirectory);
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  const binaryPath = NodePath.join(outputDirectory, binaryName);
  const checksumPath = `${binaryPath}.sha256`;
  const artifactManifestPath = `${binaryPath}.json`;
  const entrypoint = NodePath.join(input.repositoryRoot, "apps", "hostd", "src", "bin.ts");

  await execFile(
    "bun",
    [
      "build",
      "--compile",
      "--minify",
      `--target=${target.bunTarget}`,
      `--outfile=${binaryPath}`,
      entrypoint,
    ],
    { cwd: input.repositoryRoot },
  );
  if (target.extension === "") await NodeFSP.chmod(binaryPath, 0o755);

  const sha256 = await sha256File(binaryPath);
  await NodeFSP.writeFile(checksumPath, renderSha256File(sha256, binaryName), "utf8");
  await NodeFSP.writeFile(
    artifactManifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: "cocoa-hostd",
        version,
        target: input.target,
        bunTarget: target.bunTarget,
        binary: binaryName,
        sha256,
        ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    target: input.target,
    version,
    binaryName,
    binaryPath,
    checksumPath,
    manifestPath: artifactManifestPath,
    sha256,
  };
}

/**
 * Verify and stage an immutable candidate. Publication is a same-directory
 * rename, so an updater never observes a partial binary. Activation is left to
 * the service manager after its own generation and drain checks.
 */
export async function stageHostdCandidate(options: StageHostdCandidateOptions): Promise<string> {
  const version = requireVersion(options.version);
  const expectedName = hostdReleaseBinaryName(version, options.target);
  if (NodePath.basename(options.binaryPath) !== expectedName) {
    throw new Error(`Expected candidate binary '${expectedName}'.`);
  }
  await verifyHostdReleaseArtifact(options.binaryPath, options.checksumPath);

  const candidatesRoot = NodePath.resolve(options.installRoot, "candidates");
  const finalDirectory = NodePath.join(candidatesRoot, version, options.target);
  const stagingDirectory = NodePath.join(
    candidatesRoot,
    `.staging-${version}-${options.target}-${NodeProcess.pid}-${NodeCrypto.randomUUID()}`,
  );
  await NodeFSP.mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  const stagedBinary = NodePath.join(stagingDirectory, expectedName);
  const stagedChecksumPath = `${stagedBinary}.sha256`;

  try {
    await NodeFSP.copyFile(options.binaryPath, stagedBinary);
    await NodeFSP.copyFile(options.checksumPath, stagedChecksumPath);
    if (HOSTD_RELEASE_TARGETS[options.target].extension === "") {
      await NodeFSP.chmod(stagedBinary, 0o755);
    }
    const stagedChecksum = await sha256File(stagedBinary);
    const sourceChecksum = await verifyHostdReleaseArtifact(
      options.binaryPath,
      options.checksumPath,
    );
    if (stagedChecksum !== sourceChecksum) {
      throw new Error(`Staged checksum mismatch for '${expectedName}'.`);
    }
    if (options.doctorArgs !== undefined) {
      await execFile(stagedBinary, [...options.doctorArgs], { cwd: stagingDirectory });
    }

    await NodeFSP.mkdir(NodePath.dirname(finalDirectory), { recursive: true, mode: 0o700 });
    try {
      await NodeFSP.rename(stagingDirectory, finalDirectory);
    } catch (publishCause) {
      const existingBinary = NodePath.join(finalDirectory, expectedName);
      const existingChecksum = `${existingBinary}.sha256`;
      let existingHash: string;
      try {
        existingHash = await verifyHostdReleaseArtifact(existingBinary, existingChecksum);
      } catch {
        throw publishCause;
      }
      if (existingHash !== sourceChecksum) {
        throw new Error(
          `Refusing to overwrite immutable candidate '${NodePath.join(version, options.target)}'.`,
          { cause: publishCause },
        );
      }
      await NodeFSP.rm(stagingDirectory, { recursive: true, force: true });
    }
    return NodePath.join(finalDirectory, expectedName);
  } catch (cause) {
    await NodeFSP.rm(stagingDirectory, { recursive: true, force: true });
    throw cause;
  }
}

interface ParsedCli {
  readonly command: "build" | "verify" | "stage";
  readonly values: ReadonlyMap<string, string>;
  readonly doctorArgs: ReadonlyArray<string>;
}

const parseCli = (argv: ReadonlyArray<string>): ParsedCli => {
  const [command, ...args] = argv;
  if (command !== "build" && command !== "verify" && command !== "stage") {
    throw new Error("Usage: bun scripts/hostd-release.ts <build|verify|stage> [options]");
  }
  const values = new Map<string, string>();
  const doctorArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key === "--doctor-arg") {
      if (value === undefined) throw new Error("--doctor-arg requires a value.");
      doctorArgs.push(value);
      index += 1;
      continue;
    }
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error(`Invalid hostd release option '${String(key)}'.`);
    }
    values.set(key.slice(2), value);
    index += 1;
  }
  return { command, values, doctorArgs };
};

const requiredOption = (values: ReadonlyMap<string, string>, name: string): string => {
  const value = values.get(name);
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required.`);
  return value;
};

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const parsed = parseCli(argv);
  if (parsed.command === "build") {
    const sourceRevision = parsed.values.get("source-revision");
    const artifact = await buildHostdReleaseArtifact({
      repositoryRoot: NodePath.resolve(parsed.values.get("root") ?? "."),
      outputDirectory: requiredOption(parsed.values, "output"),
      version: requiredOption(parsed.values, "version"),
      target: requireHostdReleaseTarget(requiredOption(parsed.values, "target")),
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
    });
    NodeProcess.stdout.write(`${JSON.stringify(artifact)}\n`);
    return;
  }
  if (parsed.command === "verify") {
    const sha256 = await verifyHostdReleaseArtifact(
      requiredOption(parsed.values, "binary"),
      requiredOption(parsed.values, "checksum"),
    );
    NodeProcess.stdout.write(`${sha256}\n`);
    return;
  }
  const staged = await stageHostdCandidate({
    binaryPath: requiredOption(parsed.values, "binary"),
    checksumPath: requiredOption(parsed.values, "checksum"),
    installRoot: requiredOption(parsed.values, "install-root"),
    version: requiredOption(parsed.values, "version"),
    target: requireHostdReleaseTarget(requiredOption(parsed.values, "target")),
    ...(parsed.doctorArgs.length === 0 ? {} : { doctorArgs: parsed.doctorArgs }),
  });
  NodeProcess.stdout.write(`${staged}\n`);
}

if (import.meta.main) {
  await main(NodeProcess.argv.slice(2)).catch((cause: unknown) => {
    NodeProcess.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    NodeProcess.exit(1);
  });
}
