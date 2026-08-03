import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CodexCheckpointHelperCaptureResult,
  type CodexCheckpointHelperObserveResult,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { makeBaselineCheckpointIdentity } from "../../checkpointing/CheckpointIds.ts";
import { ProviderCheckpointOperationRepositoryLive } from "../../persistence/Layers/ProviderCheckpointOperations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderCheckpointOperationRepository,
  type ProviderCheckpointOperationRepositoryShape,
  type PrepareProviderCheckpointOperationInput,
} from "../../persistence/Services/ProviderCheckpointOperations.ts";
import * as ProjectRepository from "../../project/ProjectRepository.ts";
import {
  ProviderVcsCheckpointOutcomeUnknownError,
  type ProviderVcsCheckpointCapability,
  type ProviderVcsRepository,
} from "../../provider/ProviderVcsAdapter.ts";
import {
  CheckpointCoordinator,
  type BaselineCheckpointGateIntent,
} from "../Services/CheckpointCoordinator.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { CheckpointCoordinatorLive, makeCheckpointCoordinator } from "./CheckpointCoordinator.ts";

const providerInstanceId = ProviderInstanceId.make("codex-test");
const projectId = ProjectId.make("project-test");
const threadId = ThreadId.make("thread-test");
const fingerprint = "a".repeat(64);
const changedFingerprint = "9".repeat(64);
const requestSha256 = "b".repeat(64);
const checkpointOid = "c".repeat(40);
const treeOid = "d".repeat(40);
const receiptObjectOid = "e".repeat(40);
const createdAt = "2026-08-04T08:00:00.000Z";

const intent: BaselineCheckpointGateIntent = {
  sourceCommandId: CommandId.make("command-baseline"),
  sourceEventId: EventId.make("event-baseline"),
  projectId,
  threadId,
  messageId: MessageId.make("message-baseline"),
  checkpointTurnCount: 0,
  createdAt,
};

const identity = makeBaselineCheckpointIdentity({
  providerInstanceId,
  threadId,
  sourceCommandId: intent.sourceCommandId,
});

const captureResult = (digest = requestSha256): CodexCheckpointHelperCaptureResult => ({
  operation: "capture",
  receipt: {
    operation: "capture",
    operationId: identity.operationId,
    receiptRef: `refs/cocoa/checkpoint-receipts/v1/${identity.operationId}`,
    requestSha256: digest,
    repositoryFingerprint: fingerprint,
    status: "succeeded",
    checkpointId: identity.logicalCheckpointId,
    checkpointRef: `refs/cocoa/checkpoints/v1/${identity.logicalCheckpointId}`,
    checkpointOid,
    treeOid,
  },
  receiptObjectOid,
});

type ExecuteMode = "success" | "unknown";

interface FixtureState {
  readonly events: Array<string>;
  executeMode: ExecuteMode;
  prepareDigest: string;
  observeResult: CodexCheckpointHelperObserveResult;
  bindingFingerprint: string;
  hasCapability: boolean;
  notRepository: boolean;
  executeCount: number;
  observeCount: number;
}

const makeState = (): FixtureState => ({
  events: [],
  executeMode: "success",
  prepareDigest: requestSha256,
  observeResult: { operation: "observe", status: "not_found" },
  bindingFingerprint: fingerprint,
  hasCapability: true,
  notRepository: false,
  executeCount: 0,
  observeCount: 0,
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
    fingerprint: state.bindingFingerprint,
  },
  prepareCapture: () => {
    state.events.push("provider.prepare");
    return Effect.succeed({
      generationId: 7,
      requestSha256: state.prepareDigest,
      execute: Effect.suspend(() => {
        state.events.push("provider.execute");
        state.executeCount += 1;
        return state.executeMode === "success"
          ? Effect.succeed(captureResult())
          : Effect.fail(
              new ProviderVcsCheckpointOutcomeUnknownError({
                providerInstanceId,
                operation: "captureCheckpoint",
              }),
            );
      }),
    });
  },
  diff: () => Effect.die("unused"),
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
  ...(state.hasCapability ? { checkpoints: capability(state) } : {}),
  getStatus: () => Effect.die("unused"),
  listRefs: () => Effect.die("unused"),
  listRemotes: () => Effect.die("unused"),
  getReviewDiff: () => Effect.die("unused"),
});

