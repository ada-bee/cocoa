/* eslint-disable t3code/no-manual-effect-runtime-in-tests -- The acceptance boundary intentionally tears down and recreates a runtime against the same SQLite database. */
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  AuthSessionId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ServerSettings,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { COCOA_CLIENT_V1_METHODS, CocoaClientV1RpcGroup } from "@t3tools/contracts/client/v1";
import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as SessionStore from "../src/auth/SessionStore.ts";
import * as CheckpointDiffQuery from "../src/checkpointing/CheckpointDiffQuery.ts";
import { cocoaClientV1WebSocketRouteLayer } from "../src/clientApi/v1/Route.ts";
import { resolveCocoaGatewayProviderInstanceConfigMap } from "../src/cocoa/CocoaGatewayPolicy.ts";
import { deriveServerPaths, ServerConfig } from "../src/config.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../src/git/GitWorkflowService.ts";
import { staticAndDevRouteLayer } from "../src/http.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { TurnDispatchJournalRepositoryLive } from "../src/persistence/Layers/TurnDispatchJournal.ts";
import { TurnDispatchJournalRepository } from "../src/persistence/Services/TurnDispatchJournal.ts";
import * as ProjectWorkspace from "../src/project/ProjectWorkspace.ts";
import * as ProjectExecution from "../src/project/ProjectExecution.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import * as ProviderFilesystemBrowse from "../src/provider/ProviderFilesystemBrowse.ts";
import {
  ProviderWorkspaceReadByteLimit,
  type ProviderWorkspaceAdapter,
} from "../src/provider/ProviderWorkspaceAdapter.ts";
import type {
  ProviderInstance,
  ProviderInstanceGenerationState,
} from "../src/provider/ProviderDriver.ts";
import { makeProviderRegistryLayer } from "../src/provider/testUtils/providerRegistryMock.ts";
import * as ProviderInstanceRegistry from "../src/provider/Services/ProviderInstanceRegistry.ts";
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
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { CheckpointRevertReactor } from "../src/orchestration/Services/CheckpointRevertReactor.ts";
import { CheckpointCoordinator } from "../src/orchestration/Services/CheckpointCoordinator.ts";
import { CheckpointRevertGate } from "../src/orchestration/Services/CheckpointRevertGate.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { PostTurnCheckpointReactor } from "../src/orchestration/Services/PostTurnCheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../src/orchestration/Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../src/orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProviderGenerationRecoveryReactorLive } from "../src/provider/Layers/ProviderGenerationRecoveryReactor.ts";
import { ProviderGenerationRecoveryReactor } from "../src/provider/Services/ProviderGenerationRecoveryReactor.ts";
import { ProviderSessionDirectory } from "../src/provider/Services/ProviderSessionDirectory.ts";
import * as ServerRuntimeStartup from "../src/serverRuntimeStartup.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";

const CODEX = ProviderDriverKind.make("codex");
const MACBOOK = ProviderInstanceId.make("macbook_air");
const LINUX = ProviderInstanceId.make("linux_dev_box");
const REMOTE_WORKSPACE = "/srv/cocoa/shared-workspace";
const NOW = "2026-08-04T00:00:00.000Z";
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const ENVIRONMENT_ID = EnvironmentId.make("cocoa-full-topology");
const CLIENT_SESSION_ID = AuthSessionId.make("cocoa-full-topology-client");
const APPROVAL_ID = ApprovalRequestId.make("approval-after-disconnect");
const USER_INPUT_ID = ApprovalRequestId.make("input-after-disconnect");
const RUNTIME_APPROVAL_ID = RuntimeRequestId.make(APPROVAL_ID);
const RUNTIME_USER_INPUT_ID = RuntimeRequestId.make(USER_INPUT_ID);

const operateSession: EnvironmentAuth.AuthenticatedSession = {
  sessionId: CLIENT_SESSION_ID,
  subject: "full-topology-client",
  method: "bearer-access-token",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthTerminalOperateScope],
};

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
  readonly recoverCalls: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
  readonly recoverEntered: Map<ProviderInstanceId, Deferred.Deferred<void>>;
  readonly approvalResponses: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly requestId: ApprovalRequestId;
    readonly decision: string;
  }>;
  readonly userInputResponses: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly requestId: ApprovalRequestId;
    readonly answers: Readonly<Record<string, unknown>>;
  }>;
  readonly authoritativeReadCalls: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
  readonly authoritativeReadEntered: Map<ProviderInstanceId, Deferred.Deferred<void>>;
  readonly stopCalls: Array<ThreadId>;
  readonly interruptCalls: Array<ThreadId>;
  readonly sendGates: Map<ThreadId, Deferred.Deferred<void>>;
  readonly sendEntered: Map<ThreadId, Deferred.Deferred<void>>;
  readonly runtimeEvents: PubSub.PubSub<ProviderRuntimeEvent>;
  readonly generationState: Map<ProviderInstanceId, Ref.Ref<ProviderInstanceGenerationState>>;
  readonly generationChanges: Map<
    ProviderInstanceId,
    PubSub.PubSub<ProviderInstanceGenerationState>
  >;
  readonly registryChanges: PubSub.PubSub<void>;
  readonly workspaceCalls: Array<{
    readonly operation: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly workspaceRoot?: string;
    readonly relativePath?: string;
  }>;
  readonly executionCalls: Array<{
    readonly providerInstanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly command: ReadonlyArray<string>;
  }>;
  readonly diffCalls: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
  localWorkspaceOperations: number;
  localTerminalOperations: number;
  providerSpawnOperations: number;
}

