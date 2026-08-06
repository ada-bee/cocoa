import * as NodeCrypto from "node:crypto";

import { CodexSettings, type ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const COCOA_DEVELOPMENT_BUILD_IDENTITY = "development";
export const COCOA_SETTINGS_IDENTITY_VERSION = 1 as const;

const BUILD_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}$/;
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

export function normalizeCocoaBuildIdentity(value: string | undefined): string {
  const normalized = value?.trim() || COCOA_DEVELOPMENT_BUILD_IDENTITY;
  if (!BUILD_IDENTITY_PATTERN.test(normalized)) {
    throw new Error("COCOA_BUILD_IDENTITY must be 1-128 non-whitespace URI-safe characters.");
  }
  return normalized;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

/**
 * Hash only Cocoa's loaded provider routing/model configuration. Credential
 * bytes cannot enter this payload: endpoint authentication contains file
 * references, and provider process environments are deliberately omitted.
 */
export function computeCocoaSettingsIdentity(settings: ServerSettings): string {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([instanceId, instance]) => [
        instanceId,
        {
          driver: instance.driver,
          displayName: instance.displayName,
          enabled: instance.enabled,
          config: instance.driver === "codex" ? decodeCodexSettings(instance.config ?? {}) : null,
        },
      ]),
  );
  const payload = canonicalize({
    schemaVersion: COCOA_SETTINGS_IDENTITY_VERSION,
    providerInstances,
    sourceControlWriterModelSelection: settings.sourceControlWriterModelSelection,
    textGenerationModelSelection: settings.textGenerationModelSelection,
  });
  return `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}
