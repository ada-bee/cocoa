/**
 * Provider-neutral control protocol between the Cocoa gateway and cocoa-hostd.
 *
 * Conversation execution remains on the provider relay. This protocol exposes
 * only bounded, typed host capabilities and generation-bound opaque handles;
 * it never accepts arbitrary VCS argv or lets callers reinterpret host paths.
 *
 * @module cocoaHostControl
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageSummary, UsageSummaryInput } from "./usage.ts";
import { VcsDriverKind } from "./vcs.ts";

export const COCOA_HOST_CONTROL_PROTOCOL = "cocoa-host-control" as const;
export const COCOA_HOST_CONTROL_PROTOCOL_VERSION = 2 as const;
export const COCOA_HOST_CONTROL_LEGACY_PROTOCOL_VERSION = 1 as const;
export const COCOA_HOST_CONTROL_SUPPORTED_VERSIONS = [
  COCOA_HOST_CONTROL_PROTOCOL_VERSION,
  COCOA_HOST_CONTROL_LEGACY_PROTOCOL_VERSION,
] as const;

export const COCOA_HOST_CONTROL_MAX_PATH_CHARS = 4_096;
export const COCOA_HOST_CONTROL_MAX_WORKSPACE_ENTRIES = 25_000;
export const COCOA_HOST_CONTROL_MAX_WORKSPACE_DEPTH = 64;
export const COCOA_HOST_CONTROL_MAX_WORKSPACE_DIRECTORIES = 10_000;
export const COCOA_HOST_CONTROL_MAX_WORKSPACE_READ_BYTES = 1024 * 1024;
export const COCOA_HOST_CONTROL_MAX_VCS_PATHS = 10_000;
export const COCOA_HOST_CONTROL_MAX_VCS_REFS = 10_000;
export const COCOA_HOST_CONTROL_MAX_VCS_REMOTES = 256;
export const COCOA_HOST_CONTROL_MAX_DIFF_BYTES = 4 * 1024 * 1024;
export const COCOA_HOST_CONTROL_MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
export const COCOA_HOST_CONTROL_MAX_TERMINAL_ARGV_BYTES = 64 * 1024;
export const COCOA_HOST_CONTROL_MAX_TERMINAL_OUTPUT_BYTES = 4 * 1024 * 1024;
export const COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES = 64 * 1024;
export const COCOA_HOST_CONTROL_MAX_USAGE_RESPONSE_BYTES = 3 * 1024 * 1024;

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const utf8Encoder = new TextEncoder();

const boundedBase64 = (maxBytes: number) =>
  Schema.String.check(
    Schema.isMaxLength(Math.ceil(maxBytes / 3) * 4),
    Schema.isBase64(),
    Schema.makeFilter((value) => {
      const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
      const decodedBytes = (value.length / 4) * 3 - padding;
      return decodedBytes <= maxBytes || "Base64 payload exceeded the protocol byte limit.";
    }),
  );

const SafeOpaqueId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
);

export const CocoaHostControlRequestId = SafeOpaqueId.pipe(
  Schema.brand("CocoaHostControlRequestId"),
);
export type CocoaHostControlRequestId = typeof CocoaHostControlRequestId.Type;

export const CocoaHostControlGenerationId = SafeOpaqueId.pipe(
  Schema.brand("CocoaHostControlGenerationId"),
);
export type CocoaHostControlGenerationId = typeof CocoaHostControlGenerationId.Type;

export const CocoaHostControlResourceId = SafeOpaqueId.pipe(
  Schema.brand("CocoaHostControlResourceId"),
);
export type CocoaHostControlResourceId = typeof CocoaHostControlResourceId.Type;

/** v1 path syntax. A future protocol version can add non-POSIX hosts. */
export const CocoaHostControlAbsolutePath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(COCOA_HOST_CONTROL_MAX_PATH_CHARS),
  Schema.makeFilter((path) => {
    if (!path.startsWith("/")) return "Host paths must be absolute POSIX paths.";
    if (path.includes("\0") || path.includes("\\")) {
      return "Host paths must not contain NUL bytes or backslashes.";
    }
    if (path === "/") return true;
    if (path.endsWith("/")) return "Host paths must not end with '/'.";
    return (
      path
        .slice(1)
        .split("/")
        .every((component) => component !== "" && component !== "." && component !== "..") ||
      "Host paths must be normalized."
    );
  }),
);
export type CocoaHostControlAbsolutePath = typeof CocoaHostControlAbsolutePath.Type;
const isCocoaHostControlAbsolutePath = Schema.is(CocoaHostControlAbsolutePath);

