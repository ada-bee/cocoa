import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import {
  connectGateway as connectGatewayAtom,
  updateDirectConnection,
} from "../../connection/onboarding";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspaceEnvironment, type WorkspaceEnvironment } from "../../state/workspaceModel";

export function useConnectionController() {
  const { environments } = useEnvironments();
  const connectGatewayMutation = useAtomCommand(connectGatewayAtom, {
    reportFailure: false,
  });
  const updateDirect = useAtomCommand(updateDirectConnection, { reportFailure: false });
  const removeEnvironmentMutation = useAtomCommand(environmentCatalog.remove, "environment remove");
  const retryEnvironmentMutation = useAtomCommand(environmentCatalog.retryNow, "environment retry");

  const connectedEnvironments = useMemo<ReadonlyArray<WorkspaceEnvironment>>(
    () => environments.map(projectWorkspaceEnvironment),
    [environments],
  );

  const connectGateway = useCallback(
    (httpBaseUrl: string) => connectGatewayMutation(httpBaseUrl),
    [connectGatewayMutation],
  );
  const removeEnvironment = useCallback(
    (environmentId: EnvironmentId) => removeEnvironmentMutation(environmentId),
    [removeEnvironmentMutation],
  );
  const retryEnvironment = useCallback(
    (environmentId: EnvironmentId) => retryEnvironmentMutation(environmentId),
    [retryEnvironmentMutation],
  );
  const updateEnvironment = useCallback(
    (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) =>
      updateDirect({
        environmentId,
        label: updates.label,
        httpBaseUrl: updates.displayUrl,
      }),
    [updateDirect],
  );

  return {
    connectedEnvironments,
    connectGateway,
    removeEnvironment,
    retryEnvironment,
    updateEnvironment,
  };
}
