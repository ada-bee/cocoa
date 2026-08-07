import {
  CocoaHostControlResourceId,
  type CocoaHostControlErrorResponse,
  type CocoaHostControlGenerationId,
  type CocoaHostControlOperation,
  type CocoaHostControlRequestId,
} from "@t3tools/contracts";
import type { WorkspaceRuntime, WorkspaceRuntimeError } from "@t3tools/host-runtime/workspace";
import type { VcsProcess, VcsProcessOutput } from "@t3tools/host-runtime/vcs";
import type * as Effect from "effect/Effect";

export interface HostControlRepositoryHandle {
  readonly rootPath: string;
  readonly commonDirectoryPath: string | null;
}

export const HOST_CONTROL_MAX_WORKSPACE_HANDLES = 256;
export const HOST_CONTROL_MAX_REPOSITORY_HANDLES = 256;

export const setBoundedHandle = <Value>(
  handles: Map<string, Value>,
  id: CocoaHostControlResourceId,
  value: Value,
  maximum: number,
): void => {
  while (handles.size >= maximum) {
    const oldest = handles.keys().next().value;
    if (oldest === undefined) break;
    handles.delete(oldest);
  }
  handles.set(id, value);
};

export interface HostControlOperationState {
  readonly generationId: CocoaHostControlGenerationId;
  readonly homePath: string;
  readonly gitExecutable: string;
  readonly workspaces: Map<string, WorkspaceRuntime>;
  readonly repositories: Map<string, HostControlRepositoryHandle>;
  readonly makeResourceId: () => CocoaHostControlResourceId;
}

export interface HostControlOperationDependencies {
  readonly generationId: CocoaHostControlGenerationId;
  readonly homePath: string;
  readonly gitExecutable?: string;
  readonly openWorkspace: (
    rootPath: string,
  ) => Effect.Effect<WorkspaceRuntime, WorkspaceRuntimeError>;
  readonly runVcs: VcsProcess["Service"]["run"];
  readonly makeResourceId?: () => CocoaHostControlResourceId;
}

export type HostControlVcsRun = HostControlOperationDependencies["runVcs"];
export type HostControlVcsOutput = VcsProcessOutput;

export const makeHostControlOperationState = (
  dependencies: HostControlOperationDependencies,
): HostControlOperationState => {
  let nextResourceId = 0;
  return {
    generationId: dependencies.generationId,
    homePath: dependencies.homePath,
    gitExecutable: dependencies.gitExecutable ?? "git",
    workspaces: new Map(),
    repositories: new Map(),
    makeResourceId:
      dependencies.makeResourceId ??
      (() => CocoaHostControlResourceId.make(`resource-${(nextResourceId += 1)}`)),
  };
};

type HostControlErrorCode = CocoaHostControlErrorResponse["error"]["code"];

export const controlError = (
  request: {
    readonly protocolVersion: 1;
    readonly requestId: CocoaHostControlRequestId;
    readonly operation: CocoaHostControlOperation;
  },
  code: HostControlErrorCode,
  message: string,
  retryable = false,
): CocoaHostControlErrorResponse => ({
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  operation: request.operation,
  error: { code, message, retryable },
});

export const workspaceControlError = (
  request: Parameters<typeof controlError>[0],
  error: WorkspaceRuntimeError,
): CocoaHostControlErrorResponse => {
  switch (error.reason) {
    case "invalid-path":
    case "outside-root":
      return controlError(request, "invalidPath", `Workspace path rejected: ${error.reason}.`);
    case "path-not-found":
      return controlError(request, "notFound", "Workspace path was not found.");
    case "path-not-directory":
    case "path-not-file":
    case "operation-failed":
      return controlError(
        request,
        "operationFailed",
        `Workspace operation failed: ${error.reason}.`,
      );
    default:
      return controlError(request, "operationFailed", "Workspace operation failed.");
  }
};

export const hasCurrentGeneration = (
  state: HostControlOperationState,
  request: { readonly generationId: CocoaHostControlGenerationId },
): boolean => request.generationId === state.generationId;
