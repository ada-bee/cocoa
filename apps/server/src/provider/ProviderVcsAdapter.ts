/**
 * Provider-owned read-only version-control primitives.
 *
 * A driver resolves one provider-host path to a repository handle whose
 * operations remain permanently bound to that repository root and metadata
 * directory. Callers supply typed safety limits, but never another cwd or an
 * argv vector. Read operations are always available through the base handle;
 * checkpoint mutations are exposed only through an optional, separately bound
 * capability.
 *
 * @module provider/ProviderVcsAdapter
 */
import {
  type CodexCheckpointHelperCaptureRequest,
  type CodexCheckpointHelperCaptureResult,
  type CodexCheckpointHelperDeleteRequest,
  type CodexCheckpointHelperDeleteResult,
  type CodexCheckpointHelperDiffRequest,
  type CodexCheckpointHelperDiffResult,
  type CodexCheckpointHelperObserveRequest,
  type CodexCheckpointHelperObserveResult,
  type CodexCheckpointHelperRepositoryBinding,
  type CodexCheckpointHelperRestoreRequest,
  type CodexCheckpointHelperRestoreResult,
  type CodexCheckpointHelperSha256,
  ProviderInstanceId,
  type VcsDriverKind,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ProviderVcsOperation = Schema.Literals([
  "openRepository",
  "getStatus",
  "listRefs",
  "listRemotes",
  "getReviewDiff",
  "captureCheckpoint",
  "diffCheckpoints",
  "restoreCheckpoint",
  "deleteCheckpoints",
  "observeCheckpointOperation",
]);
export type ProviderVcsOperation = typeof ProviderVcsOperation.Type;

export const ProviderVcsReadCapability = Schema.Literals([
  "status",
  "refs",
  "remotes",
  "reviewDiff",
]);
export type ProviderVcsReadCapability = typeof ProviderVcsReadCapability.Type;

export const ProviderVcsCheckpointMutationOperation = Schema.Literals([
  "captureCheckpoint",
  "restoreCheckpoint",
  "deleteCheckpoints",
]);
export type ProviderVcsCheckpointMutationOperation =
  typeof ProviderVcsCheckpointMutationOperation.Type;

/** Closed, generation-specific declaration of the reads implemented by a handle. */
export const ProviderVcsReadCapabilities = Schema.Struct({
  status: Schema.Boolean,
  refs: Schema.Boolean,
  remotes: Schema.Boolean,
  reviewDiff: Schema.Boolean,
});
export type ProviderVcsReadCapabilities = typeof ProviderVcsReadCapabilities.Type;

export const PROVIDER_VCS_MAX_STATUS_PATHS = 10_000;
export const ProviderVcsStatusPathLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_VCS_MAX_STATUS_PATHS),
).pipe(Schema.brand("ProviderVcsStatusPathLimit"));
export type ProviderVcsStatusPathLimit = typeof ProviderVcsStatusPathLimit.Type;

export const PROVIDER_VCS_MAX_REFS = 10_000;
export const ProviderVcsRefLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_VCS_MAX_REFS),
).pipe(Schema.brand("ProviderVcsRefLimit"));
export type ProviderVcsRefLimit = typeof ProviderVcsRefLimit.Type;

export const PROVIDER_VCS_MAX_REMOTES = 256;
export const ProviderVcsRemoteLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_VCS_MAX_REMOTES),
).pipe(Schema.brand("ProviderVcsRemoteLimit"));
export type ProviderVcsRemoteLimit = typeof ProviderVcsRemoteLimit.Type;

export const PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES = 4 * 1024 * 1024;
export const ProviderVcsReviewDiffByteLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES),
).pipe(Schema.brand("ProviderVcsReviewDiffByteLimit"));
export type ProviderVcsReviewDiffByteLimit = typeof ProviderVcsReviewDiffByteLimit.Type;

export const ProviderVcsRefQuery = Schema.String.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("ProviderVcsRefQuery"),
);
export type ProviderVcsRefQuery = typeof ProviderVcsRefQuery.Type;

