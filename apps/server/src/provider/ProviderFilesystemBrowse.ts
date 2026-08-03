import {
  FILESYSTEM_BROWSE_MAX_ENTRIES,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  type FilesystemBrowseInput,
  type FilesystemBrowseResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProviderWorkspaceBrowseMaxEntries,
  type ProviderWorkspaceError,
} from "./ProviderWorkspaceAdapter.ts";
import * as ProviderInstanceRegistry from "./Services/ProviderInstanceRegistry.ts";

const MAX_ENTRIES = ProviderWorkspaceBrowseMaxEntries.make(FILESYSTEM_BROWSE_MAX_ENTRIES);

interface BrowseFailureContext {
  readonly failure: FilesystemBrowseFailure;
  readonly retryable: boolean;
}

function providerWorkspaceFailure(error: ProviderWorkspaceError): BrowseFailureContext {
  switch (error._tag) {
    case "ProviderWorkspaceDisconnectedError":
      return { failure: "provider_unavailable", retryable: true };
    case "ProviderWorkspaceUnsupportedError":
      return { failure: "unsupported_operation", retryable: false };
    case "ProviderWorkspaceProtocolError":
      return { failure: "protocol_incompatible", retryable: false };
    case "ProviderWorkspaceOperationError":
      return { failure: "operation_failed", retryable: true };
    case "ProviderWorkspacePathError":
      switch (error.issue) {
        case "path_not_found":
          return { failure: "path_not_found", retryable: false };
        case "path_not_directory":
        case "path_not_file":
          return { failure: "path_not_directory", retryable: false };
        case "invalid_root":
        case "invalid_path":
        case "path_is_symlink":
          return { failure: "invalid_path", retryable: false };
        default:
          return { failure: "operation_failed", retryable: false };
      }
  }
}

export class ProviderFilesystemBrowse extends Context.Service<
  ProviderFilesystemBrowse,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, FilesystemBrowseError>;
  }
>()("t3/provider/ProviderFilesystemBrowse") {}

export const make = Effect.gen(function* () {
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const browse: ProviderFilesystemBrowse["Service"]["browse"] = Effect.fn(
    "ProviderFilesystemBrowse.browse",
  )(function* (input) {
    const instance = yield* providerInstances.getInstance(input.providerInstanceId);
    if (instance === undefined) {
      return yield* new FilesystemBrowseError({
        providerInstanceId: input.providerInstanceId,
        failure: "provider_instance_not_found",
        retryable: false,
      });
    }
    if (!instance.enabled) {
      return yield* new FilesystemBrowseError({
        providerInstanceId: input.providerInstanceId,
        failure: "provider_unavailable",
        retryable: false,
      });
    }
    if (instance.workspace === undefined) {
      return yield* new FilesystemBrowseError({
        providerInstanceId: input.providerInstanceId,
        failure: "unsupported_operation",
        retryable: false,
      });
    }

    const result = yield* instance.workspace
      .browseDirectory({ locator: input.locator, maxEntries: MAX_ENTRIES })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Provider filesystem browse failed", {
            providerInstanceId: input.providerInstanceId,
            providerErrorTag: error._tag,
            providerOperation: error.operation,
            failure: providerWorkspaceFailure(error).failure,
          }),
        ),
        Effect.mapError(
          (error) =>
            new FilesystemBrowseError({
              providerInstanceId: input.providerInstanceId,
              ...providerWorkspaceFailure(error),
            }),
        ),
      );

    const directories = result.entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => ({ name: entry.name }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    return {
      directoryPath: result.directoryPath,
      parentPath: result.parentPath,
      entries: directories.slice(0, FILESYSTEM_BROWSE_MAX_ENTRIES),
      truncated: result.truncated || directories.length > FILESYSTEM_BROWSE_MAX_ENTRIES,
    };
  });

  return ProviderFilesystemBrowse.of({ browse });
});

export const layer = Layer.effect(ProviderFilesystemBrowse, make);
