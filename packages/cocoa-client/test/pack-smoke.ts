// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const packageRoot = NodePath.resolve(import.meta.dirname, "..");
const workspaceRoot = NodePath.resolve(packageRoot, "../..");
const tempRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-client-pack-"));

async function run(command: ReadonlyArray<string>, cwd: string): Promise<string> {
  const process = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode}).\n${stdout}\n${stderr}`);
  }
  return stdout.trim();
}

try {
  await run(["bun", "run", "build"], packageRoot);
  const stagingRoot = NodePath.join(tempRoot, "staging");
  await NodeFSP.mkdir(stagingRoot, { recursive: true });
  await NodeFSP.cp(NodePath.join(packageRoot, "dist"), NodePath.join(stagingRoot, "dist"), {
    recursive: true,
  });
  await NodeFSP.cp(
    NodePath.resolve(workspaceRoot, "LICENSE"),
    NodePath.join(stagingRoot, "LICENSE"),
  );
  const sourceManifest = JSON.parse(
    await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
  ) as { readonly version: string; readonly devDependencies: Record<string, string> };
  const normalizedDevDependencies = Object.fromEntries(
    await Promise.all(
      Object.keys(sourceManifest.devDependencies).map(async (name) => {
        const installedManifest = JSON.parse(
          await NodeFSP.readFile(
            NodePath.join(packageRoot, "node_modules", name, "package.json"),
            "utf8",
          ),
        ) as { readonly version: string };
        return [name, installedManifest.version] as const;
      }),
    ),
  );
  await NodeFSP.writeFile(
    NodePath.join(stagingRoot, "package.json"),
    `${JSON.stringify(
      {
        ...sourceManifest,
        devDependencies: normalizedDevDependencies,
      },
      undefined,
      2,
    )}\n`,
  );
  const packedPathOutput = await run(
    ["bun", "pm", "pack", "--destination", tempRoot, "--ignore-scripts", "--quiet"],
    stagingRoot,
  );
  const reportedTarballPath = packedPathOutput.split("\n").at(-1);
  if (reportedTarballPath === undefined || reportedTarballPath.length === 0) {
    throw new Error("bun pm pack did not report its tarball path.");
  }
  const tarballPath = NodePath.isAbsolute(reportedTarballPath)
    ? reportedTarballPath
    : NodePath.resolve(stagingRoot, reportedTarballPath);

  const extractRoot = NodePath.join(tempRoot, "extract");
  await NodeFSP.mkdir(extractRoot, { recursive: true });
  await run(["tar", "-xzf", tarballPath, "-C", extractRoot], tempRoot);
  const packedPackageRoot = NodePath.join(extractRoot, "package");
  const packedManifest = JSON.parse(
    await NodeFSP.readFile(NodePath.join(packedPackageRoot, "package.json"), "utf8"),
  ) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
  };
  if (packedManifest.name !== "@brbc/cocoa-client" || packedManifest.version !== "0.0.31") {
    throw new Error("Packed manifest has the wrong public identity or version.");
  }
  if (
    JSON.stringify(packedManifest.dependencies) !== JSON.stringify({ effect: "4.0.0-beta.102" })
  ) {
    throw new Error("Packed client has an unexpected runtime dependency set.");
  }
  for (const specifier of Object.values({
    ...packedManifest.dependencies,
    ...packedManifest.devDependencies,
  })) {
    if (specifier.startsWith("workspace:") || specifier.startsWith("catalog:")) {
      throw new Error("Packed manifest contains an unresolved workspace or catalog specifier.");
    }
  }
  const packedFiles = await NodeFSP.readdir(NodePath.join(packedPackageRoot, "dist"));
  if (!packedFiles.includes("index.js") || !packedFiles.includes("index.d.ts")) {
    throw new Error("Packed client is missing its ESM runtime or declarations.");
  }
  const emitted = `${await NodeFSP.readFile(NodePath.join(packedPackageRoot, "dist/index.js"), "utf8")}\n${await NodeFSP.readFile(NodePath.join(packedPackageRoot, "dist/index.d.ts"), "utf8")}`;
  const importsPrivateModule =
    /(?:from\s*|import\s*\()["'](?:@t3tools|\.\.?\/(?:apps|packages))[/]/.test(emitted);
  const importsTypeScriptSource = /(?:from\s*["']|import\s*\(["'])[^"']+\.ts["']/.test(emitted);
  if (importsPrivateModule || importsTypeScriptSource) {
    throw new Error("Packed output leaks a private workspace or TypeScript source dependency.");
  }

  const consumerRoot = NodePath.join(tempRoot, "consumer");
  await NodeFSP.mkdir(consumerRoot, { recursive: true });
  await Bun.write(
    NodePath.join(consumerRoot, "package.json"),
    JSON.stringify({ name: "cocoa-client-consumer", private: true, type: "module" }),
  );
  await run(["bun", "add", tarballPath, "--no-save"], consumerRoot);
  await Bun.write(
    NodePath.join(consumerRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["index.ts"],
    }),
  );
  await Bun.write(
    NodePath.join(consumerRoot, "index.ts"),
    `import { COCOA_CLIENT_PROTOCOL_VERSION, supportsCocoaCapability, type CocoaClientConnectOptions } from "@brbc/cocoa-client";
const options: CocoaClientConnectOptions = { baseUrl: "https://cocoa.example", bearerToken: "token" };
if (COCOA_CLIENT_PROTOCOL_VERSION !== 1 || !supportsCocoaCapability(["orchestration.core"], "orchestration.core") || options.baseUrl.length === 0) throw new Error("consumer failed");
`,
  );
  await run(
    [NodePath.resolve(workspaceRoot, "node_modules/.bin/tsgo"), "-p", "tsconfig.json"],
    consumerRoot,
  );
  await run(["bun", "index.ts"], consumerRoot);
} finally {
  await NodeFSP.rm(tempRoot, { recursive: true, force: true });
}
