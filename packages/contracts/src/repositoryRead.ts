import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

export const REPOSITORY_STATUS_MAX_CHANGED_PATHS = 10_000;
export const REPOSITORY_REFS_MAX_REFS = 10_000;
export const REPOSITORY_REMOTES_MAX_REMOTES = 256;
export const REPOSITORY_REMOTE_NAME_MAX_LENGTH = 256;
export const REPOSITORY_REMOTE_URL_MAX_LENGTH = 4_096;
export const REPOSITORY_REVIEW_MAX_BYTES = 4 * 1024 * 1024;

export const RepositoryReadTarget = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
});
export type RepositoryReadTarget = typeof RepositoryReadTarget.Type;

export const RepositoryReadOperation = Schema.Literals([
  "status",
  "list-refs",
  "list-remotes",
  "review-diff",
]);
export type RepositoryReadOperation = typeof RepositoryReadOperation.Type;

export const RepositoryReadErrorCode = Schema.Literals([
  "target-not-found",
  "target-mismatch",
  "provider-unavailable",
  "not-repository",
  "disconnected",
  "unsupported",
  "protocol",
  "invalid-path",
  "operation-failed",
]);
export type RepositoryReadErrorCode = typeof RepositoryReadErrorCode.Type;

export class RepositoryReadError extends Schema.TaggedErrorClass<RepositoryReadError>()(
  "RepositoryReadError",
  {
    operation: RepositoryReadOperation,
    code: RepositoryReadErrorCode,
    detail: Schema.String.check(Schema.isMaxLength(512)),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Repository read ${this.operation} failed: ${this.detail}`;
  }
}

export const RepositoryNotRepositoryResult = Schema.TaggedStruct("NotRepository", {});
export type RepositoryNotRepositoryResult = typeof RepositoryNotRepositoryResult.Type;

export const RepositoryStatusPathLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(REPOSITORY_STATUS_MAX_CHANGED_PATHS),
);
export type RepositoryStatusPathLimit = typeof RepositoryStatusPathLimit.Type;

export const RepositoryStatusInput = Schema.Struct({
  target: RepositoryReadTarget,
  maxChangedPaths: RepositoryStatusPathLimit,
});
export type RepositoryStatusInput = typeof RepositoryStatusInput.Type;

export const RepositoryStatusHead = Schema.Union([
  Schema.TaggedStruct("Unborn", {}),
  Schema.TaggedStruct("Branch", {
    name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
    commit: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  }),
  Schema.TaggedStruct("Detached", {
    commit: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  }),
]);
export type RepositoryStatusHead = typeof RepositoryStatusHead.Type;

export const RepositoryChangedPathKind = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "other",
]);
export type RepositoryChangedPathKind = typeof RepositoryChangedPathKind.Type;

export const RepositoryChangedPath = Schema.Struct({
  path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  previousPath: Schema.optional(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  ),
  kind: RepositoryChangedPathKind,
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
});
export type RepositoryChangedPath = typeof RepositoryChangedPath.Type;

export const RepositoryStatusRepositoryResult = Schema.TaggedStruct("Repository", {
  head: RepositoryStatusHead,
  defaultRef: Schema.NullOr(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))),
  upstreamRef: Schema.NullOr(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))),
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  hasPrimaryRemote: Schema.Boolean,
  hasWorkingTreeChanges: Schema.Boolean,
  changedPaths: Schema.Array(RepositoryChangedPath).check(
    Schema.isMaxLength(REPOSITORY_STATUS_MAX_CHANGED_PATHS),
  ),
  truncated: Schema.Boolean,
});
export type RepositoryStatusRepositoryResult = typeof RepositoryStatusRepositoryResult.Type;

export const RepositoryStatusResult = Schema.Union([
  RepositoryNotRepositoryResult,
  RepositoryStatusRepositoryResult,
]);
export type RepositoryStatusResult = typeof RepositoryStatusResult.Type;

export const RepositoryStatusStreamEvent = Schema.TaggedStruct("snapshot", {
  status: RepositoryStatusResult,
});
export type RepositoryStatusStreamEvent = typeof RepositoryStatusStreamEvent.Type;

export const RepositoryRefScope = Schema.Literals(["local", "knownRemote", "all"]);
export type RepositoryRefScope = typeof RepositoryRefScope.Type;

export const RepositoryRefLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(REPOSITORY_REFS_MAX_REFS),
);
export type RepositoryRefLimit = typeof RepositoryRefLimit.Type;

export const RepositoryListRefsInput = Schema.Struct({
  target: RepositoryReadTarget,
  scope: RepositoryRefScope,
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  maxRefs: RepositoryRefLimit,
});
export type RepositoryListRefsInput = typeof RepositoryListRefsInput.Type;

export const RepositoryRef = Schema.Struct({
  kind: Schema.Literals(["local", "knownRemote"]),
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  target: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
});
export type RepositoryRef = typeof RepositoryRef.Type;

export const RepositoryListRefsRepositoryResult = Schema.TaggedStruct("Repository", {
  refs: Schema.Array(RepositoryRef).check(Schema.isMaxLength(REPOSITORY_REFS_MAX_REFS)),
  truncated: Schema.Boolean,
});
export type RepositoryListRefsRepositoryResult = typeof RepositoryListRefsRepositoryResult.Type;

export const RepositoryListRefsResult = Schema.Union([
  RepositoryNotRepositoryResult,
  RepositoryListRefsRepositoryResult,
]);
export type RepositoryListRefsResult = typeof RepositoryListRefsResult.Type;

export const RepositoryRemoteLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(REPOSITORY_REMOTES_MAX_REMOTES),
);
export type RepositoryRemoteLimit = typeof RepositoryRemoteLimit.Type;

export const RepositoryListRemotesInput = Schema.Struct({
  target: RepositoryReadTarget,
  maxRemotes: RepositoryRemoteLimit,
});
export type RepositoryListRemotesInput = typeof RepositoryListRemotesInput.Type;

const isUnsafeRemoteCodePoint = (codePoint: number): boolean =>
  codePoint <= 0x1f ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  codePoint === 0x061c ||
  codePoint === 0x200e ||
  codePoint === 0x200f ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2066 && codePoint <= 0x2069);

const isSanitizedRemoteText = (value: string): boolean =>
  value.trim() === value &&
  Array.from(value).every((character) => !isUnsafeRemoteCodePoint(character.codePointAt(0) ?? 0));

const SAFE_REMOTE_PROTOCOLS = new Set(["git:", "http:", "https:", "ssh:"]);

const isSafeRemoteUrl = (value: string): boolean => {
  if (!isSanitizedRemoteText(value) || /\s/u.test(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) {
    try {
      const url = new URL(value);
      return (
        SAFE_REMOTE_PROTOCOLS.has(url.protocol) &&
        url.hostname.length > 0 &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0 &&
        !value.includes("?") &&
        !value.includes("#")
      );
    } catch {
      return false;
    }
  }
  if (/[@?#]/u.test(value)) return false;
  const colon = value.indexOf(":");
  return (
    colon > 0 &&
    colon < value.length - 1 &&
    !value.includes("::") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    /^(?:\[[^\]]+\]|[^:/\\]+):[^@?#\s]+$/u.test(value)
  );
};

const RepositoryRemoteUrl = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(REPOSITORY_REMOTE_URL_MAX_LENGTH),
  Schema.makeFilter(
    (value) =>
      isSafeRemoteUrl(value) ||
      "Repository remote URLs must be credential-redacted network locations.",
  ),
);

export const RepositoryRemote = Schema.Struct({
  name: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(REPOSITORY_REMOTE_NAME_MAX_LENGTH),
    Schema.makeFilter(
      (value) => isSanitizedRemoteText(value) || "Repository remote names must be sanitized text.",
    ),
  ),
  fetchUrl: Schema.optional(RepositoryRemoteUrl),
  pushUrl: Schema.optional(RepositoryRemoteUrl),
});
export type RepositoryRemote = typeof RepositoryRemote.Type;

export const RepositoryListRemotesRepositoryResult = Schema.TaggedStruct("Repository", {
  remotes: Schema.Array(RepositoryRemote).check(Schema.isMaxLength(REPOSITORY_REMOTES_MAX_REMOTES)),
  truncated: Schema.Boolean,
});
export type RepositoryListRemotesRepositoryResult =
  typeof RepositoryListRemotesRepositoryResult.Type;

export const RepositoryListRemotesResult = Schema.Union([
  RepositoryNotRepositoryResult,
  RepositoryListRemotesRepositoryResult,
]);
export type RepositoryListRemotesResult = typeof RepositoryListRemotesResult.Type;

export const RepositoryRevision = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((revision) => {
    if (revision.includes("\0")) return "Repository revisions must not contain NUL bytes.";
    return !revision.startsWith("-") || "Repository revisions must not begin with '-'.";
  }),
);
export type RepositoryRevision = typeof RepositoryRevision.Type;

export const RepositoryReviewByteLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(REPOSITORY_REVIEW_MAX_BYTES),
);
export type RepositoryReviewByteLimit = typeof RepositoryReviewByteLimit.Type;

export const RepositoryReviewDiffInput = Schema.Struct({
  target: RepositoryReadTarget,
  baseRef: Schema.optional(RepositoryRevision),
  ignoreWhitespace: Schema.Boolean,
  maxBytes: RepositoryReviewByteLimit,
});
export type RepositoryReviewDiffInput = typeof RepositoryReviewDiffInput.Type;

export const RepositoryReviewDiffSource = Schema.Struct({
  kind: Schema.Literals(["workingTree", "baseRange"]),
  baseRef: Schema.NullOr(RepositoryRevision),
  headRef: Schema.NullOr(RepositoryRevision),
  patch: Schema.String.check(Schema.isMaxLength(REPOSITORY_REVIEW_MAX_BYTES)),
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type RepositoryReviewDiffSource = typeof RepositoryReviewDiffSource.Type;

export const RepositoryReviewDiffRepositoryResult = Schema.TaggedStruct("Repository", {
  sources: Schema.Array(RepositoryReviewDiffSource).check(Schema.isMaxLength(2)),
  truncated: Schema.Boolean,
});
export type RepositoryReviewDiffRepositoryResult = typeof RepositoryReviewDiffRepositoryResult.Type;

export const RepositoryReviewDiffResult = Schema.Union([
  RepositoryNotRepositoryResult,
  RepositoryReviewDiffRepositoryResult,
]);
export type RepositoryReviewDiffResult = typeof RepositoryReviewDiffResult.Type;
