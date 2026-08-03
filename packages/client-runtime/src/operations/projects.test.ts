import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  CommandId,
  SourceControlDiscoveryResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  buildAddProjectRemoteSourceReadiness,
  buildProjectCreateCommand,
  canCreateProjectInEnvironment,
  findExistingAddProject,
  getAvailableProjectProviderInstances,
  getAddProjectInitialQuery,
  resolveAddProjectPath,
  resolveProjectCreationProviderInstanceId,
  resolveProjectCreationModelSelection,
  sortAddProjectProviderSources,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

const providerInstanceId = ProviderInstanceId.make("codex");

describe("add project shared logic", () => {
  it("only resolves an endpoint when explicit or unambiguous", () => {
    const personal = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      enabled: true,
      installed: true,
    };
    const work = {
      instanceId: ProviderInstanceId.make("codex_work"),
      enabled: true,
      installed: true,
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("codex_disabled"),
      enabled: false,
      installed: true,
    };

    expect(getAvailableProjectProviderInstances([personal, disabled])).toEqual([personal]);
    expect(resolveProjectCreationProviderInstanceId([personal, disabled])).toBe(
      personal.instanceId,
    );
    expect(resolveProjectCreationProviderInstanceId([personal, work])).toBeNull();
    expect(resolveProjectCreationProviderInstanceId([personal, work], work.instanceId)).toBe(
      work.instanceId,
    );
    expect(resolveProjectCreationProviderInstanceId([personal], disabled.instanceId)).toBe(
      personal.instanceId,
    );
  });

  it("resolves a default model only from the selected endpoint", () => {
    const personal = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      enabled: true,
      installed: true,
      models: [
        { slug: "custom", isCustom: true },
        { slug: "personal-default", isCustom: false, isDefault: true },
      ],
    };
    const work = {
      instanceId: ProviderInstanceId.make("codex_work"),
      enabled: true,
      installed: true,
      models: [{ slug: "work-default", isCustom: false, isDefault: true }],
    };

    expect(resolveProjectCreationModelSelection([personal, work], work.instanceId)).toEqual({
      instanceId: work.instanceId,
      model: "work-default",
    });
    expect(
      resolveProjectCreationModelSelection([personal], ProviderInstanceId.make("missing")),
    ).toBeNull();
  });

  it("only allows project creation in connected environments", () => {
    expect(canCreateProjectInEnvironment("connected")).toBe(true);
    expect(canCreateProjectInEnvironment("available")).toBe(false);
    expect(canCreateProjectInEnvironment("offline")).toBe(false);
    expect(canCreateProjectInEnvironment("connecting")).toBe(false);
    expect(canCreateProjectInEnvironment("reconnecting")).toBe(false);
    expect(canCreateProjectInEnvironment("error")).toBe(false);
  });

  it("resolves initial browse paths from settings", () => {
    expect(getAddProjectInitialQuery("")).toBe("~/");
    expect(getAddProjectInitialQuery("/work")).toBe("/work/");
    expect(getAddProjectInitialQuery("C:\\work")).toBe("~/");
  });

  it("accepts only provider-resolved absolute paths", () => {
    expect(
      resolveAddProjectPath({
        rawPath: "C:\\repo",
      }),
    ).toEqual({
      ok: false,
      error: "Choose or enter an absolute folder path on the selected Codex endpoint.",
    });
    expect(
      resolveAddProjectPath({
        rawPath: "../next",
      }),
    ).toEqual({
      ok: false,
      error: "Choose or enter an absolute folder path on the selected Codex endpoint.",
    });
    expect(resolveAddProjectPath({ rawPath: "/work/next" })).toEqual({
      ok: true,
      path: "/work/next",
    });
    expect(resolveAddProjectPath({ rawPath: "/work/../next" }).ok).toBe(false);
    expect(resolveAddProjectPath({ rawPath: "/work\\next" }).ok).toBe(false);
  });

  it("marks authenticated source control providers as ready", () => {
    const discovery: SourceControlDiscoveryResult = {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          status: "available",
          installHint: "Install gh",
          version: Option.some("1.0.0"),
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("octo"),
            host: Option.some("github.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "gitlab",
          label: "GitLab",
          status: "available",
          installHint: "Install glab",
          version: Option.some("1.0.0"),
          detail: Option.none(),
          auth: {
            status: "unauthenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.some("Run glab auth login"),
          },
        },
      ],
    };

    const readiness = buildAddProjectRemoteSourceReadiness(discovery);
    expect(readiness.url.ready).toBe(true);
    expect(readiness.github.ready).toBe(true);
    expect(readiness.gitlab).toEqual({ ready: false, hint: "Run glab auth login" });
    expect(sortAddProjectProviderSources(readiness)[0]).toBe("github");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        providerInstanceId,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        providerInstanceId,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(
      findExistingAddProject({ projects, environmentId: env, providerInstanceId, path: "/repo" })
        ?.id,
    ).toBe("project");
  });

  it("builds the existing project.create command shape", () => {
    expect(
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        providerInstanceId,
        workspaceRoot: "/work/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      type: "project.create",
      commandId: "command",
      projectId: "project",
      providerInstanceId: "codex",
      title: "repo",
      workspaceRoot: "/work/repo",
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: null,
    });
  });
});
