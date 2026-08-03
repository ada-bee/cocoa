import { assert, it } from "@effect/vitest";
import {
  CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CodexCheckpointHelperDiffResult,
} from "@t3tools/contracts";
import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderCheckpointOperations from "../persistence/Services/ProviderCheckpointOperations.ts";
import * as ProjectRepository from "../project/ProjectRepository.ts";
import {
  ProviderVcsDisconnectedError,
  type ProviderVcsCheckpointDiffInput,
  type ProviderVcsRepository,
} from "../provider/ProviderVcsAdapter.ts";
import { CheckpointDiffQuery, layer } from "./CheckpointDiffQuery.ts";

const threadId = ThreadId.make("thread-diff");
const projectId = ProjectId.make("project-diff");
const providerId = ProviderInstanceId.make("provider-a");
const otherProviderId = ProviderInstanceId.make("provider-b");
const baseId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const baseOperationId = "33333333-3333-4333-8333-333333333333";
const targetOperationId = "44444444-4444-4444-8444-444444444444";
const targetTurnId = TurnId.make("turn-target");
const baseOid = "a".repeat(40);
const targetOid = "b".repeat(40);
const fingerprint = "c".repeat(64);
const binding = {
  worktreeRoot: { canonicalPath: "/provider/worktree", device: "1", inode: "10" },
  gitDirectoryRoot: { canonicalPath: "/provider/git", device: "1", inode: "11" },
  gitCommonDirectoryRoot: { canonicalPath: "/provider/common", device: "1", inode: "12" },
  objectFormat: "sha1" as const,
  fingerprint,
};

const nativeCheckpoint = (
  logicalCheckpointId: string,
  captureOperationId: string,
  checkpointOid: string,
  providerInstanceId = providerId,
  turnId: TurnId | null = null,
): ProviderCheckpointOperations.ProviderNativeCheckpoint => ({
  logicalCheckpointId,
  providerInstanceId,
  projectId,
  threadId,
  turnId,
  repository: { fingerprint, objectFormat: "sha1" },
  captureOperationId,
  checkpointRef: `refs/cocoa/checkpoints/v1/${logicalCheckpointId}`,
  checkpointOid,
  treeOid: "d".repeat(40),
  receiptRef: `refs/cocoa/checkpoint-receipts/v1/${captureOperationId}`,
  receiptObjectOid: "e".repeat(40),
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:01.000Z",
});

const defaultResult = (patch = "diff"): CodexCheckpointHelperDiffResult => ({
  operation: "diff",
  baseCheckpointId: baseId,
  targetCheckpointId: targetId,
  baseOid,
  targetOid,
  patchBase64: Buffer.from(patch, "utf8").toString("base64"),
  byteLength: Buffer.byteLength(patch, "utf8"),
  truncated: false,
});

interface TestOptions {
  readonly providerInstanceId?: ProviderInstanceId;
  readonly latestCheckpointTurnCount?: number;
  readonly missingTurnCount?: number;
  readonly bindingFingerprint?: string;
  readonly diff?: (
    input: ProviderVcsCheckpointDiffInput,
  ) => Effect.Effect<CodexCheckpointHelperDiffResult, ProviderVcsDisconnectedError>;
  readonly result?: unknown;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
  readonly observations?: Array<unknown>;
  readonly exactFailure?:
    | "cross_owner"
    | "non_completed"
    | "logical_mismatch"
    | "baseline_link_mismatch";
  readonly baseTurnCount?: number;
  readonly targetTurnCount?: number;
}

