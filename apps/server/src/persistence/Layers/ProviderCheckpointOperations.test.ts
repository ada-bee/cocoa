import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runCocoaMigrations } from "../CocoaMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  ProviderCheckpointOperationRepository,
  ProviderCheckpointIntentConflictError,
  ProviderCheckpointCompletionConflictError,
  ProviderCheckpointProjectionConflictError,
  ProviderCheckpointOperationTransitionError,
  type PrepareProviderCheckpointOperationInput,
  type ProviderNativeCheckpoint,
} from "../Services/ProviderCheckpointOperations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderCheckpointOperationRepositoryLive } from "./ProviderCheckpointOperations.ts";

const operationA = "11111111-1111-4111-8111-111111111111";
const operationB = "33333333-3333-4333-8333-333333333333";
const operationDelete = "55555555-5555-4555-8555-555555555555";
const operationC = "66666666-6666-4666-8666-666666666666";
const operationD = "77777777-7777-4777-8777-777777777777";
const operationE = "88888888-8888-4888-8888-888888888888";
const operationF = "99999999-9999-4999-8999-999999999999";
const operationG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationH = "12121212-1212-4121-8121-121212121212";
const operationI = "13131313-1313-4131-8131-131313131313";
const operationJ = "16161616-1616-4161-8161-161616161616";
const operationK = "18181818-1818-4181-8181-181818181818";
const operationL = "19191919-1919-4191-8191-191919191919";
const operationM = "23232323-2323-4232-8232-232323232323";
const operationN = "24242424-2424-4242-8242-242424242424";
const operationO = "25252525-2525-4252-8252-252525252525";
const checkpointA = "22222222-2222-4222-8222-222222222222";
const checkpointB = "44444444-4444-4444-8444-444444444444";
const checkpointC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const checkpointD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const checkpointE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const checkpointF = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const checkpointH = "14141414-1414-4141-8141-141414141414";
const checkpointI = "15151515-1515-4151-8151-151515151515";
const checkpointJ = "17171717-1717-4171-8171-171717171717";
const checkpointK = "20202020-2020-4202-8202-202020202020";
const checkpointL = "21212121-2121-4212-8212-212121212121";
const fingerprint = "a".repeat(64);
const checkpointOidA = "b".repeat(40);
const checkpointOidB = "c".repeat(40);
const treeOid = "d".repeat(40);
const receiptObjectOid = "e".repeat(40);
const now = "2026-08-03T12:00:00.000Z";
const later = "2026-08-03T12:01:00.000Z";
const providerInstanceId = ProviderInstanceId.make("codex-macbook");
const projectId = ProjectId.make("cocoa");
const threadId = ThreadId.make("thread-checkpoint");
const turnId = TurnId.make("turn-checkpoint");

const captureInput = (
  operationId: string,
  logicalCheckpointId: string,
): PrepareProviderCheckpointOperationInput => ({
  operationId,
  logicalCheckpointId,
  providerInstanceId,
  projectId,
  threadId,
  turnId,
  operationKind: "capture",
  canonicalRequest: { operation: "capture", operationId, checkpointId: logicalCheckpointId },
  requestSha256: fingerprint,
  repository: { fingerprint, objectFormat: "sha1" },
  providerGeneration: 7,
  preparedAt: now,
  intentContext: {
    kind: "baseline",
    sourceCommandId: CommandId.make(`command:${operationId}`),
    sourceEventId: EventId.make(`event:${operationId}`),
    messageId: MessageId.make(`message:${operationId}`),
    checkpointTurnCount: 0,
  },
});

const restoreInput = (
  operationId: string,
  logicalCheckpointId: string,
  expectedCheckpointOid: string,
): PrepareProviderCheckpointOperationInput => ({
  operationId,
  logicalCheckpointId,
  providerInstanceId,
  projectId,
  threadId,
  turnId: null,
  operationKind: "restore",
  canonicalRequest: {
    operation: "restore",
    operationId,
    checkpointId: logicalCheckpointId,
    expectedCheckpointOid,
  },
  requestSha256: fingerprint,
  repository: { fingerprint, objectFormat: "sha1" },
  providerGeneration: 7,
  preparedAt: now,
  intentContext: {
    kind: "restore",
    sourceRevertEventId: EventId.make(`event:${operationId}`),
    sourceCommandId: null,
    requestedTurnCount: 1,
  },
});

