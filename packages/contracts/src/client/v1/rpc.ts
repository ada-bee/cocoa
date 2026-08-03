import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { AuthEnvironmentScope } from "../../auth.ts";
import { TrimmedNonEmptyString } from "../../baseSchemas.ts";
import {
  CocoaClientProtocolVersionMismatch,
  CocoaClientV1InfoRequest,
  CocoaClientV1InfoResponse,
  CocoaClientV1ProbeResult,
} from "./capabilities.ts";
import {
  CocoaClientV1Command,
  CocoaClientV1DispatchResult,
  CocoaClientV1GetFullThreadDiffInput,
  CocoaClientV1GetFullThreadDiffResult,
  CocoaClientV1GetShellSnapshotInput,
  CocoaClientV1GetThreadSnapshotInput,
  CocoaClientV1GetTurnDiffInput,
  CocoaClientV1GetTurnDiffResult,
  CocoaClientV1SearchThreadsInput,
  CocoaClientV1SearchThreadsResult,
  CocoaClientV1ShellSnapshot,
  CocoaClientV1ShellStreamItem,
  CocoaClientV1SubscribeShellInput,
  CocoaClientV1SubscribeThreadInput,
  CocoaClientV1ThreadDetailSnapshot,
  CocoaClientV1ThreadStreamItem,
} from "./orchestration.ts";

export const COCOA_CLIENT_V1_METHODS = {
  info: "client.info",
  probe: "client.probe",
  dispatchCommand: "orchestration.dispatchCommand",
  getShellSnapshot: "orchestration.getShellSnapshot",
  getThreadSnapshot: "orchestration.getThreadSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  searchThreads: "orchestration.searchThreads",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
} as const;

export type CocoaClientV1Method =
  (typeof COCOA_CLIENT_V1_METHODS)[keyof typeof COCOA_CLIENT_V1_METHODS];

export const COCOA_CLIENT_V1_SUPPORTED_METHODS = [
  COCOA_CLIENT_V1_METHODS.info,
  COCOA_CLIENT_V1_METHODS.probe,
  COCOA_CLIENT_V1_METHODS.dispatchCommand,
  COCOA_CLIENT_V1_METHODS.getShellSnapshot,
  COCOA_CLIENT_V1_METHODS.getThreadSnapshot,
  COCOA_CLIENT_V1_METHODS.subscribeShell,
  COCOA_CLIENT_V1_METHODS.subscribeThread,
  COCOA_CLIENT_V1_METHODS.searchThreads,
  COCOA_CLIENT_V1_METHODS.getTurnDiff,
  COCOA_CLIENT_V1_METHODS.getFullThreadDiff,
] as const satisfies ReadonlyArray<CocoaClientV1Method>;

export const CocoaClientV1RequestError = Schema.Struct({
  code: Schema.Literals([
    "invalid_request",
    "auth_invalid",
    "insufficient_scope",
    "not_found",
    "internal_error",
  ]),
  message: TrimmedNonEmptyString,
  requiredScope: Schema.optionalKey(AuthEnvironmentScope),
  traceId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CocoaClientV1RequestError = typeof CocoaClientV1RequestError.Type;

export const CocoaClientV1InfoRpc = Rpc.make(COCOA_CLIENT_V1_METHODS.info, {
  payload: CocoaClientV1InfoRequest,
  success: CocoaClientV1InfoResponse,
  error: Schema.Union([CocoaClientProtocolVersionMismatch, CocoaClientV1RequestError]),
});

export const CocoaClientV1ProbeRpc = Rpc.make(COCOA_CLIENT_V1_METHODS.probe, {
  payload: Schema.Struct({}),
  success: CocoaClientV1ProbeResult,
  error: CocoaClientV1RequestError,
});

export const CocoaClientV1DispatchCommandRpc = Rpc.make(COCOA_CLIENT_V1_METHODS.dispatchCommand, {
  payload: CocoaClientV1Command,
  success: CocoaClientV1DispatchResult,
  error: CocoaClientV1RequestError,
});

export const CocoaClientV1GetShellSnapshotRpc = Rpc.make(COCOA_CLIENT_V1_METHODS.getShellSnapshot, {
  payload: CocoaClientV1GetShellSnapshotInput,
  success: CocoaClientV1ShellSnapshot,
  error: CocoaClientV1RequestError,
});

export const CocoaClientV1GetThreadSnapshotRpc = Rpc.make(
  COCOA_CLIENT_V1_METHODS.getThreadSnapshot,
  {
    payload: CocoaClientV1GetThreadSnapshotInput,
    success: CocoaClientV1ThreadDetailSnapshot,
    error: CocoaClientV1RequestError,
  },
);

export const CocoaClientV1SubscribeShellRpc = Rpc.make(COCOA_CLIENT_V1_METHODS.subscribeShell, {
  payload: CocoaClientV1SubscribeShellInput,
  success: CocoaClientV1ShellStreamItem,
  error: CocoaClientV1RequestError,
  stream: true,
});

export const CocoaClientV1SubscribeThreadRpc = Rpc.make(COCOA_CLIENT_V1_METHODS.subscribeThread, {
  payload: CocoaClientV1SubscribeThreadInput,
  success: CocoaClientV1ThreadStreamItem,
  error: CocoaClientV1RequestError,
  stream: true,
});

export const CocoaClientV1SearchThreadsRpc = Rpc.make(COCOA_CLIENT_V1_METHODS.searchThreads, {
  payload: CocoaClientV1SearchThreadsInput,
  success: CocoaClientV1SearchThreadsResult,
  error: CocoaClientV1RequestError,
});

export const CocoaClientV1GetTurnDiffRpc = Rpc.make(COCOA_CLIENT_V1_METHODS.getTurnDiff, {
  payload: CocoaClientV1GetTurnDiffInput,
  success: CocoaClientV1GetTurnDiffResult,
  error: CocoaClientV1RequestError,
});

export const CocoaClientV1GetFullThreadDiffRpc = Rpc.make(
  COCOA_CLIENT_V1_METHODS.getFullThreadDiff,
  {
    payload: CocoaClientV1GetFullThreadDiffInput,
    success: CocoaClientV1GetFullThreadDiffResult,
    error: CocoaClientV1RequestError,
  },
);

export const CocoaClientV1RpcGroup = RpcGroup.make(
  CocoaClientV1InfoRpc,
  CocoaClientV1ProbeRpc,
  CocoaClientV1DispatchCommandRpc,
  CocoaClientV1GetShellSnapshotRpc,
  CocoaClientV1GetThreadSnapshotRpc,
  CocoaClientV1SubscribeShellRpc,
  CocoaClientV1SubscribeThreadRpc,
  CocoaClientV1SearchThreadsRpc,
  CocoaClientV1GetTurnDiffRpc,
  CocoaClientV1GetFullThreadDiffRpc,
);
