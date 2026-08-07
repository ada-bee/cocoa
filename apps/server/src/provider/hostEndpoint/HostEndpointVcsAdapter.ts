import { type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type ProviderVcsAdapter,
  ProviderVcsDisconnectedError,
  type ProviderVcsError,
  ProviderVcsOperationError,
  type ProviderVcsOperation,
  ProviderVcsPathError,
  ProviderVcsProtocolError,
  type ProviderVcsRepository,
  type ProviderVcsReviewDiffSource,
  ProviderVcsUnsupportedError,
} from "../ProviderVcsAdapter.ts";
import {
  requestHostEndpoint,
  type HostEndpointControlClient,
} from "./HostEndpointControlClient.ts";
import type { HostEndpointRpcRequestError } from "./HostEndpointRpcClient.ts";

export interface MakeHostEndpointVcsAdapterOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly client: HostEndpointControlClient;
}

const MUTATIONS = new Set<ProviderVcsOperation>([
  "pull",
  "createWorktree",
  "removeWorktree",
  "createRef",
  "switchRef",
  "prepareCommit",
  "commit",
  "push",
]);

const ambiguousAfterDispatch = (error: HostEndpointRpcRequestError): boolean => {
  switch (error._tag) {
    case "HostEndpointRpcDisconnectedError":
    case "HostEndpointRpcSendError":
    case "HostEndpointRpcTimeoutError":
    case "HostEndpointRpcProtocolError":
    case "HostEndpointRpcResponseDecodeError":
      return true;
    case "HostEndpointRpcRemoteError":
      return ["outcomeUnknown", "disconnected", "staleHandle"].includes(error.code);
    default:
      return false;
  }
};

