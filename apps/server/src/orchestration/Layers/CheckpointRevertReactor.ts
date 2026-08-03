import {
  CommandId,
  EventId,
  type CodexCheckpointHelperDeleteResult,
  type CodexCheckpointHelperRestoreResult,
  type IsoDateTime,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { makeRestoreCheckpointOperationId } from "../../checkpointing/CheckpointIds.ts";
import {
  CheckpointRevertIntentRepository,
  type CheckpointRevertIntent,
} from "../../persistence/Services/CheckpointRevertIntents.ts";
import {
  CheckpointRevertSagaRepository,
  type CheckpointRevertSaga,
  type CheckpointRevertStaleTarget,
} from "../../persistence/Services/CheckpointRevertSagas.ts";
import {
  ProviderCheckpointOperationRepository,
  type ProviderCheckpointOperation,
  type ProviderCheckpointOperationError,
  type ProviderNativeCheckpoint,
} from "../../persistence/Services/ProviderCheckpointOperations.ts";
import { ProjectionCheckpointRepository } from "../../persistence/Services/ProjectionCheckpoints.ts";
import * as ProjectRepository from "../../project/ProjectRepository.ts";
import {
  ProviderVcsCheckpointOutcomeUnknownError,
  ProviderVcsCheckpointRestoreIndeterminateError,
  ProviderVcsDisconnectedError,
  ProviderVcsProtocolError,
  type ProviderVcsCheckpointCapability,
  type ProviderVcsCheckpointDeleteInput,
  type ProviderVcsPreparedCheckpointMutation,
} from "../../provider/ProviderVcsAdapter.ts";
import {
  ProviderRollbackActiveTurnError,
  ProviderRollbackOutcomeUnknownError,
} from "../../provider/Errors.ts";
import { PROVIDER_TURN_SEQUENCE_DIGEST_VERSION } from "../../provider/ProviderTurnSequenceDigest.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  CheckpointRevertBlockedError,
  CheckpointRevertReactor,
  type CheckpointRevertBlockCode,
  type CheckpointRevertProcessResult,
  type CheckpointRevertReactorShape,
  type CheckpointRevertRequestedEvent,
} from "../Services/CheckpointRevertReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const isRollbackUnknown = Schema.is(ProviderRollbackOutcomeUnknownError);
const isRollbackActive = Schema.is(ProviderRollbackActiveTurnError);
const isVcsUnknown = Schema.is(ProviderVcsCheckpointOutcomeUnknownError);
const isVcsDisconnected = Schema.is(ProviderVcsDisconnectedError);
const isVcsProtocol = Schema.is(ProviderVcsProtocolError);
const isRestoreIndeterminate = Schema.is(ProviderVcsCheckpointRestoreIndeterminateError);

const deterministicPreSagaFailures = new Set<CheckpointRevertBlockCode>([
  "thread_not_found",
  "project_not_found",
  "target_checkpoint_missing",
  "stale_checkpoint_missing",
  "repository_binding_changed",
  "checkpoint_capability_unavailable",
  "intent_conflict",
]);

const durableError = (code: string): ProviderCheckpointOperationError => ({ code });

const block = (
  code: CheckpointRevertBlockCode,
  context?: Partial<
    Pick<CheckpointRevertSaga, "sagaId" | "threadId" | "projectId" | "retainedLogicalCheckpointId">
  >,
) =>
  new CheckpointRevertBlockedError({
    code,
    ...(context?.sagaId === undefined ? {} : { sagaId: context.sagaId }),
    ...(context?.threadId === undefined ? {} : { threadId: context.threadId }),
    ...(context?.projectId === undefined ? {} : { projectId: context.projectId }),
    ...(context?.retainedLogicalCheckpointId === undefined
      ? {}
      : { logicalCheckpointId: context.retainedLogicalCheckpointId }),
  });

const sameDigest = (
  left: { readonly count: number; readonly sha256: string },
  right: { readonly turnCount: number; readonly sha256: string },
): boolean => left.count === right.turnCount && left.sha256 === right.sha256;

const mapRepositoryFailure = (error: unknown, saga?: CheckpointRevertSaga) => {
  if (isVcsDisconnected(error)) return block("repository_unavailable", saga);
  if (isVcsProtocol(error)) return block("checkpoint_prepare_failed", saga);
  return block("repository_unavailable", saga);
};

interface BoundCheckpointRepository {
  readonly checkpoints: ProviderVcsCheckpointCapability;
}

interface RevertRequest {
  readonly sourceEventId: CheckpointRevertIntent["sourceEventId"];
  readonly sourceSequence: number;
  readonly sourceCommandId: CheckpointRevertIntent["sourceCommandId"];
  readonly threadId: CheckpointRevertIntent["threadId"];
  readonly requestedTurnCount: number;
  readonly requestedAt: IsoDateTime;
  readonly createdAt: IsoDateTime;
}

const requestFromIntent = (intent: CheckpointRevertIntent): RevertRequest => ({
  sourceEventId: intent.sourceEventId,
  sourceSequence: intent.sourceSequence,
  sourceCommandId: intent.sourceCommandId,
  threadId: intent.threadId,
  requestedTurnCount: intent.requestedTurnCount,
  requestedAt: intent.requestedAt,
  createdAt: intent.createdAt,
});

const intentMatchesEvent = (
  intent: CheckpointRevertIntent,
  event: CheckpointRevertRequestedEvent,
): boolean =>
  intent.sourceEventId === event.eventId &&
  intent.sourceSequence === event.sequence &&
  intent.sourceCommandId === event.commandId &&
  intent.threadId === event.payload.threadId &&
  intent.requestedTurnCount === event.payload.turnCount &&
  intent.requestedAt === event.payload.createdAt &&
  intent.createdAt === event.occurredAt;

