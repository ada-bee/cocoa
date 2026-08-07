import type { CocoaHostVcsRequest, CocoaHostWorkspaceRequest } from "@t3tools/contracts";

import type { HostControlOperationDependencies } from "./state.ts";
import { makeHostControlOperationState } from "./state.ts";
import { makeVcsControlHandler } from "./vcs.ts";
import { makeWorkspaceControlHandler } from "./workspace.ts";

export * from "./state.ts";
export * from "./terminal.ts";
export * from "./vcs.ts";
export * from "./workspace.ts";

/** Transport-free, generation-scoped host operation dispatchers. */
export const makeHostControlOperations = (dependencies: HostControlOperationDependencies) => {
  const state = makeHostControlOperationState(dependencies);
  const workspace = makeWorkspaceControlHandler(state, dependencies);
  const vcs = makeVcsControlHandler(state, dependencies);
  return {
    state,
    workspace: (request: CocoaHostWorkspaceRequest) => workspace(request),
    vcs: (request: CocoaHostVcsRequest) => vcs(request),
  } as const;
};