const projectionService = {
  getProjectShellById: () =>
    Effect.succeed(
      Option.some({
        id: projectId,
        providerInstanceId,
        title: "Project",
        workspaceRoot: "/remote/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      }),
    ),
} as unknown as ProjectionSnapshotQueryShape;

const testLayer = (state: FixtureState) => {
  const database = ProviderCheckpointOperationRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const tracedRepository = Layer.effect(
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
  ).pipe(Layer.provide(database));
  const projectLayer = Layer.succeed(ProjectRepository.ProjectRepository, {
    resolve: () =>
      state.notRepository
        ? Effect.fail(
            new ProjectRepository.ProjectRepositoryNotRepositoryError({
              projectId,
              threadId,
              providerInstanceId,
            }),
          )
        : Effect.succeed(repository(state)),
  });
  return CheckpointCoordinatorLive.pipe(
    Layer.provideMerge(tracedRepository),
    Layer.provideMerge(projectLayer),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionService)),
  );
};

const preparedInput = (
  digest = requestSha256,
  repositoryFingerprint = fingerprint,
): PrepareProviderCheckpointOperationInput => ({
  operationId: identity.operationId,
  logicalCheckpointId: identity.logicalCheckpointId,
  providerInstanceId,
  projectId,
  threadId,
  turnId: null,
  operationKind: "capture",
  intentContext: {
    kind: "baseline",
    sourceCommandId: intent.sourceCommandId,
    sourceEventId: intent.sourceEventId,
    messageId: intent.messageId,
    checkpointTurnCount: intent.checkpointTurnCount,
  },
  canonicalRequest: {
    operation: "capture",
    operationId: identity.operationId,
    checkpointId: identity.logicalCheckpointId,
  },
  requestSha256: digest,
  repository: { fingerprint: repositoryFingerprint, objectFormat: "sha1" },
  providerGeneration: 1,
  preparedAt: createdAt,
});

