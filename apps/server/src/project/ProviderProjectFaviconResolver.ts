import { ProjectId, T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ProviderWorkspaceReadByteLimit,
  type ProviderWorkspaceMetadata,
} from "../provider/ProviderWorkspaceAdapter.ts";
import * as ProjectWorkspace from "./ProjectWorkspace.ts";
import {
  extractIconHref,
  FAVICON_CANDIDATES,
  iconHrefCandidates,
  ICON_SOURCE_FILES,
} from "./ProjectFaviconDiscovery.ts";

const DEFAULT_CACHE_CAPACITY = 1_024;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(30);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(5);
const PROJECT_METADATA_READ_LIMIT = ProviderWorkspaceReadByteLimit.make(128 * 1024);

const decodeT3ProjectFileJson = Schema.decodeOption(T3ProjectFileFromJson);

export class ProviderProjectFaviconResolutionError extends Schema.TaggedErrorClass<ProviderProjectFaviconResolutionError>()(
  "ProviderProjectFaviconResolutionError",
  {
    projectId: ProjectId,
    operation: Schema.Literals(["inspect-candidate", "read-source"]),
    relativePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve project favicon during ${this.operation} for project '${this.projectId}'.`;
  }
}

export interface ProviderProjectFaviconResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

export class ProviderProjectFaviconResolver extends Context.Service<
  ProviderProjectFaviconResolver,
  {
    readonly resolvePath: (
      projectId: ProjectId,
    ) => Effect.Effect<string | null, ProviderProjectFaviconResolutionError>;
  }
>()("t3/project/ProviderProjectFaviconResolver") {}

function normalizeRelativePath(value: string): string | null {
  if (value.length === 0 || value.length > 1_024 || value.startsWith("/") || value.includes("\\")) {
    return null;
  }
  const normalized: Array<string> = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    if (segment.includes("\0")) return null;
    normalized.push(segment);
  }
  return normalized.length === 0 ? null : normalized.join("/");
}

function isMissingWorkspacePath(error: ProjectWorkspace.ProjectWorkspaceError): boolean {
  return error._tag === "ProviderWorkspacePathError" && error.issue === "path_not_found";
}

export const make = Effect.fn("ProviderProjectFaviconResolver.make")(function* (
  options: ProviderProjectFaviconResolverOptions = {},
) {
  const workspace = yield* ProjectWorkspace.ProjectWorkspace;

  const inspectFile = Effect.fn("ProviderProjectFaviconResolver.inspectFile")(function* (
    projectId: ProjectId,
    relativePath: string,
  ): Effect.fn.Return<ProviderWorkspaceMetadata | null, ProviderProjectFaviconResolutionError> {
    return yield* workspace.getMetadata({ target: { projectId }, relativePath }).pipe(
      Effect.catch((cause) =>
        isMissingWorkspacePath(cause)
          ? Effect.succeed(null)
          : Effect.fail(
              new ProviderProjectFaviconResolutionError({
                projectId,
                operation: "inspect-candidate",
                relativePath,
                cause,
              }),
            ),
      ),
    );
  });

  const findExistingFile = Effect.fn("ProviderProjectFaviconResolver.findExistingFile")(function* (
    projectId: ProjectId,
    candidates: ReadonlyArray<string>,
  ): Effect.fn.Return<string | null, ProviderProjectFaviconResolutionError> {
    for (const candidate of candidates) {
      const relativePath = normalizeRelativePath(candidate);
      if (relativePath === null) continue;
      const metadata = yield* inspectFile(projectId, relativePath);
      if (metadata?.kind === "file") return relativePath;
    }
    return null;
  });

  const readSource = Effect.fn("ProviderProjectFaviconResolver.readSource")(function* (
    projectId: ProjectId,
    relativePath: string,
  ): Effect.fn.Return<string | null, ProviderProjectFaviconResolutionError> {
    const metadata = yield* inspectFile(projectId, relativePath);
    if (metadata?.kind !== "file") return null;
    const read = yield* workspace
      .readFile({
        target: { projectId },
        relativePath,
        maxBytes: PROJECT_METADATA_READ_LIMIT,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderProjectFaviconResolutionError({
              projectId,
              operation: "read-source",
              relativePath,
              cause,
            }),
        ),
      );
    if (read.truncated) {
      yield* Effect.logDebug("Skipping oversized project icon metadata source.", {
        projectId,
        relativePath,
        maxBytes: PROJECT_METADATA_READ_LIMIT,
      });
      return null;
    }
    return new TextDecoder().decode(read.bytes);
  });

  const resolveUncached = Effect.fn("ProviderProjectFaviconResolver.resolveUncached")(function* (
    projectId: ProjectId,
  ) {
    const projectFileSource = yield* readSource(projectId, T3_PROJECT_FILE_NAME).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to load provider t3.json for favicon discovery.", {
          projectId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (projectFileSource !== null) {
      const projectFile = decodeT3ProjectFileJson(projectFileSource);
      if (Option.isSome(projectFile) && projectFile.value.iconPath !== undefined) {
        const configured = yield* findExistingFile(projectId, [projectFile.value.iconPath]);
        if (configured !== null) return configured;
      }
    }

    const wellKnown = yield* findExistingFile(projectId, FAVICON_CANDIDATES);
    if (wellKnown !== null) return wellKnown;

    for (const sourceFile of ICON_SOURCE_FILES) {
      const source = yield* readSource(projectId, sourceFile);
      if (source === null) continue;
      const href = extractIconHref(source);
      if (href === null) continue;
      const resolved = yield* findExistingFile(projectId, iconHrefCandidates(href));
      if (resolved !== null) return resolved;
    }
    return null;
  });

  const paths = yield* Cache.makeWith<
    ProjectId,
    string | null,
    ProviderProjectFaviconResolutionError
  >(resolveUncached, {
    capacity: options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: (value) =>
        value === null
          ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
          : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
      onFailure: () => Duration.zero,
    }),
  });

  const resolvePath: ProviderProjectFaviconResolver["Service"]["resolvePath"] = Effect.fn(
    "ProviderProjectFaviconResolver.resolvePath",
  )((projectId) => Cache.get(paths, projectId));

  return ProviderProjectFaviconResolver.of({ resolvePath });
});

export const layer = Layer.effect(ProviderProjectFaviconResolver, make());
