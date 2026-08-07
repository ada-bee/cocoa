// @effect-diagnostics globalConsole:off - The standalone host daemon logs directly to its service output stream.

import type { UpstreamSocket } from "./unixWebSocket.ts";
import { connectUnixWebSocket } from "./unixWebSocket.ts";

const MAX_PENDING_MESSAGES = 256;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_DOWNSTREAM_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

type DownstreamMessage = string | Buffer;

interface PendingMessage {
  readonly data: DownstreamMessage;
  readonly byteLength: number;
}

interface RelayConnectionData {
  readonly socketPath: string;
  upstream: UpstreamSocket | undefined;
  pending: Array<PendingMessage>;
  pendingBytes: number;
  closing: boolean;
}

export interface HostdLogger {
  readonly info: (message: string) => void;
  readonly error: (message: string, cause?: unknown) => void;
}

export interface StartHostdOptions {
  readonly bindHost: string;
  readonly port: number;
  readonly socketPath: string;
  readonly key: string;
  readonly logger?: HostdLogger;
  readonly makeUpstream?: (socketPath: string) => UpstreamSocket;
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

export const hasBearerKey = (request: Request, expectedKey: string): boolean =>
  request.headers.get("authorization") === `Bearer ${expectedKey}`;

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
  downstream: Bun.ServerWebSocket<RelayConnectionData>,
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

export const startHostd = (options: StartHostdOptions): RunningHostd => {
  const logger = options.logger ?? defaultLogger;
  const makeUpstream = options.makeUpstream ?? connectToCodexUnixSocket;

  const server = Bun.serve<RelayConnectionData>({
    hostname: options.bindHost,
    port: options.port,
    fetch(request, server) {
      if (!hasBearerKey(request, options.key)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        });
      }

      const upgraded = server.upgrade(request, {
        data: {
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
        let upstream: UpstreamSocket;
        try {
          upstream = makeUpstream(downstream.data.socketPath);
        } catch (cause) {
          logger.error("Failed to create Codex app-server connection", cause);
          closeDownstream(downstream, 1011, "Codex app-server unavailable");
          return;
        }
        downstream.data.upstream = upstream;

        upstream.once("open", () => {
          if (downstream.data.closing) {
            closeUpstream(downstream.data);
            return;
          }
          for (const message of downstream.data.pending) {
            upstream.send(message.data, { binary: typeof message.data !== "string" });
          }
          downstream.data.pending = [];
          downstream.data.pendingBytes = 0;
        });

        upstream.on("message", (data, isBinary) => {
          if (downstream.data.closing) return;
          downstream.send(normalizeUpstreamMessage(data, isBinary), isBinary);
        });

        upstream.once("close", (code, reason) => {
          downstream.data.upstream = undefined;
          const closeCode = isSendableCloseCode(code) ? code : 1011;
          closeDownstream(
            downstream,
            closeCode,
            reason.length === 0 ? "Codex app-server disconnected" : reason.toString(),
          );
        });

        upstream.once("error", (cause) => {
          logger.error(
            `Codex app-server connection failed at ${downstream.data.socketPath}`,
            cause,
          );
          closeDownstream(downstream, 1011, "Codex app-server unavailable");
        });
      },
      message(downstream, rawMessage) {
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
      await server.stop(true);
    },
  };
};
