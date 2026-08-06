import type { AssetResource } from "@t3tools/contracts";
import {
  AssetAttachmentNotFoundError,
  AssetPreviewTypeValidationError,
  AssetSigningKeyLoadError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceAssetTooLargeError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspacePathValidationError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectWorkspace from "../project/ProjectWorkspace.ts";
import {
  PROVIDER_WORKSPACE_MAX_READ_BYTES,
  ProviderWorkspaceReadByteLimit,
} from "../provider/ProviderWorkspaceAdapter.ts";

export const ASSET_ROUTE_PREFIX = "/api/assets";

const SIGNING_SECRET_NAME = "asset-access-signing-key";
const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
const PROJECT_FAVICON_TOKEN_BUCKET_MS = 30 * 60 * 1000;
const PREVIEW_RELATIVE_PATH_MAX_LENGTH = 1024;
const PREVIEW_READ_BYTE_LIMIT = ProviderWorkspaceReadByteLimit.make(
  PROVIDER_WORKSPACE_MAX_READ_BYTES,
);
const PREVIEW_ASSET_EXTENSIONS = new Set([
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  ...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);

const AssetClaimsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(2),
    kind: Schema.Literal("workspace-file"),
    projectId: ProjectId,
    threadId: ThreadId,
    baseRelativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    kind: Schema.Literal("workspace-file-exact"),
    projectId: ProjectId,
    threadId: ThreadId,
    relativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  // Provider-owned v1 claims are decoded only so they can fail closed without
  // ever being interpreted against the gateway filesystem.
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file"),
    workspaceRoot: Schema.String,
    baseRelativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file-exact"),
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon"),
    workspaceRoot: Schema.String,
    relativePath: Schema.NullOr(Schema.String),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    kind: Schema.Literal("project-favicon-fallback"),
    expiresAt: Schema.Number,
  }),
]);
type AssetClaims = typeof AssetClaimsSchema.Type;

const AssetClaimsJson = Schema.fromJsonString(AssetClaimsSchema);
const decodeAssetClaims = Schema.decodeUnknownOption(AssetClaimsJson);
const encodeAssetClaims = Schema.encodeSync(AssetClaimsJson);

export type ResolvedAsset =
  | { readonly kind: "file"; readonly path: string }
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly relativePath: string;
    };

