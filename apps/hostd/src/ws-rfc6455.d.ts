declare module "ws-rfc6455" {
  import type * as NodeStream from "node:stream";
  import WebSocket = require("ws");

  const DefaultWebSocket: typeof WebSocket;
  export default DefaultWebSocket;

  export interface ReceiverOptions {
    readonly allowSynchronousEvents?: boolean;
    readonly binaryType?: "nodebuffer" | "arraybuffer" | "blob" | "fragments";
    readonly extensions?: Readonly<Record<string, unknown>>;
    readonly isServer?: boolean;
    readonly maxBufferedChunks?: number;
    readonly maxFragments?: number;
    readonly maxPayload?: number;
    readonly skipUTF8Validation?: boolean;
  }

  export class Receiver extends NodeStream.Writable {
    constructor(options?: ReceiverOptions);
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: "ping" | "pong", listener: (data: Buffer) => void): this;
    on(event: "conclude", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
}
