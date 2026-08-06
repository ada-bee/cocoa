import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "./sidebarProjectGrouping";
import type { Project } from "./types";

const gatewayEnvironmentId = EnvironmentId.make("cocoa-gateway");
const macbookId = ProviderInstanceId.make("macbook");
const rigatoniId = ProviderInstanceId.make("rigatoni");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function project(input: {
  id: string;
  environmentId?: EnvironmentId;
  providerInstanceId: ProviderInstanceId;
}): Project {
  return {
    id: ProjectId.make(input.id),
    environmentId: input.environmentId ?? gatewayEnvironmentId,
    providerInstanceId: input.providerInstanceId,
    title: "shared-repo",
    workspaceRoot: "/work/shared-repo",
    repositoryIdentity,
    defaultModelSelection: {
      instanceId: input.providerInstanceId,
      model: "gpt-5-codex",
    },
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar project picker", () => {
  it("exposes every provider-bound physical member and keeps the preferred one first", () => {
    const macbook = project({ id: "macbook-project", providerInstanceId: macbookId });
    const rigatoni = project({ id: "rigatoni-project", providerInstanceId: rigatoniId });
    const groups = buildSidebarProjectSnapshots({
      projects: [macbook, rigatoni],
      settings: groupingSettings,
      primaryEnvironmentId: gatewayEnvironmentId,
      resolveEnvironmentLabel: () => "Cocoa gateway",
    });

    expect(groups).toHaveLength(1);
    const entries = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: gatewayEnvironmentId,
        projectId: rigatoni.id,
      },
      resolveProviderDisplayName: ({ providerInstanceId }) =>
        providerInstanceId === macbookId ? "MacBook Air" : "Linux dev box",
    });

    expect(entries.map((entry) => entry.targetProject.id)).toEqual([rigatoni.id, macbook.id]);
    expect(entries.map((entry) => entry.isPreferred)).toEqual([true, false]);
    expect(entries.map((entry) => entry.displayName)).toEqual([
      "shared-repo — Linux dev box",
      "shared-repo — MacBook Air",
    ]);
    expect(entries[0]?.key).not.toBe(entries[1]?.key);
    expect(entries[0]?.key).toContain(rigatoniId);
    expect(entries[1]?.key).toContain(macbookId);
  });

  it("adds environment context when the same endpoint label appears in multiple environments", () => {
    const remoteEnvironmentId = EnvironmentId.make("remote-gateway");
    const local = project({ id: "local-project", providerInstanceId: macbookId });
    const remote = project({
      id: "remote-project",
      environmentId: remoteEnvironmentId,
      providerInstanceId: macbookId,
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [local, remote],
      settings: groupingSettings,
      primaryEnvironmentId: gatewayEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === gatewayEnvironmentId ? "Home" : "Remote",
    });

    const entries = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: null,
      resolveProviderDisplayName: () => "Codex",
    });

    expect(entries.map((entry) => entry.displayName)).toEqual([
      "shared-repo — Codex (macbook) · Home",
      "shared-repo — Codex (macbook) · Remote",
    ]);
  });
});
