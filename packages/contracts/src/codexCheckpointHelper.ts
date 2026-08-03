/**
 * CCH1: the provider-host checkpoint helper wire protocol.
 *
 * This protocol is intentionally separate from `codexWorkspaceHelper` v1. The
 * workspace helper is read-only, while CCH1 owns narrowly scoped Git ref and
 * worktree mutations on a provider host. As with the workspace helper, one
 * request is passed to one helper process as a base64-encoded UTF-8 JSON argv
 * value. Implementations must reject decoded JSON larger than
 * `CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES` before parsing it and must not
 * emit a response larger than `CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES`.
 *
 * The configured Git executable is an explicit normalized absolute path on
 * every request. `open` resolves a repository and returns descriptor-derived
 * identities for the worktree, linked-worktree Git directory, and Git common
 * directory. Every later repository operation reopens those roots and requires
 * an exact `expectedBinding` match before running Git or touching the worktree.
 *
 * Checkpoint and receipt refs are helper-derived, respectively
 * `refs/cocoa/checkpoints/v1/<checkpointId>` and
 * `refs/cocoa/checkpoint-receipts/v1/<operationId>`. They are never request
 * parameters.
 * Capture records the current tracked, staged, and non-ignored untracked state
 * without changing HEAD, the index, or the worktree. Diff compares two captured
 * checkpoints and returns a bounded Git patch. Restore replaces tracked,
 * staged, and non-ignored untracked state with the checkpoint. Delete removes
 * only the helper-derived checkpoint ref. Implementations must use atomic Git
 * ref transactions for checkpoint and receipt publication.
 *
 * A mutation receipt binds an operation UUID to the SHA-256 of the exact UTF-8
 * request JSON bytes (excluding transport framing such as a trailing newline).
 * Reusing an operation UUID with a different digest is an
 * `operation_id_conflict`. A committed receipt with a matching digest is
 * authoritative and is returned instead of repeating a mutation. After a
 * disconnect callers use `observe`; they must never blindly replay restore. If
 * restore has no observable receipt, its outcome is indeterminate.
 *
 * @module codexCheckpointHelper
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CODEX_CHECKPOINT_HELPER_PROTOCOL = "cocoa.checkpoint.v1" as const;
export const CODEX_CHECKPOINT_HELPER_PROTOCOL_VERSION = 1 as const;
export const CODEX_CHECKPOINT_HELPER_CONFIG_TYPE = "cocoa-checkpoint-helper-v1" as const;
export const CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES = 64 * 1024;
export const CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES = 4 * 1024 * 1024;
export const CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
export const CODEX_CHECKPOINT_HELPER_MAX_PATH_BYTES = 4096;
export const CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX = "refs/cocoa/checkpoints/v1/";
export const CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX = "refs/cocoa/checkpoint-receipts/v1/";
export const CODEX_CHECKPOINT_HELPER_MAX_DELETE_CHECKPOINTS = 256;

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const Protocol = Schema.Literal(CODEX_CHECKPOINT_HELPER_PROTOCOL);

/** Canonical lowercase, non-nil RFC UUID (versions 1 through 8). */
export const CodexCheckpointHelperUuid = Schema.String.check(
  Schema.isUUID(),
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
export type CodexCheckpointHelperUuid = typeof CodexCheckpointHelperUuid.Type;

export const CodexCheckpointHelperOperationId = CodexCheckpointHelperUuid;
export type CodexCheckpointHelperOperationId = typeof CodexCheckpointHelperOperationId.Type;

export const CodexCheckpointHelperCheckpointId = CodexCheckpointHelperUuid;
export type CodexCheckpointHelperCheckpointId = typeof CodexCheckpointHelperCheckpointId.Type;

/** Lowercase SHA-256 hex used for repository fingerprints and request digests. */
export const CodexCheckpointHelperSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type CodexCheckpointHelperSha256 = typeof CodexCheckpointHelperSha256.Type;

/** A full Git object ID. Abbreviated, uppercase, and decorated revisions are rejected. */
export const CodexCheckpointHelperOid = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
);
export type CodexCheckpointHelperOid = typeof CodexCheckpointHelperOid.Type;