export const ProviderVcsRevision = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((revision) => {
    if (revision.includes("\0")) return "VCS revisions must not contain NUL bytes.";
    return !revision.startsWith("-") || "VCS revisions must not begin with '-'.";
  }),
).pipe(Schema.brand("ProviderVcsRevision"));
export type ProviderVcsRevision = typeof ProviderVcsRevision.Type;

export const ProviderVcsChangedPathKind = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "other",
]);
export type ProviderVcsChangedPathKind = typeof ProviderVcsChangedPathKind.Type;

export interface ProviderVcsChangedPath {
  /** Normalized repository-relative path. */
  readonly path: string;
  readonly previousPath?: string;
  readonly kind: ProviderVcsChangedPathKind;
  readonly staged: boolean;
  readonly unstaged: boolean;
  /** Null when the provider cannot derive a text line count. */
  readonly additions: number | null;
  /** Null when the provider cannot derive a text line count. */
  readonly deletions: number | null;
}

export type ProviderVcsHead =
  | { readonly _tag: "Unborn" }
  | {
      readonly _tag: "Branch";
      readonly name: string;
      readonly commit: string;
    }
  | {
      readonly _tag: "Detached";
      readonly commit: string;
    };

export interface ProviderVcsStatusResult {
  readonly head: ProviderVcsHead;
  readonly defaultRef: string | null;
  readonly upstreamRef: string | null;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly hasPrimaryRemote: boolean;
  readonly hasWorkingTreeChanges: boolean;
  readonly changedPaths: ReadonlyArray<ProviderVcsChangedPath>;
  /** True when the requested path bound omitted one or more changed paths. */
  readonly truncated: boolean;
}

export const ProviderVcsRefScope = Schema.Literals(["local", "knownRemote", "all"]);
export type ProviderVcsRefScope = typeof ProviderVcsRefScope.Type;

export interface ProviderVcsRef {
  readonly kind: "local" | "knownRemote";
  readonly name: string;
  readonly target: string;
  readonly current: boolean;
  readonly isDefault: boolean;
}

export interface ProviderVcsRefListing {
  readonly refs: ReadonlyArray<ProviderVcsRef>;
  /** True when the requested ref bound omitted one or more matching refs. */
  readonly truncated: boolean;
}

export interface ProviderVcsRemote {
  readonly name: string;
  /** Credential-redacted fetch URL. */
  readonly fetchUrl: string;
  /** Credential-redacted push URL, when it differs from the fetch URL. */
  readonly pushUrl: string | null;
  readonly isPrimary: boolean;
}

export interface ProviderVcsRemoteListing {
  readonly remotes: ReadonlyArray<ProviderVcsRemote>;
  /** True when the requested remote bound omitted one or more remotes. */
  readonly truncated: boolean;
}

export const ProviderVcsReviewDiffSourceKind = Schema.Literals(["workingTree", "baseRange"]);
export type ProviderVcsReviewDiffSourceKind = typeof ProviderVcsReviewDiffSourceKind.Type;

export interface ProviderVcsReviewDiffSource {
  readonly kind: ProviderVcsReviewDiffSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly patch: string;
  /** UTF-8 bytes delivered in patch. */
  readonly byteLength: number;
  readonly truncated: boolean;
}

export interface ProviderVcsReviewDiffResult {
  readonly sources: ReadonlyArray<ProviderVcsReviewDiffSource>;
  /** True when any source or the aggregate byte bound omitted patch bytes. */
  readonly truncated: boolean;
}

export class ProviderVcsDisconnectedError extends Schema.TaggedErrorClass<ProviderVcsDisconnectedError>()(
  "ProviderVcsDisconnectedError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderVcsOperation,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider VCS '${this.providerInstanceId}' is disconnected during ${this.operation}.`;
  }
}

export class ProviderVcsUnsupportedError extends Schema.TaggedErrorClass<ProviderVcsUnsupportedError>()(
  "ProviderVcsUnsupportedError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderVcsOperation,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider VCS '${this.providerInstanceId}' does not support ${this.operation}.`;
  }
}