it.effect("journals prepared and in-flight before one converged baseline dispatch", () => {
  const state = makeState();
  return Effect.gen(function* () {
    const coordinator = yield* CheckpointCoordinator;
    const results = yield* Effect.all(
      [coordinator.gateBaseline(intent), coordinator.gateBaseline(intent)],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(results, [
      { _tag: "Ready", logicalCheckpointId: identity.logicalCheckpointId },
      { _tag: "Ready", logicalCheckpointId: identity.logicalCheckpointId },
    ]);
    assert.strictEqual(state.executeCount, 1);
    assert.deepStrictEqual(state.events.slice(0, 4), [
      "provider.prepare",
      "journal.prepared",
      "journal.in_flight",
      "provider.execute",
    ]);

    const operations = yield* ProviderCheckpointOperationRepository;
    const row = Option.getOrThrow(
      yield* operations.getByOperationId({ operationId: identity.operationId }),
    );
    assert.strictEqual(row.state, "completed");
    assert.isTrue(
      Option.isSome(
        yield* operations.getLogicalCheckpoint({
          logicalCheckpointId: identity.logicalCheckpointId,
        }),
      ),
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("returns NotApplicable only before any journal intent exists", () => {
  const state = makeState();
  state.notRepository = true;
  return Effect.gen(function* () {
    const coordinator = yield* CheckpointCoordinator;
    assert.deepStrictEqual(yield* coordinator.gateBaseline(intent), {
      _tag: "NotApplicable",
      reason: "not_repository",
    });
    const operations = yield* ProviderCheckpointOperationRepository;
    assert.isTrue(
      Option.isNone(yield* operations.getByOperationId({ operationId: identity.operationId })),
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("returns NotApplicable for an initially absent checkpoint capability", () => {
  const state = makeState();
  state.hasCapability = false;
  return Effect.gen(function* () {
    const coordinator = yield* CheckpointCoordinator;
    assert.deepStrictEqual(yield* coordinator.gateBaseline(intent), {
      _tag: "NotApplicable",
      reason: "checkpoint_capability_unavailable",
    });
    const operations = yield* ProviderCheckpointOperationRepository;
    assert.isTrue(
      Option.isNone(yield* operations.getByOperationId({ operationId: identity.operationId })),
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("recovers a prepared row by exact re-prepare and a single dispatch", () => {
  const state = makeState();
  return Effect.gen(function* () {
    const operations = yield* ProviderCheckpointOperationRepository;
    yield* operations.prepare(preparedInput());
    const restarted = yield* makeCheckpointCoordinator;
    const outcomes = yield* restarted.recover(providerInstanceId);
    assert.strictEqual(outcomes[0]?.status, "ready");
    assert.strictEqual(state.executeCount, 1);
    assert.strictEqual(state.observeCount, 0);
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("recovers an in-flight provider commit by observation only", () => {
  const state = makeState();
  state.observeResult = {
    operation: "observe",
    status: "found",
    receipt: captureResult().receipt,
    receiptObjectOid,
  };
  return Effect.gen(function* () {
    const operations = yield* ProviderCheckpointOperationRepository;
    yield* operations.prepare(preparedInput());
    yield* operations.markInFlight({
      operationId: identity.operationId,
      providerGeneration: 1,
      updatedAt: createdAt,
    });
    const restarted = yield* makeCheckpointCoordinator;
    const outcomes = yield* restarted.recover();
    assert.strictEqual(outcomes[0]?.status, "ready");
    assert.strictEqual(state.executeCount, 0);
    assert.strictEqual(state.observeCount, 1);
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("fails an in-flight capture when observation proves no receipt exists", () => {
  const state = makeState();
  return Effect.gen(function* () {
    const operations = yield* ProviderCheckpointOperationRepository;
    yield* operations.prepare(preparedInput());
    yield* operations.markInFlight({
      operationId: identity.operationId,
      providerGeneration: 1,
      updatedAt: createdAt,
    });
    const restarted = yield* makeCheckpointCoordinator;
    const outcome = (yield* restarted.recover())[0];
    assert.strictEqual(outcome?.blockCode, "checkpoint_failed");
    assert.strictEqual(state.executeCount, 0);
    assert.strictEqual(state.observeCount, 1);
    assert.strictEqual(
      Option.getOrThrow(yield* operations.getByOperationId({ operationId: identity.operationId }))
        .state,
      "failed",
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect(
  "keeps a disconnected dispatched capture outcome-unknown until observe resolves it",
  () => {
    const state = makeState();
    state.executeMode = "unknown";
    return Effect.gen(function* () {
      const coordinator = yield* CheckpointCoordinator;
      const first = yield* Effect.result(coordinator.gateBaseline(intent));
      assert.isTrue(Result.isFailure(first));
      const operations = yield* ProviderCheckpointOperationRepository;
      assert.strictEqual(
        Option.getOrThrow(yield* operations.getByOperationId({ operationId: identity.operationId }))
          .state,
        "outcome_unknown",
      );

      state.observeResult = {
        operation: "observe",
        status: "found",
        receipt: captureResult().receipt,
        receiptObjectOid,
      };
      assert.strictEqual((yield* coordinator.recover())[0]?.status, "ready");
      assert.strictEqual(state.executeCount, 1);
      assert.strictEqual(state.observeCount, 1);
    }).pipe(Effect.provide(testLayer(state)));
  },
);

it.effect("fails a prepared row on request digest change without dispatch", () => {
  const state = makeState();
  state.prepareDigest = "8".repeat(64);
  return Effect.gen(function* () {
    const operations = yield* ProviderCheckpointOperationRepository;
    yield* operations.prepare(preparedInput());
    const outcome = (yield* (yield* CheckpointCoordinator).recover())[0];
    assert.strictEqual(outcome?.blockCode, "request_digest_changed");
    assert.strictEqual(state.executeCount, 0);
    assert.strictEqual(
      Option.getOrThrow(yield* operations.getByOperationId({ operationId: identity.operationId }))
        .state,
      "failed",
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("blocks and terminalizes persisted intents when capability disappears", () => {
  const state = makeState();
  return Effect.gen(function* () {
    const operations = yield* ProviderCheckpointOperationRepository;
    yield* operations.prepare(preparedInput());
    state.hasCapability = false;
    const recovered = (yield* (yield* CheckpointCoordinator).recover())[0];
    assert.strictEqual(recovered?.blockCode, "repository_unavailable");
    assert.strictEqual(
      Option.getOrThrow(yield* operations.getByOperationId({ operationId: identity.operationId }))
        .state,
      "failed",
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("blocks completed rows on current binding change without rewriting completion", () => {
  const state = makeState();
  return Effect.gen(function* () {
    const coordinator = yield* CheckpointCoordinator;
    yield* coordinator.gateBaseline(intent);
    state.bindingFingerprint = changedFingerprint;
    const blocked = yield* Effect.result(coordinator.gateBaseline(intent));
    assert.isTrue(Result.isFailure(blocked));
    if (Result.isFailure(blocked)) {
      assert.strictEqual(blocked.failure.code, "repository_binding_changed");
    }
    const operations = yield* ProviderCheckpointOperationRepository;
    assert.strictEqual(
      Option.getOrThrow(yield* operations.getByOperationId({ operationId: identity.operationId }))
        .state,
      "completed",
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("fails a prepared row when its current repository binding changes", () => {
  const state = makeState();
  state.bindingFingerprint = changedFingerprint;
  return Effect.gen(function* () {
    const operations = yield* ProviderCheckpointOperationRepository;
    yield* operations.prepare(preparedInput());
    const outcome = (yield* (yield* CheckpointCoordinator).recover())[0];
    assert.strictEqual(outcome?.blockCode, "repository_binding_changed");
    assert.strictEqual(state.executeCount, 0);
    assert.strictEqual(
      Option.getOrThrow(yield* operations.getByOperationId({ operationId: identity.operationId }))
        .state,
      "failed",
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("blocks completed rows when capability disappears without rewriting completion", () => {
  const state = makeState();
  return Effect.gen(function* () {
    const coordinator = yield* CheckpointCoordinator;
    yield* coordinator.gateBaseline(intent);
    state.hasCapability = false;
    const blocked = yield* Effect.result(coordinator.gateBaseline(intent));
    assert.isTrue(Result.isFailure(blocked));
    if (Result.isFailure(blocked)) {
      assert.strictEqual(blocked.failure.code, "repository_unavailable");
    }
    const operations = yield* ProviderCheckpointOperationRepository;
    assert.strictEqual(
      Option.getOrThrow(yield* operations.getByOperationId({ operationId: identity.operationId }))
        .state,
      "completed",
    );
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("marks an in-flight row indeterminate when capability disappears", () => {
  const state = makeState();
  state.hasCapability = false;
  return Effect.gen(function* () {
    const operations = yield* ProviderCheckpointOperationRepository;
    yield* operations.prepare(preparedInput());
    yield* operations.markInFlight({
      operationId: identity.operationId,
      providerGeneration: 1,
      updatedAt: createdAt,
    });
    const outcome = (yield* (yield* CheckpointCoordinator).recover())[0];
    assert.strictEqual(outcome?.blockCode, "repository_unavailable");
    assert.strictEqual(
      Option.getOrThrow(yield* operations.getByOperationId({ operationId: identity.operationId }))
        .state,
      "indeterminate",
    );
  }).pipe(Effect.provide(testLayer(state)));
});
