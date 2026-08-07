import type {
  ProviderHostId,
  ServerSettings,
  ServerSettingsPatch,
  SourceControlHostingProviderKind,
  SourceControlProviderKind,
} from "@t3tools/contracts";

export type HostingProviderKind = Exclude<SourceControlProviderKind, "unknown">;

/** Build a whole-map patch without affecting defaults for other hosting services. */
export function buildSourceControlHostingHostDefaultPatch(
  settings: Pick<ServerSettings, "sourceControlHostingHostDefaults">,
  kind: HostingProviderKind,
  hostId: ProviderHostId | null,
): ServerSettingsPatch {
  const sourceControlHostingHostDefaults = {
    ...settings.sourceControlHostingHostDefaults,
  };
  if (hostId === null) {
    delete sourceControlHostingHostDefaults[kind];
  } else {
    sourceControlHostingHostDefaults[kind] = hostId;
  }
  return { sourceControlHostingHostDefaults };
}

/** Enable or disable one centralized hosting integration without changing its host selection. */
export function buildSourceControlHostingEnabledPatch(
  settings: Pick<ServerSettings, "sourceControlDisabledHostingProviders">,
  kind: SourceControlHostingProviderKind,
  enabled: boolean,
): ServerSettingsPatch {
  const sourceControlDisabledHostingProviders = enabled
    ? settings.sourceControlDisabledHostingProviders.filter((candidate) => candidate !== kind)
    : settings.sourceControlDisabledHostingProviders.includes(kind)
      ? settings.sourceControlDisabledHostingProviders
      : [...settings.sourceControlDisabledHostingProviders, kind];

  return { sourceControlDisabledHostingProviders };
}
