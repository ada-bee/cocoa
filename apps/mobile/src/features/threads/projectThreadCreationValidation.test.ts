import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";

import {
  ProjectThreadProviderMismatchError,
  validateProjectThreadCreation,
} from "./projectThreadCreationValidation";

describe("project thread creation validation", () => {
  it("rejects a model from a different provider before submission", () => {
    const error = validateProjectThreadCreation({
      environmentId: EnvironmentId.make("gateway"),
      projectId: ProjectId.make("project-macbook"),
      projectProviderInstanceId: ProviderInstanceId.make("codex-macbook"),
      modelProviderInstanceId: ProviderInstanceId.make("codex-linux"),
      environmentMode: "local",
      branch: null,
      initialMessageText: "Implement the task",
    });

    expect(error).toEqual(
      new ProjectThreadProviderMismatchError({
        environmentId: EnvironmentId.make("gateway"),
        projectId: ProjectId.make("project-macbook"),
        projectProviderInstanceId: ProviderInstanceId.make("codex-macbook"),
        modelProviderInstanceId: ProviderInstanceId.make("codex-linux"),
      }),
    );
  });

  it("accepts a model owned by the selected project provider", () => {
    expect(
      validateProjectThreadCreation({
        environmentId: EnvironmentId.make("gateway"),
        projectId: ProjectId.make("project-macbook"),
        projectProviderInstanceId: ProviderInstanceId.make("codex-macbook"),
        modelProviderInstanceId: ProviderInstanceId.make("codex-macbook"),
        environmentMode: "local",
        branch: null,
        initialMessageText: "Implement the task",
      }),
    ).toBeNull();
  });
});
