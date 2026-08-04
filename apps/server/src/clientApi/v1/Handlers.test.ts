import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestrationEvent,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent as OrchestrationEventType,
} from "@t3tools/contracts";
import {
  COCOA_CLIENT_V1_METHODS,
  COCOA_CLIENT_V1_SUPPORTED_METHODS,
} from "@t3tools/contracts/client/v1";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as CheckpointDiffQuery from "../../checkpointing/CheckpointDiffQuery.ts";
import { CheckpointProviderOperationError } from "../../checkpointing/Errors.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  OrchestrationCommandBlockedByRevertError,
  OrchestrationCommandBusyError,
} from "../../orchestration/Errors.ts";
import {
  CheckpointRevertGate,
  CheckpointRevertGateBlockedError,
} from "../../orchestration/Services/CheckpointRevertGate.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { DEFAULT_RUNTIME_BUFFER_LIMITS } from "../../RuntimeBufferLimits.ts";
import { COCOA_CLIENT_V1_REQUIRED_SCOPES } from "./Authorization.ts";
import { COCOA_CLIENT_V1_RESUME_MAX_GAP, makeCocoaClientV1Handlers } from "./Handlers.ts";

const createdAt = "2026-08-04T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("codex-main");

const shellSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot)({
  snapshotSequence: 5,
  projects: [
    {
      id: projectId,
      providerInstanceId: instanceId,
      title: "Cocoa",
      workspaceRoot: "/remote/cocoa",
      defaultModelSelection: { instanceId, model: "gpt-5.4" },
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  ],
  threads: [
    {
      id: threadId,
      projectId,
      title: "Thread one",
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/remote/cocoa",
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
  updatedAt: createdAt,
});

const threadSnapshot = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot)({
  snapshotSequence: 5,
  thread: {
    ...shellSnapshot.threads[0],
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  },
});

const messageEvent = (sequence: number, text: string) =>
  Schema.decodeUnknownSync(OrchestrationEvent)({
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: createdAt,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: { providerTurnId: `native-${sequence}`, adapterKey: "codex" },
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: `message-${sequence}`,
      role: "assistant",
      text,
      attachments: [],
      turnId: `turn-${sequence}`,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    },
  });

const readSession: EnvironmentAuth.AuthenticatedSession = {
  sessionId: AuthSessionId.make("session-read"),
  subject: "test-client",
  method: "bearer-access-token",
  scopes: [AuthOrchestrationReadScope],
};

const operateSession: EnvironmentAuth.AuthenticatedSession = {
  ...readSession,
  sessionId: AuthSessionId.make("session-operate"),
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};

interface HarnessOptions {
  readonly snapshot?: typeof shellSnapshot;
  readonly thread?: Option.Option<typeof threadSnapshot>;
  readonly events?: ReadonlyArray<OrchestrationEventType>;
  readonly livePrelude?: ReadonlyArray<OrchestrationEventType>;
  readonly latestSequence?: number;
  readonly loadShell?: Effect.Effect<typeof shellSnapshot>;
  readonly diffFailure?: boolean;
  readonly dispatchBusy?: boolean;
  readonly dispatchBlockedByRevert?: boolean;
  readonly revertBlocked?: boolean;
}

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const live = yield* PubSub.unbounded<OrchestrationEventType>();
    const latest = yield* Ref.make(options.latestSequence ?? 5);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const events = options.events ?? [];

    const projections = ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () =>
        options.loadShell ?? Effect.succeed(options.snapshot ?? shellSnapshot),
      getArchivedShellSnapshot: () => Effect.die("unused"),
      searchThreads: () =>
        Effect.succeed({
          matches: [
            {
              threadId,
              projectId,
              source: "assistant",
              snippet: "matching snippet",
              messageCreatedAt: createdAt,
            },
          ],
        }),
      getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 5 }),
      getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some((options.snapshot ?? shellSnapshot).projects[0]!)
            : Option.none(),
        ),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(threadId)),
      getCheckpointDiffContext: () => Effect.succeed(Option.none()),
      getThreadShellById: (id) =>
        Effect.succeed(
          id === threadId
            ? Option.some((options.snapshot ?? shellSnapshot).threads[0]!)
            : Option.none(),
        ),
      getThreadDetailById: () => Effect.succeed(Option.none()),
      getThreadDetailSnapshot: () => Effect.succeed(options.thread ?? Option.some(threadSnapshot)),
    });

    const engine = OrchestrationEngine.OrchestrationEngineService.of({
      readEvents: (after, limit = 1_000) =>
        Stream.fromIterable(events.filter((event) => event.sequence > after).slice(0, limit)),
      dispatch: (command) =>
        options.dispatchBusy === true
          ? Effect.fail(
              new OrchestrationCommandBusyError({
                commandId: command.commandId,
                retryable: true,
              }),
            )
          : options.dispatchBlockedByRevert === true
            ? Effect.fail(
                new OrchestrationCommandBlockedByRevertError({
                  commandId: command.commandId,
                  threadId: threadId,
                  retryable: true,
                }),
              )
            : Ref.updateAndGet(dispatched, (commands) => [...commands, command]).pipe(
                Effect.map((commands) => ({ sequence: commands.length })),
              ),
      streamDomainEvents: Stream.concat(
        Stream.fromIterable(options.livePrelude ?? []),
        Stream.fromPubSub(live),
      ),
      latestSequence: Ref.get(latest),
    });

    const diffFailure = new CheckpointProviderOperationError({
      operation: "CheckpointDiffQuery.getTurnDiff",
      threadId,
    });
    const diffs = CheckpointDiffQuery.CheckpointDiffQuery.of({
      getTurnDiff: () =>
        options.diffFailure
          ? Effect.fail(diffFailure)
          : Effect.succeed({
              threadId,
              fromTurnCount: 0,
              toTurnCount: 1,
              diff: "safe diff",
              byteLength: 9,
              truncated: false,
            }),
      getFullThreadDiff: () =>
        Effect.succeed({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: "safe diff",
          byteLength: 9,
          truncated: false,
        }),
      getCompletedCaptureDiff: () => Effect.die("unused"),
    });

    const providerRegistry = ProviderRegistry.ProviderRegistry.of({
      getProviders: Effect.succeed([]),
      refresh: () => Effect.succeed([]),
      refreshInstance: () => Effect.succeed([]),
      getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
      setProviderMaintenanceActionState: () => Effect.succeed([]),
      streamChanges: Stream.empty,
    });
    const serverEnvironment = ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Test Cocoa",
        serverVersion: "1.0.0",
        platform: { os: "darwin", arch: "arm64" },
        capabilities: { repositoryIdentity: false },
      }),
    });
    const startup = ServerRuntimeStartup.ServerRuntimeStartup.of({
      awaitCommandReady: Effect.void,
      getCommandReadinessState: Effect.succeed("ready"),
      markHttpListening: Effect.void,
      enqueueCommand: (effect) => effect,
    });
    const terminals = TerminalManager.TerminalManager.of({
      open: () => Effect.die("unused"),
      attachStream: () => Effect.die("unused"),
      write: () => Effect.die("unused"),
      resize: () => Effect.die("unused"),
      clear: () => Effect.die("unused"),
      restart: () => Effect.die("unused"),
      close: () => Effect.void,
      subscribe: () => Effect.succeed(() => undefined),
      subscribeMetadata: () => Effect.succeed(() => undefined),
    });
    const checkpointRevertGate = CheckpointRevertGate.of({
      assertThreadAvailable: (candidateThreadId) =>
        options.revertBlocked === true
          ? Effect.fail(
              new CheckpointRevertGateBlockedError({
                threadId: candidateThreadId,
                sourceEventId: EventId.make("revert-gate-source"),
              }),
            )
          : Effect.void,
      isThreadBlocked: () => Effect.succeed(options.revertBlocked === true),
    });

    const layer = Layer.mergeAll(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projections),
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
      Layer.succeed(CheckpointDiffQuery.CheckpointDiffQuery, diffs),
      Layer.succeed(ProviderRegistry.ProviderRegistry, providerRegistry),
      Layer.succeed(ServerEnvironment.ServerEnvironment, serverEnvironment),
      Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, startup),
      Layer.succeed(TerminalManager.TerminalManager, terminals),
      Layer.succeed(CheckpointRevertGate, checkpointRevertGate),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "client-v1" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    return { live, latest, dispatched, layer };
  });

