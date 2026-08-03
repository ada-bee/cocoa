/**
 * Provider-routed public repository reads.
 *
 * The network contract supplies only durable project/thread identity. This
 * service resolves the authoritative provider-host path through
 * ProjectRepository and never accepts or interprets a client cwd.
 *
 * @module project/RepositoryReadService
 */
import {
  RepositoryReadError,
  type RepositoryReadOperation,
  type RepositoryListRefsInput,
  type RepositoryListRefsResult,
  type RepositoryReviewDiffInput,
  type RepositoryReviewDiffResult,
  type RepositoryStatusInput,
  type RepositoryStatusResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProviderVcsRefLimit,
  ProviderVcsRefQuery,
  ProviderVcsReviewDiffByteLimit,
  ProviderVcsRevision,
  ProviderVcsStatusPathLimit,
  type ProviderVcsRepository,
} from "../provider/ProviderVcsAdapter.ts";
import * as ProjectRepository from "./ProjectRepository.ts";

export interface RepositoryReadServiceShape {
  readonly status: (
    input: RepositoryStatusInput,
  ) => Effect.Effect<RepositoryStatusResult, RepositoryReadError>;
  readonly listRefs: (
    input: RepositoryListRefsInput,
  ) => Effect.Effect<RepositoryListRefsResult, RepositoryReadError>;
  readonly getReviewDiff: (
    input: RepositoryReviewDiffInput,
  ) => Effect.Effect<RepositoryReviewDiffResult, RepositoryReadError>;
}

export class RepositoryReadService extends Context.Service<
  RepositoryReadService,
  RepositoryReadServiceShape
>()("t3/project/RepositoryReadService") {}

const readError = (
  operation: RepositoryReadOperation,
  code: RepositoryReadError["code"],
  detail: string,
  retryable: boolean,
) => new RepositoryReadError({ operation, code, detail, retryable });

export function mapProjectRepositoryReadError(
  operation: RepositoryReadOperation,
  error: Exclude<
    ProjectRepository.ProjectRepositoryError,
    ProjectRepository.ProjectRepositoryNotRepositoryError
  >,
): RepositoryReadError {
  switch (error._tag) {
    case "ProjectRepositoryProjectNotFoundError":
    case "ProjectRepositoryThreadNotFoundError":
      return readError(
        operation,
        "target-not-found",
        "The repository target was not found.",
        false,
      );
    case "ProjectRepositoryThreadProjectMismatchError":
      return readError(
        operation,
        "target-mismatch",
        "The thread does not belong to the requested project.",
        false,
      );
    case "ProjectRepositoryProviderNotFoundError":
    case "ProjectRepositoryProviderUnavailableError":
      return readError(
        operation,
        "provider-unavailable",
        "The repository provider is unavailable.",
        true,
      );
    case "ProjectRepositoryCapabilityUnavailableError":
      return readError(
        operation,
        "unsupported",
        "The repository provider does not support repository reads.",
        false,
      );
    case "ProjectRepositoryResolveOperationError":
      return readError(
        operation,
        "operation-failed",
        "The repository target could not be resolved.",
        true,
      );
    case "ProviderVcsDisconnectedError":
      return readError(operation, "disconnected", "The repository provider disconnected.", true);
    case "ProviderVcsUnsupportedError":
      return readError(
        operation,
        "unsupported",
        "The repository provider does not support this read.",
        false,
      );
    case "ProviderVcsProtocolError":
      return readError(
        operation,
        "protocol",
        "The repository provider returned an incompatible response.",
        false,
      );
    case "ProviderVcsPathError":
      return readError(
        operation,
        "invalid-path",
        "The persisted repository path is invalid on the provider.",
        false,
      );
    case "ProviderVcsOperationError":
      return readError(
        operation,
        "operation-failed",
        "The repository provider could not complete the read.",
        true,
      );
  }
}

const unsupportedCapability = (operation: RepositoryReadOperation) =>
  readError(operation, "unsupported", "The repository provider does not support this read.", false);

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

const clipUtf8 = (
  value: string,
  maxBytes: number,
): { readonly value: string; readonly bytes: number; readonly clipped: boolean } => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) {
    return { value, bytes: encoded.byteLength, clipped: false };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maxBytes;
  while (end > 0) {
    try {
      return { value: decoder.decode(encoded.slice(0, end)), bytes: end, clipped: true };
    } catch {
      end -= 1;
    }
  }
  return { value: "", bytes: 0, clipped: true };
};

