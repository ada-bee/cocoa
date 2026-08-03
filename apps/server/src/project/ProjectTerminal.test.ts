import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import {
  type ProviderTerminalAdapter,
  ProviderTerminalColumns,
  ProviderTerminalDisconnectedError,
  type ProviderTerminalEvent,
  ProviderTerminalOutputByteLimit,
  ProviderTerminalRows,
  type ProviderTerminalSession,
  type ProviderTerminalStartInput,
} from "../provider/ProviderTerminalAdapter.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProjectTerminal from "./ProjectTerminal.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projectC = ProjectId.make("project-c");
const missingProject = ProjectId.make("missing-project");
const providerA = ProviderInstanceId.make("provider-a");
const providerB = ProviderInstanceId.make("provider-b");
const providerC = ProviderInstanceId.make("provider-c");
const missingProvider = ProviderInstanceId.make("missing-provider");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const threadC = ThreadId.make("thread-c");
const missingThread = ThreadId.make("missing-thread");
const sharedRoot = "/srv/shared/workspace";

function projectShell(input: {
  readonly id: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly workspaceRoot?: string;
}): OrchestrationProjectShell {
  return {
    id: input.id,
    providerInstanceId: input.providerInstanceId,
    title: `Project ${input.id}`,
    workspaceRoot: input.workspaceRoot ?? sharedRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  } as OrchestrationProjectShell;
}

function threadShell(input: {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}): OrchestrationThreadShell {
  return input as unknown as OrchestrationThreadShell;
}

function providerInstance(input: {
  readonly instanceId: ProviderInstanceId;
  readonly terminal?: ProviderTerminalAdapter;
  readonly enabled?: boolean;
}): ProviderInstance {
  return {
    instanceId: input.instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    terminal: input.terminal,
    enabled: input.enabled ?? true,
  } as unknown as ProviderInstance;
}

function terminalSession(label: string): ProviderTerminalSession & { readonly label: string } {
  return {
    label,
    write: () => Effect.void,
    resize: () => Effect.void,
    terminate: Effect.void,
  };
}

function startInput(projectId: ProjectId, threadId: ThreadId) {
  return {
    projectId,
    threadId,
    shellArgv: ["/bin/zsh", "-l"] as const,
    cols: ProviderTerminalColumns.make(120),
    rows: ProviderTerminalRows.make(40),
    env: { TERM: "xterm-256color" },
    outputByteLimit: ProviderTerminalOutputByteLimit.make(1024),
  };
}

function testLayer(input: {
  readonly projects?: ReadonlyMap<ProjectId, OrchestrationProjectShell>;
  readonly threads?: ReadonlyMap<ThreadId, OrchestrationThreadShell>;
  readonly instances?: ReadonlyMap<ProviderInstanceId, ProviderInstance>;
  readonly getProjectShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getProjectShellById"];
  readonly getThreadShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadShellById"];
}) {
  const projects = input.projects ?? new Map();
  const threads = input.threads ?? new Map();
  const instances = input.instances ?? new Map();
  return ProjectTerminal.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShellById:
          input.getProjectShellById ??
          ((projectId) => {
            const project = projects.get(projectId);
            return Effect.succeed(project === undefined ? Option.none() : Option.some(project));
          }),
        getThreadShellById:
          input.getThreadShellById ??
          ((threadId) => {
            const thread = threads.get(threadId);
            return Effect.succeed(thread === undefined ? Option.none() : Option.some(thread));
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (instanceId) => Effect.succeed(instances.get(instanceId)),
      }),
    ),
  );
}

