import { assert, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import {
  type ProviderVcsAdapter,
  ProviderVcsDisconnectedError,
  type ProviderVcsError,
  ProviderVcsOperationError,
  ProviderVcsPathError,
  ProviderVcsProtocolError,
  type ProviderVcsRepository,
  ProviderVcsUnsupportedError,
} from "../provider/ProviderVcsAdapter.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProjectRepository from "./ProjectRepository.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const missingProject = ProjectId.make("missing-project");
const deletedProject = ProjectId.make("deleted-project");
const disabledProject = ProjectId.make("disabled-project");
const providerA = ProviderInstanceId.make("provider-a");
const providerB = ProviderInstanceId.make("provider-b");
const missingProvider = ProviderInstanceId.make("missing-provider");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const threadWithoutWorktree = ThreadId.make("thread-without-worktree");
const missingThread = ThreadId.make("missing-thread");
const sharedRoot = "/provider/shared/repository";

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

function threadShell(input: {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}): OrchestrationThreadShell {
  return input as unknown as OrchestrationThreadShell;
}

function repository(rootPath: string): ProviderVcsRepository {
  return {
    identity: {
      kind: "git",
      rootPath,
      commonDirectoryPath: `${rootPath}/.git`,
    },
    capabilities: {
      status: true,
      refs: true,
      remotes: true,
      reviewDiff: true,
    },
    getStatus: () => Effect.die("unused"),
    listRefs: () => Effect.die("unused"),
    listRemotes: () => Effect.die("unused"),
    getReviewDiff: () => Effect.die("unused"),
  };
}

function providerInstance(input: {
  readonly instanceId: ProviderInstanceId;
  readonly vcs?: ProviderVcsAdapter;
  readonly enabled?: boolean;
}): ProviderInstance {
  return {
    instanceId: input.instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    enabled: input.enabled ?? true,
    ...(input.vcs === undefined ? {} : { vcs: input.vcs }),
  } as unknown as ProviderInstance;
}

function testLayer(input: {
  readonly projects?: ReadonlyMap<ProjectId, OrchestrationProjectShell>;
  readonly threads?: ReadonlyMap<ThreadId, OrchestrationThreadShell>;
  readonly instances?: ReadonlyMap<ProviderInstanceId, ProviderInstance>;
  readonly getProjectShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getProjectShellById"];
  readonly getThreadShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadShellById"];
}) {
  const projects = input.projects ?? new Map();
  const threads = input.threads ?? new Map();
  const instances = input.instances ?? new Map();
  return ProjectRepository.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShellById:
          input.getProjectShellById ??
          ((projectId) => {
            const project = projects.get(projectId);
            return Effect.succeed(project === undefined ? Option.none() : Option.some(project));
          }),
        getThreadShellById:
          input.getThreadShellById ??
          ((threadId) => {
            const thread = threads.get(threadId);
            return Effect.succeed(thread === undefined ? Option.none() : Option.some(thread));
          }),
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
  "routes identical roots through the exact project provider and ignores caller path overrides",
  () => {
    const calls: Array<{ readonly provider: string; readonly path: string }> = [];
    const makeVcs = (provider: string): ProviderVcsAdapter => ({
      openRepository: (path) =>
        Effect.sync(() => {
          calls.push({ provider, path });
          return { _tag: "Repository" as const, repository: repository(`${path}/${provider}`) };
        }),
    });
    const projects = new Map([
      [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
      [projectB, projectShell({ id: projectB, providerInstanceId: providerB })],
    ]);
    const instances = new Map([
      [providerA, providerInstance({ instanceId: providerA, vcs: makeVcs("a") })],
      [providerB, providerInstance({ instanceId: providerB, vcs: makeVcs("b") })],
    ]);

    return Effect.gen(function* () {
      const service = yield* ProjectRepository.ProjectRepository;
      const resolvedA = yield* service.resolve({
        projectId: projectA,
        providerHostPath: "/gateway/or/caller/selected",
      } as Parameters<typeof service.resolve>[0]);
      const resolvedB = yield* service.resolve({ projectId: projectB });

      assert.strictEqual(resolvedA.identity.rootPath, `${sharedRoot}/a`);
      assert.strictEqual(resolvedB.identity.rootPath, `${sharedRoot}/b`);
      assert.deepStrictEqual(calls, [
        { provider: "a", path: sharedRoot },
        { provider: "b", path: sharedRoot },
      ]);
    }).pipe(Effect.provide(testLayer({ projects, instances })));
  },
);

it.effect("prefers a verified thread worktree and falls back to the project root", () => {
  const openedPaths: Array<string> = [];
  const vcs: ProviderVcsAdapter = {
    openRepository: (path) =>
      Effect.sync(() => {
        openedPaths.push(path);
        return { _tag: "Repository", repository: repository(path) };
      }),
  };
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const threads = new Map([
    [threadA, threadShell({ id: threadA, projectId: projectA, worktreePath: "/worktrees/a" })],
    [
      threadWithoutWorktree,
      threadShell({ id: threadWithoutWorktree, projectId: projectA, worktreePath: null }),
    ],
  ]);
  const instances = new Map([[providerA, providerInstance({ instanceId: providerA, vcs })]]);

  return Effect.gen(function* () {
    const service = yield* ProjectRepository.ProjectRepository;
    yield* service.resolve({ projectId: projectA, threadId: threadA });
    yield* service.resolve({ projectId: projectA, threadId: threadWithoutWorktree });
    assert.deepStrictEqual(openedPaths, ["/worktrees/a", sharedRoot]);
  }).pipe(Effect.provide(testLayer({ projects, threads, instances })));
});

it.effect("reports missing or deleted projects, missing threads, and ownership mismatches", () => {
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const threads = new Map([
    [threadB, threadShell({ id: threadB, projectId: projectB, worktreePath: "/worktrees/b" })],
  ]);

  return Effect.gen(function* () {
    const service = yield* ProjectRepository.ProjectRepository;
    const missing = yield* service.resolve({ projectId: missingProject }).pipe(Effect.flip);
    const deleted = yield* service.resolve({ projectId: deletedProject }).pipe(Effect.flip);
    const missingThreadError = yield* service
      .resolve({ projectId: projectA, threadId: missingThread })
      .pipe(Effect.flip);
    const mismatch = yield* service
      .resolve({ projectId: projectA, threadId: threadB })
      .pipe(Effect.flip);

    assert.strictEqual(missing._tag, "ProjectRepositoryProjectNotFoundError");
    assert.strictEqual(deleted._tag, "ProjectRepositoryProjectNotFoundError");
    assert.strictEqual(missingThreadError._tag, "ProjectRepositoryThreadNotFoundError");
    assert.strictEqual(mismatch._tag, "ProjectRepositoryThreadProjectMismatchError");
    if (mismatch._tag === "ProjectRepositoryThreadProjectMismatchError") {
      assert.strictEqual(mismatch.actualProjectId, projectB);
    }
  }).pipe(Effect.provide(testLayer({ projects, threads })));
});

it.effect("distinguishes missing, disabled, and VCS-incapable provider instances", () => {
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: missingProvider })],
    [projectB, projectShell({ id: projectB, providerInstanceId: providerB })],
    [disabledProject, projectShell({ id: disabledProject, providerInstanceId: providerA })],
  ]);
  const instances = new Map([
    [providerA, providerInstance({ instanceId: providerA, enabled: false })],
    [providerB, providerInstance({ instanceId: providerB })],
  ]);

  return Effect.gen(function* () {
    const service = yield* ProjectRepository.ProjectRepository;
    const providerMissing = yield* service.resolve({ projectId: projectA }).pipe(Effect.flip);
    const capabilityMissing = yield* service.resolve({ projectId: projectB }).pipe(Effect.flip);
    const disabled = yield* service.resolve({ projectId: disabledProject }).pipe(Effect.flip);

    assert.strictEqual(providerMissing._tag, "ProjectRepositoryProviderNotFoundError");
    assert.strictEqual(capabilityMissing._tag, "ProjectRepositoryCapabilityUnavailableError");
    assert.strictEqual(disabled._tag, "ProjectRepositoryProviderUnavailableError");
    if (disabled._tag === "ProjectRepositoryProviderUnavailableError") {
      assert.strictEqual(disabled.reason, "disabled");
    }
  }).pipe(Effect.provide(testLayer({ projects, instances })));
});