/** Empty identifies the opened root itself. */
export const CocoaHostControlRelativePath = Schema.String.check(
  Schema.isMaxLength(COCOA_HOST_CONTROL_MAX_PATH_CHARS),
  Schema.makeFilter((path) => {
    if (path.includes("\0") || path.includes("\\")) {
      return "Relative paths must not contain NUL bytes or backslashes.";
    }
    if (path.startsWith("/")) return "Relative paths must not be absolute.";
    if (path === "") return true;
    return (
      path
        .split("/")
        .every((component) => component !== "" && component !== "." && component !== "..") ||
      "Relative paths must be normalized descendants."
    );
  }),
);
export type CocoaHostControlRelativePath = typeof CocoaHostControlRelativePath.Type;

const DirectEntryName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.makeFilter(
    (name) =>
      (!name.includes("/") &&
        !name.includes("\\") &&
        !name.includes("\0") &&
        name !== "." &&
        name !== "..") ||
      "Entry names must be direct child names.",
  ),
);

export const CocoaHostControlProtocolVersion = Schema.Literals(
  COCOA_HOST_CONTROL_SUPPORTED_VERSIONS,
);
export type CocoaHostControlProtocolVersion = typeof CocoaHostControlProtocolVersion.Type;
const ControlProtocolVersion = CocoaHostControlProtocolVersion;
const ControlRequestFields = {
  protocolVersion: ControlProtocolVersion,
  requestId: CocoaHostControlRequestId,
} as const;
const ControlResponseFields = ControlRequestFields;

export const CocoaHostControlOperation = Schema.Literals([
  "workspace.browse",
  "workspace.open",
  "workspace.stat",
  "workspace.list",
  "workspace.read",
  "vcs.open",
  "vcs.status",
  "vcs.listRefs",
  "vcs.listRemotes",
  "vcs.diff",
  "vcs.pull",
  "vcs.createWorktree",
  "vcs.removeWorktree",
  "vcs.createRef",
  "vcs.switchRef",
  "vcs.prepareCommit",
  "vcs.commit",
  "vcs.push",
  "terminal.start",
  "terminal.attach",
  "terminal.write",
  "terminal.resize",
  "terminal.terminate",
  "usage.read",
]);
export type CocoaHostControlOperation = typeof CocoaHostControlOperation.Type;

export const CocoaHostWorkspaceOperation = Schema.Literals([
  "browse",
  "open",
  "stat",
  "list",
  "read",
]);
export const CocoaHostVcsOperation = Schema.Literals([
  "open",
  "status",
  "listRefs",
  "listRemotes",
  "pull",
  "createWorktree",
  "removeWorktree",
  "createRef",
  "switchRef",
  "prepareCommit",
  "commit",
  "push",
]);
export const CocoaHostReviewDiffOperation = Schema.Literal("diff");
export const CocoaHostTerminalOperation = Schema.Literals([
  "start",
  "attach",
  "write",
  "resize",
  "terminate",
]);
export const CocoaHostUsageOperation = Schema.Literal("read");

export const CocoaHostWorkspaceCapability = strict(
  Schema.Struct({
    kind: Schema.Literal("workspace"),
    version: ControlProtocolVersion,
    operations: Schema.Array(CocoaHostWorkspaceOperation).check(Schema.isMaxLength(5)),
    maxEntries: PositiveInt.check(
      Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_WORKSPACE_ENTRIES),
    ),
    maxReadBytes: PositiveInt.check(
      Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_WORKSPACE_READ_BYTES),
    ),
  }),
);

export const CocoaHostVcsCapability = strict(
  Schema.Struct({
    kind: Schema.Literal("vcs"),
    version: ControlProtocolVersion,
    driverKinds: Schema.Array(VcsDriverKind).check(Schema.isMaxLength(3)),
    operations: Schema.Array(CocoaHostVcsOperation).check(Schema.isMaxLength(12)),
    maxChangedPaths: PositiveInt.check(
      Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_VCS_PATHS),
    ),
    maxRefs: PositiveInt.check(Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_VCS_REFS)),
  }),
);

