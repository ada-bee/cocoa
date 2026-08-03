import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CheckpointRevertIntentRepository } from "../../persistence/Services/CheckpointRevertIntents.ts";
import {
  CheckpointRevertGate,
  CheckpointRevertGateBlockedError,
  type CheckpointRevertGateShape,
} from "../Services/CheckpointRevertGate.ts";

const make = Effect.gen(function* () {
  const intents = yield* CheckpointRevertIntentRepository;

  const assertThreadAvailable: CheckpointRevertGateShape["assertThreadAvailable"] = (threadId) =>
    intents.getActiveByThread({ threadId }).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (intent) =>
            Effect.fail(
              new CheckpointRevertGateBlockedError({
                threadId,
                sourceEventId: intent.sourceEventId,
                ...(intent.sagaId === null ? {} : { sagaId: intent.sagaId }),
              }),
            ),
        }),
      ),
    );

  const isThreadBlocked: CheckpointRevertGateShape["isThreadBlocked"] = (threadId) =>
    intents.getActiveByThread({ threadId }).pipe(Effect.orDie, Effect.map(Option.isSome));

  return CheckpointRevertGate.of({ assertThreadAvailable, isThreadBlocked });
});

export const CheckpointRevertGateLive = Layer.effect(CheckpointRevertGate, make);
