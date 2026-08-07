/**
 * Host-safe PTY process primitives, independent of terminal session policy,
 * persistence, and transport.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PtySpawnError extends Schema.TaggedErrorClass<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  shell: Schema.optional(Schema.String),
  attemptedShells: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const shell = this.shell === undefined ? "" : ` '${this.shell}'`;
    const attemptedShells =
      this.attemptedShells === undefined || this.attemptedShells.length === 0
        ? ""
        : ` Tried shells: ${this.attemptedShells.join(", ")}.`;
    return `Failed to spawn PTY process${shell} with ${this.adapter}.${attemptedShells}`;
  }
}

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  readonly write: (data: Uint8Array) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly kill: (signal?: string) => void;
  readonly onData: (callback: (data: Uint8Array) => void) => () => void;
  readonly onExit: (callback: (event: PtyExitEvent) => void) => () => void;
}

export interface PtySpawnInput {
  readonly shell: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: NodeJS.ProcessEnv;
}

export class PtyAdapter extends Context.Service<
  PtyAdapter,
  {
    readonly spawn: (input: PtySpawnInput) => Effect.Effect<PtyProcess, PtySpawnError>;
  }
>()("@t3tools/host-runtime/pty/PtyAdapter") {}