export const CocoaHostReviewDiffCapability = strict(
  Schema.Struct({
    kind: Schema.Literal("reviewDiff"),
    version: ControlProtocolVersion,
    operations: Schema.Array(CocoaHostReviewDiffOperation).check(Schema.isMaxLength(1)),
    maxPatchBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_DIFF_BYTES)),
  }),
);

export const CocoaHostTerminalCapability = strict(
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    version: ControlProtocolVersion,
    operations: Schema.Array(CocoaHostTerminalOperation).check(Schema.isMaxLength(5)),
    maxOutputBytes: PositiveInt.check(
      Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_TERMINAL_OUTPUT_BYTES),
    ),
    supportsReconnect: Schema.Boolean,
  }),
);

export const CocoaHostUsageCapability = strict(
  Schema.Struct({
    kind: Schema.Literal("usage"),
    version: Schema.Literal(COCOA_HOST_CONTROL_PROTOCOL_VERSION),
    operations: Schema.Array(CocoaHostUsageOperation).check(Schema.isMaxLength(1)),
  }),
);

export const CocoaHostProviderRelayKind = Schema.Literal("codex");
export type CocoaHostProviderRelayKind = typeof CocoaHostProviderRelayKind.Type;

const RelayRoute = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.makeFilter((route) => {
    if (!route.startsWith("/")) return "Provider relay routes must be absolute URL paths.";
    if (route.includes("?") || route.includes("#") || route.includes("\0")) {
      return "Provider relay routes must not contain a query, fragment, or NUL byte.";
    }
    return true;
  }),
);

export const CocoaHostProviderRelayCapability = strict(
  Schema.Struct({
    kind: Schema.Literal("providerRelay"),
    version: ControlProtocolVersion,
    providers: Schema.Array(CocoaHostProviderRelayKind).check(Schema.isMaxLength(1)),
    transport: Schema.Literal("websocket-json-rpc"),
  }),
);

export const CocoaHostControlCapability = Schema.Union([
  CocoaHostWorkspaceCapability,
  CocoaHostVcsCapability,
  CocoaHostReviewDiffCapability,
  CocoaHostTerminalCapability,
  CocoaHostUsageCapability,
  CocoaHostProviderRelayCapability,
]);
export type CocoaHostControlCapability = typeof CocoaHostControlCapability.Type;

export const CocoaHostProviderRelayMetadata = strict(
  Schema.Struct({
    relayId: CocoaHostControlResourceId,
    provider: CocoaHostProviderRelayKind,
    route: RelayRoute,
    transport: Schema.Literal("websocket-json-rpc"),
    status: Schema.Literals(["available", "unavailable"]),
    generationId: Schema.NullOr(CocoaHostControlGenerationId),
    userAgent: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
    serverVersion: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
    platformFamily: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
    platformOs: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  }),
);
export type CocoaHostProviderRelayMetadata = typeof CocoaHostProviderRelayMetadata.Type;

export const CocoaHostControlHandshakeRequest = strict(
  Schema.Struct({
    protocol: Schema.Literal(COCOA_HOST_CONTROL_PROTOCOL),
    requestId: CocoaHostControlRequestId,
    supportedVersions: Schema.Array(PositiveInt).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
    client: strict(
      Schema.Struct({
        name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
        version: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      }),
    ),
  }),
);
export type CocoaHostControlHandshakeRequest = typeof CocoaHostControlHandshakeRequest.Type;

export const CocoaHostControlHandshakeResponse = strict(
  Schema.Struct({
    protocol: Schema.Literal(COCOA_HOST_CONTROL_PROTOCOL),
    requestId: CocoaHostControlRequestId,
    selectedVersion: ControlProtocolVersion,
    host: strict(
      Schema.Struct({
        generationId: CocoaHostControlGenerationId,
        implementation: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
        version: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
        platformFamily: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
        platformOs: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
      }),
    ),
    capabilities: Schema.Array(CocoaHostControlCapability).check(Schema.isMaxLength(6)),
    providerRelays: Schema.Array(CocoaHostProviderRelayMetadata).check(Schema.isMaxLength(8)),
  }),
);
export type CocoaHostControlHandshakeResponse = typeof CocoaHostControlHandshakeResponse.Type;

