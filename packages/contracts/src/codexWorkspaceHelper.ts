/**
 * Versioned wire and configuration contracts for Cocoa's provider-host
 * workspace helper.
 *
 * The v1 helper is deliberately read-only. It receives a provider-owned root
 * and root-relative paths, and performs bounded validation, metadata, listing,
 * and read operations on the provider host. No configurable argv or shell
 * command crosses this boundary.
 *
 * @module codexWorkspaceHelper
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION = 1 as const;
export const CODEX_WORKSPACE_HELPER_MAX_PATH_BYTES = 4096;
export const CODEX_WORKSPACE_HELPER_MAX_READ_BYTES = 1024 * 1024;
export const CODEX_WORKSPACE_HELPER_MAX_LIST_ENTRIES = 25_000;
export const CODEX_WORKSPACE_HELPER_MAX_LIST_DEPTH = 64;
export const CODEX_WORKSPACE_HELPER_MAX_LIST_DIRECTORIES = 10_000;
export const CODEX_WORKSPACE_HELPER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

/** Initial provider-host path syntax. Windows hosts require a future protocol version. */
export const CodexWorkspaceHelperAbsolutePath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(CODEX_WORKSPACE_HELPER_MAX_PATH_BYTES),
  Schema.makeFilter((path) => {
    if (path.includes("\0")) return "Provider-host paths must not contain NUL bytes.";
    return path.startsWith("/") || "Provider-host paths must be absolute POSIX paths.";
  }),
);
export type CodexWorkspaceHelperAbsolutePath = typeof CodexWorkspaceHelperAbsolutePath.Type;

/**
 * Empty means the captured workspace root. Non-empty paths are normalized,
 * slash-separated descendants and may not contain traversal components.
 */
export const CodexWorkspaceHelperRelativePath = Schema.String.check(
  Schema.isMaxLength(CODEX_WORKSPACE_HELPER_MAX_PATH_BYTES),
  Schema.makeFilter((path) => {
    if (path.includes("\0")) return "Workspace-relative paths must not contain NUL bytes.";
    if (path.startsWith("/")) return "Workspace-relative paths must not be absolute.";
    if (path.includes("\\")) {
      return "Workspace-relative paths must use POSIX '/' separators, not backslashes.";
    }
    if (path === "") return true;
    const components = path.split("/");
    return (
      components.every(
        (component) => component !== "" && component !== "." && component !== "..",
      ) ||
      "Workspace-relative paths must be normalized descendants without empty, '.' or '..' components."
    );
  }),
);
export type CodexWorkspaceHelperRelativePath = typeof CodexWorkspaceHelperRelativePath.Type;

export const CodexWorkspaceHelperReadByteLimit = PositiveInt.check(
  Schema.isLessThanOrEqualTo(CODEX_WORKSPACE_HELPER_MAX_READ_BYTES),
);
export type CodexWorkspaceHelperReadByteLimit = typeof CodexWorkspaceHelperReadByteLimit.Type;

export const CodexWorkspaceHelperListEntryLimit = PositiveInt.check(
  Schema.isLessThanOrEqualTo(CODEX_WORKSPACE_HELPER_MAX_LIST_ENTRIES),
);
export type CodexWorkspaceHelperListEntryLimit = typeof CodexWorkspaceHelperListEntryLimit.Type;

export const CodexWorkspaceHelperListDepthLimit = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(CODEX_WORKSPACE_HELPER_MAX_LIST_DEPTH),
);
export type CodexWorkspaceHelperListDepthLimit = typeof CodexWorkspaceHelperListDepthLimit.Type;

export const CodexWorkspaceHelperListDirectoryLimit = PositiveInt.check(
  Schema.isLessThanOrEqualTo(CODEX_WORKSPACE_HELPER_MAX_LIST_DIRECTORIES),
);
export type CodexWorkspaceHelperListDirectoryLimit =
  typeof CodexWorkspaceHelperListDirectoryLimit.Type;

export const CodexWorkspaceHelperResponseByteLimit = PositiveInt.check(
  Schema.isLessThanOrEqualTo(CODEX_WORKSPACE_HELPER_MAX_RESPONSE_BYTES),
);
export type CodexWorkspaceHelperResponseByteLimit =
  typeof CodexWorkspaceHelperResponseByteLimit.Type;

export const CodexWorkspaceHelperFileSize = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export type CodexWorkspaceHelperFileSize = typeof CodexWorkspaceHelperFileSize.Type;

