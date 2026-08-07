import { type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";

import {
  type ProviderWorkspaceAdapter,
  ProviderWorkspaceDisconnectedError,
  type ProviderWorkspaceError,
  ProviderWorkspaceOperationError,
  type ProviderWorkspaceOperation,
  ProviderWorkspacePathError,
  ProviderWorkspaceProtocolError,
  type ProviderWorkspaceRoot,
  ProviderWorkspaceUnsupportedError,
} from "../ProviderWorkspaceAdapter.ts";
import {
  requestHostEndpoint,
  type HostEndpointControlClient,
} from "./HostEndpointControlClient.ts";
import { type HostEndpointRpcRequestError } from "./HostEndpointRpcClient.ts";

export interface MakeHostEndpointWorkspaceAdapterOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly client: HostEndpointControlClient;
}

const mapWorkspaceError = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderWorkspaceOperation,
  path: string,
  error: HostEndpointRpcRequestError,
): ProviderWorkspaceError => {
  if (error._tag === "HostEndpointRpcRemoteError") {
    switch (error.code) {
      case "unsupportedProtocol":
      case "unsupportedOperation":
        return new ProviderWorkspaceUnsupportedError({
          providerInstanceId,
          operation,
          cause: error,
        });
      case "invalidPath":
        return new ProviderWorkspacePathError({
          providerInstanceId,
          operation,
          path,
          issue: error.remoteMessage,
          cause: error,
        });
      case "disconnected":
      case "staleHandle":
        return new ProviderWorkspaceDisconnectedError({
          providerInstanceId,
          operation,
          cause: error,
        });
      case "invalidRequest":
        return new ProviderWorkspaceProtocolError({
          providerInstanceId,
          operation,
          detail: error.remoteMessage,
          cause: error,
        });
      default:
        return new ProviderWorkspaceOperationError({
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
      return new ProviderWorkspaceDisconnectedError({
        providerInstanceId,
        operation,
        cause: error,
      });
    case "HostEndpointRpcProtocolError":
    case "HostEndpointRpcResponseDecodeError":
    case "HostEndpointRpcSerializationError":
    case "HostEndpointRpcInvalidPayloadError":
      return new ProviderWorkspaceProtocolError({
        providerInstanceId,
        operation,
        detail: "cocoa-hostd workspace protocol failed validation",
        cause: error,
      });
    case "HostEndpointRpcCapacityError":
      return new ProviderWorkspaceOperationError({
        providerInstanceId,
        operation,
        detail: "cocoa-hostd workspace request capacity was exhausted",
        cause: error,
      });
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

const wrongGeneration = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderWorkspaceOperation,
) =>
  new ProviderWorkspaceProtocolError({
    providerInstanceId,
    operation,
    detail: "cocoa-hostd returned a resource for a different host generation",
  });

export const makeHostEndpointWorkspaceAdapter = (
  options: MakeHostEndpointWorkspaceAdapterOptions,
): ProviderWorkspaceAdapter => {
  const capability = options.client.handshake.capabilities.find(
    (candidate) => candidate.kind === "workspace",
  );
  const supports = (operation: "browse" | "open" | "stat" | "list" | "read") =>
    capability?.operations.includes(operation) === true;
  const unsupported = (operation: ProviderWorkspaceOperation) =>
    new ProviderWorkspaceUnsupportedError({
      providerInstanceId: options.providerInstanceId,
      operation,
    });

  const browseDirectory: ProviderWorkspaceAdapter["browseDirectory"] = Effect.fn(
    "HostEndpointWorkspaceAdapter.browseDirectory",
  )(function* (input) {
    if (!supports("browse")) return yield* unsupported("browseDirectory");
    const response = yield* requestHostEndpoint(options.client, "workspace.browse", {
      locator: input.locator,
      maxEntries: Math.min(input.maxEntries, capability!.maxEntries),
    }).pipe(
      Effect.mapError((error) =>
        mapWorkspaceError(
          options.providerInstanceId,
          "browseDirectory",
          input.locator.kind === "absolute" ? input.locator.path : input.locator.relativePath,
          error,
        ),
      ),
    );
    return {
      directoryPath: response.directoryPath,
      parentPath: response.parentPath,
      entries: response.entries,
      truncated: response.truncated,
    };
  });

  const openRoot: ProviderWorkspaceAdapter["openRoot"] = Effect.fn(
    "HostEndpointWorkspaceAdapter.openRoot",
  )(function* (workspaceRoot) {
    if (!supports("open")) return yield* unsupported("openRoot");
    const opened = yield* requestHostEndpoint(options.client, "workspace.open", {
      path: workspaceRoot,
    }).pipe(
      Effect.mapError((error) =>
        mapWorkspaceError(options.providerInstanceId, "openRoot", workspaceRoot, error),
      ),
    );
    if (opened.generationId !== options.client.generationId) {
      return yield* wrongGeneration(options.providerInstanceId, "openRoot");
    }
    const binding = {
      generationId: opened.generationId,
      rootId: opened.rootId,
    } as const;

    const root: ProviderWorkspaceRoot = {
      getMetadata: Effect.fn("HostEndpointWorkspaceAdapter.getMetadata")(function* (input) {
        if (!supports("stat")) return yield* unsupported("getMetadata");
        const response = yield* requestHostEndpoint(options.client, "workspace.stat", {
          ...binding,
          relativePath: input.relativePath,
        }).pipe(
          Effect.mapError((error) =>
            mapWorkspaceError(options.providerInstanceId, "getMetadata", input.relativePath, error),
          ),
        );
        return response.metadata;
      }),
      listDirectory: Effect.fn("HostEndpointWorkspaceAdapter.listDirectory")(function* (input) {
        if (!supports("list")) return yield* unsupported("listDirectory");
        const response = yield* requestHostEndpoint(options.client, "workspace.list", {
          ...binding,
          relativePath: input.relativePath,
          maxEntries: Math.min(input.maxEntries, capability!.maxEntries),
          maxDepth: 1,
          maxDirectories: Math.min(input.maxEntries, capability!.maxEntries),
        }).pipe(
          Effect.mapError((error) =>
            mapWorkspaceError(
              options.providerInstanceId,
              "listDirectory",
              input.relativePath,
              error,
            ),
          ),
        );
        if (response.entries.some((entry) => entry.path.includes("/"))) {
          return yield* new ProviderWorkspaceProtocolError({
            providerInstanceId: options.providerInstanceId,
            operation: "listDirectory",
            detail: "cocoa-hostd returned a non-child directory entry",
          });
        }
        return {
          entries: response.entries.map((entry) => ({ name: entry.path, kind: entry.kind })),
          truncated: response.truncated,
        };
      }),
      listEntries: Effect.fn("HostEndpointWorkspaceAdapter.listEntries")(function* (input) {
        if (!supports("list")) return yield* unsupported("listEntries");
        const response = yield* requestHostEndpoint(options.client, "workspace.list", {
          ...binding,
          relativePath: input.relativePath,
          maxEntries: Math.min(input.maxEntries, capability!.maxEntries),
          maxDepth: input.maxDepth,
          maxDirectories: input.maxDirectories,
        }).pipe(
          Effect.mapError((error) =>
            mapWorkspaceError(options.providerInstanceId, "listEntries", input.relativePath, error),
          ),
        );
        return { entries: response.entries, truncated: response.truncated };
      }),
      readFile: Effect.fn("HostEndpointWorkspaceAdapter.readFile")(function* (input) {
        if (!supports("read")) return yield* unsupported("readFile");
        const requestedBytes = Math.min(input.maxBytes, capability!.maxReadBytes);
        const response = yield* requestHostEndpoint(options.client, "workspace.read", {
          ...binding,
          relativePath: input.relativePath,
          maxBytes: requestedBytes,
        }).pipe(
          Effect.mapError((error) =>
            mapWorkspaceError(options.providerInstanceId, "readFile", input.relativePath, error),
          ),
        );
        const bytes = yield* Effect.fromResult(Encoding.decodeBase64(response.dataBase64)).pipe(
          Effect.mapError(
            () =>
              new ProviderWorkspaceProtocolError({
                providerInstanceId: options.providerInstanceId,
                operation: "readFile",
                detail: "cocoa-hostd returned invalid base64 file data",
              }),
          ),
        );
        if (
          bytes.byteLength > requestedBytes ||
          (!response.truncated && response.byteLength !== bytes.byteLength) ||
          (response.truncated && response.byteLength <= bytes.byteLength)
        ) {
          return yield* new ProviderWorkspaceProtocolError({
            providerInstanceId: options.providerInstanceId,
            operation: "readFile",
            detail: "cocoa-hostd returned inconsistent file read bounds",
          });
        }
        return { bytes, byteLength: response.byteLength, truncated: response.truncated };
      }),
    };
    return root;
  });

  return { browseDirectory, openRoot };
};
