/**
 * Provider-owned, bounded noninteractive command execution.
 *
 * The caller supplies an authoritative provider-host cwd resolved from a
 * durable project. Implementations must pin one provider connection generation
 * for the whole request and must never replay a command after disconnect.
 *
 * @module provider/ProviderExecutionAdapter
 */
import {
  ProviderExecutionOutputByteLimit,
  ProviderExecutionTimeoutMs,
  ProviderInstanceId,
  type ProviderExecutionCommand,
  type ProviderExecutionResult,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface ProviderExecutionInput {
  /** Absolute path interpreted only on the selected provider host. */
  readonly cwd: string;
  /** Structured argv; never a shell command string. */
  readonly command: ProviderExecutionCommand;
  readonly timeoutMs: ProviderExecutionTimeoutMs;
  /** Per-stream stdout/stderr byte limit. */
  readonly outputByteLimit: ProviderExecutionOutputByteLimit;
}

export class ProviderExecutionDisconnectedError extends Schema.TaggedErrorClass<ProviderExecutionDisconnectedError>()(
  "ProviderExecutionDisconnectedError",
  { providerInstanceId: ProviderInstanceId },
) {
  override get message(): string {
    return `Provider execution '${this.providerInstanceId}' disconnected.`;
  }
}

export class ProviderExecutionUnsupportedError extends Schema.TaggedErrorClass<ProviderExecutionUnsupportedError>()(
  "ProviderExecutionUnsupportedError",
  { providerInstanceId: ProviderInstanceId },
) {
  override get message(): string {
    return `Provider instance '${this.providerInstanceId}' does not support command execution.`;
  }
}

export class ProviderExecutionProtocolError extends Schema.TaggedErrorClass<ProviderExecutionProtocolError>()(
  "ProviderExecutionProtocolError",
  {
    providerInstanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider execution protocol failed for '${this.providerInstanceId}': ${this.detail}`;
  }
}

export class ProviderExecutionOperationError extends Schema.TaggedErrorClass<ProviderExecutionOperationError>()(
  "ProviderExecutionOperationError",
  {
    providerInstanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider execution failed for '${this.providerInstanceId}': ${this.detail}`;
  }
}

export type ProviderExecutionError =
  | ProviderExecutionDisconnectedError
  | ProviderExecutionUnsupportedError
  | ProviderExecutionProtocolError
  | ProviderExecutionOperationError;

/** Optional per-instance capability, separate from interactive terminals. */
export interface ProviderExecutionAdapter {
  readonly execute: (
    input: ProviderExecutionInput,
  ) => Effect.Effect<ProviderExecutionResult, ProviderExecutionError>;
}