it.effect("preserves every provider VCS failure without gateway-side reinterpretation", () => {
  const providerErrors: ReadonlyArray<ProviderVcsError> = [
    new ProviderVcsDisconnectedError({
      providerInstanceId: providerA,
      operation: "openRepository",
    }),
    new ProviderVcsUnsupportedError({
      providerInstanceId: providerA,
      operation: "openRepository",
    }),
    new ProviderVcsProtocolError({
      providerInstanceId: providerA,
      operation: "openRepository",
      detail: "invalid response",
    }),
    new ProviderVcsPathError({
      providerInstanceId: providerA,
      operation: "openRepository",
      providerHostPath: sharedRoot,
      issue: "missing directory",
    }),
    new ProviderVcsOperationError({
      providerInstanceId: providerA,
      operation: "openRepository",
      detail: "helper failed",
    }),
  ];
  let errorIndex = 0;
  const vcs: ProviderVcsAdapter = {
    openRepository: () => Effect.fail(providerErrors[errorIndex++]!),
  };
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const instances = new Map([[providerA, providerInstance({ instanceId: providerA, vcs })]]);

  return Effect.gen(function* () {
    const service = yield* ProjectRepository.ProjectRepository;
    for (const expected of providerErrors) {
      const actual = yield* service.resolve({ projectId: projectA }).pipe(Effect.flip);
      assert.strictEqual(actual, expected);
    }
  }).pipe(Effect.provide(testLayer({ projects, instances })));
});

