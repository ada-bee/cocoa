import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleArray,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../../baseSchemas.ts";
import { ProviderInstanceId } from "../../providerInstance.ts";

export const COCOA_CLIENT_PROTOCOL_VERSION = 1 as const;
export const COCOA_CLIENT_PROTOCOL_MIN_VERSION = 1 as const;
export const COCOA_CLIENT_PROTOCOL_MAX_VERSION = 1 as const;

export const CocoaClientProtocolVersionV1 = Schema.Literal(COCOA_CLIENT_PROTOCOL_VERSION);
export type CocoaClientProtocolVersionV1 = typeof CocoaClientProtocolVersionV1.Type;

export const CocoaClientProtocolRange = Schema.Struct({
  minimum: PositiveInt,
  maximum: PositiveInt,
}).check(
  Schema.makeFilter(
    (range) =>
      range.minimum <= range.maximum ||
      "minimum protocol version must be less than or equal to maximum protocol version",
  ),
);
export type CocoaClientProtocolRange = typeof CocoaClientProtocolRange.Type;

export const COCOA_CLIENT_V1_PROTOCOL_RANGE = {
  minimum: COCOA_CLIENT_PROTOCOL_MIN_VERSION,
  maximum: COCOA_CLIENT_PROTOCOL_MAX_VERSION,
} as const satisfies CocoaClientProtocolRange;

export function selectCocoaClientProtocolVersion(
  client: CocoaClientProtocolRange,
  server: CocoaClientProtocolRange,
): number | null {
  const minimum = Math.max(client.minimum, server.minimum);
  const maximum = Math.min(client.maximum, server.maximum);
  return minimum <= maximum ? maximum : null;
}

export const CocoaClientV1CapabilityId = Schema.Literals([
  "orchestration.core",
  "orchestration.resume",
  "orchestration.search",
  "orchestration.diff",
  "workspace.filesystem",
  "workspace.vcs",
  "workspace.terminal",
  "workspace.execution",
]);
export type CocoaClientV1CapabilityId = typeof CocoaClientV1CapabilityId.Type;

export const COCOA_CLIENT_V1_CORE_CAPABILITIES = [
  "orchestration.core",
  "orchestration.resume",
  "orchestration.search",
  "orchestration.diff",
] as const satisfies ReadonlyArray<CocoaClientV1CapabilityId>;

export const COCOA_CLIENT_V1_OPTIONAL_CAPABILITIES = [
  "workspace.filesystem",
  "workspace.vcs",
  "workspace.terminal",
  "workspace.execution",
] as const satisfies ReadonlyArray<CocoaClientV1CapabilityId>;

export const CocoaClientV1Capabilities = ForwardCompatibleArray(CocoaClientV1CapabilityId);
export type CocoaClientV1Capabilities = typeof CocoaClientV1Capabilities.Type;

export const CocoaClientV1ProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optionalKey(TrimmedNonEmptyString),
  isDefault: Schema.optionalKey(Schema.Boolean),
});
export type CocoaClientV1ProviderModel = typeof CocoaClientV1ProviderModel.Type;

export const CocoaClientV1ProviderState = Schema.Literals([
  "ready",
  "warning",
  "error",
  "disabled",
]);
export type CocoaClientV1ProviderState = typeof CocoaClientV1ProviderState.Type;

export const CocoaClientV1ProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type CocoaClientV1ProviderAuthStatus = typeof CocoaClientV1ProviderAuthStatus.Type;

/**
 * Normalized lifecycle for long-lived provider endpoints. Optional on provider
 * info so v1 clients continue to accept gateways that predate endpoint health.
 */
export const CocoaClientV1ProviderConnectionState = Schema.Literals([
  "ready",
  "connecting",
  "disconnected",
  "blocked",
]);
export type CocoaClientV1ProviderConnectionState = typeof CocoaClientV1ProviderConnectionState.Type;

export const COCOA_CLIENT_V1_PROVIDER_MESSAGE_MAX_LENGTH = 2_048;

export const CocoaClientV1ProviderInfo = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  status: CocoaClientV1ProviderState,
  authStatus: CocoaClientV1ProviderAuthStatus,
  connectionState: Schema.optionalKey(CocoaClientV1ProviderConnectionState),
  message: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(COCOA_CLIENT_V1_PROVIDER_MESSAGE_MAX_LENGTH)),
  ),
  models: Schema.Array(CocoaClientV1ProviderModel),
});
export type CocoaClientV1ProviderInfo = typeof CocoaClientV1ProviderInfo.Type;

export const CocoaClientV1EnvironmentInfo = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
});
export type CocoaClientV1EnvironmentInfo = typeof CocoaClientV1EnvironmentInfo.Type;

export const CocoaClientV1InfoRequest = Schema.Struct({
  protocolRange: CocoaClientProtocolRange,
});
export type CocoaClientV1InfoRequest = typeof CocoaClientV1InfoRequest.Type;

export const CocoaClientV1InfoResponse = Schema.Struct({
  protocolVersion: CocoaClientProtocolVersionV1,
  protocolRange: CocoaClientProtocolRange,
  capabilities: CocoaClientV1Capabilities,
  environment: CocoaClientV1EnvironmentInfo,
  providers: Schema.Array(CocoaClientV1ProviderInfo),
});
export type CocoaClientV1InfoResponse = typeof CocoaClientV1InfoResponse.Type;

export const CocoaClientProtocolVersionMismatch = Schema.Struct({
  code: Schema.Literal("protocol_version_mismatch"),
  clientRange: CocoaClientProtocolRange,
  serverRange: CocoaClientProtocolRange,
  message: TrimmedNonEmptyString,
});
export type CocoaClientProtocolVersionMismatch = typeof CocoaClientProtocolVersionMismatch.Type;

export const CocoaClientV1ProbeResult = Schema.Struct({
  protocolVersion: CocoaClientProtocolVersionV1,
});
export type CocoaClientV1ProbeResult = typeof CocoaClientV1ProbeResult.Type;

export function hasCocoaClientV1Capability(
  capabilities: CocoaClientV1Capabilities,
  capability: CocoaClientV1CapabilityId,
): boolean {
  return capabilities.includes(capability);
}
