/// <reference types="bun" />

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BunPtyAdapter as HostBunPtyAdapter,
  type PtyExitEvent,
  type PtyProcess as BytePtyProcess,
} from "@t3tools/host-runtime/pty";

import * as PtyAdapter from "./PtyAdapter.ts";

export const BunPtyOperationUnavailableError = HostBunPtyAdapter.BunPtyOperationUnavailableError;
export const BunPtyUnsupportedPlatformError = HostBunPtyAdapter.BunPtyUnsupportedPlatformError;

/**
 * Upstream's terminal manager consumes strings. The host control protocol
 * deliberately transports raw bytes, so host-runtime owns the Bun process and
 * this compatibility adapter performs only the UTF-8 boundary conversion.
 */
class Utf8PtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: BytePtyProcess;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly pendingData: string[] = [];
  private exitEvent: PtyExitEvent | undefined;

  constructor(process: BytePtyProcess) {
    this.process = process;
    process.onData((data) => {
      const text = this.decoder.decode(data, { stream: true });
      if (text.length === 0) return;
      if (this.dataListeners.size === 0) this.pendingData.push(text);
      else for (const listener of this.dataListeners) listener(text);
    });
    process.onExit((event) => {
      const remainder = this.decoder.decode();
      if (remainder.length > 0) {
        if (this.dataListeners.size === 0) this.pendingData.push(remainder);
        else for (const listener of this.dataListeners) listener(remainder);
      }
      this.exitEvent = event;
      for (const listener of this.exitListeners) listener(event);
    });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(this.encoder.encode(data));
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    for (const data of this.pendingData.splice(0)) callback(data);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    if (this.exitEvent !== undefined) {
      callback(this.exitEvent);
      return () => undefined;
    }
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
}

export const make = Effect.fn("BunPtyAdapter.make")(function* () {
  const adapter = yield* HostBunPtyAdapter.make();
  return PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      adapter.spawn(input).pipe(Effect.map((process) => new Utf8PtyProcess(process))),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
