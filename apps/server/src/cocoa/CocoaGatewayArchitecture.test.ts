// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  auditCocoaGatewayArchitecture,
  collectStaticImportSpecifiers,
  type CocoaGatewayArchitectureClassification,
} from "./CocoaGatewayArchitectureAudit.ts";
import {
  COCOA_GATEWAY_FORBIDDEN_DEPENDENCY_ALLOWLIST,
  COCOA_GATEWAY_RUNTIME_DEPENDENCY_MAP,
  COCOA_GATEWAY_RUNTIME_ENTRY,
  COCOA_GATEWAY_RUNTIME_IMPORT_MANIFEST,
  COCOA_GATEWAY_TRANSITIVE_CALLSITE_MANIFEST,
} from "./CocoaGatewayArchitecture.ts";

const sourceRoot = NodePath.resolve(new URL("..", import.meta.url).pathname);

const normalizePath = (path: string): string => path.split(NodePath.sep).join("/");

const readSource = (path: string): string | undefined => {
  const absolute = NodePath.join(sourceRoot, path);
  return NodeFS.existsSync(absolute) ? NodeFS.readFileSync(absolute, "utf8") : undefined;
};

const resolveRelativeImport = (sourcePath: string, specifier: string): string | undefined => {
  const unresolved = NodePath.resolve(sourceRoot, NodePath.dirname(sourcePath), specifier);
  const candidates = [
    unresolved,
    unresolved.replace(/\.js$/, ".ts"),
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    NodePath.join(unresolved, "index.ts"),
  ];
  const resolved = candidates.find(
    (candidate) => NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile(),
  );
  return resolved === undefined
    ? undefined
    : normalizePath(NodePath.relative(sourceRoot, resolved));
};

const classifications: ReadonlyArray<CocoaGatewayArchitectureClassification> =
  COCOA_GATEWAY_TRANSITIVE_CALLSITE_MANIFEST;

const audit = () =>
  auditCocoaGatewayArchitecture({
    entryPath: COCOA_GATEWAY_RUNTIME_ENTRY,
    readSource,
    resolveRelativeImport,
    classifications,
  });

const formatAudit = (result: ReturnType<typeof audit>): string =>
  JSON.stringify(
    {
      modules: result.modules,
      forbiddenCallsites: result.forbiddenCallsites,
      unclassifiedCallsites: result.unclassifiedCallsites,
      staleClassifications: result.staleClassifications,
    },
    null,
    2,
  );

const virtualAudit = (files: Readonly<Record<string, string>>) =>
  auditCocoaGatewayArchitecture({
    entryPath: "entry.ts",
    readSource: (path) => files[path],
    resolveRelativeImport: (sourcePath, specifier) => {
      const resolved = NodePath.posix.normalize(
        NodePath.posix.join(NodePath.posix.dirname(sourcePath), specifier),
      );
      return files[resolved] === undefined ? undefined : resolved;
    },
    classifications: [],
  });

