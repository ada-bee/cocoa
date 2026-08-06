import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import type { RepositoryGroup } from "../../lib/repositoryGroups";

export type NewTaskPhysicalProject = {
  readonly key: string;
  readonly project: EnvironmentProject;
};

export function newTaskPhysicalProjectKey(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly providerInstanceId: string;
}): string {
  return `${input.environmentId}:${input.projectId}:${input.providerInstanceId}`;
}

export function newTaskPhysicalProjectKeyFor(project: EnvironmentProject): string {
  return newTaskPhysicalProjectKey({
    environmentId: project.environmentId,
    projectId: project.id,
    providerInstanceId: project.providerInstanceId,
  });
}

/** Preserve every provider-bound project even when the UI groups their repository. */
export function flattenNewTaskPhysicalProjects(
  repositoryGroups: ReadonlyArray<RepositoryGroup>,
): ReadonlyArray<NewTaskPhysicalProject> {
  return repositoryGroups.flatMap((group) =>
    group.projects.map(({ project }) => ({
      key: newTaskPhysicalProjectKeyFor(project),
      project,
    })),
  );
}

export function findNewTaskPhysicalProject(
  projects: ReadonlyArray<EnvironmentProject>,
  key: string | null,
): EnvironmentProject | null {
  if (key === null) return null;
  return projects.find((project) => newTaskPhysicalProjectKeyFor(project) === key) ?? null;
}

export function newTaskProviderLabel(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  project: EnvironmentProject,
): string {
  const instanceId = String(project.providerInstanceId);
  const displayName = serverConfigs
    .get(project.environmentId)
    ?.providers.find((provider) => provider.instanceId === project.providerInstanceId)
    ?.displayName?.trim();
  return displayName && displayName !== instanceId ? `${displayName} · ${instanceId}` : instanceId;
}

export function projectsHostingNewTaskRepository(
  projects: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): ReadonlyArray<EnvironmentProject> {
  if (selectedProject === null) return [];

  const repositoryKey = selectedProject.repositoryIdentity?.canonicalKey ?? null;
  const workspaceBasename = selectedProject.workspaceRoot.split("/").at(-1) || null;
  const projectTitle = selectedProject.title;

  return projects.filter((project) => {
    const candidateRepositoryKey = project.repositoryIdentity?.canonicalKey ?? null;
    if (repositoryKey !== null && candidateRepositoryKey !== null) {
      return candidateRepositoryKey === repositoryKey;
    }
    return (
      (workspaceBasename !== null &&
        project.workspaceRoot.split("/").at(-1) === workspaceBasename) ||
      project.title === projectTitle
    );
  });
}
