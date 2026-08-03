import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CheckpointRevertSagaRepository } from "../../persistence/Services/CheckpointRevertSagas.ts";
import {
  CheckpointRevertGate,
  CheckpointRevertGateBlockedError,
  type CheckpointRevertGateShape,
} from "../Services/CheckpointRevertGate.ts";

const make = Effect.gen(function* () {
  const sagas = yield* CheckpointRevertSagaRepository;

  const assertThreadAvailable: CheckpointRevertGateShape["assertThreadAvailable"] = (threadId) =>
    sagas.getActiveByThread({ threadId }).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (saga) =>
            Effect.fail(new CheckpointRevertGateBlockedError({ threadId, sagaId: saga.sagaId })),
        }),
      ),
    );

  const isThreadBlocked: CheckpointRevertGateShape["isThreadBlocked"] = (threadId) =>
    sagas.getActiveByThread({ threadId }).pipe(Effect.orDie, Effect.map(Option.isSome));

  return CheckpointRevertGate.of({ assertThreadAvailable, isThreadBlocked });
});

export const CheckpointRevertGateLive = Layer.effect(CheckpointRevertGate, make);