export const makeCheckpointRevertReactor = Effect.gen(function* () {
  const sagas = yield* CheckpointRevertSagaRepository;
  const intents = yield* CheckpointRevertIntentRepository;
  const operations = yield* ProviderCheckpointOperationRepository;
  const projectedCheckpoints = yield* ProjectionCheckpointRepository;
  const projections = yield* ProjectionSnapshotQuery;
  const projectRepository = yield* ProjectRepository.ProjectRepository;
  const providers = yield* ProviderService;
  const orchestration = yield* OrchestrationEngineService;

  const keyedLocks = yield* SynchronizedRef.make(
    new Map<string, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>(),
  );
  const withThreadLock = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      SynchronizedRef.modifyEffect(keyedLocks, (locks) => {
        const existing = locks.get(threadId);
        if (existing !== undefined) {
          const next = new Map(locks);
          next.set(threadId, { semaphore: existing.semaphore, users: existing.users + 1 });
          return Effect.succeed([existing.semaphore, next] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(locks);
            next.set(threadId, { semaphore, users: 1 });
            return [semaphore, next] as const;
          }),
        );
      }),
      (semaphore) => semaphore.withPermits(1)(effect),
      (semaphore) =>
        SynchronizedRef.update(keyedLocks, (locks) => {
          const current = locks.get(threadId);
          if (current === undefined || current.semaphore !== semaphore) return locks;
          const next = new Map(locks);
          if (current.users === 1) next.delete(threadId);
          else next.set(threadId, { semaphore, users: current.users - 1 });
          return next;
        }),
    );

  const now = Effect.fn("CheckpointRevertReactor.now")(function* () {
    return DateTime.formatIso(yield* DateTime.now);
  });

  const persist = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    saga?: CheckpointRevertSaga,
  ): Effect.Effect<A, CheckpointRevertBlockedError, R> =>
    effect.pipe(Effect.mapError(() => block("persistence_failure", saga)));

  const reload = (sagaId: CheckpointRevertSaga["sagaId"]) =>
    persist(sagas.getBySagaId({ sagaId })).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.flatMap((saga) =>
        saga === undefined ? Effect.fail(block("persistence_failure")) : Effect.succeed(saga),
      ),
    );

  const reportTerminal = Effect.fn("CheckpointRevertReactor.reportTerminal")(function* (
    intent: CheckpointRevertIntent,
    outcome: "failed" | "indeterminate",
  ) {
    yield* orchestration
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          `server:checkpoint-revert-terminal:${intent.sourceEventId}:${outcome}`,
        ),
        threadId: intent.threadId,
        activity: {
          id: EventId.make(`server:checkpoint-revert-terminal:${intent.sourceEventId}:${outcome}`),
          tone: "error",
          kind: `checkpoint.revert.${outcome}`,
          summary:
            outcome === "failed" ? "Checkpoint revert failed" : "Checkpoint revert needs attention",
          payload: { turnCount: intent.requestedTurnCount, outcome },
          turnId: null,
          createdAt: intent.requestedAt,
        },
        createdAt: intent.requestedAt,
      })
      .pipe(Effect.mapError(() => block("domain_dispatch_failed")));
  });

  const terminalResult = (
    intent: CheckpointRevertIntent,
    outcome: "completed" | "failed" | "indeterminate",
    sagaId: CheckpointRevertSaga["sagaId"] | null,
    sequence?: number,
  ): CheckpointRevertProcessResult => ({
    sourceEventId: intent.sourceEventId,
    ...(sagaId === null ? {} : { sagaId }),
    status: outcome,
    ...(sequence === undefined ? {} : { sequence }),
  });

  const settleIntent = Effect.fn("CheckpointRevertReactor.settleIntent")(function* (
    intent: CheckpointRevertIntent,
    outcome: "completed" | "failed" | "indeterminate",
    sagaId: CheckpointRevertSaga["sagaId"] | null,
    sequence?: number,
  ) {
    if (outcome !== "completed") yield* reportTerminal(intent, outcome);
    yield* persist(
      intents.markTerminal({
        sourceEventId: intent.sourceEventId,
        sagaId,
        outcome,
        terminalAt: yield* now(),
      }),
    );
    return terminalResult(intent, outcome, sagaId, sequence);
  });

  const resolveBound = Effect.fn("CheckpointRevertReactor.resolveBound")(function* (
    saga: CheckpointRevertSaga,
  ): Effect.fn.Return<BoundCheckpointRepository, CheckpointRevertBlockedError> {
    const repository = yield* projectRepository
      .resolve({ projectId: saga.projectId, threadId: saga.threadId })
      .pipe(Effect.mapError((error) => mapRepositoryFailure(error, saga)));
    const checkpoints = repository.checkpoints;
    if (checkpoints === undefined) return yield* block("checkpoint_capability_unavailable", saga);
    if (
      checkpoints.binding.fingerprint !== saga.repositoryFingerprint ||
      checkpoints.binding.objectFormat !== saga.repositoryObjectFormat
    ) {
      return yield* block("repository_binding_changed", saga);
    }
    return { checkpoints };
  });

  const markSagaIndeterminate = Effect.fn("CheckpointRevertReactor.markSagaIndeterminate")(
    function* (
      saga: CheckpointRevertSaga,
      code: string,
      publicCode: CheckpointRevertBlockCode = "provider_rollback_indeterminate",
    ) {
      yield* persist(
        sagas.markIndeterminate({
          sagaId: saga.sagaId,
          updatedAt: yield* now(),
          error: durableError(code),
        }),
        saga,
      );
      return yield* block(publicCode, saga);
    },
  );

  const createSaga = Effect.fn("CheckpointRevertReactor.createSaga")(function* (
    request: RevertRequest,
  ) {
    const existing = yield* persist(
      sagas.getBySourceEventId({ sourceRevertEventId: request.sourceEventId }),
    ).pipe(Effect.map(Option.getOrUndefined));
    if (existing !== undefined) return existing;

    const thread = yield* projections.getThreadShellById(request.threadId).pipe(
      Effect.mapError(() => block("persistence_failure")),
      Effect.map(Option.getOrUndefined),
    );
    if (thread === undefined)
      return yield* block("thread_not_found", { threadId: request.threadId });
    const project = yield* projections.getProjectShellById(thread.projectId).pipe(
      Effect.mapError(() => block("persistence_failure")),
      Effect.map(Option.getOrUndefined),
    );
    if (project === undefined) {
      return yield* block("project_not_found", {
        threadId: request.threadId,
        projectId: thread.projectId,
      });
    }
    const target = yield* persist(
      operations.getReadyLogicalCheckpoint({
        providerInstanceId: project.providerInstanceId,
        projectId: project.id,
        threadId: request.threadId,
        checkpointTurnCount: request.requestedTurnCount,
      }),
    ).pipe(Effect.map(Option.getOrUndefined));
    if (target === undefined) {
      return yield* block("target_checkpoint_missing", {
        threadId: request.threadId,
        projectId: project.id,
      });
    }

    const repository = yield* projectRepository
      .resolve({ projectId: project.id, threadId: request.threadId })
      .pipe(Effect.mapError((error) => mapRepositoryFailure(error)));
    const checkpoints = repository.checkpoints;
    if (checkpoints === undefined) return yield* block("checkpoint_capability_unavailable");
    if (
      target.repository.fingerprint !== checkpoints.binding.fingerprint ||
      target.repository.objectFormat !== checkpoints.binding.objectFormat
    ) {
      return yield* block("repository_binding_changed");
    }

    const inspection = yield* providers
      .inspectConversation({
        threadId: request.threadId,
        providerInstanceId: project.providerInstanceId,
        targetTurnCount: request.requestedTurnCount,
      })
      .pipe(Effect.mapError(() => block("provider_route_changed")));

    const summaries = yield* projectedCheckpoints
      .listByThreadId({ threadId: request.threadId })
      .pipe(Effect.mapError(() => block("persistence_failure")));
    const staleSummaries = summaries.filter(
      (summary) =>
        summary.status === "ready" &&
        summary.checkpointTurnCount > request.requestedTurnCount &&
        summary.checkpointTurnCount <= inspection.preimage.turnCount,
    );
    const staleTargets = yield* Effect.forEach(
      staleSummaries,
      (summary) =>
        persist(
          operations.getReadyLogicalCheckpoint({
            providerInstanceId: project.providerInstanceId,
            projectId: project.id,
            threadId: request.threadId,
            checkpointTurnCount: summary.checkpointTurnCount,
          }),
        ).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.flatMap((checkpoint) =>
            checkpoint === undefined ||
            String(summary.checkpointRef) !== checkpoint.logicalCheckpointId
              ? Effect.fail(block("stale_checkpoint_missing"))
              : Effect.succeed({
                  checkpointTurnCount: summary.checkpointTurnCount,
                  logicalCheckpointId: checkpoint.logicalCheckpointId,
                  expectedCheckpointOid: checkpoint.checkpointOid,
                }),
          ),
        ),
      { concurrency: 1 },
    );

    const created = yield* persist(
      sagas.getOrCreate({
        sourceRevertEventId: request.sourceEventId,
        sourceCommandId: request.sourceCommandId,
        providerInstanceId: project.providerInstanceId,
        projectId: project.id,
        threadId: request.threadId,
        providerDriverKind: inspection.binding.driverKind,
        continuationIdentitySha256: inspection.binding.continuationIdentitySha256,
        requestedTurnCount: request.requestedTurnCount,
        preimageTurnCount: inspection.preimage.turnCount,
        preimage: { count: inspection.preimage.turnCount, sha256: inspection.preimage.sha256 },
        target: { count: inspection.target.turnCount, sha256: inspection.target.sha256 },
        retainedLogicalCheckpointId: target.logicalCheckpointId,
        retainedExpectedCheckpointOid: target.checkpointOid,
        repositoryFingerprint: target.repository.fingerprint,
        repositoryObjectFormat: target.repository.objectFormat,
        restoreOperationId: makeRestoreCheckpointOperationId({
          revertEventId: request.sourceEventId,
        }),
        staleTargets,
        createdAt: request.createdAt,
      }),
    );
    return created.saga;
  });

  const recoverRollback = Effect.fn("CheckpointRevertReactor.recoverRollback")(function* (
    saga: CheckpointRevertSaga,
  ) {
    const inspected = yield* providers
      .inspectConversation({
        threadId: saga.threadId,
        providerInstanceId: saga.providerInstanceId,
        targetTurnCount: saga.requestedTurnCount,
      })
      .pipe(Effect.mapError(() => block("provider_rollback_outcome_unknown", saga)));
    if (!sameDigest(saga.target, inspected.preimage)) {
      return yield* markSagaIndeterminate(saga, "provider_conversation_diverged");
    }
    yield* persist(
      sagas.markRollbackCompleted({ sagaId: saga.sagaId, updatedAt: yield* now() }),
      saga,
    );
  });

  const dispatchRollback = Effect.fn("CheckpointRevertReactor.dispatchRollback")(function* (
    saga: CheckpointRevertSaga,
  ) {
    yield* persist(
      sagas.markRollbackInFlight({ sagaId: saga.sagaId, updatedAt: yield* now() }),
      saga,
    );
    if (saga.preimageTurnCount === saga.requestedTurnCount) {
      yield* persist(
        sagas.markRollbackCompleted({ sagaId: saga.sagaId, updatedAt: yield* now() }),
        saga,
      );
      return;
    }
    const rolledBack = yield* Effect.result(
      providers.rollbackConversationChecked({
        threadId: saga.threadId,
        providerInstanceId: saga.providerInstanceId,
        numTurns: saga.preimageTurnCount - saga.requestedTurnCount,
        expectedPreimage: {
          version: PROVIDER_TURN_SEQUENCE_DIGEST_VERSION,
          turnCount: saga.preimage.count,
          sha256: saga.preimage.sha256,
        },
        expectedTarget: {
          version: PROVIDER_TURN_SEQUENCE_DIGEST_VERSION,
          turnCount: saga.target.count,
          sha256: saga.target.sha256,
        },
        expectedDriverKind: saga.providerDriverKind,
        expectedContinuationIdentitySha256: saga.continuationIdentitySha256,
      }),
    );
    if (Result.isFailure(rolledBack)) {
      if (isRollbackUnknown(rolledBack.failure)) {
        yield* persist(
          sagas.markRollbackOutcomeUnknown({
            sagaId: saga.sagaId,
            updatedAt: yield* now(),
            error: durableError("provider_rollback_outcome_unknown"),
          }),
          saga,
        );
        return yield* block("provider_rollback_outcome_unknown", saga);
      }
      if (isRollbackActive(rolledBack.failure)) {
        return yield* markSagaIndeterminate(
          saga,
          "provider_turn_active",
          "provider_rollback_active",
        );
      }
      return yield* markSagaIndeterminate(saga, "provider_rollback_failed");
    }
    yield* persist(
      sagas.markRollbackCompleted({ sagaId: saga.sagaId, updatedAt: yield* now() }),
      saga,
    );
  });

  const exactRestoreOperation = (
    operation: ProviderCheckpointOperation,
    saga: CheckpointRevertSaga,
  ) =>
    operation.operationId === saga.restoreOperationId &&
    operation.logicalCheckpointId === saga.retainedLogicalCheckpointId &&
    operation.providerInstanceId === saga.providerInstanceId &&
    operation.projectId === saga.projectId &&
    operation.threadId === saga.threadId &&
    operation.turnId === null &&
    operation.operationKind === "restore" &&
    operation.intentContext.kind === "restore" &&
    operation.intentContext.sourceRevertEventId === saga.sourceRevertEventId &&
    operation.intentContext.sourceCommandId === saga.sourceCommandId &&
    operation.intentContext.requestedTurnCount === saga.requestedTurnCount &&
    operation.canonicalRequest.operation === "restore" &&
    operation.canonicalRequest.operationId === saga.restoreOperationId &&
    operation.canonicalRequest.checkpointId === saga.retainedLogicalCheckpointId &&
    operation.canonicalRequest.expectedCheckpointOid === saga.retainedExpectedCheckpointOid &&
    operation.repository.fingerprint === saga.repositoryFingerprint &&
    operation.repository.objectFormat === saga.repositoryObjectFormat;

  const finalizeRestore = Effect.fn("CheckpointRevertReactor.finalizeRestore")(function* (
    saga: CheckpointRevertSaga,
    operation: ProviderCheckpointOperation,
    target: ProviderNativeCheckpoint,
    result: CodexCheckpointHelperRestoreResult,
  ) {
    if (
      result.receipt.operationId !== operation.operationId ||
      result.receipt.requestSha256 !== operation.requestSha256 ||
      result.receipt.checkpointId !== target.logicalCheckpointId ||
      result.receipt.checkpointOid !== target.checkpointOid ||
      result.receipt.repositoryFingerprint !== target.repository.fingerprint
    ) {
      yield* persist(
        operations.markIndeterminate({
          operationId: operation.operationId,
          updatedAt: yield* now(),
          error: durableError("checkpoint_receipt_invalid"),
        }),
        saga,
      );
      return yield* markSagaIndeterminate(saga, "checkpoint_receipt_invalid");
    }
    const updatedAt = yield* now();
    yield* persist(
      operations.finalizeRestore({
        completion: {
          operationId: operation.operationId,
          updatedAt,
          receipt: result.receipt,
          result,
        },
        targetCheckpoint: target,
      }),
      saga,
    );
    yield* persist(sagas.markRestored({ sagaId: saga.sagaId, updatedAt }), saga);
  });

  const observeRestore = Effect.fn("CheckpointRevertReactor.observeRestore")(function* (
    saga: CheckpointRevertSaga,
    operation: ProviderCheckpointOperation,
    bound: BoundCheckpointRepository,
    target: ProviderNativeCheckpoint,
  ) {
    if (operation.state === "in_flight") {
      yield* persist(
        operations.markOutcomeUnknown({
          operationId: operation.operationId,
          updatedAt: yield* now(),
          error: durableError("checkpoint_outcome_unknown"),
        }),
        saga,
      );
    }
    const observed = yield* Effect.result(
      bound.checkpoints.observe({
        operationId: operation.operationId,
        expectedRequestSha256: operation.requestSha256,
      }),
    );
    if (Result.isFailure(observed)) return yield* block("checkpoint_outcome_unknown", saga);
    if (observed.success.status === "not_found") {
      yield* persist(
        operations.markRestoreObserveNotFound({
          operationId: operation.operationId,
          updatedAt: yield* now(),
          error: durableError("restore_receipt_not_found"),
        }),
        saga,
      );
      return yield* markSagaIndeterminate(
        saga,
        "restore_receipt_not_found",
        "checkpoint_restore_indeterminate",
      );
    }
    if (observed.success.receipt.operation !== "restore") {
      return yield* markSagaIndeterminate(
        saga,
        "checkpoint_receipt_invalid",
        "checkpoint_receipt_invalid",
      );
    }
    yield* finalizeRestore(saga, operation, target, {
      operation: "restore",
      receipt: observed.success.receipt,
      receiptObjectOid: observed.success.receiptObjectOid,
    });
  });

  const dispatchRestore = Effect.fn("CheckpointRevertReactor.dispatchRestore")(function* (
    saga: CheckpointRevertSaga,
    operation: ProviderCheckpointOperation,
    prepared: ProviderVcsPreparedCheckpointMutation<CodexCheckpointHelperRestoreResult>,
    target: ProviderNativeCheckpoint,
  ) {
    yield* persist(
      operations.markInFlight({
        operationId: operation.operationId,
        providerGeneration: prepared.generationId,
        updatedAt: yield* now(),
      }),
      saga,
    );
    const executed = yield* Effect.result(prepared.execute);
    if (Result.isFailure(executed)) {
      const ambiguous =
        isVcsUnknown(executed.failure) ||
        isVcsDisconnected(executed.failure) ||
        isVcsProtocol(executed.failure);
      yield* persist(
        ambiguous
          ? operations.markOutcomeUnknown({
              operationId: operation.operationId,
              updatedAt: yield* now(),
              error: durableError("checkpoint_outcome_unknown"),
            })
          : operations.markIndeterminate({
              operationId: operation.operationId,
              updatedAt: yield* now(),
              error: durableError("checkpoint_restore_indeterminate"),
            }),
        saga,
      );
      if (!ambiguous || isRestoreIndeterminate(executed.failure)) {
        return yield* markSagaIndeterminate(
          saga,
          "checkpoint_restore_indeterminate",
          "checkpoint_restore_indeterminate",
        );
      }
      return yield* block("checkpoint_outcome_unknown", saga);
    }
    yield* finalizeRestore(saga, operation, target, executed.success);
  });

  const processRestore = Effect.fn("CheckpointRevertReactor.processRestore")(function* (
    saga: CheckpointRevertSaga,
  ) {
    const bound = yield* resolveBound(saga);
    const target = yield* persist(
      operations.getLogicalCheckpoint({ logicalCheckpointId: saga.retainedLogicalCheckpointId }),
      saga,
    ).pipe(Effect.map(Option.getOrUndefined));
    if (
      target === undefined ||
      target.providerInstanceId !== saga.providerInstanceId ||
      target.projectId !== saga.projectId ||
      target.threadId !== saga.threadId ||
      target.checkpointOid !== saga.retainedExpectedCheckpointOid
    ) {
      return yield* markSagaIndeterminate(
        saga,
        "target_checkpoint_missing",
        "checkpoint_restore_indeterminate",
      );
    }

    let operation = yield* persist(
      operations.getByOperationId({ operationId: saga.restoreOperationId }),
      saga,
    ).pipe(Effect.map(Option.getOrUndefined));
    let prepared:
      | ProviderVcsPreparedCheckpointMutation<CodexCheckpointHelperRestoreResult>
      | undefined;
    if (operation === undefined) {
      prepared = yield* bound.checkpoints
        .prepareRestore({
          operationId: saga.restoreOperationId,
          checkpointId: saga.retainedLogicalCheckpointId,
          expectedCheckpointOid: saga.retainedExpectedCheckpointOid,
        })
        .pipe(Effect.mapError((error) => mapRepositoryFailure(error, saga)));
      const persisted = yield* persist(
        operations.getOrPrepare({
          operationId: saga.restoreOperationId,
          logicalCheckpointId: saga.retainedLogicalCheckpointId,
          providerInstanceId: saga.providerInstanceId,
          projectId: saga.projectId,
          threadId: saga.threadId,
          turnId: null,
          operationKind: "restore",
          intentContext: {
            kind: "restore",
            sourceRevertEventId: saga.sourceRevertEventId,
            sourceCommandId: saga.sourceCommandId,
            requestedTurnCount: saga.requestedTurnCount,
          },
          canonicalRequest: {
            operation: "restore",
            operationId: saga.restoreOperationId,
            checkpointId: saga.retainedLogicalCheckpointId,
            expectedCheckpointOid: saga.retainedExpectedCheckpointOid,
          },
          requestSha256: prepared.requestSha256,
          repository: {
            fingerprint: saga.repositoryFingerprint,
            objectFormat: saga.repositoryObjectFormat,
          },
          providerGeneration: prepared.generationId,
          preparedAt: yield* now(),
        }),
        saga,
      );
      operation = persisted.operation;
    }
    if (!exactRestoreOperation(operation, saga)) {
      return yield* markSagaIndeterminate(saga, "restore_intent_conflict", "intent_conflict");
    }
    if (saga.state === "rollback_completed") {
      yield* persist(sagas.markRestoring({ sagaId: saga.sagaId, updatedAt: yield* now() }), saga);
    }
    if (operation.state === "completed") {
      yield* persist(sagas.markRestored({ sagaId: saga.sagaId, updatedAt: yield* now() }), saga);
      return;
    }
    if (operation.state === "failed" || operation.state === "indeterminate") {
      return yield* markSagaIndeterminate(
        saga,
        "checkpoint_restore_indeterminate",
        "checkpoint_restore_indeterminate",
      );
    }
    if (operation.state === "prepared") {
      const exactPrepared =
        prepared ??
        (yield* bound.checkpoints
          .prepareRestore({
            operationId: operation.operationId,
            checkpointId: saga.retainedLogicalCheckpointId,
            expectedCheckpointOid: saga.retainedExpectedCheckpointOid,
          })
          .pipe(Effect.mapError((error) => mapRepositoryFailure(error, saga))));
      if (exactPrepared.requestSha256 !== operation.requestSha256) {
        return yield* markSagaIndeterminate(
          saga,
          "request_digest_changed",
          "checkpoint_restore_indeterminate",
        );
      }
      return yield* dispatchRestore(saga, operation, exactPrepared, target);
    }
    return yield* observeRestore(saga, operation, bound, target);
  });

  const finalizeDomain = Effect.fn("CheckpointRevertReactor.finalizeDomain")(function* (
    saga: CheckpointRevertSaga,
  ) {
    const finalizationStartedAt: IsoDateTime = saga.finalizationStartedAt ?? (yield* now());
    if (saga.finalizationStartedAt === null) {
      yield* persist(
        sagas.beginDomainFinalization({
          sagaId: saga.sagaId,
          finalizationStartedAt,
          updatedAt: finalizationStartedAt,
        }),
        saga,
      );
    }
    const dispatched = yield* orchestration
      .dispatch({
        type: "thread.revert.complete",
        commandId: CommandId.make(`server:checkpoint-revert:${saga.sagaId}`),
        threadId: saga.threadId,
        turnCount: saga.requestedTurnCount,
        createdAt: finalizationStartedAt,
      })
      .pipe(Effect.mapError(() => block("domain_dispatch_failed", saga)));
    yield* persist(
      sagas.markDomainFinalized({
        sagaId: saga.sagaId,
        sequence: dispatched.sequence,
        updatedAt: yield* now(),
      }),
      saga,
    );
  });

  const exactDeleteOperation = (
    operation: ProviderCheckpointOperation,
    saga: CheckpointRevertSaga,
    batch: ReadonlyArray<CheckpointRevertStaleTarget>,
  ) =>
    operation.operationKind === "delete" &&
    operation.operationId === batch[0]?.deleteOperationId &&
    operation.logicalCheckpointId === batch[0]?.logicalCheckpointId &&
    operation.providerInstanceId === saga.providerInstanceId &&
    operation.projectId === saga.projectId &&
    operation.threadId === saga.threadId &&
    operation.turnId === null &&
    operation.intentContext.kind === "delete" &&
    operation.intentContext.sourceRevertEventId === saga.sourceRevertEventId &&
    operation.intentContext.sourceCommandId === saga.sourceCommandId &&
    operation.intentContext.requestedTurnCount === saga.requestedTurnCount &&
    operation.intentContext.batchOrdinal === batch[0]?.batchOrdinal &&
    operation.canonicalRequest.operation === "delete" &&
    operation.canonicalRequest.operationId === batch[0]?.deleteOperationId &&
    operation.canonicalRequest.checkpoints.length === batch.length &&
    batch.every(
      (target, index) =>
        operation.canonicalRequest.operation === "delete" &&
        operation.canonicalRequest.checkpoints[index]?.checkpointId ===
          target.logicalCheckpointId &&
        operation.canonicalRequest.checkpoints[index]?.expectedCheckpointOid ===
          target.expectedCheckpointOid,
    ) &&
    operation.repository.fingerprint === saga.repositoryFingerprint &&
    operation.repository.objectFormat === saga.repositoryObjectFormat &&
    operation.targets.length === batch.length &&
    batch.every(
      (target, index) =>
        operation.targets[index]?.logicalCheckpointId === target.logicalCheckpointId &&
        operation.targets[index]?.expectedCheckpointOid === target.expectedCheckpointOid,
    );

  const finalizeDelete = Effect.fn("CheckpointRevertReactor.finalizeDelete")(function* (
    saga: CheckpointRevertSaga,
    operation: ProviderCheckpointOperation,
    result: CodexCheckpointHelperDeleteResult,
  ) {
    if (
      result.receipt.operationId !== operation.operationId ||
      result.receipt.requestSha256 !== operation.requestSha256 ||
      result.receipt.repositoryFingerprint !== operation.repository.fingerprint
    ) {
      return yield* block("checkpoint_receipt_invalid", saga);
    }
    yield* persist(
      operations.finalizeDelete({
        operationId: operation.operationId,
        updatedAt: yield* now(),
        receipt: result.receipt,
        result,
      }),
      saga,
    );
  });

  const processDeleteBatch = Effect.fn("CheckpointRevertReactor.processDeleteBatch")(function* (
    saga: CheckpointRevertSaga,
    batch: ReadonlyArray<CheckpointRevertStaleTarget>,
  ) {
    if (batch.length === 0 || batch.length > 256) return yield* block("intent_conflict", saga);
    const bound = yield* resolveBound(saga);
    const operationId = batch[0]!.deleteOperationId;
    let operation = yield* persist(operations.getByOperationId({ operationId }), saga).pipe(
      Effect.map(Option.getOrUndefined),
    );
    let prepared:
      | ProviderVcsPreparedCheckpointMutation<CodexCheckpointHelperDeleteResult>
      | undefined;
    const first = batch[0]!;
    const checkpoints: ProviderVcsCheckpointDeleteInput["checkpoints"] = [
      {
        checkpointId: first.logicalCheckpointId,
        expectedCheckpointOid: first.expectedCheckpointOid,
      },
      ...batch.slice(1).map((target) => ({
        checkpointId: target.logicalCheckpointId,
        expectedCheckpointOid: target.expectedCheckpointOid,
      })),
    ];
    if (operation === undefined) {
      prepared = yield* bound.checkpoints
        .prepareDelete({ operationId, checkpoints })
        .pipe(Effect.mapError((error) => mapRepositoryFailure(error, saga)));
      operation = (yield* persist(
        operations.getOrPrepare({
          operationId,
          logicalCheckpointId: batch[0]!.logicalCheckpointId,
          providerInstanceId: saga.providerInstanceId,
          projectId: saga.projectId,
          threadId: saga.threadId,
          turnId: null,
          operationKind: "delete",
          intentContext: {
            kind: "delete",
            sourceRevertEventId: saga.sourceRevertEventId,
            sourceCommandId: saga.sourceCommandId,
            requestedTurnCount: saga.requestedTurnCount,
            batchOrdinal: batch[0]!.batchOrdinal,
          },
          canonicalRequest: { operation: "delete", operationId, checkpoints },
          requestSha256: prepared.requestSha256,
          repository: {
            fingerprint: saga.repositoryFingerprint,
            objectFormat: saga.repositoryObjectFormat,
          },
          providerGeneration: prepared.generationId,
          preparedAt: yield* now(),
        }),
        saga,
      )).operation;
    }
    if (!exactDeleteOperation(operation, saga, batch)) return yield* block("intent_conflict", saga);
    if (operation.state === "completed") return;
    if (operation.state === "failed" || operation.state === "indeterminate") {
      return yield* block("checkpoint_delete_indeterminate", saga);
    }
    if (operation.state === "in_flight") {
      yield* persist(
        operations.markOutcomeUnknown({
          operationId,
          updatedAt: yield* now(),
          error: durableError("checkpoint_outcome_unknown"),
        }),
        saga,
      );
      operation = yield* persist(operations.getByOperationId({ operationId }), saga).pipe(
        Effect.map(Option.getOrThrow),
      );
    }
    if (operation.state === "outcome_unknown") {
      const observed = yield* Effect.result(
        bound.checkpoints.observe({
          operationId,
          expectedRequestSha256: operation.requestSha256,
        }),
      );
      if (Result.isFailure(observed)) return yield* block("checkpoint_outcome_unknown", saga);
      if (observed.success.status === "not_found") {
        yield* persist(
          operations.resetDeleteAfterObserveNotFound({ operationId, updatedAt: yield* now() }),
          saga,
        );
        operation = yield* persist(operations.getByOperationId({ operationId }), saga).pipe(
          Effect.map(Option.getOrThrow),
        );
      } else {
        if (observed.success.receipt.operation !== "delete") {
          return yield* block("checkpoint_receipt_invalid", saga);
        }
        return yield* finalizeDelete(saga, operation, {
          operation: "delete",
          receipt: observed.success.receipt,
          receiptObjectOid: observed.success.receiptObjectOid,
        });
      }
    }
    const exactPrepared =
      prepared ??
      (yield* bound.checkpoints
        .prepareDelete({ operationId, checkpoints })
        .pipe(Effect.mapError((error) => mapRepositoryFailure(error, saga))));
    if (exactPrepared.requestSha256 !== operation.requestSha256) {
      return yield* block("checkpoint_delete_indeterminate", saga);
    }
    yield* persist(
      operations.markInFlight({
        operationId,
        providerGeneration: exactPrepared.generationId,
        updatedAt: yield* now(),
      }),
      saga,
    );
    const executed = yield* Effect.result(exactPrepared.execute);
    if (Result.isFailure(executed)) {
      yield* persist(
        operations.markOutcomeUnknown({
          operationId,
          updatedAt: yield* now(),
          error: durableError("checkpoint_outcome_unknown"),
        }),
        saga,
      );
      return yield* block("checkpoint_outcome_unknown", saga);
    }
    yield* finalizeDelete(saga, operation, executed.success);
  });

  const prune = Effect.fn("CheckpointRevertReactor.prune")(function* (saga: CheckpointRevertSaga) {
    const targets = yield* persist(sagas.listStaleTargets({ sagaId: saga.sagaId }), saga);
    const batches = Map.groupBy(targets, (target) => target.batchOrdinal);
    for (const batchOrdinal of [...batches.keys()].toSorted((left, right) => left - right)) {
      yield* processDeleteBatch(saga, batches.get(batchOrdinal) ?? []);
    }
    const completedAt = yield* now();
    yield* persist(
      sagas.complete({ sagaId: saga.sagaId, completedAt, updatedAt: completedAt }),
      saga,
    );
  });

  const drive = Effect.fn("CheckpointRevertReactor.drive")(function* (
    initial: CheckpointRevertSaga,
  ): Effect.fn.Return<CheckpointRevertProcessResult, CheckpointRevertBlockedError> {
    for (let step = 0; step < 12; step += 1) {
      const saga = yield* reload(initial.sagaId);
      switch (saga.state) {
        case "prepared":
          yield* dispatchRollback(saga);
          break;
        case "rollback_in_flight":
        case "rollback_outcome_unknown":
          yield* recoverRollback(saga);
          break;
        case "rollback_completed":
        case "restoring":
          yield* processRestore(saga);
          break;
        case "restored":
          yield* finalizeDomain(saga);
          break;
        case "domain_finalized":
          yield* prune(saga);
          break;
        case "completed":
          return {
            sourceEventId: saga.sourceRevertEventId,
            sagaId: saga.sagaId,
            status: "completed",
            ...(saga.finalizationSequence === null ? {} : { sequence: saga.finalizationSequence }),
          };
        case "failed":
          return { sourceEventId: saga.sourceRevertEventId, sagaId: saga.sagaId, status: "failed" };
        case "indeterminate":
          return {
            sourceEventId: saga.sourceRevertEventId,
            sagaId: saga.sagaId,
            status: "indeterminate",
          };
      }
    }
    return {
      sourceEventId: initial.sourceRevertEventId,
      sagaId: initial.sagaId,
      status: "pending",
    };
  });

  const processIntent = Effect.fn("CheckpointRevertReactor.processIntent")(function* (
    initialIntent: CheckpointRevertIntent,
  ) {
    if (initialIntent.state === "terminal") {
      return terminalResult(initialIntent, initialIntent.terminalOutcome!, initialIntent.sagaId);
    }

    const attempted = yield* Effect.result(
      Effect.gen(function* () {
        const saga = yield* createSaga(requestFromIntent(initialIntent));
        const linked = yield* persist(
          intents.linkSaga({ sourceEventId: initialIntent.sourceEventId, sagaId: saga.sagaId }),
          saga,
        );
        const driven = yield* drive(saga);
        if (driven.status === "completed") {
          return yield* settleIntent(linked, "completed", saga.sagaId, driven.sequence);
        }
        if (driven.status === "failed" || driven.status === "indeterminate") {
          return yield* settleIntent(linked, driven.status, saga.sagaId);
        }
        return driven;
      }),
    );
    if (Result.isSuccess(attempted)) return attempted.success;

    const saga = yield* persist(
      sagas.getBySourceEventId({ sourceRevertEventId: initialIntent.sourceEventId }),
    ).pipe(Effect.map(Option.getOrUndefined));
    if (saga !== undefined) {
      const linked = yield* persist(
        intents.linkSaga({ sourceEventId: initialIntent.sourceEventId, sagaId: saga.sagaId }),
        saga,
      );
      const current = yield* reload(saga.sagaId);
      if (current.state === "completed") {
        return yield* settleIntent(
          linked,
          "completed",
          current.sagaId,
          current.finalizationSequence ?? undefined,
        );
      }
      if (current.state === "failed" || current.state === "indeterminate") {
        return yield* settleIntent(linked, current.state, current.sagaId);
      }
    } else if (deterministicPreSagaFailures.has(attempted.failure.code)) {
      return yield* settleIntent(initialIntent, "failed", null);
    }
    return yield* attempted.failure;
  });

  const process: CheckpointRevertReactorShape["process"] = Effect.fn(
    "CheckpointRevertReactor.process",
  )(function* (event) {
    const intent = yield* persist(
      intents.getBySourceEventId({ sourceEventId: event.eventId }),
    ).pipe(Effect.map(Option.getOrUndefined));
    if (intent === undefined || !intentMatchesEvent(intent, event)) {
      return yield* block("intent_conflict", { threadId: event.payload.threadId });
    }
    return yield* withThreadLock(intent.threadId, processIntent(intent));
  });

  const recover: CheckpointRevertReactorShape["recover"] = Effect.fn(
    "CheckpointRevertReactor.recover",
  )(function* () {
    const outcomes: CheckpointRevertProcessResult[] = [];
    let after: {
      readonly sourceSequence: number;
      readonly sourceEventId: CheckpointRevertIntent["sourceEventId"];
    } | null = null;
    for (;;) {
      const page: ReadonlyArray<CheckpointRevertIntent> = yield* persist(
        intents.listRecovery({ after, limit: 500 }),
      );
      for (const intent of page) {
        const attempted = yield* Effect.result(
          withThreadLock(intent.threadId, processIntent(intent)),
        );
        outcomes.push(
          Result.isSuccess(attempted)
            ? attempted.success
            : {
                sourceEventId: intent.sourceEventId,
                ...(intent.sagaId === null ? {} : { sagaId: intent.sagaId }),
                status: "pending",
              },
        );
      }
      const last: CheckpointRevertIntent | undefined = page.at(-1);
      if (last === undefined || page.length < 500) break;
      after = { sourceSequence: last.sourceSequence, sourceEventId: last.sourceEventId };
    }
    return outcomes;
  });

  const worker = yield* makeDrainableWorker((event: CheckpointRevertRequestedEvent) =>
    process(event).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("checkpoint revert remains pending", {
          eventId: event.eventId,
          code: error.code,
        }),
      ),
    ),
  );

  const start: CheckpointRevertReactorShape["start"] = Effect.fn("CheckpointRevertReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(orchestration.streamDomainEvents, (event) =>
          event.type === "thread.checkpoint-revert-requested" ? worker.enqueue(event) : Effect.void,
        ),
      );
      yield* recover().pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logWarning("checkpoint revert recovery remains pending", { code: error.code }),
        ),
      );
    },
  );

  return CheckpointRevertReactor.of({ process, recover, start, drain: worker.drain });
});

export const CheckpointRevertReactorLive = Layer.effect(
  CheckpointRevertReactor,
  makeCheckpointRevertReactor,
);
