import type * as CodexSchema from "effect-codex-app-server/schema";

import packageJson from "../../../package.json" with { type: "json" };

/** Shared initialize payload for the legacy per-session transport. */
export function buildCodexSessionInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: "t3code_desktop",
      title: "Cocoa Code Desktop",
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}
