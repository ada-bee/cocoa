import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  MOBILE_REPOSITORY_REF_LIMIT,
  MOBILE_REPOSITORY_REVIEW_BYTE_LIMIT,
  MOBILE_REPOSITORY_STATUS_PATH_LIMIT,
  presentRepositoryRefs,
  presentRepositoryReviewSources,
  presentRepositoryStatus,
  repositoryListRefsInput,
  repositoryReviewDiffInput,
  repositoryStatusInput,
} from "./repository-read";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

describe("mobile repository reads", () => {
  it("targets persisted project and thread identities with explicit bounds", () => {
    expect(repositoryStatusInput(projectId, threadId)).toEqual({
      target: { projectId, threadId },
      maxChangedPaths: MOBILE_REPOSITORY_STATUS_PATH_LIMIT,
    });
    expect(repositoryListRefsInput({ projectId, threadId, query: "feature" })).toEqual({
      target: { projectId, threadId },
      scope: "all",
      query: "feature",
      maxRefs: MOBILE_REPOSITORY_REF_LIMIT,
    });
    expect(repositoryReviewDiffInput(projectId, threadId)).toEqual({
      target: { projectId, threadId },
      ignoreWhitespace: false,
      maxBytes: MOBILE_REPOSITORY_REVIEW_BYTE_LIMIT,
    });

    expect(repositoryStatusInput(projectId, threadId)).not.toHaveProperty("cwd");
    expect(repositoryListRefsInput({ projectId })).not.toHaveProperty("cwd");
    expect(repositoryReviewDiffInput(projectId, threadId)).not.toHaveProperty("cwd");
  });

  it("presents bounded repository status to the existing mobile controls", () => {
    const status = presentRepositoryStatus({
      _tag: "Repository",
      head: { _tag: "Branch", name: "main", commit: "abc123" },
      defaultRef: "main",
      upstreamRef: "origin/main",
      aheadCount: 2,
      behindCount: 1,
      hasPrimaryRemote: true,
      hasWorkingTreeChanges: true,
      changedPaths: [
        {
          path: "src/app.ts",
          kind: "modified",
          staged: false,
          unstaged: true,
          additions: 4,
          deletions: null,
        },
        {
          path: "src/known.ts",
          kind: "modified",
          staged: false,
          unstaged: true,
          additions: 3,
          deletions: 2,
        },
      ],
      truncated: false,
    });

    expect(status).toMatchObject({
      isRepo: true,
      refName: "main",
      isDefaultRef: true,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      workingTree: {
        files: [{ path: "src/known.ts", insertions: 3, deletions: 2 }],
        insertions: 3,
        deletions: 2,
      },
    });
  });

  it("presents provider refs without inventing worktree paths", () => {
    const refs = presentRepositoryRefs({
      _tag: "Repository",
      refs: [
        { kind: "local", name: "main", target: "abc123", current: true, isDefault: true },
        {
          kind: "knownRemote",
          name: "origin/main",
          target: "abc123",
          current: false,
          isDefault: true,
        },
      ],
      truncated: false,
    });

    expect(refs?.refs).toEqual([
      {
        name: "main",
        isRemote: false,
        current: true,
        isDefault: true,
        worktreePath: null,
      },
      {
        name: "origin/main",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: true,
        worktreePath: null,
      },
    ]);
  });

  it("presents repository review sources without changing bounded patches", () => {
    const sources = presentRepositoryReviewSources(
      {
        _tag: "Repository",
        sources: [
          {
            kind: "workingTree",
            baseRef: null,
            headRef: "HEAD",
            patch: "diff --git a/app.ts b/app.ts\n",
            byteLength: 31,
            truncated: false,
          },
        ],
        truncated: false,
      },
      (diff) => `hash:${diff.length}`,
    );

    expect(sources).toEqual([
      {
        id: "git:working-tree",
        kind: "working-tree",
        title: "Dirty worktree",
        baseRef: null,
        headRef: "HEAD",
        diff: "diff --git a/app.ts b/app.ts\n",
        diffHash: "hash:29",
        truncated: false,
      },
    ]);
  });
});
