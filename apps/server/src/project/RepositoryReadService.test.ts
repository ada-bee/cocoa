import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RepositoryRefLimit,
  RepositoryReviewByteLimit,
  RepositoryStatusPathLimit,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type ProviderVcsRepository,
  ProviderVcsDisconnectedError,
  ProviderVcsOperationError,
  ProviderVcsPathError,
  ProviderVcsProtocolError,
  ProviderVcsUnsupportedError,
} from "../provider/ProviderVcsAdapter.ts";
import * as ProjectRepository from "./ProjectRepository.ts";
import * as RepositoryReadService from "./RepositoryReadService.ts";

const projectId = ProjectId.make("project-read");
const threadId = ThreadId.make("thread-read");
const providerInstanceId = ProviderInstanceId.make("provider-read");
const target = { projectId, threadId } as const;

function repository(overrides: Partial<ProviderVcsRepository> = {}): ProviderVcsRepository {
  return {
    identity: {
      kind: "git",
      rootPath: "/remote/project",
      commonDirectoryPath: "/remote/project/.git",
    },
    capabilities: { status: true, refs: true, remotes: true, reviewDiff: true },
    getStatus: () =>
      Effect.succeed({
        head: { _tag: "Branch", name: "main", commit: "a".repeat(40) },
        defaultRef: null,
        upstreamRef: "origin/main",
        aheadCount: 1,
        behindCount: 2,
        hasPrimaryRemote: true,
        hasWorkingTreeChanges: true,
        changedPaths: [
          {
            path: "src/a.ts",
            kind: "modified",
            staged: false,
            unstaged: true,
            additions: null,
            deletions: null,
          },
        ],
        truncated: false,
      }),
    listRefs: () =>
      Effect.succeed({
        refs: [
          {
            kind: "local",
            name: "main",
            target: "a".repeat(40),
            current: true,
            isDefault: false,
          },
        ],
        truncated: false,
      }),
    listRemotes: () => Effect.succeed({ remotes: [], truncated: false }),
    getReviewDiff: () =>
      Effect.succeed({
        sources: [
          {
            kind: "workingTree",
            baseRef: null,
            headRef: "HEAD",
            patch: "diff",
            byteLength: 4,
            truncated: false,
          },
        ],
        truncated: false,
      }),
    ...overrides,
  };
}

function layer(resolve: ProjectRepository.ProjectRepositoryShape["resolve"]) {
  return RepositoryReadService.layer.pipe(
    Layer.provide(Layer.succeed(ProjectRepository.ProjectRepository, { resolve })),
  );
}

it.effect("forwards durable project/thread identity and maps truthful provider status", () => {
  const targets: Array<ProjectRepository.ProjectRepositoryTarget> = [];
  return Effect.gen(function* () {
    const service = yield* RepositoryReadService.RepositoryReadService;
    const result = yield* service.status({
      target,
      maxChangedPaths: RepositoryStatusPathLimit.make(10),
    });
    assert.strictEqual(result._tag, "Repository");
    if (result._tag === "Repository") {
      assert.deepStrictEqual(result.head, {
        _tag: "Branch",
        name: "main",
        commit: "a".repeat(40),
      });
      assert.strictEqual(result.defaultRef, null);
      assert.strictEqual(result.changedPaths[0]?.additions, null);
      assert.isFalse(result.truncated);
    }
    assert.deepStrictEqual(targets, [target]);
  }).pipe(
    Effect.provide(
      layer((resolvedTarget) => {
        targets.push(resolvedTarget);
        return Effect.succeed(repository());
      }),
    ),
  );
});

it.effect("passes bounded ref and review inputs without cwd or provider reinterpretation", () => {
  const refInputs: Array<unknown> = [];
  const reviewInputs: Array<unknown> = [];
  const handle = repository({
    listRefs: (input) => {
      refInputs.push(input);
      return Effect.succeed({ refs: [], truncated: false });
    },
    getReviewDiff: (input) => {
      reviewInputs.push(input);
      return Effect.succeed({ sources: [], truncated: false });
    },
  });
  return Effect.gen(function* () {
    const service = yield* RepositoryReadService.RepositoryReadService;
    yield* service.listRefs({
      target,
      scope: "knownRemote",
      query: "topic",
      maxRefs: RepositoryRefLimit.make(50),
    });
    yield* service.getReviewDiff({
      target,
      baseRef: "origin/main",
      ignoreWhitespace: true,
      maxBytes: RepositoryReviewByteLimit.make(1_024),
    });
    assert.deepStrictEqual(refInputs, [{ scope: "knownRemote", query: "topic", maxRefs: 50 }]);
    assert.deepStrictEqual(reviewInputs, [
      {
        baseRef: "origin/main",
        ignoreWhitespace: true,
        maxBytes: 1_024,
      },
    ]);
  }).pipe(Effect.provide(layer(() => Effect.succeed(handle))));
});

it.effect("normalizes non-repositories as explicit bounded read results", () =>
  Effect.gen(function* () {
    const service = yield* RepositoryReadService.RepositoryReadService;
    assert.deepStrictEqual(
      yield* service.status({
        target,
        maxChangedPaths: RepositoryStatusPathLimit.make(1),
      }),
      { _tag: "NotRepository" },
    );
    assert.deepStrictEqual(
      yield* service.listRefs({
        target,
        scope: "all",
        maxRefs: RepositoryRefLimit.make(1),
      }),
      { _tag: "NotRepository" },
    );
    assert.deepStrictEqual(
      yield* service.getReviewDiff({
        target,
        ignoreWhitespace: false,
        maxBytes: RepositoryReviewByteLimit.make(1),
      }),
      { _tag: "NotRepository" },
    );
  }).pipe(
    Effect.provide(
      layer(() =>
        Effect.fail(
          new ProjectRepository.ProjectRepositoryNotRepositoryError({
            projectId,
            threadId,
            providerInstanceId,
          }),
        ),
      ),
    ),
  ),
);