/** Canonical-form absolute POSIX path on the provider host. */
export const CodexCheckpointHelperNormalizedAbsolutePath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(CODEX_CHECKPOINT_HELPER_MAX_PATH_BYTES),
  Schema.makeFilter((path) => {
    if (path.includes("\0")) return "Provider-host paths must not contain NUL bytes.";
    if (!path.startsWith("/")) return "Provider-host paths must be absolute POSIX paths.";
    if (path.includes("\\")) return "Provider-host paths must use POSIX '/' separators.";
    if (path === "/") return true;
    if (path.endsWith("/")) return "Provider-host paths must not end with '/'.";
    const components = path.slice(1).split("/");
    return (
      components.every(
        (component) => component !== "" && component !== "." && component !== "..",
      ) || "Provider-host paths must be normalized without empty, '.' or '..' components."
    );
  }),
);
export type CodexCheckpointHelperNormalizedAbsolutePath =
  typeof CodexCheckpointHelperNormalizedAbsolutePath.Type;

/** Administrator-configured checkpoint helper executable; directories are not accepted. */
export const CodexCheckpointHelperExecutablePath =
  CodexCheckpointHelperNormalizedAbsolutePath.check(
    Schema.makeFilter((path) => path !== "/" || "The helper executable path must name a file."),
  );
export type CodexCheckpointHelperExecutablePath = typeof CodexCheckpointHelperExecutablePath.Type;

/** Fixed, versioned helper configuration; arbitrary argv and shell commands are intentionally absent. */
export const CodexCheckpointHelperConfig = strict(
  Schema.Struct({
    type: Schema.Literal(CODEX_CHECKPOINT_HELPER_CONFIG_TYPE),
    executablePath: CodexCheckpointHelperExecutablePath,
    expectedProtocol: Schema.Literal(CODEX_CHECKPOINT_HELPER_PROTOCOL_VERSION),
  }),
);
export type CodexCheckpointHelperConfig = typeof CodexCheckpointHelperConfig.Type;

/** Administrator-configured Git binary; directories are not accepted. */
export const CodexCheckpointHelperGitExecutablePath =
  CodexCheckpointHelperNormalizedAbsolutePath.check(
    Schema.makeFilter((path) => path !== "/" || "The Git executable path must name a file."),
  );
export type CodexCheckpointHelperGitExecutablePath =
  typeof CodexCheckpointHelperGitExecutablePath.Type;

const FileIdentityComponent = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^(?:0|[1-9][0-9]{0,31})$/),
);

/** Identity obtained from an opened directory, not from path text alone. */
export const CodexCheckpointHelperRootIdentity = strict(
  Schema.Struct({
    canonicalPath: CodexCheckpointHelperNormalizedAbsolutePath,
    device: FileIdentityComponent,
    inode: FileIdentityComponent,
  }),
);
export type CodexCheckpointHelperRootIdentity = typeof CodexCheckpointHelperRootIdentity.Type;

export const CodexCheckpointHelperObjectFormat = Schema.Literals(["sha1", "sha256"]);
export type CodexCheckpointHelperObjectFormat = typeof CodexCheckpointHelperObjectFormat.Type;

/**
 * Strong repository binding. `fingerprint` is the lowercase SHA-256 of the
 * UTF-8 bytes formed by joining the protocol string, then the three roots'
 * canonicalPath/device/inode values in field order, then objectFormat, with a
 * NUL byte after every value (including objectFormat).
 */
export const CodexCheckpointHelperRepositoryBinding = strict(
  Schema.Struct({
    worktreeRoot: CodexCheckpointHelperRootIdentity,
    gitDirectoryRoot: CodexCheckpointHelperRootIdentity,
    gitCommonDirectoryRoot: CodexCheckpointHelperRootIdentity,
    objectFormat: CodexCheckpointHelperObjectFormat,
    fingerprint: CodexCheckpointHelperSha256,
  }),
);
export type CodexCheckpointHelperRepositoryBinding =
  typeof CodexCheckpointHelperRepositoryBinding.Type;

export const CodexCheckpointHelperPatchByteLimit = PositiveInt.check(
  Schema.isLessThanOrEqualTo(CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES),
);
export type CodexCheckpointHelperPatchByteLimit = typeof CodexCheckpointHelperPatchByteLimit.Type;

