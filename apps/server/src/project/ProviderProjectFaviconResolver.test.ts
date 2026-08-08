import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ProjectWorkspaceShape } from "./ProjectWorkspace.ts";
import { ProjectWorkspace } from "./ProjectWorkspace.ts";
import { make } from "./ProviderProjectFaviconResolver.ts";

const encoder = new TextEncoder();

function makeWorkspace(
  files: ReadonlyMap<string, string>,
  inspected: Array<string>,
  read: Array<{
    readonly key: string;
    readonly maxBytes: number;
  }>,
): ProjectWorkspace["Service"] {
  const unavailable: ProjectWorkspaceShape = {
    validateRoot: () => Effect.die("unexpected validateRoot"),
    listDirectory: () => Effect.die("unexpected listDirectory"),
    listEntries: () => Effect.die("unexpected listEntries"),
    getMetadata: (input) => {
      const key = `${input.target.projectId}:${input.relativePath}`;
      inspected.push(key);
      const source = files.get(key);
      return Effect.succeed(
        source === undefined
          ? { kind: "other" as const }
          : { kind: "file" as const, size: encoder.encode(source).byteLength },
      );
    },
    readFile: (input) => {
      const key = `${input.target.projectId}:${input.relativePath}`;
      read.push({ key, maxBytes: input.maxBytes });
      const bytes = encoder.encode(files.get(key) ?? "");
      return Effect.succeed({
        bytes: bytes.slice(0, input.maxBytes),
        byteLength: bytes.byteLength,
        truncated: bytes.byteLength > input.maxBytes,
      });
    },
  };
  return ProjectWorkspace.of(unavailable);
}

describe("ProviderProjectFaviconResolver", () => {
  it.effect("preserves t3.json priority and routes identical workspace paths by project id", () =>
    Effect.gen(function* () {
      const firstProjectId = ProjectId.make("project-first");
      const secondProjectId = ProjectId.make("project-second");
      const inspected: Array<string> = [];
      const reads: Array<{ readonly key: string; readonly maxBytes: number }> = [];
      const files = new Map([
        [`${firstProjectId}:t3.json`, '{ "iconPath": "brand/first.svg" }'],
        [`${firstProjectId}:brand/first.svg`, "first"],
        [`${firstProjectId}:favicon.svg`, "lower-priority"],
        [`${secondProjectId}:favicon.png`, "second"],
        [`${secondProjectId}:public/favicon.svg`, "lower-priority"],
      ]);
      const resolver = yield* make().pipe(
        Effect.provideService(ProjectWorkspace, makeWorkspace(files, inspected, reads)),
      );

      expect(yield* resolver.resolvePath(firstProjectId)).toBe("brand/first.svg");
      expect(yield* resolver.resolvePath(secondProjectId)).toBe("favicon.png");
      expect(inspected).toContain(`${firstProjectId}:brand/first.svg`);
      expect(inspected).not.toContain(`${firstProjectId}:favicon.svg`);
      expect(inspected).toContain(`${secondProjectId}:favicon.png`);
      expect(reads).toEqual([{ key: `${firstProjectId}:t3.json`, maxBytes: 128 * 1024 }]);
    }),
  );

  it.effect("discovers link metadata, rejects traversal, and caches the resolved path", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-link");
      const inspected: Array<string> = [];
      const reads: Array<{ readonly key: string; readonly maxBytes: number }> = [];
      const files = new Map([
        [`${projectId}:t3.json`, '{ "iconPath": "../../outside.svg" }'],
        [`${projectId}:index.html`, '<link rel="icon" href="/brand/logo.svg">'],
        [`${projectId}:public/brand/logo.svg`, "logo"],
      ]);
      const resolver = yield* make().pipe(
        Effect.provideService(ProjectWorkspace, makeWorkspace(files, inspected, reads)),
      );

      expect(yield* resolver.resolvePath(projectId)).toBe("public/brand/logo.svg");
      const inspectionCount = inspected.length;
      const readCount = reads.length;
      expect(yield* resolver.resolvePath(projectId)).toBe("public/brand/logo.svg");
      expect(inspected).toHaveLength(inspectionCount);
      expect(reads).toHaveLength(readCount);
      expect(inspected).not.toContain(`${projectId}:outside.svg`);
      expect(reads).toContainEqual({ key: `${projectId}:index.html`, maxBytes: 128 * 1024 });
    }),
  );

  it.effect("skips an oversized metadata source and continues discovery", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-oversized-source");
      const inspected: Array<string> = [];
      const reads: Array<{ readonly key: string; readonly maxBytes: number }> = [];
      const files = new Map([
        [`${projectId}:index.html`, "x".repeat(128 * 1024 + 1)],
        [`${projectId}:public/index.html`, '<link rel="shortcut icon" href="/brand/fallback.png">'],
        [`${projectId}:public/brand/fallback.png`, "fallback"],
      ]);
      const resolver = yield* make().pipe(
        Effect.provideService(ProjectWorkspace, makeWorkspace(files, inspected, reads)),
      );

      expect(yield* resolver.resolvePath(projectId)).toBe("public/brand/fallback.png");
      expect(reads).toContainEqual({ key: `${projectId}:index.html`, maxBytes: 128 * 1024 });
      expect(reads).toContainEqual({
        key: `${projectId}:public/index.html`,
        maxBytes: 128 * 1024,
      });
    }),
  );
});
