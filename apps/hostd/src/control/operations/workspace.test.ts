// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CocoaHostControlGenerationId,
  CocoaHostControlRequestId,
  CocoaHostControlResourceId,
  CocoaHostWorkspaceRequest,
  CocoaHostWorkspaceResponse,
} from "@t3tools/contracts";
import { openWorkspace } from "@t3tools/host-runtime/workspace";
import { afterEach, describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeHostControlOperations } from "./index.ts";
import { HOST_CONTROL_MAX_WORKSPACE_HANDLES, type HostControlVcsRun } from "./state.ts";

const decodeRequest = Schema.decodeUnknownSync(CocoaHostWorkspaceRequest);
const decodeResponse = Schema.decodeUnknownSync(CocoaHostWorkspaceResponse);
const generationId = CocoaHostControlGenerationId.make("generation-1");
const requestId = CocoaHostControlRequestId.make("request-1");
const temporaryPaths: string[] = [];

const unusedVcs: HostControlVcsRun = () => Effect.die("VCS was not expected in workspace tests");

// Bun is the hostd test runner; bridge only at the outer test boundary.
const effectTest = (name: string, test: () => Effect.Effect<void, never>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Hostd intentionally uses Bun's test runner.
  it(name, () => Effect.runPromise(test()));

const makeOperations = (homePath: string) => {
  let nextId = 0;
  return makeHostControlOperations({
    generationId,
    homePath,
    openWorkspace,
    runVcs: unusedVcs,
    makeResourceId: () => CocoaHostControlResourceId.make(`workspace-${(nextId += 1)}`),
  });
};

afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) {
    await NodeFSP.rm(path, { recursive: true, force: true });
  }
});

describe("hostd workspace control operations", () => {
  effectTest(
    "opens one canonical root and serves bounded list/read operations through its handle",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-hostd-workspace-")),
        );
        temporaryPaths.push(root);
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "src")));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "src", "index.ts"), "export const cocoa = true;\n"),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "README.md"), "# Cocoa\n"),
        );
        const operations = makeOperations(root);

        const opened = yield* operations.workspace(
          decodeRequest({
            protocolVersion: 1,
            requestId,
            operation: "workspace.open",
            path: root,
          }),
        );
        expect("error" in opened).toBe(false);
        if ("error" in opened || opened.operation !== "workspace.open") return;
        expect(() => decodeResponse(opened)).not.toThrow();
        expect(opened.generationId).toBe(generationId);
        expect(operations.state.workspaces.has(opened.rootId)).toBe(true);

        const listed = yield* operations.workspace(
          decodeRequest({
            protocolVersion: 1,
            requestId,
            operation: "workspace.list",
            generationId,
            rootId: opened.rootId,
            relativePath: "",
            maxEntries: 10,
            maxDepth: 2,
            maxDirectories: 10,
          }),
        );
        expect(listed).toMatchObject({
          operation: "workspace.list",
          truncated: false,
          entries: [
            { path: "README.md", kind: "file" },
            { path: "src", kind: "directory" },
            { path: "src/index.ts", kind: "file" },
          ],
        });

        const nested = yield* operations.workspace(
          decodeRequest({
            protocolVersion: 1,
            requestId,
            operation: "workspace.list",
            generationId,
            rootId: opened.rootId,
            relativePath: "src",
            maxEntries: 10,
            maxDepth: 1,
            maxDirectories: 10,
          }),
        );
        expect(nested).toMatchObject({
          operation: "workspace.list",
          truncated: false,
          entries: [{ path: "index.ts", kind: "file" }],
        });

        const read = yield* operations.workspace(
          decodeRequest({
            protocolVersion: 1,
            requestId,
            operation: "workspace.read",
            generationId,
            rootId: opened.rootId,
            relativePath: "src/index.ts",
            maxBytes: 1024,
          }),
        );
        expect(read).toMatchObject({
          operation: "workspace.read",
          dataBase64: Buffer.from("export const cocoa = true;\n").toString("base64"),
          byteLength: 27,
          truncated: false,
        });
        expect(() => decodeResponse(read)).not.toThrow();

        const truncatedRead = yield* operations.workspace(
          decodeRequest({
            protocolVersion: 1,
            requestId,
            operation: "workspace.read",
            generationId,
            rootId: opened.rootId,
            relativePath: "src/index.ts",
            maxBytes: 6,
          }),
        );
        expect(truncatedRead).toMatchObject({
          operation: "workspace.read",
          dataBase64: Buffer.from("export").toString("base64"),
          byteLength: 27,
          truncated: true,
        });
        expect(() => decodeResponse(truncatedRead)).not.toThrow();
      }),
  );

  effectTest(
    "supports home-relative browsing without turning the path into a gateway-local concern",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-hostd-home-")),
        );
        temporaryPaths.push(home);
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(home, "Developer")));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(home, "Developer", "README.md"), "hello"),
        );
        const canonicalHome = yield* Effect.promise(() => NodeFSP.realpath(home));
        const operations = makeOperations(home);

        const browsed = yield* operations.workspace(
          decodeRequest({
            protocolVersion: 1,
            requestId,
            operation: "workspace.browse",
            locator: { kind: "home", relativePath: "Developer" },
            maxEntries: 10,
          }),
        );
        expect(browsed).toMatchObject({
          operation: "workspace.browse",
          directoryPath: NodePath.join(canonicalHome, "Developer"),
          parentPath: canonicalHome,
          entries: [{ name: "README.md", kind: "file" }],
        });
      }),
  );

  effectTest("rejects stale and unknown handles before touching the filesystem", () =>
    Effect.gen(function* () {
      const operations = makeOperations("/tmp");
      const stale = yield* operations.workspace(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "workspace.stat",
          generationId: "generation-old",
          rootId: "workspace-1",
          relativePath: "",
        }),
      );
      expect(stale).toMatchObject({ error: { code: "staleHandle", retryable: false } });

      const unknown = yield* operations.workspace(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "workspace.stat",
          generationId,
          rootId: "workspace-missing",
          relativePath: "",
        }),
      );
      expect(unknown).toMatchObject({ error: { code: "notFound", retryable: false } });
    }),
  );

  effectTest("bounds generation-scoped workspace handles", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-hostd-workspace-handles-")),
      );
      temporaryPaths.push(root);
      const operations = makeOperations(root);
      for (let index = 0; index <= HOST_CONTROL_MAX_WORKSPACE_HANDLES; index += 1) {
        yield* operations.workspace(
          decodeRequest({
            protocolVersion: 1,
            requestId,
            operation: "workspace.open",
            path: root,
          }),
        );
      }
      expect(operations.state.workspaces.size).toBe(HOST_CONTROL_MAX_WORKSPACE_HANDLES);
      expect(operations.state.workspaces.has("workspace-1")).toBe(false);
    }),
  );
});
