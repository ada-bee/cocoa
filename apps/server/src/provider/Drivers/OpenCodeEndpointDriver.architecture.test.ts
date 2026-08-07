// @effect-diagnostics nodeBuiltinImport:off - architecture test reads source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { auditCocoaGatewayArchitecture } from "../../cocoa/CocoaGatewayArchitectureAudit.ts";

const sourceRoot = NodePath.resolve(import.meta.dirname, "../..");
const normalizePath = (path: string): string => path.split(NodePath.sep).join("/");
const readSource = (path: string): string | undefined => {
  const absolute = NodePath.join(sourceRoot, path);
  return NodeFS.existsSync(absolute) ? NodeFS.readFileSync(absolute, "utf8") : undefined;
};
const resolveRelativeImport = (sourcePath: string, specifier: string): string | undefined => {
  const unresolved = NodePath.resolve(sourceRoot, NodePath.dirname(sourcePath), specifier);
  const resolved = [
    unresolved,
    unresolved.replace(/\.js$/, ".ts"),
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    NodePath.join(unresolved, "index.ts"),
  ].find((candidate) => NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile());
  return resolved === undefined
    ? undefined
    : normalizePath(NodePath.relative(sourceRoot, resolved));
};

const audit = () =>
  auditCocoaGatewayArchitecture({
    entryPath: "provider/cocoaGatewayDrivers.ts",
    readSource,
    resolveRelativeImport,
    classifications: [],
  });

describe("Cocoa OpenCode endpoint driver architecture", () => {
  it("keeps the endpoint catalog outside every local OpenCode implementation", () => {
    const modules = audit().modules;
    for (const forbiddenModule of [
      "provider/Drivers/OpenCodeDriver.ts",
      "provider/Layers/LegacyOpenCodeAdapter.ts",
      "provider/opencodeRuntime.ts",
      "provider/providerMaintenance.ts",
      "textGeneration/OpenCodeTextGeneration.ts",
    ]) {
      expect(modules, forbiddenModule).not.toContain(forbiddenModule);
    }
  });

  it("imports no process service in the OpenCode endpoint graph", () => {
    const processImports = audit().imports.filter(
      ({ specifier }) =>
        specifier === "effect/unstable/process" ||
        specifier === "effect/unstable/process/ChildProcessSpawner",
    );
    expect(processImports).toEqual([]);
  });

  it("does not interpret remote paths with Path services in OpenCode modules", () => {
    const pathImports = audit().imports.filter(
      ({ sourcePath, specifier }) =>
        specifier === "effect/Path" &&
        (sourcePath === "provider/OpenCodeEndpointRuntime.ts" ||
          sourcePath === "provider/Layers/OpenCodeAdapter.ts" ||
          sourcePath === "provider/Drivers/OpenCodeEndpointDriver.ts" ||
          sourcePath === "provider/Drivers/OpenCodeEndpointProviderSnapshot.ts"),
    );
    expect(pathImports).toEqual([]);
  });
});