export const CodexCheckpointHelperDiffLimits = strict(
  Schema.Struct({ maxPatchBytes: CodexCheckpointHelperPatchByteLimit }),
);
export type CodexCheckpointHelperDiffLimits = typeof CodexCheckpointHelperDiffLimits.Type;

export const CodexCheckpointHelperDeleteItem = strict(
  Schema.Struct({
    checkpointId: CodexCheckpointHelperCheckpointId,
    expectedCheckpointOid: CodexCheckpointHelperOid,
  }),
);
export type CodexCheckpointHelperDeleteItem = typeof CodexCheckpointHelperDeleteItem.Type;

export const CodexCheckpointHelperDeleteItems = Schema.NonEmptyArray(
  CodexCheckpointHelperDeleteItem,
).check(
  Schema.isMaxLength(CODEX_CHECKPOINT_HELPER_MAX_DELETE_CHECKPOINTS),
  Schema.makeFilter(
    (items) =>
      new Set(items.map((item) => item.checkpointId)).size === items.length ||
      "A delete batch must not repeat a checkpoint ID.",
  ),
);
export type CodexCheckpointHelperDeleteItems = typeof CodexCheckpointHelperDeleteItems.Type;

const commonRequestFields = {
  protocol: Protocol,
  gitExecutablePath: CodexCheckpointHelperGitExecutablePath,
} as const;

export const CodexCheckpointHelperProbeRequest = strict(
  Schema.Struct({ ...commonRequestFields, operation: Schema.Literal("probe") }),
);
export type CodexCheckpointHelperProbeRequest = typeof CodexCheckpointHelperProbeRequest.Type;

export const CodexCheckpointHelperOpenRequest = strict(
  Schema.Struct({
    ...commonRequestFields,
    operation: Schema.Literal("open"),
    workspaceRoot: CodexCheckpointHelperNormalizedAbsolutePath,
  }),
);
export type CodexCheckpointHelperOpenRequest = typeof CodexCheckpointHelperOpenRequest.Type;

export const CodexCheckpointHelperCaptureRequest = strict(
  Schema.Struct({
    ...commonRequestFields,
    operation: Schema.Literal("capture"),
    operationId: CodexCheckpointHelperOperationId,
    checkpointId: CodexCheckpointHelperCheckpointId,
    expectedBinding: CodexCheckpointHelperRepositoryBinding,
  }),
);
export type CodexCheckpointHelperCaptureRequest = typeof CodexCheckpointHelperCaptureRequest.Type;

export const CodexCheckpointHelperDiffRequest = strict(
  Schema.Struct({
    ...commonRequestFields,
    operation: Schema.Literal("diff"),
    baseCheckpointId: CodexCheckpointHelperCheckpointId,
    targetCheckpointId: CodexCheckpointHelperCheckpointId,
    expectedBinding: CodexCheckpointHelperRepositoryBinding,
    ignoreWhitespace: Schema.Boolean,
    limits: CodexCheckpointHelperDiffLimits,
  }),
);
export type CodexCheckpointHelperDiffRequest = typeof CodexCheckpointHelperDiffRequest.Type;

export const CodexCheckpointHelperRestoreRequest = strict(
  Schema.Struct({
    ...commonRequestFields,
    operation: Schema.Literal("restore"),
    operationId: CodexCheckpointHelperOperationId,
    checkpointId: CodexCheckpointHelperCheckpointId,
    expectedCheckpointOid: CodexCheckpointHelperOid,
    expectedBinding: CodexCheckpointHelperRepositoryBinding,
  }),
);
export type CodexCheckpointHelperRestoreRequest = typeof CodexCheckpointHelperRestoreRequest.Type;

export const CodexCheckpointHelperDeleteRequest = strict(
  Schema.Struct({
    ...commonRequestFields,
    operation: Schema.Literal("delete"),
    operationId: CodexCheckpointHelperOperationId,
    checkpoints: CodexCheckpointHelperDeleteItems,
    expectedBinding: CodexCheckpointHelperRepositoryBinding,
  }),
);
export type CodexCheckpointHelperDeleteRequest = typeof CodexCheckpointHelperDeleteRequest.Type;

export const CodexCheckpointHelperObserveRequest = strict(
  Schema.Struct({
    ...commonRequestFields,
    operation: Schema.Literal("observe"),
    operationId: CodexCheckpointHelperOperationId,
    expectedRequestSha256: CodexCheckpointHelperSha256,
    expectedBinding: CodexCheckpointHelperRepositoryBinding,
  }),
);
export type CodexCheckpointHelperObserveRequest = typeof CodexCheckpointHelperObserveRequest.Type;

