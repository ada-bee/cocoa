import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";
import type {
  ProjectId,
  RepositoryStatusInput,
  RepositoryStatusResult,
  ThreadId,
  VcsStatusResult,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

export function repositoryStatusInput(
  projectId: ProjectId,
  threadId?: ThreadId,
): RepositoryStatusInput {
  return {
    target: { projectId, ...(threadId === undefined ? {} : { threadId }) },
    maxChangedPaths: 1_000,
  };
}

export function repositoryStatusRefName(status: RepositoryStatusResult | null | undefined) {
  return status?._tag === "Repository" && status.head._tag === "Branch" ? status.head.name : null;
}

export function repositoryStatusIsRepository(
  status: RepositoryStatusResult | null | undefined,
): boolean | null {
  return status === null || status === undefined ? null : status._tag === "Repository";
}

/**
 * Compatibility view for the existing mutation UI. Unknown line counts are
 * excluded instead of being presented as zero, and provider/PR metadata stays
 * unavailable because the repository provider did not report it.
 */
export function repositoryStatusForLegacyUi(
  status: RepositoryStatusResult | null | undefined,
): VcsStatusResult | null {
  if (status === null || status === undefined) return null;
  if (status._tag === "NotRepository") {
    return {
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }

  const files = status.changedPaths.flatMap((change) =>
    change.additions === null || change.deletions === null
      ? []
      : [{ path: change.path, insertions: change.additions, deletions: change.deletions }],
  );
  const refName = repositoryStatusRefName(status);
  return {
    isRepo: true,
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: refName !== null && refName === status.defaultRef,
    refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: {
      files,
      insertions: files.reduce((sum, file) => sum + file.insertions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    hasUpstream: status.upstreamRef !== null,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    pr: null,
  };
}
