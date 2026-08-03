import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointRevertReactor } from "../Services/CheckpointRevertReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { PostTurnCheckpointReactor } from "../Services/PostTurnCheckpointReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { ProviderGenerationRecoveryReactor } from "../../provider/Services/ProviderGenerationRecoveryReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerGenerationRecoveryReactor = yield* ProviderGenerationRecoveryReactor;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const postTurnCheckpointReactor = yield* PostTurnCheckpointReactor;
  const checkpointRevertReactor = yield* CheckpointRevertReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* postTurnCheckpointReactor.start();
    yield* providerGenerationRecoveryReactor.start();
    yield* providerCommandReactor.start();
    yield* checkpointRevertReactor.start();
    yield* threadDeletionReactor.start();
    yield* agentAwarenessRelay.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const makeCoreOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerGenerationRecoveryReactor = yield* ProviderGenerationRecoveryReactor;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const postTurnCheckpointReactor = yield* PostTurnCheckpointReactor;
  const checkpointRevertReactor = yield* CheckpointRevertReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* postTurnCheckpointReactor.start();
    yield* providerGenerationRecoveryReactor.start();
    yield* providerCommandReactor.start();
    yield* checkpointRevertReactor.start();
    yield* threadDeletionReactor.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);

/** Cocoa gateway orchestration excludes the hosted agent-awareness relay. */
export const CoreOrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeCoreOrchestrationReactor,
);
