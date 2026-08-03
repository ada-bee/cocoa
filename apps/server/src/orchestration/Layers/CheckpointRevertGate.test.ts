import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeRestoreCheckpointOperationId } from "../../checkpointing/CheckpointIds.ts";
import {
  CheckpointRevertIntentRepository,
  type ProjectCheckpointRevertIntentInput,
} from "../../persistence/Services/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepository } from "../../persistence/Services/CheckpointRevertSagas.ts";
import { CheckpointRevertIntentRepositoryLive } from "../../persistence/Layers/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepositoryLive } from "../../persistence/Layers/CheckpointRevertSagas.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  CheckpointRevertGate,
  CheckpointRevertGateBlockedError,
} from "../Services/CheckpointRevertGate.ts";
import { CheckpointRevertGateLive } from "./CheckpointRevertGate.ts";

const createdAt = "2026-08-04T10:00:00.000Z";
const terminalAt = "2026-08-04T10:01:00.000Z";
const providerInstanceId = ProviderInstanceId.make("provider-gate-test");
const projectId = ProjectId.make("project-gate-test");

const intentInput = (source: string, sequence: number, threadId: ThreadId) =>
  ({
    sourceEventId: EventId.make(source),
    sourceSequence: sequence,
    sourceCommandId: CommandId.make(`command:${source}`),
    threadId,
    requestedTurnCount: 1,
    requestedAt: createdAt,
    createdAt,
  }) satisfies ProjectCheckpointRevertIntentInput;

const sagaInput = (intent: ProjectCheckpointRevertIntentInput) => ({
  sourceRevertEventId: intent.sourceEventId,
  sourceCommandId: intent.sourceCommandId,
  providerInstanceId,
  projectId,
  threadId: intent.threadId,
  providerDriverKind: ProviderDriverKind.make("codex"),
  continuationIdentitySha256: "a".repeat(64),
  requestedTurnCount: 1,
  preimageTurnCount: 2,
  preimage: { count: 2, sha256: "b".repeat(64) },
  target: { count: 1, sha256: "c".repeat(64) },
  retainedLogicalCheckpointId: "00000000-0000-4000-8000-000000000001",
  retainedExpectedCheckpointOid: "d".repeat(40),
  repositoryFingerprint: "e".repeat(64),
  repositoryObjectFormat: "sha1" as const,
  restoreOperationId: makeRestoreCheckpointOperationId({ revertEventId: intent.sourceEventId }),
  staleTargets: [],
  createdAt,
});

const persistence = Layer.mergeAll(
  CheckpointRevertIntentRepositoryLive,
  CheckpointRevertSagaRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(persistence)("CheckpointRevertGate", (it) => {
  it.effect("reads awaiting, linked, and terminal intent state across fresh gate layers", () =>
    Effect.gen(function* () {
      const intents = yield* CheckpointRevertIntentRepository;
      const sagas = yield* CheckpointRevertSagaRepository;

      const readFreshGate = <A, E>(
        effect: Effect.Effect<A, E, CheckpointRevertGate>,
      ): Effect.Effect<A, E, CheckpointRevertIntentRepository> =>
        effect.pipe(Effect.provide(CheckpointRevertGateLive));

      const awaitingThread = ThreadId.make("thread-gate-awaiting");
      const awaiting = intentInput("event:gate:awaiting", 1, awaitingThread);
      yield* intents.projectInTransaction(awaiting);
      assert.isTrue(
        yield* readFreshGate(
          Effect.gen(function* () {
            const gate = yield* CheckpointRevertGate;
            return yield* gate.isThreadBlocked(awaitingThread);
          }),
        ),
      );
      const awaitingBlocked = yield* Effect.result(
        readFreshGate(
          Effect.gen(function* () {
            const gate = yield* CheckpointRevertGate;
            yield* gate.assertThreadAvailable(awaitingThread);
          }),
        ),
      );
      assert.equal(awaitingBlocked._tag, "Failure");
      if (awaitingBlocked._tag === "Failure") {
        assert.instanceOf(awaitingBlocked.failure, CheckpointRevertGateBlockedError);
        assert.equal(awaitingBlocked.failure.sourceEventId, awaiting.sourceEventId);
        assert.isUndefined(awaitingBlocked.failure.sagaId);
      }

      const linkedThread = ThreadId.make("thread-gate-linked");
      const linkedIntent = intentInput("event:gate:linked", 2, linkedThread);
      yield* intents.projectInTransaction(linkedIntent);
      const linkedSaga = (yield* sagas.getOrCreate(sagaInput(linkedIntent))).saga;
      yield* intents.linkSaga({
        sourceEventId: linkedIntent.sourceEventId,
        sagaId: linkedSaga.sagaId,
      });
      const linkedBlocked = yield* Effect.result(
        readFreshGate(
          Effect.gen(function* () {
            const gate = yield* CheckpointRevertGate;
            yield* gate.assertThreadAvailable(linkedThread);
          }),
        ),
      );
      assert.equal(linkedBlocked._tag, "Failure");
      if (linkedBlocked._tag === "Failure") {
        assert.instanceOf(linkedBlocked.failure, CheckpointRevertGateBlockedError);
        assert.equal(linkedBlocked.failure.sourceEventId, linkedIntent.sourceEventId);
        assert.equal(linkedBlocked.failure.sagaId, linkedSaga.sagaId);
      }

      yield* intents.markTerminal({
        sourceEventId: linkedIntent.sourceEventId,
        sagaId: linkedSaga.sagaId,
        outcome: "indeterminate",
        terminalAt,
      });
      const preSagaFailedThread = ThreadId.make("thread-gate-pre-saga-failed");
      const preSagaFailed = intentInput("event:gate:pre-saga-failed", 3, preSagaFailedThread);
      yield* intents.projectInTransaction(preSagaFailed);
      yield* intents.markTerminal({
        sourceEventId: preSagaFailed.sourceEventId,
        sagaId: null,
        outcome: "failed",
        terminalAt,
      });

      const terminalStates = yield* readFreshGate(
        Effect.gen(function* () {
          const gate = yield* CheckpointRevertGate;
          return yield* Effect.all(
            [linkedThread, preSagaFailedThread].map((threadId) => gate.isThreadBlocked(threadId)),
          );
        }),
      );
      assert.deepStrictEqual(terminalStates, [false, false]);
    }),
  );
});
