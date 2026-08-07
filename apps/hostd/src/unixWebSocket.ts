// @effect-diagnostics nodeBuiltinImport:off - The lightweight standalone transport uses native crypto and event primitives without an Effect runtime.

import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";

import { Receiver } from "ws-rfc6455";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const MAX_HANDSHAKE_BYTES = 32 * 1024;
const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_OUTBOUND_BUFFER_BYTES = 4 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_SECONDS = 10;
const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface UpstreamSocket {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
  readonly readyState: number;
  send(data: string | Buffer, options: { readonly binary: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
  once(event: "open", listener: () => void): this;
  once(event: "close", listener: (code: number, reason: Buffer) => void): this;
  once(event: "error", listener: (cause: Error) => void): this;
}

const parseHeaders = (headerBlock: string): Map<string, string> => {
  const lines = headerBlock.split("\r\n");
  const status = lines.shift();
  if (status === undefined || !/^HTTP\/1\.[01] 101(?: |$)/u.test(status)) {
    throw new Error(
      `Codex app-server rejected the WebSocket upgrade: ${status ?? "empty response"}`,
    );
  }

  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, value);
  }
  return headers;
};

const makeClientFrame = (opcode: number, payload: Buffer): Buffer => {
  const extendedLengthBytes = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const headerBytes = 2 + extendedLengthBytes + 4;
  const frame = Buffer.allocUnsafe(headerBytes + payload.byteLength);
  frame[0] = 0x80 | opcode;
  if (extendedLengthBytes === 0) {
    frame[1] = 0x80 | payload.byteLength;
  } else if (extendedLengthBytes === 2) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.byteLength, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }

  const maskOffset = 2 + extendedLengthBytes;
  const mask = NodeCrypto.randomBytes(4);
  mask.copy(frame, maskOffset);
  for (let index = 0; index < payload.byteLength; index += 1) {
    frame[headerBytes + index] = payload[index]! ^ mask[index % 4]!;
  }
  return frame;
};

const makeClosePayload = (code: number | undefined, reason: string | Buffer): Buffer => {
  if (code === undefined) return Buffer.alloc(0);
  const reasonBytes = typeof reason === "string" ? Buffer.from(reason) : reason;
  const payload = Buffer.allocUnsafe(2 + reasonBytes.byteLength);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
};

class UnixWebSocket extends NodeEvents.EventEmitter implements UpstreamSocket {
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  readyState = CONNECTING;
  private socket: Bun.Socket<UnixWebSocket> | undefined;
  private readonly handshakeKey = NodeCrypto.randomBytes(16).toString("base64");
  private handshakeBuffer = Buffer.alloc(0);
  private receiver: Receiver | undefined;
  private outbound: Buffer | undefined;
  private endAfterFlush = false;
  private closeCode = 1006;
  private closeReason: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closeEmitted = false;
  private errorEmitted = false;

  constructor(socketPath: string) {
    super();
    void Bun.connect<UnixWebSocket>({
      unix: socketPath,
      data: this,
      socket: {
        binaryType: "buffer",
        open: (socket) => socket.data.handleOpen(socket),
        data: (socket, data) => socket.data.handleData(data),
        drain: (socket) => socket.data.flushOutbound(),
        timeout: (socket) =>
          socket.data.fail(new Error("Codex app-server WebSocket handshake timed out")),
        error: (socket, cause) => socket.data.fail(cause),
        connectError: (socket, cause) => socket.data.fail(cause),
        close: (socket, cause) => {
          if (cause !== undefined) socket.data.emitErrorOnce(cause);
          socket.data.emitClose();
        },
      },
    }).catch(() => {
      // connectError reports the failure through the relay's error listener.
    });
  }

  send(data: string | Buffer, options: { readonly binary: boolean }): void {
    if (this.readyState !== OPEN) throw new Error("Codex app-server WebSocket is not open");
    const payload = typeof data === "string" ? Buffer.from(data) : data;
    this.writeFrame(options.binary ? 0x2 : 0x1, payload);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.closeCode = code;
    this.closeReason = Buffer.from(reason);
    if (this.readyState === CONNECTING) {
      this.terminate();
      return;
    }
    this.readyState = CLOSING;
    this.endAfterFlush = true;
    this.writeFrame(0x8, makeClosePayload(code, reason));
    this.flushOutbound();
  }

  terminate(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    this.socket?.terminate();
  }

