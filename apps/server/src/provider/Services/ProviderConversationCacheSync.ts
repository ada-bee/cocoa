import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as PubSub from "effect/PubSub";

export interface ProviderConversationCacheSyncShape {
  /** Attach provider invalidation listeners and the periodic reconciliation pass. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Queue an authoritative two-part (active + archived) catalog sweep. */
  readonly refreshInstance: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
  /** Queue a provider-native full-history refresh for one cached thread. */
  readonly refreshThread: (
    providerInstanceId: ProviderInstanceId,
    providerThreadId: string,
  ) => Effect.Effect<void>;
  /** Deterministic test/flush boundary for all work queued so far. */
  readonly drain: Effect.Effect<void>;
  /** Coalesced notification that cached provider conversation state may have changed. */
  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
}

export class ProviderConversationCacheSync extends Context.Service<
  ProviderConversationCacheSync,
  ProviderConversationCacheSyncShape
>()("t3/provider/Services/ProviderConversationCacheSync") {}
