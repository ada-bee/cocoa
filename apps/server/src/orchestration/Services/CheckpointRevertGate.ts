import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CheckpointRevertSagaId } from "../../persistence/Services/CheckpointRevertSagas.ts";

export class CheckpointRevertGateBlockedError extends Schema.TaggedErrorClass<CheckpointRevertGateBlockedError>()(
  "CheckpointRevertGateBlockedError",
  {
    threadId: ThreadId,
    sagaId: CheckpointRevertSagaId,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' is blocked by an active checkpoint revert.`;
  }
}

export interface CheckpointRevertGateShape {
  readonly assertThreadAvailable: (
    threadId: ThreadId,
  ) => Effect.Effect<void, CheckpointRevertGateBlockedError>;
  readonly isThreadBlocked: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export class CheckpointRevertGate extends Context.Service<
  CheckpointRevertGate,
  CheckpointRevertGateShape
>()("t3/orchestration/Services/CheckpointRevertGate") {}
