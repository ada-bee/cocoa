import {
  CheckpointRef,
  CommandId,
  TurnId,
  type CodexCheckpointHelperCaptureResult,
  type CodexCheckpointHelperCheckpointId,
  type IsoDateTime,
  type ProjectId,
  type ProviderInstanceId,
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

import { CheckpointDiffQuery } from "../../checkpointing/CheckpointDiffQuery.ts";
import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { makePostTurnCheckpointIdentity } from "../../checkpointing/CheckpointIds.ts";
import {
  ProviderCheckpointOperationRepository,
  type ProviderCheckpointOperation,
  type ProviderCheckpointOperationError,
  type ProviderNativeCheckpoint,
} from "../../persistence/Services/ProviderCheckpointOperations.ts";
import {
  PostTurnCheckpointIntentRepository,
  type PostTurnCheckpointIntent,
} from "../../persistence/Services/PostTurnCheckpointIntents.ts";
import {
  TurnDispatchJournalRepository,
  type TurnDispatchBaselineNotApplicableReason,
  TurnDispatchProviderTurnId,
} from "../../persistence/Services/TurnDispatchJournal.ts";
import * as ProjectRepository from "../../project/ProjectRepository.ts";
import {
  type ProviderVcsCheckpointCapability,
  ProviderVcsCheckpointOutcomeUnknownError,
  ProviderVcsDisconnectedError,
  ProviderVcsProtocolError,
  type ProviderVcsRepository,
} from "../../provider/ProviderVcsAdapter.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  PostTurnCheckpointBlockedError,
  PostTurnCheckpointReactor,
  type DurableTurnCompletedEvent,
  type PostTurnCheckpointBlockCode,
  type PostTurnCheckpointProcessResult,
  type PostTurnCheckpointReactorShape,
  type PostTurnCheckpointRecoveryOutcome,
} from "../Services/PostTurnCheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

interface PostTurnContext {
  readonly intent: PostTurnCheckpointIntent & { readonly state: "bound" };
  readonly providerInstanceId: ProviderInstanceId;
  readonly projectId: ProjectId;
  readonly logicalCheckpointId: CodexCheckpointHelperCheckpointId;
  readonly operationId: ReturnType<typeof makePostTurnCheckpointIdentity>["operationId"];
  readonly baselineCheckpointTurnCount: number;
  readonly checkpointTurnCount: number;
  readonly baselineLogicalCheckpointId: CodexCheckpointHelperCheckpointId | null;
  readonly baselineNotApplicableReason: TurnDispatchBaselineNotApplicableReason | null;
}

interface BoundRepository {
  readonly repository: ProviderVcsRepository;
  readonly checkpoints: ProviderVcsCheckpointCapability;
}

const durableError = (code: string): ProviderCheckpointOperationError => ({ code });
const isOutcomeUnknown = Schema.is(ProviderVcsCheckpointOutcomeUnknownError);
const isDisconnected = Schema.is(ProviderVcsDisconnectedError);
const isProtocolError = Schema.is(ProviderVcsProtocolError);

const block = (
  code: PostTurnCheckpointBlockCode,
  operation?: Pick<PostTurnContext, "operationId" | "logicalCheckpointId">,
) =>
  new PostTurnCheckpointBlockedError({
    code,
    ...(operation === undefined
      ? {}
      : {
          operationId: operation.operationId,
          logicalCheckpointId: operation.logicalCheckpointId,
        }),
  });

const mapRepositoryError = (
  error: ProjectRepository.ProjectRepositoryError,
  context: Pick<PostTurnContext, "operationId" | "logicalCheckpointId">,
) => {
  switch (error._tag) {
    case "ProviderVcsDisconnectedError":
      return block("provider_disconnected", context);
    case "ProviderVcsProtocolError":
    case "ProviderVcsPathError":
      return block("provider_protocol_error", context);
    default:
      return block("repository_unavailable", context);
  }
};

const mapCheckpointError = (
  error: unknown,
  context: Pick<PostTurnContext, "operationId" | "logicalCheckpointId">,
) => {
  if (isOutcomeUnknown(error)) return block("checkpoint_outcome_unknown", context);
  if (isDisconnected(error)) return block("provider_disconnected", context);
  if (isProtocolError(error)) return block("provider_protocol_error", context);
  return block("checkpoint_prepare_failed", context);
};

