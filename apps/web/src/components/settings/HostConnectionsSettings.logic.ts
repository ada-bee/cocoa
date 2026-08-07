import {
  CocoaHostTransport,
  decodeCocoaHostPairingToken,
  ProviderDriverKind,
  type ProviderHostConfig,
  ProviderHostId,
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
  readonly hostId: ProviderHostId;
  readonly host: ProviderHostConfig;
  readonly transport: CocoaHostTransport;
  readonly bindings: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  }>;
  readonly codexBinding: {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  } | null;
  readonly legacy: boolean;
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

export function readCocoaHostIconSvg(host: ProviderHostConfig): string | null {
  const value = host.iconSvg;
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
  host: ProviderHostConfig,
  svg: string | null,
): ProviderHostConfig {
  const { iconSvg: _iconSvg, ...rest } = host;
  return svg === null ? rest : { ...rest, iconSvg: svg };
}

export function deriveCocoaHostConnections(
  settings: Pick<ServerSettings, "providerHosts" | "providerInstances">,
): ReadonlyArray<CocoaHostConnection> {
  const instances = Object.entries(settings.providerInstances ?? {}).map(
    ([rawInstanceId, instance]) => ({
      instanceId: ProviderInstanceId.make(rawInstanceId),
      instance,
    }),
  );
  const canonical = Object.entries(settings.providerHosts ?? {}).map(([rawHostId, host]) => {
    const hostId = ProviderHostId.make(rawHostId);
    const bindings = instances.filter(({ instance }) => instance.hostId === hostId);
    return {
      hostId,
      host,
      transport: host.transport,
      bindings,
      codexBinding: bindings.find(({ instance }) => instance.driver === CODEX_DRIVER) ?? null,
      legacy: false,
    } satisfies CocoaHostConnection;
  });

  const legacy = instances.flatMap(({ instanceId, instance }) => {
    if (instance.driver !== CODEX_DRIVER) return [];
    if (instance.hostId !== undefined) return [];
    const transport = readConfig(instance.config).endpointTransport;
    if (!isCocoaHostTransport(transport)) return [];
    const host: ProviderHostConfig = {
      transport,
      ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
      ...(instance.iconSvg === undefined ? {} : { iconSvg: instance.iconSvg }),
      ...(instance.accentColor === undefined ? {} : { accentColor: instance.accentColor }),
    };
    const binding = { instanceId, instance };
    return [
      {
        hostId: ProviderHostId.make(`legacy_${instanceId}`.slice(0, 64)),
        host,
        transport,
        bindings: [binding],
        codexBinding: binding,
        legacy: true,
      },
    ];
  });
  return [...canonical, ...legacy];
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

function nextHostId(settings: Pick<ServerSettings, "providerHosts">, url: string): ProviderHostId {
  const base = hostnameSlug(url);
  const existing = new Set(Object.keys(settings.providerHosts ?? {}));
  if (!existing.has(base)) return ProviderHostId.make(base);
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    if (!existing.has(candidate)) return ProviderHostId.make(candidate);
  }
}

