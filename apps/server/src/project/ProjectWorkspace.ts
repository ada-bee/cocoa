/**
 * ProjectWorkspace resolves durable project ownership before delegating any
 * workspace operation to the owning provider instance.
 *
 * Callers supply only a ProjectId and a relative path. The persisted project
 * root is authoritative and never interpreted on the gateway host.
 *
 * @module project/ProjectWorkspace
 */
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  ProviderWorkspaceDirectoryEntry,
  ProviderWorkspaceError,
  ProviderWorkspaceMetadata,
  ProviderWorkspaceRoot,
} from "../provider/ProviderWorkspaceAdapter.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";

export class ProjectWorkspaceProjectNotFoundError extends Schema.TaggedErrorClass<ProjectWorkspaceProjectNotFoundError>()(
  "ProjectWorkspaceProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' was not found while resolving its workspace.`;
  }
}

export class ProjectWorkspaceProviderNotFoundError extends Schema.TaggedErrorClass<ProjectWorkspaceProviderNotFoundError>()(
  "ProjectWorkspaceProviderNotFoundError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' references unavailable provider instance '${this.providerInstanceId}'.`;
  }
}

export class ProjectWorkspaceCapabilityUnavailableError extends Schema.TaggedErrorClass<ProjectWorkspaceCapabilityUnavailableError>()(
  "ProjectWorkspaceCapabilityUnavailableError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Provider instance '${this.providerInstanceId}' does not expose workspace access for project '${this.projectId}'.`;
  }
}

export class ProjectWorkspaceThreadNotFoundError extends Schema.TaggedErrorClass<ProjectWorkspaceThreadNotFoundError>()(
  "ProjectWorkspaceThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' was not found while resolving workspace for project '${this.projectId}'.`;
  }
}

export class ProjectWorkspaceThreadProjectMismatchError extends Schema.TaggedErrorClass<ProjectWorkspaceThreadProjectMismatchError>()(
  "ProjectWorkspaceThreadProjectMismatchError",
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

export class ProjectWorkspaceResolveOperationError extends Schema.TaggedErrorClass<ProjectWorkspaceResolveOperationError>()(
  "ProjectWorkspaceResolveOperationError",
  {
    projectId: ProjectId,
    operation: Schema.Literals(["resolveProject", "resolveThread"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project workspace resolution failed for project '${this.projectId}'.`;
  }
}

export type ProjectWorkspaceError =
  | ProjectWorkspaceProjectNotFoundError
  | ProjectWorkspaceProviderNotFoundError
  | ProjectWorkspaceCapabilityUnavailableError
  | ProjectWorkspaceThreadNotFoundError
  | ProjectWorkspaceThreadProjectMismatchError
  | ProjectWorkspaceResolveOperationError
  | ProviderWorkspaceError;

export interface ProjectWorkspaceTarget {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId;
}

export interface ProjectWorkspaceShape {
  /** Validate the persisted provider-host root without exposing a root handle. */
  readonly validateRoot: (
    target: ProjectWorkspaceTarget,
  ) => Effect.Effect<void, ProjectWorkspaceError>;
  readonly getMetadata: (input: {
    readonly target: ProjectWorkspaceTarget;
    readonly relativePath: string;
  }) => Effect.Effect<ProviderWorkspaceMetadata, ProjectWorkspaceError>;
  readonly listDirectory: (input: {
    readonly target: ProjectWorkspaceTarget;
    readonly relativePath: string;
  }) => Effect.Effect<ReadonlyArray<ProviderWorkspaceDirectoryEntry>, ProjectWorkspaceError>;
}

export class ProjectWorkspace extends Context.Service<ProjectWorkspace, ProjectWorkspaceShape>()(
  "t3/project/ProjectWorkspace",
) {}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerInstanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const resolveRoot = Effect.fn("ProjectWorkspace.resolveRoot")(function* (
    target: ProjectWorkspaceTarget,
  ): Effect.fn.Return<ProviderWorkspaceRoot, ProjectWorkspaceError> {
    const projectId = target.projectId;
    const project = yield* projectionSnapshotQuery.getProjectShellById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(
        (cause) =>
          new ProjectWorkspaceResolveOperationError({
            projectId,
            operation: "resolveProject",
            cause,
          }),
      ),
    );
    if (project === undefined) {
      return yield* new ProjectWorkspaceProjectNotFoundError({ projectId });
    }

    const thread =
      target.threadId === undefined
        ? undefined
        : yield* projectionSnapshotQuery.getThreadShellById(target.threadId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectWorkspaceResolveOperationError({
                  projectId,
                  operation: "resolveThread",
                  cause,
                }),
            ),
          );
    if (target.threadId !== undefined && thread === undefined) {
      return yield* new ProjectWorkspaceThreadNotFoundError({
        projectId,
        threadId: target.threadId,
      });
    }
    if (thread !== undefined && thread.projectId !== projectId) {
      return yield* new ProjectWorkspaceThreadProjectMismatchError({
        projectId,
        threadId: thread.id,
        actualProjectId: thread.projectId,
      });
    }

    const instance = yield* providerInstanceRegistry.getInstance(project.providerInstanceId);
    if (instance === undefined) {
      return yield* new ProjectWorkspaceProviderNotFoundError({
        projectId,
        providerInstanceId: project.providerInstanceId,
      });
    }
    if (instance.workspace === undefined) {
      return yield* new ProjectWorkspaceCapabilityUnavailableError({
        projectId,
        providerInstanceId: project.providerInstanceId,
      });
    }

    return yield* instance.workspace.openRoot(thread?.worktreePath ?? project.workspaceRoot);
  });

  const validateRoot: ProjectWorkspaceShape["validateRoot"] = Effect.fn(
    "ProjectWorkspace.validateRoot",
  )(function* (target) {
    yield* resolveRoot(target);
  });

  const getMetadata: ProjectWorkspaceShape["getMetadata"] = Effect.fn(
    "ProjectWorkspace.getMetadata",
  )(function* (input) {
    const root = yield* resolveRoot(input.target);
    return yield* root.getMetadata({ relativePath: input.relativePath });
  });

  const listDirectory: ProjectWorkspaceShape["listDirectory"] = Effect.fn(
    "ProjectWorkspace.listDirectory",
  )(function* (input) {
    const root = yield* resolveRoot(input.target);
    return yield* root.listDirectory({ relativePath: input.relativePath });
  });

  return ProjectWorkspace.of({ validateRoot, getMetadata, listDirectory });
});

export const layer = Layer.effect(ProjectWorkspace, make);
