/**
 * Coordinates proactive recovery of persisted provider sessions when a
 * reconnecting provider instance publishes a new ready generation.
 *
 * @module provider/Services/ProviderGenerationRecoveryReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProviderGenerationRecoveryReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderGenerationRecoveryReactor extends Context.Service<
  ProviderGenerationRecoveryReactor,
  ProviderGenerationRecoveryReactorShape
>()("t3/provider/Services/ProviderGenerationRecoveryReactor") {}
