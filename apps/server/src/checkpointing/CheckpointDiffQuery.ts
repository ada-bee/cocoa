/** Provider-bound, path-free checkpoint diff queries. */
import {
  CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
  CodexCheckpointHelperPatchByteLimit,
  type CodexCheckpointHelperCheckpointId,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetTurnDiffInput,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
  type CodexCheckpointHelperDiffResult,
} from "@t3tools/contracts";
import { Buffer } from "node:buffer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderCheckpointOperations from "../persistence/Services/ProviderCheckpointOperations.ts";
import * as ProjectRepository from "../project/ProjectRepository.ts";
import type { ProviderVcsError, ProviderVcsRepository } from "../provider/ProviderVcsAdapter.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointNativeProjectionError,
  CheckpointProviderBindingMismatchError,
  CheckpointProviderDisconnectedError,
  CheckpointProviderOperationError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointUnsupportedError,
  type CheckpointDiffOperation,
  type CheckpointServiceError,
} from "./Errors.ts";

/** Internal orchestration-only input for a capture not yet in public projections. */
export interface CompletedCaptureDiffInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly baseCheckpointId: CodexCheckpointHelperCheckpointId;
  readonly targetCheckpointId: CodexCheckpointHelperCheckpointId;
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly ignoreWhitespace?: boolean;
}

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResult, CheckpointServiceError>;
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
    /** Diff exact completed native captures before the target public projection exists. */
    readonly getCompletedCaptureDiff: (
      input: CompletedCaptureDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const decodeTurnDiff = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffResult);
const maxPatchBytes = CodexCheckpointHelperPatchByteLimit.make(
  CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
);

const decodeBase64Patch = (
  input: unknown,
): { readonly result: CodexCheckpointHelperDiffResult; readonly bytes: Buffer } | null => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  const exactKeys = [
    "operation",
    "baseCheckpointId",
    "targetCheckpointId",
    "baseOid",
    "targetOid",
    "patchBase64",
    "byteLength",
    "truncated",
  ];
  if (
    Object.keys(row).length !== exactKeys.length ||
    exactKeys.some((key) => !Object.hasOwn(row, key)) ||
    row.operation !== "diff" ||
    typeof row.baseCheckpointId !== "string" ||
    typeof row.targetCheckpointId !== "string" ||
    typeof row.baseOid !== "string" ||
    typeof row.targetOid !== "string" ||
    typeof row.patchBase64 !== "string" ||
    !Number.isSafeInteger(row.byteLength) ||
    (row.byteLength as number) < 0 ||
    (row.byteLength as number) > CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES ||
    typeof row.truncated !== "boolean"
  ) {
    return null;
  }

  const encoded = row.patchBase64;
  if (encoded.length % 4 !== 0 || encoded.length > Math.ceil(maxPatchBytes / 3) * 4) {
    return null;
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  for (let index = 0; index < encoded.length - padding; index += 1) {
    const code = encoded.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return null;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== row.byteLength || bytes.toString("base64") !== encoded) return null;
  return { result: row as unknown as CodexCheckpointHelperDiffResult, bytes };
};

const unavailable = (
  operation: CheckpointDiffOperation,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
) => new CheckpointProviderDisconnectedError({ operation, threadId, providerInstanceId });

const mapRepositoryError =
  (
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) =>
  (cause: ProjectRepository.ProjectRepositoryError): CheckpointServiceError => {
    switch (cause._tag) {
      case "ProviderVcsDisconnectedError":
      case "ProjectRepositoryProviderNotFoundError":
      case "ProjectRepositoryProviderUnavailableError":
        return unavailable(operation, threadId, providerInstanceId);
      case "ProviderVcsUnsupportedError":
      case "ProjectRepositoryCapabilityUnavailableError":
      case "ProjectRepositoryNotRepositoryError":
        return new CheckpointUnsupportedError({ operation });
      default:
        return new CheckpointProviderOperationError({ operation, threadId });
    }
  };

