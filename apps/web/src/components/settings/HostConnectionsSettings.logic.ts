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

const HOST_ICON_MAX_BYTES = 64 * 1024;
const SVG_XML_DECLARATION = /^<\?xml(?:\s+[^?]*)?\?>/iu;
const SVG_COMMENT = /^<!--[\s\S]*?-->/u;
const SVG_DOCTYPE =
  /^<!DOCTYPE\s+svg(?:\s+(?:PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*')|SYSTEM\s+(?:"[^"]*"|'[^']*')))?\s*>/iu;

function stripCocoaHostIconSvgPreamble(input: string): string {
  let remaining = input;
  for (;;) {
    const preamble =
      remaining.match(SVG_XML_DECLARATION) ??
      remaining.match(SVG_COMMENT) ??
      remaining.match(SVG_DOCTYPE);
    if (!preamble) return remaining;
    remaining = remaining.slice(preamble[0].length).trimStart();
  }
}

export function readCocoaHostIconSvg(instance: ProviderInstanceConfig): string | null {
  const value = instance.iconSvg;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Keep SVG uploads inert and bounded. They are rendered through an `<img>`
 * data URL (never injected as markup); these checks additionally reject
 * executable content, external fetches, and embedded documents.
 */
export function sanitizeCocoaHostIconSvg(input: string): string {
  const boundedInput = input.trim();
  if (new TextEncoder().encode(boundedInput).byteLength > HOST_ICON_MAX_BYTES) {
    throw new Error("Host icons must be 64 KB or smaller.");
  }
  const svg = stripCocoaHostIconSvgPreamble(boundedInput);
  if (!/^<svg(?:\s|>)/iu.test(svg) || !/<\/svg>$/iu.test(svg)) {
    throw new Error("Choose a complete SVG file.");
  }
  if (
    /<(?:script|foreignObject|iframe|object|embed|audio|video)\b/iu.test(svg) ||
    /\son[a-z]+\s*=/iu.test(svg) ||
    /\b(?:href|xlink:href)\s*=\s*["'](?!#)/iu.test(svg) ||
    /(?:url\s*\(|@import)/iu.test(svg)
  ) {
    throw new Error("Host icons cannot contain scripts, embedded documents, or external links.");
  }
  return svg;
}

export function withCocoaHostIconSvg(
  instance: ProviderInstanceConfig,
  svg: string | null,
): ProviderInstanceConfig {
  const { iconSvg: _iconSvg, ...rest } = instance;
  return svg === null ? rest : { ...rest, iconSvg: svg };
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
        ...(existingInstance?.iconSvg === undefined ? {} : { iconSvg: existingInstance.iconSvg }),
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
    | "providerInstances"
    | "defaultModelSelections"
    | "sourceControlWriterModelSelection"
    | "textGenerationModelSelection"
    | "textGenerationModelSelections"
  >,
  connection: CocoaHostConnection,
): ServerSettingsPatch {
  const providerInstances = { ...settings.providerInstances };
  delete providerInstances[connection.instanceId];
  const textGenerationModelSelections = { ...settings.textGenerationModelSelections };
  const defaultModelSelections = { ...settings.defaultModelSelections };
  const removedDefaultSelection = defaultModelSelections[connection.instanceId] !== undefined;
  delete defaultModelSelections[connection.instanceId];
  const removedPerProviderSelection =
    textGenerationModelSelections[connection.instanceId] !== undefined;
  delete textGenerationModelSelections[connection.instanceId];
  const perProviderPatch = {
    ...(removedPerProviderSelection ? { textGenerationModelSelections } : {}),
    ...(removedDefaultSelection ? { defaultModelSelections } : {}),
  };
  const [remainingHost] = deriveCocoaHostConnections({ providerInstances });
  if (!remainingHost) return { providerInstances, ...perProviderPatch };

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
    return {
      providerInstances,
      ...perProviderPatch,
      textGenerationModelSelection,
      sourceControlWriterModelSelection,
    };
  }
  if (repointTextGeneration) {
    return { providerInstances, ...perProviderPatch, textGenerationModelSelection };
  }
  if (repointSourceControl) {
    return { providerInstances, ...perProviderPatch, sourceControlWriterModelSelection };
  }
  return { providerInstances, ...perProviderPatch };
}
