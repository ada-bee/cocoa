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
const serverSource = NodeFS.readFileSync(NodePath.join(sourceRoot, "server.ts"), "utf8");
const serverEnvironmentSource = NodeFS.readFileSync(
  NodePath.join(sourceRoot, "environment/ServerEnvironment.ts"),
  "utf8",
);

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

  it("keeps the complete Cocoa runtime composition outside mixed legacy server source", () => {
    expect(serverSource).toContain(
      'import { CocoaRuntimeDependenciesLive } from "./cocoa/CocoaGatewayRuntime.ts";',
    );
    expect(serverSource).not.toContain("const CocoaRuntimeBaseDependenciesLive =");
    expect(serverSource).not.toContain("const CocoaRuntimeCoreDependenciesLive =");
    expect(serverSource).not.toContain("const CocoaRuntimeDependenciesLive =");
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
    expect(result.modules[0]).toBeDefined();
    expect(result.modules).toMatchSnapshot();
    expect(result.unclassifiedCallsites, formatAudit(result)).toEqual([]);
    expect(result.staleClassifications, formatAudit(result)).toEqual([]);
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
  ])("fails closed for an opaque %s", (_label, source) => {
    expect(() => virtualAudit({ "entry.ts": source })).toThrow(
      /dependency closure cannot be proven/,
    );
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

  it("keeps conditional legacy process services out of the Cocoa branch", () => {
    expect(serverSource).toContain(
      "const LegacyRuntimeDependenciesWithVcsLive = LegacyRuntimeDependenciesLive.pipe(",
    );
    expect(serverSource).toContain(
      "const hostedRuntimeLayer = legacyFleetFeatures ? LegacyHostedRuntimeLayerLive : Layer.empty;",
    );
    expect(serverSource).toContain('config.runtimeProfile === "cocoa-gateway"');
    expect(serverSource).toContain("Cocoa gateway updates are administrator-managed.");
    expect(serverSource).toContain(
      'if (config.runtimeProfile !== "cocoa-gateway") {\n      yield* fixPath();',
    );
    expect(serverSource.match(/yield\* fixPath\(\);/g)).toHaveLength(1);
  });

  it("keeps Cocoa environment metadata free of host command probes", () => {
    const cocoaEnvironmentStart = serverEnvironmentSource.indexOf(
      "export const makeCocoaGateway =",
    );
    const cocoaEnvironmentEnd = serverEnvironmentSource.indexOf(
      "export const cocoaGatewayLayer =",
      cocoaEnvironmentStart,
    );
    expect(cocoaEnvironmentStart).toBeGreaterThanOrEqual(0);
    expect(cocoaEnvironmentEnd).toBeGreaterThan(cocoaEnvironmentStart);

    const cocoaEnvironment = serverEnvironmentSource.slice(
      cocoaEnvironmentStart,
      cocoaEnvironmentEnd,
    );
    expect(cocoaEnvironment).not.toContain("ProcessRunner");
    expect(cocoaEnvironment).not.toContain("resolveServerEnvironmentLabel");
    expect(cocoaEnvironment).not.toContain("resolveServiceLauncherMode");
  });
});