/** A handshake failure is framed before a protocol version has been selected. */
export const CocoaHostControlHandshakeErrorResponse = strict(
  Schema.Struct({
    protocol: Schema.Literal(COCOA_HOST_CONTROL_PROTOCOL),
    requestId: CocoaHostControlRequestId,
    error: strict(
      Schema.Struct({
        code: Schema.Literals(["unsupportedProtocol", "invalidRequest"]),
        message: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
        retryable: Schema.Literal(false),
      }),
    ),
  }),
);
export type CocoaHostControlHandshakeErrorResponse =
  typeof CocoaHostControlHandshakeErrorResponse.Type;

export const CocoaHostControlHandshakeFrame = Schema.Union([
  CocoaHostControlHandshakeRequest,
  CocoaHostControlHandshakeResponse,
  CocoaHostControlHandshakeErrorResponse,
]);
export type CocoaHostControlHandshakeFrame = typeof CocoaHostControlHandshakeFrame.Type;

export const CocoaHostWorkspaceEntryKind = Schema.Literals([
  "file",
  "directory",
  "symlink",
  "other",
]);

export const CocoaHostWorkspaceBrowseLocator = Schema.Union([
  strict(
    Schema.Struct({
      kind: Schema.Literal("absolute"),
      path: CocoaHostControlAbsolutePath,
    }),
  ),
  strict(
    Schema.Struct({
      kind: Schema.Literal("home"),
      relativePath: CocoaHostControlRelativePath,
    }),
  ),
]);

const WorkspaceEntry = strict(
  Schema.Struct({
    path: CocoaHostControlRelativePath,
    kind: CocoaHostWorkspaceEntryKind,
  }),
);
const WorkspaceBrowseEntry = strict(
  Schema.Struct({
    name: DirectEntryName,
    kind: CocoaHostWorkspaceEntryKind,
  }),
);

const WorkspaceHandleFields = {
  generationId: CocoaHostControlGenerationId,
  rootId: CocoaHostControlResourceId,
} as const;

export const CocoaHostWorkspaceRequest = Schema.Union([
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("workspace.browse"),
      locator: CocoaHostWorkspaceBrowseLocator,
      maxEntries: PositiveInt.check(
        Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_WORKSPACE_ENTRIES),
      ),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("workspace.open"),
      path: CocoaHostControlAbsolutePath,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("workspace.stat"),
      ...WorkspaceHandleFields,
      relativePath: CocoaHostControlRelativePath,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("workspace.list"),
      ...WorkspaceHandleFields,
      relativePath: CocoaHostControlRelativePath,
      maxEntries: PositiveInt.check(
        Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_WORKSPACE_ENTRIES),
      ),
      maxDepth: NonNegativeInt.check(
        Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_WORKSPACE_DEPTH),
      ),
      maxDirectories: PositiveInt.check(
        Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_WORKSPACE_DIRECTORIES),
      ),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("workspace.read"),
      ...WorkspaceHandleFields,
      relativePath: CocoaHostControlRelativePath,
      maxBytes: PositiveInt.check(
        Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_WORKSPACE_READ_BYTES),
      ),
    }),
  ),
]);
export type CocoaHostWorkspaceRequest = typeof CocoaHostWorkspaceRequest.Type;

const WorkspaceMetadata = strict(
  Schema.Struct({
    kind: CocoaHostWorkspaceEntryKind,
    size: Schema.optionalKey(NonNegativeInt),
    createdAtMs: Schema.optionalKey(Schema.Int),
    modifiedAtMs: Schema.optionalKey(Schema.Int),
  }),
);

const WorkspaceReadBase64 = boundedBase64(COCOA_HOST_CONTROL_MAX_WORKSPACE_READ_BYTES);