it.effect("routes the same persisted path through two exact provider terminal capabilities", () => {
  const calls: Array<{
    readonly provider: string;
    readonly input: ProviderTerminalStartInput;
  }> = [];
  const events: Array<{ readonly provider: string; readonly event: ProviderTerminalEvent }> = [];
  const makeTerminal = (provider: string): ProviderTerminalAdapter => ({
    start: (input, onEvent) =>
      Effect.sync(() => calls.push({ provider, input })).pipe(
        Effect.andThen(onEvent({ type: "output", bytes: new TextEncoder().encode(provider) })),
        Effect.as(terminalSession(provider)),
      ),
  });
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
    [projectB, projectShell({ id: projectB, providerInstanceId: providerB })],
  ]);
  const threads = new Map([
    [threadA, threadShell({ id: threadA, projectId: projectA, worktreePath: null })],
    [threadB, threadShell({ id: threadB, projectId: projectB, worktreePath: null })],
  ]);
  const instances = new Map([
    [providerA, providerInstance({ instanceId: providerA, terminal: makeTerminal("a") })],
    [providerB, providerInstance({ instanceId: providerB, terminal: makeTerminal("b") })],
  ]);

  return Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* ProjectTerminal.ProjectTerminal;
      const sessionA = yield* terminal.start(startInput(projectA, threadA), (event) =>
        Effect.sync(() => events.push({ provider: "a", event })),
      );
      const sessionB = yield* terminal.start(startInput(projectB, threadB), (event) =>
        Effect.sync(() => events.push({ provider: "b", event })),
      );

      assert.strictEqual((sessionA as typeof sessionA & { readonly label: string }).label, "a");
      assert.strictEqual((sessionB as typeof sessionB & { readonly label: string }).label, "b");
      assert.deepStrictEqual(
        calls.map(({ provider, input }) => ({ provider, cwd: input.cwd })),
        [
          { provider: "a", cwd: sharedRoot },
          { provider: "b", cwd: sharedRoot },
        ],
      );
      assert.deepStrictEqual(
        events.map(({ provider, event }) => ({ provider, type: event.type })),
        [
          { provider: "a", type: "output" },
          { provider: "b", type: "output" },
        ],
      );
    }).pipe(Effect.provide(testLayer({ projects, threads, instances }))),
  );
});

it.effect("prefers the persisted worktree and ignores structurally injected caller paths", () => {
  const inputs: Array<ProviderTerminalStartInput> = [];
  const terminalAdapter: ProviderTerminalAdapter = {
    start: (input) =>
      Effect.sync(() => inputs.push(input)).pipe(Effect.as(terminalSession("worktree"))),
  };
  const projects = new Map([
    [
      projectA,
      projectShell({
        id: projectA,
        providerInstanceId: providerA,
        workspaceRoot: "/srv/projects/a",
      }),
    ],
  ]);
  const threads = new Map([
    [threadA, threadShell({ id: threadA, projectId: projectA, worktreePath: "/srv/worktrees/a" })],
  ]);
  const instances = new Map([
    [providerA, providerInstance({ instanceId: providerA, terminal: terminalAdapter })],
  ]);

  return Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* ProjectTerminal.ProjectTerminal;
      const injected = {
        ...startInput(projectA, threadA),
        cwd: "/gateway/or/caller/path",
        workspaceRoot: "/caller/workspace",
        worktreePath: "/caller/worktree",
      };
      yield* terminal.start(injected, () => Effect.void);

      assert.strictEqual(inputs.length, 1);
      const resolved = inputs[0]!;
      assert.deepStrictEqual(Object.keys(resolved).sort(), [
        "cols",
        "cwd",
        "env",
        "outputByteLimit",
        "rows",
        "shellArgv",
      ]);
      assert.strictEqual(resolved.cwd, "/srv/worktrees/a");
      assert.deepStrictEqual(resolved.shellArgv, ["/bin/zsh", "-l"]);
      assert.strictEqual(resolved.cols, 120);
      assert.strictEqual(resolved.rows, 40);
      assert.deepStrictEqual(resolved.env, { TERM: "xterm-256color" });
      assert.strictEqual(resolved.outputByteLimit, 1024);
    }).pipe(Effect.provide(testLayer({ projects, threads, instances }))),
  );
});

