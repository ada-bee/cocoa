/** Provider-bound, path-free checkpoint diff queries. */
import {
  CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
  CodexCheckpointHelperPatchByteLimit,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetTurnDiffInput,
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
    const repository = yield* projectRepository
      .resolve({ projectId: context.projectId, threadId: context.threadId })
      .pipe(
        Effect.mapError(
          mapRepositoryError(input.operation, input.threadId, context.providerInstanceId),
        ),
      );
    if (repository.checkpoints === undefined) {
      return yield* new CheckpointUnsupportedError({ operation: input.operation });
    }
    if (!sameBinding(repository, base) || !sameBinding(repository, target)) {
      return yield* new CheckpointProviderBindingMismatchError({
        operation: input.operation,
        threadId: input.threadId,
      });
    }

    const unknownResult = yield* repository.checkpoints
      .diff({
        baseCheckpointId: base.logicalCheckpointId,
        targetCheckpointId: target.logicalCheckpointId,
        ignoreWhitespace: input.ignoreWhitespace,
        limits: { maxPatchBytes },
      })
      .pipe(
        Effect.mapError(
          mapProviderError(input.operation, input.threadId, context.providerInstanceId),
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
      result.baseCheckpointId !== base.logicalCheckpointId ||
      result.targetCheckpointId !== target.logicalCheckpointId ||
      result.baseOid !== base.checkpointOid ||
      result.targetOid !== target.checkpointOid
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
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
