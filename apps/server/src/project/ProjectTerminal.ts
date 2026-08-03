/**
 * ProjectTerminal resolves durable project and thread ownership before
 * starting an interactive terminal on the owning provider instance.
 *
 * Callers supply persisted identities and terminal controls, never a cwd. The
 * persisted thread worktree (when present) or project workspace root is the
 * authoritative provider-host path and is never interpreted by the gateway.
 *
 * @module project/ProjectTerminal
 */
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  ProviderTerminalColumns,
  ProviderTerminalError,
  ProviderTerminalEventHandler,
  ProviderTerminalOutputByteLimit,
  ProviderTerminalRows,
  ProviderTerminalSession,
} from "../provider/ProviderTerminalAdapter.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";

export class ProjectTerminalProjectNotFoundError extends Schema.TaggedErrorClass<ProjectTerminalProjectNotFoundError>()(
  "ProjectTerminalProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' was not found while resolving its terminal.`;
  }
}

export class ProjectTerminalThreadNotFoundError extends Schema.TaggedErrorClass<ProjectTerminalThreadNotFoundError>()(
  "ProjectTerminalThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' was not found while resolving terminal for project '${this.projectId}'.`;
  }
}

export class ProjectTerminalThreadProjectMismatchError extends Schema.TaggedErrorClass<ProjectTerminalThreadProjectMismatchError>()(
  "ProjectTerminalThreadProjectMismatchError",
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

export class ProjectTerminalProviderNotFoundError extends Schema.TaggedErrorClass<ProjectTerminalProviderNotFoundError>()(
  "ProjectTerminalProviderNotFoundError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' references unavailable provider instance '${this.providerInstanceId}'.`;
  }
}

export class ProjectTerminalProviderUnavailableError extends Schema.TaggedErrorClass<ProjectTerminalProviderUnavailableError>()(
  "ProjectTerminalProviderUnavailableError",
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

export class ProjectTerminalCapabilityUnavailableError extends Schema.TaggedErrorClass<ProjectTerminalCapabilityUnavailableError>()(
  "ProjectTerminalCapabilityUnavailableError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Provider instance '${this.providerInstanceId}' does not expose terminal access for project '${this.projectId}'.`;
  }
}

export const ProjectTerminalResolveOperation = Schema.Literals(["resolveProject", "resolveThread"]);
export type ProjectTerminalResolveOperation = typeof ProjectTerminalResolveOperation.Type;

export class ProjectTerminalResolveOperationError extends Schema.TaggedErrorClass<ProjectTerminalResolveOperationError>()(
  "ProjectTerminalResolveOperationError",
  {
    projectId: ProjectId,
    operation: ProjectTerminalResolveOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project terminal resolution failed for project '${this.projectId}' during ${this.operation}.`;
  }
}

export type ProjectTerminalResolverError =
  | ProjectTerminalProjectNotFoundError
  | ProjectTerminalThreadNotFoundError
  | ProjectTerminalThreadProjectMismatchError
  | ProjectTerminalProviderNotFoundError
  | ProjectTerminalProviderUnavailableError
  | ProjectTerminalCapabilityUnavailableError
  | ProjectTerminalResolveOperationError;

export type ProjectTerminalError = ProjectTerminalResolverError | ProviderTerminalError;

/** Provider terminal start controls with no caller-controlled cwd. */
export interface ProjectTerminalStartInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly shellArgv: readonly [string, ...ReadonlyArray<string>];
  readonly cols: ProviderTerminalColumns;
  readonly rows: ProviderTerminalRows;
  readonly env?: Readonly<Record<string, string>>;
  readonly outputByteLimit: ProviderTerminalOutputByteLimit;
}

export interface ProjectTerminalShape {
  readonly start: (
    input: ProjectTerminalStartInput,
    onEvent: ProviderTerminalEventHandler,
  ) => Effect.Effect<ProviderTerminalSession, ProjectTerminalError, Scope.Scope>;
}

export class ProjectTerminal extends Context.Service<ProjectTerminal, ProjectTerminalShape>()(
  "t3/project/ProjectTerminal",
) {}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerInstanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const start: ProjectTerminalShape["start"] = Effect.fn("ProjectTerminal.start")(
    function* (input, onEvent) {
      const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (cause) =>
            new ProjectTerminalResolveOperationError({
              projectId: input.projectId,
              operation: "resolveProject",
              cause,
            }),
        ),
      );
      if (project === undefined) {
        return yield* new ProjectTerminalProjectNotFoundError({ projectId: input.projectId });
      }

      const thread = yield* projectionSnapshotQuery.getThreadShellById(input.threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (cause) =>
            new ProjectTerminalResolveOperationError({
              projectId: input.projectId,
              operation: "resolveThread",
              cause,
            }),
        ),
      );
      if (thread === undefined) {
        return yield* new ProjectTerminalThreadNotFoundError({
          projectId: input.projectId,
          threadId: input.threadId,
        });
      }
      if (thread.projectId !== project.id) {
        return yield* new ProjectTerminalThreadProjectMismatchError({
          projectId: project.id,
          threadId: thread.id,
          actualProjectId: thread.projectId,
        });
      }

      const instance = yield* providerInstanceRegistry.getInstance(project.providerInstanceId);
      if (instance === undefined) {
        return yield* new ProjectTerminalProviderNotFoundError({
          projectId: project.id,
          providerInstanceId: project.providerInstanceId,
        });
      }
      if (instance.enabled === false) {
        return yield* new ProjectTerminalProviderUnavailableError({
          projectId: project.id,
          providerInstanceId: project.providerInstanceId,
          reason: "disabled",
        });
      }
      if (instance.terminal === undefined) {
        return yield* new ProjectTerminalCapabilityUnavailableError({
          projectId: project.id,
          providerInstanceId: project.providerInstanceId,
        });
      }

      return yield* instance.terminal.start(
        {
          cwd: thread.worktreePath ?? project.workspaceRoot,
          shellArgv: input.shellArgv,
          cols: input.cols,
          rows: input.rows,
          ...(input.env === undefined ? {} : { env: input.env }),
          outputByteLimit: input.outputByteLimit,
        },
        onEvent,
      );
    },
  );

  return ProjectTerminal.of({ start });
});

export const layer = Layer.effect(ProjectTerminal, make);