const captureResult = (operationId: string, logicalCheckpointId: string, oid: string) => {
  const receipt = {
    operation: "capture" as const,
    operationId,
    receiptRef: `refs/cocoa/checkpoint-receipts/v1/${operationId}`,
    requestSha256: fingerprint,
    repositoryFingerprint: fingerprint,
    status: "succeeded" as const,
    checkpointId: logicalCheckpointId,
    checkpointRef: `refs/cocoa/checkpoints/v1/${logicalCheckpointId}`,
    checkpointOid: oid,
    treeOid,
  };
  return { operation: "capture" as const, receipt, receiptObjectOid };
};

const checkpointProjection = (
  operationId: string,
  logicalCheckpointId: string,
  oid: string,
): ProviderNativeCheckpoint => ({
  logicalCheckpointId,
  providerInstanceId,
  projectId,
  threadId,
  turnId,
  repository: { fingerprint, objectFormat: "sha1" },
  captureOperationId: operationId,
  checkpointRef: `refs/cocoa/checkpoints/v1/${logicalCheckpointId}`,
  checkpointOid: oid,
  treeOid,
  receiptRef: `refs/cocoa/checkpoint-receipts/v1/${operationId}`,
  receiptObjectOid,
  createdAt: now,
  updatedAt: later,
});

