import {
  canCreateProjectInEnvironment,
  getAvailableProjectProviderInstances,
  resolveProjectCreationProviderInstanceId,
  type ProjectProviderCandidate,
} from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

export interface AddProjectProviderSelection<T extends ProjectProviderCandidate> {
  readonly providers: ReadonlyArray<T>;
  readonly selectedProviderInstanceId: ProviderInstanceId | null;
  readonly requiresSelection: boolean;
}

export function resolveAddProjectProviderSelection<T extends ProjectProviderCandidate>(
  providers: ReadonlyArray<T>,
  preferredInstanceId: ProviderInstanceId | null,
): AddProjectProviderSelection<T> {
  const available = getAvailableProjectProviderInstances(providers);
  const selectedProviderInstanceId = resolveProjectCreationProviderInstanceId(
    available,
    preferredInstanceId,
  );
  return {
    providers: available,
    selectedProviderInstanceId,
    requiresSelection: available.length > 1 && selectedProviderInstanceId === null,
  };
}

export function resolveAddProjectEnvironment<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  },
>(environmentOptions: ReadonlyArray<T>, requestedEnvironmentId: EnvironmentId | null): T | null {
  if (requestedEnvironmentId !== null) {
    return (
      environmentOptions.find(
        (environment) =>
          environment.environmentId === requestedEnvironmentId &&
          canCreateProjectInEnvironment(environment.connectionState),
      ) ?? null
    );
  }

  return (
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ?? null
  );
}
