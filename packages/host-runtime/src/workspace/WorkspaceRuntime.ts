// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const DEFAULT_READ_MAX_BYTES = 1024 * 1024;
const DEFAULT_LIST_MAX_ENTRIES = 1_000;
const DEFAULT_TREE_MAX_ENTRIES = 10_000;
const DEFAULT_TREE_MAX_DEPTH = 20;
const DEFAULT_TREE_MAX_DIRECTORIES = 1_000;

export type WorkspaceEntryKind = "file" | "directory" | "symlink" | "other";

export interface WorkspaceStat {
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  readonly size: number;
  readonly modifiedAtMs: number;
}

export interface WorkspaceEntry extends WorkspaceStat {
  readonly name: string;
}

export interface WorkspaceListResult {
  readonly path: string;
  readonly entries: ReadonlyArray<WorkspaceEntry>;
  readonly truncated: boolean;
}

export interface WorkspaceTreeEntry extends WorkspaceEntry {
  readonly depth: number;
}

export interface WorkspaceTreeResult {
  readonly path: string;
  readonly entries: ReadonlyArray<WorkspaceTreeEntry>;
  readonly truncated: boolean;
}

export interface WorkspaceReadResult {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly truncated: boolean;
}

export interface WorkspaceBrowseResult extends WorkspaceListResult {
  readonly parentPath: string | null;
}

export class WorkspaceRuntimeError extends Schema.TaggedErrorClass<WorkspaceRuntimeError>()(
  "WorkspaceRuntimeError",
  {
    operation: Schema.Literals(["open", "stat", "list", "tree", "read", "browse"]),
    path: Schema.String,
    reason: Schema.Literals([
      "invalid-path",
      "path-not-found",
      "path-not-directory",
      "path-not-file",
      "outside-root",
      "operation-failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace ${this.operation} failed for '${this.path}': ${this.reason}`;
  }
}

export type WorkspaceOperation = WorkspaceRuntimeError["operation"];

export interface WorkspaceRuntime {
  readonly rootPath: string;
  readonly stat: (path?: string) => Effect.Effect<WorkspaceStat, WorkspaceRuntimeError>;
  readonly list: (
    path?: string,
    options?: { readonly maxEntries?: number },
  ) => Effect.Effect<WorkspaceListResult, WorkspaceRuntimeError>;
  readonly tree: (
    path?: string,
    options?: {
      readonly maxEntries?: number;
      readonly maxDepth?: number;
      readonly maxDirectories?: number;
    },
  ) => Effect.Effect<WorkspaceTreeResult, WorkspaceRuntimeError>;
  readonly read: (
    path: string,
    options?: { readonly maxBytes?: number },
  ) => Effect.Effect<WorkspaceReadResult, WorkspaceRuntimeError>;
  readonly browse: (
    path?: string,
    options?: { readonly maxEntries?: number },
  ) => Effect.Effect<WorkspaceBrowseResult, WorkspaceRuntimeError>;
}

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { readonly code?: unknown }).code)
    : undefined;

const operationError = (
  operation: WorkspaceOperation,
  path: string,
  cause: unknown,
): WorkspaceRuntimeError => {
  const code = errorCode(cause);
  return new WorkspaceRuntimeError({
    operation,
    path,
    reason:
      code === "ENOENT"
        ? "path-not-found"
        : code === "ENOTDIR"
          ? "path-not-directory"
          : "operation-failed",
    cause,
  });
};

const validateLimit = (
  value: number | undefined,
  fallback: number,
  operation: WorkspaceOperation,
  path: string,
): Effect.Effect<number, WorkspaceRuntimeError> => {
  const limit = value ?? fallback;
  return Number.isSafeInteger(limit) && limit > 0
    ? Effect.succeed(limit)
    : Effect.fail(new WorkspaceRuntimeError({ operation, path, reason: "invalid-path" }));
};

/** Accepts only normalized POSIX paths relative to an already-open host root. */
export const normalizeWorkspacePath = (
  input: string,
  operation: WorkspaceOperation = "stat",
): Effect.Effect<string, WorkspaceRuntimeError> => {
  const invalid =
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/") ||
    (input !== "" &&
      input
        .split("/")
        .some((component) => component === "" || component === "." || component === ".."));
  return invalid
    ? Effect.fail(new WorkspaceRuntimeError({ operation, path: input, reason: "invalid-path" }))
    : Effect.succeed(input);
};

