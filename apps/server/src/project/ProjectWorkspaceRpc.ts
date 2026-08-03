import type {
  ProjectListEntriesResult,
  ProjectReadFileResult,
  ProjectWorkspaceFailure,
  ProjectWorkspaceTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ProjectWorkspaceError,
  type ProjectWorkspaceShape,
  type ProjectWorkspaceTarget as ResolvedProjectWorkspaceTarget,
} from "./ProjectWorkspace.ts";
import {
  ProviderWorkspaceMaxDepth,
  ProviderWorkspaceMaxDirectories,
  ProviderWorkspaceMaxEntries,
  type ProviderWorkspaceOperation,
  ProviderWorkspaceReadByteLimit,
} from "../provider/ProviderWorkspaceAdapter.ts";

const LIST_MAX_ENTRIES = ProviderWorkspaceMaxEntries.make(25_000);
const LIST_MAX_DEPTH = ProviderWorkspaceMaxDepth.make(64);
const LIST_MAX_DIRECTORIES = ProviderWorkspaceMaxDirectories.make(10_000);
const READ_MAX_BYTES = ProviderWorkspaceReadByteLimit.make(1024 * 1024);

export interface ProjectWorkspaceFailureContext {
  readonly failure: ProjectWorkspaceFailure;
  readonly retryable: boolean;
}

export class ProjectWorkspaceBinaryFileError extends Schema.TaggedErrorClass<ProjectWorkspaceBinaryFileError>()(
  "ProjectWorkspaceBinaryFileError",
  {},
) {}

export type ProjectWorkspaceRpcError = ProjectWorkspaceError | ProjectWorkspaceBinaryFileError;

function unexpectedProjectWorkspaceError(error: never): never {
  throw new Error(`Unhandled project workspace error: ${String(error)}`);
}

export function projectWorkspaceFailureContext(
  error: ProjectWorkspaceRpcError,
): ProjectWorkspaceFailureContext {
  switch (error._tag) {
    case "ProjectWorkspaceProjectNotFoundError":
      return { failure: "project_not_found", retryable: false };
    case "ProjectWorkspaceThreadNotFoundError":
      return { failure: "thread_not_found", retryable: false };
    case "ProjectWorkspaceThreadProjectMismatchError":
      return { failure: "thread_project_mismatch", retryable: false };
    case "ProjectWorkspaceProviderNotFoundError":
      return { failure: "provider_instance_not_found", retryable: false };
    case "ProjectWorkspaceProviderUnavailableError":
      return { failure: "provider_unavailable", retryable: false };
    case "ProjectWorkspaceCapabilityUnavailableError":
    case "ProviderWorkspaceUnsupportedError":
      return { failure: "unsupported_operation", retryable: false };
    case "ProjectWorkspaceResolveOperationError":
      return { failure: "operation_failed", retryable: true };
    case "ProviderWorkspaceDisconnectedError":
      return { failure: "provider_unavailable", retryable: true };
    case "ProviderWorkspaceProtocolError":
      return { failure: "protocol_incompatible", retryable: false };
    case "ProviderWorkspacePathError":
      return providerWorkspacePathFailureContext(error.operation, error.issue);
    case "ProviderWorkspaceOperationError":
      return { failure: "operation_failed", retryable: true };
    case "ProjectWorkspaceBinaryFileError":
      return { failure: "binary_file", retryable: false };
    default:
      return unexpectedProjectWorkspaceError(error);
  }
}

function providerWorkspacePathFailureContext(
  operation: ProviderWorkspaceOperation,
  issue: string,
): ProjectWorkspaceFailureContext {
  switch (issue) {
    case "path_not_found":
      return {
        failure: operation === "openRoot" ? "workspace_root_not_found" : "path_not_found",
        retryable: false,
      };
    case "path_not_file":
      return { failure: "path_not_file", retryable: false };
    case "path_not_directory":
      return {
        failure: operation === "openRoot" ? "workspace_root_not_directory" : "path_not_directory",
        retryable: false,
      };
    case "path_is_symlink":
      return { failure: "symlink_rejected", retryable: false };
    case "file_too_large":
      return { failure: "file_too_large", retryable: false };
    case "invalid_path":
      return { failure: "path_outside_workspace", retryable: false };
    default:
      return { failure: "operation_failed", retryable: false };
  }
}

export const unsupportedProjectWorkspaceFailure = (): ProjectWorkspaceFailureContext => ({
  failure: "unsupported_operation",
  retryable: false,
});

function resolvedTarget(target: ProjectWorkspaceTarget): ResolvedProjectWorkspaceTarget {
  return target.threadId === undefined
    ? { projectId: target.projectId }
    : { projectId: target.projectId, threadId: target.threadId };
}

export const listProjectEntries = Effect.fn("ProjectWorkspaceRpc.listProjectEntries")(function* (
  workspace: ProjectWorkspaceShape,
  target: ProjectWorkspaceTarget,
): Effect.fn.Return<ProjectListEntriesResult, ProjectWorkspaceError> {
  const listing = yield* workspace.listEntries({
    target: resolvedTarget(target),
    relativePath: "",
    maxEntries: LIST_MAX_ENTRIES,
    maxDepth: LIST_MAX_DEPTH,
    maxDirectories: LIST_MAX_DIRECTORIES,
  });
  const entries: Array<ProjectListEntriesResult["entries"][number]> = [];
  for (const entry of listing.entries) {
    switch (entry.kind) {
      case "file":
      case "directory":
        entries.push({ path: entry.path, kind: entry.kind });
        break;
      case "symlink":
      case "other":
        break;
      default:
        unexpectedProjectWorkspaceError(entry.kind);
    }
  }
  return { entries, truncated: listing.truncated };
});

export const readProjectFile = Effect.fn("ProjectWorkspaceRpc.readProjectFile")(function* (
  workspace: ProjectWorkspaceShape,
  input: {
    readonly target: ProjectWorkspaceTarget;
    readonly relativePath: string;
  },
): Effect.fn.Return<ProjectReadFileResult, ProjectWorkspaceRpcError> {
  const result = yield* workspace.readFile({
    target: resolvedTarget(input.target),
    relativePath: input.relativePath,
    maxBytes: READ_MAX_BYTES,
  });
  if (result.bytes.includes(0)) {
    return yield* new ProjectWorkspaceBinaryFileError();
  }
  return {
    relativePath: input.relativePath,
    contents: new TextDecoder("utf-8").decode(result.bytes),
    byteLength: result.byteLength,
    truncated: result.truncated,
  };
});
