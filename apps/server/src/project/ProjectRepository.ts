/**
 * ProjectRepository resolves durable project ownership before opening a
 * provider-host version-control repository.
 *
 * Callers supply only project and optional thread identity. The persisted
 * project root or verified thread worktree path is authoritative and is never
 * interpreted on the gateway host.
 *
 * @module project/ProjectRepository
 */
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderVcsError, ProviderVcsRepository } from "../provider/ProviderVcsAdapter.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";

export class ProjectRepositoryProjectNotFoundError extends Schema.TaggedErrorClass<ProjectRepositoryProjectNotFoundError>()(
  "ProjectRepositoryProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' was not found while resolving its repository.`;
  }
}

export class ProjectRepositoryThreadNotFoundError extends Schema.TaggedErrorClass<ProjectRepositoryThreadNotFoundError>()(
  "ProjectRepositoryThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' was not found while resolving repository for project '${this.projectId}'.`;
  }
}

export class ProjectRepositoryThreadProjectMismatchError extends Schema.TaggedErrorClass<ProjectRepositoryThreadProjectMismatchError>()(
  "ProjectRepositoryThreadProjectMismatchError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' belongs to project '${this.actualProjectId}', not requested project '${this.projectId}'.`;
  }
}

export class ProjectRepositoryProviderNotFoundError extends Schema.TaggedErrorClass<ProjectRepositoryProviderNotFoundError>()(
  "ProjectRepositoryProviderNotFoundError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' references unavailable provider instance '${this.providerInstanceId}'.`;
  }
}

export class ProjectRepositoryProviderUnavailableError extends Schema.TaggedErrorClass<ProjectRepositoryProviderUnavailableError>()(
  "ProjectRepositoryProviderUnavailableError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    reason: Schema.Literal("disabled"),
  },
) {
  override get message(): string {
    return `Provider instance '${this.providerInstanceId}' is disabled for project '${this.projectId}'.`;
  }
}

export class ProjectRepositoryCapabilityUnavailableError extends Schema.TaggedErrorClass<ProjectRepositoryCapabilityUnavailableError>()(
  "ProjectRepositoryCapabilityUnavailableError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Provider instance '${this.providerInstanceId}' does not expose repository access for project '${this.projectId}'.`;
  }
}

export class ProjectRepositoryNotRepositoryError extends Schema.TaggedErrorClass<ProjectRepositoryNotRepositoryError>()(
  "ProjectRepositoryNotRepositoryError",
  {
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `The provider-host target for project '${this.projectId}' is not inside a supported repository.`;
  }
}

export const ProjectRepositoryResolveOperation = Schema.Literals([
  "resolveProject",
  "resolveThread",
]);
export type ProjectRepositoryResolveOperation = typeof ProjectRepositoryResolveOperation.Type;

export class ProjectRepositoryResolveOperationError extends Schema.TaggedErrorClass<ProjectRepositoryResolveOperationError>()(
  "ProjectRepositoryResolveOperationError",
  {
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    operation: ProjectRepositoryResolveOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project repository resolution failed for project '${this.projectId}' during ${this.operation}.`;
  }
}

export type ProjectRepositoryError =
  | ProjectRepositoryProjectNotFoundError
  | ProjectRepositoryThreadNotFoundError
  | ProjectRepositoryThreadProjectMismatchError
  | ProjectRepositoryProviderNotFoundError
  | ProjectRepositoryProviderUnavailableError
  | ProjectRepositoryCapabilityUnavailableError
  | ProjectRepositoryNotRepositoryError
  | ProjectRepositoryResolveOperationError
  | ProviderVcsError;

export interface ProjectRepositoryTarget {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId;
}

export interface ProjectRepositoryShape {
  /** Resolve and open the exact provider-owned repository for this target. */
  readonly resolve: (
    target: ProjectRepositoryTarget,
  ) => Effect.Effect<ProviderVcsRepository, ProjectRepositoryError>;
}

export class ProjectRepository extends Context.Service<ProjectRepository, ProjectRepositoryShape>()(
  "t3/project/ProjectRepository",
) {}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerInstanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const resolve: ProjectRepositoryShape["resolve"] = Effect.fn("ProjectRepository.resolve")(
    function* (target) {
      const project = yield* projectionSnapshotQuery.getProjectShellById(target.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (cause) =>
            new ProjectRepositoryResolveOperationError({
              projectId: target.projectId,
              ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
              operation: "resolveProject",
              cause,
            }),
        ),
      );
      if (project === undefined) {
        return yield* new ProjectRepositoryProjectNotFoundError({ projectId: target.projectId });
      }

      const threadId = target.threadId;
      const thread =
        threadId === undefined
          ? undefined
          : yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
              Effect.map(Option.getOrUndefined),
              Effect.mapError(
                (cause) =>
                  new ProjectRepositoryResolveOperationError({
                    projectId: target.projectId,
                    threadId,
                    operation: "resolveThread",
                    cause,
                  }),
              ),
            );
      if (threadId !== undefined && thread === undefined) {
        return yield* new ProjectRepositoryThreadNotFoundError({
          projectId: target.projectId,
          threadId,
        });
      }
      if (thread !== undefined && thread.projectId !== target.projectId) {
        return yield* new ProjectRepositoryThreadProjectMismatchError({
          projectId: target.projectId,
          threadId: thread.id,
          actualProjectId: thread.projectId,
        });
      }

      const instance = yield* providerInstanceRegistry.getInstance(project.providerInstanceId);
      if (instance === undefined) {
        return yield* new ProjectRepositoryProviderNotFoundError({
          projectId: target.projectId,
          providerInstanceId: project.providerInstanceId,
        });
      }
      if (instance.enabled === false) {
        return yield* new ProjectRepositoryProviderUnavailableError({
          projectId: target.projectId,
          providerInstanceId: project.providerInstanceId,
          reason: "disabled",
        });
      }
      if (instance.vcs === undefined) {
        return yield* new ProjectRepositoryCapabilityUnavailableError({
          projectId: target.projectId,
          providerInstanceId: project.providerInstanceId,
        });
      }

      const opened = yield* instance.vcs.openRepository(
        thread?.worktreePath ?? project.workspaceRoot,
      );
      if (opened._tag === "NotRepository") {
        return yield* new ProjectRepositoryNotRepositoryError({
          projectId: target.projectId,
          ...(threadId === undefined ? {} : { threadId }),
          providerInstanceId: project.providerInstanceId,
        });
      }
      return opened.repository;
    },
  );

  return ProjectRepository.of({ resolve });
});

export const layer = Layer.effect(ProjectRepository, make);