export const CodexWorkspaceHelperTimestampMs = Schema.Int.check(
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
export type CodexWorkspaceHelperTimestampMs = typeof CodexWorkspaceHelperTimestampMs.Type;

export const CodexWorkspaceHelperEntryKind = Schema.Literals([
  "file",
  "directory",
  "symlink",
  "other",
]);
export type CodexWorkspaceHelperEntryKind = typeof CodexWorkspaceHelperEntryKind.Type;

export const CodexWorkspaceHelperCapability = Schema.Literals([
  "probe",
  "validate",
  "stat",
  "list",
  "read",
]);
export type CodexWorkspaceHelperCapability = typeof CodexWorkspaceHelperCapability.Type;

const ProtocolVersion = Schema.Literal(CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION);
const FileIdentityComponent = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[0-9]+$/),
);

/** Identity captured from the opened root descriptor and rechecked on every operation. */
export const CodexWorkspaceHelperRootIdentity = strict(
  Schema.Struct({
    canonicalRoot: CodexWorkspaceHelperAbsolutePath,
    device: FileIdentityComponent,
    inode: FileIdentityComponent,
  }),
);
export type CodexWorkspaceHelperRootIdentity = typeof CodexWorkspaceHelperRootIdentity.Type;

export const CodexWorkspaceHelperListLimits = strict(
  Schema.Struct({
    maxEntries: CodexWorkspaceHelperListEntryLimit,
    maxDepth: CodexWorkspaceHelperListDepthLimit,
    maxDirectories: CodexWorkspaceHelperListDirectoryLimit,
    maxResponseBytes: CodexWorkspaceHelperResponseByteLimit,
  }),
);
export type CodexWorkspaceHelperListLimits = typeof CodexWorkspaceHelperListLimits.Type;

export const CodexWorkspaceHelperRequest = Schema.Union([
  strict(
    Schema.Struct({
      protocol: ProtocolVersion,
      operation: Schema.Literal("probe"),
    }),
  ),
  strict(
    Schema.Struct({
      protocol: ProtocolVersion,
      operation: Schema.Literal("validate"),
      root: CodexWorkspaceHelperAbsolutePath,
    }),
  ),
  strict(
    Schema.Struct({
      protocol: ProtocolVersion,
      operation: Schema.Literal("stat"),
      root: CodexWorkspaceHelperAbsolutePath,
      expectedRoot: CodexWorkspaceHelperRootIdentity,
      relativePath: CodexWorkspaceHelperRelativePath,
    }),
  ),
  strict(
    Schema.Struct({
      protocol: ProtocolVersion,
      operation: Schema.Literal("list"),
      root: CodexWorkspaceHelperAbsolutePath,
      expectedRoot: CodexWorkspaceHelperRootIdentity,
      relativePath: CodexWorkspaceHelperRelativePath,
      limits: CodexWorkspaceHelperListLimits,
    }),
  ),
  strict(
    Schema.Struct({
      protocol: ProtocolVersion,
      operation: Schema.Literal("read"),
      root: CodexWorkspaceHelperAbsolutePath,
      expectedRoot: CodexWorkspaceHelperRootIdentity,
      relativePath: CodexWorkspaceHelperRelativePath,
      maxBytes: CodexWorkspaceHelperReadByteLimit,
    }),
  ),
]);
export type CodexWorkspaceHelperRequest = typeof CodexWorkspaceHelperRequest.Type;

export const CodexWorkspaceHelperMetadata = strict(
  Schema.Struct({
    kind: CodexWorkspaceHelperEntryKind,
    size: Schema.optionalKey(CodexWorkspaceHelperFileSize),
    createdAtMs: Schema.optionalKey(CodexWorkspaceHelperTimestampMs),
    modifiedAtMs: Schema.optionalKey(CodexWorkspaceHelperTimestampMs),
  }),
);
export type CodexWorkspaceHelperMetadata = typeof CodexWorkspaceHelperMetadata.Type;

export const CodexWorkspaceHelperEntry = strict(
  Schema.Struct({
    path: CodexWorkspaceHelperRelativePath,
    kind: CodexWorkspaceHelperEntryKind,
  }),
);
export type CodexWorkspaceHelperEntry = typeof CodexWorkspaceHelperEntry.Type;

const Base64Bytes = Schema.String.check(
  Schema.isMaxLength(Math.ceil(CODEX_WORKSPACE_HELPER_MAX_READ_BYTES / 3) * 4),
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
);

