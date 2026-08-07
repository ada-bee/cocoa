// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { openWorkspace } from "./WorkspaceRuntime.ts";

const withWorkspace = <A, E>(
  use: (input: { readonly root: string; readonly outside: string }) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-host-runtime-"));
      const root = NodePath.join(base, "workspace");
      const outside = NodePath.join(base, "outside");
      await NodeFSP.mkdir(NodePath.join(root, "src"), { recursive: true });
      await NodeFSP.mkdir(outside, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(root, "src", "main.ts"),
        "export const cocoa = true;\n",
      );
      await NodeFSP.writeFile(NodePath.join(root, "README.md"), "abcdefghij");
      await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "secret");
      await NodeFSP.symlink(outside, NodePath.join(root, "escape"));
      return { base, root, outside };
    }),
    ({ root, outside }) => use({ root, outside }),
    ({ base }) => Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
  );

describe("WorkspaceRuntime", () => {
  it.effect("uses normalized POSIX-relative paths and bounded reads", () =>
    withWorkspace(({ root }) =>
      Effect.gen(function* () {
        const workspace = yield* openWorkspace(root);
        const read = yield* workspace.read("README.md", { maxBytes: 4 });
        expect(read).toMatchObject({
          path: "README.md",
          byteLength: 10,
          truncated: true,
        });
        expect(new TextDecoder().decode(read.bytes)).toBe("abcd");

        for (const invalid of ["../outside", "/absolute", "src\\main.ts", "src//main.ts"]) {
          const error = yield* workspace.stat(invalid).pipe(Effect.flip);
          expect(error.reason).toBe("invalid-path");
        }
      }),
    ),
  );

  it.effect("rejects symlinks that resolve outside the opened root", () =>
    withWorkspace(({ root }) =>
      Effect.gen(function* () {
        const workspace = yield* openWorkspace(root);
        const error = yield* workspace.read("escape/secret.txt").pipe(Effect.flip);
        expect(error).toMatchObject({
          operation: "read",
          path: "escape/secret.txt",
          reason: "outside-root",
        });
      }),
    ),
  );

  it.effect("bounds listings and never descends through directory symlinks", () =>
    withWorkspace(({ root }) =>
      Effect.gen(function* () {
        const workspace = yield* openWorkspace(root);
        const list = yield* workspace.list("", { maxEntries: 2 });
        expect(list.entries).toHaveLength(2);
        expect(list.truncated).toBe(true);

        const tree = yield* workspace.tree("", {
          maxEntries: 20,
          maxDepth: 4,
          maxDirectories: 4,
        });
        expect(tree.entries.find((entry) => entry.path === "escape")?.kind).toBe("symlink");
        expect(tree.entries.some((entry) => entry.path === "escape/secret.txt")).toBe(false);
        expect(tree.entries.some((entry) => entry.path === "src/main.ts")).toBe(true);

        const browse = yield* workspace.browse("src");
        expect(browse.parentPath).toBe("");
        expect(browse.entries.map((entry) => entry.name)).toEqual(["main.ts"]);
      }),
    ),
  );

  it.effect("returns binary bytes without text decoding", () =>
    withWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "image.bin"), Uint8Array.of(0, 255, 1)),
        );
        const workspace = yield* openWorkspace(root);
        const read = yield* workspace.read("image.bin");
        expect([...read.bytes]).toEqual([0, 255, 1]);
        expect(read.truncated).toBe(false);
      }),
    ),
  );

  it.effect("bounds recursive directory traversal independently", () =>
    withWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.join(root, "src", "nested", "deeper"), { recursive: true }),
        );
        const workspace = yield* openWorkspace(root);
        const tree = yield* workspace.tree("src", {
          maxEntries: 20,
          maxDepth: 20,
          maxDirectories: 1,
        });
        expect(tree.truncated).toBe(true);
        expect(tree.entries.some((entry) => entry.path === "src/nested")).toBe(true);
        expect(tree.entries.some((entry) => entry.path === "src/nested/deeper")).toBe(false);
      }),
    ),
  );
});
