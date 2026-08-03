import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  REPOSITORY_REFS_MAX_REFS,
  REPOSITORY_REVIEW_MAX_BYTES,
  REPOSITORY_STATUS_MAX_CHANGED_PATHS,
  RepositoryListRefsInput,
  RepositoryListRefsResult,
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
