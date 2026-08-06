import { ExternalLauncherError, type EditorId, type LaunchEditorInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export {
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  isExternalLauncherError,
} from "@t3tools/contracts";
export type { LaunchEditorInput } from "@t3tools/contracts";

/** Browser/editor launch boundary. Cocoa supplies a non-launching implementation. */
export class ExternalLauncher extends Context.Service<
  ExternalLauncher,
  {
    readonly resolveAvailableEditors: () => Effect.Effect<ReadonlyArray<EditorId>>;
    readonly launchBrowser: (target: string) => Effect.Effect<void, ExternalLauncherError>;
    readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/process/externalLauncher",
) {}
