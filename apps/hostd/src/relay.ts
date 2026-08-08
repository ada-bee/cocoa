// @effect-diagnostics globalConsole:off - The standalone host daemon logs directly to its service output stream.
// @effect-diagnostics nodeBuiltinImport:off - Control metadata reflects the native host and configured Unix socket.

import {
  COCOA_HOST_CONTROL_PROTOCOL,
  COCOA_HOST_CONTROL_PROTOCOL_VERSION,
  COCOA_HOST_CONTROL_SUPPORTED_VERSIONS,
  CocoaHostControlHandshakeRequest,
  CocoaHostControlOperation,
  CocoaHostControlRequest,
  CocoaHostControlRequestId,
  CocoaHostControlResourceId,
  type CocoaHostControlErrorResponse,
  type CocoaHostControlEvent,
  type CocoaHostControlCapability,
  type CocoaHostControlHandshakeRequest as CocoaHostControlHandshakeRequestType,
  type CocoaHostControlHandshakeErrorResponse,
  type CocoaHostControlHandshakeResponse,
  type CocoaHostControlOperation as CocoaHostControlOperationType,
  type CocoaHostControlProtocolVersion,
  type CocoaHostControlRequest as CocoaHostControlRequestType,
  type CocoaHostControlRequestId as CocoaHostControlRequestIdType,
  type CocoaHostControlResponse,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";

import { makeHostControlRuntime, type HostControlRuntime } from "./control/runtime.ts";
import type { UpstreamSocket } from "./unixWebSocket.ts";
import { connectUnixWebSocket } from "./unixWebSocket.ts";

import packageJson from "../package.json" with { type: "json" };

const MAX_PENDING_MESSAGES = 256;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_DOWNSTREAM_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const MAX_CONTROL_FRAME_BYTES = MAX_DOWNSTREAM_BACKPRESSURE_BYTES - 1024;
const CONTROL_ROUTE = "/control/v1";
const PROVIDER_RELAY_ROUTE = "/";

type DownstreamMessage = string | Buffer;

interface PendingMessage {
  readonly data: DownstreamMessage;
  readonly byteLength: number;
}

interface RelayConnectionData {
  readonly mode: "relay";
  readonly socketPath: string;
  upstream: UpstreamSocket | undefined;
  pending: Array<PendingMessage>;
  pendingBytes: number;
  closing: boolean;
}

interface ControlConnectionData {
  readonly mode: "control";
  handshakeComplete: boolean;
  protocolVersion: CocoaHostControlProtocolVersion | undefined;
  requestQueue: Promise<void>;
  unsubscribeRuntime: (() => void) | undefined;
  closing: boolean;
}

type HostdConnectionData = RelayConnectionData | ControlConnectionData;

export interface HostdLogger {
  readonly info: (message: string) => void;
  readonly error: (message: string, cause?: unknown) => void;
}

export interface StartHostdOptions {
  readonly installationId?: string;
  readonly bindHost: string;
  readonly port: number;
  readonly socketPath: string;
  readonly key: string;
  readonly logger?: HostdLogger;
  readonly makeUpstream?: (socketPath: string) => UpstreamSocket;
  readonly controlRuntime?: HostControlRuntime;
}

export interface RunningHostd {
  readonly hostname: string;
  readonly port: number;
  readonly stop: () => Promise<void>;
}

const defaultLogger: HostdLogger = {
  info: (message) => console.log(message),
  error: (message, cause) => console.error(message, cause),
};

export const hasBearerKey = (request: Request, expectedKey: string): boolean => {
  const actual = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${expectedKey}`;
  const actualDigest = NodeCrypto.createHash("sha256").update(actual).digest();
  const expectedDigest = NodeCrypto.createHash("sha256").update(expected).digest();
  return NodeCrypto.timingSafeEqual(actualDigest, expectedDigest);
};

export const connectToCodexUnixSocket = (socketPath: string): UpstreamSocket =>
  connectUnixWebSocket(socketPath);

const byteLength = (message: DownstreamMessage): number =>
  typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;

const normalizeDownstreamMessage = (message: string | Buffer): DownstreamMessage =>
  typeof message === "string" ? message : Buffer.from(message);

const normalizeUpstreamMessage = (data: Buffer, isBinary: boolean): string | Buffer => {
  if (!isBinary) return data.toString();
  return Buffer.from(data);
};

const isSendableCloseCode = (code: number): boolean =>
  (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
  (code >= 3000 && code <= 4999);

const closeDownstream = (
  downstream: Bun.ServerWebSocket<HostdConnectionData>,
  code: number,
  reason: string,
): void => {
  if (downstream.data.closing) return;
  downstream.data.closing = true;
  try {
    downstream.close(code, reason);
  } catch {
    // The peer may already be gone.
  }
};

const closeUpstream = (data: RelayConnectionData): void => {
  const upstream = data.upstream;
  data.upstream = undefined;
  if (upstream === undefined) return;
  if (upstream.readyState === upstream.CONNECTING) {
    upstream.terminate();
    return;
  }
  if (upstream.readyState === upstream.OPEN) {
    upstream.close(1000);
  }
};

const decodeHandshake = Schema.decodeUnknownSync(CocoaHostControlHandshakeRequest);
const decodeControlRequest = Schema.decodeUnknownSync(CocoaHostControlRequest);
const decodeControlOperation = Schema.decodeUnknownSync(CocoaHostControlOperation);

const requestIdFromUnknown = (value: unknown): CocoaHostControlRequestIdType => {
  if (typeof value !== "object" || value === null) {
    return CocoaHostControlRequestId.make("handshake-error");
  }
  const requestId = Reflect.get(value, "requestId");
  return typeof requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)
    ? CocoaHostControlRequestId.make(requestId)
    : CocoaHostControlRequestId.make("handshake-error");
};

const sendControlFrame = (
  downstream: Bun.ServerWebSocket<HostdConnectionData>,
  frame:
    | CocoaHostControlHandshakeResponse
    | CocoaHostControlHandshakeErrorResponse
    | CocoaHostControlResponse
    | CocoaHostControlEvent,
): boolean => {
  if (downstream.data.closing) return false;
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONTROL_FRAME_BYTES) {
    closeDownstream(downstream, 1009, "Control frame limit exceeded");
    return false;
  }
  const sent = downstream.send(encoded);
  if (sent < 0) {
    closeDownstream(downstream, 1011, "Control connection backpressure exceeded");
    return false;
  }
  return true;
};

const providerRelayAvailable = (socketPath: string): boolean => {
  try {
    return NodeFS.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
};

const capabilitiesForVersion = (
  capabilities: ReadonlyArray<CocoaHostControlCapability>,
  selectedVersion: CocoaHostControlProtocolVersion,
): ReadonlyArray<CocoaHostControlCapability> => {
  const selectedCapabilities: Array<CocoaHostControlCapability> = [];
  for (const capability of capabilities) {
    if (capability.kind === "usage") {
      if (selectedVersion === COCOA_HOST_CONTROL_PROTOCOL_VERSION) {
        selectedCapabilities.push(capability);
      }
      continue;
    }
    selectedCapabilities.push({ ...capability, version: selectedVersion });
  }
  return selectedCapabilities;
};

const controlHandshakeResponse = (
  request: CocoaHostControlHandshakeRequestType,
  socketPath: string,
  runtime: HostControlRuntime,
  selectedVersion: CocoaHostControlProtocolVersion,
): CocoaHostControlHandshakeResponse => ({
  protocol: COCOA_HOST_CONTROL_PROTOCOL,
  requestId: request.requestId,
  selectedVersion,
  host: {
    generationId: runtime.generationId,
    implementation: "cocoa-hostd",
    version: packageJson.version,
    platformFamily: runtime.platformFamily,
    platformOs: runtime.platformOs,
  },
  capabilities: [
    ...capabilitiesForVersion(runtime.capabilities, selectedVersion),
    {
      kind: "providerRelay",
      version: selectedVersion,
      providers: ["codex"],
      transport: "websocket-json-rpc",
    },
  ],
  providerRelays: [
    {
      relayId: CocoaHostControlResourceId.make("codex"),
      provider: "codex",
      route: PROVIDER_RELAY_ROUTE,
      transport: "websocket-json-rpc",
      status: providerRelayAvailable(socketPath) ? "available" : "unavailable",
      generationId: null,
    },
  ],
});

const handshakeError = (
  requestId: CocoaHostControlRequestIdType,
  code: "unsupportedProtocol" | "invalidRequest",
  message: string,
): CocoaHostControlHandshakeErrorResponse => ({
  protocol: COCOA_HOST_CONTROL_PROTOCOL,
  requestId,
  error: { code, message, retryable: false },
});

const operationFailure = (request: CocoaHostControlRequestType): CocoaHostControlErrorResponse => ({
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  operation: request.operation,
  error: {
    code: "operationFailed",
    message: `cocoa-hostd could not complete '${request.operation}'.`,
    retryable: false,
  },
});

const handleControlMessage = (
  downstream: Bun.ServerWebSocket<HostdConnectionData>,
  rawMessage: string | Buffer,
  socketPath: string,
  runtime: HostControlRuntime,
  logger: HostdLogger,
): void => {
  const connection = downstream.data;
  if (connection.mode !== "control") return;

  if (typeof rawMessage !== "string") {
    closeDownstream(downstream, 1003, "Control protocol requires text JSON frames");
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(rawMessage) as unknown;
  } catch {
    sendControlFrame(
      downstream,
      handshakeError(
        CocoaHostControlRequestId.make("handshake-error"),
        "invalidRequest",
        "Control frame was not valid JSON.",
      ),
    );
    closeDownstream(downstream, 1002, "Invalid control JSON");
    return;
  }

  if (!connection.handshakeComplete) {
    let request: CocoaHostControlHandshakeRequestType;
    try {
      request = decodeHandshake(value);
    } catch {
      sendControlFrame(
        downstream,
        handshakeError(
          requestIdFromUnknown(value),
          "invalidRequest",
          "The first control frame must be a valid handshake request.",
        ),
      );
      closeDownstream(downstream, 1002, "Control handshake required");
      return;
    }
    const selectedVersion = COCOA_HOST_CONTROL_SUPPORTED_VERSIONS.find((version) =>
      request.supportedVersions.includes(version),
    );
    if (selectedVersion === undefined) {
      sendControlFrame(
        downstream,
        handshakeError(
          request.requestId,
          "unsupportedProtocol",
          `cocoa-hostd supports control protocol versions ${COCOA_HOST_CONTROL_SUPPORTED_VERSIONS.join(", ")}.`,
        ),
      );
      return;
    }
    connection.handshakeComplete = true;
    connection.protocolVersion = selectedVersion;
    connection.unsubscribeRuntime = runtime.subscribe((event) => {
      if (!connection.closing && connection.handshakeComplete) {
        sendControlFrame(downstream, { ...event, protocolVersion: selectedVersion });
      }
    });
    sendControlFrame(
      downstream,
      controlHandshakeResponse(request, socketPath, runtime, selectedVersion),
    );
    return;
  }

  let request: CocoaHostControlRequestType;
  try {
    request = decodeControlRequest(value);
  } catch {
    // When request identity and operation are recoverable, return the typed
    // invalid-request envelope. Otherwise close rather than inventing routing data.
    const requestId = requestIdFromUnknown(value);
    let operation: CocoaHostControlOperationType;
    try {
      operation = decodeControlOperation(
        typeof value === "object" && value !== null ? Reflect.get(value, "operation") : undefined,
      );
    } catch {
      closeDownstream(downstream, 1002, "Invalid control request");
      return;
    }
    sendControlFrame(downstream, {
      protocolVersion: connection.protocolVersion ?? COCOA_HOST_CONTROL_PROTOCOL_VERSION,
      requestId,
      operation,
      error: {
        code: "invalidRequest",
        message: "The control request did not match its operation contract.",
        retryable: false,
      },
    });
    return;
  }

  if (request.protocolVersion !== connection.protocolVersion) {
    sendControlFrame(downstream, {
      protocolVersion: connection.protocolVersion ?? COCOA_HOST_CONTROL_PROTOCOL_VERSION,
      requestId: request.requestId,
      operation: request.operation,
      error: {
        code: "invalidRequest",
        message: "The control request protocol version did not match the negotiated version.",
        retryable: false,
      },
    });
    return;
  }

  connection.requestQueue = connection.requestQueue
    .then(async () => {
      const dispatched = await runtime.dispatch(request);
      if (connection.closing) return;
      for (const event of dispatched.replayEvents) {
        if (!sendControlFrame(downstream, event)) return;
      }
      sendControlFrame(downstream, dispatched.response);
    })
    .catch((cause: unknown) => {
      logger.error(`Host control operation '${request.operation}' failed`, cause);
      if (!connection.closing) sendControlFrame(downstream, operationFailure(request));
    });
};

export const startHostd = (options: StartHostdOptions): RunningHostd => {
  const logger = options.logger ?? defaultLogger;
  const makeUpstream = options.makeUpstream ?? connectToCodexUnixSocket;
  const controlRuntime =
    options.controlRuntime ??
    makeHostControlRuntime(
      options.installationId === undefined ? {} : { installationId: options.installationId },
    );

  const server = Bun.serve<HostdConnectionData>({
    hostname: options.bindHost,
    port: options.port,
    fetch(request, server) {
      if (!hasBearerKey(request, options.key)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        });
      }

      const path = new URL(request.url).pathname;
      if (path !== PROVIDER_RELAY_ROUTE && path !== CONTROL_ROUTE) {
        return new Response("Not found", { status: 404 });
      }

      const upgraded = server.upgrade(request, {
        data:
          path === CONTROL_ROUTE
            ? {
                mode: "control",
                handshakeComplete: false,
                protocolVersion: undefined,
                requestQueue: Promise.resolve(),
                unsubscribeRuntime: undefined,
                closing: false,
              }
            : {
                mode: "relay",
                socketPath: options.socketPath,
                upstream: undefined,
                pending: [],
                pendingBytes: 0,
                closing: false,
              },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      perMessageDeflate: false,
      maxPayloadLength: MAX_WEBSOCKET_PAYLOAD_BYTES,
      backpressureLimit: MAX_DOWNSTREAM_BACKPRESSURE_BYTES,
      closeOnBackpressureLimit: true,
      open(downstream) {
        const connection = downstream.data;
        if (connection.mode === "control") return;
        let upstream: UpstreamSocket;
        try {
          upstream = makeUpstream(connection.socketPath);
        } catch (cause) {
          logger.error("Failed to create Codex app-server connection", cause);
          closeDownstream(downstream, 1011, "Codex app-server unavailable");
          return;
        }
        connection.upstream = upstream;

        upstream.once("open", () => {
          if (connection.closing) {
            closeUpstream(connection);
            return;
          }
          for (const message of connection.pending) {
            upstream.send(message.data, { binary: typeof message.data !== "string" });
          }
          connection.pending = [];
          connection.pendingBytes = 0;
        });

        upstream.on("message", (data, isBinary) => {
          if (connection.closing) return;
          downstream.send(normalizeUpstreamMessage(data, isBinary), isBinary);
        });

        upstream.once("close", (code, reason) => {
          connection.upstream = undefined;
          const closeCode = isSendableCloseCode(code) ? code : 1011;
          closeDownstream(
            downstream,
            closeCode,
            reason.length === 0 ? "Codex app-server disconnected" : reason.toString(),
          );
        });

        upstream.once("error", (cause) => {
          logger.error(`Codex app-server connection failed at ${connection.socketPath}`, cause);
          closeDownstream(downstream, 1011, "Codex app-server unavailable");
        });
      },
      message(downstream, rawMessage) {
        if (downstream.data.mode === "control") {
          handleControlMessage(downstream, rawMessage, options.socketPath, controlRuntime, logger);
          return;
        }
        const message = normalizeDownstreamMessage(rawMessage);
        const upstream = downstream.data.upstream;
        if (upstream !== undefined && upstream.readyState === upstream.OPEN) {
          upstream.send(message, { binary: typeof message !== "string" });
          return;
        }

        const messageBytes = byteLength(message);
        if (
          downstream.data.pending.length >= MAX_PENDING_MESSAGES ||
          downstream.data.pendingBytes + messageBytes > MAX_PENDING_BYTES
        ) {
          closeUpstream(downstream.data);
          closeDownstream(downstream, 1009, "Pending message limit exceeded");
          return;
        }
        downstream.data.pending.push({ data: message, byteLength: messageBytes });
        downstream.data.pendingBytes += messageBytes;
      },
      close(downstream) {
        downstream.data.closing = true;
        if (downstream.data.mode === "control") {
          downstream.data.unsubscribeRuntime?.();
          downstream.data.unsubscribeRuntime = undefined;
          return;
        }
        downstream.data.pending = [];
        downstream.data.pendingBytes = 0;
        closeUpstream(downstream.data);
      },
    },
  });

  logger.info(`cocoa-hostd listening on ws://${server.hostname}:${server.port}/`);
  logger.info(`Relaying to Codex app-server at ${options.socketPath}`);

  return {
    hostname: server.hostname ?? options.bindHost,
    port: server.port ?? options.port,
    stop: async () => {
      await controlRuntime.close();
      await server.stop(true);
    },
  };
};
