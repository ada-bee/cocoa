import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderVcsRepository } from "../provider/ProviderVcsAdapter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectRepository from "./ProjectRepository.ts";
import * as RepositoryGitActionService from "./RepositoryGitActionService.ts";

const projectId = ProjectId.make("git-actions-project");
const baseRepository = (overrides: Partial<ProviderVcsRepository>): ProviderVcsRepository => ({
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
});

const layer = (repository: ProviderVcsRepository) =>
  RepositoryGitActionService.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectRepository.ProjectRepository, {
        resolve: () => Effect.succeed(repository),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        {} as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("custom message should skip generation"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
        }),
      ),
    ),
  );

it.effect("runs custom-message commit and push against the provider repository", () => {
  const calls: string[] = [];
  const repository = baseRepository({
    prepareCommit: () => {
      calls.push("prepare");
      return Effect.succeed({
        branch: "topic",
        stagedSummary: "M\ta.txt",
        stagedPatch: "patch",
      });
    },
    commit: (input) => {
      calls.push(`commit:${input.subject}:${input.body}`);
      return Effect.succeed({ commitSha: "abcdef123456" });
    },
    listRefs: () => Effect.succeed({ refs: [], truncated: false }),
    push: () => {
      calls.push("push");
      return Effect.succeed({
        status: "pushed",
        branch: "topic",
        upstreamBranch: "origin/topic",
      });
    },
  });
  const progress: string[] = [];

  return Effect.gen(function* () {
    const service = yield* RepositoryGitActionService.RepositoryGitActionService;
    const result = yield* service.run(
      {
        actionId: "action-1",
        cwd: "/untrusted/client/path",
        target: { projectId },
        action: "commit_push",
        commitMessage: "Update a\n\nDetails",
      },
      (event) => Effect.sync(() => progress.push(event.kind)),
    );

    assert.deepStrictEqual(calls, ["prepare", "commit:Update a:Details", "push"]);
    assert.strictEqual(result.commit.status, "created");
    assert.strictEqual(result.push.status, "pushed");
    assert.deepStrictEqual(progress, [
      "action_started",
      "phase_started",
      "phase_started",
      "phase_started",
      "action_finished",
    ]);
  }).pipe(Effect.provide(layer(repository)));
});

it.effect("rejects change-request actions before touching a provider repository", () => {
  let resolved = false;
  const repository = baseRepository({});
  const customLayer = RepositoryGitActionService.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectRepository.ProjectRepository, {
        resolve: () => {
          resolved = true;
          return Effect.succeed(repository);
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        {} as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RepositoryGitActionService.RepositoryGitActionService;
    const error = yield* Effect.flip(
      service.run(
        {
          actionId: "action-2",
          cwd: "/client/path",
          target: { projectId },
          action: "create_pr",
        },
        () => Effect.void,
      ),
    );
    assert.strictEqual(error._tag, "GitManagerError");
    assert.isFalse(resolved);
  }).pipe(Effect.provide(customLayer));
});