const makeRemoteProviderState: Effect.Effect<RemoteProviderState> = Effect.gen(function* () {
  const generationState = new Map<ProviderInstanceId, Ref.Ref<ProviderInstanceGenerationState>>();
  const generationChanges = new Map<
    ProviderInstanceId,
    PubSub.PubSub<ProviderInstanceGenerationState>
  >();
  for (const providerInstanceId of [MACBOOK, LINUX]) {
    generationState.set(
      providerInstanceId,
      yield* Ref.make<ProviderInstanceGenerationState>({
        _tag: "Ready",
        providerInstanceId,
        generationId: 1,
      }),
    );
    generationChanges.set(
      providerInstanceId,
      yield* PubSub.unbounded<ProviderInstanceGenerationState>(),
    );
  }
  return {
    sessions: new Map(),
    snapshots: new Map(),
    startCalls: [],
    sendCalls: [],
    recoverCalls: [],
    recoverEntered: new Map(),
    approvalResponses: [],
    userInputResponses: [],
    authoritativeReadCalls: [],
    authoritativeReadEntered: new Map(),
    stopCalls: [],
    interruptCalls: [],
    sendGates: new Map(),
    sendEntered: new Map(),
    runtimeEvents: yield* PubSub.unbounded<ProviderRuntimeEvent>(),
    generationState,
    generationChanges,
    registryChanges: yield* PubSub.unbounded<void>(),
    workspaceCalls: [],
    executionCalls: [],
    diffCalls: [],
    localWorkspaceOperations: 0,
    localTerminalOperations: 0,
    providerSpawnOperations: 0,
  } satisfies RemoteProviderState;
});

const providerTurnId = (id: ThreadId) => TurnId.make(`provider-turn:${id}`);

const publishRuntimeEvent = (state: RemoteProviderState, event: ProviderRuntimeEvent) =>
  PubSub.publish(state.runtimeEvents, event).pipe(Effect.asVoid);

const setGeneration = (state: RemoteProviderState, generation: ProviderInstanceGenerationState) =>
  Effect.gen(function* () {
    const current = state.generationState.get(generation.providerInstanceId);
    const changes = state.generationChanges.get(generation.providerInstanceId);
    assert.isDefined(current);
    assert.isDefined(changes);
    yield* Ref.set(current!, generation);
    yield* PubSub.publish(changes!, generation);
  });

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
    recoverSession: ({ threadId: id, providerInstanceId }) => {
      const session = state.sessions.get(id);
      if (session === undefined || session.providerInstanceId !== providerInstanceId) {
        return unsupported("recoverSession");
      }
      return Effect.sync(() => {
        state.recoverCalls.push({ threadId: id, providerInstanceId });
        return session;
      }).pipe(
        Effect.tap(() => {
          const entered = state.recoverEntered.get(providerInstanceId);
          return entered === undefined ? Effect.void : Deferred.succeed(entered, undefined);
        }),
      );
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
    respondToRequest: (input) =>
      Effect.sync(() => {
        const providerInstanceId = state.sessions.get(input.threadId)?.providerInstanceId;
        if (providerInstanceId === undefined) {
          throw new Error(`Missing provider session for approval '${input.requestId}'.`);
        }
        state.approvalResponses.push({
          threadId: input.threadId,
          providerInstanceId,
          requestId: input.requestId,
          decision: input.decision,
        });
      }),
    respondToUserInput: (input) =>
      Effect.sync(() => {
        const providerInstanceId = state.sessions.get(input.threadId)?.providerInstanceId;
        if (providerInstanceId === undefined) {
          throw new Error(`Missing provider session for input '${input.requestId}'.`);
        }
        state.userInputResponses.push({
          threadId: input.threadId,
          providerInstanceId,
          requestId: input.requestId,
          answers: input.answers,
        });
      }),
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
      }).pipe(
        Effect.tap(() => {
          const entered = state.authoritativeReadEntered.get(input.providerInstanceId);
          return entered === undefined ? Effect.void : Deferred.succeed(entered, undefined);
        }),
      ),
    rollbackConversationChecked: () => unsupported("rollbackConversationChecked"),
    streamEvents: Stream.fromPubSub(state.runtimeEvents),
  };
};

