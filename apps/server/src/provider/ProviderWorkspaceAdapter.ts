/**
 * Provider-owned workspace primitives.
 *
 * A driver validates an absolute provider-host root once and returns a handle
 * whose operations are permanently bound to that root. Consumers can inspect
 * metadata, bounded directory trees, and bounded file prefixes, but cannot
 * substitute a different root or perform unbounded workspace access.
 *
 * @module provider/ProviderWorkspaceAdapter
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ProviderWorkspaceOperation = Schema.Literals([
  "openRoot",
  "getMetadata",
  "listDirectory",
  "listEntries",
  "readFile",
  "browseDirectory",
]);
export type ProviderWorkspaceOperation = typeof ProviderWorkspaceOperation.Type;

export const ProviderWorkspaceEntryKind = Schema.Literals([
  "file",
  "directory",
  "symlink",
  "other",
]);
export type ProviderWorkspaceEntryKind = typeof ProviderWorkspaceEntryKind.Type;

export interface ProviderWorkspaceMetadata {
  readonly kind: ProviderWorkspaceEntryKind;
  readonly size?: number;
  readonly createdAtMs?: number;
  readonly modifiedAtMs?: number;
}

export interface ProviderWorkspaceDirectoryEntry {
  /** A direct child name, never an absolute or root-relative path. */
  readonly name: string;
  readonly kind: ProviderWorkspaceEntryKind;
}

export const ProviderWorkspaceMaxEntries = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ProviderWorkspaceMaxEntries"),
);
export type ProviderWorkspaceMaxEntries = typeof ProviderWorkspaceMaxEntries.Type;

export interface ProviderWorkspaceDirectoryListing {
  readonly entries: ReadonlyArray<ProviderWorkspaceDirectoryEntry>;
  /** True when more direct children existed than the requested bound. */
  readonly truncated: boolean;
}

export const PROVIDER_WORKSPACE_MAX_BROWSE_ENTRIES = 10_000;
export const ProviderWorkspaceBrowseMaxEntries = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_WORKSPACE_MAX_BROWSE_ENTRIES),
).pipe(Schema.brand("ProviderWorkspaceBrowseMaxEntries"));
export type ProviderWorkspaceBrowseMaxEntries = typeof ProviderWorkspaceBrowseMaxEntries.Type;

/** A provider-host directory, independent of any configured project root. */
export type ProviderWorkspaceBrowseLocator =
  | {
      readonly kind: "absolute";
      /** A normalized absolute POSIX path on the provider host. */
      readonly path: string;
    }
  | {
      readonly kind: "home";
      /** A normalized descendant path resolved below HOME on the provider host. */
      readonly relativePath: string;
    };

export interface ProviderWorkspaceBrowseResult {
  readonly directoryPath: string;
  readonly parentPath: string | null;
  readonly entries: ReadonlyArray<ProviderWorkspaceDirectoryEntry>;
  readonly truncated: boolean;
}

export const PROVIDER_WORKSPACE_MAX_LIST_DEPTH = 64;
export const ProviderWorkspaceMaxDepth = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(PROVIDER_WORKSPACE_MAX_LIST_DEPTH),
).pipe(Schema.brand("ProviderWorkspaceMaxDepth"));
export type ProviderWorkspaceMaxDepth = typeof ProviderWorkspaceMaxDepth.Type;

export const PROVIDER_WORKSPACE_MAX_LIST_DIRECTORIES = 10_000;
export const ProviderWorkspaceMaxDirectories = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_WORKSPACE_MAX_LIST_DIRECTORIES),
).pipe(Schema.brand("ProviderWorkspaceMaxDirectories"));
export type ProviderWorkspaceMaxDirectories = typeof ProviderWorkspaceMaxDirectories.Type;

export interface ProviderWorkspaceEntry {
  /** A normalized path relative to the requested directory. */
  readonly path: string;
  readonly kind: ProviderWorkspaceEntryKind;
}

export interface ProviderWorkspaceEntryListing {
  readonly entries: ReadonlyArray<ProviderWorkspaceEntry>;
  /** True only when entry, directory, or response bounds omitted in-scope entries. */
  readonly truncated: boolean;
}