export const CodexCheckpointHelperRequest = Schema.Union([
  CodexCheckpointHelperProbeRequest,
  CodexCheckpointHelperOpenRequest,
  CodexCheckpointHelperCaptureRequest,
  CodexCheckpointHelperDiffRequest,
  CodexCheckpointHelperRestoreRequest,
  CodexCheckpointHelperDeleteRequest,
  CodexCheckpointHelperObserveRequest,
]);
export type CodexCheckpointHelperRequest = typeof CodexCheckpointHelperRequest.Type;

export const CodexCheckpointHelperCapability = Schema.Literals([
  "probe",
  "open",
  "capture",
  "diff",
  "restore",
  "delete",
  "observe",
]);
export type CodexCheckpointHelperCapability = typeof CodexCheckpointHelperCapability.Type;

export const CodexCheckpointHelperLimits = strict(
  Schema.Struct({
    maxRequestBytes: Schema.Literal(CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES),
    maxPatchBytes: Schema.Literal(CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES),
    maxResponseBytes: Schema.Literal(CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES),
  }),
);
export type CodexCheckpointHelperLimits = typeof CodexCheckpointHelperLimits.Type;

export const CodexCheckpointHelperProbeResult = strict(
  Schema.Struct({
    operation: Schema.Literal("probe"),
    implementation: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    buildId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
    gitExecutablePath: CodexCheckpointHelperGitExecutablePath,
    capabilities: Schema.Array(CodexCheckpointHelperCapability).check(
      Schema.isMaxLength(7),
      Schema.makeFilter(
        (values) =>
          new Set(values).size === values.length || "Capabilities must not contain duplicates.",
      ),
    ),
    objectFormats: Schema.Array(CodexCheckpointHelperObjectFormat).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(2),
      Schema.makeFilter(
        (values) =>
          new Set(values).size === values.length || "Object formats must not contain duplicates.",
      ),
    ),
    limits: CodexCheckpointHelperLimits,
  }),
);
export type CodexCheckpointHelperProbeResult = typeof CodexCheckpointHelperProbeResult.Type;

export const CodexCheckpointHelperOpenResult = strict(
  Schema.Struct({
    operation: Schema.Literal("open"),
    binding: CodexCheckpointHelperRepositoryBinding,
    headOid: Schema.NullOr(CodexCheckpointHelperOid),
  }),
);
export type CodexCheckpointHelperOpenResult = typeof CodexCheckpointHelperOpenResult.Type;

