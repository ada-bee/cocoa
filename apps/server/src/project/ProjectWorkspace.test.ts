import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import {
  ProviderWorkspaceDisconnectedError,
  ProviderWorkspaceOperationError,
  ProviderWorkspacePathError,
  ProviderWorkspaceProtocolError,
  ProviderWorkspaceUnsupportedError,
  type ProviderWorkspaceAdapter,
  type ProviderWorkspaceError,
  ProviderWorkspaceMaxEntries,
  ProviderWorkspaceReadByteLimit,
  PROVIDER_WORKSPACE_MAX_READ_BYTES,
} from "../provider/ProviderWorkspaceAdapter.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ProjectWorkspace from "./ProjectWorkspace.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const missingProject = ProjectId.make("missing-project");
const providerA = ProviderInstanceId.make("provider-a");
const providerB = ProviderInstanceId.make("provider-b");
const missingProvider = ProviderInstanceId.make("missing-provider");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const missingThread = ThreadId.make("missing-thread");
const sharedRoot = "/srv/shared/workspace";

it("requires directory listing bounds to be positive integers", () => {
  assert.throws(() => ProviderWorkspaceMaxEntries.make(0));
  assert.throws(() => ProviderWorkspaceMaxEntries.make(1.5));
  assert.strictEqual(ProviderWorkspaceMaxEntries.make(1), 1);
});

it("bounds provider workspace reads at one MiB", () => {
  assert.throws(() => ProviderWorkspaceReadByteLimit.make(0));
  assert.throws(() => ProviderWorkspaceReadByteLimit.make(PROVIDER_WORKSPACE_MAX_READ_BYTES + 1));
  assert.strictEqual(
    ProviderWorkspaceReadByteLimit.make(PROVIDER_WORKSPACE_MAX_READ_BYTES),
    PROVIDER_WORKSPACE_MAX_READ_BYTES,
  );
});

function projectShell(input: {
  readonly id: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly workspaceRoot?: string;
}): OrchestrationProjectShell {
  return {
    id: input.id,
    providerInstanceId: input.providerInstanceId,
    title: `Project ${input.id}`,
    workspaceRoot: input.workspaceRoot ?? sharedRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  } as OrchestrationProjectShell;
}

function providerInstance(
  instanceId: ProviderInstanceId,
  workspace?: ProviderWorkspaceAdapter,
  enabled = true,
): ProviderInstance {
  return {
    instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    workspace,
    enabled,
  } as unknown as ProviderInstance;
}

function threadShell(input: {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}): OrchestrationThreadShell {
  return input as unknown as OrchestrationThreadShell;
}

function testLayer(input: {
  readonly projects?: ReadonlyMap<ProjectId, OrchestrationProjectShell>;
  readonly threads?: ReadonlyMap<ThreadId, OrchestrationThreadShell>;
  readonly instances?: ReadonlyMap<ProviderInstanceId, ProviderInstance>;
  readonly getProjectShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getProjectShellById"];
}) {
  const projects = input.projects ?? new Map();
  const threads = input.threads ?? new Map();
  const instances = input.instances ?? new Map();
  return ProjectWorkspace.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShellById:
          input.getProjectShellById ??
          ((projectId) => {
            const project = projects.get(projectId);
            return Effect.succeed(project === undefined ? Option.none() : Option.some(project));
          }),
        getThreadShellById: (threadId) => {
          const thread = threads.get(threadId);
          return Effect.succeed(thread === undefined ? Option.none() : Option.some(thread));
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (instanceId) => Effect.succeed(instances.get(instanceId)),
      }),
    ),
  );
}

