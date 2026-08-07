import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderHostId,
  ProviderInstanceId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  discoverProviderSourceControl,
  resolveProviderSourceControlInstanceId,
} from "./ProviderSourceControlDiscovery.ts";

const ALFREDO = ProviderInstanceId.make("alfredo");
const RAVIOLI = ProviderInstanceId.make("ravioli");

function project(input: {
  readonly id: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly provider?: string;
}): OrchestrationProjectShell {
  return {
    id: ProjectId.make(input.id),
    providerInstanceId: input.providerInstanceId,
    title: input.id,
    workspaceRoot: `/srv/${input.id}`,
    repositoryIdentity:
      input.provider === undefined
        ? null
        : {
            canonicalKey: `${input.provider}.example/owner/${input.id}`,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: `https://${input.provider}.example/owner/${input.id}.git`,
            },
            provider: input.provider,
          },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}

describe("provider source control discovery", () => {
  it("resolves every host kind through a live VCS-capable binding, not a Codex-only slot", () => {
    const alfredoHost = ProviderHostId.make("alfredo_host");
    const opencode = ProviderInstanceId.make("opencode_alfredo");
    const selected = resolveProviderSourceControlInstanceId({
      requestedHostId: alfredoHost,
      configuredInstances: {
        [ALFREDO]: {
          driver: ProviderDriverKind.make("codex"),
          hostId: alfredoHost,
        },
        [opencode]: {
          driver: ProviderDriverKind.make("opencode"),
          hostId: alfredoHost,
        },
      },
      liveInstances: [
        { instanceId: ALFREDO, vcsAvailable: false },
        { instanceId: opencode, vcsAvailable: true },
      ],
    });

    expect(selected).toBe(opencode);
  });

  it("scopes Git and detected repository hosts to one provider host", () => {
    const result = discoverProviderSourceControl({
      providerInstanceId: ALFREDO,
      projects: [
        project({ id: "cocoa", providerInstanceId: ALFREDO, provider: "github" }),
        project({ id: "web", providerInstanceId: ALFREDO, provider: "gitlab" }),
        project({ id: "other", providerInstanceId: RAVIOLI, provider: "bitbucket" }),
      ],
      vcsAvailable: true,
    });

    expect(result.versionControlSystems[0]).toMatchObject({
      kind: "git",
      status: "available",
    });
    expect(result.sourceControlProviders.map((provider) => provider.kind)).toEqual([
      "github",
      "gitlab",
    ]);
    expect(result.sourceControlProviders[0]?.auth.status).toBe("unknown");
    expect(Option.getOrNull(result.sourceControlProviders[0]!.detail)).toContain(
      "repository remote",
    );
  });

  it("reports missing Git capability without inventing repository integrations", () => {
    const result = discoverProviderSourceControl({
      providerInstanceId: RAVIOLI,
      projects: [],
      vcsAvailable: false,
    });

    expect(result.versionControlSystems[0]?.status).toBe("missing");
    expect(result.sourceControlProviders).toEqual([]);
  });
});