const makeWorkspaceAdapter = (
  state: RemoteProviderState,
  providerInstanceId: ProviderInstanceId,
): ProviderWorkspaceAdapter => ({
  browseDirectory: ({ locator }) =>
    Effect.sync(() => {
      state.workspaceCalls.push({ operation: "browse", providerInstanceId });
      return {
        directoryPath:
          locator.kind === "absolute" ? locator.path : `/home/remote/${locator.relativePath}`,
        parentPath: null,
        entries: [
          { name: `${providerInstanceId}-workspace`, kind: "directory" as const },
          { name: "ignored-file", kind: "file" as const },
        ],
        truncated: false,
      };
    }),
  openRoot: (workspaceRoot) =>
    workspaceRoot !== REMOTE_WORKSPACE
      ? Effect.die(new Error(`Gateway changed remote root to '${workspaceRoot}'.`))
      : Effect.sync(() => {
          state.workspaceCalls.push({
            operation: "openRoot",
            providerInstanceId,
            workspaceRoot,
          });
          return {
            getMetadata: ({ relativePath }) =>
              Effect.sync(() => {
                state.workspaceCalls.push({
                  operation: "metadata",
                  providerInstanceId,
                  relativePath,
                });
                return { kind: "file" as const, size: 32 };
              }),
            listDirectory: ({ relativePath }) =>
              Effect.sync(() => {
                state.workspaceCalls.push({
                  operation: "listDirectory",
                  providerInstanceId,
                  relativePath,
                });
                return {
                  entries: [{ name: `${providerInstanceId}.md`, kind: "file" as const }],
                  truncated: false,
                };
              }),
            listEntries: ({ relativePath }) =>
              Effect.sync(() => {
                state.workspaceCalls.push({
                  operation: "listEntries",
                  providerInstanceId,
                  relativePath,
                });
                return {
                  entries: [{ path: `${providerInstanceId}.md`, kind: "file" as const }],
                  truncated: false,
                };
              }),
            readFile: ({ relativePath, maxBytes }) =>
              Effect.sync(() => {
                state.workspaceCalls.push({
                  operation: "readFile",
                  providerInstanceId,
                  relativePath,
                });
                const bytes = new TextEncoder().encode(`${providerInstanceId}:${relativePath}`);
                const visible = bytes.slice(0, maxBytes);
                return {
                  bytes: visible,
                  byteLength: bytes.byteLength,
                  truncated: visible.byteLength < bytes.byteLength,
                };
              }),
          };
        }),
});

