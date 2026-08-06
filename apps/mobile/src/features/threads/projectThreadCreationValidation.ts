import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class ProjectThreadTaskRequiredError extends Schema.TaggedErrorClass<ProjectThreadTaskRequiredError>()(
  "ProjectThreadTaskRequiredError",
  {
    environmentId: EnvironmentId,
    projectId: ProjectId,
    environmentMode: Schema.Literals(["local", "worktree"]),
  },
) {
  override get message(): string {
    return "Enter a task before starting the thread.";
  }
}

export class ProjectThreadBaseBranchRequiredError extends Schema.TaggedErrorClass<ProjectThreadBaseBranchRequiredError>()(
  "ProjectThreadBaseBranchRequiredError",
  {
    environmentId: EnvironmentId,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return "Select a base branch before creating a worktree.";
  }
}

export class ProjectThreadProviderMismatchError extends Schema.TaggedErrorClass<ProjectThreadProviderMismatchError>()(
  "ProjectThreadProviderMismatchError",
  {
    environmentId: EnvironmentId,
    projectId: ProjectId,
    projectProviderInstanceId: ProviderInstanceId,
    modelProviderInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return "Choose a model from the selected project's provider.";
  }
}

export const ProjectThreadCreationValidationError = Schema.Union([
  ProjectThreadTaskRequiredError,
  ProjectThreadBaseBranchRequiredError,
  ProjectThreadProviderMismatchError,
]);
export type ProjectThreadCreationValidationError = typeof ProjectThreadCreationValidationError.Type;

export function validateProjectThreadCreation(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectProviderInstanceId: ProviderInstanceId;
  readonly modelProviderInstanceId: ProviderInstanceId;
  readonly environmentMode: "local" | "worktree";
  readonly branch: string | null;
  readonly initialMessageText: string;
}): ProjectThreadCreationValidationError | null {
  if (input.projectProviderInstanceId !== input.modelProviderInstanceId) {
    return new ProjectThreadProviderMismatchError({
      environmentId: input.environmentId,
      projectId: input.projectId,
      projectProviderInstanceId: input.projectProviderInstanceId,
      modelProviderInstanceId: input.modelProviderInstanceId,
    });
  }
  if (input.initialMessageText.trim().length === 0) {
    return new ProjectThreadTaskRequiredError({
      environmentId: input.environmentId,
      projectId: input.projectId,
      environmentMode: input.environmentMode,
    });
  }
  if (input.environmentMode === "worktree" && !input.branch) {
    return new ProjectThreadBaseBranchRequiredError({
      environmentId: input.environmentId,
      projectId: input.projectId,
    });
  }
  return null;
}
