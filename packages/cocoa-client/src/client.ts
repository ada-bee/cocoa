import {
  COCOA_CLIENT_V1_PROTOCOL_RANGE,
  type CocoaClientV1InfoResponse,
} from "@t3tools/contracts/client/v1";

import { requireCocoaCapability, supportsCocoaCapability } from "./capabilities.ts";
import { CocoaClientError } from "./errors.ts";
import { createCocoaClientHttpSession } from "./http.ts";
import type { CocoaClient, CocoaClientConnectOptions } from "./public-types.ts";
import { recoverShell, recoverThread } from "./recovery.ts";
import { subscribeToShell, subscribeToThread } from "./subscription.ts";
import { createCocoaClientTransport, type CocoaClientTransport } from "./transport.ts";

export async function connectWithTransport(
  transport: CocoaClientTransport,
  options: Pick<CocoaClientConnectOptions, "protocolRange"> = {},
): Promise<CocoaClient> {
  let info: CocoaClientV1InfoResponse;
  try {
    info = await transport.request("client.info", {
      protocolRange: options.protocolRange ?? COCOA_CLIENT_V1_PROTOCOL_RANGE,
    });
  } catch (error) {
    await transport.close();
    throw error;
  }

  return {
    info,
    get state() {
      return transport.state;
    },
    get capabilities() {
      return info.capabilities;
    },
    request: (method, input) => transport.request(method, input),
    probe: () => transport.request("client.probe", {}),
    dispatchCommand: (command) => transport.request("orchestration.dispatchCommand", command),
    executeCommand: (input) => transport.request("workspace.executeCommand", input),
    getShellSnapshot: (input = {}) => transport.request("orchestration.getShellSnapshot", input),
    getThreadSnapshot: (input) => transport.request("orchestration.getThreadSnapshot", input),
    searchThreads: (input) => transport.request("orchestration.searchThreads", input),
    getTurnDiff: (input) => transport.request("orchestration.getTurnDiff", input),
    getFullThreadDiff: (input) => transport.request("orchestration.getFullThreadDiff", input),
    subscribeShell: (input = {}) => subscribeToShell(transport, input),
    subscribeThread: (input) => subscribeToThread(transport, input),
    recoverShell: () => recoverShell(transport),
    recoverThread: (input) => recoverThread(transport, input),
    supportsCapability: (capability) => supportsCocoaCapability(info.capabilities, capability),
    requireCapability: (capability) => requireCocoaCapability(info.capabilities, capability),
    close: () => transport.close(),
  };
}

export async function connect(options: CocoaClientConnectOptions): Promise<CocoaClient> {
  const http = await createCocoaClientHttpSession(options);
  const WebSocketImplementation = options.WebSocket ?? globalThis.WebSocket;
  if (typeof WebSocketImplementation !== "function") {
    throw new CocoaClientError(
      "configuration",
      "No WebSocket implementation is available. Pass connect({ WebSocket }).",
    );
  }
  const transport = createCocoaClientTransport({
    issueWebSocketUrl: http.issueWebSocketUrl,
    WebSocket: WebSocketImplementation,
    ...(options.onConnectionStateChange === undefined
      ? {}
      : { onConnectionStateChange: options.onConnectionStateChange }),
  });
  return connectWithTransport(transport, options);
}