describe("Cocoa client v1 handlers", () => {
  it("keeps method inventory and authorization coverage exact", () => {
    expect(Object.keys(COCOA_CLIENT_V1_REQUIRED_SCOPES)).toEqual([
      ...COCOA_CLIENT_V1_SUPPORTED_METHODS,
    ]);
    expect(COCOA_CLIENT_V1_REQUIRED_SCOPES).toMatchObject({
      [COCOA_CLIENT_V1_METHODS.info]: AuthOrchestrationReadScope,
      [COCOA_CLIENT_V1_METHODS.probe]: AuthOrchestrationReadScope,
      [COCOA_CLIENT_V1_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
    });
    expect(
      Object.entries(COCOA_CLIENT_V1_REQUIRED_SCOPES)
        .filter(([method]) => method !== COCOA_CLIENT_V1_METHODS.dispatchCommand)
        .every(([, scope]) => scope === AuthOrchestrationReadScope),
    ).toBe(true);
  });

  it.effect("rejects a protocol range mismatch with the explicit negotiation error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const handlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
        Effect.provide(harness.layer),
      );
      const error = yield* handlers[COCOA_CLIENT_V1_METHODS.info]({
        protocolRange: { minimum: 2, maximum: 3 },
      }).pipe(Effect.flip);
      expect(error).toEqual({
        code: "protocol_version_mismatch",
        clientRange: { minimum: 2, maximum: 3 },
        serverRange: { minimum: 1, maximum: 1 },
        message: "The client and server do not support a common Cocoa protocol version.",
      });
    }),
  );

  it.effect("reports the negotiated v1 protocol and probe without optional workspace domains", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const handlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
        Effect.provide(harness.layer),
      );
      const info = yield* handlers[COCOA_CLIENT_V1_METHODS.info]({
        protocolRange: { minimum: 1, maximum: 1 },
      });
      expect(info).toMatchObject({
        protocolVersion: 1,
        protocolRange: { minimum: 1, maximum: 1 },
        environment: { environmentId: "environment-1", label: "Test Cocoa" },
        providers: [],
      });
      expect(info.capabilities).toEqual([
        "orchestration.core",
        "orchestration.resume",
        "orchestration.search",
        "orchestration.diff",
      ]);
      expect(yield* handlers[COCOA_CLIENT_V1_METHODS.probe]({})).toEqual({
        protocolVersion: 1,
      });
    }),
  );

  it.effect("authorizes dispatch separately and runs normalized commands through the engine", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const readHandlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
        Effect.provide(harness.layer),
      );
      const denied = yield* readHandlers[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
        type: "thread.archive",
        commandId: CommandId.make("archive-denied"),
        threadId,
      }).pipe(Effect.flip, Effect.provide(harness.layer));
      expect(denied).toMatchObject({
        code: "insufficient_scope",
        requiredScope: AuthOrchestrationOperateScope,
      });

      const handlers = yield* makeCocoaClientV1Handlers(operateSession).pipe(
        Effect.provide(harness.layer),
      );
      expect(
        yield* handlers[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
          type: "project.create",
          commandId: CommandId.make("project-create"),
          projectId,
          providerInstanceId: instanceId,
          title: "Remote Cocoa",
          workspaceRoot: " /remote/cocoa/ ",
          createdAt,
        }).pipe(Effect.provide(harness.layer)),
      ).toEqual({ sequence: 1 });
      const dispatched = yield* Ref.get(harness.dispatched);
      expect(dispatched[0]).toMatchObject({
        type: "project.create",
        workspaceRoot: "/remote/cocoa",
        createWorkspaceRootIfMissing: false,
      });

      expect(
        yield* handlers[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("checkpoint-revert"),
          threadId,
          turnCount: 1,
          createdAt,
        }).pipe(Effect.provide(harness.layer)),
      ).toEqual({ sequence: 2 });
      expect((yield* Ref.get(harness.dispatched))[1]).toMatchObject({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("checkpoint-revert"),
        threadId,
        turnCount: 1,
      });
    }),
  );

  it.effect("preserves a sanitized retryable busy dispatch rejection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ dispatchBusy: true });
      const handlers = yield* makeCocoaClientV1Handlers(operateSession).pipe(
        Effect.provide(harness.layer),
      );

      const error = yield* handlers[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
        type: "project.create",
        commandId: CommandId.make("project-create-busy"),
        projectId,
        providerInstanceId: instanceId,
        title: "Remote Cocoa",
        workspaceRoot: "/remote/cocoa",
        createdAt,
      }).pipe(Effect.flip, Effect.provide(harness.layer));

      expect(error).toEqual({
        code: "busy",
        message: "The Cocoa gateway is busy. Retry the same command shortly.",
        retryable: true,
      });
      expect(yield* Ref.get(harness.dispatched)).toEqual([]);
    }),
  );

  it.effect("maps engine-level revert isolation to a retryable busy rejection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ dispatchBlockedByRevert: true });
      const handlers = yield* makeCocoaClientV1Handlers(operateSession).pipe(
        Effect.provide(harness.layer),
      );

      const error = yield* handlers[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
        type: "thread.archive",
        commandId: CommandId.make("thread-archive-during-revert"),
        threadId,
      }).pipe(Effect.flip, Effect.provide(harness.layer));

      expect(error).toEqual({
        code: "busy",
        message: "The Cocoa gateway is busy. Retry the same command shortly.",
        retryable: true,
      });
      expect(yield* Ref.get(harness.dispatched)).toEqual([]);
    }),
  );

  it.effect("rejects turn starts and checkpoint reverts while a revert saga is active", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ revertBlocked: true });
      const handlers = yield* makeCocoaClientV1Handlers(operateSession).pipe(
        Effect.provide(harness.layer),
      );

      for (const command of [
        {
          type: "thread.turn.start" as const,
          commandId: CommandId.make("turn-start-during-revert"),
          threadId,
          message: {
            messageId: MessageId.make("message-during-revert"),
            role: "user" as const,
            text: "do work",
            attachments: [],
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdAt,
        },
        {
          type: "thread.checkpoint.revert" as const,
          commandId: CommandId.make("revert-during-revert"),
          threadId,
          turnCount: 0,
          createdAt,
        },
      ]) {
        const error = yield* handlers[COCOA_CLIENT_V1_METHODS.dispatchCommand](command).pipe(
          Effect.flip,
          Effect.provide(harness.layer),
        );
        expect(error).toEqual({
          code: "busy",
          message: "A checkpoint revert is already in progress for this thread.",
          retryable: true,
        });
      }
      expect(yield* Ref.get(harness.dispatched)).toEqual([]);
    }),
  );

  it.effect("returns explicit snapshots and a not-found error for missing threads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const handlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
        Effect.provide(harness.layer),
      );
      const snapshot = yield* handlers[COCOA_CLIENT_V1_METHODS.getShellSnapshot]({});
      expect(snapshot.snapshotSequence).toBe(5);
      expect(snapshot.projects[0]).toEqual(
        expect.objectContaining({ id: projectId, providerInstanceId: instanceId }),
      );

      const missing = yield* makeHarness({ thread: Option.none() });
      const missingHandlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
        Effect.provide(missing.layer),
      );
      expect(
        yield* missingHandlers[COCOA_CLIENT_V1_METHODS.getThreadSnapshot]({ threadId }).pipe(
          Effect.flip,
        ),
      ).toEqual({ code: "not_found", message: "The requested thread was not found." });
    }),
  );

  it.effect("attaches live thread delivery before a delayed snapshot and orders the marker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const snapshotStarted = yield* Deferred.make<void>();
        const finishSnapshot = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          loadShell: Deferred.succeed(snapshotStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishSnapshot)),
            Effect.as(shellSnapshot),
          ),
        });
        const handlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
          Effect.provide(harness.layer),
        );
        const collecting = yield* handlers[COCOA_CLIENT_V1_METHODS.subscribeShell]({
          requestCompletionMarker: true,
        }).pipe(Stream.take(3), Stream.runCollect, Effect.timeout("2 seconds"), Effect.forkChild);
        yield* Deferred.await(snapshotStarted);
        yield* PubSub.publish(harness.live, messageEvent(6, "during snapshot"));
        yield* Deferred.succeed(finishSnapshot, undefined);
        const items = Array.from(yield* Fiber.join(collecting));
        expect(items.map((item) => item.kind)).toEqual([
          "snapshot",
          "thread-upserted",
          "synchronized",
        ]);
      }),
    ),
  );

  it.effect("terminates an overflowing live tail and allows a fresh snapshot subscription", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const snapshotStarted = yield* Deferred.make<void>();
        const finishSnapshot = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          loadShell: Deferred.succeed(snapshotStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishSnapshot)),
            Effect.as(shellSnapshot),
          ),
        });
        const handlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
          Effect.provide(harness.layer),
        );
        const failedTail = yield* handlers[COCOA_CLIENT_V1_METHODS.subscribeShell]({}).pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.forkChild,
        );

        yield* Deferred.await(snapshotStarted);
        yield* Effect.forEach(
          Array.from(
            { length: DEFAULT_RUNTIME_BUFFER_LIMITS.clientLiveEvents + 1 },
            (_, index) => index + 6,
          ),
          (sequence) => PubSub.publish(harness.live, messageEvent(sequence, `burst-${sequence}`)),
          { discard: true },
        );
        yield* Deferred.succeed(finishSnapshot, undefined);

        expect(yield* Fiber.join(failedTail)).toEqual({
          code: "reset_required",
          message: "The live update buffer overflowed. Reconnect to load a fresh snapshot.",
          retryable: true,
        });

        const recovered = Array.from(
          yield* handlers[COCOA_CLIENT_V1_METHODS.subscribeShell]({}).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        );
        expect(recovered).toHaveLength(1);
        expect(recovered[0]?.kind).toBe("snapshot");
      }),
    ),
  );

  it.effect("dedupes replay/live overlap and resets stale cursors with a snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replayed = messageEvent(6, "replayed");
        const harness = yield* makeHarness({
          events: [replayed],
          livePrelude: [replayed],
          latestSequence: 6,
        });
        const handlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
          Effect.provide(harness.layer),
        );
        const collecting = yield* handlers[COCOA_CLIENT_V1_METHODS.subscribeThread]({
          threadId,
          afterSequence: 5,
          requestCompletionMarker: true,
        }).pipe(Stream.take(2), Stream.runCollect, Effect.timeout("2 seconds"), Effect.forkChild);
        const items = Array.from(yield* Fiber.join(collecting));
        expect(items.map((item) => item.kind)).toEqual(["event", "synchronized"]);
        expect(items.filter((item) => item.kind === "event")).toHaveLength(1);

        const stale = yield* makeHarness({
          latestSequence: COCOA_CLIENT_V1_RESUME_MAX_GAP + 10,
        });
        const staleHandlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
          Effect.provide(stale.layer),
        );
        const staleItems = Array.from(
          yield* staleHandlers[COCOA_CLIENT_V1_METHODS.subscribeThread]({
            threadId,
            afterSequence: 1,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect, Effect.timeout("2 seconds")),
        );
        expect(staleItems.map((item) => item.kind)).toEqual(["snapshot", "synchronized"]);
      }),
    ),
  );

  it.effect("sanitizes diff failures without leaking causes or paths", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ diffFailure: true });
      const handlers = yield* makeCocoaClientV1Handlers(readSession).pipe(
        Effect.provide(harness.layer),
      );
      const error = yield* handlers[COCOA_CLIENT_V1_METHODS.getTurnDiff]({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
      }).pipe(Effect.flip);
      expect(error).toEqual({
        code: "internal_error",
        message: "Failed to load the requested turn diff.",
      });
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("path");
      expect(error.message).not.toContain("/remote/cocoa");
    }),
  );
});
