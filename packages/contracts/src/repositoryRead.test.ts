import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  REPOSITORY_REFS_MAX_REFS,
  REPOSITORY_REMOTES_MAX_REMOTES,
  REPOSITORY_REMOTE_NAME_MAX_LENGTH,
  REPOSITORY_REMOTE_URL_MAX_LENGTH,
  REPOSITORY_REVIEW_MAX_BYTES,
  REPOSITORY_STATUS_MAX_CHANGED_PATHS,
  RepositoryListRefsInput,
  RepositoryListRefsResult,
  RepositoryListRemotesInput,
  RepositoryListRemotesResult,
  RepositoryReadError,
  RepositoryReadTarget,
  RepositoryReviewDiffInput,
  RepositoryReviewDiffResult,
  RepositoryStatusInput,
  RepositoryStatusResult,
} from "./repositoryRead.ts";

const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema as never)(value) as Schema.Schema.Type<S>;

const expectRejected = <S extends Schema.Top>(schema: S, value: unknown) => {
  expect(() => decode(schema, value)).toThrow();
};

describe("repository read codecs", () => {
  it("decodes durable project and optional thread targets", () => {
    expect(decode(RepositoryReadTarget, { projectId: "project-a" })).toEqual({
      projectId: "project-a",
    });
    expect(decode(RepositoryReadTarget, { projectId: "project-a", threadId: "thread-a" })).toEqual({
      projectId: "project-a",
      threadId: "thread-a",
    });
  });

  it("enforces request bounds and safe revisions", () => {
    expectRejected(RepositoryStatusInput, {
      target: { projectId: "project-a" },
      maxChangedPaths: REPOSITORY_STATUS_MAX_CHANGED_PATHS + 1,
    });
    expectRejected(RepositoryListRefsInput, {
      target: { projectId: "project-a" },
      scope: "all",
      maxRefs: REPOSITORY_REFS_MAX_REFS + 1,
    });
    expectRejected(RepositoryListRemotesInput, {
      target: { projectId: "project-a" },
      maxRemotes: REPOSITORY_REMOTES_MAX_REMOTES + 1,
    });
    expectRejected(RepositoryListRemotesInput, {
      target: { projectId: "project-a" },
      maxRemotes: 0,
    });
    expectRejected(RepositoryReviewDiffInput, {
      target: { projectId: "project-a" },
      baseRef: "-main",
      ignoreWhitespace: false,
      maxBytes: 1,
    });
    expectRejected(RepositoryReviewDiffInput, {
      target: { projectId: "project-a" },
      baseRef: "main\0other",
      ignoreWhitespace: false,
      maxBytes: 1,
    });
    expectRejected(RepositoryReviewDiffInput, {
      target: { projectId: "project-a" },
      ignoreWhitespace: false,
      maxBytes: REPOSITORY_REVIEW_MAX_BYTES + 1,
    });
  });

  it("enforces status and refs result bounds", () => {
    const change = {
      path: "file.ts",
      kind: "modified",
      staged: false,
      unstaged: true,
      additions: null,
      deletions: null,
    };
    expectRejected(RepositoryStatusResult, {
      _tag: "Repository",
      head: { _tag: "Branch", name: "main", commit: "abc" },
      defaultRef: "main",
      upstreamRef: null,
      aheadCount: 0,
      behindCount: 0,
      hasPrimaryRemote: false,
      hasWorkingTreeChanges: true,
      changedPaths: Array.from({ length: REPOSITORY_STATUS_MAX_CHANGED_PATHS + 1 }, () => change),
      truncated: true,
    });
    expectRejected(RepositoryStatusResult, {
      _tag: "Repository",
      head: { _tag: "Unborn" },
      defaultRef: null,
      upstreamRef: null,
      aheadCount: 0,
      behindCount: 0,
      hasPrimaryRemote: false,
      hasWorkingTreeChanges: true,
      changedPaths: [{ ...change, path: "x".repeat(4_097) }],
      truncated: false,
    });
    const ref = {
      kind: "local",
      name: "main",
      target: "abc",
      current: true,
      isDefault: true,
    };
    expectRejected(RepositoryListRefsResult, {
      _tag: "Repository",
      refs: Array.from({ length: REPOSITORY_REFS_MAX_REFS + 1 }, () => ref),
      truncated: true,
    });
    const remote = {
      name: "origin",
      fetchUrl: "https://example.test/owner/repository.git",
    };
    expectRejected(RepositoryListRemotesResult, {
      _tag: "Repository",
      remotes: Array.from({ length: REPOSITORY_REMOTES_MAX_REMOTES + 1 }, () => remote),
      truncated: true,
    });
    expectRejected(RepositoryListRemotesResult, {
      _tag: "Repository",
      remotes: [{ ...remote, name: "x".repeat(REPOSITORY_REMOTE_NAME_MAX_LENGTH + 1) }],
      truncated: false,
    });
    expectRejected(RepositoryListRemotesResult, {
      _tag: "Repository",
      remotes: [{ ...remote, fetchUrl: "x".repeat(REPOSITORY_REMOTE_URL_MAX_LENGTH + 1) }],
      truncated: false,
    });
    expectRejected(RepositoryListRemotesResult, {
      _tag: "Repository",
      remotes: [{ name: "", fetchUrl: "https://example.test/repository.git" }],
      truncated: false,
    });
    expectRejected(RepositoryListRemotesResult, {
      _tag: "Repository",
      remotes: [{ name: "origin", pushUrl: "" }],
      truncated: false,
    });
    for (const fetchUrl of [
      "https://token@example.test/repository.git",
      "https://example.test/repository.git?token=secret",
      "file:///private/workspace",
      "/private/workspace",
      "C:\\private\\workspace",
      "ext::helper command",
    ]) {
      expectRejected(RepositoryListRemotesResult, {
        _tag: "Repository",
        remotes: [{ name: "origin", fetchUrl }],
        truncated: false,
      });
    }
    expectRejected(RepositoryListRemotesResult, {
      _tag: "Repository",
      remotes: [{ name: "origin\n", fetchUrl: "https://example.test/repository.git" }],
      truncated: false,
    });
  });

  it("enforces review source, patch, and error-detail bounds", () => {
    const source = {
      kind: "workingTree",
      baseRef: null,
      headRef: null,
      patch: "",
      byteLength: 0,
      truncated: false,
    };
    expectRejected(RepositoryReviewDiffResult, {
      _tag: "Repository",
      sources: [source, source, source],
      truncated: true,
    });
    expectRejected(RepositoryReviewDiffResult, {
      _tag: "Repository",
      sources: [{ ...source, patch: "x".repeat(REPOSITORY_REVIEW_MAX_BYTES + 1) }],
      truncated: true,
    });
    expectRejected(RepositoryReadError, {
      _tag: "RepositoryReadError",
      operation: "status",
      code: "operation-failed",
      detail: "x".repeat(513),
      retryable: false,
    });
  });
});