it.effect("resolves project ownership from a durable thread without a caller project id", () => {
  const starts: Array<ProviderTerminalStartInput> = [];
  const terminalAdapter: ProviderTerminalAdapter = {
    start: (input) =>
      Effect.sync(() => starts.push(input)).pipe(Effect.as(terminalSession("thread-route"))),
  };
  const projects = new Map([
    [
      projectA,
      projectShell({
        id: projectA,
        providerInstanceId: providerA,
        workspaceRoot: "/srv/projects/a",
      }),
    ],
  ]);
  const threads = new Map([
    [threadA, threadShell({ id: threadA, projectId: projectA, worktreePath: "/srv/worktrees/a" })],
  ]);
  const instances = new Map([
    [providerA, providerInstance({ instanceId: providerA, terminal: terminalAdapter })],
  ]);

  return Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* ProjectTerminal.ProjectTerminal;
      const { projectId, providerInstanceId, cwd, worktreePath } = yield* terminal.startForThread(
        {
          threadId: threadA,
          shellArgv: ["/bin/sh"],
          cols: ProviderTerminalColumns.make(100),
          rows: ProviderTerminalRows.make(30),
          outputByteLimit: ProviderTerminalOutputByteLimit.make(1024),
        },
        () => Effect.void,
      );
      assert.strictEqual(projectId, projectA);
      assert.strictEqual(providerInstanceId, providerA);
      assert.strictEqual(cwd, "/srv/worktrees/a");
      assert.strictEqual(worktreePath, "/srv/worktrees/a");
      assert.strictEqual(starts[0]?.cwd, "/srv/worktrees/a");
    }).pipe(Effect.provide(testLayer({ projects, threads, instances }))),
  );
});

it.effect("rejects missing identities and project/thread ownership mismatches distinctly", () => {
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const threads = new Map([
    [threadB, threadShell({ id: threadB, projectId: projectB, worktreePath: null })],
  ]);

  return Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* ProjectTerminal.ProjectTerminal;
      const missingProjectError = yield* terminal
        .start(startInput(missingProject, threadA), () => Effect.void)
        .pipe(Effect.flip);
      const missingThreadError = yield* terminal
        .start(startInput(projectA, missingThread), () => Effect.void)
        .pipe(Effect.flip);
      const mismatchError = yield* terminal
        .start(startInput(projectA, threadB), () => Effect.void)
        .pipe(Effect.flip);

      assert.strictEqual(missingProjectError._tag, "ProjectTerminalProjectNotFoundError");
      assert.strictEqual(missingThreadError._tag, "ProjectTerminalThreadNotFoundError");
      assert.strictEqual(mismatchError._tag, "ProjectTerminalThreadProjectMismatchError");
      if (mismatchError._tag === "ProjectTerminalThreadProjectMismatchError") {
        assert.strictEqual(mismatchError.actualProjectId, projectB);
      }
    }).pipe(Effect.provide(testLayer({ projects, threads }))),
  );
});

it.effect("rejects missing, disabled, and terminal-incapable provider instances distinctly", () => {
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: missingProvider })],
    [projectB, projectShell({ id: projectB, providerInstanceId: providerB })],
    [projectC, projectShell({ id: projectC, providerInstanceId: providerC })],
  ]);
  const threads = new Map([
    [threadA, threadShell({ id: threadA, projectId: projectA, worktreePath: null })],
    [threadB, threadShell({ id: threadB, projectId: projectB, worktreePath: null })],
    [threadC, threadShell({ id: threadC, projectId: projectC, worktreePath: null })],
  ]);
  const instances = new Map([
    [providerB, providerInstance({ instanceId: providerB, enabled: false })],
    [providerC, providerInstance({ instanceId: providerC })],
  ]);

  return Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* ProjectTerminal.ProjectTerminal;
      const missing = yield* terminal
        .start(startInput(projectA, threadA), () => Effect.void)
        .pipe(Effect.flip);
      const disabled = yield* terminal
        .start(startInput(projectB, threadB), () => Effect.void)
        .pipe(Effect.flip);
      const unsupported = yield* terminal
        .start(startInput(projectC, threadC), () => Effect.void)
        .pipe(Effect.flip);

      assert.strictEqual(missing._tag, "ProjectTerminalProviderNotFoundError");
      assert.strictEqual(disabled._tag, "ProjectTerminalProviderUnavailableError");
      assert.strictEqual(unsupported._tag, "ProjectTerminalCapabilityUnavailableError");
      if (disabled._tag === "ProjectTerminalProviderUnavailableError") {
        assert.strictEqual(disabled.reason, "disabled");
      }
    }).pipe(Effect.provide(testLayer({ projects, threads, instances }))),
  );
});