const testLayer = (options: TestOptions = {}) => {
  const activeThreadId = options.threadId ?? threadId;
  const activeProjectId = options.projectId ?? projectId;
  const activeProviderId = options.providerInstanceId ?? providerId;
  const observations = options.observations ?? [];
  const base = nativeCheckpoint(baseId, baseOperationId, baseOid, activeProviderId);
  const target = nativeCheckpoint(
    targetId,
    targetOperationId,
    targetOid,
    activeProviderId,
    targetTurnId,
  );
  const captureOperation = (
    checkpoint: ProviderCheckpointOperations.ProviderNativeCheckpoint,
    checkpointTurnCount: number,
    kind: "baseline" | "post_turn",
  ): ProviderCheckpointOperations.ProviderCheckpointOperation => {
    const isBaseline = kind === "baseline";
    const receipt = {
      operation: "capture" as const,
      operationId: checkpoint.captureOperationId,
      receiptRef: checkpoint.receiptRef,
      requestSha256: fingerprint,
      repositoryFingerprint: fingerprint,
      status: "succeeded" as const,
      checkpointId: checkpoint.logicalCheckpointId,
      checkpointRef: checkpoint.checkpointRef,
      checkpointOid: checkpoint.checkpointOid,
      treeOid: checkpoint.treeOid,
    };
    return {
      operationId: checkpoint.captureOperationId,
      logicalCheckpointId: checkpoint.logicalCheckpointId,
      providerInstanceId: activeProviderId,
      projectId: activeProjectId,
      threadId: activeThreadId,
      turnId: isBaseline ? null : targetTurnId,
      operationKind: "capture",
      intentKey: fingerprint,
      intentContext: isBaseline
        ? {
            kind: "baseline",
            sourceCommandId: CommandId.make("command:baseline"),
            sourceEventId: EventId.make("event:baseline"),
            messageId: MessageId.make("message:baseline"),
            checkpointTurnCount,
          }
        : {
            kind: "post_turn",
            sourceEventId: EventId.make("event:post-turn"),
            turnId: targetTurnId,
            baselineCheckpointId: baseId,
            checkpointTurnCount,
            completedAt: "2026-08-04T00:00:01.000Z",
            outcome: "completed",
          },
      canonicalRequest: {
        operation: "capture",
        operationId: checkpoint.captureOperationId,
        checkpointId: checkpoint.logicalCheckpointId,
      },
      targets: [
        { logicalCheckpointId: checkpoint.logicalCheckpointId, expectedCheckpointOid: null },
      ],
      requestSha256: fingerprint,
      repository: checkpoint.repository,
      providerGeneration: 1,
      state: "completed",
      receipt,
      result: { operation: "capture", receipt, receiptObjectOid: checkpoint.receiptObjectOid },
      error: null,
      preparedAt: checkpoint.createdAt,
      updatedAt: checkpoint.updatedAt,
      finalizedSequence: null,
    };
  };
  const baseCapture = captureOperation(base, options.baseTurnCount ?? 0, "baseline");
  const exactTarget =
    options.exactFailure === "cross_owner"
      ? { ...target, providerInstanceId: otherProviderId }
      : target;
  const validTargetCapture = captureOperation(target, options.targetTurnCount ?? 1, "post_turn");
  const targetCapture = {
    ...validTargetCapture,
    ...(options.exactFailure === "non_completed" ? { state: "in_flight" as const } : {}),
    ...(options.exactFailure === "logical_mismatch" ? { logicalCheckpointId: baseId } : {}),
    ...(options.exactFailure === "baseline_link_mismatch" &&
    validTargetCapture.intentContext.kind === "post_turn"
      ? {
          intentContext: {
            ...validTargetCapture.intentContext,
            baselineCheckpointId: targetId,
          },
        }
      : {}),
  };
  const repository: ProviderVcsRepository = {
    identity: { kind: "git", rootPath: "/provider/worktree", commonDirectoryPath: null },
    capabilities: { status: true, refs: true, remotes: true, reviewDiff: true },
    checkpoints: {
      binding: {
        ...binding,
        fingerprint: options.bindingFingerprint ?? fingerprint,
      },
      prepareCapture: () => Effect.die("unused"),
      diff:
        options.diff ??
        ((input) => {
          observations.push(input);
          return Effect.succeed(
            (options.result ?? defaultResult()) as CodexCheckpointHelperDiffResult,
          );
        }),
      prepareRestore: () => Effect.die("unused"),
      prepareDelete: () => Effect.die("unused"),
      observe: () => Effect.die("unused"),
    },
    getStatus: () => Effect.die("unused"),
    listRefs: () => Effect.die("unused"),
    listRemotes: () => Effect.die("unused"),
    getReviewDiff: () => Effect.die("unused"),
  };

  return layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getCheckpointDiffContext: (requestedThreadId) => {
            observations.push({ requestedThreadId });
            return Effect.succeed(
              requestedThreadId === activeThreadId
                ? Option.some({
                    threadId: activeThreadId,
                    projectId: activeProjectId,
                    providerInstanceId: activeProviderId,
                    latestCheckpointTurnCount: options.latestCheckpointTurnCount ?? 1,
                  })
                : Option.none(),
            );
          },
        }),
        Layer.mock(ProviderCheckpointOperations.ProviderCheckpointOperationRepository)({
          getReadyLogicalCheckpoint: (input) => {
            observations.push(input);
            if (
              input.providerInstanceId !== activeProviderId ||
              input.projectId !== activeProjectId ||
              input.threadId !== activeThreadId ||
              input.checkpointTurnCount === options.missingTurnCount
            ) {
              return Effect.succeed(Option.none());
            }
            return Effect.succeed(
              input.checkpointTurnCount === 0 ? Option.some(base) : Option.some(target),
            );
          },
          getLogicalCheckpoint: ({ logicalCheckpointId }) =>
            Effect.succeed(
              logicalCheckpointId === baseId
                ? Option.some(base)
                : logicalCheckpointId === targetId
                  ? Option.some(exactTarget)
                  : Option.none(),
            ),
          getByOperationId: ({ operationId }) =>
            Effect.succeed(
              operationId === baseOperationId
                ? Option.some(baseCapture)
                : operationId === targetOperationId
                  ? Option.some(targetCapture)
                  : Option.none(),
            ),
        }),
        Layer.mock(ProjectRepository.ProjectRepository)({
          resolve: (targetOwner) => {
            observations.push(targetOwner);
            return Effect.succeed(repository);
          },
        }),
      ),
    ),
  );
};

