/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";
import type { ProviderTurnSequenceDigest } from "../ProviderTurnSequenceDigest.ts";

export interface ProviderConversationBinding {
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentitySha256: string;
}

export interface ProviderConversationInspection {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly binding: ProviderConversationBinding;
  readonly preimage: ProviderTurnSequenceDigest;
  readonly target: ProviderTurnSequenceDigest;
}

export interface ProviderAuthoritativeTurnSnapshot {
  readonly id: TurnId;
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly completedAt: string | null;
  readonly assistantMessages: ReadonlyArray<{
    readonly itemId: string;
    readonly text: string;
    readonly phase: "commentary" | "final_answer" | null;
  }>;
  readonly finalAssistantItemId: string | null;
  readonly finalAssistantText: string | null;
  readonly hasNonrecoverableActivityGap: boolean;
}

export interface ProviderAuthoritativeConversationSnapshot {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly turns: ReadonlyArray<ProviderAuthoritativeTurnSnapshot>;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Recover a persisted resumable session for one configured provider instance.
   *
   * This adopts an already-active matching session or resumes from persisted
   * provider state. It never sends or replays user input.
   */
  readonly recoverSession: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  readonly inspectConversation: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly targetTurnCount: number;
  }) => Effect.Effect<ProviderConversationInspection, ProviderServiceError>;

  /** Read-only, exact-route snapshot used to converge missed provider notifications. */
  readonly readAuthoritativeConversation: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<ProviderAuthoritativeConversationSnapshot, ProviderServiceError>;

  readonly rollbackConversationChecked: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly numTurns: number;
    readonly expectedPreimage: ProviderTurnSequenceDigest;
    readonly expectedTarget: ProviderTurnSequenceDigest;
    readonly expectedDriverKind: ProviderDriverKind;
    readonly expectedContinuationIdentitySha256: string;
  }) => Effect.Effect<ProviderConversationInspection, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
