import type {
  ProviderHostId,
  ServerSettings,
  ServerSettingsPatch,
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