const exactCaptureResult = (
  operation: ProviderCheckpointOperation,
  result: CodexCheckpointHelperCaptureResult,
) =>
  result.receipt.operationId === operation.operationId &&
  result.receipt.checkpointId === operation.logicalCheckpointId &&
  result.receipt.requestSha256 === operation.requestSha256 &&
  result.receipt.repositoryFingerprint === operation.repository.fingerprint;

const nativeCheckpoint = (
  operation: ProviderCheckpointOperation,
  result: CodexCheckpointHelperCaptureResult,
  updatedAt: IsoDateTime,
): ProviderNativeCheckpoint => ({
  logicalCheckpointId: operation.logicalCheckpointId,
  providerInstanceId: operation.providerInstanceId,
  projectId: operation.projectId,
  threadId: operation.threadId,
  turnId: operation.turnId,
  repository: operation.repository,
  captureOperationId: operation.operationId,
  checkpointRef: result.receipt.checkpointRef,
  checkpointOid: result.receipt.checkpointOid,
  treeOid: result.receipt.treeOid,
  receiptRef: result.receipt.receiptRef,
  receiptObjectOid: result.receiptObjectOid,
  createdAt: operation.preparedAt,
  updatedAt,
});

const exactPersistedEvent = (operation: ProviderCheckpointOperation, context: PostTurnContext) => {
  const persisted = operation.intentContext;
  return (
    operation.operationKind === "capture" &&
    operation.operationId === context.operationId &&
    operation.logicalCheckpointId === context.logicalCheckpointId &&
    operation.providerInstanceId === context.providerInstanceId &&
    operation.projectId === context.projectId &&
    operation.threadId === context.intent.threadId &&
    operation.turnId === context.intent.turnId &&
    persisted.kind === "post_turn" &&
    persisted.sourceEventId === context.intent.sourceEventId &&
    persisted.turnId === context.intent.turnId &&
    persisted.baselineCheckpointId === context.baselineLogicalCheckpointId &&
    persisted.checkpointTurnCount === context.checkpointTurnCount &&
    persisted.completedAt === context.intent.completedAt &&
    persisted.outcome === context.intent.outcome
  );
};

