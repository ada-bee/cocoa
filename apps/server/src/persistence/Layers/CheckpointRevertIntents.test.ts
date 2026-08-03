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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeRestoreCheckpointOperationId } from "../../checkpointing/CheckpointIds.ts";
import { runCocoaMigrations } from "../CocoaMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  CheckpointRevertIntentConflictError,
  CheckpointRevertIntentRepository,
  CheckpointRevertIntentTransitionError,
  type ProjectCheckpointRevertIntentInput,
} from "../Services/CheckpointRevertIntents.ts";
import {
  CheckpointRevertSagaRepository,
  type CreateCheckpointRevertSagaInput,
} from "../Services/CheckpointRevertSagas.ts";
import { CheckpointRevertIntentRepositoryLive } from "./CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepositoryLive } from "./CheckpointRevertSagas.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const now = "2026-08-04T11:00:00.000Z";
const later = "2026-08-04T11:01:00.000Z";
const providerInstanceId = ProviderInstanceId.make("codex-macbook-air");
const projectId = ProjectId.make("cocoa");
const retainedId = "ffffffff-ffff-4fff-bfff-ffffffffffff";

const intentInput = (
  suffix: string,
  sourceSequence: number,
  threadId = ThreadId.make(`thread-revert-intent-${suffix}`),
): ProjectCheckpointRevertIntentInput => ({
  sourceEventId: EventId.make(`event:revert-intent:${suffix}`),
  sourceSequence,
  sourceCommandId: CommandId.make(`command:revert-intent:${suffix}`),
  threadId,
  requestedTurnCount: 1,
  requestedAt: now,
  createdAt: now,
});

const sagaInput = (
  intent: ProjectCheckpointRevertIntentInput,
): CreateCheckpointRevertSagaInput => ({
  sourceRevertEventId: intent.sourceEventId,
  sourceCommandId: intent.sourceCommandId,
  providerInstanceId,
  projectId,
  threadId: intent.threadId,
  providerDriverKind: ProviderDriverKind.make("codex"),
  continuationIdentitySha256: "a".repeat(64),
  requestedTurnCount: intent.requestedTurnCount,
  preimageTurnCount: 2,
  preimage: { count: 2, sha256: "b".repeat(64) },
  target: { count: intent.requestedTurnCount, sha256: "c".repeat(64) },
  retainedLogicalCheckpointId: retainedId,
  retainedExpectedCheckpointOid: "d".repeat(40),
  repositoryFingerprint: "e".repeat(64),
  repositoryObjectFormat: "sha1",
  restoreOperationId: makeRestoreCheckpointOperationId({ revertEventId: intent.sourceEventId }),
  staleTargets: [],
  createdAt: now,
});