const CheckpointRefPattern = new RegExp(
  `^${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX.replaceAll("/", "\\/")}[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
);

/** A helper-derived ref. It is output-only and cannot select an arbitrary Git ref. */
export const CodexCheckpointHelperCheckpointRef = Schema.String.check(
  Schema.isMaxLength(CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX.length + 36),
  Schema.isPattern(CheckpointRefPattern),
);
export type CodexCheckpointHelperCheckpointRef = typeof CodexCheckpointHelperCheckpointRef.Type;

const ReceiptRefPattern = new RegExp(
  `^${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX.replaceAll("/", "\\/")}[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
);

/** A helper-derived receipt ref. It is output-only and cannot select an arbitrary Git ref. */
export const CodexCheckpointHelperReceiptRef = Schema.String.check(
  Schema.isMaxLength(CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX.length + 36),
  Schema.isPattern(ReceiptRefPattern),
);
export type CodexCheckpointHelperReceiptRef = typeof CodexCheckpointHelperReceiptRef.Type;

const hasDerivedCheckpointRef = <A extends { checkpointId: string; checkpointRef: string }>(
  value: A,
) =>
  value.checkpointRef === `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${value.checkpointId}` ||
  "The checkpoint ref must be derived from checkpointId.";

const hasDerivedReceiptRef = <A extends { operationId: string; receiptRef: string }>(value: A) =>
  value.receiptRef === `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${value.operationId}` ||
  "The receipt ref must be derived from operationId.";

const receiptCommon = {
  operationId: CodexCheckpointHelperOperationId,
  receiptRef: CodexCheckpointHelperReceiptRef,
  requestSha256: CodexCheckpointHelperSha256,
  repositoryFingerprint: CodexCheckpointHelperSha256,
  status: Schema.Literal("succeeded"),
} as const;

export const CodexCheckpointHelperCaptureReceipt = strict(
  Schema.Struct({
    ...receiptCommon,
    operation: Schema.Literal("capture"),
    checkpointId: CodexCheckpointHelperCheckpointId,
    checkpointRef: CodexCheckpointHelperCheckpointRef,
    checkpointOid: CodexCheckpointHelperOid,
    treeOid: CodexCheckpointHelperOid,
  }).check(Schema.makeFilter(hasDerivedCheckpointRef), Schema.makeFilter(hasDerivedReceiptRef)),
);
export type CodexCheckpointHelperCaptureReceipt = typeof CodexCheckpointHelperCaptureReceipt.Type;

export const CodexCheckpointHelperRestoreReceipt = strict(
  Schema.Struct({
    ...receiptCommon,
    operation: Schema.Literal("restore"),
    checkpointId: CodexCheckpointHelperCheckpointId,
    checkpointRef: CodexCheckpointHelperCheckpointRef,
    checkpointOid: CodexCheckpointHelperOid,
  }).check(Schema.makeFilter(hasDerivedCheckpointRef), Schema.makeFilter(hasDerivedReceiptRef)),
);
export type CodexCheckpointHelperRestoreReceipt = typeof CodexCheckpointHelperRestoreReceipt.Type;

const CodexCheckpointHelperDeletedReceiptItemVariant = Schema.Union([
  strict(
    Schema.Struct({
      checkpointId: CodexCheckpointHelperCheckpointId,
      checkpointRef: CodexCheckpointHelperCheckpointRef,
      status: Schema.Literal("deleted"),
      deletedCheckpointOid: CodexCheckpointHelperOid,
    }),
  ),
  strict(
    Schema.Struct({
      checkpointId: CodexCheckpointHelperCheckpointId,
      checkpointRef: CodexCheckpointHelperCheckpointRef,
      status: Schema.Literal("already_absent"),
    }),
  ),
]);
export const CodexCheckpointHelperDeletedReceiptItem = strict(
  CodexCheckpointHelperDeletedReceiptItemVariant.check(Schema.makeFilter(hasDerivedCheckpointRef)),
);
export type CodexCheckpointHelperDeletedReceiptItem =
  typeof CodexCheckpointHelperDeletedReceiptItem.Type;

export const CodexCheckpointHelperDeleteReceipt = strict(
  Schema.Struct({
    ...receiptCommon,
    operation: Schema.Literal("delete"),
    checkpoints: Schema.NonEmptyArray(CodexCheckpointHelperDeletedReceiptItem).check(
      Schema.isMaxLength(CODEX_CHECKPOINT_HELPER_MAX_DELETE_CHECKPOINTS),
      Schema.makeFilter(
        (items) =>
          new Set(items.map((item) => item.checkpointId)).size === items.length ||
          "A delete receipt must not repeat a checkpoint ID.",
      ),
    ),
  }).check(Schema.makeFilter(hasDerivedReceiptRef)),
);
export type CodexCheckpointHelperDeleteReceipt = typeof CodexCheckpointHelperDeleteReceipt.Type;

export const CodexCheckpointHelperMutationReceipt = Schema.Union([
  CodexCheckpointHelperCaptureReceipt,
  CodexCheckpointHelperRestoreReceipt,
  CodexCheckpointHelperDeleteReceipt,
]);
export type CodexCheckpointHelperMutationReceipt = typeof CodexCheckpointHelperMutationReceipt.Type;

const base64DecodedByteLength = (value: string): number => {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
};

const PatchBase64 = Schema.String.check(
  Schema.isMaxLength(Math.ceil(CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES / 3) * 4),
  Schema.isBase64(),
  Schema.makeFilter(
    (value) =>
      base64DecodedByteLength(value) <= CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES ||
      "Decoded patch exceeds the CCH1 patch byte limit.",
  ),
);

export const CodexCheckpointHelperDiffResult = strict(
  Schema.Struct({
    operation: Schema.Literal("diff"),
    baseCheckpointId: CodexCheckpointHelperCheckpointId,
    targetCheckpointId: CodexCheckpointHelperCheckpointId,
    baseOid: CodexCheckpointHelperOid,
    targetOid: CodexCheckpointHelperOid,
    patchBase64: PatchBase64,
    byteLength: NonNegativeInt.check(
      Schema.isLessThanOrEqualTo(CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES),
    ),
    truncated: Schema.Boolean,
  }).check(
    Schema.makeFilter(
      (result) =>
        base64DecodedByteLength(result.patchBase64) === result.byteLength ||
        "byteLength must equal the decoded patch length.",
    ),
  ),
);
export type CodexCheckpointHelperDiffResult = typeof CodexCheckpointHelperDiffResult.Type;

export const CodexCheckpointHelperCaptureResult = strict(
  Schema.Struct({
    operation: Schema.Literal("capture"),
    receipt: CodexCheckpointHelperCaptureReceipt,
    receiptObjectOid: CodexCheckpointHelperOid,
  }),
);
export type CodexCheckpointHelperCaptureResult = typeof CodexCheckpointHelperCaptureResult.Type;

export const CodexCheckpointHelperRestoreResult = strict(
  Schema.Struct({
    operation: Schema.Literal("restore"),
    receipt: CodexCheckpointHelperRestoreReceipt,
    receiptObjectOid: CodexCheckpointHelperOid,
  }),
);
export type CodexCheckpointHelperRestoreResult = typeof CodexCheckpointHelperRestoreResult.Type;

export const CodexCheckpointHelperDeleteResult = strict(
  Schema.Struct({
    operation: Schema.Literal("delete"),
    receipt: CodexCheckpointHelperDeleteReceipt,
    receiptObjectOid: CodexCheckpointHelperOid,
  }),
);
export type CodexCheckpointHelperDeleteResult = typeof CodexCheckpointHelperDeleteResult.Type;

export const CodexCheckpointHelperObserveResult = Schema.Union([
  strict(
    Schema.Struct({
      operation: Schema.Literal("observe"),
      status: Schema.Literal("not_found"),
    }),
  ),
  strict(
    Schema.Struct({
      operation: Schema.Literal("observe"),
      status: Schema.Literal("found"),
      receipt: CodexCheckpointHelperMutationReceipt,
      receiptObjectOid: CodexCheckpointHelperOid,
    }),
  ),
]);
export type CodexCheckpointHelperObserveResult = typeof CodexCheckpointHelperObserveResult.Type;

export const CodexCheckpointHelperResult = Schema.Union([
  CodexCheckpointHelperProbeResult,
  CodexCheckpointHelperOpenResult,
  CodexCheckpointHelperCaptureResult,
  CodexCheckpointHelperDiffResult,
  CodexCheckpointHelperRestoreResult,
  CodexCheckpointHelperDeleteResult,
  CodexCheckpointHelperObserveResult,
]);
export type CodexCheckpointHelperResult = typeof CodexCheckpointHelperResult.Type;

export const CodexCheckpointHelperErrorCode = Schema.Literals([
  "unsupported_protocol",
  "unsupported_operation",
  "invalid_request",
  "invalid_git_executable",
  "not_a_repository",
  "unsupported_object_format",
  "binding_changed",
  "checkpoint_exists",
  "checkpoint_not_found",
  "checkpoint_oid_mismatch",
  "repository_busy",
  "operation_id_conflict",
  "request_too_large",
  "response_too_large",
  "operation_failed",
]);
export type CodexCheckpointHelperErrorCode = typeof CodexCheckpointHelperErrorCode.Type;

export const CodexCheckpointHelperError = strict(
  Schema.Struct({
    code: CodexCheckpointHelperErrorCode,
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
    retryable: Schema.Boolean,
  }),
);
export type CodexCheckpointHelperError = typeof CodexCheckpointHelperError.Type;

export const CodexCheckpointHelperResponse = Schema.Union([
  strict(
    Schema.Struct({
      protocol: Protocol,
      ok: Schema.Literal(true),
      result: CodexCheckpointHelperResult,
    }),
  ),
  strict(
    Schema.Struct({
      protocol: Protocol,
      ok: Schema.Literal(false),
      error: CodexCheckpointHelperError,
    }),
  ),
]);
export type CodexCheckpointHelperResponse = typeof CodexCheckpointHelperResponse.Type;
