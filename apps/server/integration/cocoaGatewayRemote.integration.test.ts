// @effect-diagnostics nodeBuiltinImport:off
/* eslint-disable t3code/no-manual-effect-runtime-in-tests -- The acceptance boundary intentionally tears down and recreates a runtime against the same SQLite database. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ThreadId,
  TurnId,
  type ProviderSession,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveCocoaGatewayProviderInstanceConfigMap } from "../src/cocoa/CocoaGatewayPolicy.ts";
import { deriveServerPaths, ServerConfig } from "../src/config.ts";
import * as GitWorkflowService from "../src/git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { TurnDispatchJournalRepositoryLive } from "../src/persistence/Layers/TurnDispatchJournal.ts";
import { TurnDispatchJournalRepository } from "../src/persistence/Services/TurnDispatchJournal.ts";
import * as ProjectWorkspace from "../src/project/ProjectWorkspace.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../src/provider/testUtils/providerRegistryMock.ts";
import {
  ProviderService,
  type ProviderAuthoritativeConversationSnapshot,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { TextGeneration, type TextGenerationShape } from "../src/textGeneration/TextGeneration.ts";
import { VcsStatusBroadcaster } from "../src/vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { ProviderCommandReactorLive } from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { CheckpointCoordinator } from "../src/orchestration/Services/CheckpointCoordinator.ts";
import { CheckpointRevertGate } from "../src/orchestration/Services/CheckpointRevertGate.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../src/orchestration/Services/ProviderCommandReactor.ts";

const CODEX = ProviderDriverKind.make("codex");
const MACBOOK = ProviderInstanceId.make("macbook_air");
const LINUX = ProviderInstanceId.make("linux_dev_box");
const REMOTE_WORKSPACE = "/srv/cocoa/shared-workspace";
const NOW = "2026-08-04T00:00:00.000Z";
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

const projectId = (value: string) => ProjectId.make(value);
const threadId = (value: string) => ThreadId.make(value);
const messageId = (value: string) => MessageId.make(value);

interface RemoteProviderState {
  readonly sessions: Map<ThreadId, ProviderSession>;
  readonly snapshots: Map<ThreadId, ProviderAuthoritativeConversationSnapshot>;
  readonly startCalls: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly cwd: string | undefined;
  }>;
  readonly sendCalls: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
  readonly authoritativeReadCalls: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
  readonly stopCalls: Array<ThreadId>;
  readonly interruptCalls: Array<ThreadId>;
  readonly sendGates: Map<ThreadId, Deferred.Deferred<void>>;
  readonly sendEntered: Map<ThreadId, Deferred.Deferred<void>>;
  readonly runtimeEvents: PubSub.PubSub<never>;
  localWorkspaceOperations: number;
}

const makeRemoteProviderState: Effect.Effect<RemoteProviderState> = Effect.gen(function* () {
  return {
    sessions: new Map(),
    snapshots: new Map(),
    startCalls: [],
    sendCalls: [],
    authoritativeReadCalls: [],
    stopCalls: [],
    interruptCalls: [],
    sendGates: new Map(),
    sendEntered: new Map(),
    runtimeEvents: yield* PubSub.unbounded<never>(),
    localWorkspaceOperations: 0,
  } satisfies RemoteProviderState;
});

const providerTurnId = (id: ThreadId) => TurnId.make(`provider-turn:${id}`);

const makeRemoteProviderService = (state: RemoteProviderState): ProviderServiceShape => {
  const unsupported = (operation: string) =>
    Effect.die(new Error(`Unexpected provider operation in gateway acceptance test: ${operation}`));

  return {
    startSession: (id, input) =>
      Effect.sync(() => {
        const providerInstanceId = input.providerInstanceId;
        if (providerInstanceId === undefined) {
          throw new Error("Gateway did not route the provider session to an explicit instance.");
        }
        const session: ProviderSession = {
          provider: CODEX,
          providerInstanceId,
          threadId: id,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.modelSelection?.model === undefined
            ? {}
            : { model: input.modelSelection.model }),
          resumeCursor: { threadId: String(id), providerInstanceId: String(providerInstanceId) },
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.sessions.set(id, session);
        state.startCalls.push({ threadId: id, providerInstanceId, cwd: input.cwd });
        return session;
      }),
    recoverSession: ({ threadId: id }) => {
      const session = state.sessions.get(id);
      return session === undefined ? unsupported("recoverSession") : Effect.succeed(session);
    },
    sendTurn: (input) =>
      Effect.gen(function* () {
        const session = state.sessions.get(input.threadId);
        if (session?.providerInstanceId === undefined) {
          return yield* Effect.die(
            new Error(`Missing explicitly routed session for '${input.threadId}'.`),
          );
        }
        state.sendCalls.push({
          threadId: input.threadId,
          providerInstanceId: session.providerInstanceId,
        });
        const entered = state.sendEntered.get(input.threadId);
        if (entered !== undefined) {
          yield* Deferred.succeed(entered, undefined);
        }
        const gate = state.sendGates.get(input.threadId);
        if (gate !== undefined) {
          yield* Deferred.await(gate);
        }
        return { threadId: input.threadId, turnId: providerTurnId(input.threadId) };
      }),
    interruptTurn: ({ threadId: id }) =>
      Effect.sync(() => {
        state.interruptCalls.push(id);
      }),
    respondToRequest: () => unsupported("respondToRequest"),
    respondToUserInput: () => unsupported("respondToUserInput"),
    stopSession: ({ threadId: id }) =>
      Effect.sync(() => {
        state.stopCalls.push(id);
      }),
    listSessions: () => Effect.succeed(Array.from(state.sessions.values())),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: CODEX,
        displayName: instanceId === MACBOOK ? "MacBook Air" : "Linux dev box",
        enabled: true,
        gatewayMcpMode: "inject",
        continuationIdentity: {
          driverKind: CODEX,
          continuationKey: `codex:endpoint:${instanceId}`,
        },
      }),
    rollbackConversation: () => unsupported("rollbackConversation"),
    inspectConversation: () => unsupported("inspectConversation"),
    readAuthoritativeConversation: (input) =>
      Effect.sync(() => {
        state.authoritativeReadCalls.push(input);
        return (
          state.snapshots.get(input.threadId) ?? {
            ...input,
            turns: [],
          }
        );
      }),
    rollbackConversationChecked: () => unsupported("rollbackConversationChecked"),
    streamEvents: Stream.fromPubSub(state.runtimeEvents),
  };
};

interface GatewayRuntime {
  readonly runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProjectionSnapshotQuery
    | ProviderCommandReactor
    | TurnDispatchJournalRepository,
    unknown
  >;
  readonly engine: OrchestrationEngineService["Service"];
  readonly projections: ProjectionSnapshotQuery["Service"];
  readonly reactor: ProviderCommandReactor["Service"];
  readonly journal: TurnDispatchJournalRepository["Service"];
  readonly scope: Scope.Closeable;
  readonly close: () => Promise<void>;
}

const makeGatewayRuntime = async (
  baseDir: string,
  dbPath: string,
  state: RemoteProviderState,
): Promise<GatewayRuntime> => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const projection = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(persistence),
  );
  const orchestration = OrchestrationEngineLive.pipe(
    Layer.provide(projection),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(persistence),
  );
  const journal = TurnDispatchJournalRepositoryLive.pipe(Layer.provide(persistence));
  const gatewayConfig = ServerConfig.layerTest("/gateway/has-no-provider-workspace", baseDir, {
    runtimeProfile: "cocoa-gateway",
  });
  const providerSnapshots = [MACBOOK, LINUX].map((instanceId) => ({ instanceId }));
  const remoteWorkspace = Layer.mock(ProjectWorkspace.ProjectWorkspace)({
    validateRoot: () => Effect.void,
  });
  const noLocalGit = Layer.succeed(GitWorkflowService.GitWorkflowService, {
    renameBranch: () =>
      Effect.sync(() => {
        state.localWorkspaceOperations += 1;
        throw new Error("Gateway attempted a local Git operation.");
      }),
  } as never);
  const noLocalVcs = Layer.succeed(VcsStatusBroadcaster, {
    refreshStatus: () =>
      Effect.sync(() => {
        state.localWorkspaceOperations += 1;
        throw new Error("Gateway attempted a local VCS operation.");
      }),
  } as never);
  const textGeneration = Layer.succeed(TextGeneration, {
    generateBranchName: () => Effect.succeed({ branch: "remote-change" }),
    generateThreadTitle: () => Effect.void,
  } as unknown as TextGenerationShape);
  const reactor = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(orchestration),
    Layer.provideMerge(projection),
    Layer.provideMerge(Layer.succeed(ProviderService, makeRemoteProviderService(state))),
    Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
    Layer.provideMerge(noLocalGit),
    Layer.provideMerge(noLocalVcs),
    Layer.provideMerge(textGeneration),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(remoteWorkspace),
    Layer.provideMerge(
      Layer.succeed(
        CheckpointCoordinator,
        CheckpointCoordinator.of({
          gateBaseline: () => Effect.succeed({ _tag: "NotApplicable", reason: "not_repository" }),
          recover: () => Effect.succeed([]),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        CheckpointRevertGate,
        CheckpointRevertGate.of({
          assertThreadAvailable: () => Effect.void,
          isThreadBlocked: () => Effect.succeed(false),
        }),
      ),
    ),
    Layer.provideMerge(journal),
    Layer.provide(gatewayConfig),
    Layer.provide(NodeServices.layer),
  );
  const layer = Layer.mergeAll(orchestration, projection, reactor, journal).pipe(
    Layer.provide(gatewayConfig),
    Layer.provide(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projections = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const providerCommandReactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
  const turnDispatchJournal = await runtime.runPromise(
    Effect.service(TurnDispatchJournalRepository),
  );
  const scope = await Effect.runPromise(Scope.make("sequential"));
  await runtime.runPromise(providerCommandReactor.start().pipe(Scope.provide(scope)));

  let closed = false;
  return {
    runtime,
    engine,
    projections,
    reactor: providerCommandReactor,
    journal: turnDispatchJournal,
    scope,
    close: async () => {
      if (closed) return;
      closed = true;
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
};

const createProjectAndThread = (
  engine: OrchestrationEngineService["Service"],
  input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly suffix: string;
  },
) =>
  Effect.gen(function* () {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${input.suffix}`),
      projectId: input.projectId,
      providerInstanceId: input.providerInstanceId,
      title: input.suffix,
      workspaceRoot: REMOTE_WORKSPACE,
      defaultModelSelection: {
        instanceId: input.providerInstanceId,
        model: "gpt-5.4",
      },
      createdAt: NOW,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${input.suffix}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.suffix,
      modelSelection: { instanceId: input.providerInstanceId, model: "gpt-5.4" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
  });

const startTurn = (engine: OrchestrationEngineService["Service"], id: ThreadId, suffix: string) =>
  engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`cmd-turn-${suffix}`),
    threadId: id,
    message: {
      messageId: messageId(`message-${suffix}`),
      role: "user",
      text: `turn for ${suffix}`,
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: NOW,
  });

it.live(
  "keeps remote turns routed and converges after client disconnect, restart, and endpoint replacement",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => ({
        baseDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cocoa-gateway-e2e-")),
        runtimes: [] as Array<GatewayRuntime>,
      })),
      ({ baseDir, runtimes }) =>
        Effect.gen(function* () {
          const settings = decodeServerSettings({
            providerInstances: {
              [MACBOOK]: {
                driver: "codex",
                config: {
                  endpointTransport: { type: "ssh-proxy", host: "192.168.20.99" },
                },
              },
              [LINUX]: {
                driver: "codex",
                config: {
                  endpointTransport: { type: "ssh-proxy", host: "rigatoni-alfredo" },
                },
              },
            },
            textGenerationModelSelection: { instanceId: MACBOOK, model: "gpt-5.4" },
          });
          const configured = yield* resolveCocoaGatewayProviderInstanceConfigMap(settings);
          expect(Object.keys(configured)).toEqual([MACBOOK, LINUX]);
          for (const instance of Object.values(configured)) {
            expect(instance.config).not.toHaveProperty("binaryPath");
            expect(instance.config).not.toHaveProperty("homePath");
          }

          const state = yield* makeRemoteProviderState;
          const { dbPath } = yield* deriveServerPaths(baseDir, undefined);
          const macThread = threadId("thread-macbook");
          const linuxThread = threadId("thread-linux");
          const macSendGate = yield* Deferred.make<void>();
          const macSendEntered = yield* Deferred.make<void>();
          state.sendGates.set(macThread, macSendGate);
          state.sendEntered.set(macThread, macSendEntered);

          let first = yield* Effect.promise(() => makeGatewayRuntime(baseDir, dbPath, state));
          runtimes.push(first);
          const clientScope = yield* Scope.make("sequential");
          yield* Stream.runDrain(first.engine.streamDomainEvents).pipe(Effect.forkIn(clientScope));

          yield* createProjectAndThread(first.engine, {
            projectId: projectId("project-macbook"),
            threadId: macThread,
            providerInstanceId: MACBOOK,
            suffix: "macbook",
          });
          yield* createProjectAndThread(first.engine, {
            projectId: projectId("project-linux"),
            threadId: linuxThread,
            providerInstanceId: LINUX,
            suffix: "linux",
          });

          yield* startTurn(first.engine, macThread, "macbook");
          yield* Deferred.await(macSendEntered);
          yield* Scope.close(clientScope, Exit.void);
          yield* Deferred.succeed(macSendGate, undefined);
          yield* first.reactor.drain;

          yield* startTurn(first.engine, linuxThread, "linux");
          yield* first.reactor.drain;

          expect(state.startCalls).toEqual([
            { threadId: macThread, providerInstanceId: MACBOOK, cwd: REMOTE_WORKSPACE },
            { threadId: linuxThread, providerInstanceId: LINUX, cwd: REMOTE_WORKSPACE },
          ]);
          expect(state.sendCalls).toEqual([
            { threadId: macThread, providerInstanceId: MACBOOK },
            { threadId: linuxThread, providerInstanceId: LINUX },
          ]);
          expect(state.stopCalls).toEqual([]);
          expect(state.interruptCalls).toEqual([]);
          assert.strictEqual(state.localWorkspaceOperations, 0);

          const linuxTurnId = providerTurnId(linuxThread);
          yield* first.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-linux-running"),
            threadId: linuxThread,
            session: {
              threadId: linuxThread,
              status: "running",
              providerName: CODEX,
              providerInstanceId: LINUX,
              runtimeMode: "approval-required",
              activeTurnId: linuxTurnId,
              lastError: null,
              updatedAt: NOW,
            },
            createdAt: NOW,
          });
          yield* first.engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make("cmd-linux-partial"),
            threadId: linuxThread,
            messageId: messageId("assistant:linux-final"),
            delta: "partial",
            turnId: linuxTurnId,
            createdAt: NOW,
          });

          state.snapshots.set(macThread, {
            threadId: macThread,
            providerInstanceId: MACBOOK,
            turns: [
              {
                id: providerTurnId(macThread),
                status: "running",
                completedAt: null,
                assistantMessages: [],
                finalAssistantItemId: null,
                finalAssistantText: null,
                hasNonrecoverableActivityGap: false,
              },
            ],
          });
          state.snapshots.set(linuxThread, {
            threadId: linuxThread,
            providerInstanceId: LINUX,
            turns: [
              {
                id: linuxTurnId,
                status: "running",
                completedAt: null,
                assistantMessages: [],
                finalAssistantItemId: null,
                finalAssistantText: null,
                hasNonrecoverableActivityGap: false,
              },
            ],
          });

          yield* Effect.promise(() => first.close());
          first = yield* Effect.promise(() => makeGatewayRuntime(baseDir, dbPath, state));
          runtimes.push(first);
          const restarted = yield* first.projections.getSnapshot();
          expect(
            restarted.projects
              .map((project) => [project.id, project.workspaceRoot])
              .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
          ).toEqual([
            [projectId("project-linux"), REMOTE_WORKSPACE],
            [projectId("project-macbook"), REMOTE_WORKSPACE],
          ]);

          state.snapshots.set(linuxThread, {
            threadId: linuxThread,
            providerInstanceId: LINUX,
            turns: [
              {
                id: linuxTurnId,
                status: "completed",
                completedAt: null,
                assistantMessages: [
                  {
                    itemId: "linux-commentary",
                    text: "offline commentary",
                    phase: "commentary",
                  },
                  {
                    itemId: "linux-final",
                    text: "partial and recovered",
                    phase: "final_answer",
                  },
                ],
                finalAssistantItemId: "linux-final",
                finalAssistantText: "partial and recovered",
                hasNonrecoverableActivityGap: true,
              },
            ],
          });

          // This is the exact instance-scoped recovery hook invoked when a replacement
          // endpoint generation becomes ready. Repeating it proves duplicate finals are inert.
          yield* first.reactor.recover(LINUX);
          yield* first.reactor.drain;
          yield* first.reactor.recover(LINUX);
          yield* first.reactor.drain;

          const completed = (yield* first.projections.getSnapshot()).threads.find(
            (thread) => thread.id === linuxThread,
          );
          expect(
            completed?.messages
              .filter((message) => message.id.startsWith("assistant:"))
              .map((message) => ({
                id: message.id,
                text: message.text,
                streaming: message.streaming,
              })),
          ).toEqual([
            {
              id: messageId("assistant:linux-commentary"),
              text: "offline commentary",
              streaming: false,
            },
            {
              id: messageId("assistant:linux-final"),
              text: "partial and recovered",
              streaming: false,
            },
          ]);
          expect(completed?.latestTurn).toMatchObject({
            turnId: linuxTurnId,
            state: "completed",
          });
          expect(
            completed?.activities.filter(
              (activity) => activity.kind === "provider.reconciliation.gap",
            ),
          ).toHaveLength(1);
          const events = Array.from(yield* Stream.runCollect(first.engine.readEvents(0, 200)));
          expect(
            events.filter(
              (event) =>
                event.type === "thread.turn-completed" && event.payload.threadId === linuxThread,
            ),
          ).toHaveLength(1);
          expect(state.sendCalls.filter((call) => call.threadId === linuxThread)).toHaveLength(1);
          expect(
            state.authoritativeReadCalls.filter(
              (call) => call.providerInstanceId === LINUX && call.threadId === linuxThread,
            ).length,
          ).toBeGreaterThanOrEqual(2);
          assert.strictEqual(state.localWorkspaceOperations, 0);
          yield* Effect.promise(() => first.close());
        }).pipe(Effect.provide(NodeServices.layer)),
      ({ baseDir, runtimes }) =>
        Effect.promise(async () => {
          await Promise.all(runtimes.map((runtime) => runtime.close()));
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }),
    ),
);
