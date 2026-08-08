import type {
  ProviderHostId,
  ProviderInstanceId,
  UsageSummary,
  UsageSummaryInput,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProviderUsageError extends Schema.TaggedErrorClass<ProviderUsageError>()(
  "ProviderUsageError",
  {
    providerInstanceId: Schema.String,
    reason: Schema.Literals(["disconnected", "unsupported", "operation-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProviderUsageAdapter {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerHostId: ProviderHostId;
  readonly readSummary: (
    input: UsageSummaryInput,
  ) => Effect.Effect<UsageSummary, ProviderUsageError>;
}
