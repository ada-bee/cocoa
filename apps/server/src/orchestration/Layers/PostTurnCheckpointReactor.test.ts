import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import {
  CheckpointDiffQuery,
  layer as CheckpointDiffQueryLive,
} from "../../checkpointing/CheckpointDiffQuery.ts";
import {
  makeBaselineCheckpointIdentity,
  makePostTurnCheckpointIdentity,
} from "../../checkpointing/CheckpointIds.ts";
import { ProviderCheckpointOperationRepositoryLive } from "../../persistence/Layers/ProviderCheckpointOperations.ts";
import { PostTurnCheckpointIntentRepositoryLive } from "../../persistence/Layers/PostTurnCheckpointIntents.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { TurnDispatchJournalRepositoryLive } from "../../persistence/Layers/TurnDispatchJournal.ts";
import { PostTurnCheckpointIntentRepository } from "../../persistence/Services/PostTurnCheckpointIntents.ts";
import {
  ProviderCheckpointOperationRepository,
  type ProviderCheckpointOperationRepositoryShape,
  type PrepareProviderCheckpointOperationInput,
} from "../../persistence/Services/ProviderCheckpointOperations.ts";
import {
  TurnDispatchId,
  TurnDispatchJournalRepository,
} from "../../persistence/Services/TurnDispatchJournal.ts";
import * as ProjectRepository from "../../project/ProjectRepository.ts";
import {
  ProviderVcsCheckpointOutcomeUnknownError,
  type ProviderVcsCheckpointCapability,
  type ProviderVcsRepository,
} from "../../provider/ProviderVcsAdapter.ts";
import { PostTurnCheckpointReactor } from "../Services/PostTurnCheckpointReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  PostTurnCheckpointReactorLive,
  makePostTurnCheckpointReactor,
} from "./PostTurnCheckpointReactor.ts";

const providerInstanceId = ProviderInstanceId.make("codex-post-turn");
const projectId = ProjectId.make("project-post-turn");
const threadId = ThreadId.make("thread-post-turn");
const cocoaTurnId = TurnId.make("turn-cocoa-1");
const providerTurnId = TurnId.make("turn-native-1");
const fingerprint = "a".repeat(64);
const baselineDigest = "b".repeat(64);
const postDigest = "c".repeat(64);
const baselineOid = "d".repeat(40);
const postOid = "e".repeat(40);
const treeOid = "f".repeat(40);
const receiptObjectOid = "1".repeat(40);
const createdAt = "2026-08-04T09:00:00.000Z";

const baselineIdentity = makeBaselineCheckpointIdentity({
  providerInstanceId,
  threadId,
  sourceCommandId: CommandId.make("command-baseline-post-turn"),
});
const postIdentity = makePostTurnCheckpointIdentity({
  providerInstanceId,
  threadId,
  providerTurnId,
});

const captureResult = (
  operationId: string,
  checkpointId: string,
  requestSha256: string,
  checkpointOid: string,
) => ({
  operation: "capture" as const,
  receipt: {
    operation: "capture" as const,
    operationId,
    receiptRef: `refs/cocoa/checkpoint-receipts/v1/${operationId}`,
    requestSha256,
    repositoryFingerprint: fingerprint,
    status: "succeeded" as const,
    checkpointId,
    checkpointRef: `refs/cocoa/checkpoints/v1/${checkpointId}`,
    checkpointOid,
    treeOid,
  },
  receiptObjectOid,
});

const postCaptureResult = () =>
  captureResult(postIdentity.operationId, postIdentity.logicalCheckpointId, postDigest, postOid);

const completionEvent: Extract<OrchestrationEvent, { type: "thread.turn-completed" }> = {
  sequence: 20,
  eventId: EventId.make("event-turn-completed-post"),
  type: "thread.turn-completed",
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: createdAt,
  commandId: CommandId.make("command-turn-completed-post"),
  causationEventId: null,
  correlationId: CommandId.make("command-turn-completed-post"),
  metadata: { providerTurnId },
  payload: {
    threadId,
    turnId: cocoaTurnId,
    providerTurnId,
    outcome: "completed",
    completedAt: createdAt,
  },
};

interface FixtureState {
  readonly events: Array<string>;
  readonly commands: Array<OrchestrationCommand>;
  readonly commandSequences: Map<string, number>;
  readonly durableEvents: Array<OrchestrationEvent>;
  executeMode: "success" | "unknown";
  observeResult: ReturnType<ProviderVcsCheckpointCapability["observe"]> extends Effect.Effect<
    infer A,
    any,
    any
  >
    ? A
    : never;
  executeCount: number;
  observeCount: number;
  diffCount: number;
  nextSequence: number;
}

