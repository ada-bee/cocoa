import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";

import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import {
  findNewTaskPhysicalProject,
  flattenNewTaskPhysicalProjects,
  newTaskPhysicalProjectKeyFor,
  newTaskProviderLabel,
  projectsHostingNewTaskRepository,
} from "./newTaskProjectSelection";

const environmentId = EnvironmentId.make("gateway");
const repositoryIdentity = {
  canonicalKey: "github.com/brbc/cocoa",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "git@github.com:brbc/cocoa.git",
  },
  provider: "github",
  owner: "brbc",
  name: "cocoa",
  displayName: "Cocoa",
};

function project(providerInstanceId: string, projectId: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(projectId),
    providerInstanceId: ProviderInstanceId.make(providerInstanceId),
    title: "Cocoa",
    workspaceRoot: "/workspace/cocoa",
    repositoryIdentity,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make(providerInstanceId),
      model: "gpt-5.6-sol",
    },
    scripts: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
}

describe("new-task physical project selection", () => {
  it("preserves both provider endpoints inside one logical repository group", () => {
    const macbook = project("codex-macbook", "project-macbook");
    const linux = project("codex-linux", "project-linux");
    const repositoryGroups = groupProjectsByRepository({ projects: [macbook, linux], threads: [] });

    expect(repositoryGroups).toHaveLength(1);
    const choices = flattenNewTaskPhysicalProjects(repositoryGroups);
    expect(choices.map((choice) => choice.key)).toEqual([
      "gateway:project-macbook:codex-macbook",
      "gateway:project-linux:codex-linux",
    ]);
    expect(choices.map((choice) => choice.project)).toEqual([macbook, linux]);
  });

  it("switches by the exact environment, project, and provider key", () => {
    const macbook = project("codex-macbook", "project-macbook");
    const linux = project("codex-linux", "project-linux");
    const projects = [macbook, linux];

    expect(projectsHostingNewTaskRepository(projects, macbook)).toEqual(projects);
    expect(findNewTaskPhysicalProject(projects, newTaskPhysicalProjectKeyFor(linux))).toBe(linux);
  });

  it("labels otherwise identical rows with provider display name and instance id", () => {
    const macbook = project("codex-macbook", "project-macbook");
    const configs = new Map([
      [
        environmentId,
        {
          providers: [
            {
              instanceId: ProviderInstanceId.make("codex-macbook"),
              displayName: "MacBook Air",
            },
          ],
        } as unknown as ServerConfig,
      ],
    ]);

    expect(newTaskProviderLabel(configs, macbook)).toBe("MacBook Air · codex-macbook");
  });
});