export class ProviderVcsProtocolError extends Schema.TaggedErrorClass<ProviderVcsProtocolError>()(
  "ProviderVcsProtocolError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderVcsOperation,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider VCS protocol failed for '${this.providerInstanceId}' during ${this.operation}: ${this.detail}`;
  }
}

export class ProviderVcsPathError extends Schema.TaggedErrorClass<ProviderVcsPathError>()(
  "ProviderVcsPathError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderVcsOperation,
    providerHostPath: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider VCS path '${this.providerHostPath}' is invalid for '${this.providerInstanceId}' during ${this.operation}: ${this.issue}`;
  }
}

export class ProviderVcsOperationError extends Schema.TaggedErrorClass<ProviderVcsOperationError>()(
  "ProviderVcsOperationError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderVcsOperation,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider VCS operation failed for '${this.providerInstanceId}' during ${this.operation}: ${this.detail}`;
  }
}

/**
 * A well-framed helper response reported `operation_failed` for restore, so
 * the provider cannot safely claim that the worktree was left unchanged.
 */
export class ProviderVcsCheckpointRestoreIndeterminateError extends Schema.TaggedErrorClass<ProviderVcsCheckpointRestoreIndeterminateError>()(
  "ProviderVcsCheckpointRestoreIndeterminateError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: Schema.Literal("restoreCheckpoint"),
  },
) {
  override get message(): string {
    return `Checkpoint helper reported an indeterminate restore failure for provider VCS '${this.providerInstanceId}'; do not retry automatically.`;
  }
}

/**
 * A checkpoint mutation was dispatched, but transport or provider generation
 * ended before a matching receipt could establish its outcome.
 */
export class ProviderVcsCheckpointOutcomeUnknownError extends Schema.TaggedErrorClass<ProviderVcsCheckpointOutcomeUnknownError>()(
  "ProviderVcsCheckpointOutcomeUnknownError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderVcsCheckpointMutationOperation,
  },
) {
  override get message(): string {
    return `Checkpoint mutation outcome is unknown for provider VCS '${this.providerInstanceId}' during ${this.operation}; observe its receipt before any retry.`;
  }
}

export type ProviderVcsError =
  | ProviderVcsDisconnectedError
  | ProviderVcsUnsupportedError
  | ProviderVcsProtocolError
  | ProviderVcsPathError
  | ProviderVcsOperationError
  | ProviderVcsCheckpointRestoreIndeterminateError
  | ProviderVcsCheckpointOutcomeUnknownError;

export interface ProviderVcsRepositoryIdentity {
  readonly kind: VcsDriverKind;
  /** Canonical worktree root on the provider host. */
  readonly rootPath: string;
  /** Canonical VCS metadata/common directory on the provider host, when applicable. */
  readonly commonDirectoryPath: string | null;
}

type BoundCheckpointInput<Request> = Omit<
  Request,
  "protocol" | "operation" | "gitExecutablePath" | "expectedBinding"
>;

/** Logical capture parameters; transport and repository binding remain provider-owned. */
export type ProviderVcsCheckpointCaptureInput =
  BoundCheckpointInput<CodexCheckpointHelperCaptureRequest>;

/** Logical diff parameters and CCH1 patch bounds for two captured checkpoints. */
export type ProviderVcsCheckpointDiffInput = BoundCheckpointInput<CodexCheckpointHelperDiffRequest>;

/** Logical restore parameters, including the checkpoint OID precondition. */
export type ProviderVcsCheckpointRestoreInput =
  BoundCheckpointInput<CodexCheckpointHelperRestoreRequest>;

/** Bounded atomic checkpoint deletion parameters and OID preconditions. */
export type ProviderVcsCheckpointDeleteInput =
  BoundCheckpointInput<CodexCheckpointHelperDeleteRequest>;

/** Receipt observation parameters used to resolve a disconnected mutation. */
export type ProviderVcsCheckpointObserveInput =
  BoundCheckpointInput<CodexCheckpointHelperObserveRequest>;

/**
 * A provider-normal mutation request prepared without dispatching it.
 *
 * `generationId` identifies the borrowed provider generation and
 * `requestSha256` identifies the exact private provider request captured by
 * `execute`, while the request itself (including provider-host paths) remains
 * inside the adapter. Prepared executions are generation-bound and may be
 * single-use; callers must durably record both fields before executing them.
 */