const makeState = (): FixtureState => ({
  events: [],
  commands: [],
  commandSequences: new Map(),
  durableEvents: [],
  executeMode: "success",
  observeResult: { operation: "observe", status: "not_found" },
  executeCount: 0,
  observeCount: 0,
  diffCount: 0,
  nextSequence: 100,
});

const capability = (state: FixtureState): ProviderVcsCheckpointCapability => ({
  binding: {
    worktreeRoot: { canonicalPath: "/remote/repo", device: "1", inode: "2" },
    gitDirectoryRoot: { canonicalPath: "/remote/repo/.git", device: "1", inode: "3" },
    gitCommonDirectoryRoot: {
      canonicalPath: "/remote/repo/.git",
      device: "1",
      inode: "3",
    },
    objectFormat: "sha1",
    fingerprint,
  },
  prepareCapture: (input) => {
    state.events.push("provider.prepare");
    return Effect.succeed({
      generationId: 9,
      requestSha256: postDigest,
      execute: Effect.suspend(() => {
        state.events.push("provider.execute");
        state.executeCount += 1;
        return state.executeMode === "success"
          ? Effect.succeed(
              captureResult(input.operationId, input.checkpointId, postDigest, postOid),
            )
          : Effect.fail(
              new ProviderVcsCheckpointOutcomeUnknownError({
                providerInstanceId,
                operation: "captureCheckpoint",
              }),
            );
      }),
    });
  },
  diff: (input) => {
    state.events.push("provider.diff");
    state.diffCount += 1;
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    return Effect.succeed({
      operation: "diff",
      baseCheckpointId: input.baseCheckpointId,
      targetCheckpointId: input.targetCheckpointId,
      baseOid: baselineOid,
      targetOid: postOid,
      patchBase64: Buffer.from(patch, "utf8").toString("base64"),
      byteLength: Buffer.byteLength(patch, "utf8"),
      truncated: false,
    });
  },
  prepareRestore: () => Effect.die("unused"),
  prepareDelete: () => Effect.die("unused"),
  observe: () => {
    state.events.push("provider.observe");
    state.observeCount += 1;
    return Effect.succeed(state.observeResult);
  },
});

const repository = (state: FixtureState): ProviderVcsRepository => ({
  identity: { kind: "git", rootPath: "/remote/repo", commonDirectoryPath: "/remote/repo/.git" },
  capabilities: { status: true, refs: true, remotes: true, reviewDiff: true },
  checkpoints: capability(state),
  getStatus: () => Effect.die("unused"),
  listRefs: () => Effect.die("unused"),
  listRemotes: () => Effect.die("unused"),
  getReviewDiff: () => Effect.die("unused"),
});

const engineService = (state: FixtureState): OrchestrationEngineShape => ({
  dispatch: (command) =>
    Effect.sync(() => {
      state.events.push("domain.dispatch");
      const key = command.commandId;
      const existing = state.commandSequences.get(key);
      if (existing !== undefined) return { sequence: existing };
      const sequence = state.nextSequence++;
      state.commandSequences.set(key, sequence);
      state.commands.push(command);
      return { sequence };
    }),
  readEvents: (cursor, limit = 500) =>
    Stream.fromIterable(
      state.durableEvents.filter((event) => event.sequence > cursor).slice(0, limit),
    ),
  streamDomainEvents: Stream.empty,
  latestSequence: Effect.succeed(0),
});

const projectionService = {
  getCheckpointDiffContext: () => Effect.die("post-turn exact diff must not read projections"),
} as unknown as ProjectionSnapshotQueryShape;

const testLayer = (state: FixtureState) => {
  const providerBase = ProviderCheckpointOperationRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const tracedProvider = Layer.effect(
    ProviderCheckpointOperationRepository,
    Effect.gen(function* () {
      const base = yield* ProviderCheckpointOperationRepository;
      return {
        ...base,
        getOrPrepare: (input) =>
          base
            .getOrPrepare(input)
            .pipe(Effect.tap(() => Effect.sync(() => state.events.push("journal.prepared")))),
        markInFlight: (input) =>
          base
            .markInFlight(input)
            .pipe(Effect.tap(() => Effect.sync(() => state.events.push("journal.in_flight")))),
      } satisfies ProviderCheckpointOperationRepositoryShape;
    }),
  ).pipe(Layer.provide(providerBase));
  const turnDispatch = TurnDispatchJournalRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const postTurnIntents = PostTurnCheckpointIntentRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const project = Layer.succeed(ProjectRepository.ProjectRepository, {
    resolve: () => Effect.succeed(repository(state)),
  });
  const engine = Layer.succeed(OrchestrationEngineService, engineService(state));
  const projection = Layer.succeed(ProjectionSnapshotQuery, projectionService);
  const dependencies = Layer.mergeAll(
    tracedProvider,
    turnDispatch,
    postTurnIntents,
    project,
    engine,
    projection,
    SqlitePersistenceMemory,
  );
  const diff = CheckpointDiffQueryLive.pipe(Layer.provide(dependencies));
  return PostTurnCheckpointReactorLive.pipe(
    Layer.provideMerge(diff),
    Layer.provideMerge(dependencies),
  );
};