export const mapHostEndpointVcsError = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  path: string,
  error: HostEndpointRpcRequestError,
): ProviderVcsError => {
  if (MUTATIONS.has(operation) && ambiguousAfterDispatch(error)) {
    return new ProviderVcsOperationError({
      providerInstanceId,
      operation,
      detail: "mutation outcome unknown; do not retry automatically",
      cause: error,
    });
  }
  if (error._tag === "HostEndpointRpcRemoteError") {
    switch (error.code) {
      case "unsupportedProtocol":
      case "unsupportedOperation":
        return new ProviderVcsUnsupportedError({ providerInstanceId, operation, cause: error });
      case "invalidPath":
        return new ProviderVcsPathError({
          providerInstanceId,
          operation,
          providerHostPath: path,
          issue: error.remoteMessage,
          cause: error,
        });
      case "disconnected":
      case "staleHandle":
        return new ProviderVcsDisconnectedError({ providerInstanceId, operation, cause: error });
      case "invalidRequest":
        return new ProviderVcsProtocolError({
          providerInstanceId,
          operation,
          detail: error.remoteMessage,
          cause: error,
        });
      default:
        return new ProviderVcsOperationError({
          providerInstanceId,
          operation,
          detail: error.remoteMessage,
          cause: error,
        });
    }
  }
  switch (error._tag) {
    case "HostEndpointRpcDisconnectedError":
    case "HostEndpointRpcSendError":
    case "HostEndpointRpcTimeoutError":
      return new ProviderVcsDisconnectedError({ providerInstanceId, operation, cause: error });
    case "HostEndpointRpcProtocolError":
    case "HostEndpointRpcResponseDecodeError":
    case "HostEndpointRpcSerializationError":
    case "HostEndpointRpcInvalidPayloadError":
      return new ProviderVcsProtocolError({
        providerInstanceId,
        operation,
        detail: "cocoa-hostd VCS protocol failed validation",
        cause: error,
      });
    case "HostEndpointRpcCapacityError":
      return new ProviderVcsOperationError({
        providerInstanceId,
        operation,
        detail: "cocoa-hostd VCS request capacity was exhausted",
        cause: error,
      });
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

const wrongGeneration = (providerInstanceId: ProviderInstanceId, operation: ProviderVcsOperation) =>
  new ProviderVcsProtocolError({
    providerInstanceId,
    operation,
    detail: "cocoa-hostd returned a repository for a different host generation",
  });

export const makeHostEndpointVcsAdapter = (
  options: MakeHostEndpointVcsAdapterOptions,
): ProviderVcsAdapter => {
  const hostCapability = options.client.handshake.capabilities.find(
    (candidate) => candidate.kind === "vcs",
  );
  const diffCapability = options.client.handshake.capabilities.find(
    (candidate) => candidate.kind === "reviewDiff",
  );
  const unsupported = (operation: ProviderVcsOperation) =>
    new ProviderVcsUnsupportedError({
      providerInstanceId: options.providerInstanceId,
      operation,
    });

  const openRepository: ProviderVcsAdapter["openRepository"] = Effect.fn(
    "HostEndpointVcsAdapter.openRepository",
  )(function* (providerHostPath) {
    if (hostCapability?.operations.includes("open") !== true) {
      return yield* unsupported("openRepository");
    }
    const response = yield* requestHostEndpoint(options.client, "vcs.open", {
      path: providerHostPath,
    }).pipe(
      Effect.catch((error) =>
        error._tag === "HostEndpointRpcRemoteError" && error.code === "notRepository"
          ? Effect.succeed(null)
          : Effect.fail(
              mapHostEndpointVcsError(
                options.providerInstanceId,
                "openRepository",
                providerHostPath,
                error,
              ),
            ),
      ),
    );
    if (response === null || response.result.kind === "notRepository") {
      return { _tag: "NotRepository" as const };
    }
    const opened = response.result;
    if (opened.generationId !== options.client.generationId) {
      return yield* wrongGeneration(options.providerInstanceId, "openRepository");
    }
    const binding = {
      generationId: opened.generationId,
      repositoryId: opened.repositoryId,
    } as const;
    const advertised = new Set(opened.operations);
    const supports = (operation: (typeof opened.operations)[number]) =>
      advertised.has(operation) && hostCapability.operations.includes(operation);
    const mapError = (operation: ProviderVcsOperation, path = opened.rootPath) =>
      Effect.mapError((error: HostEndpointRpcRequestError) =>
        mapHostEndpointVcsError(options.providerInstanceId, operation, path, error),
      );

    const repository: ProviderVcsRepository = {
      identity: {
        kind: opened.driverKind,
        rootPath: opened.rootPath,
        commonDirectoryPath: opened.commonDirectoryPath,
      },
      capabilities: {
        status: supports("status"),
        refs: supports("listRefs"),
        remotes: supports("listRemotes"),
        reviewDiff: opened.reviewDiff && diffCapability?.operations.includes("diff") === true,
      },
      getStatus: Effect.fn("HostEndpointVcsAdapter.getStatus")(function* (input) {
        if (!supports("status")) return yield* unsupported("getStatus");
        const value = yield* requestHostEndpoint(options.client, "vcs.status", {
          ...binding,
          maxChangedPaths: Math.min(input.maxChangedPaths, hostCapability.maxChangedPaths),
        }).pipe(mapError("getStatus"));
        const head =
          value.head.kind === "unborn"
            ? ({ _tag: "Unborn" } as const)
            : value.head.kind === "branch"
              ? ({ _tag: "Branch", name: value.head.name, commit: value.head.commit } as const)
              : ({ _tag: "Detached", commit: value.head.commit } as const);
        return {
          head,
          defaultRef: value.defaultRef,
          upstreamRef: value.upstreamRef,
          aheadCount: value.aheadCount,
          behindCount: value.behindCount,
          hasPrimaryRemote: value.hasPrimaryRemote,
          hasWorkingTreeChanges: value.hasWorkingTreeChanges,
          changedPaths: value.changedPaths,
          truncated: value.truncated,
        };
      }),
      listRefs: Effect.fn("HostEndpointVcsAdapter.listRefs")(function* (input) {
        if (!supports("listRefs")) return yield* unsupported("listRefs");
        const value = yield* requestHostEndpoint(options.client, "vcs.listRefs", {
          ...binding,
          scope: input.scope,
          ...(input.query === undefined ? {} : { query: input.query }),
          maxRefs: Math.min(input.maxRefs, hostCapability.maxRefs),
        }).pipe(mapError("listRefs"));
        return { refs: value.refs, truncated: value.truncated };
      }),
      listRemotes: Effect.fn("HostEndpointVcsAdapter.listRemotes")(function* (input) {
        if (!supports("listRemotes")) return yield* unsupported("listRemotes");
        const value = yield* requestHostEndpoint(options.client, "vcs.listRemotes", {
          ...binding,
          maxRemotes: input.maxRemotes,
        }).pipe(mapError("listRemotes"));
        return { remotes: value.remotes, truncated: value.truncated };
      }),
      getReviewDiff: Effect.fn("HostEndpointVcsAdapter.getReviewDiff")(function* (input) {
        if (!(opened.reviewDiff && diffCapability?.operations.includes("diff") === true)) {
          return yield* unsupported("getReviewDiff");
        }
        let remaining: number = input.maxBytes;
        let truncated = false;
        const sources: Array<ProviderVcsReviewDiffSource> = [];
        const workingLimit = Math.min(remaining, diffCapability.maxPatchBytes);
        const working = yield* requestHostEndpoint(options.client, "vcs.diff", {
          ...binding,
          source: "workingTree",
          ignoreWhitespace: input.ignoreWhitespace,
          maxBytes: workingLimit,
        }).pipe(mapError("getReviewDiff"));
        if (
          working.source !== "workingTree" ||
          working.byteLength > workingLimit ||
          new TextEncoder().encode(working.patch).byteLength !== working.byteLength
        ) {
          return yield* new ProviderVcsProtocolError({
            providerInstanceId: options.providerInstanceId,
            operation: "getReviewDiff",
            detail: "cocoa-hostd returned inconsistent working-tree diff metadata",
          });
        }
        sources.push({
          kind: working.source,
          baseRef: working.baseRef,
          headRef: working.headRef,
          patch: working.patch,
          byteLength: working.byteLength,
          truncated: working.truncated,
        });
        remaining -= working.byteLength;
        truncated ||= working.truncated;
        if (input.baseRef !== undefined) {
          if (remaining === 0) {
            sources.push({
              kind: "baseRange",
              baseRef: input.baseRef,
              headRef: null,
              patch: "",
              byteLength: 0,
              truncated: true,
            });
            truncated = true;
          } else {
            const baseRangeLimit = Math.min(remaining, diffCapability.maxPatchBytes);
            const baseRange = yield* requestHostEndpoint(options.client, "vcs.diff", {
              ...binding,
              source: "baseRange",
              baseRef: input.baseRef,
              ignoreWhitespace: input.ignoreWhitespace,
              maxBytes: baseRangeLimit,
            }).pipe(mapError("getReviewDiff"));
            if (
              baseRange.source !== "baseRange" ||
              baseRange.byteLength > baseRangeLimit ||
              new TextEncoder().encode(baseRange.patch).byteLength !== baseRange.byteLength
            ) {
              return yield* new ProviderVcsProtocolError({
                providerInstanceId: options.providerInstanceId,
                operation: "getReviewDiff",
                detail: "cocoa-hostd returned inconsistent base-range diff metadata",
              });
            }
            sources.push({
              kind: baseRange.source,
              baseRef: baseRange.baseRef,
              headRef: baseRange.headRef,
              patch: baseRange.patch,
              byteLength: baseRange.byteLength,
              truncated: baseRange.truncated,
            });
            truncated ||= baseRange.truncated;
          }
        }
        return { sources, truncated };
      }),
      ...(supports("pull")
        ? {
            pull: Effect.fn("HostEndpointVcsAdapter.pull")(function* () {
              const value = yield* requestHostEndpoint(options.client, "vcs.pull", {
                ...binding,
              }).pipe(mapError("pull"));
              return {
                status: value.status,
                refName: value.refName,
                upstreamRef: value.upstreamRef,
              };
            }),
          }
        : {}),
      ...(supports("createWorktree")
        ? {
            createWorktree: Effect.fn("HostEndpointVcsAdapter.createWorktree")(function* (input) {
              const value = yield* requestHostEndpoint(options.client, "vcs.createWorktree", {
                ...binding,
                refName: input.refName,
                ...(input.newRefName === undefined ? {} : { newRefName: input.newRefName }),
                ...(input.baseRefName === undefined ? {} : { baseRefName: input.baseRefName }),
                path: input.path,
              }).pipe(mapError("createWorktree", input.path ?? opened.rootPath));
              return { worktree: { path: value.path, refName: value.refName } };
            }),
          }
        : {}),
      ...(supports("removeWorktree")
        ? {
            removeWorktree: Effect.fn("HostEndpointVcsAdapter.removeWorktree")(function* (input) {
              yield* requestHostEndpoint(options.client, "vcs.removeWorktree", {
                ...binding,
                path: input.path,
                force: input.force,
              }).pipe(mapError("removeWorktree", input.path));
            }),
          }
        : {}),
      ...(supports("createRef")
        ? {
            createRef: Effect.fn("HostEndpointVcsAdapter.createRef")(function* (input) {
              const value = yield* requestHostEndpoint(options.client, "vcs.createRef", {
                ...binding,
                refName: input.refName,
                switchRef: input.switchRef,
              }).pipe(mapError("createRef"));
              return { refName: value.refName };
            }),
          }
        : {}),
      ...(supports("switchRef")
        ? {
            switchRef: Effect.fn("HostEndpointVcsAdapter.switchRef")(function* (input) {
              const value = yield* requestHostEndpoint(options.client, "vcs.switchRef", {
                ...binding,
                refName: input.refName,
              }).pipe(mapError("switchRef"));
              return { refName: value.refName };
            }),
          }
        : {}),
      ...(supports("prepareCommit")
        ? {
            prepareCommit: Effect.fn("HostEndpointVcsAdapter.prepareCommit")(function* (input) {
              const value = yield* requestHostEndpoint(options.client, "vcs.prepareCommit", {
                ...binding,
                ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
              }).pipe(mapError("prepareCommit"));
              return value.prepared;
            }),
          }
        : {}),
      ...(supports("commit")
        ? {
            commit: Effect.fn("HostEndpointVcsAdapter.commit")(function* (input) {
              const value = yield* requestHostEndpoint(options.client, "vcs.commit", {
                ...binding,
                subject: input.subject,
                body: input.body,
              }).pipe(mapError("commit"));
              return { commitSha: value.commitSha };
            }),
          }
        : {}),
      ...(supports("push")
        ? {
            push: Effect.fn("HostEndpointVcsAdapter.push")(function* () {
              const value = yield* requestHostEndpoint(options.client, "vcs.push", {
                ...binding,
              }).pipe(mapError("push"));
              return {
                status: value.status,
                branch: value.branch,
                ...(value.upstreamBranch === undefined
                  ? {}
                  : { upstreamBranch: value.upstreamBranch }),
                ...(value.setUpstream === undefined ? {} : { setUpstream: value.setUpstream }),
              };
            }),
          }
        : {}),
    };
    return { _tag: "Repository" as const, repository };
  });

  return { openRepository };
};
