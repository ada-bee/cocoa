// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type {
  CocoaHostControlErrorResponse,
  CocoaHostWorkspaceRequest,
  CocoaHostWorkspaceResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  controlError,
  hasCurrentGeneration,
  HOST_CONTROL_MAX_WORKSPACE_HANDLES,
  setBoundedHandle,
  type HostControlOperationDependencies,
  type HostControlOperationState,
  workspaceControlError,
} from "./state.ts";

export type WorkspaceControlResult = CocoaHostWorkspaceResponse | CocoaHostControlErrorResponse;

const responseBase = <O extends CocoaHostWorkspaceRequest["operation"]>(
  request: CocoaHostWorkspaceRequest,
  operation: O,
) => ({
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  operation,
});

const resolveWorkspace = (
  state: HostControlOperationState,
  request: Extract<
    CocoaHostWorkspaceRequest,
    { readonly generationId: unknown; readonly rootId: unknown }
  >,
) => {
  if (!hasCurrentGeneration(state, request)) {
    return controlError(
      request,
      "staleHandle",
      "Workspace handle belongs to a stale host generation.",
    );
  }
  const workspace = state.workspaces.get(request.rootId);
  return (
    workspace ?? controlError(request, "notFound", "Workspace handle was not found on this host.")
  );
};

export const makeWorkspaceControlHandler = (
  state: HostControlOperationState,
  dependencies: Pick<HostControlOperationDependencies, "openWorkspace">,
) =>
  Effect.fn("HostControl.workspace")(function* (
    request: CocoaHostWorkspaceRequest,
  ): Effect.fn.Return<WorkspaceControlResult> {
    switch (request.operation) {
      case "workspace.browse": {
        const requestedPath =
          request.locator.kind === "absolute"
            ? request.locator.path
            : request.locator.relativePath === ""
              ? state.homePath
              : NodePath.posix.join(state.homePath, request.locator.relativePath);
        const result = yield* dependencies.openWorkspace(requestedPath).pipe(
          Effect.flatMap((workspace) =>
            workspace
              .browse("", { maxEntries: request.maxEntries })
              .pipe(Effect.map((listing) => ({ workspace, listing }))),
          ),
          Effect.match({
            onFailure: (error) => workspaceControlError(request, error),
            onSuccess: ({ workspace, listing }) => ({
              ...responseBase(request, "workspace.browse"),
              directoryPath: workspace.rootPath,
              parentPath:
                workspace.rootPath === "/" ? null : NodePath.posix.dirname(workspace.rootPath),
              entries: listing.entries.map((entry) => ({
                name: entry.name,
                kind: entry.kind,
              })),
              truncated: listing.truncated,
            }),
          }),
        );
        return result;
      }
      case "workspace.open": {
        const result = yield* dependencies.openWorkspace(request.path).pipe(
          Effect.flatMap((workspace) =>
            workspace.stat("").pipe(Effect.map((metadata) => ({ workspace, metadata }))),
          ),
          Effect.match({
            onFailure: (error) => workspaceControlError(request, error),
            onSuccess: ({ workspace, metadata }) => {
              const rootId = state.makeResourceId();
              setBoundedHandle(
                state.workspaces,
                rootId,
                workspace,
                HOST_CONTROL_MAX_WORKSPACE_HANDLES,
              );
              return {
                ...responseBase(request, "workspace.open"),
                generationId: state.generationId,
                rootId,
                canonicalRoot: workspace.rootPath,
                metadata: {
                  kind: metadata.kind,
                  size: metadata.size,
                  modifiedAtMs: Math.trunc(metadata.modifiedAtMs),
                },
              };
            },
          }),
        );
        return result;
      }
      case "workspace.stat": {
        const workspace = resolveWorkspace(state, request);
        if ("error" in workspace) return workspace;
        return yield* workspace.stat(request.relativePath).pipe(
          Effect.match({
            onFailure: (error) => workspaceControlError(request, error),
            onSuccess: (metadata) => ({
              ...responseBase(request, "workspace.stat"),
              metadata: {
                kind: metadata.kind,
                size: metadata.size,
                modifiedAtMs: Math.trunc(metadata.modifiedAtMs),
              },
            }),
          }),
        );
      }
      case "workspace.list": {
        const workspace = resolveWorkspace(state, request);
        if ("error" in workspace) return workspace;
        if (request.maxDepth === 0) {
          return yield* workspace.list(request.relativePath, { maxEntries: 1 }).pipe(
            Effect.match({
              onFailure: (error) => workspaceControlError(request, error),
              onSuccess: (listing) => ({
                ...responseBase(request, "workspace.list"),
                entries: [],
                truncated: listing.entries.length > 0 || listing.truncated,
              }),
            }),
          );
        }
        return yield* workspace
          .tree(request.relativePath, {
            maxEntries: request.maxEntries,
            maxDepth: request.maxDepth,
            maxDirectories: request.maxDirectories,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => workspaceControlError(request, error),
              onSuccess: (listing) => {
                const prefix = request.relativePath === "" ? "" : `${request.relativePath}/`;
                return {
                  ...responseBase(request, "workspace.list"),
                  entries: listing.entries.map((entry) => ({
                    path: prefix === "" ? entry.path : entry.path.slice(prefix.length),
                    kind: entry.kind,
                  })),
                  truncated: listing.truncated,
                };
              },
            }),
          );
      }
      case "workspace.read": {
        const workspace = resolveWorkspace(state, request);
        if ("error" in workspace) return workspace;
        return yield* workspace.read(request.relativePath, { maxBytes: request.maxBytes }).pipe(
          Effect.match({
            onFailure: (error) => workspaceControlError(request, error),
            onSuccess: (read) => ({
              ...responseBase(request, "workspace.read"),
              dataBase64: Buffer.from(read.bytes).toString("base64"),
              byteLength: read.byteLength,
              truncated: read.truncated,
            }),
          }),
        );
      }
    }
  });
