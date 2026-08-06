import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import {
  deriveLogicalProjectKey,
  derivePhysicalProjectKey,
  derivePhysicalProjectKeyFromPath,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  resolveProjectGroupingMode,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("cocoa-gateway");

function makeProject(
  providerInstanceId: ProviderInstanceId,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(`project-${providerInstanceId}`),
    providerInstanceId,
    title: "cocoa",
    workspaceRoot: "/work/cocoa",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("physical project identity", () => {
  it("normalizes path variants for the same environment and provider instance", () => {
    const providerInstanceId = ProviderInstanceId.make("macbook");

    expect(
      derivePhysicalProjectKeyFromPath(environmentId, providerInstanceId, "/work/cocoa/"),
    ).toBe(derivePhysicalProjectKey(makeProject(providerInstanceId)));
  });

  it("keeps the same workspace path distinct across provider instances", () => {
    const macbook = makeProject(ProviderInstanceId.make("macbook"));
    const rigatoni = makeProject(ProviderInstanceId.make("rigatoni"));

    expect(derivePhysicalProjectKey(macbook)).not.toBe(derivePhysicalProjectKey(rigatoni));
    expect(getProjectOrderKey(macbook)).not.toBe(getProjectOrderKey(rigatoni));
    expect(deriveProjectGroupingOverrideKey(macbook)).not.toBe(
      deriveProjectGroupingOverrideKey(rigatoni),
    );
    expect(deriveLogicalProjectKey(macbook, { groupingMode: "separate" })).not.toBe(
      deriveLogicalProjectKey(rigatoni, { groupingMode: "separate" }),
    );
  });

  it("applies a grouping override only to its provider-bound project", () => {
    const macbook = makeProject(ProviderInstanceId.make("macbook"));
    const rigatoni = makeProject(ProviderInstanceId.make("rigatoni"));
    const settings = {
      sidebarProjectGroupingMode: "repository" as const,
      sidebarProjectGroupingOverrides: {
        [deriveProjectGroupingOverrideKey(macbook)]: "separate" as const,
      },
    };

    expect(resolveProjectGroupingMode(macbook, settings)).toBe("separate");
    expect(resolveProjectGroupingMode(rigatoni, settings)).toBe("repository");
  });
});