it.effect("resolves turn zero and keeps all gateway paths out of provider diff inputs", () => {
  const observations: Array<unknown> = [];
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 1 });

    assert.deepStrictEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff",
      byteLength: 4,
      truncated: false,
    });
    assert.deepStrictEqual(observations.at(-1), {
      baseCheckpointId: baseId,
      targetCheckpointId: targetId,
      ignoreWhitespace: false,
      limits: { maxPatchBytes: CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES },
    });
    assert.isFalse(
      observations.some(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          Object.keys(item).some((key) => key.toLowerCase().includes("path")),
      ),
    );
  }).pipe(Effect.provide(testLayer({ observations })));
});

it.effect("diffs a completed post-turn capture before its public projection advances", () => {
  const observations: Array<unknown> = [];
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery;
    const result = yield* query.getCompletedCaptureDiff({
      providerInstanceId: providerId,
      projectId,
      threadId,
      baseCheckpointId: baseId,
      targetCheckpointId: targetId,
      fromTurnCount: 0,
      toTurnCount: 1,
    });

    assert.deepStrictEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff",
      byteLength: 4,
      truncated: false,
    });
    assert.deepStrictEqual(Object.keys(result).toSorted(), [
      "byteLength",
      "diff",
      "fromTurnCount",
      "threadId",
      "toTurnCount",
      "truncated",
    ]);
    assert.isFalse(
      observations.some(
        (item) => item !== null && typeof item === "object" && "requestedThreadId" in item,
      ),
    );
  }).pipe(
    Effect.provide(
      testLayer({
        latestCheckpointTurnCount: 0,
        observations,
      }),
    ),
  );
});

it.effect("accepts a later turn's completed baseline capture at a nonzero count", () =>
  Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery;
    const result = yield* query.getCompletedCaptureDiff({
      providerInstanceId: providerId,
      projectId,
      threadId,
      baseCheckpointId: baseId,
      targetCheckpointId: targetId,
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.equal(result.fromTurnCount, 1);
    assert.equal(result.toTurnCount, 2);
  }).pipe(Effect.provide(testLayer({ baseTurnCount: 1, targetTurnCount: 2 }))),
);

for (const [name, exactFailure] of [
  ["cross-owner native row", "cross_owner"],
  ["non-completed capture", "non_completed"],
  ["logical capture mismatch", "logical_mismatch"],
  ["post-turn baseline link mismatch", "baseline_link_mismatch"],
] as const) {
  it.effect(`rejects an internal ${name}`, () =>
    Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery;
      const error = yield* Effect.flip(
        query.getCompletedCaptureDiff({
          providerInstanceId: providerId,
          projectId,
          threadId,
          baseCheckpointId: baseId,
          targetCheckpointId: targetId,
          fromTurnCount: 0,
          toTurnCount: 1,
        }),
      );
      assert.equal(error._tag, "CheckpointNativeProjectionError");
    }).pipe(Effect.provide(testLayer({ exactFailure }))),
  );
}

it.effect("rejects a current binding mismatch for an internal completed capture diff", () =>
  Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery;
    const error = yield* Effect.flip(
      query.getCompletedCaptureDiff({
        providerInstanceId: providerId,
        projectId,
        threadId,
        baseCheckpointId: baseId,
        targetCheckpointId: targetId,
        fromTurnCount: 0,
        toTurnCount: 1,
      }),
    );
    assert.equal(error._tag, "CheckpointProviderBindingMismatchError");
  }).pipe(Effect.provide(testLayer({ bindingFingerprint: "f".repeat(64) }))),
);

