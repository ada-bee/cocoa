/// <reference types="bun" />

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PtyAdapter from "./PtyAdapter.ts";

export class BunPtyUnsupportedPlatformError extends Schema.TaggedErrorClass<BunPtyUnsupportedPlatformError>()(
  "BunPtyUnsupportedPlatformError",
  { platform: Schema.Literal("win32") },
) {
  override get message(): string {
    return `Bun PTY terminal support is unavailable on ${this.platform}. Please use Node.js (e.g. by running \`npx t3\`) instead.`;
  }
}

export class BunPtyOperationUnavailableError extends Schema.TaggedErrorClass<BunPtyOperationUnavailableError>()(
  "BunPtyOperationUnavailableError",
  {
    operation: Schema.Literals(["write", "resize"]),
    pid: Schema.Number,
  },
) {
  override get message(): string {
    return `Bun PTY ${this.operation} is unavailable for process ${this.pid}.`;
  }
}

class BunPtyProcess implements PtyAdapter.PtyProcess {
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly pendingData: Uint8Array[] = [];
  private readonly process: Bun.Subprocess;
  private didExit = false;
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;

  constructor(process: Bun.Subprocess) {
    this.process = process;
    void this.process.exited
      .then((exitCode) => {
        this.emitExit({
          exitCode: Number.isInteger(exitCode) ? exitCode : 0,
          signal: typeof this.process.signalCode === "number" ? this.process.signalCode : null,
        });
      })
      .catch(() => {
        this.emitExit({ exitCode: 1, signal: null });
      });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: Uint8Array): void {
    if (!this.process.terminal) {
      throw new BunPtyOperationUnavailableError({ operation: "write", pid: this.pid });
    }
    this.process.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.process.terminal?.resize) {
      throw new BunPtyOperationUnavailableError({ operation: "resize", pid: this.pid });
    }
    this.process.terminal.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (signal === undefined) {
      this.process.kill();
      return;
    }
    this.process.kill(signal as NodeJS.Signals);
  }

  onData(callback: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(callback);
    for (const data of this.pendingData.splice(0)) callback(data);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent !== undefined) {
      callback(this.exitEvent);
      return () => undefined;
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: Uint8Array): void {
    if (this.didExit) return;
    if (data.byteLength === 0) return;
    const owned = Uint8Array.from(data);
    if (this.dataListeners.size === 0) {
      this.pendingData.push(owned);
      return;
    }
    for (const listener of this.dataListeners) listener(owned);
  }

  private emitExit(event: PtyAdapter.PtyExitEvent): void {
    if (this.didExit) return;
    this.didExit = true;
    this.exitEvent = event;
    for (const listener of this.exitListeners) listener(event);
  }
}

export const make = Effect.fn("BunPtyAdapter.make")(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    return yield* Effect.die(new BunPtyUnsupportedPlatformError({ platform }));
  }

  return PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.try({
        try: () => {
          let processHandle: BunPtyProcess | null = null;
          const pendingData: Uint8Array[] = [];
          const subprocess = Bun.spawn([input.shell, ...(input.args ?? [])], {
            cwd: input.cwd,
            env: input.env,
            terminal: {
              cols: input.cols,
              rows: input.rows,
              data: (_terminal, data) => {
                if (processHandle === null) pendingData.push(Uint8Array.from(data));
                else processHandle.emitData(data);
              },
            },
          });
          processHandle = new BunPtyProcess(subprocess);
          for (const data of pendingData) processHandle.emitData(data);
          return processHandle;
        },
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({ adapter: "bun", shell: input.shell, cause }),
      }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
