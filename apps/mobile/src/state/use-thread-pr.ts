import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { useRepositoryStatus } from "./queries";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

/**
 * Live PR status for a thread's branch. Subscriptions are deduplicated per
 * (environmentId, projectId, threadId) by the atom family, and virtualization
 * means only visible rows subscribe at all.
 */
export function useThreadPr(thread: EnvironmentThreadShell): ThreadPrPresentation | null {
  const gitStatus = useRepositoryStatus({
    environmentId: thread.branch === null ? null : thread.environmentId,
    target: thread.branch === null ? null : { projectId: thread.projectId, threadId: thread.id },
  });

  const status = gitStatus.data;
  if (status === null || thread.branch === null || status.refName !== thread.branch) {
    return null;
  }
  if (!status.pr) {
    return null;
  }
  return presentThreadPr(status.pr, status.sourceControlProvider);
}