it.effect("keeps identical workspace owners separated by provider and project identity", () =>
  Effect.gen(function* () {
    const firstObservations: Array<unknown> = [];
    const secondObservations: Array<unknown> = [];
    const otherProjectId = ProjectId.make("project-other");
    const otherThreadId = ThreadId.make("thread-other");

    const first = yield* Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery;
      return yield* query.getFullThreadDiff({ threadId, toTurnCount: 1 });
    }).pipe(Effect.provide(testLayer({ observations: firstObservations })));
    const second = yield* Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery;
      return yield* query.getFullThreadDiff({ threadId: otherThreadId, toTurnCount: 1 });
    }).pipe(
      Effect.provide(
        testLayer({
          providerInstanceId: otherProviderId,
          projectId: otherProjectId,
          threadId: otherThreadId,
          observations: secondObservations,
        }),
      ),
    );

    assert.equal(first.threadId, threadId);
    assert.equal(second.threadId, otherThreadId);
    assert.isTrue(
      firstObservations.some(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          "providerInstanceId" in item &&
          item.providerInstanceId === providerId,
      ),
    );
    assert.isTrue(
      secondObservations.some(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          "providerInstanceId" in item &&
          item.providerInstanceId === otherProviderId,
      ),
    );
    assert.isTrue(
      secondObservations.some(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          "projectId" in item &&
          item.projectId === otherProjectId,
      ),
    );
  }),
);

it.effect("rejects unavailable ranges and missing completed checkpoints", () =>
  Effect.gen(function* () {
    const range = yield* Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery;
      return yield* Effect.flip(query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 }));
    }).pipe(Effect.provide(testLayer({ latestCheckpointTurnCount: 1 })));
    assert.equal(range._tag, "CheckpointTurnRangeUnavailableError");

    const missing = yield* Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery;
      return yield* Effect.flip(query.getFullThreadDiff({ threadId, toTurnCount: 1 }));
    }).pipe(Effect.provide(testLayer({ missingTurnCount: 0 })));
    assert.equal(missing._tag, "CheckpointRefUnavailableError");
    if (missing._tag === "CheckpointRefUnavailableError") assert.equal(missing.turnCount, 0);
  }),
);

it.effect("rejects stale repository bindings before calling the helper", () => {
  const observations: Array<unknown> = [];
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery;
    const error = yield* Effect.flip(query.getFullThreadDiff({ threadId, toTurnCount: 1 }));
    assert.equal(error._tag, "CheckpointProviderBindingMismatchError");
    assert.equal(observations.filter((item) => "baseCheckpointId" in Object(item)).length, 0);
  }).pipe(Effect.provide(testLayer({ bindingFingerprint: "f".repeat(64), observations })));
});

for (const [name, result] of [
  ["invalid base64", { ...defaultResult(), patchBase64: "***" }],
  ["invalid UTF-8", { ...defaultResult(), patchBase64: "/w==", byteLength: 1 }],
  ["incorrect decoded length", { ...defaultResult(), byteLength: 3 }],
] as const) {
  it.effect(`rejects ${name} provider patches`, () =>
    Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery;
      const error = yield* Effect.flip(query.getFullThreadDiff({ threadId, toTurnCount: 1 }));
      assert.equal(error._tag, "CheckpointDiffResultInvalidError");
    }).pipe(Effect.provide(testLayer({ result }))),
  );
}

it.effect("preserves an exact-cap patch length and truthful provider truncation", () => {
  const patch = "x".repeat(CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES);
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery;
    const result = yield* query.getTurnDiff({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      ignoreWhitespace: true,
    });
    assert.equal(result.byteLength, CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES);
    assert.equal(result.diff.length, CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES);
    assert.isTrue(result.truncated);
  }).pipe(
    Effect.provide(
      testLayer({
        result: {
          ...defaultResult(patch),
          truncated: true,
        },
      }),
    ),
  );
});

it.effect("sanitizes provider disconnects", () =>
  Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery;
    const error = yield* Effect.flip(query.getFullThreadDiff({ threadId, toTurnCount: 1 }));
    assert.equal(error._tag, "CheckpointProviderDisconnectedError");
    assert.notInclude(error.message, "/provider/worktree");
  }).pipe(
    Effect.provide(
      testLayer({
        diff: () =>
          Effect.fail(
            new ProviderVcsDisconnectedError({
              providerInstanceId: providerId,
              operation: "diffCheckpoints",
              cause: new Error("secret /provider/worktree"),
            }),
          ),
      }),
    ),
  ),
);
