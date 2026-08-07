import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
  type ProjectGroupingSettings,
} from "./logicalProject";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
  allRemoteMembersAreDesktopLocal: boolean;
}

export interface SidebarProjectPickerEntry {
  /** Stable provider-aware key for menu values and rendered rows. */
  key: string;
  /** Logical project name plus enough endpoint context to identify this member. */
  displayName: string;
  /** Endpoint/environment suffix shown separately where the UI supports it. */
  contextLabel: string | null;
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

export type ResolveProjectProviderDisplayName = (
  project: Pick<SidebarProjectGroupMember, "environmentId" | "providerInstanceId">,
) => string | null;

interface SidebarProjectGroupCandidate {
  readonly logicalKey: string;
  readonly project: Project;
}

function getProjectFreshnessTime(project: Project): number {
  const updatedAtTime = Date.parse(project.updatedAt);
  if (Number.isFinite(updatedAtTime)) {
    return updatedAtTime;
  }
  const createdAtTime = Date.parse(project.createdAt);
  return Number.isFinite(createdAtTime) ? createdAtTime : 0;
}

function shouldReplaceDuplicateMember(input: {
  existingMember: Project;
  candidateMember: Project;
  primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  if (
    input.primaryEnvironmentId !== null &&
    input.existingMember.environmentId !== input.primaryEnvironmentId &&
    input.candidateMember.environmentId === input.primaryEnvironmentId
  ) {
    return true;
  }

  const existingFreshness = getProjectFreshnessTime(input.existingMember);
  const candidateFreshness = getProjectFreshnessTime(input.candidateMember);
  if (candidateFreshness !== existingFreshness) {
    return candidateFreshness > existingFreshness;
  }

  return input.candidateMember.id > input.existingMember.id;
}

function collectProjectWinnersByPhysicalKey(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, SidebarProjectGroupCandidate> {
  const winnersByPhysicalKey = new Map<string, SidebarProjectGroupCandidate>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const existing = winnersByPhysicalKey.get(physicalProjectKey);
    if (!existing) {
      winnersByPhysicalKey.set(physicalProjectKey, { logicalKey, project });
      continue;
    }
    if (
      shouldReplaceDuplicateMember({
        existingMember: existing.project,
        candidateMember: project,
        primaryEnvironmentId: input.primaryEnvironmentId,
      })
    ) {
      winnersByPhysicalKey.set(physicalProjectKey, { logicalKey, project });
    }
  }
  return winnersByPhysicalKey;
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const [physicalProjectKey, winner] of collectProjectWinnersByPhysicalKey(input)) {
    mapping.set(physicalProjectKey, winner.logicalKey);
  }
  return mapping;
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectSnapshot[] {
  const winnersByPhysicalKey = collectProjectWinnersByPhysicalKey(input);
  const groupedMembers = new Map<string, SidebarProjectGroupMember[]>();
  for (const { logicalKey, project } of winnersByPhysicalKey.values()) {
    const member: SidebarProjectGroupMember = {
      ...project,
      physicalProjectKey: derivePhysicalProjectKey(project),
      environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
    };
    const existingMembers = groupedMembers.get(logicalKey);
    if (existingMembers) {
      existingMembers.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  const projectRefsByLogicalKey = new Map<string, ScopedProjectRef[]>();
  const seenProjectRefs = new Set<string>();
  for (const project of input.projects) {
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const logicalKey =
      winnersByPhysicalKey.get(physicalProjectKey)?.logicalKey ??
      deriveLogicalProjectKeyFromSettings(project, input.settings);
    const projectRefKey = `${project.environmentId}:${project.id}`;
    if (seenProjectRefs.has(projectRefKey)) continue;
    seenProjectRefs.add(projectRefKey);

    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const existingRefs = projectRefsByLogicalKey.get(logicalKey);
    if (existingRefs) {
      existingRefs.push(projectRef);
    } else {
      projectRefsByLogicalKey.set(logicalKey, [projectRef]);
    }
  }

  const result: SidebarProjectSnapshot[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    if (seen.has(logicalKey)) {
      continue;
    }
    seen.add(logicalKey);

    const members = groupedMembers.get(logicalKey) ?? [];
    const representative =
      (input.primaryEnvironmentId
        ? members.find((member) => member.environmentId === input.primaryEnvironmentId)
        : null) ?? members[0];
    if (!representative) {
      continue;
    }

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));
    result.push({
      ...representative,
      projectKey: logicalKey,
      displayName:
        members.length > 1
          ? deriveProjectGroupLabel({
              representative,
              members,
            })
          : representative.title,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      memberProjects: members,
      memberProjectRefs: projectRefsByLogicalKey.get(logicalKey) ?? [],
      remoteEnvironmentLabels,
      allRemoteMembersAreDesktopLocal,
    });
  }

  return result;
}

export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
  resolveProviderDisplayName?: ResolveProjectProviderDisplayName;
}) {
  const entries = input.groups.flatMap((group): SidebarProjectPickerEntry[] => {
    const containsPreferredProject = input.preferredProjectRef
      ? group.memberProjectRefs.some(
          (projectRef) =>
            projectRef.environmentId === input.preferredProjectRef?.environmentId &&
            projectRef.projectId === input.preferredProjectRef.projectId,
        )
      : false;
    const preferredProject = containsPreferredProject
      ? (group.memberProjects.find(
          (project) =>
            project.environmentId === input.preferredProjectRef?.environmentId &&
            project.id === input.preferredProjectRef?.projectId,
        ) ??
        group.memberProjects.find(
          (project) => project.environmentId === input.preferredProjectRef?.environmentId,
        ))
      : null;
    const representativeProject =
      preferredProject ??
      group.memberProjects.find(
        (project) => project.environmentId === group.environmentId && project.id === group.id,
      ) ??
      group.memberProjects[0];
    if (!representativeProject) return [];

    const orderedProjects = [
      representativeProject,
      ...group.memberProjects.filter(
        (project) => project.physicalProjectKey !== representativeProject.physicalProjectKey,
      ),
    ];
    const spansEnvironments =
      new Set(group.memberProjects.map((project) => project.environmentId)).size > 1;
    const rawProviderLabels = new Map(
      group.memberProjects.map((project) => [
        project.physicalProjectKey,
        input.resolveProviderDisplayName?.(project)?.trim() || String(project.providerInstanceId),
      ]),
    );
    const providerLabelCounts = new Map<string, number>();
    for (const providerLabel of rawProviderLabels.values()) {
      providerLabelCounts.set(providerLabel, (providerLabelCounts.get(providerLabel) ?? 0) + 1);
    }
    const baseContexts = new Map(
      group.memberProjects.map((project) => {
        const rawProviderLabel = rawProviderLabels.get(project.physicalProjectKey)!;
        const providerLabel =
          (providerLabelCounts.get(rawProviderLabel) ?? 0) > 1
            ? `${rawProviderLabel} (${project.providerInstanceId})`
            : rawProviderLabel;
        const environmentLabel = project.environmentLabel?.trim() || String(project.environmentId);
        return [
          project.physicalProjectKey,
          spansEnvironments ? `${providerLabel} · ${environmentLabel}` : providerLabel,
        ] as const;
      }),
    );
    const contextCounts = new Map<string, number>();
    for (const context of baseContexts.values()) {
      contextCounts.set(context, (contextCounts.get(context) ?? 0) + 1);
    }

    return orderedProjects.map((targetProject) => {
      const baseContext = baseContexts.get(targetProject.physicalProjectKey)!;
      const contextLabel =
        (contextCounts.get(baseContext) ?? 0) > 1
          ? `${baseContext} · ${targetProject.workspaceRoot}`
          : baseContext;
      return {
        key: targetProject.physicalProjectKey,
        displayName:
          group.memberProjects.length > 1
            ? `${group.displayName} — ${contextLabel}`
            : group.displayName,
        contextLabel: group.memberProjects.length > 1 ? contextLabel : null,
        group,
        targetProject,
        isPreferred: targetProject.physicalProjectKey === preferredProject?.physicalProjectKey,
      };
    });
  });
  const preferredIndex = entries.findIndex((entry) => entry.isPreferred);
  if (preferredIndex <= 0) return entries;

  const preferred = entries[preferredIndex]!;
  return [
    preferred,
    ...entries.filter(
      (entry, index) =>
        index !== preferredIndex && entry.group.projectKey === preferred.group.projectKey,
    ),
    ...entries.filter((entry) => entry.group.projectKey !== preferred.group.projectKey),
  ];
}