it.effect(
  "routes identical workspace roots through the owning provider instance and keeps the root authoritative",
  () => {
    const calls: Array<{
      readonly provider: string;
      readonly operation: string;
      readonly root: string;
      readonly relativePath?: string;
      readonly maxEntries?: number;
      readonly maxBytes?: number;
    }> = [];
    const makeWorkspace = (provider: string, kind: "file" | "directory") => ({
      openRoot: (root: string) =>
        Effect.succeed({
          getMetadata: ({ relativePath }: { readonly relativePath: string }) =>
            Effect.sync(() => {
              calls.push({ provider, operation: "getMetadata", root, relativePath });
              return { kind } as const;
            }),
          listDirectory: ({
            relativePath,
            maxEntries,
          }: {
            readonly relativePath: string;
            readonly maxEntries: ProviderWorkspaceMaxEntries;
          }) =>
            Effect.sync(() => {
              calls.push({
                provider,
                operation: "listDirectory",
                root,
                relativePath,
                maxEntries,
              });
              return {
                entries: [{ name: `${provider}.txt`, kind: "file" as const }],
                truncated: true,
              };
            }),
          readFile: ({
            relativePath,
            maxBytes,
          }: {
            readonly relativePath: string;
            readonly maxBytes: ProviderWorkspaceReadByteLimit;
          }) =>
            Effect.sync(() => {
              calls.push({
                provider,
                operation: "readFile",
                root,
                relativePath,
                maxBytes,
              });
              const bytes = new TextEncoder().encode(provider);
              return { bytes, byteLength: bytes.byteLength, truncated: false };
            }),
        }),
    });
    const projects = new Map([
      [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
      [projectB, projectShell({ id: projectB, providerInstanceId: providerB })],
    ]);
    const instances = new Map([
      [providerA, providerInstance(providerA, makeWorkspace("a", "file"))],
      [providerB, providerInstance(providerB, makeWorkspace("b", "directory"))],
    ]);

    return Effect.gen(function* () {
      const workspace = yield* ProjectWorkspace.ProjectWorkspace;
      const metadataA = yield* workspace.getMetadata({
        target: {
          projectId: projectA,
          workspaceRoot: "/gateway/or/attacker/selected",
        },
        relativePath: "src/index.ts",
        // Runtime callers cannot override the persisted root; unknown input
        // fields are deliberately ignored by this internal service API.
      } as Parameters<typeof workspace.getMetadata>[0]);
      const metadataB = yield* workspace.getMetadata({
        target: { projectId: projectB },
        relativePath: "src",
      });
      const listing = yield* workspace.listDirectory({
        target: { projectId: projectA },
        relativePath: "src",
        maxEntries: ProviderWorkspaceMaxEntries.make(1),
      });
      const read = yield* workspace.readFile({
        target: { projectId: projectA },
        relativePath: "README.md",
        maxBytes: ProviderWorkspaceReadByteLimit.make(16),
      });

      assert.strictEqual(metadataA.kind, "file");
      assert.strictEqual(metadataB.kind, "directory");
      assert.deepStrictEqual(listing, {
        entries: [{ name: "a.txt", kind: "file" }],
        truncated: true,
      });
      assert.strictEqual(new TextDecoder().decode(read.bytes), "a");
      assert.deepStrictEqual(calls, [
        {
          provider: "a",
          operation: "getMetadata",
          root: sharedRoot,
          relativePath: "src/index.ts",
        },
        { provider: "b", operation: "getMetadata", root: sharedRoot, relativePath: "src" },
        {
          provider: "a",
          operation: "listDirectory",
          root: sharedRoot,
          relativePath: "src",
          maxEntries: 1,
        },
        {
          provider: "a",
          operation: "readFile",
          root: sharedRoot,
          relativePath: "README.md",
          maxBytes: 16,
        },
      ]);
    }).pipe(Effect.provide(testLayer({ projects, instances })));
  },
);

it.effect("validates only the persisted root and does not expose a root handle", () => {
  const openedRoots: Array<string> = [];
  const workspace: ProviderWorkspaceAdapter = {
    openRoot: (root) =>
      Effect.sync(() => {
        openedRoots.push(root);
        return {
          getMetadata: () => Effect.die("unused"),
          listDirectory: () => Effect.die("unused"),
          readFile: () => Effect.die("unused"),
        };
      }),
  };
  const projects = new Map([
    [
      projectA,
      projectShell({
        id: projectA,
        providerInstanceId: providerA,
        workspaceRoot: "/provider/canonical-root",
      }),
    ],
  ]);
  const instances = new Map([[providerA, providerInstance(providerA, workspace)]]);

  return Effect.gen(function* () {
    const service = yield* ProjectWorkspace.ProjectWorkspace;
    const result = yield* service.validateRoot({ projectId: projectA });
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(openedRoots, ["/provider/canonical-root"]);
  }).pipe(Effect.provide(testLayer({ projects, instances })));
});

it.effect("reports missing project, provider, and workspace capability distinctly", () => {
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: missingProvider })],
    [projectB, projectShell({ id: projectB, providerInstanceId: providerB })],
  ]);
  const instances = new Map([[providerB, providerInstance(providerB)]]);

  return Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace.ProjectWorkspace;
    const projectError = yield* workspace
      .validateRoot({ projectId: missingProject })
      .pipe(Effect.flip);
    const providerError = yield* workspace.validateRoot({ projectId: projectA }).pipe(Effect.flip);
    const capabilityError = yield* workspace
      .validateRoot({ projectId: projectB })
      .pipe(Effect.flip);

    assert.strictEqual(projectError._tag, "ProjectWorkspaceProjectNotFoundError");
    assert.strictEqual(providerError._tag, "ProjectWorkspaceProviderNotFoundError");
    assert.strictEqual(capabilityError._tag, "ProjectWorkspaceCapabilityUnavailableError");
    if (providerError._tag === "ProjectWorkspaceProviderNotFoundError") {
      assert.strictEqual(providerError.providerInstanceId, missingProvider);
    }
  }).pipe(Effect.provide(testLayer({ projects, instances })));
});

