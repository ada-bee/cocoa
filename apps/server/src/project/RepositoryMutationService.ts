/** Provider-routed repository mutations keyed by durable project/thread identity. */
import {
  GitCommandError,
  type RepositoryReadTarget,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsPullInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectRepository from "./ProjectRepository.ts";

type MutationInput = {
  readonly cwd: string;
  readonly target?: RepositoryReadTarget | undefined;
};

export interface RepositoryMutationServiceShape {
  readonly pull: (input: VcsPullInput) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly createWorktree: (
    input: VcsCreateWorktreeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  readonly createRef: (
    input: VcsCreateRefInput,
  ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
  readonly switchRef: (
    input: VcsSwitchRefInput,
  ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
}

export class RepositoryMutationService extends Context.Service<
  RepositoryMutationService,
  RepositoryMutationServiceShape
>()("t3/project/RepositoryMutationService") {}

function mutationError(operation: string, input: MutationInput, detail: string) {
  return new GitCommandError({
    operation,
    command: "git",
    cwd: input.cwd,
    detail,
  });
}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectRepository.ProjectRepository;

  const resolve = (operation: string, input: MutationInput) =>
    input.target === undefined
      ? Effect.fail(
          mutationError(
            operation,
            input,
            "A durable project target is required for provider-host repository mutations.",
          ),
        )
      : projects
          .resolve({
            projectId: input.target.projectId,
            ...(input.target.threadId === undefined ? {} : { threadId: input.target.threadId }),
          })
          .pipe(
            Effect.mapError(() =>
              mutationError(
                operation,
                input,
                "The provider-host repository could not be resolved.",
              ),
            ),
          );

  const unsupported = (operation: string, input: MutationInput) =>
    mutationError(operation, input, "This provider host does not support the requested mutation.");

  const pull: RepositoryMutationServiceShape["pull"] = Effect.fn("RepositoryMutationService.pull")(
    function* (input) {
      const repository = yield* resolve("vcs.pull", input);
      if (repository.pull === undefined) return yield* unsupported("vcs.pull", input);
      return yield* repository
        .pull()
        .pipe(
          Effect.mapError(() =>
            mutationError("vcs.pull", input, "The provider host could not pull this branch."),
          ),
        );
    },
  );

  const createWorktree: RepositoryMutationServiceShape["createWorktree"] = Effect.fn(
    "RepositoryMutationService.createWorktree",
  )(function* (input) {
    const repository = yield* resolve("vcs.createWorktree", input);
    if (repository.createWorktree === undefined) {
      return yield* unsupported("vcs.createWorktree", input);
    }
    return yield* repository
      .createWorktree({
        refName: input.refName,
        ...(input.newRefName === undefined ? {} : { newRefName: input.newRefName }),
        ...(input.baseRefName === undefined ? {} : { baseRefName: input.baseRefName }),
        path: input.path,
      })
      .pipe(
        Effect.mapError(() =>
          mutationError(
            "vcs.createWorktree",
            input,
            "The provider host could not create this worktree.",
          ),
        ),
      );
  });

  const removeWorktree: RepositoryMutationServiceShape["removeWorktree"] = Effect.fn(
    "RepositoryMutationService.removeWorktree",
  )(function* (input) {
    const repository = yield* resolve("vcs.removeWorktree", input);
    if (repository.removeWorktree === undefined) {
      return yield* unsupported("vcs.removeWorktree", input);
    }
    return yield* repository
      .removeWorktree({ path: input.path, force: input.force ?? false })
      .pipe(
        Effect.mapError(() =>
          mutationError(
            "vcs.removeWorktree",
            input,
            "The provider host could not remove this worktree.",
          ),
        ),
      );
  });

  const createRef: RepositoryMutationServiceShape["createRef"] = Effect.fn(
    "RepositoryMutationService.createRef",
  )(function* (input) {
    const repository = yield* resolve("vcs.createRef", input);
    if (repository.createRef === undefined) return yield* unsupported("vcs.createRef", input);
    return yield* repository
      .createRef({ refName: input.refName, switchRef: input.switchRef ?? false })
      .pipe(
        Effect.mapError(() =>
          mutationError("vcs.createRef", input, "The provider host could not create this branch."),
        ),
      );
  });

  const switchRef: RepositoryMutationServiceShape["switchRef"] = Effect.fn(
    "RepositoryMutationService.switchRef",
  )(function* (input) {
    const repository = yield* resolve("vcs.switchRef", input);
    if (repository.switchRef === undefined) return yield* unsupported("vcs.switchRef", input);
    return yield* repository
      .switchRef({ refName: input.refName })
      .pipe(
        Effect.mapError(() =>
          mutationError("vcs.switchRef", input, "The provider host could not switch this branch."),
        ),
      );
  });

  return RepositoryMutationService.of({
    pull,
    createWorktree,
    removeWorktree,
    createRef,
    switchRef,
  });
});

export const layer = Layer.effect(RepositoryMutationService, make);