export const CocoaHostWorkspaceResponse = Schema.Union([
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("workspace.browse"),
      directoryPath: CocoaHostControlAbsolutePath,
      parentPath: Schema.NullOr(CocoaHostControlAbsolutePath),
      entries: Schema.Array(WorkspaceBrowseEntry).check(
        Schema.isMaxLength(COCOA_HOST_CONTROL_MAX_WORKSPACE_ENTRIES),
      ),
      truncated: Schema.Boolean,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("workspace.open"),
      ...WorkspaceHandleFields,
      canonicalRoot: CocoaHostControlAbsolutePath,
      metadata: WorkspaceMetadata,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("workspace.stat"),
      metadata: WorkspaceMetadata,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("workspace.list"),
      entries: Schema.Array(WorkspaceEntry).check(
        Schema.isMaxLength(COCOA_HOST_CONTROL_MAX_WORKSPACE_ENTRIES),
      ),
      truncated: Schema.Boolean,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("workspace.read"),
      dataBase64: WorkspaceReadBase64,
      byteLength: NonNegativeInt,
      truncated: Schema.Boolean,
    }),
  ),
]);
export type CocoaHostWorkspaceResponse = typeof CocoaHostWorkspaceResponse.Type;

const VcsRepositoryFields = {
  generationId: CocoaHostControlGenerationId,
  repositoryId: CocoaHostControlResourceId,
} as const;

export const CocoaHostVcsRevision = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((revision) => {
    if (revision.includes("\0")) return "VCS revisions must not contain NUL bytes.";
    return !revision.startsWith("-") || "VCS revisions must not begin with '-'.";
  }),
);

const VcsRefName = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));
const VcsRepositoryRelativePath = CocoaHostControlRelativePath.check(Schema.isNonEmpty());
const BoundedCommitMessage = Schema.String.check(
  Schema.makeFilter(
    (message) =>
      utf8Encoder.encode(message).byteLength <= COCOA_HOST_CONTROL_MAX_COMMIT_MESSAGE_BYTES ||
      "Commit message exceeded the protocol byte limit.",
  ),
);

export const CocoaHostVcsRequest = Schema.Union([
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.open"),
      path: CocoaHostControlAbsolutePath,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.status"),
      ...VcsRepositoryFields,
      maxChangedPaths: PositiveInt.check(
        Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_VCS_PATHS),
      ),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.listRefs"),
      ...VcsRepositoryFields,
      scope: Schema.Literals(["local", "knownRemote", "all"]),
      query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
      maxRefs: PositiveInt.check(Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_VCS_REFS)),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.listRemotes"),
      ...VcsRepositoryFields,
      maxRemotes: PositiveInt.check(Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_VCS_REMOTES)),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.diff"),
      ...VcsRepositoryFields,
      source: Schema.Literal("workingTree"),
      ignoreWhitespace: Schema.Boolean,
      maxBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_DIFF_BYTES)),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.diff"),
      ...VcsRepositoryFields,
      source: Schema.Literal("baseRange"),
      baseRef: Schema.Union([Schema.Literal("automatic"), CocoaHostVcsRevision]),
      ignoreWhitespace: Schema.Boolean,
      maxBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_DIFF_BYTES)),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.pull"),
      ...VcsRepositoryFields,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.createWorktree"),
      ...VcsRepositoryFields,
      refName: VcsRefName,
      newRefName: Schema.optionalKey(VcsRefName),
      baseRefName: Schema.optionalKey(VcsRefName),
      path: Schema.NullOr(CocoaHostControlAbsolutePath),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.removeWorktree"),
      ...VcsRepositoryFields,
      path: CocoaHostControlAbsolutePath,
      force: Schema.Boolean,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.createRef"),
      ...VcsRepositoryFields,
      refName: VcsRefName,
      switchRef: Schema.Boolean,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.switchRef"),
      ...VcsRepositoryFields,
      refName: VcsRefName,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.prepareCommit"),
      ...VcsRepositoryFields,
      filePaths: Schema.optionalKey(
        Schema.Array(VcsRepositoryRelativePath).check(
          Schema.isMaxLength(COCOA_HOST_CONTROL_MAX_VCS_PATHS),
        ),
      ),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.commit"),
      ...VcsRepositoryFields,
      subject: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
      body: BoundedCommitMessage,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("vcs.push"),
      ...VcsRepositoryFields,
    }),
  ),
]);
export type CocoaHostVcsRequest = typeof CocoaHostVcsRequest.Type;

