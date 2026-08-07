import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ProviderVcsRepository } from "../provider/ProviderVcsAdapter.ts";
import * as ProjectRepository from "./ProjectRepository.ts";
import * as RepositoryMutationService from "./RepositoryMutationService.ts";

const projectId = ProjectId.make("project-mutation");
const threadId = ThreadId.make("thread-mutation");
const providerInstanceId = ProviderInstanceId.make("provider-mutation");
const target = { projectId, threadId } as const;

function repository(overrides: Partial<ProviderVcsRepository>): ProviderVcsRepository {
  return {
    identity: {
      kind: "git",
      rootPath: "/provider/project",
      commonDirectoryPath: "/provider/project/.git",
    },
    capabilities: { status: true, refs: true, remotes: true, reviewDiff: true },
    getStatus: () => Effect.die("unused"),
    listRefs: () => Effect.die("unused"),
    listRemotes: () => Effect.die("unused"),
    getReviewDiff: () => Effect.die("unused"),
    ...overrides,
  };
}

function layer(resolve: ProjectRepository.ProjectRepositoryShape["resolve"]) {
  return RepositoryMutationService.layer.pipe(
    Layer.provide(Layer.succeed(ProjectRepository.ProjectRepository, { resolve })),
  );
}

it.effect("routes mutations by durable project/thread identity without forwarding cwd", () => {
  const resolvedTargets: Array<ProjectRepository.ProjectRepositoryTarget> = [];
  const providerInputs: Array<unknown> = [];
  const handle = repository({
    createWorktree: (input) => {
      providerInputs.push(input);
      return Effect.succeed({ worktree: { path: "/provider/worktrees/topic", refName: "topic" } });
    },
    switchRef: (input) => {
      providerInputs.push(input);
      return Effect.succeed({ refName: input.refName });
    },
  });

  return Effect.gen(function* () {
    const service = yield* RepositoryMutationService.RepositoryMutationService;
    yield* service.createWorktree({
      cwd: "/untrusted/client/path",
      target,
      refName: "origin/main",
      newRefName: "topic",
      baseRefName: "main",
      path: null,
    });
    yield* service.switchRef({
      cwd: "/another/untrusted/path",
      target,
      refName: "topic",
    });

    assert.deepStrictEqual(resolvedTargets, [target, target]);
    assert.deepStrictEqual(providerInputs, [
      {
        refName: "origin/main",
        newRefName: "topic",
        baseRefName: "main",
        path: null,
      },
      { refName: "topic" },
    ]);
  }).pipe(
    Effect.provide(
      layer((resolvedTarget) => {
        resolvedTargets.push(resolvedTarget);
        return Effect.succeed(handle);
      }),
    ),
  );
});

it.effect("requires a durable target and returns a bounded public error", () => {
  let resolved = false;
  return Effect.gen(function* () {
    const service = yield* RepositoryMutationService.RepositoryMutationService;
    const error = yield* Effect.flip(
      service.createRef({ cwd: "/client/path", refName: "topic", switchRef: true }),
    );
    assert.strictEqual(error._tag, "GitCommandError");
    assert.include(error.detail, "durable project target");
    assert.isFalse(resolved);
  }).pipe(
    Effect.provide(
      layer(() => {
        resolved = true;
        return Effect.die(
          new ProjectRepository.ProjectRepositoryProviderNotFoundError({
            projectId,
            providerInstanceId,
          }),
        );
      }),
    ),
  );
});
