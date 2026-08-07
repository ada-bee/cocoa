import { DEFAULT_SERVER_SETTINGS, ProviderHostId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSourceControlHostingHostDefaultPatch } from "./SourceControlSettings.logic";

describe("source-control hosting host defaults", () => {
  it("sets one service default without replacing the others", () => {
    const patch = buildSourceControlHostingHostDefaultPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        sourceControlHostingHostDefaults: {
          gitlab: ProviderHostId.make("gitlab_host"),
        },
      },
      "github",
      ProviderHostId.make("github_host"),
    );

    expect(patch.sourceControlHostingHostDefaults).toEqual({
      github: "github_host",
      gitlab: "gitlab_host",
    });
  });

  it("clears only the selected service default", () => {
    const patch = buildSourceControlHostingHostDefaultPatch(
      {
        sourceControlHostingHostDefaults: {
          github: ProviderHostId.make("shared_host"),
          gitlab: ProviderHostId.make("shared_host"),
        },
      },
      "github",
      null,
    );

    expect(patch.sourceControlHostingHostDefaults).toEqual({ gitlab: "shared_host" });
  });
});