export function buildAddCocoaHostSettingsPatch(
  settings: Pick<
    ServerSettings,
    "providerHosts" | "providerInstances" | "textGenerationModelSelection"
  >,
  transport: CocoaHostTransport,
): ServerSettingsPatch {
  const existingHosts = deriveCocoaHostConnections(settings);
  const matchingHosts = existingHosts.filter(
    (connection) => connection.transport.url === transport.url,
  );
  const canonicalMatch = matchingHosts.find((connection) => !connection.legacy);
  const legacyMatch = matchingHosts.find((connection) => connection.legacy);
  const matchingHost = canonicalMatch ?? legacyMatch;
  const existingCodexHosts = existingHosts.filter((connection) => connection.codexBinding !== null);
  const isFirstHost = existingCodexHosts.length === 0;
  const hostId = canonicalMatch?.hostId ?? nextHostId(settings, transport.url);
  const instanceId =
    canonicalMatch?.codexBinding?.instanceId ??
    legacyMatch?.codexBinding?.instanceId ??
    (isFirstHost ? DEFAULT_CODEX_INSTANCE : nextInstanceId(settings, transport.url));
  const existingInstance = settings.providerInstances?.[instanceId];
  const existingConfig = readConfig(existingInstance?.config);
  const customModels = Array.isArray(existingConfig.customModels)
    ? existingConfig.customModels.filter((model): model is string => typeof model === "string")
    : [];
  const hostname = new URL(transport.url).hostname;
  const previousHost = matchingHost?.host;
  const host: ProviderHostConfig = {
    ...(previousHost?.displayName === undefined
      ? { displayName: hostname }
      : { displayName: previousHost.displayName }),
    ...(previousHost?.iconSvg === undefined ? {} : { iconSvg: previousHost.iconSvg }),
    ...(previousHost?.accentColor === undefined ? {} : { accentColor: previousHost.accentColor }),
    transport,
  };

  const patch: ServerSettingsPatch = {
    providerHosts: {
      ...settings.providerHosts,
      [hostId]: host,
    },
    providerInstances: {
      ...settings.providerInstances,
      [instanceId]: {
        driver: CODEX_DRIVER,
        hostId,
        enabled: true,
        ...(existingInstance?.displayName === undefined
          ? {}
          : { displayName: existingInstance.displayName }),
        ...(existingInstance?.accentColor === undefined
          ? {}
          : { accentColor: existingInstance.accentColor }),
        ...(existingInstance?.iconSvg === undefined ? {} : { iconSvg: existingInstance.iconSvg }),
        config: customModels.length === 0 ? {} : { customModels },
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

export function buildUpdateCocoaHostSettingsPatch(
  settings: Pick<
    ServerSettings,
    "providerHosts" | "providerInstances" | "textGenerationModelSelection"
  >,
  connection: CocoaHostConnection,
  host: ProviderHostConfig,
): ServerSettingsPatch {
  if (!connection.legacy) {
    return {
      providerHosts: {
        ...settings.providerHosts,
        [connection.hostId]: host,
      },
    };
  }
  const migration = buildAddCocoaHostSettingsPatch(settings, connection.transport);
  const providerHosts = migration.providerHosts ?? settings.providerHosts;
  const providerInstances = migration.providerInstances ?? settings.providerInstances;
  const migrated = deriveCocoaHostConnections({ providerHosts, providerInstances }).find(
    (candidate) => !candidate.legacy && candidate.transport.url === connection.transport.url,
  );
  if (!migrated) throw new Error("Could not migrate the legacy provider host.");
  return {
    ...migration,
    providerHosts: {
      ...providerHosts,
      [migrated.hostId]: host,
    },
  };
}

export function buildRemoveCocoaHostSettingsPatch(
  settings: Pick<
    ServerSettings,
    | "providerInstances"
    | "providerHosts"
    | "sourceControlHostingHostDefaults"
    | "defaultModelSelections"
    | "sourceControlWriterModelSelection"
    | "textGenerationModelSelection"
    | "textGenerationModelSelections"
  >,
  connection: CocoaHostConnection,
): ServerSettingsPatch {
  const providerHosts = { ...settings.providerHosts };
  if (!connection.legacy) delete providerHosts[connection.hostId];
  const sourceControlHostingHostDefaults = {
    ...settings.sourceControlHostingHostDefaults,
  };
  for (const [kind, hostId] of Object.entries(sourceControlHostingHostDefaults)) {
    if (hostId === connection.hostId) {
      delete sourceControlHostingHostDefaults[
        kind as keyof typeof sourceControlHostingHostDefaults
      ];
    }
  }
  const providerInstances = { ...settings.providerInstances };
  const removedInstanceIds = new Set(connection.bindings.map(({ instanceId }) => instanceId));
  for (const instanceId of removedInstanceIds) delete providerInstances[instanceId];
  const textGenerationModelSelections = { ...settings.textGenerationModelSelections };
  const defaultModelSelections = { ...settings.defaultModelSelections };
  let removedDefaultSelection = false;
  let removedPerProviderSelection = false;
  for (const instanceId of removedInstanceIds) {
    removedDefaultSelection ||= defaultModelSelections[instanceId] !== undefined;
    removedPerProviderSelection ||= textGenerationModelSelections[instanceId] !== undefined;
    delete defaultModelSelections[instanceId];
    delete textGenerationModelSelections[instanceId];
  }
  const perProviderPatch = {
    ...(removedPerProviderSelection ? { textGenerationModelSelections } : {}),
    ...(removedDefaultSelection ? { defaultModelSelections } : {}),
    sourceControlHostingHostDefaults,
  };
  const remainingHost = deriveCocoaHostConnections({ providerHosts, providerInstances }).find(
    (candidate) => candidate.codexBinding !== null,
  );
  if (!remainingHost?.codexBinding) {
    return { providerHosts, providerInstances, ...perProviderPatch };
  }
  const remainingInstanceId = remainingHost.codexBinding.instanceId;

  const repointTextGeneration = removedInstanceIds.has(
    settings.textGenerationModelSelection.instanceId,
  );
  const repointSourceControl =
    settings.sourceControlWriterModelSelection !== null &&
    removedInstanceIds.has(settings.sourceControlWriterModelSelection.instanceId);
  const textGenerationModelSelection = {
    ...settings.textGenerationModelSelection,
    instanceId: remainingInstanceId,
  };
  const sourceControlWriterModelSelection = settings.sourceControlWriterModelSelection
    ? {
        ...settings.sourceControlWriterModelSelection,
        instanceId: remainingInstanceId,
      }
    : null;

  if (repointTextGeneration && repointSourceControl) {
    return {
      providerHosts,
      providerInstances,
      ...perProviderPatch,
      textGenerationModelSelection,
      sourceControlWriterModelSelection,
    };
  }
  if (repointTextGeneration) {
    return { providerHosts, providerInstances, ...perProviderPatch, textGenerationModelSelection };
  }
  if (repointSourceControl) {
    return {
      providerHosts,
      providerInstances,
      ...perProviderPatch,
      sourceControlWriterModelSelection,
    };
  }
  return { providerHosts, providerInstances, ...perProviderPatch };
}
