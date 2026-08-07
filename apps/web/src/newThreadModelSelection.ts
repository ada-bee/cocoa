import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { resolveDefaultProviderModelSelection } from "./providerInstances";

export interface NewThreadModelTarget {
  readonly providerInstanceId: ProviderInstanceId;
  readonly defaultModelSelection: ModelSelection | null;
}

/**
 * Resolve the model state for a new draft without crossing provider-instance
 * boundaries. A carried selection is reusable only on the exact target
 * endpoint. Otherwise the project's own default wins, followed by that exact
 * endpoint's advertised default; another instance is never considered even
 * when it uses the same driver.
 */
export function resolveNewThreadModelSelection(input: {
  readonly carriedSelection: ModelSelection | null;
  readonly targetProject: NewThreadModelTarget;
  readonly hostDefaultSelection?: ModelSelection | undefined;
  readonly targetEnvironmentProviders: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  if (input.carriedSelection?.instanceId === input.targetProject.providerInstanceId) {
    return input.carriedSelection;
  }

  const projectDefault =
    input.targetProject.defaultModelSelection?.instanceId === input.targetProject.providerInstanceId
      ? input.targetProject.defaultModelSelection
      : null;
  const hostDefault =
    input.hostDefaultSelection?.instanceId === input.targetProject.providerInstanceId
      ? input.hostDefaultSelection
      : null;
  const targetProvider = input.targetEnvironmentProviders.find(
    (provider) => provider.instanceId === input.targetProject.providerInstanceId,
  );

  return targetProvider
    ? resolveDefaultProviderModelSelection([targetProvider], projectDefault ?? hostDefault)
    : (projectDefault ?? hostDefault);
}
