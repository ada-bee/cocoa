import {
  type FilesystemBrowseEntry,
  type FilesystemBrowseInput,
  type FilesystemBrowseLocator,
  type ProviderInstanceId,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  isFilesystemBrowseQuery,
} from "./projects.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

function normalizePosixDirectoryPath(path: string): string | null {
  if (path.includes("\\")) return null;
  const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  if (withoutTrailingSlash.length === 0) return "";
  const segments = withoutTrailingSlash.split("/");
  return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ? null
    : segments.join("/");
}

export function getFilesystemBrowseLocator(directoryPath: string): FilesystemBrowseLocator | null {
  const trimmedPath = directoryPath.trim();
  if (trimmedPath.startsWith("~/")) {
    const relativePath = normalizePosixDirectoryPath(trimmedPath.slice(2));
    return relativePath === null ? null : { kind: "home", relativePath };
  }
  if (trimmedPath.startsWith("/")) {
    const relativePath = normalizePosixDirectoryPath(trimmedPath.slice(1));
    if (relativePath === null) return null;
    return { kind: "absolute", path: relativePath.length === 0 ? "/" : `/${relativePath}` };
  }
  return null;
}

export function getFilesystemBrowseInput(
  providerInstanceId: ProviderInstanceId,
  directoryPath: string,
): FilesystemBrowseInput | null {
  const locator = getFilesystemBrowseLocator(directoryPath);
  return locator ? { providerInstanceId, locator } : null;
}

export function appendFilesystemBrowseLeaf(directoryPath: string, leaf: string): string | null {
  const locator = getFilesystemBrowseLocator(directoryPath);
  const trimmedLeaf = leaf.trim();
  if (
    locator?.kind !== "absolute" ||
    trimmedLeaf.length === 0 ||
    trimmedLeaf === "." ||
    trimmedLeaf === ".." ||
    trimmedLeaf.includes("/") ||
    trimmedLeaf.includes("\\")
  ) {
    return null;
  }
  return locator.path === "/" ? `/${trimmedLeaf}` : `${locator.path}/${trimmedLeaf}`;
}

export function getFilesystemBrowsePath(query: string, enabled = true) {
  const isBrowsing = enabled && isFilesystemBrowseQuery(query);
  const directoryPath = isBrowsing ? getBrowseDirectoryPath(query) : "";
  const filterQuery =
    isBrowsing && !hasTrailingPathSeparator(query) ? getBrowseLeafPathSegment(query) : "";
  const parentPath = isBrowsing ? getBrowseParentPath(directoryPath) : null;
  const locator = isBrowsing ? getFilesystemBrowseLocator(directoryPath) : null;

  return {
    isBrowsing,
    directoryPath,
    filterQuery,
    parentPath,
    canBrowseUp: isBrowsing && canNavigateUp(directoryPath),
    locator,
  };
}

export function filterFilesystemBrowseEntries(
  entries: ReadonlyArray<FilesystemBrowseEntry>,
  query: string,
) {
  const lowerQuery = query.toLowerCase();
  const showHidden = query.startsWith(".");
  const visibleEntries = entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerQuery) &&
      (showHidden || !entry.name.startsWith(".")),
  );
  const exactEntry =
    query.length > 0 ? (visibleEntries.find((entry) => entry.name === query) ?? null) : null;

  return { visibleEntries, exactEntry };
}

export function createBrowseNavigationCoordinator() {
  let generation = 0;

  return {
    invalidate: () => {
      generation += 1;
    },
    run: async (load: () => Promise<void>, commit: () => void) => {
      const navigationGeneration = ++generation;
      await load();
      if (navigationGeneration !== generation) {
        return false;
      }
      commit();
      return true;
    },
  };
}

export function canPreloadBrowsePath(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export function createFilesystemEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    browse: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:filesystem:browse",
      tag: WS_METHODS.filesystemBrowse,
    }),
  };
}
