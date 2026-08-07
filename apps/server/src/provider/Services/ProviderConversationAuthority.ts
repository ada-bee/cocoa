import type { OrchestrationCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProviderConversationAuthorityError extends Schema.TaggedErrorClass<ProviderConversationAuthorityError>()(
  "ProviderConversationAuthorityError",
  {
    reason: Schema.Literals([
      "cache-failed",
      "provider-unavailable",
      "unsupported",
      "protocol",
      "operation-failed",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProviderConversationAuthorityShape {
  /**
   * Apply provider-owned lifecycle/title mutations at the authority endpoint.
   * Returns false for commands outside this boundary or local provider-unbound drafts.
   */
  readonly apply: (
    command: OrchestrationCommand,
  ) => Effect.Effect<boolean, ProviderConversationAuthorityError>;
}

export class ProviderConversationAuthority extends Context.Service<
  ProviderConversationAuthority,
  ProviderConversationAuthorityShape
>()("t3/provider/Services/ProviderConversationAuthority") {}