it.effect("reports a disabled provider instance as unavailable before capability lookup", () => {
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const instances = new Map([[providerA, providerInstance(providerA, undefined, false)]]);

  return Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace.ProjectWorkspace;
    const error = yield* workspace.validateRoot({ projectId: projectA }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProjectWorkspaceProviderUnavailableError");
    if (error._tag === "ProjectWorkspaceProviderUnavailableError") {
      assert.strictEqual(error.providerInstanceId, providerA);
      assert.strictEqual(error.reason, "disabled");
    }
  }).pipe(Effect.provide(testLayer({ projects, instances })));
});

it.effect("normalizes projection lookup failures as project resolution operations", () => {
  const cause = new PersistenceSqlError({ operation: "test.query" });
  return Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace.ProjectWorkspace;
    const error = yield* workspace.validateRoot({ projectId: projectA }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProjectWorkspaceResolveOperationError");
    if (error._tag === "ProjectWorkspaceResolveOperationError") {
      assert.strictEqual(error.projectId, projectA);
      assert.strictEqual(error.operation, "resolveProject");
      assert.strictEqual(error.cause, cause);
    }
  }).pipe(
    Effect.provide(
      testLayer({
        getProjectShellById: () => Effect.fail(cause),
      }),
    ),
  );
});

it.effect("preserves normalized provider workspace failure categories", () => {
  const errors: ReadonlyArray<ProviderWorkspaceError> = [
    new ProviderWorkspaceDisconnectedError({
      providerInstanceId: providerA,
      operation: "getMetadata",
    }),
    new ProviderWorkspaceProtocolError({
      providerInstanceId: providerA,
      operation: "getMetadata",
      detail: "invalid response",
    }),
    new ProviderWorkspaceUnsupportedError({
      providerInstanceId: providerA,
      operation: "getMetadata",
    }),
    new ProviderWorkspacePathError({
      providerInstanceId: providerA,
      operation: "getMetadata",
      path: "../outside",
      issue: "outside root",
    }),
    new ProviderWorkspaceOperationError({
      providerInstanceId: providerA,
      operation: "getMetadata",
      detail: "remote filesystem rejected the request",
    }),
  ];
  let errorIndex = 0;
  const providerWorkspace: ProviderWorkspaceAdapter = {
    openRoot: () =>
      Effect.succeed({
        getMetadata: () => Effect.fail(errors[errorIndex++]!),
        listDirectory: () => Effect.die("unused"),
        readFile: () => Effect.die("unused"),
      }),
  };
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const instances = new Map([[providerA, providerInstance(providerA, providerWorkspace)]]);

  return Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace.ProjectWorkspace;
    for (const expected of errors) {
      const actual = yield* workspace
        .getMetadata({ target: { projectId: projectA }, relativePath: "." })
        .pipe(Effect.flip);
      assert.strictEqual(actual, expected);
    }
  }).pipe(Effect.provide(testLayer({ projects, instances })));
});

it.effect("routes a verified thread to its provider-owned worktree root", () => {
  const openedRoots: Array<string> = [];
  const providerWorkspace: ProviderWorkspaceAdapter = {
    openRoot: (root) =>
      Effect.sync(() => {
        openedRoots.push(root);
        return {
          getMetadata: () => Effect.succeed({ kind: "directory" as const }),
          listDirectory: () => Effect.succeed({ entries: [], truncated: false }),
          readFile: () => Effect.die("unused"),
        };
      }),
  };
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const threads = new Map([
    [threadA, threadShell({ id: threadA, projectId: projectA, worktreePath: "/srv/worktrees/a" })],
  ]);
  const instances = new Map([[providerA, providerInstance(providerA, providerWorkspace)]]);

  return Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace.ProjectWorkspace;
    yield* workspace.getMetadata({
      target: { projectId: projectA, threadId: threadA },
      relativePath: ".",
    });
    assert.deepStrictEqual(openedRoots, ["/srv/worktrees/a"]);
  }).pipe(Effect.provide(testLayer({ projects, threads, instances })));
});

it.effect("rejects missing threads and project/thread ownership mismatches", () => {
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const threads = new Map([
    [threadB, threadShell({ id: threadB, projectId: projectB, worktreePath: "/srv/worktrees/b" })],
  ]);

  return Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace.ProjectWorkspace;
    const missing = yield* workspace
      .validateRoot({ projectId: projectA, threadId: missingThread })
      .pipe(Effect.flip);
    const mismatch = yield* workspace
      .validateRoot({ projectId: projectA, threadId: threadB })
      .pipe(Effect.flip);

    assert.strictEqual(missing._tag, "ProjectWorkspaceThreadNotFoundError");
    assert.strictEqual(mismatch._tag, "ProjectWorkspaceThreadProjectMismatchError");
    if (mismatch._tag === "ProjectWorkspaceThreadProjectMismatchError") {
      assert.strictEqual(mismatch.actualProjectId, projectB);
    }
  }).pipe(Effect.provide(testLayer({ projects, threads })));
});
