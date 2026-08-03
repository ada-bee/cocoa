import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  ProjectId,
  type ProjectWorkspaceTarget,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];
const EMPTY_PROJECT_WORKSPACE_TARGET = { projectId: ProjectId.make("unselected") };

/**
 * Scripts declared in the project's checked-in `t3.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  target: ProjectWorkspaceTarget | null,
): ReadonlyArray<T3ProjectFileScript> {
  const query = useProjectFileQuery(
    environmentId,
    target ?? EMPTY_PROJECT_WORKSPACE_TARGET,
    T3_PROJECT_FILE_NAME,
    target !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return useMemo(() => {
    if (contents === null) return NO_SCRIPTS;
    const decoded = decodeT3ProjectFile(contents);
    if (Exit.isFailure(decoded)) return NO_SCRIPTS;
    return decoded.value.scripts ?? NO_SCRIPTS;
  }, [contents]);
}