const mapProviderError =
  (
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) =>
  (cause: ProviderVcsError): CheckpointServiceError => {
    if (cause._tag === "ProviderVcsDisconnectedError") {
      return unavailable(operation, threadId, providerInstanceId);
    }
    if (cause._tag === "ProviderVcsUnsupportedError") {
      return new CheckpointUnsupportedError({ operation });
    }
    return new CheckpointProviderOperationError({ operation, threadId });
  };

const sameBinding = (
  repository: ProviderVcsRepository,
  checkpoint: ProviderCheckpointOperations.ProviderNativeCheckpoint,
) =>
  repository.checkpoints !== undefined &&
  repository.checkpoints.binding.fingerprint === checkpoint.repository.fingerprint &&
  repository.checkpoints.binding.objectFormat === checkpoint.repository.objectFormat;

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const checkpointOperations =
    yield* ProviderCheckpointOperations.ProviderCheckpointOperationRepository;
  const projectRepository = yield* ProjectRepository.ProjectRepository;

  const runBoundDiff = Effect.fn("CheckpointDiffQuery.runBoundDiff")(function* (input: {
    readonly operation: CheckpointDiffOperation;
    readonly providerInstanceId: ProviderInstanceId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
    readonly ignoreWhitespace: boolean;
    readonly base: ProviderCheckpointOperations.ProviderNativeCheckpoint;
    readonly target: ProviderCheckpointOperations.ProviderNativeCheckpoint;
  }) {
    const repository = yield* projectRepository
      .resolve({ projectId: input.projectId, threadId: input.threadId })
      .pipe(
        Effect.mapError(
          mapRepositoryError(input.operation, input.threadId, input.providerInstanceId),
        ),
      );
    if (repository.checkpoints === undefined) {
      return yield* new CheckpointUnsupportedError({ operation: input.operation });
    }
    if (!sameBinding(repository, input.base) || !sameBinding(repository, input.target)) {
      return yield* new CheckpointProviderBindingMismatchError({
        operation: input.operation,
        threadId: input.threadId,
      });
    }

    const unknownResult = yield* repository.checkpoints
      .diff({
        baseCheckpointId: input.base.logicalCheckpointId,
        targetCheckpointId: input.target.logicalCheckpointId,
        ignoreWhitespace: input.ignoreWhitespace,
        limits: { maxPatchBytes },
      })
      .pipe(
        Effect.mapError(
          mapProviderError(input.operation, input.threadId, input.providerInstanceId),
        ),
      );
    const decoded = decodeBase64Patch(unknownResult);
    if (decoded === null) {
      return yield* new CheckpointDiffResultInvalidError({
        operation: input.operation,
        threadId: input.threadId,
      });
    }
    const { result, bytes } = decoded;
    if (
      result.baseCheckpointId !== input.base.logicalCheckpointId ||
      result.targetCheckpointId !== input.target.logicalCheckpointId ||
      result.baseOid !== input.base.checkpointOid ||
      result.targetOid !== input.target.checkpointOid
    ) {
      return yield* new CheckpointDiffResultInvalidError({
        operation: input.operation,
        threadId: input.threadId,
      });
    }

    const diff = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () =>
        new CheckpointDiffResultInvalidError({
          operation: input.operation,
          threadId: input.threadId,
        }),
    });

    return yield* decodeTurnDiff({
      threadId: input.threadId,
      fromTurnCount: input.fromTurnCount,
      toTurnCount: input.toTurnCount,
      diff,
      byteLength: result.byteLength,
      truncated: result.truncated,
    }).pipe(
      Effect.mapError(
        () =>
          new CheckpointDiffResultInvalidError({
            operation: input.operation,
            threadId: input.threadId,
          }),
      ),
    );
  });

  const runDiff = Effect.fn("CheckpointDiffQuery.runDiff")(function* (input: {
    readonly operation: CheckpointDiffOperation;
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
    readonly ignoreWhitespace: boolean;
  }) {
    const contextOption = yield* projections.getCheckpointDiffContext(input.threadId);
    if (Option.isNone(contextOption)) {
      return yield* new CheckpointThreadNotFoundError({
        operation: input.operation,
        threadId: input.threadId,
      });
    }
    const context = contextOption.value;

    const requestedTurnCount = Math.max(input.fromTurnCount, input.toTurnCount);
    if (
      input.fromTurnCount > input.toTurnCount ||
      requestedTurnCount > context.latestCheckpointTurnCount
    ) {
      return yield* new CheckpointTurnRangeUnavailableError({
        operation: input.operation,
        threadId: input.threadId,
        requestedTurnCount,
        availableTurnCount: context.latestCheckpointTurnCount,
      });
    }

    const loadCheckpoint = Effect.fn("CheckpointDiffQuery.loadCheckpoint")(function* (
      turnCount: number,
      checkpoint: "from" | "to",
    ) {
      const found = yield* checkpointOperations
        .getReadyLogicalCheckpoint({
          providerInstanceId: context.providerInstanceId,
          projectId: context.projectId,
          threadId: context.threadId,
          checkpointTurnCount: turnCount,
        })
        .pipe(
          Effect.mapError(
            () =>
              new CheckpointNativeProjectionError({
                operation: input.operation,
                threadId: input.threadId,
              }),
          ),
        );
      if (Option.isNone(found)) {
        return yield* new CheckpointRefUnavailableError({
          operation: input.operation,
          threadId: input.threadId,
          turnCount,
          checkpoint,
        });
      }
      return found.value;
    });

    const [base, target] = yield* Effect.all([
      loadCheckpoint(input.fromTurnCount, "from"),
      loadCheckpoint(input.toTurnCount, "to"),
    ]);
    return yield* runBoundDiff({
      operation: input.operation,
      providerInstanceId: context.providerInstanceId,
      projectId: context.projectId,
      threadId: input.threadId,
      fromTurnCount: input.fromTurnCount,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace: input.ignoreWhitespace,
      base,
      target,
    });
  });

  const loadExactCompletedCapture = Effect.fn("CheckpointDiffQuery.loadExactCompletedCapture")(
    function* (input: {
      readonly operation: CheckpointDiffOperation;
      readonly providerInstanceId: ProviderInstanceId;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly logicalCheckpointId: CodexCheckpointHelperCheckpointId;
      readonly turnCount: number;
      readonly checkpoint: "from" | "to";
      readonly intentKind: "baseline" | "post_turn";
    }) {
      const checkpoint = yield* checkpointOperations
        .getLogicalCheckpoint({ logicalCheckpointId: input.logicalCheckpointId })
        .pipe(
          Effect.mapError(
            () =>
              new CheckpointNativeProjectionError({
                operation: input.operation,
                threadId: input.threadId,
              }),
          ),
          Effect.map(Option.getOrUndefined),
        );
      if (checkpoint === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation: input.operation,
          threadId: input.threadId,
          turnCount: input.turnCount,
          checkpoint: input.checkpoint,
        });
      }
      const capture = yield* checkpointOperations
        .getByOperationId({ operationId: checkpoint.captureOperationId })
        .pipe(
          Effect.mapError(
            () =>
              new CheckpointNativeProjectionError({
                operation: input.operation,
                threadId: input.threadId,
              }),
          ),
          Effect.map(Option.getOrUndefined),
        );
      const intent = capture?.intentContext;
      const result = capture?.result;
      const intentMatches =
        input.intentKind === "baseline"
          ? intent?.kind === "baseline" &&
            intent.checkpointTurnCount === input.turnCount &&
            capture?.turnId === null
          : intent?.kind === "post_turn" &&
            intent.checkpointTurnCount === input.turnCount &&
            capture?.turnId === intent.turnId;
      const exact =
        capture !== undefined &&
        capture.state === "completed" &&
        capture.operationKind === "capture" &&
        capture.logicalCheckpointId === input.logicalCheckpointId &&
        capture.providerInstanceId === input.providerInstanceId &&
        capture.projectId === input.projectId &&
        capture.threadId === input.threadId &&
        capture.canonicalRequest.operation === "capture" &&
        capture.canonicalRequest.checkpointId === input.logicalCheckpointId &&
        checkpoint.logicalCheckpointId === input.logicalCheckpointId &&
        checkpoint.providerInstanceId === input.providerInstanceId &&
        checkpoint.projectId === input.projectId &&
        checkpoint.threadId === input.threadId &&
        checkpoint.turnId === capture.turnId &&
        checkpoint.captureOperationId === capture.operationId &&
        checkpoint.repository.fingerprint === capture.repository.fingerprint &&
        checkpoint.repository.objectFormat === capture.repository.objectFormat &&
        intentMatches &&
        result?.operation === "capture" &&
        result.receipt.operationId === capture.operationId &&
        result.receipt.checkpointId === checkpoint.logicalCheckpointId &&
        result.receipt.checkpointRef === checkpoint.checkpointRef &&
        result.receipt.checkpointOid === checkpoint.checkpointOid &&
        result.receipt.treeOid === checkpoint.treeOid &&
        result.receipt.receiptRef === checkpoint.receiptRef &&
        result.receipt.requestSha256 === capture.requestSha256 &&
        result.receipt.repositoryFingerprint === checkpoint.repository.fingerprint &&
        result.receiptObjectOid === checkpoint.receiptObjectOid;
      if (!exact) {
        return yield* new CheckpointNativeProjectionError({
          operation: input.operation,
          threadId: input.threadId,
        });
      }
      return { checkpoint, capture };
    },
  );

  return CheckpointDiffQuery.of({
    getTurnDiff: (input) =>
      runDiff({
        operation: "CheckpointDiffQuery.getTurnDiff",
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        ignoreWhitespace: input.ignoreWhitespace ?? false,
      }),
    getFullThreadDiff: (input) =>
      runDiff({
        operation: "CheckpointDiffQuery.getFullThreadDiff",
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
        ignoreWhitespace: input.ignoreWhitespace ?? false,
      }),
    getCompletedCaptureDiff: (input) =>
      Effect.gen(function* () {
        const operation = "CheckpointDiffQuery.getCompletedCaptureDiff" as const;
        const [baseCapture, targetCapture] = yield* Effect.all([
          loadExactCompletedCapture({
            operation,
            providerInstanceId: input.providerInstanceId,
            projectId: input.projectId,
            threadId: input.threadId,
            logicalCheckpointId: input.baseCheckpointId,
            turnCount: input.fromTurnCount,
            checkpoint: "from",
            intentKind: "baseline",
          }),
          loadExactCompletedCapture({
            operation,
            providerInstanceId: input.providerInstanceId,
            projectId: input.projectId,
            threadId: input.threadId,
            logicalCheckpointId: input.targetCheckpointId,
            turnCount: input.toTurnCount,
            checkpoint: "to",
            intentKind: "post_turn",
          }),
        ]);
        if (
          targetCapture.capture.intentContext.kind !== "post_turn" ||
          targetCapture.capture.intentContext.baselineCheckpointId !==
            baseCapture.checkpoint.logicalCheckpointId
        ) {
          return yield* new CheckpointNativeProjectionError({
            operation,
            threadId: input.threadId,
          });
        }
        return yield* runBoundDiff({
          operation,
          providerInstanceId: input.providerInstanceId,
          projectId: input.projectId,
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          ignoreWhitespace: input.ignoreWhitespace ?? false,
          base: baseCapture.checkpoint,
          target: targetCapture.checkpoint,
        });
      }),
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
