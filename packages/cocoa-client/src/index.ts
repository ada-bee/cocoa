export type {
  CocoaClientProtocolRange,
  CocoaClientV1Capabilities,
  CocoaClientV1CapabilityId,
  CocoaClientV1Command,
  CocoaClientV1DispatchResult,
  CocoaClientV1GetFullThreadDiffInput,
  CocoaClientV1GetFullThreadDiffResult,
  CocoaClientV1GetShellSnapshotInput,
  CocoaClientV1GetThreadSnapshotInput,
  CocoaClientV1GetTurnDiffInput,
  CocoaClientV1GetTurnDiffResult,
  CocoaClientV1InfoResponse,
  CocoaClientV1ProbeResult,
  CocoaClientV1SearchThreadsInput,
  CocoaClientV1SearchThreadsResult,
  CocoaClientV1ShellSnapshot,
  CocoaClientV1ShellStreamItem,
  CocoaClientV1SubscribeShellInput,
  CocoaClientV1SubscribeThreadInput,
  CocoaClientV1ThreadDetailSnapshot,
  CocoaClientV1ThreadStreamItem,
} from "@t3tools/contracts/client/v1";

import type {
  CocoaClientProtocolRange,
  CocoaClientV1CapabilityId,
} from "@t3tools/contracts/client/v1";

export const COCOA_CLIENT_PROTOCOL_VERSION = 1 as const;
export const COCOA_CLIENT_PROTOCOL_MIN_VERSION = 1 as const;
export const COCOA_CLIENT_PROTOCOL_MAX_VERSION = 1 as const;
export const COCOA_CLIENT_V1_PROTOCOL_RANGE = {
  minimum: COCOA_CLIENT_PROTOCOL_MIN_VERSION,
  maximum: COCOA_CLIENT_PROTOCOL_MAX_VERSION,
} as const satisfies CocoaClientProtocolRange;
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
] as const satisfies ReadonlyArray<CocoaClientV1CapabilityId>;

export function selectCocoaClientProtocolVersion(
  client: CocoaClientProtocolRange,
  server: CocoaClientProtocolRange,
): number | null {
  const minimum = Math.max(client.minimum, server.minimum);
  const maximum = Math.min(client.maximum, server.maximum);
  return minimum <= maximum ? maximum : null;
}

export { requireCocoaCapability, supportsCocoaCapability } from "./capabilities.ts";
export { connect } from "./client.ts";
export {
  CocoaClientCapabilityError,
  CocoaClientError,
  CocoaClientHttpError,
  CocoaClientProtocolError,
  CocoaClientRequestError,
} from "./errors.ts";
export { DEFAULT_COCOA_CLIENT_SCOPES } from "./http.ts";
export { COCOA_CLIENT_UNARY_METHODS } from "./public-types.ts";
export type {
  CocoaClient,
  CocoaClientConnectOptions,
  CocoaClientConnectionState,
  CocoaClientConnectionStatus,
  CocoaClientFetch,
  CocoaClientRecovery,
  CocoaClientRecoveryUpdate,
  CocoaClientScope,
  CocoaClientUnaryMethod,
  CocoaClientUnaryMethodMap,
  DisposableAsyncIterable,
} from "./public-types.ts";