it.effect("preserves provider terminal failures without reclassification", () => {
  const providerError = new ProviderTerminalDisconnectedError({
    providerInstanceId: providerA,
    operation: "start",
  });
  const terminalAdapter: ProviderTerminalAdapter = {
    start: () => Effect.fail(providerError),
  };
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const threads = new Map([
    [threadA, threadShell({ id: threadA, projectId: projectA, worktreePath: null })],
  ]);
  const instances = new Map([
    [providerA, providerInstance({ instanceId: providerA, terminal: terminalAdapter })],
  ]);

  return Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* ProjectTerminal.ProjectTerminal;
      const error = yield* terminal
        .start(startInput(projectA, threadA), () => Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(error, providerError);
    }).pipe(Effect.provide(testLayer({ projects, threads, instances }))),
  );
});

it.effect("preserves provider session scope cleanup", () => {
  let acquired = 0;
  let released = 0;
  const session = terminalSession("scoped");
  const terminalAdapter: ProviderTerminalAdapter = {
    start: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired += 1;
          return session;
        }),
        () =>
          Effect.sync(() => {
            released += 1;
          }),
      ),
  };
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);
  const threads = new Map([
    [threadA, threadShell({ id: threadA, projectId: projectA, worktreePath: null })],
  ]);
  const instances = new Map([
    [providerA, providerInstance({ instanceId: providerA, terminal: terminalAdapter })],
  ]);

  return Effect.gen(function* () {
    const terminal = yield* ProjectTerminal.ProjectTerminal;
    const returned = yield* Effect.scoped(
      terminal.start(startInput(projectA, threadA), () => Effect.void),
    );
    assert.strictEqual(returned, session);
    assert.deepStrictEqual({ acquired, released }, { acquired: 1, released: 1 });
  }).pipe(Effect.provide(testLayer({ projects, threads, instances })));
});

it.effect("normalizes project and thread lookup failures as distinct resolver operations", () => {
  const projectCause = new PersistenceSqlError({ operation: "test.project" });
  const threadCause = new PersistenceSqlError({ operation: "test.thread" });
  const projects = new Map([
    [projectA, projectShell({ id: projectA, providerInstanceId: providerA })],
  ]);

  return Effect.scoped(
    Effect.gen(function* () {
      const projectTerminal = yield* ProjectTerminal.ProjectTerminal.pipe(
        Effect.provide(
          testLayer({
            getProjectShellById: () => Effect.fail(projectCause),
          }),
        ),
      );
      const projectError = yield* projectTerminal
        .start(startInput(projectA, threadA), () => Effect.void)
        .pipe(Effect.flip);

      const threadTerminal = yield* ProjectTerminal.ProjectTerminal.pipe(
        Effect.provide(
          testLayer({
            projects,
            getThreadShellById: () => Effect.fail(threadCause),
          }),
        ),
      );
      const threadError = yield* threadTerminal
        .start(startInput(projectA, threadA), () => Effect.void)
        .pipe(Effect.flip);

      assert.strictEqual(projectError._tag, "ProjectTerminalResolveOperationError");
      assert.strictEqual(threadError._tag, "ProjectTerminalResolveOperationError");
      if (projectError._tag === "ProjectTerminalResolveOperationError") {
        assert.strictEqual(projectError.operation, "resolveProject");
        assert.strictEqual(projectError.cause, projectCause);
      }
      if (threadError._tag === "ProjectTerminalResolveOperationError") {
        assert.strictEqual(threadError.operation, "resolveThread");
        assert.strictEqual(threadError.cause, threadCause);
      }
    }),
  );
});
