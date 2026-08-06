declare module "ws-rfc6455" {
  import type * as NodeStream from "node:stream";

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
    on(event: "drain", listener: () => void): this;
    off(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
    off(event: "ping" | "pong", listener: (data: Buffer) => void): this;
    off(event: "conclude", listener: (code: number, reason: Buffer) => void): this;
    off(event: "error", listener: (error: Error) => void): this;
    off(event: "drain", listener: () => void): this;
  }

  export interface SenderOptions {
    readonly binary: boolean;
    readonly compress: boolean;
    readonly fin: boolean;
    readonly mask: boolean;
  }

  export class Sender {
    constructor(
      socket: NodeStream.Duplex,
      extensions?: Readonly<Record<string, unknown>>,
      generateMask?: (mask: Buffer) => void,
    );
    send(
      data: string | Uint8Array,
      options: SenderOptions,
      callback: (error?: Error) => void,
    ): void;
    pong(data: string | Uint8Array, mask: boolean, callback: (error?: Error) => void): void;
    close(
      code: number | undefined,
      reason: string | Uint8Array | undefined,
      mask: boolean,
      callback: (error?: Error) => void,
    ): void;
  }
}