it.effect("normalizes an explicit not-repository result separately", () => {
  const vcs: ProviderVcsAdapter = {
    openRepository: () => Effect.succeed({ _tag: "NotRepository" }),
  };
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const instances = new Map([[providerA, providerInstance({ instanceId: providerA, vcs })]]);

  return Effect.gen(function* () {
    const service = yield* ProjectRepository.ProjectRepository;
    const error = yield* service.resolve({ projectId: projectA }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProjectRepositoryNotRepositoryError");
    if (error._tag === "ProjectRepositoryNotRepositoryError") {
      assert.strictEqual(error.projectId, projectA);
      assert.strictEqual(error.providerInstanceId, providerA);
    }
  }).pipe(Effect.provide(testLayer({ projects, instances })));
});

it.effect("normalizes project and thread projection failures by resolver operation", () => {
  const projectCause = new PersistenceSqlError({ operation: "test.project" });
  const threadCause = new PersistenceSqlError({ operation: "test.thread" });
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);

  return Effect.gen(function* () {
    const projectResolver = yield* ProjectRepository.ProjectRepository.pipe(
      Effect.provide(
        testLayer({
          getProjectShellById: () => Effect.fail(projectCause),
        }),
      ),
    );
    const projectError = yield* projectResolver.resolve({ projectId: projectA }).pipe(Effect.flip);

    const threadResolver = yield* ProjectRepository.ProjectRepository.pipe(
      Effect.provide(
        testLayer({
          projects,
          getThreadShellById: () => Effect.fail(threadCause),
        }),
      ),
    );
    const threadError = yield* threadResolver
      .resolve({ projectId: projectA, threadId: threadA })
      .pipe(Effect.flip);

    assert.strictEqual(projectError._tag, "ProjectRepositoryResolveOperationError");
    assert.strictEqual(threadError._tag, "ProjectRepositoryResolveOperationError");
    if (projectError._tag === "ProjectRepositoryResolveOperationError") {
      assert.strictEqual(projectError.operation, "resolveProject");
      assert.strictEqual(projectError.cause, projectCause);
    }
    if (threadError._tag === "ProjectRepositoryResolveOperationError") {
      assert.strictEqual(threadError.operation, "resolveThread");
      assert.strictEqual(threadError.cause, threadCause);
    }
  });
});

it.effect("requires no gateway filesystem or process service", () => {
  const vcs: ProviderVcsAdapter = {
    openRepository: (path) => Effect.succeed({ _tag: "Repository", repository: repository(path) }),
  };
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const instances = new Map([[providerA, providerInstance({ instanceId: providerA, vcs })]]);

  return Effect.gen(function* () {
    const service = yield* ProjectRepository.ProjectRepository;
    const resolved = yield* service.resolve({ projectId: projectA });
    assert.strictEqual(resolved.identity.rootPath, sharedRoot);
  }).pipe(
    // Supplying only projections and the provider registry proves that the
    // resolver has no FileSystem, Path, process-spawner, or VCS-driver service.
    Effect.provide(testLayer({ projects, instances })),
  );
});
