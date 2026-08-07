import {
  type OrchestrationProjectShell,
  type ProviderHostId,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type SourceControlDiscoveryResult,
  type SourceControlProviderDiscoveryItem,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

const PROVIDER_LABELS: Readonly<Record<SourceControlProviderKind, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  "azure-devops": "Azure DevOps",
  unknown: "Source control provider",
};

const PROVIDER_INSTALL_HINTS: Readonly<Record<SourceControlProviderKind, string>> = {
  github: "Install and authenticate the GitHub CLI on this provider host.",
  gitlab: "Install and authenticate the GitLab CLI on this provider host.",
  bitbucket: "Configure Bitbucket credentials on this provider host.",
  "azure-devops": "Install and authenticate the Azure CLI on this provider host.",
  unknown: "Configure the repository hosting integration on this provider host.",
};

export function resolveProviderSourceControlInstanceId(input: {
  readonly requestedInstanceId?: ProviderInstanceId;
  readonly requestedHostId?: ProviderHostId;
  readonly configuredInstances: ProviderInstanceConfigMap;
  readonly liveInstances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly vcsAvailable: boolean;
  }>;
}): ProviderInstanceId | undefined {
  if (input.requestedInstanceId !== undefined) return input.requestedInstanceId;
  if (input.requestedHostId === undefined) return input.liveInstances[0]?.instanceId;

  const configuredIds = new Set(
    Object.entries(input.configuredInstances)
      .filter(([, configured]) => configured.hostId === input.requestedHostId)
      .map(([instanceId]) => instanceId),
  );
  return (
    input.liveInstances.find(
      (instance) => configuredIds.has(instance.instanceId) && instance.vcsAvailable,
    )?.instanceId ??
    input.liveInstances.find((instance) => configuredIds.has(instance.instanceId))?.instanceId
  );
}

function detectedProviderItem(kind: SourceControlProviderKind): SourceControlProviderDiscoveryItem {
  return {
    kind,
    label: PROVIDER_LABELS[kind],
    status: "available",
    version: Option.none(),
    installHint: PROVIDER_INSTALL_HINTS[kind],
    detail: Option.some("Detected from a repository remote on this provider host."),
    auth: {
      status: "unknown",
      account: Option.none(),
      host: Option.none(),
      detail: Option.some(
        "Cocoa can read this host's repositories, but account discovery is not available yet.",
      ),
    },
  };
}

function sourceControlProviderKind(value: string | undefined): SourceControlProviderKind | null {
  switch (value) {
    case "github":
    case "gitlab":
    case "bitbucket":
    case "azure-devops":
    case "unknown":
      return value;
    default:
      return null;
  }
}

export function discoverProviderSourceControl(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly vcsAvailable: boolean;
}): SourceControlDiscoveryResult {
  const providerKinds = new Set<SourceControlProviderKind>();
  for (const project of input.projects) {
    if (project.providerInstanceId !== input.providerInstanceId) continue;
    const kind = sourceControlProviderKind(project.repositoryIdentity?.provider);
    if (kind !== null) providerKinds.add(kind);
  }

  return {
    versionControlSystems: [
      {
        kind: "git",
        label: "Git",
        executable: "git",
        implemented: true,
        status: input.vcsAvailable ? "available" : "missing",
        version: Option.none(),
        installHint: "Configure a Git executable for this provider host.",
        detail: input.vcsAvailable
          ? Option.some("Git operations are routed through this provider host.")
          : Option.some("This provider host does not currently expose Git operations."),
      },
    ],
    sourceControlProviders: [...providerKinds]
      .toSorted((left, right) => left.localeCompare(right))
      .map(detectedProviderItem),
  };
}
