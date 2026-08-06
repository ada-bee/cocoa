import { type ProviderDriverKind, type ServerProviderVersionAdvisory } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
}): ProviderMaintenanceCapabilities {
  return {
    provider: input.provider,
    packageName: input.packageName,
    update:
      input.updateExecutable === null || input.updateLockKey === null
        ? null
        : {
            command: [input.updateExecutable, ...input.updateArgs].join(" "),
            executable: input.updateExecutable,
            args: input.updateArgs,
            lockKey: input.updateLockKey,
          },
  };
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    ...input,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  });
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: input.driver,
      packageName: null,
    });
  const latestVersion = input.latestVersion ?? null;
  const isBehind =
    input.currentVersion !== null &&
    latestVersion !== null &&
    compareSemverVersions(input.currentVersion, latestVersion) < 0;
  const hasComparableVersions = input.currentVersion !== null && latestVersion !== null;

  return {
    status: isBehind ? "behind_latest" : hasComparableVersions ? "current" : "unknown",
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: isBehind ? "Install the update now or review provider settings." : null,
  };
}