it.effect("enforces public result caps even when a provider violates its bound", () => {
  const handle = repository({
    getStatus: () =>
      Effect.succeed({
        head: { _tag: "Unborn" },
        defaultRef: null,
        upstreamRef: null,
        aheadCount: 0,
        behindCount: 0,
        hasPrimaryRemote: false,
        hasWorkingTreeChanges: true,
        changedPaths: ["one", "two"].map((path) => ({
          path,
          kind: "untracked" as const,
          staged: false,
          unstaged: true,
          additions: null,
          deletions: null,
        })),
        truncated: false,
      }),
    listRefs: () =>
      Effect.succeed({
        refs: ["one", "two"].map((name) => ({
          kind: "local" as const,
          name,
          target: "a".repeat(40),
          current: false,
          isDefault: false,
        })),
        truncated: false,
      }),
    getReviewDiff: () =>
      Effect.succeed({
        sources: [
          {
            kind: "workingTree",
            baseRef: null,
            headRef: "HEAD",
            patch: "ééé",
            byteLength: 1,
            truncated: false,
          },
          {
            kind: "baseRange",
            baseRef: "main",
            headRef: "HEAD",
            patch: "overflow",
            byteLength: 8,
            truncated: false,
          },
        ],
        truncated: false,
      }),
  });
  return Effect.gen(function* () {
    const service = yield* RepositoryReadService.RepositoryReadService;
    const status = yield* service.status({
      target,
      maxChangedPaths: RepositoryStatusPathLimit.make(1),
    });
    const refs = yield* service.listRefs({
      target,
      scope: "all",
      maxRefs: RepositoryRefLimit.make(1),
    });
    const review = yield* service.getReviewDiff({
      target,
      ignoreWhitespace: false,
      maxBytes: RepositoryReviewByteLimit.make(5),
    });
    assert.strictEqual(status._tag, "Repository");
    assert.strictEqual(refs._tag, "Repository");
    assert.strictEqual(review._tag, "Repository");
    if (status._tag === "Repository") {
      assert.strictEqual(status.changedPaths.length, 1);
      assert.isTrue(status.truncated);
    }
    if (refs._tag === "Repository") {
      assert.strictEqual(refs.refs.length, 1);
      assert.isTrue(refs.truncated);
    }
    if (review._tag === "Repository") {
      assert.strictEqual(review.sources[0]?.patch, "éé");
      assert.strictEqual(review.sources[0]?.byteLength, 4);
      assert.strictEqual(review.sources[1]?.patch, "o");
      assert.strictEqual(review.sources[1]?.byteLength, 1);
      assert.isTrue(review.truncated);
      assert.isTrue(review.sources.every((source) => source.truncated));
    }
  }).pipe(Effect.provide(layer(() => Effect.succeed(handle))));
});

it.effect("maps every resolver/provider failure to fixed sanitized public errors", () => {
  const errors: ReadonlyArray<{
    readonly error: ProjectRepository.ProjectRepositoryError;
    readonly code: string;
  }> = [
    {
      error: new ProjectRepository.ProjectRepositoryProjectNotFoundError({ projectId }),
      code: "target-not-found",
    },
    {
      error: new ProjectRepository.ProjectRepositoryThreadProjectMismatchError({
        projectId,
        threadId,
        actualProjectId: ProjectId.make("other"),
      }),
      code: "target-mismatch",
    },
    {
      error: new ProviderVcsDisconnectedError({
        providerInstanceId,
        operation: "getStatus",
      }),
      code: "disconnected",
    },
    {
      error: new ProviderVcsUnsupportedError({
        providerInstanceId,
        operation: "getStatus",
      }),
      code: "unsupported",
    },
    {
      error: new ProviderVcsProtocolError({
        providerInstanceId,
        operation: "getStatus",
        detail: "SECRET protocol response",
      }),
      code: "protocol",
    },
    {
      error: new ProviderVcsPathError({
        providerInstanceId,
        operation: "getStatus",
        providerHostPath: "/SECRET/path",
        issue: "SECRET",
      }),
      code: "invalid-path",
    },
    {
      error: new ProviderVcsOperationError({
        providerInstanceId,
        operation: "getStatus",
        detail: "SECRET stderr",
      }),
      code: "operation-failed",
    },
  ];
  return Effect.gen(function* () {
    for (const item of errors) {
      const service = yield* RepositoryReadService.RepositoryReadService.pipe(
        Effect.provide(layer(() => Effect.fail(item.error))),
      );
      const error = yield* Effect.flip(
        service.status({
          target,
          maxChangedPaths: RepositoryStatusPathLimit.make(1),
        }),
      );
      assert.strictEqual(error._tag, "RepositoryReadError");
      assert.strictEqual(error.code, item.code);
      assert.notInclude(error.message, "SECRET");
    }
  });
});

it.effect("does not invoke a read whose repository capability is false", () => {
  let called = false;
  const handle = repository({
    capabilities: { status: false, refs: true, remotes: true, reviewDiff: true },
    getStatus: () => {
      called = true;
      return Effect.die("must not execute");
    },
  });
  return Effect.gen(function* () {
    const service = yield* RepositoryReadService.RepositoryReadService;
    const error = yield* Effect.flip(
      service.status({
        target,
        maxChangedPaths: RepositoryStatusPathLimit.make(1),
      }),
    );
    assert.strictEqual(error.code, "unsupported");
    assert.isFalse(called);
  }).pipe(Effect.provide(layer(() => Effect.succeed(handle))));
});
