import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { COCOA_CLIENT_V1_METHODS, CocoaClientV1RpcGroup } from "@t3tools/contracts/client/v1";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";

type CocoaClientV1RpcMethod = RpcGroup.Rpcs<typeof CocoaClientV1RpcGroup>["_tag"];

export const COCOA_CLIENT_V1_REQUIRED_SCOPES = {
  [COCOA_CLIENT_V1_METHODS.info]: AuthOrchestrationReadScope,
  [COCOA_CLIENT_V1_METHODS.probe]: AuthOrchestrationReadScope,
  [COCOA_CLIENT_V1_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [COCOA_CLIENT_V1_METHODS.executeCommand]: AuthTerminalOperateScope,
  [COCOA_CLIENT_V1_METHODS.getShellSnapshot]: AuthOrchestrationReadScope,
  [COCOA_CLIENT_V1_METHODS.getThreadSnapshot]: AuthOrchestrationReadScope,
  [COCOA_CLIENT_V1_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [COCOA_CLIENT_V1_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [COCOA_CLIENT_V1_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [COCOA_CLIENT_V1_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [COCOA_CLIENT_V1_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<CocoaClientV1RpcMethod, AuthEnvironmentScope>>;

export function requiredScopeForCocoaClientV1Method(
  method: CocoaClientV1RpcMethod,
): AuthEnvironmentScope {
  return COCOA_CLIENT_V1_REQUIRED_SCOPES[method];
}
