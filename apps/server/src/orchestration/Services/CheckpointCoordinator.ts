/**
 * Provider-bound checkpoint coordination.
 *
 * The coordinator accepts path-free orchestration intents and owns the
 * prepare -> durable journal -> dispatch ordering for baseline captures.
 * Provider-host paths and repository bindings never cross this service API.
 *
 * @module CheckpointCoordinator
 */
import {
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperOperationId,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

export const BaselineCheckpointGateIntent = strict(
  Schema.Struct({
    sourceCommandId: CommandId,
    sourceEventId: EventId,
    projectId: ProjectId,
    threadId: ThreadId,
    messageId: MessageId,
    checkpointTurnCount: NonNegativeInt,
    createdAt: IsoDateTime,
  }),
);
export type BaselineCheckpointGateIntent = typeof BaselineCheckpointGateIntent.Type;

export const BaselineCheckpointGateResult = Schema.Union([
  strict(
    Schema.Struct({
      _tag: Schema.Literal("NotApplicable"),
      reason: Schema.Literals(["not_repository", "checkpoint_capability_unavailable"]),
    }),
  ),
  strict(
    Schema.Struct({
      _tag: Schema.Literal("Ready"),
      logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    }),
  ),
]);
export type BaselineCheckpointGateResult = typeof BaselineCheckpointGateResult.Type;

export const CheckpointCoordinatorBlockCode = Schema.Literals([
  "project_not_found",
  "project_provider_changed",
  "repository_unavailable",
  "provider_disconnected",
  "provider_protocol_error",
  "checkpoint_prepare_failed",
  "checkpoint_outcome_unknown",
  "checkpoint_failed",
  "checkpoint_indeterminate",
  "repository_binding_changed",
  "request_digest_changed",
  "checkpoint_receipt_invalid",
  "checkpoint_projection_missing",
  "checkpoint_projection_conflict",
  "intent_conflict",
  "persistence_failure",
]);
export type CheckpointCoordinatorBlockCode = typeof CheckpointCoordinatorBlockCode.Type;

/** Sanitized blocking error. It never retains provider paths, stderr, or causes. */
export class CheckpointCoordinatorBlockedError extends Schema.TaggedErrorClass<CheckpointCoordinatorBlockedError>()(
  "CheckpointCoordinatorBlockedError",
  {
    code: CheckpointCoordinatorBlockCode,
    projectId: Schema.optionalKey(ProjectId),
    threadId: Schema.optionalKey(ThreadId),
    logicalCheckpointId: Schema.optionalKey(CodexCheckpointHelperCheckpointId),
  },
) {
  override get message(): string {
    return `Baseline checkpoint coordination is blocked (${this.code}).`;
  }
}

export const CheckpointRecoveryOutcome = strict(
  Schema.Struct({
    operationId: CodexCheckpointHelperOperationId,
    logicalCheckpointId: CodexCheckpointHelperCheckpointId,
    status: Schema.Literals(["ready", "failed", "pending", "unchanged"]),
    blockCode: Schema.optionalKey(CheckpointCoordinatorBlockCode),
  }),
);
export type CheckpointRecoveryOutcome = typeof CheckpointRecoveryOutcome.Type;

export interface CheckpointCoordinatorShape {
  readonly gateBaseline: (
    intent: BaselineCheckpointGateIntent,
  ) => Effect.Effect<BaselineCheckpointGateResult, CheckpointCoordinatorBlockedError>;

  /**
   * Reconcile baseline journal rows. Prepared rows may dispatch after an exact
   * re-prepare; sent rows are observe-only. Other operation kinds are left
   * untouched for their dedicated coordinators.
   */
  readonly recover: (
    providerInstanceId?: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<CheckpointRecoveryOutcome>, CheckpointCoordinatorBlockedError>;
}

export class CheckpointCoordinator extends Context.Service<
  CheckpointCoordinator,
  CheckpointCoordinatorShape
>()("t3/orchestration/Services/CheckpointCoordinator") {}
