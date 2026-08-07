import type {
  CocoaClientProtocolRange,
  CocoaClientV1Capabilities,
  CocoaClientV1CapabilityId,
  CocoaClientV1Command,
  CocoaClientV1DispatchResult,
  CocoaClientV1ExecuteCommandInput,
  CocoaClientV1ExecuteCommandResult,
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

export type CocoaClientConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "closed";

export interface CocoaClientConnectionState {
  readonly status: CocoaClientConnectionStatus;
  readonly attempt: number;
  readonly error?: unknown;
}

export interface CocoaClientConnectOptions {
  readonly baseUrl: string;
  readonly WebSocket?: typeof globalThis.WebSocket;
  readonly protocolRange?: CocoaClientProtocolRange;
  readonly onConnectionStateChange?: (state: CocoaClientConnectionState) => void;
}

export interface DisposableAsyncIterable<T> extends AsyncIterable<T>, AsyncDisposable {
  readonly closed: boolean;
  close(): Promise<void>;
  reconnect(): Promise<void>;
}

export type CocoaClientRecoveryUpdate<Snapshot, Item> =
  | { readonly kind: "reset"; readonly snapshot: Snapshot }
  | { readonly kind: "item"; readonly item: Item };

export interface CocoaClientRecovery<Snapshot, Item> extends DisposableAsyncIterable<
  CocoaClientRecoveryUpdate<Snapshot, Item>
> {
  readonly snapshot: Snapshot;
  readonly cursor: number;
}

export const COCOA_CLIENT_UNARY_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  executeCommand: "workspace.executeCommand",
  getShellSnapshot: "orchestration.getShellSnapshot",
  getThreadSnapshot: "orchestration.getThreadSnapshot",
  searchThreads: "orchestration.searchThreads",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  info: "client.info",
  probe: "client.probe",
} as const;

export interface CocoaClientUnaryMethodMap {
  "client.info": {
    readonly input: { readonly protocolRange: CocoaClientProtocolRange };
    readonly output: CocoaClientV1InfoResponse;
  };
  "client.probe": { readonly input: {}; readonly output: CocoaClientV1ProbeResult };
  "orchestration.dispatchCommand": {
    readonly input: CocoaClientV1Command;
    readonly output: CocoaClientV1DispatchResult;
  };
  "workspace.executeCommand": {
    readonly input: CocoaClientV1ExecuteCommandInput;
    readonly output: CocoaClientV1ExecuteCommandResult;
  };
  "orchestration.getShellSnapshot": {
    readonly input: CocoaClientV1GetShellSnapshotInput;
    readonly output: CocoaClientV1ShellSnapshot;
  };
  "orchestration.getThreadSnapshot": {
    readonly input: CocoaClientV1GetThreadSnapshotInput;
    readonly output: CocoaClientV1ThreadDetailSnapshot;
  };
  "orchestration.searchThreads": {
    readonly input: CocoaClientV1SearchThreadsInput;
    readonly output: CocoaClientV1SearchThreadsResult;
  };
  "orchestration.getTurnDiff": {
    readonly input: CocoaClientV1GetTurnDiffInput;
    readonly output: CocoaClientV1GetTurnDiffResult;
  };
  "orchestration.getFullThreadDiff": {
    readonly input: CocoaClientV1GetFullThreadDiffInput;
    readonly output: CocoaClientV1GetFullThreadDiffResult;
  };
}

export type CocoaClientUnaryMethod = keyof CocoaClientUnaryMethodMap;

export interface CocoaClient {
  readonly info: CocoaClientV1InfoResponse;
  readonly state: CocoaClientConnectionState;
  readonly capabilities: CocoaClientV1Capabilities;
  request<Method extends CocoaClientUnaryMethod>(
    method: Method,
    input: CocoaClientUnaryMethodMap[Method]["input"],
  ): Promise<CocoaClientUnaryMethodMap[Method]["output"]>;
  probe(): Promise<CocoaClientV1ProbeResult>;
  dispatchCommand(command: CocoaClientV1Command): Promise<CocoaClientV1DispatchResult>;
  executeCommand(
    input: CocoaClientV1ExecuteCommandInput,
  ): Promise<CocoaClientV1ExecuteCommandResult>;
  getShellSnapshot(input?: CocoaClientV1GetShellSnapshotInput): Promise<CocoaClientV1ShellSnapshot>;
  getThreadSnapshot(
    input: CocoaClientV1GetThreadSnapshotInput,
  ): Promise<CocoaClientV1ThreadDetailSnapshot>;
  searchThreads(input: CocoaClientV1SearchThreadsInput): Promise<CocoaClientV1SearchThreadsResult>;
  getTurnDiff(input: CocoaClientV1GetTurnDiffInput): Promise<CocoaClientV1GetTurnDiffResult>;
  getFullThreadDiff(
    input: CocoaClientV1GetFullThreadDiffInput,
  ): Promise<CocoaClientV1GetFullThreadDiffResult>;
  subscribeShell(
    input?: CocoaClientV1SubscribeShellInput,
  ): DisposableAsyncIterable<CocoaClientV1ShellStreamItem>;
  subscribeThread(
    input: CocoaClientV1SubscribeThreadInput,
  ): DisposableAsyncIterable<CocoaClientV1ThreadStreamItem>;
  recoverShell(): Promise<
    CocoaClientRecovery<CocoaClientV1ShellSnapshot, CocoaClientV1ShellStreamItem>
  >;
  recoverThread(
    input: CocoaClientV1GetThreadSnapshotInput,
  ): Promise<CocoaClientRecovery<CocoaClientV1ThreadDetailSnapshot, CocoaClientV1ThreadStreamItem>>;
  supportsCapability(capability: CocoaClientV1CapabilityId): boolean;
  requireCapability(capability: CocoaClientV1CapabilityId): void;
  close(): Promise<void>;
}
