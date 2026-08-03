import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeDeleteCheckpointOperationId,
  makeRestoreCheckpointOperationId,
} from "../../checkpointing/CheckpointIds.ts";
import { runCocoaMigrations } from "../CocoaMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  CheckpointRevertActiveSagaConflictError,
  CheckpointRevertSagaConflictError,
  CheckpointRevertSagaRepository,
  CheckpointRevertSagaTransitionError,
  type CreateCheckpointRevertSagaInput,
} from "../Services/CheckpointRevertSagas.ts";
import { CheckpointRevertSagaRepositoryLive } from "./CheckpointRevertSagas.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const now = "2026-08-04T10:00:00.000Z";
const t1 = "2026-08-04T10:01:00.000Z";
const t2 = "2026-08-04T10:02:00.000Z";
const providerInstanceId = ProviderInstanceId.make("codex-macbook-air");
const projectId = ProjectId.make("cocoa");
const threadId = ThreadId.make("thread-revert-persistence");
const retainedId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const retainedOid = "e".repeat(40);

const logicalId = (ordinal: number) =>
  `00000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;

const inputFor = (
  source: string,
  staleTargets: CreateCheckpointRevertSagaInput["staleTargets"] = [],
  ownerThreadId: ThreadId = threadId,
): CreateCheckpointRevertSagaInput => {
  const sourceRevertEventId = EventId.make(source);
  const requestedTurnCount = staleTargets.length === 0 ? 1 : 3;
  const preimageTurnCount =
    staleTargets.length === 0 ? 2 : requestedTurnCount + staleTargets.length;
  return {
    sourceRevertEventId,
    sourceCommandId: CommandId.make(`command:${source}`),
    providerInstanceId,
    projectId,
    threadId: ownerThreadId,
    providerDriverKind: ProviderDriverKind.make("codex"),
    continuationIdentitySha256: "a".repeat(64),
    requestedTurnCount,
    preimageTurnCount,
    preimage: { count: preimageTurnCount, sha256: "b".repeat(64) },
    target: { count: requestedTurnCount, sha256: "c".repeat(64) },
    retainedLogicalCheckpointId: retainedId,
    retainedExpectedCheckpointOid: retainedOid,
    repositoryFingerprint: "d".repeat(64),
    repositoryObjectFormat: "sha1",
    restoreOperationId: makeRestoreCheckpointOperationId({ revertEventId: sourceRevertEventId }),
    staleTargets,
    createdAt: now,
  };
};

const repositoryLayer = it.layer(
  CheckpointRevertSagaRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

repositoryLayer("CheckpointRevertSagaRepository", (it) => {
  it.effect("atomically deduplicates exact intents and materializes 257 stable targets", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointRevertSagaRepository;
      const staleTargets = Array.from({ length: 257 }, (_, index) => ({
        checkpointTurnCount: 4 + index,
        logicalCheckpointId: logicalId(257 - index),
        expectedCheckpointOid: index.toString(16).padStart(40, "0"),
      }));
      const input = inputFor("event:revert:257", staleTargets);
      const results = yield* Effect.all(
        [repository.getOrCreate(input), repository.getOrCreate(input)],
        { concurrency: "unbounded" },
      );

      assert.equal(results.filter((result) => result.inserted).length, 1);
      const persisted = results[0];
      assert.equal(persisted?.staleTargets.length, 257);
      assert.deepStrictEqual(
        persisted?.staleTargets.map((target) => target.ordinal),
        Array.from({ length: 257 }, (_, index) => index),
      );
      assert.equal(persisted?.staleTargets[255]?.batchOrdinal, 0);
      assert.equal(persisted?.staleTargets[256]?.batchOrdinal, 1);
      assert.equal(
        persisted?.staleTargets[0]?.deleteOperationId,
        makeDeleteCheckpointOperationId({
          revertEventId: input.sourceRevertEventId,
          batchOrdinal: 0,
        }),
      );
      assert.equal(
        persisted?.staleTargets[256]?.deleteOperationId,
        makeDeleteCheckpointOperationId({
          revertEventId: input.sourceRevertEventId,
          batchOrdinal: 1,
        }),
      );
      assert.notInclude(
        persisted?.staleTargets.map((target) => target.logicalCheckpointId) ?? [],
        retainedId,
      );

      const conflict = yield* Effect.flip(
        repository.getOrCreate({ ...input, repositoryFingerprint: "f".repeat(64) }),
      );
      assert.isTrue(Schema.is(CheckpointRevertSagaConflictError)(conflict));
    }),
  );

  it.effect("enforces rollback barriers and exact finalization CAS", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointRevertSagaRepository;
      const created = yield* repository.getOrCreate(
        inputFor("event:revert:transitions", [], ThreadId.make("thread-revert-transitions")),
      );
      const sagaId = created.saga.sagaId;

      yield* repository.markRollbackInFlight({ sagaId, updatedAt: t1 });
      const cannotFail = yield* Effect.flip(
        repository.failBeforeRollback({
          sagaId,
          updatedAt: t1,
          error: { code: "rollback_failed" },
        }),
      );
      assert.isTrue(Schema.is(CheckpointRevertSagaTransitionError)(cannotFail));
      yield* repository.markRollbackOutcomeUnknown({
        sagaId,
        updatedAt: t1,
        error: { code: "disconnected" },
      });
      yield* repository.markRollbackCompleted({ sagaId, updatedAt: t1 });
      yield* repository.markRestoring({ sagaId, updatedAt: t1 });
      yield* repository.markRestored({ sagaId, updatedAt: t1 });
      yield* repository.beginDomainFinalization({
        sagaId,
        finalizationStartedAt: t1,
        updatedAt: t1,
      });
      const beforeDispatch = Option.getOrThrow(yield* repository.getBySagaId({ sagaId }));
      assert.equal(beforeDispatch.state, "restored");
      assert.equal(beforeDispatch.finalizationStartedAt, t1);
      assert.isNull(beforeDispatch.finalizationSequence);

      yield* repository.markDomainFinalized({ sagaId, sequence: 42, updatedAt: t2 });
      yield* repository.markDomainFinalized({ sagaId, sequence: 42, updatedAt: t2 });
      const differentSequence = yield* Effect.flip(
        repository.markDomainFinalized({ sagaId, sequence: 43, updatedAt: t2 }),
      );
      assert.isTrue(Schema.is(CheckpointRevertSagaTransitionError)(differentSequence));
      yield* repository.complete({ sagaId, completedAt: t2, updatedAt: t2 });

      const recovery = yield* repository.listRecoveryPage({ after: null, limit: 500 });
      assert.isFalse(recovery.items.some((saga) => saga.sagaId === sagaId));
    }),
  );

  it.effect("pages only recoverable rows by the stable createdAt/sagaId key", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointRevertSagaRepository;
      yield* Effect.forEach(
        ["event:revert:page:a", "event:revert:page:b", "event:revert:page:c"],
        (source, index) =>
          repository.getOrCreate(
            inputFor(source, [], ThreadId.make(`thread-revert-page-${index}`)),
          ),
        { discard: true },
      );
      const first = yield* repository.listRecoveryPage({ after: null, limit: 2 });
      assert.equal(first.items.length, 2);
      assert.isNotNull(first.nextCursor);
      const second = yield* repository.listRecoveryPage({ after: first.nextCursor, limit: 2 });
      assert.isTrue(second.items.length >= 1);
      assert.isTrue(
        first.items.every((left) => second.items.every((right) => left.sagaId !== right.sagaId)),
      );
    }),
  );

  it.effect(
    "allows one active saga per thread and excludes every terminal state from recovery",
    () =>
      Effect.gen(function* () {
        const repository = yield* CheckpointRevertSagaRepository;
        const concurrentThread = ThreadId.make("thread-revert-active-concurrent");
        const contenders = yield* Effect.all(
          ["event:revert:concurrent:a", "event:revert:concurrent:b"].map((source) =>
            Effect.result(repository.getOrCreate(inputFor(source, [], concurrentThread))),
          ),
          { concurrency: "unbounded" },
        );
        assert.equal(contenders.filter(Result.isSuccess).length, 1);
        assert.equal(contenders.filter(Result.isFailure).length, 1);
        assert.isTrue(
          contenders.some(
            (result) =>
              Result.isFailure(result) &&
              Schema.is(CheckpointRevertActiveSagaConflictError)(result.failure),
          ),
        );

        const activeThread = ThreadId.make("thread-revert-active-uniqueness");
        const first = yield* repository.getOrCreate(
          inputFor("event:revert:active:first", [], activeThread),
        );
        assert.equal(
          Option.getOrThrow(yield* repository.getActiveByThread({ threadId: activeThread })).sagaId,
          first.saga.sagaId,
        );
        const conflict = yield* Effect.flip(
          repository.getOrCreate(inputFor("event:revert:active:second", [], activeThread)),
        );
        assert.isTrue(Schema.is(CheckpointRevertActiveSagaConflictError)(conflict));

        yield* repository.failBeforeRollback({
          sagaId: first.saga.sagaId,
          updatedAt: t1,
          error: { code: "preflight_failed" },
        });
        assert.isTrue(
          Option.isNone(yield* repository.getActiveByThread({ threadId: activeThread })),
        );
        const replacement = yield* repository.getOrCreate(
          inputFor("event:revert:active:second", [], activeThread),
        );

        const indeterminateThread = ThreadId.make("thread-revert-terminal-indeterminate");
        const indeterminate = yield* repository.getOrCreate(
          inputFor("event:revert:terminal:indeterminate", [], indeterminateThread),
        );
        yield* repository.markRollbackInFlight({
          sagaId: indeterminate.saga.sagaId,
          updatedAt: t1,
        });
        yield* repository.markIndeterminate({
          sagaId: indeterminate.saga.sagaId,
          updatedAt: t1,
          error: { code: "rollback_ambiguous" },
        });

        const recovery = yield* repository.listRecoveryPage({ after: null, limit: 500 });
        assert.isFalse(recovery.items.some((saga) => saga.sagaId === first.saga.sagaId));
        assert.isFalse(recovery.items.some((saga) => saga.sagaId === indeterminate.saga.sagaId));
        assert.isTrue(recovery.items.some((saga) => saga.sagaId === replacement.saga.sagaId));
      }),
  );
});

it.layer(NodeServices.layer)("Checkpoint revert saga restart recovery", (it) => {
  it.effect("reopens SQLite with the barrier and hashed continuation identity intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cocoa-revert-saga-" });
      const databasePath = path.join(directory, "state.sqlite");
      const input = inputFor("event:revert:restart");

      const databaseLayer = CheckpointRevertSagaRepositoryLive.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
      );
      const runWithDatabase = <A, E>(
        effect: Effect.Effect<A, E, CheckpointRevertSagaRepository | SqlClient.SqlClient>,
      ) => effect.pipe(Effect.provide(databaseLayer), Effect.scoped);

      yield* runWithDatabase(
        Effect.gen(function* () {
          yield* runCocoaMigrations();
          const repository = yield* CheckpointRevertSagaRepository;
          const created = yield* repository.getOrCreate(input);
          yield* repository.markRollbackInFlight({ sagaId: created.saga.sagaId, updatedAt: t1 });
          yield* repository.markRollbackOutcomeUnknown({
            sagaId: created.saga.sagaId,
            updatedAt: t1,
            error: { code: "disconnected" },
          });
        }),
      );

      const recovered = yield* runWithDatabase(
        Effect.gen(function* () {
          yield* runCocoaMigrations();
          const repository = yield* CheckpointRevertSagaRepository;
          const deduplicated = yield* repository.getOrCreate(input);
          assert.isFalse(deduplicated.inserted);
          return yield* repository.listRecoveryPage({ after: null, limit: 500 });
        }),
      );
      const saga = recovered.items.find(
        (candidate) => candidate.sourceRevertEventId === input.sourceRevertEventId,
      );
      assert.equal(saga?.state, "rollback_outcome_unknown");
      assert.equal(saga?.continuationIdentitySha256, input.continuationIdentitySha256);
    }),
  );
});
