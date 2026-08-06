/**
 * Resolves a durable project to its exact provider instance and authoritative
 * provider-host workspace root before executing a bounded argv vector.
 *
 * @module project/ProjectExecution
 */
import {
  ProjectId,
  ProviderExecutionOutputByteLimit,
  ProviderExecutionTimeoutMs,
  ProviderInstanceId,
  PROVIDER_EXECUTION_DEFAULT_OUTPUT_BYTES,
  PROVIDER_EXECUTION_DEFAULT_TIMEOUT_MS,
  type ProjectExecuteCommandInput,
  type ProviderExecutionResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderExecutionError } from "../provider/ProviderExecutionAdapter.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";

export class ProjectExecutionProjectNotFoundError extends Schema.TaggedErrorClass<ProjectExecutionProjectNotFoundError>()(
  "ProjectExecutionProjectNotFoundError",
  { projectId: ProjectId },
) {}

export class ProjectExecutionProviderNotFoundError extends Schema.TaggedErrorClass<ProjectExecutionProviderNotFoundError>()(
  "ProjectExecutionProviderNotFoundError",
  { projectId: ProjectId, providerInstanceId: ProviderInstanceId },
) {}

export class ProjectExecutionProviderUnavailableError extends Schema.TaggedErrorClass<ProjectExecutionProviderUnavailableError>()(
  "ProjectExecutionProviderUnavailableError",
  { projectId: ProjectId, providerInstanceId: ProviderInstanceId },
) {}

export class ProjectExecutionCapabilityUnavailableError extends Schema.TaggedErrorClass<ProjectExecutionCapabilityUnavailableError>()(
  "ProjectExecutionCapabilityUnavailableError",
  { projectId: ProjectId, providerInstanceId: ProviderInstanceId },
) {}

export class ProjectExecutionResolveOperationError extends Schema.TaggedErrorClass<ProjectExecutionResolveOperationError>()(
  "ProjectExecutionResolveOperationError",
  { projectId: ProjectId, cause: Schema.Defect() },
) {}

export type ProjectExecutionError =
  | ProjectExecutionProjectNotFoundError
  | ProjectExecutionProviderNotFoundError
  | ProjectExecutionProviderUnavailableError
  | ProjectExecutionCapabilityUnavailableError
  | ProjectExecutionResolveOperationError
  | ProviderExecutionError;

export interface ProjectExecutionShape {
  readonly execute: (
    input: ProjectExecuteCommandInput,
  ) => Effect.Effect<ProviderExecutionResult, ProjectExecutionError>;
}

export class ProjectExecution extends Context.Service<ProjectExecution, ProjectExecutionShape>()(
  "t3/project/ProjectExecution",
) {}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const execute: ProjectExecutionShape["execute"] = Effect.fn("ProjectExecution.execute")(
    function* (input) {
      const project = yield* projections.getProjectShellById(input.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (cause) =>
            new ProjectExecutionResolveOperationError({ projectId: input.projectId, cause }),
        ),
      );
      if (project === undefined) {
        return yield* new ProjectExecutionProjectNotFoundError({ projectId: input.projectId });
      }

      const instance = yield* instances.getInstance(project.providerInstanceId);
      if (instance === undefined) {
        return yield* new ProjectExecutionProviderNotFoundError({
          projectId: input.projectId,
          providerInstanceId: project.providerInstanceId,
        });
      }
      if (!instance.enabled) {
        return yield* new ProjectExecutionProviderUnavailableError({
          projectId: input.projectId,
          providerInstanceId: project.providerInstanceId,
        });
      }
      if (instance.execution === undefined) {
        return yield* new ProjectExecutionCapabilityUnavailableError({
          projectId: input.projectId,
          providerInstanceId: project.providerInstanceId,
        });
      }

      return yield* instance.execution.execute({
        cwd: project.workspaceRoot,
        command: input.command,
        timeoutMs:
          input.timeoutMs ?? ProviderExecutionTimeoutMs.make(PROVIDER_EXECUTION_DEFAULT_TIMEOUT_MS),
        outputByteLimit:
          input.outputByteLimit ??
          ProviderExecutionOutputByteLimit.make(PROVIDER_EXECUTION_DEFAULT_OUTPUT_BYTES),
      });
    },
  );

  return ProjectExecution.of({ execute });
});

export const layer = Layer.effect(ProjectExecution, make);
