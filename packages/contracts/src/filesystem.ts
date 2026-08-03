import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

export const FILESYSTEM_BROWSE_PATH_MAX_LENGTH = 4096;
export const FILESYSTEM_BROWSE_MAX_ENTRIES = 1_000;

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

const FilesystemBrowseAbsolutePath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(FILESYSTEM_BROWSE_PATH_MAX_LENGTH),
  Schema.makeFilter((value) => {
    if (value.includes("\0")) return "Filesystem paths must not contain NUL bytes.";
    if (value.includes("\\")) return "Filesystem paths must use POSIX '/' separators.";
    if (!value.startsWith("/")) return "Filesystem paths must be absolute POSIX paths.";
    if (value === "/") return true;
    const components = value.slice(1).split("/");
    return (
      components.every(
        (component) => component !== "" && component !== "." && component !== "..",
      ) || "Filesystem paths must be normalized POSIX paths."
    );
  }),
);

const FilesystemBrowseHomeRelativePath = Schema.String.check(
  Schema.isMaxLength(FILESYSTEM_BROWSE_PATH_MAX_LENGTH),
  Schema.makeFilter((value) => {
    if (value.includes("\0")) return "Filesystem paths must not contain NUL bytes.";
    if (value.includes("\\")) return "Filesystem paths must use POSIX '/' separators.";
    if (value.startsWith("/")) return "Home-relative paths must not be absolute.";
    if (value === "") return true;
    const components = value.split("/");
    return (
      components.every(
        (component) => component !== "" && component !== "." && component !== "..",
      ) || "Home-relative paths must be normalized descendants."
    );
  }),
);

export const FilesystemBrowseLocator = Schema.Union([
  strict(
    Schema.Struct({
      kind: Schema.Literal("absolute"),
      path: FilesystemBrowseAbsolutePath,
    }),
  ),
  strict(
    Schema.Struct({
      kind: Schema.Literal("home"),
      relativePath: FilesystemBrowseHomeRelativePath,
    }),
  ),
]);
export type FilesystemBrowseLocator = typeof FilesystemBrowseLocator.Type;

export const FilesystemBrowseInput = strict(
  Schema.Struct({
    providerInstanceId: ProviderInstanceId,
    locator: FilesystemBrowseLocator,
  }),
);
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = strict(
  Schema.Struct({
    name: Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(255),
      Schema.makeFilter(
        (value) =>
          (!value.includes("/") && !value.includes("\0") && value !== "." && value !== "..") ||
          "Filesystem entry names must be direct POSIX child names.",
      ),
    ),
  }),
);
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = strict(
  Schema.Struct({
    directoryPath: FilesystemBrowseAbsolutePath,
    parentPath: Schema.NullOr(FilesystemBrowseAbsolutePath),
    entries: Schema.Array(FilesystemBrowseEntry).check(
      Schema.isMaxLength(FILESYSTEM_BROWSE_MAX_ENTRIES),
    ),
    truncated: Schema.Boolean,
  }),
);
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemBrowseFailure = Schema.Literals([
  "provider_instance_not_found",
  "provider_unavailable",
  "unsupported_operation",
  "protocol_incompatible",
  "invalid_path",
  "path_not_found",
  "path_not_directory",
  "operation_failed",
]);
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type;

const FilesystemBrowseMessage = Schema.Literals([
  "The selected provider endpoint was not found.",
  "The selected provider endpoint is unavailable.",
  "The selected provider endpoint does not support folder browsing.",
  "The selected provider endpoint is incompatible with folder browsing.",
  "The folder path is invalid.",
  "The folder was not found.",
  "The selected path is not a folder.",
  "The folder could not be browsed.",
]);

const filesystemBrowseFailureMessage = (
  failure: FilesystemBrowseFailure,
): typeof FilesystemBrowseMessage.Type => {
  switch (failure) {
    case "provider_instance_not_found":
      return "The selected provider endpoint was not found.";
    case "provider_unavailable":
      return "The selected provider endpoint is unavailable.";
    case "unsupported_operation":
      return "The selected provider endpoint does not support folder browsing.";
    case "protocol_incompatible":
      return "The selected provider endpoint is incompatible with folder browsing.";
    case "invalid_path":
      return "The folder path is invalid.";
    case "path_not_found":
      return "The folder was not found.";
    case "path_not_directory":
      return "The selected path is not a folder.";
    case "operation_failed":
      return "The folder could not be browsed.";
  }
};

export class FilesystemBrowseError extends Schema.TaggedErrorClass<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  strict(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      failure: FilesystemBrowseFailure,
      retryable: Schema.Boolean,
      message: FilesystemBrowseMessage,
    }),
  ),
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly failure: FilesystemBrowseFailure;
    readonly retryable: boolean;
  }) {
    super({ ...props, message: filesystemBrowseFailureMessage(props.failure) });
  }
}
