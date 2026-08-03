/** Durable post-turn provider checkpoint coordination and reaction. */
import {
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperOperationId,
  EventId,
  NonNegativeInt,
  ProviderInstanceId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export type DurableTurnCompletedEvent = Extract<
  OrchestrationEvent,
  { readonly type: "thread.turn-completed" }
>;

export const PostTurnCheckpointBlockCode = Schema.Literals([
  "thread_not_found",
  "provider_changed",
  "baseline_missing",
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
  "diff_unavailable",
  "domain_dispatch_failed",
  "persistence_failure",
]);
export type PostTurnCheckpointBlockCode = typeof PostTurnCheckpointBlockCode.Type;

export class PostTurnCheckpointBlockedError extends Schema.TaggedErrorClass<PostTurnCheckpointBlockedError>()(
  "PostTurnCheckpointBlockedError",
  {
    code: PostTurnCheckpointBlockCode,
    operationId: Schema.optionalKey(CodexCheckpointHelperOperationId),
    logicalCheckpointId: Schema.optionalKey(CodexCheckpointHelperCheckpointId),
  },
) {
  override get message(): string {
    return `Post-turn checkpoint coordination is blocked (${this.code}).`;
  }
}

export type PostTurnCheckpointProcessResult =
  | { readonly _tag: "Ignored"; readonly reason: "provider_turn_id_missing" }
  | {
      readonly _tag: "Pending";
      readonly logicalCheckpointId: typeof CodexCheckpointHelperCheckpointId.Type;
      readonly state: "prepared" | "in_flight" | "outcome_unknown";
    }
  | {
      readonly _tag: "Finalized";
      readonly logicalCheckpointId: typeof CodexCheckpointHelperCheckpointId.Type;
      readonly sequence: number;
      readonly status: "ready" | "missing" | "error";
    };

export interface PostTurnCheckpointRecoveryOutcome {
  readonly sourceEventId: EventId;
  readonly operationId?: typeof CodexCheckpointHelperOperationId.Type;
  readonly logicalCheckpointId?: typeof CodexCheckpointHelperCheckpointId.Type;
  readonly status: "finalized" | "pending" | "failed" | "unchanged";
  readonly blockCode?: PostTurnCheckpointBlockCode;
}

export interface PostTurnCheckpointReactorShape {
  /** Process one persisted domain event, never a raw provider notification. */
  readonly processTurnCompleted: (
    event: DurableTurnCompletedEvent,
  ) => Effect.Effect<PostTurnCheckpointProcessResult, PostTurnCheckpointBlockedError>;
  readonly recover: (
    providerInstanceId?: ProviderInstanceId,
  ) => Effect.Effect<
    ReadonlyArray<PostTurnCheckpointRecoveryOutcome>,
    PostTurnCheckpointBlockedError
  >;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class PostTurnCheckpointReactor extends Context.Service<
  PostTurnCheckpointReactor,
  PostTurnCheckpointReactorShape
>()("t3/orchestration/Services/PostTurnCheckpointReactor") {}