const entryKind = (stat: NodeFS.Stats): WorkspaceEntryKind =>
  stat.isSymbolicLink()
    ? "symlink"
    : stat.isFile()
      ? "file"
      : stat.isDirectory()
        ? "directory"
        : "other";

const containsPath = (rootPath: string, candidatePath: string): boolean =>
  rootPath === "/" || candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);

export const openWorkspace = Effect.fn("WorkspaceRuntime.open")(function* (
  rootPath: string,
): Effect.fn.Return<WorkspaceRuntime, WorkspaceRuntimeError> {
  if (
    rootPath.includes("\0") ||
    rootPath.includes("\\") ||
    !NodePath.posix.isAbsolute(rootPath) ||
    NodePath.posix.normalize(rootPath) !== rootPath
  ) {
    return yield* new WorkspaceRuntimeError({
      operation: "open",
      path: rootPath,
      reason: "invalid-path",
    });
  }

  const canonicalRoot = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(rootPath),
    catch: (cause) => operationError("open", rootPath, cause),
  });
  const rootStat = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(canonicalRoot),
    catch: (cause) => operationError("open", rootPath, cause),
  });
  if (!rootStat.isDirectory()) {
    return yield* new WorkspaceRuntimeError({
      operation: "open",
      path: rootPath,
      reason: "path-not-directory",
    });
  }

  const resolveExisting = Effect.fn("WorkspaceRuntime.resolveExisting")(function* (
    relativePath: string,
    operation: WorkspaceOperation,
  ) {
    const normalized = yield* normalizeWorkspacePath(relativePath, operation);
    const lexicalPath =
      normalized === "" ? canonicalRoot : NodePath.posix.join(canonicalRoot, normalized);
    const realPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(lexicalPath),
      catch: (cause) => operationError(operation, relativePath, cause),
    });
    if (!containsPath(canonicalRoot, realPath)) {
      return yield* new WorkspaceRuntimeError({
        operation,
        path: relativePath,
        reason: "outside-root",
      });
    }
    return { normalized, lexicalPath, realPath };
  });

  const stat = Effect.fn("WorkspaceRuntime.stat")(function* (relativePath = "") {
    const target = yield* resolveExisting(relativePath, "stat");
    const value = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(target.realPath),
      catch: (cause) => operationError("stat", relativePath, cause),
    });
    return {
      path: target.normalized,
      kind: entryKind(value),
      size: value.size,
      modifiedAtMs: value.mtimeMs,
    } satisfies WorkspaceStat;
  });

  const listForOperation = Effect.fn("WorkspaceRuntime.listForOperation")(function* (
    relativePath: string,
    operation: "list" | "browse",
    maxEntriesInput?: number,
  ) {
    const maxEntries = yield* validateLimit(
      maxEntriesInput,
      DEFAULT_LIST_MAX_ENTRIES,
      operation,
      relativePath,
    );
    const target = yield* resolveExisting(relativePath, operation);
    const targetStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(target.realPath),
      catch: (cause) => operationError(operation, relativePath, cause),
    });
    if (!targetStat.isDirectory()) {
      return yield* new WorkspaceRuntimeError({
        operation,
        path: relativePath,
        reason: "path-not-directory",
      });
    }
    const names = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(target.realPath),
      catch: (cause) => operationError(operation, relativePath, cause),
    });
    names.sort((left, right) => left.localeCompare(right));
    const entries: WorkspaceEntry[] = [];
    for (const name of names.slice(0, maxEntries)) {
      const childRelative = target.normalized === "" ? name : `${target.normalized}/${name}`;
      const childStat = yield* Effect.tryPromise({
        try: () => NodeFSP.lstat(NodePath.posix.join(target.realPath, name)),
        catch: (cause) => operationError(operation, childRelative, cause),
      });
      entries.push({
        name,
        path: childRelative,
        kind: entryKind(childStat),
        size: childStat.size,
        modifiedAtMs: childStat.mtimeMs,
      });
    }
    return {
      path: target.normalized,
      entries,
      truncated: names.length > maxEntries,
    } satisfies WorkspaceListResult;
  });

  const list: WorkspaceRuntime["list"] = (path = "", options) =>
    listForOperation(path, "list", options?.maxEntries);

  const browse: WorkspaceRuntime["browse"] = Effect.fn("WorkspaceRuntime.browse")(function* (
    path = "",
    options,
  ) {
    const result = yield* listForOperation(path, "browse", options?.maxEntries);
    const parentPath =
      result.path === ""
        ? null
        : NodePath.posix.dirname(result.path) === "."
          ? ""
          : NodePath.posix.dirname(result.path);
    return { ...result, parentPath } satisfies WorkspaceBrowseResult;
  });

  const tree: WorkspaceRuntime["tree"] = Effect.fn("WorkspaceRuntime.tree")(function* (
    path = "",
    options,
  ) {
    const maxEntries = yield* validateLimit(
      options?.maxEntries,
      DEFAULT_TREE_MAX_ENTRIES,
      "tree",
      path,
    );
    const maxDepth = yield* validateLimit(options?.maxDepth, DEFAULT_TREE_MAX_DEPTH, "tree", path);
    const maxDirectories = yield* validateLimit(
      options?.maxDirectories,
      DEFAULT_TREE_MAX_DIRECTORIES,
      "tree",
      path,
    );
    const target = yield* resolveExisting(path, "tree");
    const rootTargetStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(target.realPath),
      catch: (cause) => operationError("tree", path, cause),
    });
    if (!rootTargetStat.isDirectory()) {
      return yield* new WorkspaceRuntimeError({
        operation: "tree",
        path,
        reason: "path-not-directory",
      });
    }

    const entries: WorkspaceTreeEntry[] = [];
    let truncated = false;
    let directoriesVisited = 1;
    const visit = Effect.fn("WorkspaceRuntime.tree.visit")(function* (
      directoryRealPath: string,
      directoryRelativePath: string,
      depth: number,
    ): Effect.fn.Return<void, WorkspaceRuntimeError> {
      if (depth > maxDepth || entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const names = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(directoryRealPath),
        catch: (cause) => operationError("tree", directoryRelativePath, cause),
      });
      names.sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        const relative = directoryRelativePath === "" ? name : `${directoryRelativePath}/${name}`;
        const lexical = NodePath.posix.join(directoryRealPath, name);
        const childStat = yield* Effect.tryPromise({
          try: () => NodeFSP.lstat(lexical),
          catch: (cause) => operationError("tree", relative, cause),
        });
        const kind = entryKind(childStat);
        entries.push({
          name,
          path: relative,
          kind,
          size: childStat.size,
          modifiedAtMs: childStat.mtimeMs,
          depth,
        });
        if (kind === "directory") {
          if (depth >= maxDepth || directoriesVisited >= maxDirectories) {
            truncated = true;
          } else {
            directoriesVisited += 1;
            yield* visit(lexical, relative, depth + 1);
          }
        }
      }
    });
    yield* visit(target.realPath, target.normalized, 1);
    return { path: target.normalized, entries, truncated } satisfies WorkspaceTreeResult;
  });

  const read: WorkspaceRuntime["read"] = Effect.fn("WorkspaceRuntime.read")(
    function* (path, options) {
      const maxBytes = yield* validateLimit(
        options?.maxBytes,
        DEFAULT_READ_MAX_BYTES,
        "read",
        path,
      );
      const target = yield* resolveExisting(path, "read");
      const handle = yield* Effect.tryPromise({
        try: () =>
          NodeFSP.open(target.realPath, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW),
        catch: (cause) => operationError("read", path, cause),
      });
      return yield* Effect.acquireUseRelease(
        Effect.succeed(handle),
        (openHandle) =>
          Effect.gen(function* () {
            const value = yield* Effect.tryPromise({
              try: () => openHandle.stat(),
              catch: (cause) => operationError("read", path, cause),
            });
            if (!value.isFile()) {
              return yield* new WorkspaceRuntimeError({
                operation: "read",
                path,
                reason: "path-not-file",
              });
            }
            const buffer = Buffer.alloc(Math.min(value.size, maxBytes));
            const { bytesRead } = yield* Effect.tryPromise({
              try: () => openHandle.read(buffer, 0, buffer.length, 0),
              catch: (cause) => operationError("read", path, cause),
            });
            const bytes = buffer.subarray(0, bytesRead);
            return {
              path: target.normalized,
              bytes: new Uint8Array(bytes),
              byteLength: value.size,
              truncated: value.size > maxBytes,
            } satisfies WorkspaceReadResult;
          }),
        (openHandle) => Effect.promise(() => openHandle.close()),
      );
    },
  );

  return { rootPath: canonicalRoot, stat, list, tree, read, browse };
});