const VcsHead = Schema.Union([
  strict(Schema.Struct({ kind: Schema.Literal("unborn") })),
  strict(
    Schema.Struct({
      kind: Schema.Literal("branch"),
      name: VcsRefName,
      commit: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    }),
  ),
  strict(
    Schema.Struct({
      kind: Schema.Literal("detached"),
      commit: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    }),
  ),
]);

const VcsChangedPath = strict(
  Schema.Struct({
    path: VcsRepositoryRelativePath,
    previousPath: Schema.optionalKey(VcsRepositoryRelativePath),
    kind: Schema.Literals([
      "added",
      "modified",
      "deleted",
      "renamed",
      "copied",
      "untracked",
      "conflicted",
      "other",
    ]),
    staged: Schema.Boolean,
    unstaged: Schema.Boolean,
    additions: Schema.NullOr(NonNegativeInt),
    deletions: Schema.NullOr(NonNegativeInt),
  }),
);

const VcsRef = strict(
  Schema.Struct({
    kind: Schema.Literals(["local", "knownRemote"]),
    name: VcsRefName,
    target: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    current: Schema.Boolean,
    isDefault: Schema.Boolean,
    worktreePath: Schema.optionalKey(Schema.NullOr(CocoaHostControlAbsolutePath)),
  }),
);

const VcsRemote = strict(
  Schema.Struct({
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    fetchUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
    pushUrl: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
    isPrimary: Schema.Boolean,
  }),
);

const BoundedDiffPatch = Schema.String.check(
  Schema.makeFilter(
    (patch) =>
      utf8Encoder.encode(patch).byteLength <= COCOA_HOST_CONTROL_MAX_DIFF_BYTES ||
      "Diff patch exceeded the protocol byte limit.",
  ),
);

export const CocoaHostVcsResponse = Schema.Union([
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.open"),
      result: Schema.Union([
        strict(Schema.Struct({ kind: Schema.Literal("notRepository") })),
        strict(
          Schema.Struct({
            kind: Schema.Literal("repository"),
            ...VcsRepositoryFields,
            driverKind: VcsDriverKind,
            rootPath: CocoaHostControlAbsolutePath,
            commonDirectoryPath: Schema.NullOr(CocoaHostControlAbsolutePath),
            operations: Schema.Array(CocoaHostVcsOperation).check(Schema.isMaxLength(12)),
            reviewDiff: Schema.Boolean,
          }),
        ),
      ]),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.status"),
      head: VcsHead,
      defaultRef: Schema.NullOr(VcsRefName),
      upstreamRef: Schema.NullOr(VcsRefName),
      aheadCount: NonNegativeInt,
      behindCount: NonNegativeInt,
      hasPrimaryRemote: Schema.Boolean,
      hasWorkingTreeChanges: Schema.Boolean,
      changedPaths: Schema.Array(VcsChangedPath).check(
        Schema.isMaxLength(COCOA_HOST_CONTROL_MAX_VCS_PATHS),
      ),
      truncated: Schema.Boolean,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.listRefs"),
      refs: Schema.Array(VcsRef).check(Schema.isMaxLength(COCOA_HOST_CONTROL_MAX_VCS_REFS)),
      truncated: Schema.Boolean,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.listRemotes"),
      remotes: Schema.Array(VcsRemote).check(
        Schema.isMaxLength(COCOA_HOST_CONTROL_MAX_VCS_REMOTES),
      ),
      truncated: Schema.Boolean,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.diff"),
      source: Schema.Literals(["workingTree", "baseRange"]),
      baseRef: Schema.NullOr(CocoaHostVcsRevision),
      headRef: Schema.NullOr(CocoaHostVcsRevision),
      patch: BoundedDiffPatch,
      byteLength: NonNegativeInt.check(
        Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_DIFF_BYTES),
      ),
      truncated: Schema.Boolean,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.pull"),
      status: Schema.Literals(["pulled", "skipped_up_to_date"]),
      refName: VcsRefName,
      upstreamRef: Schema.NullOr(VcsRefName),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.createWorktree"),
      path: CocoaHostControlAbsolutePath,
      refName: VcsRefName,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.removeWorktree"),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.createRef"),
      refName: VcsRefName,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.switchRef"),
      refName: Schema.NullOr(VcsRefName),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.prepareCommit"),
      prepared: Schema.NullOr(
        strict(
          Schema.Struct({
            branch: Schema.NullOr(VcsRefName),
            stagedSummary: BoundedDiffPatch,
            stagedPatch: BoundedDiffPatch,
          }),
        ),
      ),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.commit"),
      commitSha: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("vcs.push"),
      status: Schema.Literals(["pushed", "skipped_up_to_date"]),
      branch: VcsRefName,
      upstreamBranch: Schema.optionalKey(VcsRefName),
      setUpstream: Schema.optionalKey(Schema.Boolean),
    }),
  ),
]);
export type CocoaHostVcsResponse = typeof CocoaHostVcsResponse.Type;