const seedCapture = Effect.fn("seedCapture")(function* (
  input: PrepareProviderCheckpointOperationInput,
  result: ReturnType<typeof captureResult>,
) {
  const operations = yield* ProviderCheckpointOperationRepository;
  yield* operations.prepare(input);
  yield* operations.markInFlight({
    operationId: input.operationId,
    ...(input.providerGeneration == null ? {} : { providerGeneration: input.providerGeneration }),
    updatedAt: createdAt,
  });
  yield* operations.finalizeCapture({
    completion: {
      operationId: input.operationId,
      updatedAt: createdAt,
      receipt: result.receipt,
      result,
    },
    checkpoint: {
      logicalCheckpointId: input.logicalCheckpointId,
      providerInstanceId: input.providerInstanceId,
      projectId: input.projectId,
      threadId: input.threadId,
      turnId: input.turnId,
      repository: input.repository,
      captureOperationId: input.operationId,
      checkpointRef: result.receipt.checkpointRef,
      checkpointOid: result.receipt.checkpointOid,
      treeOid: result.receipt.treeOid,
      receiptRef: result.receipt.receiptRef,
      receiptObjectOid: result.receiptObjectOid,
      createdAt,
      updatedAt: createdAt,
    },
  });
});

const baselineInput = (): PrepareProviderCheckpointOperationInput => ({
  operationId: baselineIdentity.operationId,
  logicalCheckpointId: baselineIdentity.logicalCheckpointId,
  providerInstanceId,
  projectId,
  threadId,
  turnId: null,
  operationKind: "capture",
  intentContext: {
    kind: "baseline",
    sourceCommandId: CommandId.make("command-baseline-post-turn"),
    sourceEventId: EventId.make("event-baseline-post-turn"),
    messageId: MessageId.make("message-baseline-post-turn"),
    checkpointTurnCount: 0,
  },
  canonicalRequest: {
    operation: "capture",
    operationId: baselineIdentity.operationId,
    checkpointId: baselineIdentity.logicalCheckpointId,
  },
  requestSha256: baselineDigest,
  repository: { fingerprint, objectFormat: "sha1" },
  providerGeneration: 1,
  preparedAt: createdAt,
});

const postInput = (): PrepareProviderCheckpointOperationInput => ({
  operationId: postIdentity.operationId,
  logicalCheckpointId: postIdentity.logicalCheckpointId,
  providerInstanceId,
  projectId,
  threadId,
  turnId: cocoaTurnId,
  operationKind: "capture",
  intentContext: {
    kind: "post_turn",
    sourceEventId: completionEvent.eventId,
    turnId: cocoaTurnId,
    baselineCheckpointId: baselineIdentity.logicalCheckpointId,
    checkpointTurnCount: 1,
    completedAt: createdAt,
    outcome: "completed",
  },
  canonicalRequest: {
    operation: "capture",
    operationId: postIdentity.operationId,
    checkpointId: postIdentity.logicalCheckpointId,
  },
  requestSha256: postDigest,
  repository: { fingerprint, objectFormat: "sha1" },
  providerGeneration: 9,
  preparedAt: createdAt,
});

