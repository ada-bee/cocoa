import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useAssetUrl } from "../../state/assets";

export function useWorkspaceFileAssetUrl(props: {
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
}) {
  return useAssetUrl(
    props.environmentId,
    props.relativePath !== null && props.threadId !== null
      ? {
          _tag: "workspace-file",
          threadId: props.threadId,
          path: props.relativePath,
        }
      : null,
  );
}
