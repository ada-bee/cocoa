import type {
  RelayClientInstallFailureReason,
  RelayClientInstallProgressEvent,
  RelayClientStatus,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryProcessIdentity,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressStage,
  ServerSelfUpdateResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerTraceDiagnosticsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// This is part of the legacy RPC response shape, not an installer dependency.
// Cocoa never resolves or installs this binary.
export const LEGACY_RELAY_CLIENT_VERSION = "2026.5.2";

/**
 * Runtime-neutral service tags consumed by the backwards-compatible WebSocket
 * API. Their identifiers intentionally match the legacy implementations so a
 * legacy layer and a Cocoa unavailable implementation can satisfy the same
 * handler without importing either implementation here.
 */
export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/cloud/selfUpdate/ServerSelfUpdate",
) {}

export class ProcessDiagnostics extends Context.Service<
  ProcessDiagnostics,
  {
    readonly read: Effect.Effect<ServerProcessDiagnosticsResult>;
    readonly signal: (input: ServerSignalProcessInput) => Effect.Effect<ServerSignalProcessResult>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/diagnostics/ProcessDiagnostics",
) {}

export class ProcessResourceMonitor extends Context.Service<
  ProcessResourceMonitor,
  {
    readonly readHistory: (
      input: ServerProcessResourceHistoryInput,
    ) => Effect.Effect<ServerProcessResourceHistoryResult>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/diagnostics/ProcessResourceMonitor",
) {}

export class ResourceTelemetry extends Context.Service<
  ResourceTelemetry,
  {
    readonly latest: Effect.Effect<ResourceTelemetrySnapshot>;
    readonly changes: Stream.Stream<ResourceTelemetrySnapshot>;
    readonly readHistory: (input: ResourceTelemetryHistoryInput) => Effect.Effect<
      ResourceTelemetryHistory & {
        readonly legacyBackendBuckets?: ReadonlyArray<ResourceTelemetryHistoryBucket>;
      }
    >;
    readonly refresh: Effect.Effect<
      ResourceTelemetrySnapshot,
      {
        readonly _tag: "ResourceTelemetryRefreshFailed";
        readonly operation: string;
        readonly cause: unknown;
      }
    >;
    readonly validateProcessIdentity: (identity: ResourceTelemetryProcessIdentity) => Effect.Effect<
      boolean,
      {
        readonly _tag: "ResourceTelemetryRefreshFailed";
        readonly operation: string;
        readonly cause: unknown;
      }
    >;
    readonly retry: Effect.Effect<ResourceTelemetryRetryResult>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: ResourceTelemetrySnapshot;
        readonly changes: Stream.Stream<ResourceTelemetrySnapshot>;
      },
      never,
      Scope.Scope
    >;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/resourceTelemetry/ResourceTelemetry",
) {}

export class TraceDiagnostics extends Context.Service<
  TraceDiagnostics,
  {
    readonly read: (options: {
      readonly traceFilePath: string;
      readonly maxFiles: number;
      readonly slowSpanThresholdMs?: number;
      readonly readAt?: DateTime.Utc;
    }) => Effect.Effect<ServerTraceDiagnosticsResult>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/diagnostics/TraceDiagnostics",
) {}

type RelayClientStatusCompat =
  | Extract<RelayClientStatus, { readonly status: "available" | "missing" }>
  | (Omit<Extract<RelayClientStatus, { readonly status: "unsupported" }>, "platform"> & {
      readonly platform: NodeJS.Platform;
    });

type AvailableRelayClient = Extract<RelayClientStatusCompat, { readonly status: "available" }>;

export interface RelayClientInstallError {
  readonly _tag: "RelayClientInstallError";
  readonly reason: RelayClientInstallFailureReason;
  readonly message: string;
}

export class RelayClient extends Context.Service<
  RelayClient,
  {
    readonly resolve: Effect.Effect<RelayClientStatusCompat>;
    readonly install: Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
    readonly installWithProgress: (
      report: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
    ) => Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
  }
>()(
  // The legacy implementation lives in @t3tools/shared and owns this established key.
  // @effect-diagnostics-next-line deterministicKeys:off
  "@t3tools/shared/relayClient",
) {}