const TerminalColumns = PositiveInt.check(Schema.isLessThanOrEqualTo(1_000));
const TerminalRows = PositiveInt.check(Schema.isLessThanOrEqualTo(500));
const TerminalEnvKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
  Schema.isMaxLength(128),
);
const TerminalEnv = Schema.Record(
  TerminalEnvKey,
  Schema.String.check(Schema.isMaxLength(8_192)),
).check(Schema.isMaxProperties(128));
const TerminalShellArg = Schema.String.check(
  Schema.isMaxLength(8_192),
  Schema.makeFilter((arg) => !arg.includes("\0") || "Terminal argv must not contain NUL bytes."),
);
const TerminalShellArgv = Schema.NonEmptyArray(TerminalShellArg).check(
  Schema.isMaxLength(32),
  Schema.makeFilter(
    (argv) =>
      utf8Encoder.encode(argv.join("\0")).byteLength <=
        COCOA_HOST_CONTROL_MAX_TERMINAL_ARGV_BYTES ||
      "Terminal argv exceeded the protocol byte limit.",
  ),
  Schema.makeFilter(
    (argv) =>
      isCocoaHostControlAbsolutePath(argv[0]) ||
      "Terminal argv executable must be an absolute normalized host path.",
  ),
);
const TerminalDataBase64 = boundedBase64(COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES);
const TerminalOutputBase64 = boundedBase64(COCOA_HOST_CONTROL_MAX_TERMINAL_OUTPUT_BYTES);
export const CocoaHostTerminalExitReason = Schema.Literals([
  "completed",
  "terminated",
  "disconnected",
  "outputLimit",
  "failed",
]);
export type CocoaHostTerminalExitReason = typeof CocoaHostTerminalExitReason.Type;

const TerminalSessionFields = {
  generationId: CocoaHostControlGenerationId,
  sessionId: CocoaHostControlResourceId,
} as const;

export const CocoaHostTerminalRequest = Schema.Union([
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("terminal.start"),
      cwd: CocoaHostControlAbsolutePath,
      shellArgv: TerminalShellArgv,
      cols: TerminalColumns,
      rows: TerminalRows,
      env: Schema.optionalKey(TerminalEnv),
      outputByteLimit: PositiveInt.check(
        Schema.isLessThanOrEqualTo(COCOA_HOST_CONTROL_MAX_TERMINAL_OUTPUT_BYTES),
      ),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("terminal.attach"),
      ...TerminalSessionFields,
      afterSequence: Schema.optionalKey(NonNegativeInt),
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("terminal.write"),
      ...TerminalSessionFields,
      dataBase64: TerminalDataBase64,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("terminal.resize"),
      ...TerminalSessionFields,
      cols: TerminalColumns,
      rows: TerminalRows,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlRequestFields,
      operation: Schema.Literal("terminal.terminate"),
      ...TerminalSessionFields,
    }),
  ),
]);
export type CocoaHostTerminalRequest = typeof CocoaHostTerminalRequest.Type;

const TerminalSnapshot = strict(
  Schema.Struct({
    ...TerminalSessionFields,
    cwd: CocoaHostControlAbsolutePath,
    status: Schema.Literals(["running", "exited"]),
    sequence: NonNegativeInt,
    historyBase64: TerminalOutputBase64,
    historyTruncated: Schema.Boolean,
    exitCode: Schema.NullOr(Schema.Int),
    exitSignal: Schema.NullOr(Schema.Int),
    exitReason: Schema.NullOr(CocoaHostTerminalExitReason),
  }),
);

