import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BranchToolbarEnvironmentIcon } from "./BranchToolbarEnvironmentSelector";

describe("BranchToolbarEnvironmentIcon", () => {
  it("renders a provider host's configured icon and accent", () => {
    const markup = renderToStaticMarkup(
      <BranchToolbarEnvironmentIcon
        environment={{
          environmentId: EnvironmentId.make("gateway"),
          projectId: ProjectId.make("project"),
          label: "rigatoni-alfredo",
          isPrimary: false,
          hostIcon: "database",
          hostAccentColor: "#7c3aed",
        }}
        className="size-3"
      />,
    );

    expect(markup).toContain("lucide-database");
    expect(markup).toContain("color:#7c3aed");
  });

  it("keeps the cloud fallback for an ordinary remote environment", () => {
    const markup = renderToStaticMarkup(
      <BranchToolbarEnvironmentIcon
        environment={{
          environmentId: EnvironmentId.make("remote"),
          projectId: ProjectId.make("project"),
          label: "Remote",
          isPrimary: false,
        }}
        className="size-3"
      />,
    );

    expect(markup).toContain("lucide-cloud");
  });
});