function decodeClaims(encodedPayload: string): AssetClaims | null {
  try {
    return Option.getOrNull(decodeAssetClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function decodeRelativePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex < 0 ? "." : path.slice(0, separatorIndex) || ".";
}

function extension(path: string): string {
  const fileName = basename(path);
  const extensionIndex = fileName.lastIndexOf(".");
  return extensionIndex < 0 ? "" : fileName.slice(extensionIndex).toLowerCase();
}

function isSafeRelativeAssetPath(path: string, options?: { readonly rejectHidden?: boolean }) {
  if (
    path.length === 0 ||
    path.length > PREVIEW_RELATIVE_PATH_MAX_LENGTH ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      (!options?.rejectHidden || !segment.startsWith(".")),
  );
}

function joinRelativePath(base: string, path: string): string {
  return base === "." ? path : `${base}/${path}`;
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

export const issueAssetUrl = Effect.fn("AssetAccess.issueAssetUrl")(function* (input: {
  readonly resource: AssetResource;
  readonly workspaceTarget?: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  };
}) {
  const issuedAt = yield* Clock.currentTimeMillis;
  let expiresAt = issuedAt + ASSET_TOKEN_TTL_MS;
  let claims: AssetClaims;
  let fileName: string;

  switch (input.resource._tag) {
    case "workspace-file": {
      if (input.workspaceTarget === undefined) {
        return yield* new AssetWorkspaceContextNotFoundError({ resource: input.resource });
      }
      const relativePath = input.resource.path;
      if (!isSafeRelativeAssetPath(relativePath)) {
        return yield* new AssetWorkspacePathValidationError({
          resource: input.resource,
          cause: new Error("Workspace asset path is not a normalized relative path."),
        });
      }
      if (!isWorkspacePreviewEntryPath(relativePath)) {
        return yield* new AssetPreviewTypeValidationError({ resource: input.resource });
      }

      const projectWorkspace = yield* ProjectWorkspace.ProjectWorkspace;
      const metadata = yield* projectWorkspace
        .getMetadata({ target: input.workspaceTarget, relativePath })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to inspect provider workspace asset.", {
              projectId: input.workspaceTarget?.projectId,
              threadId: input.workspaceTarget?.threadId,
              relativePath,
              cause,
            }),
          ),
          Effect.mapError(
            () =>
              new AssetWorkspaceAssetInspectionError({
                resource: input.resource,
                cause: new Error("Provider workspace asset inspection failed."),
              }),
          ),
        );
      if (metadata.kind !== "file") {
        return yield* new AssetWorkspaceAssetNotFoundError({ resource: input.resource });
      }
      if (metadata.size !== undefined && metadata.size > PREVIEW_READ_BYTE_LIMIT) {
        return yield* new AssetWorkspaceAssetTooLargeError({
          resource: input.resource,
          maxBytes: PREVIEW_READ_BYTE_LIMIT,
        });
      }

      claims = isWorkspaceImagePreviewPath(relativePath)
        ? {
            version: 2,
            kind: "workspace-file-exact",
            ...input.workspaceTarget,
            relativePath,
            expiresAt,
          }
        : {
            version: 2,
            kind: "workspace-file",
            ...input.workspaceTarget,
            baseRelativePath: dirname(relativePath),
            expiresAt,
          };
      fileName = basename(relativePath);
      break;
    }
    case "attachment": {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.resource.attachmentId,
      });
      if (!attachmentPath) {
        return yield* new AssetAttachmentNotFoundError({
          resource: input.resource,
        });
      }
      claims = {
        version: 1,
        kind: "attachment",
        attachmentId: input.resource.attachmentId,
        expiresAt,
      };
      fileName = path.basename(attachmentPath);
      break;
    }
    case "project-favicon": {
      expiresAt =
        (Math.floor(issuedAt / PROJECT_FAVICON_TOKEN_BUCKET_MS) + 2) *
        PROJECT_FAVICON_TOKEN_BUCKET_MS;
      claims = {
        version: 2,
        kind: "project-favicon-fallback",
        expiresAt,
      };
      fileName = PROJECT_FAVICON_FALLBACK_MARKER;
      break;
    }
  }

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.mapError(
      (cause) =>
        new AssetSigningKeyLoadError({
          resource: input.resource,
          cause,
        }),
    ),
  );
  const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  return {
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
    expiresAt,
  };
});

export const resolveAsset = Effect.fn("AssetAccess.resolveAsset")(function* (
  token: string,
  requestedPath: string,
) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.tapError((cause) => Effect.logError("Failed to load the asset signing key.", { cause })),
    Effect.orElseSucceed(() => null),
  );
  if (!signingSecret) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) return null;

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;

  if (claims.kind === "attachment") {
    const config = yield* ServerConfig.ServerConfig;
    const attachmentPath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: claims.attachmentId,
    });
    if (!attachmentPath) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* optionOnNotFound(fileSystem.stat(attachmentPath)).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to inspect attachment asset.", {
          attachmentId: claims.attachmentId,
          path: attachmentPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File"
      ? ({ kind: "file", path: attachmentPath } satisfies ResolvedAsset)
      : null;
  }

  if (
    (claims.kind === "workspace-file" || claims.kind === "workspace-file-exact") &&
    claims.version === 2
  ) {
    const decodedPath = decodeRelativePath(requestedPath);
    if (decodedPath === null || !isSafeRelativeAssetPath(decodedPath, { rejectHidden: true })) {
      return null;
    }

    let relativePath: string;
    if (claims.kind === "workspace-file-exact") {
      if (decodedPath !== basename(claims.relativePath)) return null;
      relativePath = claims.relativePath;
    } else {
      if (!PREVIEW_ASSET_EXTENSIONS.has(extension(decodedPath))) return null;
      relativePath = joinRelativePath(claims.baseRelativePath, decodedPath);
    }

    const projectWorkspace = yield* ProjectWorkspace.ProjectWorkspace;
    const read = yield* projectWorkspace
      .readFile({
        target: {
          projectId: claims.projectId,
          threadId: claims.threadId,
        },
        relativePath,
        maxBytes: PREVIEW_READ_BYTE_LIMIT,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to read provider workspace asset.", {
            projectId: claims.projectId,
            threadId: claims.threadId,
            relativePath,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
    if (read === null || read.truncated) return null;
    return { kind: "bytes", bytes: read.bytes, relativePath } satisfies ResolvedAsset;
  }

  // All non-attachment claims describe provider-owned workspace paths. This
  // includes valid legacy v1 tokens issued before provider isolation. They are
  // deliberately non-resolvable on the gateway.
  return null;
});
