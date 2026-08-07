import {
  CocoaHostTransport,
  decodeCocoaHostPairingToken,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DEFAULT_CODEX_INSTANCE = ProviderInstanceId.make("codex");
const isCocoaHostTransport = Schema.is(CocoaHostTransport);

export interface CocoaHostConnection {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly transport: CocoaHostTransport;
}

export function parseCocoaHostPairingInput(input: string): CocoaHostTransport {
  try {
    return decodeCocoaHostPairingToken(input);
  } catch {
    throw new Error("Enter a valid Cocoa host pairing token.");
  }
}

function readConfig(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function deriveCocoaHostConnections(
  settings: Pick<ServerSettings, "providerInstances">,
): ReadonlyArray<CocoaHostConnection> {
  return Object.entries(settings.providerInstances ?? {}).flatMap(([rawInstanceId, instance]) => {
    if (instance.driver !== CODEX_DRIVER) return [];
    const transport = readConfig(instance.config).endpointTransport;
    if (!isCocoaHostTransport(transport)) return [];
    return [
      {
        instanceId: ProviderInstanceId.make(rawInstanceId),
        instance,
        transport,
      },
    ];
  });
}

function hostnameSlug(url: string): string {
  const slug = new URL(url).hostname
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 56);
  return slug || "host";
}

function nextInstanceId(settings: Pick<ServerSettings, "providerInstances">, url: string) {
  const base = `codex_${hostnameSlug(url)}`;
  const existing = new Set(Object.keys(settings.providerInstances ?? {}));
  if (!existing.has(base)) return ProviderInstanceId.make(base);

  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    if (!existing.has(candidate)) return ProviderInstanceId.make(candidate);
  }
}

export function buildAddCocoaHostSettingsPatch(
  settings: Pick<ServerSettings, "providerInstances" | "textGenerationModelSelection">,
  transport: CocoaHostTransport,
): ServerSettingsPatch {
  const existingHosts = deriveCocoaHostConnections(settings);
  const isFirstHost = existingHosts.length === 0;
  const instanceId = isFirstHost ? DEFAULT_CODEX_INSTANCE : nextInstanceId(settings, transport.url);
  const existingInstance = settings.providerInstances?.[instanceId];
  const existingConfig = readConfig(existingInstance?.config);
  const customModels = Array.isArray(existingConfig.customModels)
    ? existingConfig.customModels.filter((model): model is string => typeof model === "string")
    : [];
  const hostname = new URL(transport.url).hostname;

  const patch: ServerSettingsPatch = {
    providerInstances: {
      ...settings.providerInstances,
      [instanceId]: {
        driver: CODEX_DRIVER,
        displayName: hostname,
        enabled: true,
        ...(existingInstance?.accentColor === undefined
          ? {}
          : { accentColor: existingInstance.accentColor }),
        config: {
          ...(customModels.length === 0 ? {} : { customModels }),
          endpointTransport: transport,
        },
      },
    },
  };
  if (isFirstHost && settings.textGenerationModelSelection.instanceId !== DEFAULT_CODEX_INSTANCE) {
    return {
      ...patch,
      textGenerationModelSelection: {
        ...settings.textGenerationModelSelection,
        instanceId: DEFAULT_CODEX_INSTANCE,
      },
    };
  }
  return patch;
}

export function buildRemoveCocoaHostSettingsPatch(
  settings: Pick<
    ServerSettings,
    "providerInstances" | "sourceControlWriterModelSelection" | "textGenerationModelSelection"
  >,
  connection: CocoaHostConnection,
): ServerSettingsPatch {
  const providerInstances = { ...settings.providerInstances };
  delete providerInstances[connection.instanceId];
  const [remainingHost] = deriveCocoaHostConnections({ providerInstances });
  if (!remainingHost) return { providerInstances };

  const repointTextGeneration =
    settings.textGenerationModelSelection.instanceId === connection.instanceId;
  const repointSourceControl =
    settings.sourceControlWriterModelSelection?.instanceId === connection.instanceId;
  const textGenerationModelSelection = {
    ...settings.textGenerationModelSelection,
    instanceId: remainingHost.instanceId,
  };
  const sourceControlWriterModelSelection = settings.sourceControlWriterModelSelection
    ? {
        ...settings.sourceControlWriterModelSelection,
        instanceId: remainingHost.instanceId,
      }
    : null;

  if (repointTextGeneration && repointSourceControl) {
    return { providerInstances, textGenerationModelSelection, sourceControlWriterModelSelection };
  }
  if (repointTextGeneration) return { providerInstances, textGenerationModelSelection };
  if (repointSourceControl) return { providerInstances, sourceControlWriterModelSelection };
  return { providerInstances };
}