export const makePostTurnCheckpointReactor = Effect.gen(function* () {
  const projectRepository = yield* ProjectRepository.ProjectRepository;
  const operations = yield* ProviderCheckpointOperationRepository;
  const intents = yield* PostTurnCheckpointIntentRepository;
  const turnDispatches = yield* TurnDispatchJournalRepository;
  const diffQuery = yield* CheckpointDiffQuery;
  const orchestration = yield* OrchestrationEngineService;

  const keyedLocks = yield* SynchronizedRef.make(
    new Map<string, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>(),
  );
  const withLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      SynchronizedRef.modifyEffect(keyedLocks, (locks) => {
        const existing = locks.get(key);
        if (existing !== undefined) {
          const next = new Map(locks);
          next.set(key, { semaphore: existing.semaphore, users: existing.users + 1 });
          return Effect.succeed([existing.semaphore, next] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(locks);
            next.set(key, { semaphore, users: 1 });
            return [semaphore, next] as const;
          }),
        );
      }),
      (semaphore) => semaphore.withPermits(1)(effect),
      (semaphore) =>
        SynchronizedRef.update(keyedLocks, (locks) => {
          const current = locks.get(key);
          if (current === undefined || current.semaphore !== semaphore) return locks;
          const next = new Map(locks);
          if (current.users === 1) next.delete(key);
          else next.set(key, { semaphore, users: current.users - 1 });
          return next;
        }),
    );

  const now = Effect.fn("PostTurnCheckpointReactor.now")(function* () {
    return DateTime.formatIso(yield* DateTime.now);
  });

  const persistence = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    context?: Pick<PostTurnContext, "operationId" | "logicalCheckpointId">,
  ): Effect.Effect<A, PostTurnCheckpointBlockedError, R> =>
    effect.pipe(Effect.mapError(() => block("persistence_failure", context)));

  const resolveBound = Effect.fn("PostTurnCheckpointReactor.resolveBound")(function* (
    operation: Pick<ProviderCheckpointOperation, "projectId" | "threadId">,
    context: Pick<PostTurnContext, "operationId" | "logicalCheckpointId">,
  ): Effect.fn.Return<BoundRepository, PostTurnCheckpointBlockedError> {
    if (operation.threadId === null) return yield* block("intent_conflict", context);
    const repository = yield* projectRepository
      .resolve({ projectId: operation.projectId, threadId: operation.threadId })
      .pipe(Effect.mapError((error) => mapRepositoryError(error, context)));
    if (repository.checkpoints === undefined)
      return yield* block("repository_unavailable", context);
    return { repository, checkpoints: repository.checkpoints };
  });

  const verifyProjection = Effect.fn("PostTurnCheckpointReactor.verifyProjection")(function* (
    operation: ProviderCheckpointOperation,
    context: Pick<PostTurnContext, "operationId" | "logicalCheckpointId">,
  ) {
    const checkpoint = yield* persistence(
      operations.getLogicalCheckpoint({ logicalCheckpointId: operation.logicalCheckpointId }),
      context,
    ).pipe(Effect.map(Option.getOrUndefined));
    if (checkpoint === undefined) return yield* block("checkpoint_projection_missing", context);
    const result = operation.result;
    if (
      result?.operation !== "capture" ||
      !exactCaptureResult(operation, result) ||
      checkpoint.providerInstanceId !== operation.providerInstanceId ||
      checkpoint.projectId !== operation.projectId ||
      checkpoint.threadId !== operation.threadId ||
      checkpoint.turnId !== operation.turnId ||
      checkpoint.repository.fingerprint !== operation.repository.fingerprint ||
      checkpoint.repository.objectFormat !== operation.repository.objectFormat ||
      checkpoint.captureOperationId !== operation.operationId ||
      checkpoint.checkpointOid !== result.receipt.checkpointOid ||
      checkpoint.treeOid !== result.receipt.treeOid ||
      checkpoint.receiptObjectOid !== result.receiptObjectOid
    ) {
      return yield* block("checkpoint_projection_conflict", context);
    }
    return checkpoint;
  });

  const finalizeDomain = Effect.fn("PostTurnCheckpointReactor.finalizeDomain")(function* (
    operation: ProviderCheckpointOperation,
  ): Effect.fn.Return<PostTurnCheckpointProcessResult, PostTurnCheckpointBlockedError> {
    const context = {
      operationId: operation.operationId,
      logicalCheckpointId: operation.logicalCheckpointId,
    };
    const intent = operation.intentContext;
    if (intent.kind !== "post_turn" || operation.threadId === null || operation.turnId === null) {
      return yield* block("intent_conflict", context);
    }
    if (operation.finalizedSequence !== null) {
      yield* persistence(
        intents.markFinalized({
          sourceEventId: intent.sourceEventId,
          sequence: operation.finalizedSequence,
          updatedAt: yield* now(),
        }),
        context,
      );
      return {
        _tag: "Finalized",
        logicalCheckpointId: operation.logicalCheckpointId,
        sequence: operation.finalizedSequence,
        status: operation.state === "completed" ? "ready" : "error",
      };
    }

    let status: "ready" | "error" = "error";
    let files: ReadonlyArray<{
      readonly path: string;
      readonly kind: string;
      readonly additions: number;
      readonly deletions: number;
    }> = [];
    if (operation.state === "completed") {
      yield* verifyProjection(operation, context);
      const diff = yield* diffQuery
        .getCompletedCaptureDiff({
          providerInstanceId: operation.providerInstanceId,
          projectId: operation.projectId,
          threadId: operation.threadId,
          baseCheckpointId: intent.baselineCheckpointId,
          targetCheckpointId: operation.logicalCheckpointId,
          fromTurnCount: intent.checkpointTurnCount - 1,
          toTurnCount: intent.checkpointTurnCount,
          ignoreWhitespace: false,
        })
        .pipe(Effect.mapError(() => block("diff_unavailable", context)));
      files = yield* Effect.try({
        try: () =>
          parseTurnDiffFilesFromUnifiedDiff(diff.diff).map((file) => ({
            ...file,
            kind: "modified",
          })),
        catch: () => block("diff_unavailable", context),
      });
      status = "ready";
    } else if (operation.state !== "failed" && operation.state !== "indeterminate") {
      return {
        _tag: "Pending",
        logicalCheckpointId: operation.logicalCheckpointId,
        state: operation.state,
      };
    }

    const commandId = CommandId.make(`server:post-turn-checkpoint:${operation.operationId}`);
    const dispatched = yield* orchestration
      .dispatch({
        type: "thread.turn.diff.complete",
        commandId,
        threadId: operation.threadId,
        turnId: operation.turnId,
        completedAt: intent.completedAt,
        checkpointRef: CheckpointRef.make(operation.logicalCheckpointId),
        status,
        files,
        checkpointTurnCount: intent.checkpointTurnCount,
        createdAt: intent.completedAt,
      })
      .pipe(Effect.mapError(() => block("domain_dispatch_failed", context)));
    yield* persistence(
      operations.markFinalized({
        operationId: operation.operationId,
        sequence: dispatched.sequence,
        updatedAt: yield* now(),
      }),
      context,
    );
    yield* persistence(
      intents.markFinalized({
        sourceEventId: intent.sourceEventId,
        sequence: dispatched.sequence,
        updatedAt: yield* now(),
      }),
      context,
    );
    return {
      _tag: "Finalized",
      logicalCheckpointId: operation.logicalCheckpointId,
      sequence: dispatched.sequence,
      status,
    };
  });

  const finalizeCapture = Effect.fn("PostTurnCheckpointReactor.finalizeCapture")(function* (
    operation: ProviderCheckpointOperation,
    result: CodexCheckpointHelperCaptureResult,
  ) {
    const context = {
      operationId: operation.operationId,
      logicalCheckpointId: operation.logicalCheckpointId,
    };
    if (!exactCaptureResult(operation, result)) {
      yield* persistence(
        operations.markIndeterminate({
          operationId: operation.operationId,
          updatedAt: yield* now(),
          error: durableError("checkpoint_receipt_invalid"),
        }),
        context,
      );
      return yield* block("checkpoint_receipt_invalid", context);
    }
    const updatedAt = yield* now();
    yield* persistence(
      operations.finalizeCapture({
        completion: {
          operationId: operation.operationId,
          updatedAt,
          receipt: result.receipt,
          result,
        },
        checkpoint: nativeCheckpoint(operation, result, updatedAt),
      }),
      context,
    );
    const completed = yield* persistence(
      operations.getByOperationId({ operationId: operation.operationId }),
      context,
    ).pipe(Effect.map(Option.getOrUndefined));
    if (completed === undefined) return yield* block("persistence_failure", context);
    return yield* finalizeDomain(completed);
  });

  const observeSent = Effect.fn("PostTurnCheckpointReactor.observeSent")(function* (
    operation: ProviderCheckpointOperation,
    bound: BoundRepository,
  ): Effect.fn.Return<PostTurnCheckpointProcessResult, PostTurnCheckpointBlockedError> {
    const context = {
      operationId: operation.operationId,
      logicalCheckpointId: operation.logicalCheckpointId,
    };
    if (
      bound.checkpoints.binding.fingerprint !== operation.repository.fingerprint ||
      bound.checkpoints.binding.objectFormat !== operation.repository.objectFormat
    ) {
      yield* persistence(
        operations.markIndeterminate({
          operationId: operation.operationId,
          updatedAt: yield* now(),
          error: durableError("repository_binding_changed"),
        }),
        context,
      );
      return yield* block("repository_binding_changed", context);
    }
    const observed = yield* Effect.result(
      bound.checkpoints.observe({
        operationId: operation.operationId,
        expectedRequestSha256: operation.requestSha256,
      }),
    );
    if (Result.isFailure(observed)) {
      if (
        operation.state === "in_flight" &&
        (isDisconnected(observed.failure) || isOutcomeUnknown(observed.failure))
      ) {
        yield* persistence(
          operations.markOutcomeUnknown({
            operationId: operation.operationId,
            updatedAt: yield* now(),
            error: durableError("provider_disconnected"),
          }),
          context,
        );
      }
      return yield* mapCheckpointError(observed.failure, context);
    }
    if (observed.success.status === "not_found") {
      yield* persistence(
        operations.fail({
          operationId: operation.operationId,
          updatedAt: yield* now(),
          error: durableError("checkpoint_not_found"),
        }),
        context,
      );
      const failed = yield* persistence(
        operations.getByOperationId({ operationId: operation.operationId }),
        context,
      ).pipe(Effect.map(Option.getOrUndefined));
      if (failed === undefined) return yield* block("persistence_failure", context);
      return yield* finalizeDomain(failed);
    }
    if (observed.success.receipt.operation !== "capture") {
      yield* persistence(
        operations.markIndeterminate({
          operationId: operation.operationId,
          updatedAt: yield* now(),
          error: durableError("checkpoint_receipt_invalid"),
        }),
        context,
      );
      return yield* block("checkpoint_receipt_invalid", context);
    }
    return yield* finalizeCapture(operation, {
      operation: "capture",
      receipt: observed.success.receipt,
      receiptObjectOid: observed.success.receiptObjectOid,
    });
  });

  const dispatchPrepared = Effect.fn("PostTurnCheckpointReactor.dispatchPrepared")(function* (
    operation: ProviderCheckpointOperation,
    bound: BoundRepository,
  ): Effect.fn.Return<PostTurnCheckpointProcessResult, PostTurnCheckpointBlockedError> {
    const context = {
      operationId: operation.operationId,
      logicalCheckpointId: operation.logicalCheckpointId,
    };
    if (
      bound.checkpoints.binding.fingerprint !== operation.repository.fingerprint ||
      bound.checkpoints.binding.objectFormat !== operation.repository.objectFormat
    ) {
      yield* persistence(
        operations.fail({
          operationId: operation.operationId,
          updatedAt: yield* now(),
          error: durableError("repository_binding_changed"),
        }),
        context,
      );
      return yield* block("repository_binding_changed", context);
    }
    const prepared = yield* bound.checkpoints
      .prepareCapture({
        operationId: operation.operationId,
        checkpointId: operation.logicalCheckpointId,
      })
      .pipe(Effect.mapError((error) => mapCheckpointError(error, context)));
    if (prepared.requestSha256 !== operation.requestSha256) {
      yield* persistence(
        operations.fail({
          operationId: operation.operationId,
          updatedAt: yield* now(),
          error: durableError("request_digest_changed"),
        }),
        context,
      );
      return yield* block("request_digest_changed", context);
    }
    yield* persistence(
      operations.markInFlight({
        operationId: operation.operationId,
        providerGeneration: prepared.generationId,
        updatedAt: yield* now(),
      }),
      context,
    );
    const executed = yield* Effect.result(prepared.execute);
    if (Result.isFailure(executed)) {
      const ambiguous =
        isOutcomeUnknown(executed.failure) ||
        isDisconnected(executed.failure) ||
        isProtocolError(executed.failure);
      yield* persistence(
        ambiguous
          ? operations.markOutcomeUnknown({
              operationId: operation.operationId,
              updatedAt: yield* now(),
              error: durableError("checkpoint_outcome_unknown"),
            })
          : operations.fail({
              operationId: operation.operationId,
              updatedAt: yield* now(),
              error: durableError("checkpoint_capture_failed"),
            }),
        context,
      );
      return yield* mapCheckpointError(executed.failure, context);
    }
    return yield* finalizeCapture(operation, executed.success);
  });

  const processExisting = Effect.fn("PostTurnCheckpointReactor.processExisting")(function* (
    operation: ProviderCheckpointOperation,
    context?: PostTurnContext,
  ): Effect.fn.Return<PostTurnCheckpointProcessResult, PostTurnCheckpointBlockedError> {
    if (context !== undefined && !exactPersistedEvent(operation, context)) {
      return yield* block("intent_conflict", context);
    }
    if (
      operation.state === "completed" ||
      operation.state === "failed" ||
      operation.state === "indeterminate"
    ) {
      return yield* finalizeDomain(operation);
    }
    const bound = yield* resolveBound(operation, {
      operationId: operation.operationId,
      logicalCheckpointId: operation.logicalCheckpointId,
    });
    return operation.state === "prepared"
      ? yield* dispatchPrepared(operation, bound)
      : yield* observeSent(operation, bound);
  });

  const materializeContext = Effect.fn("PostTurnCheckpointReactor.materializeContext")(function* (
    intent: PostTurnCheckpointIntent,
  ) {
    if (intent.state !== "bound") return yield* block("intent_conflict");
    if (
      intent.providerInstanceId === null ||
      intent.projectId === null ||
      intent.baselineCheckpointTurnCount === null ||
      intent.checkpointTurnCount === null ||
      intent.operationId === null ||
      intent.logicalCheckpointId === null
    ) {
      return yield* block("intent_conflict");
    }
    return {
      intent: intent as PostTurnCheckpointIntent & { readonly state: "bound" },
      providerInstanceId: intent.providerInstanceId,
      projectId: intent.projectId,
      logicalCheckpointId: intent.logicalCheckpointId,
      operationId: intent.operationId,
      baselineCheckpointTurnCount: intent.baselineCheckpointTurnCount,
      checkpointTurnCount: intent.checkpointTurnCount,
      baselineLogicalCheckpointId: intent.baselineLogicalCheckpointId,
      baselineNotApplicableReason: intent.baselineNotApplicableReason,
    } satisfies PostTurnContext;
  });

  const finalizeBoundTurnDispatch = Effect.fn(
    "PostTurnCheckpointReactor.finalizeBoundTurnDispatch",
  )(function* (intent: PostTurnCheckpointIntent) {
    if (intent.state !== "bound") return yield* block("intent_conflict");
    if (intent.providerTurnId === null) return yield* block("intent_conflict");
    const dispatch = yield* turnDispatches
      .getStartedByProviderTurn({
        threadId: intent.threadId,
        providerTurnId: intent.providerTurnId,
      })
      .pipe(
        Effect.mapError(() => block("persistence_failure")),
        Effect.map(Option.getOrUndefined),
      );
    if (dispatch === undefined) return yield* block("thread_not_found");
    yield* turnDispatches
      .markFinalized({
        dispatchId: dispatch.dispatchId,
        sequence: intent.sourceSequence,
        updatedAt: intent.completedAt,
      })
      .pipe(Effect.mapError(() => block("persistence_failure")));
  });

  const loadContext = Effect.fn("PostTurnCheckpointReactor.loadContext")(function* (
    projected: PostTurnCheckpointIntent,
  ) {
    if (projected.state === "uncorrelatable") return Option.none<PostTurnContext>();
    if (projected.state === "bound") {
      yield* finalizeBoundTurnDispatch(projected);
      return Option.some(yield* materializeContext(projected));
    }
    if (projected.providerTurnId === null) return yield* block("intent_conflict");
    const dispatch = yield* turnDispatches
      .getStartedByProviderTurn({
        threadId: projected.threadId,
        providerTurnId: projected.providerTurnId,
      })
      .pipe(
        Effect.mapError(() => block("persistence_failure")),
        Effect.map(Option.getOrUndefined),
      );
    if (dispatch === undefined) return yield* block("thread_not_found");
    const identity = makePostTurnCheckpointIdentity({
      providerInstanceId: dispatch.providerInstanceId,
      threadId: projected.threadId,
      providerTurnId: TurnId.make(projected.providerTurnId),
    });
    const checkpointTurnCount = dispatch.checkpointTurnCount + 1;
    if (
      !Number.isSafeInteger(checkpointTurnCount) ||
      (dispatch.baselineLogicalCheckpointId === null) ===
        (dispatch.baselineNotApplicableReason === null)
    ) {
      return yield* block("intent_conflict", identity);
    }
    const bound = yield* persistence(
      intents.bind({
        sourceEventId: projected.sourceEventId,
        providerInstanceId: dispatch.providerInstanceId,
        projectId: dispatch.projectId,
        baselineCheckpointTurnCount: dispatch.checkpointTurnCount,
        checkpointTurnCount,
        baselineLogicalCheckpointId: dispatch.baselineLogicalCheckpointId,
        baselineNotApplicableReason: dispatch.baselineNotApplicableReason,
        ...identity,
        updatedAt: yield* now(),
      }),
      identity,
    );
    yield* finalizeBoundTurnDispatch(bound);
    return Option.some(yield* materializeContext(bound));
  });

  const processUnlocked = Effect.fn("PostTurnCheckpointReactor.processUnlocked")(function* (
    context: PostTurnContext,
  ): Effect.fn.Return<PostTurnCheckpointProcessResult, PostTurnCheckpointBlockedError> {
    if (
      context.baselineLogicalCheckpointId === null &&
      context.baselineNotApplicableReason !== null
    ) {
      const dispatched = yield* orchestration
        .dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`server:post-turn-checkpoint:${context.operationId}`),
          threadId: context.intent.threadId,
          turnId: context.intent.turnId,
          completedAt: context.intent.completedAt,
          checkpointRef: CheckpointRef.make(context.logicalCheckpointId),
          status: "missing",
          files: [],
          checkpointTurnCount: context.checkpointTurnCount,
          createdAt: context.intent.completedAt,
        })
        .pipe(Effect.mapError(() => block("domain_dispatch_failed", context)));
      yield* persistence(
        intents.markFinalized({
          sourceEventId: context.intent.sourceEventId,
          sequence: dispatched.sequence,
          updatedAt: yield* now(),
        }),
        context,
      );
      return {
        _tag: "Finalized",
        logicalCheckpointId: context.logicalCheckpointId,
        sequence: dispatched.sequence,
        status: "missing",
      };
    }
    if (context.baselineLogicalCheckpointId === null) {
      return yield* block("baseline_missing", context);
    }
    const existing = yield* persistence(
      operations.getByOperationId({ operationId: context.operationId }),
      context,
    ).pipe(Effect.map(Option.getOrUndefined));
    if (existing !== undefined) return yield* processExisting(existing, context);

    const baseline = yield* persistence(
      operations.getReadyLogicalCheckpoint({
        providerInstanceId: context.providerInstanceId,
        projectId: context.projectId,
        threadId: context.intent.threadId,
        checkpointTurnCount: context.baselineCheckpointTurnCount,
      }),
      context,
    ).pipe(Effect.map(Option.getOrUndefined));
    if (
      baseline === undefined ||
      baseline.logicalCheckpointId !== context.baselineLogicalCheckpointId
    ) {
      return yield* block("baseline_missing", context);
    }

    const bound = yield* resolveBound(
      { projectId: context.projectId, threadId: context.intent.threadId },
      context,
    );
    const prepared = yield* bound.checkpoints
      .prepareCapture({
        operationId: context.operationId,
        checkpointId: context.logicalCheckpointId,
      })
      .pipe(Effect.mapError((error) => mapCheckpointError(error, context)));
    const persisted = yield* persistence(
      operations.getOrPrepare({
        operationId: context.operationId,
        logicalCheckpointId: context.logicalCheckpointId,
        providerInstanceId: context.providerInstanceId,
        projectId: context.projectId,
        threadId: context.intent.threadId,
        turnId: context.intent.turnId,
        operationKind: "capture",
        intentContext: {
          kind: "post_turn",
          sourceEventId: context.intent.sourceEventId,
          turnId: context.intent.turnId,
          baselineCheckpointId: baseline.logicalCheckpointId,
          checkpointTurnCount: context.checkpointTurnCount,
          completedAt: context.intent.completedAt,
          outcome: context.intent.outcome,
        },
        canonicalRequest: {
          operation: "capture",
          operationId: context.operationId,
          checkpointId: context.logicalCheckpointId,
        },
        requestSha256: prepared.requestSha256,
        repository: {
          fingerprint: bound.checkpoints.binding.fingerprint,
          objectFormat: bound.checkpoints.binding.objectFormat,
        },
        providerGeneration: prepared.generationId,
        preparedAt: context.intent.completedAt,
      }),
      context,
    );
    if (!exactPersistedEvent(persisted.operation, context)) {
      return yield* block("intent_conflict", context);
    }
    if (persisted.operation.state !== "prepared") {
      return yield* processExisting(persisted.operation, context);
    }
    // Dispatch only after the exact request digest and generation are durable.
    yield* persistence(
      operations.markInFlight({
        operationId: context.operationId,
        providerGeneration: prepared.generationId,
        updatedAt: yield* now(),
      }),
      context,
    );
    const executed = yield* Effect.result(prepared.execute);
    if (Result.isFailure(executed)) {
      const ambiguous =
        isOutcomeUnknown(executed.failure) ||
        isDisconnected(executed.failure) ||
        isProtocolError(executed.failure);
      yield* persistence(
        ambiguous
          ? operations.markOutcomeUnknown({
              operationId: context.operationId,
              updatedAt: yield* now(),
              error: durableError("checkpoint_outcome_unknown"),
            })
          : operations.fail({
              operationId: context.operationId,
              updatedAt: yield* now(),
              error: durableError("checkpoint_capture_failed"),
            }),
        context,
      );
      return yield* mapCheckpointError(executed.failure, context);
    }
    return yield* finalizeCapture(persisted.operation, executed.success);
  });

  const processIntent = (projected: PostTurnCheckpointIntent) =>
    loadContext(projected).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.succeed({
              _tag: "Ignored" as const,
              reason: "provider_turn_id_missing" as const,
            }),
          onSome: (context) =>
            withLock(
              `${context.providerInstanceId}\0${context.intent.threadId}\0${context.operationId}`,
              processUnlocked(context),
            ),
        }),
      ),
    );

  const isProviderTurnId = Schema.is(TurnDispatchProviderTurnId);
  const processTurnCompleted: PostTurnCheckpointReactorShape["processTurnCompleted"] = (event) =>
    persistence(
      intents.projectInTransaction({
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        providerTurnId:
          event.payload.providerTurnId !== undefined &&
          isProviderTurnId(event.payload.providerTurnId)
            ? event.payload.providerTurnId
            : null,
        outcome: event.payload.outcome,
        completedAt: event.payload.completedAt,
      }),
    ).pipe(Effect.flatMap(processIntent));

  const recoverOne = Effect.fn("PostTurnCheckpointReactor.recoverOne")(function* (
    intent: PostTurnCheckpointIntent,
    providerInstanceId?: ProviderInstanceId,
  ): Effect.fn.Return<PostTurnCheckpointRecoveryOutcome, never> {
    const loaded = yield* Effect.result(loadContext(intent));
    if (Result.isFailure(loaded)) {
      return {
        sourceEventId: intent.sourceEventId,
        status: loaded.failure.code === "thread_not_found" ? "pending" : "failed",
        blockCode: loaded.failure.code,
      };
    }
    if (Option.isNone(loaded.success)) {
      return { sourceEventId: intent.sourceEventId, status: "unchanged" };
    }
    const context = loaded.success.value;
    if (providerInstanceId !== undefined && context.providerInstanceId !== providerInstanceId) {
      return {
        sourceEventId: intent.sourceEventId,
        operationId: context.operationId,
        logicalCheckpointId: context.logicalCheckpointId,
        status: "unchanged",
      };
    }
    const result = yield* Effect.result(
      withLock(
        `${context.providerInstanceId}\0${context.intent.threadId}\0${context.operationId}`,
        processUnlocked(context),
      ),
    );
    if (Result.isSuccess(result)) {
      return {
        sourceEventId: intent.sourceEventId,
        operationId: context.operationId,
        logicalCheckpointId: context.logicalCheckpointId,
        status: result.success._tag === "Finalized" ? "finalized" : "pending",
      };
    }
    const pending =
      result.failure.code === "provider_disconnected" ||
      result.failure.code === "checkpoint_outcome_unknown" ||
      result.failure.code === "diff_unavailable" ||
      result.failure.code === "domain_dispatch_failed" ||
      result.failure.code === "repository_unavailable";
    return {
      sourceEventId: intent.sourceEventId,
      operationId: context.operationId,
      logicalCheckpointId: context.logicalCheckpointId,
      status: pending ? "pending" : "failed",
      blockCode: result.failure.code,
    };
  });

  const recover: PostTurnCheckpointReactorShape["recover"] = (providerInstanceId) =>
    Effect.gen(function* () {
      const outcomes: Array<PostTurnCheckpointRecoveryOutcome> = [];
      let after:
        | { sourceSequence: number; sourceEventId: PostTurnCheckpointIntent["sourceEventId"] }
        | undefined;
      while (true) {
        const rows = yield* persistence(
          intents.listRecovery({
            ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
            ...(after === undefined ? {} : { after }),
            limit: 500,
          }),
        );
        outcomes.push(
          ...(yield* Effect.forEach(rows, (row) => recoverOne(row, providerInstanceId), {
            concurrency: 1,
          })),
        );
        const last = rows.at(-1);
        if (last === undefined || rows.length < 500) break;
        after = { sourceSequence: last.sourceSequence, sourceEventId: last.sourceEventId };
      }
      return outcomes;
    });

  const worker = yield* makeDrainableWorker((event: DurableTurnCompletedEvent) =>
    processTurnCompleted(event).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("post-turn checkpoint event remains unfinalized", {
          eventId: event.eventId,
          code: error.code,
        }),
      ),
    ),
  );

  const start: PostTurnCheckpointReactorShape["start"] = Effect.fn(
    "PostTurnCheckpointReactor.start",
  )(function* () {
    // Hot events are only an acceleration path. The checkpoint projector
    // durably creates recovery intents in the same transaction as its cursor.
    yield* forkParked(
      Stream.runForEach(orchestration.streamDomainEvents, (event) =>
        event.type === "thread.turn-completed" ? worker.enqueue(event) : Effect.void,
      ),
    );

    yield* recover().pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("post-turn checkpoint recovery remains pending", { code: error.code }),
      ),
    );
  });

  return PostTurnCheckpointReactor.of({
    processTurnCompleted,
    recover,
    start,
    drain: worker.drain,
  });
});

export const PostTurnCheckpointReactorLive = Layer.effect(
  PostTurnCheckpointReactor,
  makePostTurnCheckpointReactor,
);
