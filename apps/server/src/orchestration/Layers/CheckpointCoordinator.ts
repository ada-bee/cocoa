import {
  type CodexCheckpointHelperCaptureResult,
  type CodexCheckpointHelperCheckpointId,
  type IsoDateTime,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { makeBaselineCheckpointIdentity } from "../../checkpointing/CheckpointIds.ts";
import {
  ProviderCheckpointOperationRepository,
  type ProviderCheckpointOperation,
  type ProviderCheckpointOperationError,
  type ProviderNativeCheckpoint,
} from "../../persistence/Services/ProviderCheckpointOperations.ts";
import * as ProjectRepository from "../../project/ProjectRepository.ts";
import {
  type ProviderVcsCheckpointCapability,
  ProviderVcsCheckpointOutcomeUnknownError,
  ProviderVcsDisconnectedError,
  ProviderVcsProtocolError,
  type ProviderVcsRepository,
} from "../../provider/ProviderVcsAdapter.ts";
import {
  CheckpointCoordinator,
  CheckpointCoordinatorBlockedError,
  type CheckpointCoordinatorBlockCode,
  type CheckpointCoordinatorShape,
  type BaselineCheckpointGateIntent,
  type BaselineCheckpointGateResult,
  type CheckpointRecoveryOutcome,
} from "../Services/CheckpointCoordinator.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

interface BaselineContext {
  readonly intent: BaselineCheckpointGateIntent;
  readonly providerInstanceId: ProviderInstanceId;
  readonly logicalCheckpointId: CodexCheckpointHelperCheckpointId;
  readonly operationId: ReturnType<typeof makeBaselineCheckpointIdentity>["operationId"];
}

interface BoundRepository {
  readonly repository: ProviderVcsRepository;
  readonly checkpoints: ProviderVcsCheckpointCapability;
}

type RepositoryResolution =
  | {
      readonly _tag: "NotApplicable";
      readonly reason: "not_repository" | "checkpoint_capability_unavailable";
    }
  | { readonly _tag: "Bound"; readonly bound: BoundRepository };

const durableError = (code: string): ProviderCheckpointOperationError => ({ code });

const isOutcomeUnknown = Schema.is(ProviderVcsCheckpointOutcomeUnknownError);
const isDisconnected = Schema.is(ProviderVcsDisconnectedError);
const isProtocolError = Schema.is(ProviderVcsProtocolError);

const block = (
  code: CheckpointCoordinatorBlockCode,
  context?: Partial<Pick<BaselineContext, "intent" | "logicalCheckpointId">>,
) =>
  new CheckpointCoordinatorBlockedError({
    code,
    ...(context?.intent === undefined
      ? {}
      : { projectId: context.intent.projectId, threadId: context.intent.threadId }),
    ...(context?.logicalCheckpointId === undefined
      ? {}
      : { logicalCheckpointId: context.logicalCheckpointId }),
  });

const mapRepositoryError = (
  error: ProjectRepository.ProjectRepositoryError,
  context: Pick<BaselineContext, "intent" | "logicalCheckpointId">,
) => {
  switch (error._tag) {
    case "ProviderVcsDisconnectedError":
      return block("provider_disconnected", context);
    case "ProviderVcsProtocolError":
    case "ProviderVcsPathError":
      return block("provider_protocol_error", context);
    case "ProviderVcsCheckpointOutcomeUnknownError":
      return block("checkpoint_outcome_unknown", context);
    case "ProjectRepositoryProjectNotFoundError":
      return block("project_not_found", context);
    default:
      return block("repository_unavailable", context);
  }
};

const mapCheckpointError = (
  error: unknown,
  context: Pick<BaselineContext, "intent" | "logicalCheckpointId">,
): CheckpointCoordinatorBlockedError => {
  if (isOutcomeUnknown(error)) {
    return block("checkpoint_outcome_unknown", context);
  }
  if (isDisconnected(error)) {
    return block("provider_disconnected", context);
  }
  if (isProtocolError(error)) {
    return block("provider_protocol_error", context);
  }
  return block("checkpoint_prepare_failed", context);
};

const exactBaselineIntent = (
  operation: ProviderCheckpointOperation,
  context: BaselineContext,
): boolean => {
  const persisted = operation.intentContext;
  return (
    operation.operationKind === "capture" &&
    operation.operationId === context.operationId &&
    operation.logicalCheckpointId === context.logicalCheckpointId &&
    operation.providerInstanceId === context.providerInstanceId &&
    operation.projectId === context.intent.projectId &&
    operation.threadId === context.intent.threadId &&
    operation.turnId === null &&
    persisted.kind === "baseline" &&
    persisted.sourceCommandId === context.intent.sourceCommandId &&
    persisted.sourceEventId === context.intent.sourceEventId &&
    persisted.messageId === context.intent.messageId &&
    persisted.checkpointTurnCount === context.intent.checkpointTurnCount
  );
};

const exactCaptureResult = (
  operation: ProviderCheckpointOperation,
  result: CodexCheckpointHelperCaptureResult,
): boolean =>
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
  turnId: null,
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

export const makeCheckpointCoordinator = Effect.gen(function* () {
  const projects = yield* ProjectionSnapshotQuery;
  const projectRepository = yield* ProjectRepository.ProjectRepository;
  const operations = yield* ProviderCheckpointOperationRepository;

  const keyedLocks = yield* SynchronizedRef.make(
    new Map<string, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>(),
  );

  const withIntentLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
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

  const now = Effect.fn("CheckpointCoordinator.now")(function* () {
    return DateTime.formatIso(yield* DateTime.now);
  });

  const persistence = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    context?: Pick<BaselineContext, "intent" | "logicalCheckpointId">,
  ): Effect.Effect<A, CheckpointCoordinatorBlockedError, R> =>
    effect.pipe(Effect.mapError(() => block("persistence_failure", context)));

  const loadContext = Effect.fn("CheckpointCoordinator.loadContext")(function* (
    intent: BaselineCheckpointGateIntent,
  ) {
    const project = yield* projects.getProjectShellById(intent.projectId).pipe(
      Effect.mapError(() => block("persistence_failure", { intent })),
      Effect.map(Option.getOrUndefined),
    );
    if (project === undefined) return yield* block("project_not_found", { intent });
    const identity = makeBaselineCheckpointIdentity({
      providerInstanceId: project.providerInstanceId,
      threadId: intent.threadId,
      sourceCommandId: intent.sourceCommandId,
    });
    return {
      intent,
      providerInstanceId: project.providerInstanceId,
      ...identity,
    } satisfies BaselineContext;
  });

  const resolveRepository = Effect.fn("CheckpointCoordinator.resolveRepository")(function* (
    context: BaselineContext,
  ): Effect.fn.Return<RepositoryResolution, CheckpointCoordinatorBlockedError> {
    const resolved = yield* projectRepository
      .resolve({ projectId: context.intent.projectId, threadId: context.intent.threadId })
      .pipe(
        Effect.map((repository) => ({ _tag: "Repository" as const, repository })),
        Effect.catchTag("ProjectRepositoryNotRepositoryError", () =>
          Effect.succeed({ _tag: "NotRepository" as const }),
        ),
        Effect.mapError((error) => mapRepositoryError(error, context)),
      );
    if (resolved._tag === "NotRepository") {
      return { _tag: "NotApplicable", reason: "not_repository" };
    }
    if (resolved.repository.checkpoints === undefined) {
      return { _tag: "NotApplicable", reason: "checkpoint_capability_unavailable" };
    }
    return {
      _tag: "Bound",
      bound: { repository: resolved.repository, checkpoints: resolved.repository.checkpoints },
    };
  });

  const verifyCompleted = Effect.fn("CheckpointCoordinator.verifyCompleted")(function* (
    operation: ProviderCheckpointOperation,
    context: Pick<BaselineContext, "intent" | "logicalCheckpointId">,
  ): Effect.fn.Return<BaselineCheckpointGateResult, CheckpointCoordinatorBlockedError> {
    const checkpoint = yield* persistence(
      operations.getLogicalCheckpoint({ logicalCheckpointId: operation.logicalCheckpointId }),
      context,
    ).pipe(Effect.map(Option.getOrUndefined));
    if (checkpoint === undefined) return yield* block("checkpoint_projection_missing", context);
    const result = operation.result;
    const exact =
      result?.operation === "capture" &&
      exactCaptureResult(operation, result) &&
      checkpoint.logicalCheckpointId === operation.logicalCheckpointId &&
      checkpoint.providerInstanceId === operation.providerInstanceId &&
      checkpoint.projectId === operation.projectId &&
      checkpoint.threadId === operation.threadId &&
      checkpoint.turnId === null &&
      checkpoint.repository.fingerprint === operation.repository.fingerprint &&
      checkpoint.repository.objectFormat === operation.repository.objectFormat &&
      checkpoint.captureOperationId === operation.operationId &&
      checkpoint.checkpointRef === result.receipt.checkpointRef &&
      checkpoint.checkpointOid === result.receipt.checkpointOid &&
      checkpoint.treeOid === result.receipt.treeOid &&
      checkpoint.receiptRef === result.receipt.receiptRef &&
      checkpoint.receiptObjectOid === result.receiptObjectOid;
    if (!exact) return yield* block("checkpoint_projection_conflict", context);
    return { _tag: "Ready", logicalCheckpointId: operation.logicalCheckpointId };
  });

  const finalize = Effect.fn("CheckpointCoordinator.finalizeCapture")(function* (
    operation: ProviderCheckpointOperation,
    result: CodexCheckpointHelperCaptureResult,
    context: Pick<BaselineContext, "intent" | "logicalCheckpointId">,
  ) {
    if (!exactCaptureResult(operation, result)) {
      const updatedAt = yield* now();
      yield* persistence(
        operations.markIndeterminate({
          operationId: operation.operationId,
          updatedAt,
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
    return {
      _tag: "Ready",
      logicalCheckpointId: operation.logicalCheckpointId,
    } satisfies BaselineCheckpointGateResult;
  });

  const markBindingChanged = Effect.fn("CheckpointCoordinator.markBindingChanged")(function* (
    operation: ProviderCheckpointOperation,
    context: Pick<BaselineContext, "intent" | "logicalCheckpointId">,
  ) {
    const updatedAt = yield* now();
    const transition =
      operation.state === "prepared"
        ? operations.fail({
            operationId: operation.operationId,
            updatedAt,
            error: durableError("repository_binding_changed"),
          })
        : operations.markIndeterminate({
            operationId: operation.operationId,
            updatedAt,
            error: durableError("repository_binding_changed"),
          });
    yield* persistence(transition, context);
    return yield* block("repository_binding_changed", context);
  });

  const observeSent = Effect.fn("CheckpointCoordinator.observeSent")(function* (
    operation: ProviderCheckpointOperation,
    bound: BoundRepository,
    context: Pick<BaselineContext, "intent" | "logicalCheckpointId">,
  ): Effect.fn.Return<BaselineCheckpointGateResult, CheckpointCoordinatorBlockedError> {
    if (
      bound.checkpoints.binding.fingerprint !== operation.repository.fingerprint ||
      bound.checkpoints.binding.objectFormat !== operation.repository.objectFormat
    ) {
      return yield* markBindingChanged(operation, context);
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
      return yield* block("checkpoint_failed", context);
    }
    const receipt = observed.success.receipt;
    if (receipt.operation !== "capture") {
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
    return yield* finalize(
      operation,
      { operation: "capture", receipt, receiptObjectOid: observed.success.receiptObjectOid },
      context,
    );
  });

  const dispatchPrepared = Effect.fn("CheckpointCoordinator.dispatchPrepared")(function* (
    operation: ProviderCheckpointOperation,
    bound: BoundRepository,
    context: Pick<BaselineContext, "intent" | "logicalCheckpointId">,
  ): Effect.fn.Return<BaselineCheckpointGateResult, CheckpointCoordinatorBlockedError> {
    if (
      bound.checkpoints.binding.fingerprint !== operation.repository.fingerprint ||
      bound.checkpoints.binding.objectFormat !== operation.repository.objectFormat
    ) {
      return yield* markBindingChanged(operation, context);
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
      if (ambiguous) {
        yield* persistence(
          operations.markOutcomeUnknown({
            operationId: operation.operationId,
            updatedAt: yield* now(),
            error: durableError("checkpoint_outcome_unknown"),
          }),
          context,
        );
      } else {
        yield* persistence(
          operations.fail({
            operationId: operation.operationId,
            updatedAt: yield* now(),
            error: durableError("checkpoint_capture_failed"),
          }),
          context,
        );
      }
      return yield* mapCheckpointError(executed.failure, context);
    }
    return yield* finalize(operation, executed.success, context);
  });

  const processExisting = Effect.fn("CheckpointCoordinator.processExisting")(function* (
    operation: ProviderCheckpointOperation,
    context: BaselineContext,
    resolution?: RepositoryResolution,
  ): Effect.fn.Return<BaselineCheckpointGateResult, CheckpointCoordinatorBlockedError> {
    if (!exactBaselineIntent(operation, context)) return yield* block("intent_conflict", context);
    switch (operation.state) {
      case "failed":
        return yield* block("checkpoint_failed", context);
      case "indeterminate":
        return yield* block("checkpoint_indeterminate", context);
    }
    const resolved = resolution ?? (yield* resolveRepository(context));
    if (resolved._tag === "NotApplicable") {
      if (operation.state !== "completed") {
        const transition =
          operation.state === "prepared"
            ? operations.fail({
                operationId: operation.operationId,
                updatedAt: yield* now(),
                error: durableError("checkpoint_capability_unavailable"),
              })
            : operations.markIndeterminate({
                operationId: operation.operationId,
                updatedAt: yield* now(),
                error: durableError("checkpoint_capability_unavailable"),
              });
        yield* persistence(transition, context);
      }
      return yield* block("repository_unavailable", context);
    }
    if (
      resolved.bound.checkpoints.binding.fingerprint !== operation.repository.fingerprint ||
      resolved.bound.checkpoints.binding.objectFormat !== operation.repository.objectFormat
    ) {
      // Completed rows are immutable: projection verification may block, but
      // must never rewrite their terminal journal state.
      if (operation.state === "completed") {
        return yield* block("repository_binding_changed", context);
      }
      return yield* markBindingChanged(operation, context);
    }
    if (operation.state === "completed") return yield* verifyCompleted(operation, context);
    return operation.state === "prepared"
      ? yield* dispatchPrepared(operation, resolved.bound, context)
      : yield* observeSent(operation, resolved.bound, context);
  });

  const gateUnlocked = Effect.fn("CheckpointCoordinator.gateBaselineUnlocked")(function* (
    intent: BaselineCheckpointGateIntent,
  ): Effect.fn.Return<BaselineCheckpointGateResult, CheckpointCoordinatorBlockedError> {
    const context = yield* loadContext(intent);
    const existing = yield* persistence(
      operations.getByOperationId({ operationId: context.operationId }),
      context,
    ).pipe(Effect.map(Option.getOrUndefined));
    if (existing !== undefined) return yield* processExisting(existing, context);

    const resolution = yield* resolveRepository(context);
    if (resolution._tag === "NotApplicable") return resolution;
    const prepared = yield* resolution.bound.checkpoints
      .prepareCapture({
        operationId: context.operationId,
        checkpointId: context.logicalCheckpointId,
      })
      .pipe(Effect.mapError((error) => mapCheckpointError(error, context)));
    const binding = resolution.bound.checkpoints.binding;
    const persisted = yield* persistence(
      operations.getOrPrepare({
        operationId: context.operationId,
        logicalCheckpointId: context.logicalCheckpointId,
        providerInstanceId: context.providerInstanceId,
        projectId: intent.projectId,
        threadId: intent.threadId,
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
          operationId: context.operationId,
          checkpointId: context.logicalCheckpointId,
        },
        requestSha256: prepared.requestSha256,
        repository: { fingerprint: binding.fingerprint, objectFormat: binding.objectFormat },
        providerGeneration: prepared.generationId,
        preparedAt: intent.createdAt,
      }),
      context,
    );
    if (!exactBaselineIntent(persisted.operation, context)) {
      return yield* block("intent_conflict", context);
    }
    if (persisted.operation.state !== "prepared") {
      return yield* processExisting(persisted.operation, context, resolution);
    }
    // Execute the exact prepared closure used to compute the durable digest.
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
    return yield* finalize(persisted.operation, executed.success, context);
  });

  const gateBaseline: CheckpointCoordinatorShape["gateBaseline"] = (intent) =>
    withIntentLock(
      `${intent.projectId}\0${intent.threadId}\0${intent.sourceCommandId}`,
      gateUnlocked(intent),
    );

  const recoverOne = Effect.fn("CheckpointCoordinator.recoverOne")(function* (
    operation: ProviderCheckpointOperation,
  ): Effect.fn.Return<CheckpointRecoveryOutcome, never> {
    const persisted = operation.intentContext;
    if (
      persisted.kind !== "baseline" ||
      persisted.sourceCommandId === null ||
      operation.threadId === null
    ) {
      return {
        operationId: operation.operationId,
        logicalCheckpointId: operation.logicalCheckpointId,
        status: "unchanged",
      };
    }
    const intent: BaselineCheckpointGateIntent = {
      sourceCommandId: persisted.sourceCommandId,
      sourceEventId: persisted.sourceEventId,
      projectId: operation.projectId,
      threadId: operation.threadId,
      messageId: persisted.messageId,
      checkpointTurnCount: persisted.checkpointTurnCount,
      createdAt: operation.preparedAt,
    };
    const loaded = yield* Effect.result(loadContext(intent));
    if (Result.isFailure(loaded) || !exactBaselineIntent(operation, loaded.success)) {
      if (
        operation.state !== "completed" &&
        operation.state !== "failed" &&
        operation.state !== "indeterminate"
      ) {
        const updatedAt = yield* now();
        const transition =
          operation.state === "prepared"
            ? operations.fail({
                operationId: operation.operationId,
                updatedAt,
                error: durableError("project_provider_changed"),
              })
            : operations.markIndeterminate({
                operationId: operation.operationId,
                updatedAt,
                error: durableError("project_provider_changed"),
              });
        const transitioned = yield* Effect.result(persistence(transition));
        if (Result.isFailure(transitioned)) {
          return {
            operationId: operation.operationId,
            logicalCheckpointId: operation.logicalCheckpointId,
            status: "failed",
            blockCode: "persistence_failure",
          };
        }
      }
      return {
        operationId: operation.operationId,
        logicalCheckpointId: operation.logicalCheckpointId,
        status: "failed",
        blockCode: Result.isFailure(loaded) ? loaded.failure.code : "project_provider_changed",
      };
    }
    const recovered = yield* Effect.result(
      withIntentLock(
        `${intent.projectId}\0${intent.threadId}\0${intent.sourceCommandId}`,
        processExisting(operation, loaded.success),
      ),
    );
    if (Result.isSuccess(recovered)) {
      return {
        operationId: operation.operationId,
        logicalCheckpointId: operation.logicalCheckpointId,
        status: recovered.success._tag === "Ready" ? "ready" : "unchanged",
      };
    }
    const pending =
      recovered.failure.code === "provider_disconnected" ||
      recovered.failure.code === "checkpoint_outcome_unknown" ||
      recovered.failure.code === "repository_unavailable";
    return {
      operationId: operation.operationId,
      logicalCheckpointId: operation.logicalCheckpointId,
      status: pending ? "pending" : "failed",
      blockCode: recovered.failure.code,
    };
  });

  const recover: CheckpointCoordinatorShape["recover"] = (providerInstanceId) =>
    persistence(
      operations.listPendingRecovery({
        ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
      }),
    ).pipe(Effect.flatMap((pending) => Effect.forEach(pending, recoverOne, { concurrency: 1 })));

  return CheckpointCoordinator.of({ gateBaseline, recover });
});

export const CheckpointCoordinatorLive = Layer.effect(
  CheckpointCoordinator,
  makeCheckpointCoordinator,
);