describe("Cocoa gateway architecture", () => {
  it("has an empty forbidden dependency exception allowlist", () => {
    expect(COCOA_GATEWAY_FORBIDDEN_DEPENDENCY_ALLOWLIST).toEqual([]);
  });

  it("audits the deployed Cocoa executable instead of an inner layer", () => {
    expect(COCOA_GATEWAY_RUNTIME_ENTRY).toBe("cocoa-bin.ts");
    const entrySource = readSource(COCOA_GATEWAY_RUNTIME_ENTRY)!;
    expect(entrySource).toContain('./cocoa/CocoaGatewayServer.ts"');
    expect(entrySource).not.toMatch(/(?:\.\/server\.ts|\.\/cli\/server\.ts)/);
  });

  it("classifies every direct Cocoa runtime import with an exact file path", () => {
    const runtimeSource = readSource(COCOA_GATEWAY_RUNTIME_ENTRY)!;
    const actual = collectStaticImportSpecifiers(runtimeSource)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolveRelativeImport(COCOA_GATEWAY_RUNTIME_ENTRY, specifier))
      .sort();
    const expected = COCOA_GATEWAY_RUNTIME_IMPORT_MANIFEST.map(({ path }) => path).toSorted();
    expect(actual).toEqual(expected);
  });

  it("walks and reports the complete transitive closure with no unclassified callsites", () => {
    const result = audit();
    expect(result.modules).toContain("cocoa-bin.ts");
    expect(result.modules).toContain("cocoa/CocoaGatewayServer.ts");
    expect(result.unclassifiedCallsites, formatAudit(result)).toEqual([]);
    expect(result.staleClassifications, formatAudit(result)).toEqual([]);
  });

  it("excludes legacy providers, local project tools, hosted product code, and telemetry", () => {
    const result = audit();
    const forbiddenModules = [
      "server.ts",
      "cli/server.ts",
      "cloud/selfUpdate.ts",
      "cloud/serviceLauncherClient.ts",
      "diagnostics/ProcessDiagnostics.ts",
      "diagnostics/ProcessResourceMonitor.ts",
      "diagnostics/TraceDiagnostics.ts",
      "observability/Layers/Observability.ts",
      "provider/Drivers/CodexDriver.ts",
      "provider/Drivers/CodexHomeLayout.ts",
      "provider/Layers/CodexAdapter.ts",
      "provider/Layers/CodexProvider.ts",
      "provider/Layers/CodexSessionRuntime.ts",
      "provider/Layers/EventNdjsonLogger.ts",
      "provider/providerMaintenance.ts",
      "provider/providerSnapshot.ts",
      "resourceTelemetry/DesktopTelemetryReceiver.ts",
      "resourceTelemetry/NativeTelemetryClient.ts",
      "resourceTelemetry/ResourceMonitorBinary.ts",
      "resourceTelemetry/ResourceTelemetry.ts",
      "telemetry/AnalyticsService.ts",
      "terminal/Manager.ts",
      "terminal/PtyAdapter.ts",
      "textGeneration/CodexTextGeneration.ts",
    ];
    for (const module of forbiddenModules) {
      expect(result.modules, module).not.toContain(module);
    }
    expect(result.modules.filter((module) => /(?:^|\/)relay\//.test(module))).toEqual([]);
    expect(result.modules.filter((module) => /(?:^|\/)(?:git|vcs)\//.test(module))).toEqual([]);

    const externalSpecifiers = new Set(
      result.imports.filter((edge) => edge.targetPath === null).map((edge) => edge.specifier),
    );
    for (const specifier of [
      "@anthropic-ai/claude-agent-sdk",
      "@opencode-ai/sdk",
      "@t3tools/shared/relayClient",
      "@t3tools/tailscale",
      "node-pty",
    ]) {
      expect(externalSpecifiers, specifier).not.toContain(specifier);
    }
  });

  it("keeps Cocoa SQLite hard-pinned to durable local mode without hosted launcher resolution", () => {
    const sqliteSource = readSource("persistence/Layers/SqliteCore.ts")!;
    const sqliteAudit = auditCocoaGatewayArchitecture({
      entryPath: "persistence/Layers/SqliteCore.ts",
      readSource,
      resolveRelativeImport,
      classifications: [],
    });

    expect(sqliteSource).toContain("makeSqlitePersistenceLive(dbPath, { trial: false })");
    expect(sqliteAudit.modules).not.toContain("cloud/serviceLauncherClient.ts");
  });

  it("fails closed for a newly introduced direct forbidden callsite", () => {
    const result = virtualAudit({
      "entry.ts": 'import "node:child_process";',
    });
    expect(result.unclassifiedCallsites).toMatchObject([
      { sourcePath: "entry.ts", specifier: "node:child_process", capability: "local-shell-or-pty" },
    ]);
  });

  it("fails closed for a newly introduced transitive forbidden callsite", () => {
    const result = virtualAudit({
      "entry.ts": 'import "./safe.ts";',
      "safe.ts": 'export * from "./nested.ts";',
      "nested.ts": 'export const run = () => Bun.spawn(["codex"]);',
    });
    expect(result.unclassifiedCallsites).toMatchObject([
      {
        sourcePath: "nested.ts",
        specifier: "symbol:Bun.spawn",
        capability: "provider-process-lifecycle",
      },
    ]);
  });

  it.each([
    ["dynamic import", "const moduleName = './nested.ts'; import(moduleName);"],
    ["CommonJS require", "const moduleName = './nested.ts'; require(moduleName);"],
    ["CommonJS resolver", "require.resolve('./nested.ts');"],
    ["CommonJS loader factory", "createRequire(import.meta.url)('./nested.ts');"],
    [
      "aliased CommonJS loader factory",
      "const makeRequire = createRequire; makeRequire(import.meta.url)('./nested.ts');",
    ],
  ])("fails closed for an opaque %s", (_label, source) => {
    expect(() => virtualAudit({ "entry.ts": source })).toThrow(
      /dependency closure cannot be proven/,
    );
  });

  it.each([
    ["compact side-effect import", 'import"node:child_process";'],
    ["compact re-export", 'export{x}from"node:child_process";'],
  ])("does not miss a %s", (_label, source) => {
    const result = virtualAudit({ "entry.ts": source });
    expect(result.unclassifiedCallsites).toMatchObject([
      { sourcePath: "entry.ts", specifier: "node:child_process", capability: "local-shell-or-pty" },
    ]);
  });

  it.each([
    ["computed Bun spawn", 'Bun["spawn"](["codex"]);', "symbol:Bun.spawn"],
    ["global Bun spawn", 'globalThis.Bun.spawn(["codex"]);', "symbol:Bun.spawn"],
    ["aliased Bun spawn", "const launch = Bun.spawn; launch(['codex']);", "symbol:Bun.spawn"],
    ["destructured Bun spawn", "const { spawn } = Bun; spawn(['codex']);", "symbol:Bun.spawn"],
    ["computed process kill", 'process["kill"](123);', "symbol:process.kill"],
  ])("does not miss a %s", (_label, source, specifier) => {
    const result = virtualAudit({ "entry.ts": source });
    expect(result.unclassifiedCallsites).toMatchObject([{ sourcePath: "entry.ts", specifier }]);
  });

  it("retains the named legacy boundary map as a human-readable cross-check", () => {
    expect(Object.keys(COCOA_GATEWAY_RUNTIME_DEPENDENCY_MAP).toSorted()).toEqual([
      "hostedConnectivity",
      "localDiagnostics",
      "projectFilesystem",
      "projectVcs",
      "providerLifecycle",
      "serverEnvironment",
      "shellAndTerminal",
    ]);
  });

  it("keeps Cocoa environment metadata free of host command probes", () => {
    const cocoaEnvironment = readSource("environment/CocoaServerEnvironment.ts")!;
    expect(cocoaEnvironment).not.toContain("ProcessRunner");
    expect(cocoaEnvironment).not.toContain("resolveServerEnvironmentLabel");
    expect(cocoaEnvironment).not.toContain("resolveServiceLauncherMode");
    expect(cocoaEnvironment).not.toContain("serviceLauncherClient");
  });
});
