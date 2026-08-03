import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

/**
 * Identifies the provider workspace used by a project operation. When a
 * thread is present, the gateway resolves its active worktree instead of the
 * project's root workspace.
 */
export const ProjectWorkspaceTarget = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
});
export type ProjectWorkspaceTarget = typeof ProjectWorkspaceTarget.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  target: ProjectWorkspaceTarget,
  // An empty query is a bounded browse: the provider returns a bounded set of
  // entries, which the file picker uses for its initial results.
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectSearchContentsInput = Schema.Struct({
  target: ProjectWorkspaceTarget,
  // Whitespace is significant in content queries (" foo", regex trailing
  // spaces), so the query is deliberately not trimmed on the wire.
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_CONTENTS_MAX_LIMIT)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  useRegex: Schema.Boolean,
});
export type ProjectSearchContentsInput = typeof ProjectSearchContentsInput.Type;

export const ProjectContentMatchRange = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectContentMatchRange = typeof ProjectContentMatchRange.Type;

export const ProjectContentMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: Schema.String,
  matchRanges: Schema.Array(ProjectContentMatchRange),
});
export type ProjectContentMatch = typeof ProjectContentMatch.Type;

export const ProjectSearchContentsResult = Schema.Struct({
  matches: Schema.Array(ProjectContentMatch),
  truncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String),
});
export type ProjectSearchContentsResult = typeof ProjectSearchContentsResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  target: ProjectWorkspaceTarget,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

/** Stable, provider-neutral workspace failure codes exposed to clients. */
export const ProjectWorkspaceFailure = Schema.Literals([
  "project_not_found",
  "thread_not_found",
  "thread_project_mismatch",
  "provider_instance_not_found",
  "provider_unavailable",
  "protocol_incompatible",
  "unsupported_operation",
  "workspace_root_not_found",
  "workspace_root_not_directory",
  "path_outside_workspace",
  "path_not_found",
  "path_not_file",
  "path_not_directory",
  "symlink_rejected",
  "binary_file",
  "file_too_large",
  "search_timed_out",
  "operation_failed",
]);
export type ProjectWorkspaceFailure = typeof ProjectWorkspaceFailure.Type;

export const ProjectWorkspaceOperation = Schema.Literals([
  "search-entries",
  "search-contents",
  "list-entries",
  "read-file",
  "write-file",
]);
export type ProjectWorkspaceOperation = typeof ProjectWorkspaceOperation.Type;

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

type ProjectWorkspaceFailureContext = {
  readonly target: ProjectWorkspaceTarget;
  readonly failure: ProjectWorkspaceFailure;
  readonly operation: ProjectWorkspaceOperation;
  readonly retryable: boolean;
};

const ProjectWorkspaceErrorFields = {
  target: ProjectWorkspaceTarget,
  failure: ProjectWorkspaceFailure,
  operation: ProjectWorkspaceOperation,
  retryable: Schema.Boolean,
  message: TrimmedNonEmptyString,
};

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    ...ProjectWorkspaceErrorFields,
    queryLength: NonNegativeInt,
    limit: PositiveInt,
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectWorkspaceFailureContext & {
      readonly operation: "search-entries";
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message: decodedProjectErrorMessage(props) ?? "Failed to search workspace entries.",
    } as any);
  }
}

export class ProjectSearchContentsError extends Schema.TaggedErrorClass<ProjectSearchContentsError>()(
  "ProjectSearchContentsError",
  {
    ...ProjectWorkspaceErrorFields,
    queryLength: NonNegativeInt,
    limit: PositiveInt,
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectWorkspaceFailureContext & {
      readonly operation: "search-contents";
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message: decodedProjectErrorMessage(props) ?? "Failed to search workspace contents.",
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedErrorClass<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  ProjectWorkspaceErrorFields,
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectWorkspaceFailureContext & { readonly operation: "list-entries" }) {
    super({
      ...props,
      message: decodedProjectErrorMessage(props) ?? "Failed to list workspace entries.",
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  target: ProjectWorkspaceTarget,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  target: ProjectWorkspaceTarget,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

type ProjectFileFailureContext = ProjectWorkspaceFailureContext & {
  readonly relativePath: string;
};

const ProjectFileErrorFields = {
  ...ProjectWorkspaceErrorFields,
  relativePath: TrimmedNonEmptyString,
};

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  ProjectFileErrorFields,
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext & { readonly operation: "read-file" }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}'.`,
    } as any);
  }
}

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  ProjectFileErrorFields,
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext & { readonly operation: "write-file" }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}'.`,
    } as any);
  }
}