export const CodexWorkspaceHelperProbeResult = strict(
  Schema.Struct({
    operation: Schema.Literal("probe"),
    implementation: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    buildId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
    capabilities: Schema.Array(CodexWorkspaceHelperCapability).check(Schema.isMaxLength(5)),
  }),
);
export type CodexWorkspaceHelperProbeResult = typeof CodexWorkspaceHelperProbeResult.Type;

export const CodexWorkspaceHelperValidateResult = strict(
  Schema.Struct({
    operation: Schema.Literal("validate"),
    root: CodexWorkspaceHelperRootIdentity,
    metadata: CodexWorkspaceHelperMetadata,
  }),
);
export type CodexWorkspaceHelperValidateResult = typeof CodexWorkspaceHelperValidateResult.Type;

export const CodexWorkspaceHelperStatResult = strict(
  Schema.Struct({
    operation: Schema.Literal("stat"),
    metadata: CodexWorkspaceHelperMetadata,
  }),
);
export type CodexWorkspaceHelperStatResult = typeof CodexWorkspaceHelperStatResult.Type;

export const CodexWorkspaceHelperListResult = strict(
  Schema.Struct({
    operation: Schema.Literal("list"),
    entries: Schema.Array(CodexWorkspaceHelperEntry).check(
      Schema.isMaxLength(CODEX_WORKSPACE_HELPER_MAX_LIST_ENTRIES),
    ),
    truncated: Schema.Boolean,
  }),
);
export type CodexWorkspaceHelperListResult = typeof CodexWorkspaceHelperListResult.Type;

export const CodexWorkspaceHelperReadResult = strict(
  Schema.Struct({
    operation: Schema.Literal("read"),
    dataBase64: Base64Bytes,
    byteLength: CodexWorkspaceHelperFileSize,
    truncated: Schema.Boolean,
  }),
);
export type CodexWorkspaceHelperReadResult = typeof CodexWorkspaceHelperReadResult.Type;

export const CodexWorkspaceHelperResult = Schema.Union([
  CodexWorkspaceHelperProbeResult,
  CodexWorkspaceHelperValidateResult,
  CodexWorkspaceHelperStatResult,
  CodexWorkspaceHelperListResult,
  CodexWorkspaceHelperReadResult,
]);
export type CodexWorkspaceHelperResult = typeof CodexWorkspaceHelperResult.Type;

export const CodexWorkspaceHelperErrorCode = Schema.Literals([
  "unsupported_protocol",
  "unsupported_operation",
  "invalid_root",
  "invalid_path",
  "path_not_found",
  "path_not_file",
  "path_not_directory",
  "path_is_symlink",
  "file_too_large",
  "limit_exceeded",
  "operation_failed",
]);
export type CodexWorkspaceHelperErrorCode = typeof CodexWorkspaceHelperErrorCode.Type;

export const CodexWorkspaceHelperError = strict(
  Schema.Struct({
    code: CodexWorkspaceHelperErrorCode,
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  }),
);
export type CodexWorkspaceHelperError = typeof CodexWorkspaceHelperError.Type;

export const CodexWorkspaceHelperResponse = Schema.Union([
  strict(
    Schema.Struct({
      protocol: ProtocolVersion,
      ok: Schema.Literal(true),
      result: CodexWorkspaceHelperResult,
    }),
  ),
  strict(
    Schema.Struct({
      protocol: ProtocolVersion,
      ok: Schema.Literal(false),
      error: CodexWorkspaceHelperError,
    }),
  ),
]);
export type CodexWorkspaceHelperResponse = typeof CodexWorkspaceHelperResponse.Type;

const InlinePython3Config = strict(
  Schema.Struct({
    type: Schema.Literal("inline-python3-v1"),
    executablePath: CodexWorkspaceHelperAbsolutePath,
  }),
);

const ExecutableConfig = strict(
  Schema.Struct({
    type: Schema.Literal("cocoa-workspace-helper-v1"),
    executablePath: CodexWorkspaceHelperAbsolutePath,
    expectedProtocol: ProtocolVersion,
  }),
);

/** Administrator-selected helper implementation; arbitrary commands are intentionally absent. */
export const CodexWorkspaceHelperConfig = Schema.Union([
  InlinePython3Config,
  ExecutableConfig,
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CodexWorkspaceHelperConfig = typeof CodexWorkspaceHelperConfig.Type;