  private handleOpen(socket: Bun.Socket<UnixWebSocket>): void {
    this.socket = socket;
    socket.timeout(HANDSHAKE_TIMEOUT_SECONDS);
    this.writeRaw(
      Buffer.from(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${this.handshakeKey}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      ),
    );
  }

  private handleData(chunk: Buffer): void {
    if (this.receiver !== undefined) {
      this.receiver.write(chunk);
      return;
    }

    this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
    if (this.handshakeBuffer.byteLength > MAX_HANDSHAKE_BYTES) {
      this.fail(new Error("Codex app-server WebSocket handshake exceeded the size limit"));
      return;
    }

    const headerEnd = this.handshakeBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const headerBlock = this.handshakeBuffer.subarray(0, headerEnd).toString("latin1");
    const remainder = this.handshakeBuffer.subarray(headerEnd + 4);
    this.handshakeBuffer = Buffer.alloc(0);

    try {
      const headers = parseHeaders(headerBlock);
      const expectedAccept = NodeCrypto.createHash("sha1")
        .update(`${this.handshakeKey}${ACCEPT_GUID}`, "ascii")
        .digest("base64");
      if (headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new Error("Codex app-server WebSocket upgrade header is missing");
      }
      if (
        !headers
          .get("connection")
          ?.toLowerCase()
          .split(/\s*,\s*/u)
          .includes("upgrade")
      ) {
        throw new Error("Codex app-server WebSocket connection header is invalid");
      }
      if (headers.get("sec-websocket-accept") !== expectedAccept) {
        throw new Error("Codex app-server WebSocket accept key is invalid");
      }
    } catch (cause) {
      this.fail(cause instanceof Error ? cause : new Error("Invalid WebSocket handshake"));
      return;
    }

    this.socket?.timeout(0);
    this.receiver = new Receiver({
      isServer: false,
      maxPayload: MAX_FRAME_PAYLOAD_BYTES,
      skipUTF8Validation: false,
    });
    this.receiver.on("message", (data, isBinary) => this.emit("message", data, isBinary));
    this.receiver.on("ping", (data) => this.writeFrame(0xa, data));
    this.receiver.on("conclude", (code, reason) => {
      this.closeCode = code;
      this.closeReason = reason;
      if (this.readyState === OPEN) {
        this.readyState = CLOSING;
        this.endAfterFlush = true;
        this.writeFrame(0x8, makeClosePayload(code === 1005 ? undefined : code, reason));
        this.flushOutbound();
      }
    });
    this.receiver.on("error", (cause) => this.fail(cause));

    this.readyState = OPEN;
    this.emit("open");
    if (remainder.byteLength > 0) this.receiver.write(remainder);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (payload.byteLength + 14 > MAX_OUTBOUND_BUFFER_BYTES) {
      this.fail(new Error("Codex app-server WebSocket outbound buffer limit exceeded"));
      return;
    }
    this.writeRaw(makeClientFrame(opcode, payload));
  }

  private writeRaw(data: Buffer): void {
    const pendingBytes = this.outbound?.byteLength ?? 0;
    if (pendingBytes + data.byteLength > MAX_OUTBOUND_BUFFER_BYTES) {
      this.fail(new Error("Codex app-server WebSocket outbound buffer limit exceeded"));
      return;
    }
    this.outbound = this.outbound === undefined ? data : Buffer.concat([this.outbound, data]);
    this.flushOutbound();
  }

  private flushOutbound(): void {
    const socket = this.socket;
    const outbound = this.outbound;
    if (socket === undefined || outbound === undefined) return;
    const written = socket.write(outbound);
    if (written < 0) {
      this.fail(new Error("Codex app-server Unix socket closed while writing"));
      return;
    }
    this.outbound = written >= outbound.byteLength ? undefined : outbound.subarray(written);
    if (this.outbound === undefined && this.endAfterFlush) socket.end();
  }

  private fail(cause: Error): void {
    this.emitErrorOnce(cause);
    this.terminate();
  }

  private emitErrorOnce(cause: Error): void {
    if (this.errorEmitted) return;
    this.errorEmitted = true;
    this.emit("error", cause);
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = CLOSED;
    this.emit("close", this.closeCode, this.closeReason);
  }
}

export const connectUnixWebSocket = (socketPath: string): UpstreamSocket =>
  new UnixWebSocket(socketPath);
