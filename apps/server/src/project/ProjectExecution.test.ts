import {
  ProjectId,
  ProviderDriverKind,
  ProviderExecutionOutputByteLimit,
  ProviderExecutionTimeoutMs,
  ProviderInstanceId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderExecutionAdapter } from "../provider/ProviderExecutionAdapter.ts";
import { ProviderExecutionDisconnectedError } from "../provider/ProviderExecutionAdapter.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProjectExecution from "./ProjectExecution.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const providerA = ProviderInstanceId.make("provider-a");
const providerB = ProviderInstanceId.make("provider-b");
const sharedRoot = "/srv/shared/workspace";

function project(id: ProjectId, providerInstanceId: ProviderInstanceId): OrchestrationProjectShell {
  return {
    id,
    providerInstanceId,
    title: id,
    workspaceRoot: sharedRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  } as OrchestrationProjectShell;
}

function instance(input: {
  readonly id: ProviderInstanceId;
  readonly execution?: ProviderExecutionAdapter;
  readonly enabled?: boolean;
}): ProviderInstance {
  return {
    instanceId: input.id,
    driverKind: ProviderDriverKind.make("codex"),
    enabled: input.enabled ?? true,
    execution: input.execution,
  } as unknown as ProviderInstance;
}

function testLayer(input: {
  readonly projects?: ReadonlyMap<ProjectId, OrchestrationProjectShell>;
  readonly instances?: ReadonlyMap<ProviderInstanceId, ProviderInstance>;
}) {
  const projects = input.projects ?? new Map();
  const instances = input.instances ?? new Map();
  return ProjectExecution.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShellById: (id) =>
          Effect.succeed(projects.has(id) ? Option.some(projects.get(id)!) : Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (id) => Effect.succeed(instances.get(id)),
      }),
    ),
  );
}

it.effect(
  "routes identical roots through the project-owned provider and ignores client cwd fields",
  () => {
    const calls: Array<{ readonly provider: string; readonly input: unknown }> = [];
    const adapter = (provider: string): ProviderExecutionAdapter => ({
      execute: (input) =>
        Effect.sync(() => {
          calls.push({ provider, input });
          return {
            exitCode: 0,
            stdout: provider,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    });
    const projects = new Map([
      [projectA, project(projectA, providerA)],
      [projectB, project(projectB, providerB)],
    ]);
    const instances = new Map([
      [providerA, instance({ id: providerA, execution: adapter("a") })],
      [providerB, instance({ id: providerB, execution: adapter("b") })],
    ]);

    return Effect.gen(function* () {
      const execution = yield* ProjectExecution.ProjectExecution;
      const a = yield* execution.execute({
        projectId: projectA,
        command: ["git", "status"],
        cwd: "/gateway/attacker-selected",
      } as Parameters<typeof execution.execute>[0]);
      const b = yield* execution.execute({
        projectId: projectB,
        command: ["uname", "-s"],
        timeoutMs: ProviderExecutionTimeoutMs.make(10_000),
        outputByteLimit: ProviderExecutionOutputByteLimit.make(512),
      });

      assert.strictEqual(a.stdout, "a");
      assert.strictEqual(b.stdout, "b");
      assert.deepStrictEqual(calls, [
        {
          provider: "a",
          input: {
            cwd: sharedRoot,
            command: ["git", "status"],
            timeoutMs: 30_000,
            outputByteLimit: 1024 * 1024,
          },
        },
        {
          provider: "b",
          input: {
            cwd: sharedRoot,
            command: ["uname", "-s"],
            timeoutMs: 10_000,
            outputByteLimit: 512,
          },
        },
      ]);
    }).pipe(Effect.provide(testLayer({ projects, instances })));
  },
);

it.effect("distinguishes missing, disabled, and unsupported provider routes", () => {
  const missingProvider = ProviderInstanceId.make("missing-provider");
  const projects = new Map([
    [projectA, project(projectA, missingProvider)],
    [projectB, project(projectB, providerB)],
  ]);
  const instances = new Map([[providerB, instance({ id: providerB, enabled: false })]]);

  return Effect.gen(function* () {
    const execution = yield* ProjectExecution.ProjectExecution;
    const missingProject = yield* execution
      .execute({ projectId: ProjectId.make("missing"), command: ["true"] })
      .pipe(Effect.flip);
    const missing = yield* execution
      .execute({ projectId: projectA, command: ["true"] })
      .pipe(Effect.flip);
    const disabled = yield* execution
      .execute({ projectId: projectB, command: ["true"] })
      .pipe(Effect.flip);

    assert.strictEqual(missingProject._tag, "ProjectExecutionProjectNotFoundError");
    assert.strictEqual(missing._tag, "ProjectExecutionProviderNotFoundError");
    assert.strictEqual(disabled._tag, "ProjectExecutionProviderUnavailableError");
  }).pipe(Effect.provide(testLayer({ projects, instances })));
});

it.effect("preserves provider disconnect failures without retrying", () => {
  let calls = 0;
  const error = new ProviderExecutionDisconnectedError({ providerInstanceId: providerA });
  const execution: ProviderExecutionAdapter = {
    execute: () => {
      calls += 1;
      return Effect.fail(error);
    },
  };
  const projects = new Map([[projectA, project(projectA, providerA)]]);
  const instances = new Map([[providerA, instance({ id: providerA, execution })]]);

  return Effect.gen(function* () {
    const service = yield* ProjectExecution.ProjectExecution;
    const actual = yield* service
      .execute({ projectId: projectA, command: ["touch", "one"] })
      .pipe(Effect.flip);
    assert.strictEqual(actual, error);
    assert.strictEqual(calls, 1);
  }).pipe(Effect.provide(testLayer({ projects, instances })));
});
