import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeRestoreCheckpointOperationId } from "../../checkpointing/CheckpointIds.ts";
import { CheckpointRevertIntentRepositoryLive } from "../../persistence/Layers/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepositoryLive } from "../../persistence/Layers/CheckpointRevertSagas.ts";
import { ProviderCheckpointOperationRepositoryLive } from "../../persistence/Layers/ProviderCheckpointOperations.ts";
import { ProjectionCheckpointRepositoryLive } from "../../persistence/Layers/ProjectionCheckpoints.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { CheckpointRevertIntentRepository } from "../../persistence/Services/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepository } from "../../persistence/Services/CheckpointRevertSagas.ts";
import {
  ProviderCheckpointOperationRepository,
  type PrepareProviderCheckpointOperationInput,
} from "../../persistence/Services/ProviderCheckpointOperations.ts";
import * as ProjectRepository from "../../project/ProjectRepository.ts";
import type {
  ProviderVcsCheckpointCapability,
  ProviderVcsRepository,
} from "../../provider/ProviderVcsAdapter.ts";
import {
  PROVIDER_TURN_SEQUENCE_DIGEST_VERSION,
  type ProviderTurnSequenceDigest,
} from "../../provider/ProviderTurnSequenceDigest.ts";
import {
  ProviderService,
  type ProviderConversationInspection,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { CheckpointRevertGate } from "../Services/CheckpointRevertGate.ts";
import { CheckpointRevertReactor } from "../Services/CheckpointRevertReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { CheckpointRevertGateLive } from "./CheckpointRevertGate.ts";
import { CheckpointRevertReactorLive } from "./CheckpointRevertReactor.ts";

const createdAt = "2026-08-04T12:00:00.000Z";
const providerInstanceId = ProviderInstanceId.make("provider-revert-recovery");
const projectId = ProjectId.make("project-revert-recovery");
const threadId = ThreadId.make("thread-revert-recovery");
const sourceEventId = EventId.make("event-revert-recovery");
const sourceCommandId = CommandId.make("command-revert-recovery");
const fingerprint = "a".repeat(64);
const retainedLogicalCheckpointId = "00000000-0000-4000-8000-000000000001";
const retainedOperationId = "00000000-0000-4000-8000-000000000002";
const retainedOid = "e".repeat(40);
const retainedTreeOid = "f".repeat(40);
const restoreDigest = "1".repeat(64);

const digest = (turnCount: number, sha256: string): ProviderTurnSequenceDigest => ({
  version: PROVIDER_TURN_SEQUENCE_DIGEST_VERSION,
  turnCount,
  sha256,
});

interface FixtureState {
  inspectCount: number;
  rollbackCount: number;
  nextSequence: number;
  readonly commands: Array<OrchestrationCommand>;
  readonly commandSequences: Map<string, number>;
  readonly events: Array<string>;
  inspectedPreimage: ProviderTurnSequenceDigest;
}

const makeState = (): FixtureState => ({
  inspectCount: 0,
  rollbackCount: 0,
  nextSequence: 100,
  commands: [],
  commandSequences: new Map(),
  events: [],
  inspectedPreimage: digest(2, "d".repeat(64)),
});

const inspection = (preimage: ProviderTurnSequenceDigest): ProviderConversationInspection => ({
  threadId,
  providerInstanceId,
  binding: {
    driverKind: ProviderDriverKind.make("codex"),
    continuationIdentitySha256: "b".repeat(64),
  },
  preimage,
  target: digest(1, "c".repeat(64)),
});

const providerService = (state: FixtureState): ProviderServiceShape =>
  ({
    inspectConversation: () =>
      Effect.sync(() => {
        state.inspectCount += 1;
        state.events.push("provider.inspect");
        return inspection(state.inspectedPreimage);
      }),
    rollbackConversationChecked: () =>
      Effect.sync(() => {
        state.rollbackCount += 1;
        state.events.push("provider.rollback");
        return inspection(digest(1, "c".repeat(64)));
      }),
  }) as unknown as ProviderServiceShape;

const engineService = (state: FixtureState): OrchestrationEngineShape => ({
  dispatch: (command) =>
    Effect.sync(() => {
      const existing = state.commandSequences.get(command.commandId);
      if (existing !== undefined) return { sequence: existing };
      const sequence = state.nextSequence++;
      state.commandSequences.set(command.commandId, sequence);
      state.commands.push(command);
      state.events.push(`domain.${command.type}`);
      return { sequence };
    }),
  readEvents: () => Stream.empty,
  streamDomainEvents: Stream.empty,
  latestSequence: Effect.succeed(0),
});

const projectionService = {} as ProjectionSnapshotQueryShape;

const checkpointCapability = (state: FixtureState): ProviderVcsCheckpointCapability => ({
  binding: {
    worktreeRoot: { canonicalPath: "/remote/repo", device: "1", inode: "2" },
    gitDirectoryRoot: { canonicalPath: "/remote/repo/.git", device: "1", inode: "3" },
    gitCommonDirectoryRoot: { canonicalPath: "/remote/repo/.git", device: "1", inode: "3" },
    objectFormat: "sha1",
    fingerprint,
  },
  prepareCapture: () => Effect.die("unused"),
  diff: () => Effect.die("unused"),
  prepareRestore: (input) =>
    Effect.succeed({
      generationId: 7,
      requestSha256: restoreDigest,
      execute: Effect.sync(() => {
        state.events.push("checkpoint.restore.execute");
        return {
          operation: "restore" as const,
          receipt: {
            operation: "restore" as const,
            operationId: input.operationId,
            receiptRef: `refs/cocoa/checkpoint-receipts/v1/${input.operationId}`,
            requestSha256: restoreDigest,
            repositoryFingerprint: fingerprint,
            status: "succeeded" as const,
            checkpointId: input.checkpointId,
            checkpointRef: `refs/cocoa/checkpoints/v1/${input.checkpointId}`,
            checkpointOid: retainedOid,
          },
          receiptObjectOid: "2".repeat(40),
        };
      }),
    }),
  prepareDelete: () => Effect.die("no stale checkpoints"),
  observe: () => Effect.die("no ambiguous checkpoint operation"),
});

const providerRepository = (state: FixtureState): ProviderVcsRepository => ({
  identity: { kind: "git", rootPath: "/remote/repo", commonDirectoryPath: "/remote/repo/.git" },
  capabilities: { status: true, refs: true, remotes: true, reviewDiff: true },
  checkpoints: checkpointCapability(state),
  getStatus: () => Effect.die("unused"),
  listRefs: () => Effect.die("unused"),
  listRemotes: () => Effect.die("unused"),
  getReviewDiff: () => Effect.die("unused"),
});

const testLayer = (state: FixtureState) => {
  const repositories = Layer.mergeAll(
    CheckpointRevertIntentRepositoryLive,
    CheckpointRevertSagaRepositoryLive,
    ProviderCheckpointOperationRepositoryLive,
    ProjectionCheckpointRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
  const dependencies = Layer.mergeAll(
    repositories,
    Layer.succeed(ProviderService, providerService(state)),
    Layer.succeed(OrchestrationEngineService, engineService(state)),
    Layer.succeed(ProjectionSnapshotQuery, projectionService),
    Layer.succeed(ProjectRepository.ProjectRepository, {
      resolve: () => Effect.succeed(providerRepository(state)),
    }),
  );
  return Layer.mergeAll(
    CheckpointRevertReactorLive.pipe(Layer.provideMerge(dependencies)),
    CheckpointRevertGateLive.pipe(Layer.provideMerge(repositories)),
    dependencies,
  );
};

const seedRetainedCheckpoint = Effect.fn("seedRetainedCheckpoint")(function* () {
  const operations = yield* ProviderCheckpointOperationRepository;
  const input: PrepareProviderCheckpointOperationInput = {
    operationId: retainedOperationId,
    logicalCheckpointId: retainedLogicalCheckpointId,
    providerInstanceId,
    projectId,
    threadId,
    turnId: TurnId.make("turn-retained"),
    operationKind: "capture",
    intentContext: {
      kind: "post_turn",
      sourceEventId: EventId.make("event-retained-capture"),
      turnId: TurnId.make("turn-retained"),
      baselineCheckpointId: "00000000-0000-4000-8000-000000000003",
      checkpointTurnCount: 1,
      completedAt: createdAt,
      outcome: "completed",
    },
    canonicalRequest: {
      operation: "capture",
      operationId: retainedOperationId,
      checkpointId: retainedLogicalCheckpointId,
    },
    requestSha256: "3".repeat(64),
    repository: { fingerprint, objectFormat: "sha1" },
    providerGeneration: 1,
    preparedAt: createdAt,
  };
  yield* operations.prepare(input);
  yield* operations.markInFlight({
    operationId: retainedOperationId,
    providerGeneration: 1,
    updatedAt: createdAt,
  });
  const result = {
    operation: "capture" as const,
    receipt: {
      operation: "capture" as const,
      operationId: retainedOperationId,
      receiptRef: `refs/cocoa/checkpoint-receipts/v1/${retainedOperationId}`,
      requestSha256: "3".repeat(64),
      repositoryFingerprint: fingerprint,
      status: "succeeded" as const,
      checkpointId: retainedLogicalCheckpointId,
      checkpointRef: `refs/cocoa/checkpoints/v1/${retainedLogicalCheckpointId}`,
      checkpointOid: retainedOid,
      treeOid: retainedTreeOid,
    },
    receiptObjectOid: "4".repeat(40),
  };
  yield* operations.finalizeCapture({
    completion: {
      operationId: retainedOperationId,
      updatedAt: createdAt,
      receipt: result.receipt,
      result,
    },
    checkpoint: {
      logicalCheckpointId: retainedLogicalCheckpointId,
      providerInstanceId,
      projectId,
      threadId,
      turnId: TurnId.make("turn-retained"),
      repository: input.repository,
      captureOperationId: retainedOperationId,
      checkpointRef: result.receipt.checkpointRef,
      checkpointOid: retainedOid,
      treeOid: retainedTreeOid,
      receiptRef: result.receipt.receiptRef,
      receiptObjectOid: result.receiptObjectOid,
      createdAt,
      updatedAt: createdAt,
    },
  });
});

it.effect(
  "recovers an ambiguous provider rollback by inspection only and terminalizes divergence",
  () => {
    const state = makeState();
    return Effect.gen(function* () {
      const intents = yield* CheckpointRevertIntentRepository;
      const sagas = yield* CheckpointRevertSagaRepository;
      const reactor = yield* CheckpointRevertReactor;
      const gate = yield* CheckpointRevertGate;

      yield* intents.projectInTransaction({
        sourceEventId,
        sourceSequence: 10,
        sourceCommandId,
        threadId,
        requestedTurnCount: 1,
        requestedAt: createdAt,
        createdAt,
      });
      const created = yield* sagas.getOrCreate({
        sourceRevertEventId: sourceEventId,
        sourceCommandId,
        providerInstanceId,
        projectId,
        threadId,
        providerDriverKind: ProviderDriverKind.make("codex"),
        continuationIdentitySha256: "b".repeat(64),
        requestedTurnCount: 1,
        preimageTurnCount: 2,
        preimage: { count: 2, sha256: "d".repeat(64) },
        target: { count: 1, sha256: "c".repeat(64) },
        retainedLogicalCheckpointId: "00000000-0000-4000-8000-000000000001",
        retainedExpectedCheckpointOid: "e".repeat(40),
        repositoryFingerprint: fingerprint,
        repositoryObjectFormat: "sha1",
        restoreOperationId: makeRestoreCheckpointOperationId({ revertEventId: sourceEventId }),
        staleTargets: [],
        createdAt,
      });
      yield* intents.linkSaga({ sourceEventId, sagaId: created.saga.sagaId });
      yield* sagas.markRollbackInFlight({ sagaId: created.saga.sagaId, updatedAt: createdAt });
      yield* sagas.markRollbackOutcomeUnknown({
        sagaId: created.saga.sagaId,
        updatedAt: createdAt,
        error: { code: "provider_rollback_outcome_unknown" },
      });

      assert.isTrue(yield* gate.isThreadBlocked(threadId));
      const outcomes = yield* reactor.recover();

      assert.deepStrictEqual(outcomes, [
        {
          sourceEventId,
          sagaId: created.saga.sagaId,
          status: "indeterminate",
        },
      ]);
      assert.equal(state.inspectCount, 1);
      assert.equal(state.rollbackCount, 0);
      assert.isFalse(yield* gate.isThreadBlocked(threadId));
      const durableSaga = Option.getOrThrow(
        yield* sagas.getBySagaId({ sagaId: created.saga.sagaId }),
      );
      assert.equal(durableSaga.state, "indeterminate");
      const durableIntent = Option.getOrThrow(yield* intents.getBySourceEventId({ sourceEventId }));
      assert.equal(durableIntent.state, "terminal");
      assert.equal(durableIntent.terminalOutcome, "indeterminate");

      assert.lengthOf(state.commands, 1);
      const activity = state.commands[0];
      assert.equal(activity?.type, "thread.activity.append");
      if (activity?.type === "thread.activity.append") {
        assert.deepStrictEqual(activity.activity.payload, {
          turnCount: 1,
          outcome: "indeterminate",
        });
        assert.equal(activity.activity.summary, "Checkpoint revert needs attention");
        assert.equal(activity.activity.kind, "checkpoint.revert.indeterminate");
      }

      assert.deepStrictEqual(yield* reactor.recover(), []);
      assert.lengthOf(state.commands, 1);
    }).pipe(Effect.provide(testLayer(state)));
  },
);

it.effect("continues an observed exact target through restore and domain finalization", () => {
  const state = makeState();
  state.inspectedPreimage = digest(1, "c".repeat(64));
  return Effect.gen(function* () {
    const intents = yield* CheckpointRevertIntentRepository;
    const sagas = yield* CheckpointRevertSagaRepository;
    const reactor = yield* CheckpointRevertReactor;
    const gate = yield* CheckpointRevertGate;

    yield* seedRetainedCheckpoint();
    yield* intents.projectInTransaction({
      sourceEventId,
      sourceSequence: 10,
      sourceCommandId,
      threadId,
      requestedTurnCount: 1,
      requestedAt: createdAt,
      createdAt,
    });
    const created = yield* sagas.getOrCreate({
      sourceRevertEventId: sourceEventId,
      sourceCommandId,
      providerInstanceId,
      projectId,
      threadId,
      providerDriverKind: ProviderDriverKind.make("codex"),
      continuationIdentitySha256: "b".repeat(64),
      requestedTurnCount: 1,
      preimageTurnCount: 2,
      preimage: { count: 2, sha256: "d".repeat(64) },
      target: { count: 1, sha256: "c".repeat(64) },
      retainedLogicalCheckpointId,
      retainedExpectedCheckpointOid: retainedOid,
      repositoryFingerprint: fingerprint,
      repositoryObjectFormat: "sha1",
      restoreOperationId: makeRestoreCheckpointOperationId({ revertEventId: sourceEventId }),
      staleTargets: [],
      createdAt,
    });
    yield* intents.linkSaga({ sourceEventId, sagaId: created.saga.sagaId });
    yield* sagas.markRollbackInFlight({ sagaId: created.saga.sagaId, updatedAt: createdAt });
    yield* sagas.markRollbackOutcomeUnknown({
      sagaId: created.saga.sagaId,
      updatedAt: createdAt,
      error: { code: "provider_rollback_outcome_unknown" },
    });

    assert.deepStrictEqual(yield* reactor.recover(), [
      {
        sourceEventId,
        sagaId: created.saga.sagaId,
        status: "completed",
        sequence: 100,
      },
    ]);
    assert.equal(state.rollbackCount, 0);
    assert.deepStrictEqual(state.events, [
      "provider.inspect",
      "checkpoint.restore.execute",
      "domain.thread.revert.complete",
    ]);
    assert.lengthOf(state.commands, 1);
    assert.equal(state.commands[0]?.type, "thread.revert.complete");
    assert.equal(
      Option.getOrThrow(yield* sagas.getBySagaId({ sagaId: created.saga.sagaId })).state,
      "completed",
    );
    const intent = Option.getOrThrow(yield* intents.getBySourceEventId({ sourceEventId }));
    assert.equal(intent.state, "terminal");
    assert.equal(intent.terminalOutcome, "completed");
    assert.isFalse(yield* gate.isThreadBlocked(threadId));
  }).pipe(Effect.provide(testLayer(state)));
});