const makeProviderInstances = (state: RemoteProviderState): ReadonlyArray<ProviderInstance> =>
  [MACBOOK, LINUX].map((providerInstanceId) => {
    const current = state.generationState.get(providerInstanceId);
    const changes = state.generationChanges.get(providerInstanceId);
    assert.isDefined(current);
    assert.isDefined(changes);
    return {
      instanceId: providerInstanceId,
      driverKind: CODEX,
      continuationIdentity: {
        driverKind: CODEX,
        continuationKey: `codex:endpoint:${providerInstanceId}`,
      },
      displayName: providerInstanceId === MACBOOK ? "MacBook Air" : "Linux dev box",
      enabled: true,
      gatewayMcpMode: "unavailable",
      generationLifecycle: {
        getCurrent: Ref.get(current!),
        subscribeChanges: PubSub.subscribe(changes!),
      },
      workspace: makeWorkspaceAdapter(state, providerInstanceId),
      execution: {
        execute: (input) =>
          Effect.sync(() => {
            state.executionCalls.push({
              providerInstanceId,
              cwd: input.cwd,
              command: input.command,
            });
            return {
              exitCode: 0,
              stdout: `${providerInstanceId}:${input.command.join(" ")}`,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      },
      snapshot: {} as ProviderInstance["snapshot"],
      adapter: {} as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    } satisfies ProviderInstance;
  });

const makeProviderInstanceRegistryLayer = (state: RemoteProviderState) => {
  const instances = makeProviderInstances(state);
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
  return Layer.succeed(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
    ProviderInstanceRegistry.ProviderInstanceRegistry.of({
      getInstance: (instanceId) => Effect.succeed(byId.get(instanceId)),
      listInstances: Effect.succeed(instances),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.fromPubSub(state.registryChanges),
      subscribeChanges: PubSub.subscribe(state.registryChanges),
    }),
  );
};

interface GatewayRuntime {
  readonly runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProjectionSnapshotQuery
    | ProviderCommandReactor
    | ProviderRuntimeIngestionService
    | ProviderGenerationRecoveryReactor
    | TurnDispatchJournalRepository
    | ProjectWorkspace.ProjectWorkspace
    | ProjectExecution.ProjectExecution
    | ProviderFilesystemBrowse.ProviderFilesystemBrowse
    | HttpServer.HttpServer,
    unknown
  >;
  readonly engine: OrchestrationEngineService["Service"];
  readonly projections: ProjectionSnapshotQuery["Service"];
  readonly reactor: ProviderCommandReactor["Service"];
  readonly ingestion: ProviderRuntimeIngestionService["Service"];
  readonly journal: TurnDispatchJournalRepository["Service"];
  readonly projectWorkspace: ProjectWorkspace.ProjectWorkspace["Service"];
  readonly projectExecution: ProjectExecution.ProjectExecution["Service"];
  readonly filesystemBrowse: ProviderFilesystemBrowse.ProviderFilesystemBrowse["Service"];
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly scope: Scope.Closeable;
  readonly close: () => Promise<void>;
}

const makeCocoaClientV1RpcClient = RpcClient.make(CocoaClientV1RpcGroup);
type CocoaClientV1RpcClient =
  typeof makeCocoaClientV1RpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const rpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(wsUrl).pipe(
        Layer.provide(
          Layer.succeed(
            Socket.WebSocketConstructor,
            (url, protocols) =>
              new NodeSocket.NodeWS.WebSocket(url, protocols) as unknown as globalThis.WebSocket,
          ),
        ),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

const withCocoaClient = <A, E, R>(
  wsUrl: string,
  use: (client: CocoaClientV1RpcClient) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    makeCocoaClientV1RpcClient.pipe(Effect.flatMap(use), Effect.provide(rpcProtocolLayer(wsUrl))),
  );

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
  const baseGatewayConfig = ServerConfig.layerTest("/gateway/has-no-provider-workspace", baseDir, {
    runtimeProfile: "cocoa-gateway",
  });
  const gatewayConfig = Layer.effect(
    ServerConfig,
    ServerConfig.pipe(
      Effect.map((config) => ({ ...config, staticDir: NodePath.join(baseDir, "web") })),
    ),
  ).pipe(Layer.provide(baseGatewayConfig));
  const providerSnapshots = [MACBOOK, LINUX].map((instanceId) => ({
    instanceId,
    driver: CODEX,
    displayName: instanceId === MACBOOK ? "MacBook Air" : "Linux dev box",
    enabled: true,
    installed: true,
    version: "0.146.0",
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: NOW,
    availability: "available" as const,
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  }));
  const providerService = Layer.succeed(ProviderService, makeRemoteProviderService(state));
  const providerRegistry = makeProviderRegistryLayer(providerSnapshots);
  const providerInstances = makeProviderInstanceRegistryLayer(state);
  const remoteWorkspace = ProjectWorkspace.layer.pipe(
    Layer.provide(providerInstances),
    Layer.provide(projection),
  );
  const remoteExecution = ProjectExecution.layer.pipe(
    Layer.provide(providerInstances),
    Layer.provide(projection),
  );
  const remoteBrowse = ProviderFilesystemBrowse.layer.pipe(Layer.provide(providerInstances));
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
    Layer.provideMerge(providerService),
    Layer.provideMerge(providerRegistry),
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
  const settings = ServerSettingsService.layerTest();
  const ingestion = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(orchestration),
    Layer.provideMerge(projection),
    Layer.provideMerge(providerService),
    Layer.provideMerge(settings),
    Layer.provide(persistence),
  );
  const sessionDirectory = Layer.succeed(
    ProviderSessionDirectory,
    ProviderSessionDirectory.of({
      upsert: () => Effect.void,
      getProvider: (id) => Effect.succeed(state.sessions.get(id)?.provider ?? CODEX),
      getBinding: (id) =>
        Effect.succeed(
          Option.fromNullishOr(state.sessions.get(id)).pipe(
            Option.map((session) => ({
              threadId: id,
              provider: session.provider,
              ...(session.providerInstanceId === undefined
                ? {}
                : { providerInstanceId: session.providerInstanceId }),
              status: "running" as const,
              resumeCursor: session.resumeCursor,
              runtimeMode: session.runtimeMode,
            })),
          ),
        ),
      listThreadIds: () => Effect.succeed(Array.from(state.sessions.keys())),
      listBindings: () =>
        Effect.succeed(
          Array.from(state.sessions, ([threadId, session]) => ({
            threadId,
            provider: session.provider,
            ...(session.providerInstanceId === undefined
              ? {}
              : { providerInstanceId: session.providerInstanceId }),
            status: "running" as const,
            resumeCursor: session.resumeCursor,
            runtimeMode: session.runtimeMode,
            lastSeenAt: NOW,
          })),
        ),
    }),
  );
  const postTurnCheckpoint = Layer.succeed(PostTurnCheckpointReactor, {
    processTurnCompleted: () => Effect.die("gateway attempted local checkpoint processing"),
    recover: () => Effect.succeed([]),
    start: () => Effect.void,
    drain: Effect.void,
  });
  const checkpointRevert = Layer.succeed(CheckpointRevertReactor, {
    process: () => Effect.die("gateway attempted local checkpoint revert"),
    recover: () => Effect.succeed([]),
    start: () => Effect.void,
    drain: Effect.void,
  });
  const generationRecovery = ProviderGenerationRecoveryReactorLive.pipe(
    Layer.provideMerge(providerInstances),
    Layer.provideMerge(sessionDirectory),
    Layer.provideMerge(providerService),
    Layer.provideMerge(reactor),
    Layer.provideMerge(postTurnCheckpoint),
    Layer.provideMerge(checkpointRevert),
  );
  const gate = Layer.succeed(
    CheckpointRevertGate,
    CheckpointRevertGate.of({
      assertThreadAvailable: () => Effect.void,
      isThreadBlocked: () => Effect.succeed(false),
    }),
  );
  const diffQuery = Layer.effect(
    CheckpointDiffQuery.CheckpointDiffQuery,
    Effect.gen(function* () {
      const snapshots = yield* ProjectionSnapshotQuery;
      const resolveProvider = Effect.fn("acceptance.resolveDiffProvider")(function* (id: ThreadId) {
        const snapshot = yield* snapshots.getSnapshot();
        const thread = snapshot.threads.find((candidate) => candidate.id === id);
        const project = snapshot.projects.find((candidate) => candidate.id === thread?.projectId);
        if (project === undefined) return yield* Effect.die("missing diff project binding");
        state.diffCalls.push({ threadId: id, providerInstanceId: project.providerInstanceId });
        return project.providerInstanceId;
      });
      return CheckpointDiffQuery.CheckpointDiffQuery.of({
        getTurnDiff: (input) =>
          resolveProvider(input.threadId).pipe(
            Effect.map((providerInstanceId) => {
              const diff = `diff --provider ${providerInstanceId}\n`;
              return {
                threadId: input.threadId,
                fromTurnCount: input.fromTurnCount,
                toTurnCount: input.toTurnCount,
                diff,
                byteLength: new TextEncoder().encode(diff).byteLength,
                truncated: false,
              };
            }),
          ),
        getFullThreadDiff: (input) =>
          resolveProvider(input.threadId).pipe(
            Effect.map((providerInstanceId) => {
              const diff = `diff --provider ${providerInstanceId}\n`;
              return {
                threadId: input.threadId,
                fromTurnCount: 0,
                toTurnCount: input.toTurnCount,
                diff,
                byteLength: new TextEncoder().encode(diff).byteLength,
                truncated: false,
              };
            }),
          ),
        getCompletedCaptureDiff: () => Effect.die("unused completed capture diff"),
      });
    }),
  ).pipe(Layer.provide(projection));
  const environment = Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
      getDescriptor: Effect.succeed({
        environmentId: ENVIRONMENT_ID,
        label: "Cocoa full topology",
        serverVersion: "1.0.0",
        platform: { os: "linux", arch: "arm64" },
        capabilities: { repositoryIdentity: false },
      }),
    }),
  );
  const startup = Layer.succeed(
    ServerRuntimeStartup.ServerRuntimeStartup,
    ServerRuntimeStartup.ServerRuntimeStartup.of({
      awaitCommandReady: Effect.void,
      getCommandReadinessState: Effect.succeed("ready"),
      markHttpListening: Effect.void,
      enqueueCommand: (effect) => effect,
    }),
  );
  const terminals = Layer.succeed(
    TerminalManager.TerminalManager,
    TerminalManager.TerminalManager.of({
      open: () =>
        Effect.sync(() => {
          state.localTerminalOperations += 1;
          throw new Error("gateway attempted to open a local PTY");
        }),
      attachStream: () => Effect.die("gateway attempted to attach a local PTY"),
      write: () => Effect.die("gateway attempted to write a local PTY"),
      resize: () => Effect.die("gateway attempted to resize a local PTY"),
      clear: () => Effect.die("gateway attempted to clear a local PTY"),
      restart: () => Effect.die("gateway attempted to restart a local PTY"),
      close: () => Effect.void,
      subscribe: () => Effect.succeed(() => undefined),
      subscribeMetadata: () => Effect.succeed(() => undefined),
    }),
  );
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateWebSocketUpgrade: () => Effect.succeed(operateSession),
  });
  const sessions = Layer.mock(SessionStore.SessionStore)({
    cookieName: "cocoa-full-topology",
    markConnected: () => Effect.void,
    markDisconnected: () => Effect.void,
  });
  const handlerDependencies = Layer.mergeAll(
    orchestration,
    projection,
    gate,
    diffQuery,
    providerRegistry,
    environment,
    startup,
    terminals,
    remoteExecution,
    auth,
    sessions,
  );
  const routes = Layer.mergeAll(cocoaClientV1WebSocketRouteLayer, staticAndDevRouteLayer);
  const servedRoutes = HttpRouter.serve(routes, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(handlerDependencies),
    Layer.provide(gatewayConfig),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
  const poisonSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        state.providerSpawnOperations += 1;
        throw new Error("gateway attempted to spawn a provider process");
      }),
    ),
  );
  const layer = Layer.mergeAll(
    orchestration,
    projection,
    reactor,
    ingestion,
    generationRecovery,
    journal,
    remoteWorkspace,
    remoteExecution,
    remoteBrowse,
  ).pipe(
    Layer.provideMerge(servedRoutes),
    Layer.provideMerge(poisonSpawner),
    Layer.provide(gatewayConfig),
    Layer.provide(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projections = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const providerCommandReactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
  const providerRuntimeIngestion = await runtime.runPromise(
    Effect.service(ProviderRuntimeIngestionService),
  );
  const providerGenerationRecovery = await runtime.runPromise(
    Effect.service(ProviderGenerationRecoveryReactor),
  );
  const turnDispatchJournal = await runtime.runPromise(
    Effect.service(TurnDispatchJournalRepository),
  );
  const projectWorkspace = await runtime.runPromise(
    Effect.service(ProjectWorkspace.ProjectWorkspace),
  );
  const projectExecution = await runtime.runPromise(
    Effect.service(ProjectExecution.ProjectExecution),
  );
  const filesystemBrowse = await runtime.runPromise(
    Effect.service(ProviderFilesystemBrowse.ProviderFilesystemBrowse),
  );
  const httpServer = await runtime.runPromise(Effect.service(HttpServer.HttpServer));
  const address = httpServer.address as HttpServer.TcpAddress;
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/api/client/v1/ws`;
  const scope = await Effect.runPromise(Scope.make("sequential"));
  await runtime.runPromise(providerCommandReactor.start().pipe(Scope.provide(scope)));
  await runtime.runPromise(providerRuntimeIngestion.start().pipe(Scope.provide(scope)));
  await runtime.runPromise(providerGenerationRecovery.start().pipe(Scope.provide(scope)));

  let closed = false;
  return {
    runtime,
    engine,
    projections,
    reactor: providerCommandReactor,
    ingestion: providerRuntimeIngestion,
    journal: turnDispatchJournal,
    projectWorkspace,
    projectExecution,
    filesystemBrowse,
    httpUrl,
    wsUrl,
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
  client: CocoaClientV1RpcClient,
  input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly suffix: string;
  },
) =>
  Effect.gen(function* () {
    yield* client[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
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
    yield* client[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
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

const startTurn = (client: CocoaClientV1RpcClient, id: ThreadId, suffix: string) =>
  client[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
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
                  endpointTransport: {
                    type: "cocoa-host",
                    url: "wss://macaroni.test:4500",
                    key: "test_host_key",
                  },
                },
              },
              [LINUX]: {
                driver: "codex",
                config: {
                  endpointTransport: {
                    type: "cocoa-host",
                    url: "wss://rigatoni-alfredo.test:4500",
                    key: "test_host_key",
                  },
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
          NodeFS.mkdirSync(NodePath.join(baseDir, "web"), { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(baseDir, "web", "index.html"),
            "<main>Cocoa full topology</main>",
            "utf8",
          );
          const macThread = threadId("thread-macbook");
          const linuxThread = threadId("thread-linux");
          const macSendGate = yield* Deferred.make<void>();
          const macSendEntered = yield* Deferred.make<void>();
          state.sendGates.set(macThread, macSendGate);
          state.sendEntered.set(macThread, macSendEntered);

          let first = yield* Effect.promise(() => makeGatewayRuntime(baseDir, dbPath, state));
          runtimes.push(first);
          expect(
            // @effect-diagnostics-next-line globalFetchInEffect:off
            yield* Effect.promise(() => fetch(first.httpUrl).then((response) => response.text())),
          ).toContain("Cocoa full topology");

          yield* withCocoaClient(first.wsUrl, (client) =>
            Effect.gen(function* () {
              const info = yield* client[COCOA_CLIENT_V1_METHODS.info]({
                protocolRange: { minimum: 1, maximum: 1 },
              });
              expect(info.providers.map((provider) => provider.instanceId)).toEqual([
                MACBOOK,
                LINUX,
              ]);
              yield* createProjectAndThread(client, {
                projectId: projectId("project-macbook"),
                threadId: macThread,
                providerInstanceId: MACBOOK,
                suffix: "macbook",
              });
              yield* createProjectAndThread(client, {
                projectId: projectId("project-linux"),
                threadId: linuxThread,
                providerInstanceId: LINUX,
                suffix: "linux",
              });
              const shell = yield* client[COCOA_CLIENT_V1_METHODS.getShellSnapshot]({});
              expect(
                shell.projects
                  .map((project) => [project.providerInstanceId, project.workspaceRoot])
                  .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
              ).toEqual([
                [LINUX, REMOTE_WORKSPACE],
                [MACBOOK, REMOTE_WORKSPACE],
              ]);
              expect(
                yield* client[COCOA_CLIENT_V1_METHODS.executeCommand]({
                  projectId: projectId("project-macbook"),
                  command: ["git", "status", "--short"],
                }),
              ).toEqual({
                exitCode: 0,
                stdout: `${MACBOOK}:git status --short`,
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              });
              expect(state.executionCalls).toEqual([
                {
                  providerInstanceId: MACBOOK,
                  cwd: REMOTE_WORKSPACE,
                  command: ["git", "status", "--short"],
                },
              ]);
              yield* startTurn(client, macThread, "macbook");
            }),
          );
          yield* Deferred.await(macSendEntered);
          yield* Deferred.succeed(macSendGate, undefined);
          yield* first.reactor.drain;

          const macTurnId = providerTurnId(macThread);
          const streamAfterSequence = yield* first.engine.latestSequence;
          const streamReady = yield* Deferred.make<void>();
          const streamed = yield* withCocoaClient(first.wsUrl, (client) =>
            client[COCOA_CLIENT_V1_METHODS.subscribeThread]({
              threadId: macThread,
              afterSequence: streamAfterSequence,
              requestCompletionMarker: true,
            }).pipe(
              Stream.tap((item) =>
                item.kind === "synchronized"
                  ? Deferred.succeed(streamReady, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
              Stream.filter((item) => item.kind === "event"),
              Stream.take(1),
              Stream.runHead,
            ),
          ).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(streamReady);
          yield* publishRuntimeEvent(state, {
            type: "turn.started",
            eventId: EventId.make("runtime-mac-turn-started"),
            provider: CODEX,
            providerInstanceId: MACBOOK,
            createdAt: NOW,
            threadId: macThread,
            turnId: macTurnId,
            payload: {},
          });
          yield* publishRuntimeEvent(state, {
            type: "content.delta",
            eventId: EventId.make("runtime-mac-content"),
            provider: CODEX,
            providerInstanceId: MACBOOK,
            createdAt: NOW,
            threadId: macThread,
            turnId: macTurnId,
            itemId: RuntimeItemId.make("mac-streamed-message"),
            payload: { streamKind: "assistant_text", delta: "visible before disconnect" },
          });
          yield* first.ingestion.drain;
          expect(Option.isSome(yield* Fiber.join(streamed))).toBe(true);

          // The stream client has closed. Both blocking requests arrive while no Cocoa client
          // is connected and must survive as durable projection state.
          yield* publishRuntimeEvent(state, {
            type: "request.opened",
            eventId: EventId.make("runtime-mac-approval"),
            provider: CODEX,
            providerInstanceId: MACBOOK,
            createdAt: NOW,
            threadId: macThread,
            turnId: macTurnId,
            requestId: RUNTIME_APPROVAL_ID,
            payload: { requestType: "command_execution_approval", detail: "pwd" },
          });
          yield* publishRuntimeEvent(state, {
            type: "user-input.requested",
            eventId: EventId.make("runtime-mac-input"),
            provider: CODEX,
            providerInstanceId: MACBOOK,
            createdAt: NOW,
            threadId: macThread,
            turnId: macTurnId,
            requestId: RUNTIME_USER_INPUT_ID,
            payload: {
              questions: [
                {
                  id: "sandbox",
                  header: "Sandbox",
                  question: "Choose access",
                  options: [{ label: "workspace-write", description: "Workspace writes only" }],
                },
              ],
            },
          });
          yield* first.ingestion.drain;

          yield* withCocoaClient(first.wsUrl, (client) =>
            Effect.gen(function* () {
              const reconnected = yield* client[COCOA_CLIENT_V1_METHODS.getThreadSnapshot]({
                threadId: macThread,
              });
              expect(
                reconnected.thread.activities.map((activity) => [
                  activity.kind,
                  activity.approvalRequestId,
                ]),
              ).toEqual(
                expect.arrayContaining([
                  ["approval.requested", APPROVAL_ID],
                  ["user-input.requested", USER_INPUT_ID],
                ]),
              );
              yield* client[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
                type: "thread.approval.respond",
                commandId: CommandId.make("respond-mac-approval"),
                threadId: macThread,
                requestId: APPROVAL_ID,
                decision: "accept",
                createdAt: NOW,
              });
              yield* client[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
                type: "thread.user-input.respond",
                commandId: CommandId.make("respond-mac-input"),
                threadId: macThread,
                requestId: USER_INPUT_ID,
                answers: { sandbox: { answers: ["workspace-write"] } },
                createdAt: NOW,
              });
            }),
          );
          yield* first.reactor.drain;
          expect(state.approvalResponses).toEqual([
            {
              threadId: macThread,
              providerInstanceId: MACBOOK,
              requestId: APPROVAL_ID,
              decision: "accept",
            },
          ]);
          expect(state.userInputResponses).toEqual([
            {
              threadId: macThread,
              providerInstanceId: MACBOOK,
              requestId: USER_INPUT_ID,
              answers: { sandbox: { answers: ["workspace-write"] } },
            },
          ]);

          const macBrowse = yield* first.filesystemBrowse.browse({
            providerInstanceId: MACBOOK,
            locator: { kind: "absolute", path: REMOTE_WORKSPACE },
          });
          const linuxBrowse = yield* first.filesystemBrowse.browse({
            providerInstanceId: LINUX,
            locator: { kind: "absolute", path: REMOTE_WORKSPACE },
          });
          expect(macBrowse.entries.map((entry) => entry.name)).toEqual(["macbook_air-workspace"]);
          expect(linuxBrowse.entries.map((entry) => entry.name)).toEqual([
            "linux_dev_box-workspace",
          ]);
          const macRead = yield* first.projectWorkspace.readFile({
            target: { projectId: projectId("project-macbook") },
            relativePath: "README.md",
            maxBytes: ProviderWorkspaceReadByteLimit.make(128),
          });
          const linuxRead = yield* first.projectWorkspace.readFile({
            target: { projectId: projectId("project-linux") },
            relativePath: "README.md",
            maxBytes: ProviderWorkspaceReadByteLimit.make(128),
          });
          expect(new TextDecoder().decode(macRead.bytes)).toBe("macbook_air:README.md");
          expect(new TextDecoder().decode(linuxRead.bytes)).toBe("linux_dev_box:README.md");
          yield* withCocoaClient(first.wsUrl, (client) =>
            Effect.gen(function* () {
              const macDiff = yield* client[COCOA_CLIENT_V1_METHODS.getTurnDiff]({
                threadId: macThread,
                fromTurnCount: 0,
                toTurnCount: 1,
              });
              const linuxDiff = yield* client[COCOA_CLIENT_V1_METHODS.getTurnDiff]({
                threadId: linuxThread,
                fromTurnCount: 0,
                toTurnCount: 1,
              });
              expect(macDiff.diff).toContain(MACBOOK);
              expect(linuxDiff.diff).toContain(LINUX);
              yield* startTurn(client, linuxThread, "linux");
            }),
          );
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
          yield* publishRuntimeEvent(state, {
            type: "turn.started",
            eventId: EventId.make("runtime-linux-turn-started"),
            provider: CODEX,
            providerInstanceId: LINUX,
            createdAt: NOW,
            threadId: linuxThread,
            turnId: linuxTurnId,
            payload: {},
          });
          yield* publishRuntimeEvent(state, {
            type: "content.delta",
            eventId: EventId.make("runtime-linux-partial"),
            provider: CODEX,
            providerInstanceId: LINUX,
            createdAt: NOW,
            threadId: linuxThread,
            turnId: linuxTurnId,
            itemId: RuntimeItemId.make("linux-final"),
            payload: { streamKind: "assistant_text", delta: "partial" },
          });
          yield* first.ingestion.drain;

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

          yield* setGeneration(state, { _tag: "Unavailable", providerInstanceId: LINUX });
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

          // Drive the same generation-lifecycle seam used by the endpoint connector. A second
          // replacement generation replays the authoritative final and must remain idempotent.
          const firstAuthoritativeRead = yield* Deferred.make<void>();
          state.authoritativeReadEntered.set(LINUX, firstAuthoritativeRead);
          yield* setGeneration(state, {
            _tag: "Ready",
            providerInstanceId: LINUX,
            generationId: 2,
          });
          yield* Deferred.await(firstAuthoritativeRead);
          yield* first.reactor.drain;
          const duplicateAuthoritativeRead = yield* Deferred.make<void>();
          state.authoritativeReadEntered.set(LINUX, duplicateAuthoritativeRead);
          yield* setGeneration(state, {
            _tag: "Ready",
            providerInstanceId: LINUX,
            generationId: 3,
          });
          yield* Deferred.await(duplicateAuthoritativeRead);
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
          expect(
            state.recoverCalls.filter(
              (call) => call.providerInstanceId === LINUX && call.threadId === linuxThread,
            ).length,
          ).toBeGreaterThanOrEqual(2);
          assert.strictEqual(state.localWorkspaceOperations, 0);
          assert.strictEqual(state.localTerminalOperations, 0);
          assert.strictEqual(state.providerSpawnOperations, 0);
          yield* Effect.promise(() => first.close());
        }).pipe(Effect.provide(NodeServices.layer)),
      ({ baseDir, runtimes }) =>
        Effect.promise(async () => {
          await Promise.all(runtimes.map((runtime) => runtime.close()));
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }),
    ),
);
