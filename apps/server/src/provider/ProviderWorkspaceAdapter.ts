/**
 * Provider-owned workspace primitives.
 *
 * A driver validates an absolute provider-host root once and returns a handle
 * whose operations are permanently bound to that root. Consumers can inspect
 * metadata and direct directory children, but cannot substitute a different
 * root or access arbitrary file contents through this capability.
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
  readonly createdAtMs?: number;
  readonly modifiedAtMs?: number;
}

export interface ProviderWorkspaceDirectoryEntry {
  /** A direct child name, never an absolute or root-relative path. */
  readonly name: string;
  readonly kind: ProviderWorkspaceEntryKind;
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
  }) => Effect.Effect<ReadonlyArray<ProviderWorkspaceDirectoryEntry>, ProviderWorkspaceError>;
}

/** Optional per-instance capability implemented by provider drivers. */
export interface ProviderWorkspaceAdapter {
  readonly openRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<ProviderWorkspaceRoot, ProviderWorkspaceError>;
}
