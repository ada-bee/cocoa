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

/** Stable settings-map key for one independently operated provider host. */
export const ProviderHostId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_HOST_ID_MAX_CHARS),
  Schema.isPattern(PROVIDER_HOST_ID_PATTERN),
).pipe(Schema.brand("ProviderHostId"));
export type ProviderHostId = typeof ProviderHostId.Type;

/** Host-owned presentation and connection configuration. */
export const ProviderHostConfig = Schema.Struct({
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
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