export const PROVIDER_WORKSPACE_MAX_READ_BYTES = 1024 * 1024;
export const ProviderWorkspaceReadByteLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_WORKSPACE_MAX_READ_BYTES),
).pipe(Schema.brand("ProviderWorkspaceReadByteLimit"));
export type ProviderWorkspaceReadByteLimit = typeof ProviderWorkspaceReadByteLimit.Type;

export interface ProviderWorkspaceFileRead {
  /** At most the requested number of bytes. */
  readonly bytes: Uint8Array;
  /** Descriptor-observed file size, or a safe lower bound when the file grew during reading. */
  readonly byteLength: number;
  /** True when at least one additional byte existed on the provider host. */
  readonly truncated: boolean;
}

export class ProviderWorkspaceDisconnectedError extends Schema.TaggedErrorClass<ProviderWorkspaceDisconnectedError>()(
  "ProviderWorkspaceDisconnectedError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderWorkspaceOperation,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider workspace '${this.providerInstanceId}' is disconnected during ${this.operation}.`;
  }
}

export class ProviderWorkspaceProtocolError extends Schema.TaggedErrorClass<ProviderWorkspaceProtocolError>()(
  "ProviderWorkspaceProtocolError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderWorkspaceOperation,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider workspace protocol failed for '${this.providerInstanceId}' during ${this.operation}: ${this.detail}`;
  }
}

export class ProviderWorkspaceUnsupportedError extends Schema.TaggedErrorClass<ProviderWorkspaceUnsupportedError>()(
  "ProviderWorkspaceUnsupportedError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderWorkspaceOperation,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider workspace '${this.providerInstanceId}' does not support ${this.operation}.`;
  }
}

export class ProviderWorkspacePathError extends Schema.TaggedErrorClass<ProviderWorkspacePathError>()(
  "ProviderWorkspacePathError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderWorkspaceOperation,
    path: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider workspace path '${this.path}' is invalid for '${this.providerInstanceId}' during ${this.operation}: ${this.issue}`;
  }
}

export class ProviderWorkspaceOperationError extends Schema.TaggedErrorClass<ProviderWorkspaceOperationError>()(
  "ProviderWorkspaceOperationError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderWorkspaceOperation,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider workspace operation failed for '${this.providerInstanceId}' during ${this.operation}: ${this.detail}`;
  }
}

export type ProviderWorkspaceError =
  | ProviderWorkspaceDisconnectedError
  | ProviderWorkspaceUnsupportedError
  | ProviderWorkspaceProtocolError
  | ProviderWorkspacePathError
  | ProviderWorkspaceOperationError;

/** A provider-host root captured after the driver has validated it. */
export interface ProviderWorkspaceRoot {
  readonly getMetadata: (input: {
    readonly relativePath: string;
  }) => Effect.Effect<ProviderWorkspaceMetadata, ProviderWorkspaceError>;
  readonly listDirectory: (input: {
    readonly relativePath: string;
    readonly maxEntries: ProviderWorkspaceMaxEntries;
  }) => Effect.Effect<ProviderWorkspaceDirectoryListing, ProviderWorkspaceError>;
  readonly listEntries: (input: {
    readonly relativePath: string;
    readonly maxEntries: ProviderWorkspaceMaxEntries;
    readonly maxDepth: ProviderWorkspaceMaxDepth;
    readonly maxDirectories: ProviderWorkspaceMaxDirectories;
  }) => Effect.Effect<ProviderWorkspaceEntryListing, ProviderWorkspaceError>;
  readonly readFile: (input: {
    readonly relativePath: string;
    readonly maxBytes: ProviderWorkspaceReadByteLimit;
  }) => Effect.Effect<ProviderWorkspaceFileRead, ProviderWorkspaceError>;
}

/** Optional per-instance capability implemented by provider drivers. */
export interface ProviderWorkspaceAdapter {
  readonly browseDirectory: (input: {
    readonly locator: ProviderWorkspaceBrowseLocator;
    readonly maxEntries: ProviderWorkspaceBrowseMaxEntries;
  }) => Effect.Effect<ProviderWorkspaceBrowseResult, ProviderWorkspaceError>;
  readonly openRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<ProviderWorkspaceRoot, ProviderWorkspaceError>;
}