export const make = Effect.gen(function* () {
  const projectRepository = yield* ProjectRepository.ProjectRepository;

  const resolve = Effect.fn("RepositoryReadService.resolve")(function* (
    operation: RepositoryReadOperation,
    target: RepositoryStatusInput["target"],
  ): Effect.fn.Return<ProviderVcsRepository | null, RepositoryReadError> {
    const result = yield* projectRepository
      .resolve({
        projectId: target.projectId,
        ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
      })
      .pipe(Effect.result);
    if (result._tag === "Success") return result.success;
    if (result.failure._tag === "ProjectRepositoryNotRepositoryError") return null;
    return yield* mapProjectRepositoryReadError(operation, result.failure);
  });

  const status: RepositoryReadServiceShape["status"] = Effect.fn("RepositoryReadService.status")(
    function* (input) {
      const repository = yield* resolve("status", input.target);
      if (repository === null) return { _tag: "NotRepository" } as const;
      if (!repository.capabilities.status) return yield* unsupportedCapability("status");
      const result = yield* repository
        .getStatus({ maxChangedPaths: ProviderVcsStatusPathLimit.make(input.maxChangedPaths) })
        .pipe(Effect.mapError((error) => mapProjectRepositoryReadError("status", error)));
      const changedPaths = result.changedPaths.slice(0, input.maxChangedPaths);
      return {
        _tag: "Repository",
        ...result,
        changedPaths,
        truncated: result.truncated || result.changedPaths.length > changedPaths.length,
      } as const;
    },
  );

  const listRefs: RepositoryReadServiceShape["listRefs"] = Effect.fn(
    "RepositoryReadService.listRefs",
  )(function* (input) {
    const repository = yield* resolve("list-refs", input.target);
    if (repository === null) return { _tag: "NotRepository" } as const;
    if (!repository.capabilities.refs) return yield* unsupportedCapability("list-refs");
    const result = yield* repository
      .listRefs({
        scope: input.scope,
        ...(input.query === undefined ? {} : { query: ProviderVcsRefQuery.make(input.query) }),
        maxRefs: ProviderVcsRefLimit.make(input.maxRefs),
      })
      .pipe(Effect.mapError((error) => mapProjectRepositoryReadError("list-refs", error)));
    const refs = result.refs.slice(0, input.maxRefs);
    return {
      _tag: "Repository",
      refs,
      truncated: result.truncated || result.refs.length > refs.length,
    } as const;
  });

  const getReviewDiff: RepositoryReadServiceShape["getReviewDiff"] = Effect.fn(
    "RepositoryReadService.getReviewDiff",
  )(function* (input) {
    const repository = yield* resolve("review-diff", input.target);
    if (repository === null) return { _tag: "NotRepository" } as const;
    if (!repository.capabilities.reviewDiff) return yield* unsupportedCapability("review-diff");
    const result = yield* repository
      .getReviewDiff({
        ...(input.baseRef === undefined
          ? {}
          : { baseRef: ProviderVcsRevision.make(input.baseRef) }),
        ignoreWhitespace: input.ignoreWhitespace,
        maxBytes: ProviderVcsReviewDiffByteLimit.make(input.maxBytes),
      })
      .pipe(Effect.mapError((error) => mapProjectRepositoryReadError("review-diff", error)));
    let remaining = input.maxBytes;
    let truncated = result.truncated || result.sources.length > 2;
    const sources = result.sources.slice(0, 2).map((source) => {
      const clipped = clipUtf8(source.patch, remaining);
      const sourceTruncated =
        source.truncated || clipped.clipped || source.byteLength !== utf8Length(source.patch);
      remaining -= clipped.bytes;
      truncated ||= sourceTruncated;
      return {
        ...source,
        patch: clipped.value,
        byteLength: clipped.bytes,
        truncated: sourceTruncated,
      };
    });
    return { _tag: "Repository", sources, truncated } as const;
  });

  return RepositoryReadService.of({ status, listRefs, getReviewDiff });
});

export const layer = Layer.effect(RepositoryReadService, make);
