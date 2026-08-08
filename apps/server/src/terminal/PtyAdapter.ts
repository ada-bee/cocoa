/**
 * PtyAdapter - Terminal PTY adapter service contract.
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation.
 *
 * @module PtyAdapter
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { PtySpawnError } from "@t3tools/host-runtime/pty";

export { PtySpawnError } from "@t3tools/host-runtime/pty";

/**
 * PtySpawnError - Error type for PTY spawn failures.
 */
export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/**
 * PtyAdapter - Service tag for PTY process integration.
 */
export class PtyAdapter extends Context.Service<
  PtyAdapter,
  {
    /**
     * Spawn a PTY process for a terminal session.
     */
    readonly spawn: (input: PtySpawnInput) => Effect.Effect<PtyProcess, PtySpawnError>;
  }
>()("t3/terminal/PtyAdapter") {}
