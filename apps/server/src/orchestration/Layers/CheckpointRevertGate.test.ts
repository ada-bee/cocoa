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
import { CheckpointRevertSagaRepository } from "../../persistence/Services/CheckpointRevertSagas.ts";
import { CheckpointRevertSagaRepositoryLive } from "../../persistence/Layers/CheckpointRevertSagas.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  CheckpointRevertGate,
  CheckpointRevertGateBlockedError,
} from "../Services/CheckpointRevertGate.ts";
import { CheckpointRevertGateLive } from "./CheckpointRevertGate.ts";

const createdAt = "2026-08-04T10:00:00.000Z";
const updatedAt = "2026-08-04T10:01:00.000Z";
const providerInstanceId = ProviderInstanceId.make("provider-gate-test");
const projectId = ProjectId.make("project-gate-test");

const createSaga = (source: string, threadId: ThreadId) => {
  const sourceRevertEventId = EventId.make(source);
  return {
    sourceRevertEventId,
    sourceCommandId: CommandId.make(`command:${source}`),
    providerInstanceId,
    projectId,
    threadId,
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
    restoreOperationId: makeRestoreCheckpointOperationId({ revertEventId: sourceRevertEventId }),
    staleTargets: [],
    createdAt,
  };
};

const persistence = CheckpointRevertSagaRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.layer(persistence)("CheckpointRevertGate", (it) => {
  it.effect("reads active and terminal state from SQLite across fresh gate layers", () =>
    Effect.gen(function* () {
      const sagas = yield* CheckpointRevertSagaRepository;
      const activeThread = ThreadId.make("thread-gate-active");
      const active = yield* sagas.getOrCreate(createSaga("event:gate:active", activeThread));

      const readFreshGate = <A, E>(
        effect: Effect.Effect<A, E, CheckpointRevertGate>,
      ): Effect.Effect<A, E, CheckpointRevertSagaRepository> =>
        effect.pipe(Effect.provide(CheckpointRevertGateLive));

      assert.isTrue(
        yield* readFreshGate(
          Effect.gen(function* () {
            const gate = yield* CheckpointRevertGate;
            return yield* gate.isThreadBlocked(activeThread);
          }),
        ),
      );
      const blocked = yield* Effect.result(
        readFreshGate(
          Effect.gen(function* () {
            const gate = yield* CheckpointRevertGate;
            yield* gate.assertThreadAvailable(activeThread);
          }),
        ),
      );
      assert.isTrue(blocked._tag === "Failure");
      if (blocked._tag === "Failure") {
        assert.instanceOf(blocked.failure, CheckpointRevertGateBlockedError);
        assert.equal(blocked.failure.sagaId, active.saga.sagaId);
      }

      const failedThread = ThreadId.make("thread-gate-failed");
      const failed = yield* sagas.getOrCreate(createSaga("event:gate:failed", failedThread));
      yield* sagas.failBeforeRollback({
        sagaId: failed.saga.sagaId,
        updatedAt,
        error: { code: "preflight_failed" },
      });

      const indeterminateThread = ThreadId.make("thread-gate-indeterminate");
      const indeterminate = yield* sagas.getOrCreate(
        createSaga("event:gate:indeterminate", indeterminateThread),
      );
      yield* sagas.markRollbackInFlight({
        sagaId: indeterminate.saga.sagaId,
        updatedAt,
      });
      yield* sagas.markIndeterminate({
        sagaId: indeterminate.saga.sagaId,
        updatedAt,
        error: { code: "rollback_indeterminate" },
      });

      const completedThread = ThreadId.make("thread-gate-completed");
      const completed = yield* sagas.getOrCreate(
        createSaga("event:gate:completed", completedThread),
      );
      yield* sagas.markRollbackInFlight({ sagaId: completed.saga.sagaId, updatedAt });
      yield* sagas.markRollbackCompleted({ sagaId: completed.saga.sagaId, updatedAt });
      yield* sagas.markRestoring({ sagaId: completed.saga.sagaId, updatedAt });
      yield* sagas.markRestored({ sagaId: completed.saga.sagaId, updatedAt });
      yield* sagas.beginDomainFinalization({
        sagaId: completed.saga.sagaId,
        finalizationStartedAt: updatedAt,
        updatedAt,
      });
      yield* sagas.markDomainFinalized({
        sagaId: completed.saga.sagaId,
        sequence: 42,
        updatedAt,
      });
      yield* sagas.complete({
        sagaId: completed.saga.sagaId,
        completedAt: updatedAt,
        updatedAt,
      });

      const terminalStates = yield* readFreshGate(
        Effect.gen(function* () {
          const gate = yield* CheckpointRevertGate;
          return yield* Effect.all(
            [failedThread, indeterminateThread, completedThread].map((threadId) =>
              gate.isThreadBlocked(threadId),
            ),
          );
        }),
      );
      assert.deepStrictEqual(terminalStates, [false, false, false]);
    }),
  );
});