export interface ProviderVcsPreparedCheckpointMutation<Result> {
  readonly generationId: number;
  readonly requestSha256: CodexCheckpointHelperSha256;
  readonly execute: Effect.Effect<Result, ProviderVcsError>;
}

/**
 * Optional CCH1 capability permanently bound to the same provider repository.
 *
 * The provider creates this only after a successful checkpoint-helper `open`.
 * Implementations reconstruct full CCH1 requests from their configured
 * transport, this immutable binding, and the logical inputs below.
 */
export interface ProviderVcsCheckpointCapability {
  readonly binding: CodexCheckpointHelperRepositoryBinding;
  readonly prepareCapture: (
    input: ProviderVcsCheckpointCaptureInput,
  ) => Effect.Effect<
    ProviderVcsPreparedCheckpointMutation<CodexCheckpointHelperCaptureResult>,
    ProviderVcsError
  >;
  readonly diff: (
    input: ProviderVcsCheckpointDiffInput,
  ) => Effect.Effect<CodexCheckpointHelperDiffResult, ProviderVcsError>;
  readonly prepareRestore: (
    input: ProviderVcsCheckpointRestoreInput,
  ) => Effect.Effect<
    ProviderVcsPreparedCheckpointMutation<CodexCheckpointHelperRestoreResult>,
    ProviderVcsError
  >;
  readonly prepareDelete: (
    input: ProviderVcsCheckpointDeleteInput,
  ) => Effect.Effect<
    ProviderVcsPreparedCheckpointMutation<CodexCheckpointHelperDeleteResult>,
    ProviderVcsError
  >;
  readonly observe: (
    input: ProviderVcsCheckpointObserveInput,
  ) => Effect.Effect<CodexCheckpointHelperObserveResult, ProviderVcsError>;
}

/** Read operations permanently pinned to one provider repository identity. */
export interface ProviderVcsRepository {
  readonly identity: ProviderVcsRepositoryIdentity;
  readonly capabilities: ProviderVcsReadCapabilities;
  /** Absent unless this provider supports the separately versioned CCH1 protocol. */
  readonly checkpoints?: ProviderVcsCheckpointCapability;
  readonly getStatus: (input: {
    readonly maxChangedPaths: ProviderVcsStatusPathLimit;
  }) => Effect.Effect<ProviderVcsStatusResult, ProviderVcsError>;
  readonly listRefs: (input: {
    readonly scope: ProviderVcsRefScope;
    readonly query?: ProviderVcsRefQuery;
    readonly maxRefs: ProviderVcsRefLimit;
  }) => Effect.Effect<ProviderVcsRefListing, ProviderVcsError>;
  readonly listRemotes: (input: {
    readonly maxRemotes: ProviderVcsRemoteLimit;
  }) => Effect.Effect<ProviderVcsRemoteListing, ProviderVcsError>;
  readonly getReviewDiff: (input: {
    readonly baseRef?: ProviderVcsRevision;
    readonly ignoreWhitespace: boolean;
    /** Aggregate UTF-8 patch byte limit across every returned source. */
    readonly maxBytes: ProviderVcsReviewDiffByteLimit;
  }) => Effect.Effect<ProviderVcsReviewDiffResult, ProviderVcsError>;
}

export type ProviderVcsOpenRepositoryResult =
  | {
      /** The path is valid and accessible but is not inside a supported repository. */
      readonly _tag: "NotRepository";
    }
  | {
      readonly _tag: "Repository";
      readonly repository: ProviderVcsRepository;
    };

/** Optional per-instance capability implemented by provider drivers. */
export interface ProviderVcsAdapter {
  /**
   * Resolve a provider-host path once. Path failures use ProviderVcsPathError;
   * a valid non-repository path returns the explicit NotRepository result.
   */
  readonly openRepository: (
    providerHostPath: string,
  ) => Effect.Effect<ProviderVcsOpenRepositoryResult, ProviderVcsError>;
}