const repositoryLayer = it.layer(
  ProviderCheckpointOperationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

repositoryLayer("ProviderCheckpointOperationRepository", (it) => {
  it.effect("persists exact path-free requests and every ordered delete target", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderCheckpointOperationRepository;
      const sql = yield* SqlClient.SqlClient;
      const input: PrepareProviderCheckpointOperationInput = {
        operationId: operationDelete,
        logicalCheckpointId: checkpointA,
        providerInstanceId,
        projectId,
        threadId,
        turnId,
        operationKind: "delete",
        canonicalRequest: {
          operation: "delete",
          operationId: operationDelete,
          checkpoints: [
            { checkpointId: checkpointA, expectedCheckpointOid: checkpointOidA },
            { checkpointId: checkpointB, expectedCheckpointOid: checkpointOidB },
          ],
        },
        requestSha256: "f".repeat(64),
        repository: { fingerprint, objectFormat: "sha1" },
        providerGeneration: null,
        preparedAt: now,
        intentContext: {
          kind: "delete",
          sourceRevertEventId: EventId.make("event:delete-request"),
          sourceCommandId: CommandId.make("command:delete-request"),
          requestedTurnCount: 1,
          batchOrdinal: 0,
        },
      };

      yield* repository.prepare(input);
      const persisted = Option.getOrThrow(
        yield* repository.getByOperationId({ operationId: operationDelete }),
      );

      assert.deepStrictEqual(persisted.canonicalRequest, input.canonicalRequest);
      assert.deepStrictEqual(persisted.targets, [
        { logicalCheckpointId: checkpointA, expectedCheckpointOid: checkpointOidA },
        { logicalCheckpointId: checkpointB, expectedCheckpointOid: checkpointOidB },
      ]);

      const raw = yield* sql<{ readonly request: string }>`
        SELECT canonical_request_json AS request
        FROM checkpoint_operations
        WHERE operation_id = ${operationDelete}
      `;
      assert.notInclude(raw[0]?.request ?? "", "gitExecutablePath");
      assert.notInclude(raw[0]?.request ?? "", "canonicalPath");
      assert.notInclude(raw[0]?.request ?? "", "/tmp");
    }),
  );

  it.effect("concurrently deduplicates a stable intent and returns its original ids", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderCheckpointOperationRepository;
      const first = captureInput(operationH, checkpointH);
      const results = yield* Effect.all(
        [repository.getOrPrepare(first), repository.getOrPrepare(first)],
        { concurrency: "unbounded" },
      );

      assert.equal(results.filter((result) => result.inserted).length, 1);
      assert.deepStrictEqual(
        new Set(results.map((result) => result.operation.operationId)),
        new Set([results.find((result) => result.inserted)?.operation.operationId]),
      );
      assert.deepStrictEqual(
        new Set(results.map((result) => result.operation.logicalCheckpointId)).size,
        1,
      );

      const conflict = yield* Effect.flip(
        repository.getOrPrepare({
          ...captureInput(operationI, checkpointI),
          intentContext: first.intentContext,
        }),
      );
      assert.isTrue(Schema.is(ProviderCheckpointIntentConflictError)(conflict));
    }),
  );

  it.effect("terminally fails an outcome-unknown mutation after receipt observation", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderCheckpointOperationRepository;
      yield* repository.prepare(captureInput(operationJ, checkpointJ));
      yield* repository.markInFlight({ operationId: operationJ, updatedAt: later });
      yield* repository.markOutcomeUnknown({
        operationId: operationJ,
        updatedAt: later,
        error: { code: "disconnected" },
      });
      yield* repository.fail({
        operationId: operationJ,
        updatedAt: later,
        error: { code: "receipt_not_found" },
      });
      assert.equal(
        Option.getOrThrow(yield* repository.getByOperationId({ operationId: operationJ })).state,
        "failed",
      );
    }),
  );

  it.effect("rejects illegal transitions and preserves unknown outcomes for recovery", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderCheckpointOperationRepository;
      yield* repository.prepare(captureInput(operationA, checkpointA));

      const illegal = yield* Effect.flip(
        repository.complete({
          operationId: operationA,
          updatedAt: later,
          receipt: null,
          result: captureResult(operationA, checkpointA, checkpointOidA),
        }),
      );
      assert.isTrue(Schema.is(ProviderCheckpointOperationTransitionError)(illegal));

      yield* repository.markInFlight({ operationId: operationA, updatedAt: later });
      yield* repository.markOutcomeUnknown({
        operationId: operationA,
        updatedAt: later,
        error: { code: "transport_timeout", summary: "Receipt unavailable" },
      });

      const pending = yield* repository.listPendingRecovery({ providerInstanceId });
      assert.equal(pending.find((row) => row.operationId === operationA)?.state, "outcome_unknown");

      yield* repository.complete({
        operationId: operationA,
        updatedAt: later,
        receipt: null,
        result: captureResult(operationA, checkpointA, checkpointOidA),
      });
      assert.equal(
        (yield* repository.listPendingRecovery({ providerInstanceId })).find(
          (row) => row.operationId === operationA,
        )?.state,
        "completed",
      );
      yield* repository.markFinalized({ operationId: operationA, updatedAt: later, sequence: 42 });
      yield* repository.markFinalized({ operationId: operationA, updatedAt: later, sequence: 42 });
      yield* Effect.flip(
        repository.markFinalized({ operationId: operationA, updatedAt: later, sequence: 43 }),
      );
      assert.isUndefined(
        (yield* repository.listPendingRecovery({ providerInstanceId })).find(
          (row) => row.operationId === operationA,
        ),
      );
    }),
  );

  it.effect("atomically finalizes captures and rolls back invalid projections", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderCheckpointOperationRepository;
      yield* repository.prepare(captureInput(operationC, checkpointC));
      yield* repository.markInFlight({ operationId: operationC, updatedAt: later });

      yield* repository.finalizeCapture({
        completion: {
          operationId: operationC,
          updatedAt: later,
          receipt: null,
          result: captureResult(operationC, checkpointC, checkpointOidA),
        },
        checkpoint: checkpointProjection(operationC, checkpointC, checkpointOidA),
      });

      assert.equal(
        Option.getOrThrow(yield* repository.getByOperationId({ operationId: operationC })).state,
        "completed",
      );
      assert.isTrue(
        Option.isSome(yield* repository.getLogicalCheckpoint({ logicalCheckpointId: checkpointC })),
      );
      const projectionConflict = yield* Effect.flip(
        repository.upsertLogicalCheckpoint({
          ...checkpointProjection(operationC, checkpointC, checkpointOidA),
          checkpointOid: checkpointOidB,
        }),
      );
      assert.isTrue(Schema.is(ProviderCheckpointProjectionConflictError)(projectionConflict));

      yield* repository.prepare(captureInput(operationD, checkpointD));
      yield* repository.markInFlight({ operationId: operationD, updatedAt: later });
      const badProjection = {
        ...checkpointProjection(operationD, checkpointD, checkpointOidB),
        providerInstanceId: ProviderInstanceId.make("wrong-provider"),
      };
      yield* Effect.flip(
        repository.finalizeCapture({
          completion: {
            operationId: operationD,
            updatedAt: later,
            receipt: null,
            result: captureResult(operationD, checkpointD, checkpointOidB),
          },
          checkpoint: badProjection,
        }),
      );
      assert.equal(
        Option.getOrThrow(yield* repository.getByOperationId({ operationId: operationD })).state,
        "in_flight",
      );
      assert.isTrue(
        Option.isNone(yield* repository.getLogicalCheckpoint({ logicalCheckpointId: checkpointD })),
      );
    }),
  );

  it.effect("atomically validates every restore receipt and retained target binding", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderCheckpointOperationRepository;
      const target = checkpointProjection(operationO, checkpointB, checkpointOidB);
      yield* repository.prepare(captureInput(operationO, checkpointB));
      yield* repository.markInFlight({ operationId: operationO, updatedAt: later });
      yield* repository.finalizeCapture({
        completion: {
          operationId: operationO,
          updatedAt: later,
          receipt: null,
          result: captureResult(operationO, checkpointB, checkpointOidB),
        },
        checkpoint: target,
      });
      yield* repository.prepare(restoreInput(operationB, checkpointB, checkpointOidB));
      yield* repository.markInFlight({ operationId: operationB, updatedAt: later });

      const receipt = {
        operation: "restore" as const,
        operationId: operationB,
        receiptRef: `refs/cocoa/checkpoint-receipts/v1/${operationB}`,
        requestSha256: fingerprint,
        repositoryFingerprint: fingerprint,
        status: "succeeded" as const,
        checkpointId: checkpointB,
        checkpointRef: target.checkpointRef,
        checkpointOid: checkpointOidB,
      };
      const mismatchedReceipt = { ...receipt, requestSha256: "f".repeat(64) };
      const conflict = yield* Effect.flip(
        repository.finalizeRestore({
          completion: {
            operationId: operationB,
            updatedAt: later,
            receipt: mismatchedReceipt,
            result: {
              operation: "restore",
              receipt: mismatchedReceipt,
              receiptObjectOid,
            },
          },
          targetCheckpoint: target,
        }),
      );
      assert.isTrue(Schema.is(ProviderCheckpointCompletionConflictError)(conflict));
      assert.equal(
        Option.getOrThrow(yield* repository.getByOperationId({ operationId: operationB })).state,
        "in_flight",
      );

      yield* repository.finalizeRestore({
        completion: {
          operationId: operationB,
          updatedAt: later,
          receipt,
          result: { operation: "restore", receipt, receiptObjectOid },
        },
        targetCheckpoint: target,
      });
      assert.equal(
        Option.getOrThrow(yield* repository.getByOperationId({ operationId: operationB })).state,
        "completed",
      );
    }),
  );

  it.effect("retries only delete after observe:not_found and never retries restore", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderCheckpointOperationRepository;
      const deleteInput: PrepareProviderCheckpointOperationInput = {
        operationId: operationM,
        logicalCheckpointId: checkpointA,
        providerInstanceId,
        projectId,
        threadId,
        turnId: null,
        operationKind: "delete",
        canonicalRequest: {
          operation: "delete",
          operationId: operationM,
          checkpoints: [{ checkpointId: checkpointA, expectedCheckpointOid: checkpointOidA }],
        },
        requestSha256: fingerprint,
        repository: { fingerprint, objectFormat: "sha1" },
        providerGeneration: 7,
        preparedAt: now,
        intentContext: {
          kind: "delete",
          sourceRevertEventId: EventId.make("event:safe-delete-retry"),
          sourceCommandId: null,
          requestedTurnCount: 1,
          batchOrdinal: 0,
        },
      };
      yield* repository.prepare(deleteInput);
      yield* repository.markInFlight({ operationId: operationM, updatedAt: later });
      yield* repository.markOutcomeUnknown({
        operationId: operationM,
        updatedAt: later,
        error: { code: "disconnected" },
      });
      yield* repository.resetDeleteAfterObserveNotFound({
        operationId: operationM,
        updatedAt: later,
      });
      const retriedDelete = Option.getOrThrow(
        yield* repository.getByOperationId({ operationId: operationM }),
      );
      assert.equal(retriedDelete.state, "prepared");
      assert.equal(retriedDelete.safeRetryCount, 1);
      assert.isNull(retriedDelete.error);
      assert.equal(retriedDelete.requestSha256, deleteInput.requestSha256);
      assert.deepStrictEqual(retriedDelete.canonicalRequest, deleteInput.canonicalRequest);

      yield* repository.prepare(restoreInput(operationN, checkpointA, checkpointOidA));
      yield* repository.markInFlight({ operationId: operationN, updatedAt: later });
      yield* repository.markOutcomeUnknown({
        operationId: operationN,
        updatedAt: later,
        error: { code: "disconnected" },
      });
      const unsafeRetry = yield* Effect.flip(
        repository.resetDeleteAfterObserveNotFound({
          operationId: operationN,
          updatedAt: later,
        }),
      );
      assert.isTrue(Schema.is(ProviderCheckpointOperationTransitionError)(unsafeRetry));
      yield* repository.markRestoreObserveNotFound({
        operationId: operationN,
        updatedAt: later,
        error: { code: "receipt_not_found" },
      });
      const restore = Option.getOrThrow(
        yield* repository.getByOperationId({ operationId: operationN }),
      );
      assert.equal(restore.state, "indeterminate");
      assert.equal(restore.safeRetryCount, 0);
    }),
  );

  it.effect("resolves completed baseline and post-turn captures by exact path-free ownership", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderCheckpointOperationRepository;
      const baseline = captureInput(operationK, checkpointK);
      const postTurn: PrepareProviderCheckpointOperationInput = {
        ...captureInput(operationL, checkpointL),
        intentContext: {
          kind: "post_turn",
          sourceEventId: EventId.make("event:post-turn"),
          turnId,
          baselineCheckpointId: checkpointK,
          checkpointTurnCount: 1,
          completedAt: later,
          outcome: "completed",
        },
      };

      for (const [input, checkpoint, oid] of [
        [baseline, checkpointProjection(operationK, checkpointK, checkpointOidA), checkpointOidA],
        [postTurn, checkpointProjection(operationL, checkpointL, checkpointOidB), checkpointOidB],
      ] as const) {
        yield* repository.prepare(input);
        yield* repository.markInFlight({ operationId: input.operationId, updatedAt: later });
        yield* repository.finalizeCapture({
          completion: {
            operationId: input.operationId,
            updatedAt: later,
            receipt: null,
            result: captureResult(input.operationId, input.logicalCheckpointId, oid),
          },
          checkpoint,
        });
      }

      const foundBaseline = yield* repository.getReadyLogicalCheckpoint({
        providerInstanceId,
        projectId,
        threadId,
        checkpointTurnCount: 0,
      });
      const foundPostTurn = yield* repository.getReadyLogicalCheckpoint({
        providerInstanceId,
        projectId,
        threadId,
        checkpointTurnCount: 1,
      });
      const wrongProvider = yield* repository.getReadyLogicalCheckpoint({
        providerInstanceId: ProviderInstanceId.make("other-provider"),
        projectId,
        threadId,
        checkpointTurnCount: 1,
      });

      assert.equal(Option.getOrThrow(foundBaseline).logicalCheckpointId, checkpointK);
      assert.equal(Option.getOrThrow(foundPostTurn).logicalCheckpointId, checkpointL);
      assert.isTrue(Option.isNone(wrongProvider));
    }),
  );

  it.effect("atomically finalizes a batch delete and removes every target projection", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderCheckpointOperationRepository;
      for (const [operationId, checkpointId, oid] of [
        [operationE, checkpointE, checkpointOidA],
        [operationF, checkpointF, checkpointOidB],
      ] as const) {
        yield* repository.prepare(captureInput(operationId, checkpointId));
        yield* repository.markInFlight({ operationId, updatedAt: later });
        yield* repository.finalizeCapture({
          completion: {
            operationId,
            updatedAt: later,
            receipt: null,
            result: captureResult(operationId, checkpointId, oid),
          },
          checkpoint: checkpointProjection(operationId, checkpointId, oid),
        });
      }

      yield* repository.prepare({
        operationId: operationG,
        logicalCheckpointId: checkpointE,
        providerInstanceId,
        projectId,
        threadId,
        turnId,
        operationKind: "delete",
        canonicalRequest: {
          operation: "delete",
          operationId: operationG,
          checkpoints: [
            { checkpointId: checkpointE, expectedCheckpointOid: checkpointOidA },
            { checkpointId: checkpointF, expectedCheckpointOid: checkpointOidB },
          ],
        },
        requestSha256: fingerprint,
        repository: { fingerprint, objectFormat: "sha1" },
        providerGeneration: 7,
        preparedAt: now,
        intentContext: {
          kind: "delete",
          sourceRevertEventId: EventId.make("event:batch-delete-request"),
          sourceCommandId: null,
          requestedTurnCount: 2,
          batchOrdinal: 0,
        },
      });
      yield* repository.markInFlight({ operationId: operationG, updatedAt: later });
      const deleteReceipt = {
        operation: "delete" as const,
        operationId: operationG,
        receiptRef: `refs/cocoa/checkpoint-receipts/v1/${operationG}`,
        requestSha256: fingerprint,
        repositoryFingerprint: fingerprint,
        status: "succeeded" as const,
        checkpoints: [
          {
            checkpointId: checkpointE,
            checkpointRef: `refs/cocoa/checkpoints/v1/${checkpointE}`,
            status: "deleted" as const,
            deletedCheckpointOid: checkpointOidA,
          },
          {
            checkpointId: checkpointF,
            checkpointRef: `refs/cocoa/checkpoints/v1/${checkpointF}`,
            status: "already_absent" as const,
          },
        ],
      } as const;
      const mismatchedReceipt = {
        ...deleteReceipt,
        checkpoints: [deleteReceipt.checkpoints[1], deleteReceipt.checkpoints[0]],
      } as const;
      const completionConflict = yield* Effect.flip(
        repository.finalizeDelete({
          operationId: operationG,
          updatedAt: later,
          receipt: mismatchedReceipt,
          result: { operation: "delete", receipt: mismatchedReceipt, receiptObjectOid },
        }),
      );
      assert.isTrue(Schema.is(ProviderCheckpointCompletionConflictError)(completionConflict));
      assert.equal(
        Option.getOrThrow(yield* repository.getByOperationId({ operationId: operationG })).state,
        "in_flight",
      );
      yield* repository.finalizeDelete({
        operationId: operationG,
        updatedAt: later,
        receipt: deleteReceipt,
        result: { operation: "delete", receipt: deleteReceipt, receiptObjectOid },
      });

      assert.isTrue(
        Option.isNone(yield* repository.getLogicalCheckpoint({ logicalCheckpointId: checkpointE })),
      );
      assert.isTrue(
        Option.isNone(yield* repository.getLogicalCheckpoint({ logicalCheckpointId: checkpointF })),
      );
      assert.equal(
        Option.getOrThrow(yield* repository.getByOperationId({ operationId: operationG })).state,
        "completed",
      );
    }),
  );
});

