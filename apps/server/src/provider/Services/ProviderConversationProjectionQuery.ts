import * as Context from "effect/Context";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

/** Client-facing projection view with provider conversations as its catalog/history authority. */
export class ProviderConversationProjectionQuery extends Context.Service<
  ProviderConversationProjectionQuery,
  ProjectionSnapshotQueryShape
>()("t3/provider/Services/ProviderConversationProjectionQuery") {}
