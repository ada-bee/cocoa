/**
 * Provider-owned interactive terminal primitives.
 *
 * A driver starts a terminal on the provider host and returns controls that
 * remain pinned to that exact provider process generation and session. The
 * gateway supplies explicit safety bounds and receives binary output so the
 * adapter never needs to reinterpret terminal encoding.
 *
 * @module provider/ProviderTerminalAdapter
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export const ProviderTerminalOperation = Schema.Literals(["start", "write", "resize", "terminate"]);
export type ProviderTerminalOperation = typeof ProviderTerminalOperation.Type;

export const ProviderTerminalExitReason = Schema.Literals([
  "completed",
  "terminated",
  "disconnected",
  "outputLimit",
  "failed",
]);
export type ProviderTerminalExitReason = typeof ProviderTerminalExitReason.Type;

export const PROVIDER_TERMINAL_MAX_COLUMNS = 1_000;
export const ProviderTerminalColumns = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_TERMINAL_MAX_COLUMNS),
).pipe(Schema.brand("ProviderTerminalColumns"));
export type ProviderTerminalColumns = typeof ProviderTerminalColumns.Type;

export const PROVIDER_TERMINAL_MAX_ROWS = 500;
export const ProviderTerminalRows = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_TERMINAL_MAX_ROWS),
).pipe(Schema.brand("ProviderTerminalRows"));
export type ProviderTerminalRows = typeof ProviderTerminalRows.Type;

export const PROVIDER_TERMINAL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const ProviderTerminalOutputByteLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_TERMINAL_MAX_OUTPUT_BYTES),
).pipe(Schema.brand("ProviderTerminalOutputByteLimit"));
export type ProviderTerminalOutputByteLimit = typeof ProviderTerminalOutputByteLimit.Type;

export interface ProviderTerminalStartInput {
  /** Absolute path interpreted only on the provider host. */
  readonly cwd: string;
  /** Non-empty executable and argument vector interpreted only on the provider host. */
  readonly shellArgv: readonly [string, ...ReadonlyArray<string>];
  readonly cols: ProviderTerminalColumns;
  readonly rows: ProviderTerminalRows;
  readonly env?: Readonly<Record<string, string>>;
  /** Maximum cumulative output bytes the adapter may deliver for this session. */
  readonly outputByteLimit: ProviderTerminalOutputByteLimit;
}

export type ProviderTerminalEvent =
  | {
      readonly type: "output";
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: "exited";
      readonly exitCode: number | null;
      readonly exitSignal: number | null;
      readonly reason: ProviderTerminalExitReason;
    };

export type ProviderTerminalEventHandler = (event: ProviderTerminalEvent) => Effect.Effect<void>;

export class ProviderTerminalDisconnectedError extends Schema.TaggedErrorClass<ProviderTerminalDisconnectedError>()(
  "ProviderTerminalDisconnectedError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderTerminalOperation,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider terminal '${this.providerInstanceId}' is disconnected during ${this.operation}.`;
  }
}

export class ProviderTerminalProtocolError extends Schema.TaggedErrorClass<ProviderTerminalProtocolError>()(
  "ProviderTerminalProtocolError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderTerminalOperation,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider terminal protocol failed for '${this.providerInstanceId}' during ${this.operation}: ${this.detail}`;
  }
}

export class ProviderTerminalUnsupportedError extends Schema.TaggedErrorClass<ProviderTerminalUnsupportedError>()(
  "ProviderTerminalUnsupportedError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderTerminalOperation,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider terminal '${this.providerInstanceId}' does not support ${this.operation}.`;
  }
}

export class ProviderTerminalCwdError extends Schema.TaggedErrorClass<ProviderTerminalCwdError>()(
  "ProviderTerminalCwdError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderTerminalOperation,
    cwd: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider terminal cwd '${this.cwd}' is invalid for '${this.providerInstanceId}' during ${this.operation}: ${this.issue}`;
  }
}

export class ProviderTerminalOperationError extends Schema.TaggedErrorClass<ProviderTerminalOperationError>()(
  "ProviderTerminalOperationError",
  {
    providerInstanceId: ProviderInstanceId,
    operation: ProviderTerminalOperation,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider terminal operation failed for '${this.providerInstanceId}' during ${this.operation}: ${this.detail}`;
  }
}

export type ProviderTerminalError =
  | ProviderTerminalDisconnectedError
  | ProviderTerminalUnsupportedError
  | ProviderTerminalProtocolError
  | ProviderTerminalCwdError
  | ProviderTerminalOperationError;

/**
 * Controls for one provider terminal session.
 *
 * Every method targets the exact session and connection generation captured at
 * start time. Implementations must fail on generation replacement and must not
 * transparently rebind or retry against a newer connection.
 */
export interface ProviderTerminalSession {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, ProviderTerminalError>;
  readonly resize: (input: {
    readonly cols: ProviderTerminalColumns;
    readonly rows: ProviderTerminalRows;
  }) => Effect.Effect<void, ProviderTerminalError>;
  /** Idempotently stop this exact session. */
  readonly terminate: Effect.Effect<void, ProviderTerminalError>;
}

/** Optional per-instance capability implemented by provider drivers. */
export interface ProviderTerminalAdapter {
  /**
   * Start a provider-host terminal after installing its event handler. Events
   * are ordered and end with exactly one `exited` event. The returned scope
   * owns the session and must terminate it when closed.
   */
  readonly start: (
    input: ProviderTerminalStartInput,
    onEvent: ProviderTerminalEventHandler,
  ) => Effect.Effect<ProviderTerminalSession, ProviderTerminalError, Scope.Scope>;
}
