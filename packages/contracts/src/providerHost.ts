/**
 * Provider-host configuration shared by Cocoa's gateway and reference clients.
 *
 * A provider host is an independently operated execution endpoint. Provider
 * instances reference it by id; the transport is configured once on the host
 * rather than duplicated inside every provider-specific config blob.
 *
 * @module providerHost
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CocoaHostTransport } from "./codexEndpoint.ts";

const PROVIDER_HOST_ID_MAX_CHARS = 64;
const PROVIDER_HOST_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/u;
const PROVIDER_HOST_ICON_SVG_MAX_CHARS = 64 * 1024;

export const PROVIDER_HOST_ICONS = [
  "server",
  "monitor",
  "laptop",
  "smartphone",
  "cloud",
  "database",
  "hard-drive",
  "container",
  "boxes",
  "cpu",
  "memory-stick",
  "network",
  "router",
  "wifi",
  "terminal",
  "code",
  "braces",
  "bot",
  "sparkles",
  "globe",
  "house",
  "building",
  "factory",
  "shield",
  "lock",
  "key",
  "rocket",
  "zap",
  "workflow",
  "git-branch",
  "wrench",
  "settings",
  "flask",
  "bug",
  "gamepad",
  "radio-tower",
] as const;

/** Stable semantic icon identifiers that clients map to their native icon set. */
export const ProviderHostIcon = Schema.Literals(PROVIDER_HOST_ICONS);
export type ProviderHostIcon = typeof ProviderHostIcon.Type;
export const DEFAULT_PROVIDER_HOST_ICON: ProviderHostIcon = "server";

/** Stable settings-map key for one independently operated provider host. */
export const ProviderHostId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_HOST_ID_MAX_CHARS),
  Schema.isPattern(PROVIDER_HOST_ID_PATTERN),
).pipe(Schema.brand("ProviderHostId"));
export type ProviderHostId = typeof ProviderHostId.Type;

/** Host-owned presentation and connection configuration. */
export const ProviderHostConfig = Schema.Struct({
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  icon: Schema.optionalKey(ProviderHostIcon),
  // Compatibility field for settings written by the short-lived SVG upload UI.
  iconSvg: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_HOST_ICON_SVG_MAX_CHARS)),
  ),
  accentColor: Schema.optionalKey(TrimmedNonEmptyString),
  transport: CocoaHostTransport,
});
export type ProviderHostConfig = typeof ProviderHostConfig.Type;

/** Complete configured provider-host catalog, keyed by stable host id. */
export const ProviderHostConfigMap = Schema.Record(ProviderHostId, ProviderHostConfig);
export type ProviderHostConfigMap = typeof ProviderHostConfigMap.Type;
