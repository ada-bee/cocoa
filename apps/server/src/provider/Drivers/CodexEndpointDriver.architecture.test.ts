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

describe("Cocoa Codex endpoint driver architecture", () => {
  it("keeps the endpoint catalog outside every local Codex implementation", () => {
    const result = audit();
    for (const forbiddenModule of [
      "provider/Drivers/CodexDriver.ts",
      "provider/Drivers/CodexHomeLayout.ts",
      "provider/Layers/CodexAdapter.ts",
      "provider/Layers/CodexProvider.ts",
      "provider/Layers/CodexSessionRuntime.ts",
      "provider/ProviderInstanceEnvironment.ts",
      "provider/providerMaintenance.ts",
      "provider/providerSnapshot.ts",
      "textGeneration/CodexTextGeneration.ts",
    ]) {
      expect(result.modules, forbiddenModule).not.toContain(forbiddenModule);
    }
  });

  it("imports no process service in the direct WebSocket endpoint graph", () => {
    const processImports = audit().imports.filter(
      ({ specifier }) =>
        specifier === "effect/unstable/process" ||
        specifier === "effect/unstable/process/ChildProcessSpawner",
    );
    expect(processImports).toEqual([]);
  });

  it("contains no gateway-local project Git, workspace, or PTY implementation", () => {
    const modules = audit().modules;
    for (const forbiddenModule of [
      "terminal/PtyAdapter.ts",
      "workspace/WorkspaceEntries.ts",
      "workspace/WorkspacePaths.ts",
      "vcs/GitVcsDriver.ts",
      "vcs/VcsProcess.ts",
    ]) {
      expect(modules, forbiddenModule).not.toContain(forbiddenModule);
    }
  });
});
