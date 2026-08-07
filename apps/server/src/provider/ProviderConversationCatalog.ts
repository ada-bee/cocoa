import type { ProviderInstanceId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export type ProviderConversationThreadStatus = "not-loaded" | "idle" | "active" | "system-error";

export const ProviderConversationTurn = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["in-progress", "completed", "failed", "interrupted"]),
  startedAt: Schema.NullOr(Schema.Int),
  completedAt: Schema.NullOr(Schema.Int),
  items: Schema.Array(Schema.Unknown),
  itemsView: Schema.Literals(["not-loaded", "summary", "full"]),
});
export type ProviderConversationTurn = typeof ProviderConversationTurn.Type;

export const ProviderConversationThread = Schema.Struct({
  providerThreadId: Schema.String,
  cwd: Schema.String,
  title: Schema.NullOr(Schema.String),
  preview: Schema.String,
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
  recencyAt: Schema.NullOr(Schema.Int),
  status: Schema.Literals(["not-loaded", "idle", "active", "system-error"]),
  activeFlags: Schema.Array(Schema.Literals(["waiting-on-approval", "waiting-on-user-input"])),
  source: Schema.Unknown,
  modelProvider: Schema.String,
  ephemeral: Schema.Boolean,
  parentProviderThreadId: Schema.NullOr(Schema.String),
  turns: Schema.Array(ProviderConversationTurn),
});
export type ProviderConversationThread = typeof ProviderConversationThread.Type;

export interface ProviderConversationPage {
  readonly threads: ReadonlyArray<ProviderConversationThread>;
  readonly nextCursor: string | null;
}

export interface ProviderConversationListInput {
  readonly archived: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  readonly cwd?: string | ReadonlyArray<string>;
  readonly useStateDbOnly?: boolean;
}

export type ProviderConversationInvalidation =
  | { readonly type: "thread-changed"; readonly providerThreadId: string }
  | { readonly type: "thread-deleted"; readonly providerThreadId: string }
  | { readonly type: "catalog-changed"; readonly providerThreadId: string }
  | { readonly type: "catalog-reset" };

export class ProviderConversationCatalogError extends Schema.TaggedErrorClass<ProviderConversationCatalogError>()(
  "ProviderConversationCatalogError",
  {
    providerInstanceId: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["disconnected", "unsupported", "protocol", "operation-failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider conversation catalog '${this.providerInstanceId}' failed during ${this.operation}: ${this.detail}`;
  }
}

/** Provider-instance-owned durable conversation catalog. */
export interface ProviderConversationCatalog {
  readonly providerInstanceId: ProviderInstanceId;
  readonly listThreads: (
    input: ProviderConversationListInput,
  ) => Effect.Effect<ProviderConversationPage, ProviderConversationCatalogError>;
  readonly readThread: (
    providerThreadId: string,
  ) => Effect.Effect<ProviderConversationThread, ProviderConversationCatalogError>;
  readonly setThreadName: (
    providerThreadId: string,
    name: string,
  ) => Effect.Effect<void, ProviderConversationCatalogError>;
  readonly archiveThread: (
    providerThreadId: string,
  ) => Effect.Effect<void, ProviderConversationCatalogError>;
  readonly unarchiveThread: (
    providerThreadId: string,
  ) => Effect.Effect<void, ProviderConversationCatalogError>;
  readonly deleteThread: (
    providerThreadId: string,
  ) => Effect.Effect<void, ProviderConversationCatalogError>;
  readonly subscribeInvalidations: Effect.Effect<
    PubSub.Subscription<ProviderConversationInvalidation>,
    never,
    Scope.Scope
  >;
}
