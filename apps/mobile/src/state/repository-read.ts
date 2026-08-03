import type {
  ProjectId,
  RepositoryListRefsInput,
  RepositoryListRefsResult,
  RepositoryReviewDiffInput,
  RepositoryReviewDiffResult,
  RepositoryRef,
  RepositoryStatusInput,
  RepositoryStatusResult,
  ReviewDiffPreviewSource,
  ThreadId,
  VcsListRefsResult,
  VcsRef,
  VcsStatusResult,
} from "@t3tools/contracts";

export const MOBILE_REPOSITORY_STATUS_PATH_LIMIT = 1_000;
export const MOBILE_REPOSITORY_REF_LIMIT = 100;
export const MOBILE_REPOSITORY_REVIEW_BYTE_LIMIT = 4 * 1024 * 1024;

export function repositoryStatusInput(
  projectId: ProjectId,
  threadId?: ThreadId,
): RepositoryStatusInput {
  return {
    target: { projectId, ...(threadId === undefined ? {} : { threadId }) },
    maxChangedPaths: MOBILE_REPOSITORY_STATUS_PATH_LIMIT,
  };
}

export function repositoryListRefsInput(input: {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId;
  readonly query?: string;
}): RepositoryListRefsInput {
  return {
    target: {
      projectId: input.projectId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    },
    scope: "all",
    ...(input.query === undefined ? {} : { query: input.query }),
    maxRefs: MOBILE_REPOSITORY_REF_LIMIT,
  };
}

export function repositoryReviewDiffInput(
  projectId: ProjectId,
  threadId: ThreadId,
): RepositoryReviewDiffInput {
  return {
    target: { projectId, threadId },
    ignoreWhitespace: false,
    maxBytes: MOBILE_REPOSITORY_REVIEW_BYTE_LIMIT,
  };
}

export function presentRepositoryStatus(
  status: RepositoryStatusResult | null,
): VcsStatusResult | null {
  if (status === null) {
    return null;
  }
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

  const refName = status.head._tag === "Branch" ? status.head.name : null;
  const files = status.changedPaths.flatMap((path) =>
    path.additions === null || path.deletions === null
      ? []
      : [{ path: path.path, insertions: path.additions, deletions: path.deletions }],
  );
  return {
    isRepo: true,
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: refName !== null && status.defaultRef === refName,
    refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: {
      files,
      insertions: files.reduce((total, file) => total + file.insertions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    },
    hasUpstream: status.upstreamRef !== null,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    pr: null,
  };
}

function presentRepositoryRef(ref: RepositoryRef): VcsRef {
  const slash = ref.name.indexOf("/");
  return {
    name: ref.name,
    ...(ref.kind === "knownRemote"
      ? {
          isRemote: true,
          ...(slash > 0 ? { remoteName: ref.name.slice(0, slash) } : {}),
        }
      : { isRemote: false }),
    current: ref.current,
    isDefault: ref.isDefault,
    worktreePath: null,
  };
}

export function presentRepositoryRefs(
  result: RepositoryListRefsResult | null,
): VcsListRefsResult | null {
  if (result === null) {
    return null;
  }
  if (result._tag === "NotRepository") {
    return {
      refs: [],
      isRepo: false,
      hasPrimaryRemote: false,
      nextCursor: null,
      totalCount: 0,
    };
  }
  return {
    refs: result.refs.map(presentRepositoryRef),
    isRepo: true,
    // Ref enumeration does not identify the provider's primary remote.
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: result.refs.length,
  };
}

export function presentRepositoryReviewSources(
  result: RepositoryReviewDiffResult,
  hashDiff: (diff: string) => string,
): ReadonlyArray<ReviewDiffPreviewSource> {
  if (result._tag === "NotRepository") {
    return [];
  }
  return result.sources.map((source) => {
    const kind = source.kind === "workingTree" ? "working-tree" : "branch-range";
    return {
      id: `git:${kind}`,
      kind,
      title: kind === "working-tree" ? "Dirty worktree" : "Branch changes",
      baseRef: source.baseRef,
      headRef: source.headRef,
      diff: source.patch,
      diffHash: hashDiff(source.patch),
      truncated: source.truncated,
    };
  });
}
