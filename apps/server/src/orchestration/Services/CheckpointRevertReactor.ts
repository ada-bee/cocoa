import {
  CodexCheckpointHelperCheckpointId,
  OrchestrationEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { CheckpointRevertSagaId } from "../../persistence/Services/CheckpointRevertSagas.ts";

export type CheckpointRevertRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.checkpoint-revert-requested" }
>;

export const CheckpointRevertBlockCode = Schema.Literals([
  "thread_not_found",
  "project_not_found",
  "target_checkpoint_missing",
  "stale_checkpoint_missing",
  "provider_route_changed",
  "provider_rollback_active",
  "provider_rollback_outcome_unknown",
  "provider_rollback_indeterminate",
  "repository_unavailable",
  "repository_binding_changed",
  "checkpoint_capability_unavailable",
  "checkpoint_prepare_failed",
  "checkpoint_outcome_unknown",
  "checkpoint_restore_indeterminate",
  "checkpoint_delete_indeterminate",
  "checkpoint_receipt_invalid",
  "domain_dispatch_failed",
  "intent_conflict",
  "persistence_failure",
]);
export type CheckpointRevertBlockCode = typeof CheckpointRevertBlockCode.Type;

/** Sanitized orchestration failure. Never includes paths, refs, stderr, or arbitrary causes. */
export class CheckpointRevertBlockedError extends Schema.TaggedErrorClass<CheckpointRevertBlockedError>()(
  "CheckpointRevertBlockedError",
  {
    code: CheckpointRevertBlockCode,
    sagaId: Schema.optionalKey(CheckpointRevertSagaId),
    threadId: Schema.optionalKey(ThreadId),
    projectId: Schema.optionalKey(ProjectId),
    logicalCheckpointId: Schema.optionalKey(CodexCheckpointHelperCheckpointId),
  },
) {
  override get message(): string {
    return `Checkpoint revert is blocked (${this.code}).`;
  }
}

export interface CheckpointRevertProcessResult {
  readonly sourceEventId: OrchestrationEvent["eventId"];
  readonly sagaId?: CheckpointRevertSagaId;
  readonly status: "completed" | "failed" | "pending" | "indeterminate";
  readonly sequence?: number;
}

export interface CheckpointRevertReactorShape {
  readonly process: (
    event: CheckpointRevertRequestedEvent,
  ) => Effect.Effect<CheckpointRevertProcessResult, CheckpointRevertBlockedError>;
  readonly recover: () => Effect.Effect<
    ReadonlyArray<CheckpointRevertProcessResult>,
    CheckpointRevertBlockedError
  >;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class CheckpointRevertReactor extends Context.Service<
  CheckpointRevertReactor,
  CheckpointRevertReactorShape
>()("t3/orchestration/Services/CheckpointRevertReactor") {}