it.layer(NodeServices.layer)("Provider checkpoint restart recovery", (it) => {
  it.effect("reopens SQLite and recovers unresolved rows without replaying them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cocoa-checkpoint-journal-" });
      const databasePath = path.join(directory, "state.sqlite");

      const databaseLayer = ProviderCheckpointOperationRepositoryLive.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
      );
      const runWithDatabase = <A, E>(
        effect: Effect.Effect<A, E, ProviderCheckpointOperationRepository | SqlClient.SqlClient>,
      ) => effect.pipe(Effect.provide(databaseLayer), Effect.scoped);

      yield* runWithDatabase(
        Effect.gen(function* () {
          yield* runCocoaMigrations();
          const repository = yield* ProviderCheckpointOperationRepository;
          yield* repository.prepare(captureInput(operationA, checkpointA));
          yield* repository.markInFlight({ operationId: operationA, updatedAt: later });
          yield* repository.markOutcomeUnknown({
            operationId: operationA,
            updatedAt: later,
            error: { code: "disconnected", summary: "Receipt unavailable" },
          });
        }),
      );

      const recovered = yield* runWithDatabase(
        Effect.gen(function* () {
          yield* runCocoaMigrations();
          const repository = yield* ProviderCheckpointOperationRepository;
          const duplicate = captureInput(operationA, checkpointA);
          const deduplicated = yield* repository.getOrPrepare(duplicate);
          assert.isFalse(deduplicated.inserted);
          assert.equal(deduplicated.operation.operationId, operationA);
          return yield* repository.listPendingRecovery({
            providerInstanceId,
          });
        }),
      );
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.operationId, operationA);
      assert.equal(recovered[0]?.state, "outcome_unknown");
    }),
  );
});