const seedStartedDispatch = Effect.fn("seedStartedDispatch")(function* (
  disposition: "ready" | "not_applicable" = "ready",
) {
  const turns = yield* TurnDispatchJournalRepository;
  const dispatchId = TurnDispatchId.make("dispatch-post-turn");
  yield* turns.getOrCreate({
    dispatchId,
    sourceEventId: EventId.make("event-user-turn-post"),
    sourceCommandId: CommandId.make("command-user-turn-post"),
    threadId,
    projectId,
    providerInstanceId,
    messageId: MessageId.make("message-user-turn-post"),
    checkpointTurnCount: 0,
    modelSelection: {
      instanceId: providerInstanceId,
      model: "gpt-5.6-sol",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    titleSeedSha256: null,
    createdAt,
  });
  if (disposition === "ready") {
    yield* turns.markBaselineReady({
      dispatchId,
      baselineLogicalCheckpointId: baselineIdentity.logicalCheckpointId,
      baselineOperationId: baselineIdentity.operationId,
      updatedAt: createdAt,
    });
  } else {
    yield* turns.markBaselineNotApplicable({
      dispatchId,
      reason: "capability_unavailable",
      updatedAt: createdAt,
    });
  }
  yield* turns.markProviderInFlight({ dispatchId, updatedAt: createdAt });
  yield* turns.markStarted({ dispatchId, providerTurnId, updatedAt: createdAt });
});

const seedReadyBaselineAndDispatch = Effect.gen(function* () {
  yield* seedCapture(
    baselineInput(),
    captureResult(
      baselineIdentity.operationId,
      baselineIdentity.logicalCheckpointId,
      baselineDigest,
      baselineOid,
    ),
  );
  yield* seedStartedDispatch();
});

const seedProjectedIntent = Effect.gen(function* () {
  yield* (yield* PostTurnCheckpointIntentRepository).projectInTransaction({
    sourceEventId: completionEvent.eventId,
    sourceSequence: completionEvent.sequence,
    threadId,
    turnId: cocoaTurnId,
    providerTurnId,
    outcome: "completed",
    completedAt: createdAt,
  });
});

const seedBoundIntent = Effect.gen(function* () {
  yield* seedProjectedIntent;
  yield* (yield* PostTurnCheckpointIntentRepository).bind({
    sourceEventId: completionEvent.eventId,
    providerInstanceId,
    projectId,
    baselineCheckpointTurnCount: 0,
    checkpointTurnCount: 1,
    baselineLogicalCheckpointId: baselineIdentity.logicalCheckpointId,
    baselineNotApplicableReason: null,
    operationId: postIdentity.operationId,
    logicalCheckpointId: postIdentity.logicalCheckpointId,
    updatedAt: createdAt,
  });
});

it.effect("captures, diffs, and finalizes a durable provider turn exactly once", () => {
  const state = makeState();
  return Effect.gen(function* () {
    yield* seedReadyBaselineAndDispatch;
    state.events.length = 0;
    const reactor = yield* PostTurnCheckpointReactor;
    const first = yield* reactor.processTurnCompleted(completionEvent);
    const duplicate = yield* reactor.processTurnCompleted(completionEvent);

    assert.deepStrictEqual(first, {
      _tag: "Finalized",
      logicalCheckpointId: postIdentity.logicalCheckpointId,
      sequence: 100,
      status: "ready",
    });
    assert.deepStrictEqual(duplicate, first);
    assert.strictEqual(state.executeCount, 1);
    assert.strictEqual(state.diffCount, 1);
    assert.deepStrictEqual(state.events.slice(0, 6), [
      "provider.prepare",
      "journal.prepared",
      "journal.in_flight",
      "provider.execute",
      "provider.diff",
      "domain.dispatch",
    ]);
    assert.strictEqual(state.commands.length, 1);
    const command = state.commands[0];
    assert.strictEqual(command?.type, "thread.turn.diff.complete");
    if (command?.type === "thread.turn.diff.complete") {
      assert.strictEqual(command.checkpointRef, postIdentity.logicalCheckpointId);
      assert.strictEqual(command.checkpointTurnCount, 1);
      assert.strictEqual(command.status, "ready");
      assert.deepStrictEqual(command.files, [
        { path: "a.txt", kind: "modified", additions: 1, deletions: 1 },
      ]);
      assert.notInclude(command.checkpointRef, "refs/");
    }
    const operations = yield* ProviderCheckpointOperationRepository;
    const row = Option.getOrThrow(
      yield* operations.getByOperationId({ operationId: postIdentity.operationId }),
    );
    assert.strictEqual(row.state, "completed");
    assert.strictEqual(row.finalizedSequence, 100);
    const dispatch = Option.getOrThrow(
      yield* (yield* TurnDispatchJournalRepository).getStartedByProviderTurn({
        threadId,
        providerTurnId,
      }),
    );
    assert.strictEqual(dispatch.finalizedSequence, completionEvent.sequence);
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("advances baseline-not-applicable turns without a native capture", () => {
  const state = makeState();
  return Effect.gen(function* () {
    yield* seedStartedDispatch("not_applicable");
    const result = yield* (yield* PostTurnCheckpointReactor).processTurnCompleted(completionEvent);
    assert.strictEqual(result._tag, "Finalized");
    if (result._tag === "Finalized") assert.strictEqual(result.status, "missing");
    assert.strictEqual(state.executeCount, 0);
    assert.strictEqual(state.commands.length, 1);
    const command = state.commands[0];
    assert.strictEqual(command?.type, "thread.turn.diff.complete");
    if (command?.type === "thread.turn.diff.complete") {
      assert.strictEqual(command.status, "missing");
      assert.strictEqual(command.checkpointTurnCount, 1);
      assert.strictEqual(command.checkpointRef, postIdentity.logicalCheckpointId);
    }
    const operations = yield* ProviderCheckpointOperationRepository;
    assert.isTrue(
      Option.isNone(yield* operations.getByOperationId({ operationId: postIdentity.operationId })),
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("recovers a prepared post-turn row by exact re-prepare", () => {
  const state = makeState();
  return Effect.gen(function* () {
    yield* seedReadyBaselineAndDispatch;
    yield* seedBoundIntent;
    const operations = yield* ProviderCheckpointOperationRepository;
    yield* operations.prepare(postInput());
    const restarted = yield* makePostTurnCheckpointReactor;
    const outcome = (yield* restarted.recover(providerInstanceId)).find(
      (entry) => entry.operationId === postIdentity.operationId,
    );
    assert.strictEqual(outcome?.status, "finalized");
    assert.strictEqual(state.executeCount, 1);
    assert.strictEqual(state.observeCount, 0);
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("observes an in-flight provider commit without replaying capture", () => {
  const state = makeState();
  state.observeResult = {
    operation: "observe",
    status: "found",
    receipt: postCaptureResult().receipt,
    receiptObjectOid,
  };
  return Effect.gen(function* () {
    yield* seedReadyBaselineAndDispatch;
    yield* seedProjectedIntent;
    const operations = yield* ProviderCheckpointOperationRepository;
    yield* operations.prepare(postInput());
    yield* operations.markInFlight({
      operationId: postIdentity.operationId,
      providerGeneration: 9,
      updatedAt: createdAt,
    });
    const outcome = (yield* (yield* makePostTurnCheckpointReactor).recover()).find(
      (entry) => entry.operationId === postIdentity.operationId,
    );
    assert.strictEqual(outcome?.status, "finalized");
    assert.strictEqual(state.executeCount, 0);
    assert.strictEqual(state.observeCount, 1);
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("preserves unknown capture outcome until receipt observation", () => {
  const state = makeState();
  state.executeMode = "unknown";
  return Effect.gen(function* () {
    yield* seedReadyBaselineAndDispatch;
    const reactor = yield* PostTurnCheckpointReactor;
    const first = yield* Effect.result(reactor.processTurnCompleted(completionEvent));
    assert.isTrue(Result.isFailure(first));
    const operations = yield* ProviderCheckpointOperationRepository;
    assert.strictEqual(
      Option.getOrThrow(
        yield* operations.getByOperationId({ operationId: postIdentity.operationId }),
      ).state,
      "outcome_unknown",
    );
    assert.strictEqual(state.commands.length, 0);

    state.observeResult = {
      operation: "observe",
      status: "found",
      receipt: postCaptureResult().receipt,
      receiptObjectOid,
    };
    const outcome = (yield* reactor.recover()).find(
      (entry) => entry.operationId === postIdentity.operationId,
    );
    assert.strictEqual(outcome?.status, "finalized");
    assert.strictEqual(state.executeCount, 1);
    assert.strictEqual(state.observeCount, 1);
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("replays only diff/domain finalization for a completed-unfinalized row", () => {
  const state = makeState();
  return Effect.gen(function* () {
    yield* seedReadyBaselineAndDispatch;
    yield* seedProjectedIntent;
    yield* seedCapture(postInput(), postCaptureResult());
    const outcome = (yield* (yield* makePostTurnCheckpointReactor).recover()).find(
      (entry) => entry.operationId === postIdentity.operationId,
    );
    assert.strictEqual(outcome?.status, "finalized");
    assert.strictEqual(state.executeCount, 0);
    assert.strictEqual(state.observeCount, 0);
    assert.strictEqual(state.diffCount, 1);
    assert.strictEqual(state.commands.length, 1);
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("subscribes first and recovers projected completion intents at startup", () => {
  const state = makeState();
  return Effect.gen(function* () {
    yield* seedReadyBaselineAndDispatch;
    yield* seedProjectedIntent;
    const reactor = yield* PostTurnCheckpointReactor;
    yield* reactor.start();
    yield* reactor.drain;
    assert.strictEqual(state.executeCount, 1);
    assert.strictEqual(state.commands.length, 1);
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});