export const CocoaHostTerminalResponse = Schema.Union([
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("terminal.start"),
      snapshot: TerminalSnapshot,
    }),
  ),
  strict(
    Schema.Struct({
      ...ControlResponseFields,
      operation: Schema.Literal("terminal.attach"),
      snapshot: TerminalSnapshot,
    }),
  ),
  strict(Schema.Struct({ ...ControlResponseFields, operation: Schema.Literal("terminal.write") })),
  strict(Schema.Struct({ ...ControlResponseFields, operation: Schema.Literal("terminal.resize") })),
  strict(
    Schema.Struct({ ...ControlResponseFields, operation: Schema.Literal("terminal.terminate") }),
  ),
]);
export type CocoaHostTerminalResponse = typeof CocoaHostTerminalResponse.Type;

export const CocoaHostUsageRequest = strict(
  Schema.Struct({
    protocolVersion: Schema.Literal(COCOA_HOST_CONTROL_PROTOCOL_VERSION),
    requestId: CocoaHostControlRequestId,
    operation: Schema.Literal("usage.read"),
    input: UsageSummaryInput,
  }),
);
export type CocoaHostUsageRequest = typeof CocoaHostUsageRequest.Type;

export const CocoaHostUsageResponse = strict(
  Schema.Struct({
    protocolVersion: Schema.Literal(COCOA_HOST_CONTROL_PROTOCOL_VERSION),
    requestId: CocoaHostControlRequestId,
    operation: Schema.Literal("usage.read"),
    summary: UsageSummary,
  }),
);
export type CocoaHostUsageResponse = typeof CocoaHostUsageResponse.Type;

export const CocoaHostControlErrorCode = Schema.Literals([
  "unsupportedProtocol",
  "unsupportedOperation",
  "invalidRequest",
  "notFound",
  "staleHandle",
  "invalidPath",
  "notRepository",
  "disconnected",
  "limitExceeded",
  "outcomeUnknown",
  "operationFailed",
]);

export const CocoaHostControlErrorResponse = strict(
  Schema.Struct({
    ...ControlResponseFields,
    operation: CocoaHostControlOperation,
    error: strict(
      Schema.Struct({
        code: CocoaHostControlErrorCode,
        message: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
        retryable: Schema.Boolean,
      }),
    ),
  }),
);
export type CocoaHostControlErrorResponse = typeof CocoaHostControlErrorResponse.Type;

export const CocoaHostControlEvent = Schema.Union([
  strict(
    Schema.Struct({
      protocolVersion: ControlProtocolVersion,
      event: Schema.Literal("terminal.output"),
      ...TerminalSessionFields,
      sequence: NonNegativeInt,
      dataBase64: TerminalDataBase64,
    }),
  ),
  strict(
    Schema.Struct({
      protocolVersion: ControlProtocolVersion,
      event: Schema.Literal("terminal.exited"),
      ...TerminalSessionFields,
      sequence: NonNegativeInt,
      exitCode: Schema.NullOr(Schema.Int),
      exitSignal: Schema.NullOr(Schema.Int),
      reason: CocoaHostTerminalExitReason,
    }),
  ),
  strict(
    Schema.Struct({
      protocolVersion: ControlProtocolVersion,
      event: Schema.Literal("providerRelay.changed"),
      relay: CocoaHostProviderRelayMetadata,
    }),
  ),
]);
export type CocoaHostControlEvent = typeof CocoaHostControlEvent.Type;

export const CocoaHostControlRequest = Schema.Union([
  CocoaHostWorkspaceRequest,
  CocoaHostVcsRequest,
  CocoaHostTerminalRequest,
  CocoaHostUsageRequest,
]);
export type CocoaHostControlRequest = typeof CocoaHostControlRequest.Type;

export const CocoaHostControlResponse = Schema.Union([
  CocoaHostWorkspaceResponse,
  CocoaHostVcsResponse,
  CocoaHostTerminalResponse,
  CocoaHostUsageResponse,
  CocoaHostControlErrorResponse,
]);
export type CocoaHostControlResponse = typeof CocoaHostControlResponse.Type;

/** Any post-handshake JSON message carried by the hostd control WebSocket. */
export const CocoaHostControlFrame = Schema.Union([
  CocoaHostControlRequest,
  CocoaHostControlResponse,
  CocoaHostControlEvent,
]);
export type CocoaHostControlFrame = typeof CocoaHostControlFrame.Type;
