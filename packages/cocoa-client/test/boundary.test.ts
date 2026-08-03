// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const packageRoot = NodePath.resolve(import.meta.dirname, "..");

describe("public package boundary", () => {
  it("has a publishable manifest with one exact runtime dependency", async () => {
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.resolve(packageRoot, "package.json"), "utf8"),
    ) as {
      readonly name: string;
      readonly private: boolean;
      readonly files: ReadonlyArray<string>;
      readonly dependencies?: Record<string, string>;
      readonly exports: unknown;
    };
    expect(manifest.name).toBe("@brbc/cocoa-client");
    expect(manifest.private).toBe(false);
    expect(manifest.files).toEqual(["dist"]);
    expect(manifest.dependencies).toEqual({ effect: "4.0.0-beta.102" });
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
  });

  it("does not import private Cocoa application or platform modules", async () => {
    const sourceDirectory = NodePath.resolve(packageRoot, "src");
    const sourceFiles = (await NodeFSP.readdir(sourceDirectory)).filter((file) =>
      file.endsWith(".ts"),
    );
    const source = (
      await Promise.all(
        sourceFiles.map((file) =>
          NodeFSP.readFile(NodePath.resolve(sourceDirectory, file), "utf8"),
        ),
      )
    ).join("\n");

    expect(source).not.toMatch(/(?:apps\/|client-runtime|shared\/|server\/|provider\/|catalog:)/);
  });
});