const repositories = Layer.mergeAll(
  CheckpointRevertIntentRepositoryLive,
  CheckpointRevertSagaRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(repositories)("CheckpointRevertIntentRepository", (it) => {
  it.effect("projects exact immutable requests and rejects every drift", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointRevertIntentRepository;
      const input = intentInput("exact", 100);
      const first = yield* repository.projectInTransaction(input);
      const repeated = yield* repository.projectInTransaction(input);
      assert.deepStrictEqual(first, repeated);

      const conflict = yield* Effect.flip(
        repository.projectInTransaction({ ...input, requestedTurnCount: 2 }),
      );
      assert.isTrue(Schema.is(CheckpointRevertIntentConflictError)(conflict));
    }),
  );

  it.effect("links one exact saga and terminalizes idempotently", () =>
    Effect.gen(function* () {
      const intents = yield* CheckpointRevertIntentRepository;
      const sagas = yield* CheckpointRevertSagaRepository;
      const input = intentInput("linked", 101);
      yield* intents.projectInTransaction(input);
      const saga = (yield* sagas.getOrCreate(sagaInput(input))).saga;
      const foreignInput = intentInput("foreign-saga", 103);
      const foreignSaga = (yield* sagas.getOrCreate(sagaInput(foreignInput))).saga;
      const foreignLink = yield* Effect.flip(
        intents.linkSaga({
          sourceEventId: input.sourceEventId,
          sagaId: foreignSaga.sagaId,
        }),
      );
      assert.isTrue(Schema.is(CheckpointRevertIntentConflictError)(foreignLink));

      const linked = yield* intents.linkSaga({
        sourceEventId: input.sourceEventId,
        sagaId: saga.sagaId,
      });
      yield* intents.linkSaga({ sourceEventId: input.sourceEventId, sagaId: saga.sagaId });
      assert.equal(linked.state, "linked");
      assert.equal(linked.sagaId, saga.sagaId);

      const terminal = {
        sourceEventId: input.sourceEventId,
        sagaId: saga.sagaId,
        outcome: "completed" as const,
        terminalAt: later,
      };
      yield* intents.markTerminal(terminal);
      yield* intents.markTerminal(terminal);
      const terminalDrift = yield* Effect.flip(
        intents.markTerminal({ ...terminal, terminalAt: now }),
      );
      assert.isTrue(Schema.is(CheckpointRevertIntentTransitionError)(terminalDrift));
      assert.isFalse(
        (yield* intents.listRecovery({ after: null, limit: 500 })).some(
          (row) => row.sourceEventId === input.sourceEventId,
        ),
      );
    }),
  );

  it.effect("records and excludes an exact terminal failure before saga creation", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointRevertIntentRepository;
      const input = intentInput("pre-saga-failed", 102);
      yield* repository.projectInTransaction(input);
      const terminal = {
        sourceEventId: input.sourceEventId,
        sagaId: null,
        outcome: "failed" as const,
        terminalAt: later,
      };
      yield* repository.markTerminal(terminal);
      yield* repository.markTerminal(terminal);
      const row = Option.getOrThrow(
        yield* repository.getBySourceEventId({ sourceEventId: input.sourceEventId }),
      );
      assert.equal(row.state, "terminal");
      assert.isNull(row.sagaId);
      assert.equal(row.terminalOutcome, "failed");
      assert.isFalse(
        (yield* repository.listRecovery({ after: null, limit: 500 })).some(
          (candidate) => candidate.sourceEventId === input.sourceEventId,
        ),
      );
    }),
  );

  it.effect("admits one unfinished intent per thread and releases it only at terminal", () =>
    Effect.gen(function* () {
      const intents = yield* CheckpointRevertIntentRepository;
      const sagas = yield* CheckpointRevertSagaRepository;
      const threadId = ThreadId.make("thread-revert-intent-active-unique");
      const first = intentInput("active-first", 110, threadId);
      const second = intentInput("active-second", 111, threadId);

      yield* intents.projectInTransaction(first);
      assert.equal(
        Option.getOrThrow(yield* intents.getActiveByThread({ threadId })).state,
        "awaiting_saga",
      );
      const conflict = yield* Effect.flip(intents.projectInTransaction(second));
      assert.isTrue(Schema.is(CheckpointRevertIntentConflictError)(conflict));

      const saga = (yield* sagas.getOrCreate(sagaInput(first))).saga;
      yield* intents.linkSaga({ sourceEventId: first.sourceEventId, sagaId: saga.sagaId });
      const linked = Option.getOrThrow(yield* intents.getActiveByThread({ threadId }));
      assert.equal(linked.state, "linked");
      assert.equal(linked.sagaId, saga.sagaId);

      yield* intents.markTerminal({
        sourceEventId: first.sourceEventId,
        sagaId: saga.sagaId,
        outcome: "failed",
        terminalAt: later,
      });
      assert.isTrue(Option.isNone(yield* intents.getActiveByThread({ threadId })));
      const replacement = yield* intents.projectInTransaction(second);
      assert.equal(replacement.state, "awaiting_saga");
      assert.equal(
        Option.getOrThrow(yield* intents.getActiveByThread({ threadId })).sourceEventId,
        second.sourceEventId,
      );
    }),
  );

  it.effect("uses bounded stable keyset recovery for awaiting and linked rows", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointRevertIntentRepository;
      const inputs = [
        intentInput("page-a", 200),
        intentInput("page-b", 201),
        intentInput("page-c", 202),
      ];
      yield* Effect.forEach(inputs, repository.projectInTransaction, { discard: true });
      const first = yield* repository.listRecovery({
        after: { sourceSequence: 199, sourceEventId: EventId.make("before") },
        limit: 2,
      });
      assert.deepStrictEqual(
        first.map((row) => row.sourceSequence),
        [200, 201],
      );
      const last = first[1];
      assert.isDefined(last);
      const second = yield* repository.listRecovery({
        after: { sourceSequence: last.sourceSequence, sourceEventId: last.sourceEventId },
        limit: 2,
      });
      assert.deepStrictEqual(
        second.map((row) => row.sourceSequence),
        [202],
      );
    }),
  );
});

it.layer(NodeServices.layer)("Checkpoint revert intent crash recovery", (it) => {
  it.effect("recovers a committed request after restart before any live consumer sees it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cocoa-revert-intent-" });
      const databasePath = path.join(directory, "state.sqlite");
      const input = intentInput("restart", 300);

      const databaseLayer = CheckpointRevertIntentRepositoryLive.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
      );
      const runWithDatabase = <A, E>(
        effect: Effect.Effect<A, E, CheckpointRevertIntentRepository | SqlClient.SqlClient>,
      ) => effect.pipe(Effect.provide(databaseLayer), Effect.scoped);

      yield* runWithDatabase(
        Effect.gen(function* () {
          yield* runCocoaMigrations();
          const repository = yield* CheckpointRevertIntentRepository;
          yield* repository.projectInTransaction(input);
        }),
      );

      const recovered = yield* runWithDatabase(
        Effect.gen(function* () {
          yield* runCocoaMigrations();
          const repository = yield* CheckpointRevertIntentRepository;
          return yield* repository.listRecovery({ after: null, limit: 500 });
        }),
      );
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.sourceEventId, input.sourceEventId);
      assert.equal(recovered[0]?.state, "awaiting_saga");
    }),
  );
});
