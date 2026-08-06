import type {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Runtime-neutral terminal service contract shared by local and provider-backed implementations. */
export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;
    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/terminal/Manager/TerminalManager",
) {}
