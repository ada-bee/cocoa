import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectTerminal from "../project/ProjectTerminal.ts";
import { makeProviderTerminalManager } from "./ProviderManager.ts";
import { TerminalManager } from "./TerminalManagerService.ts";

/** Provider-backed terminal composition with no local PTY or shell implementation in its graph. */
export const layer = Layer.effect(
  TerminalManager,
  Effect.gen(function* () {
    const projectTerminal = yield* ProjectTerminal.ProjectTerminal;
    return yield* makeProviderTerminalManager({ projectTerminal });
  }),
);
