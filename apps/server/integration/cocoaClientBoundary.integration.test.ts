import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { COCOA_CLIENT_V1_METHODS } from "@t3tools/contracts/client/v1";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as CheckpointDiffQuery from "../src/checkpointing/CheckpointDiffQuery.ts";
import { makeCocoaClientV1Handlers } from "../src/clientApi/v1/Handlers.ts";
import * as ServerConfig from "../src/config.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../src/provider/Services/ProviderRegistry.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { CheckpointRevertGate } from "../src/orchestration/Services/CheckpointRevertGate.ts";
import * as OrchestrationEngine from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "../src/serverRuntimeStartup.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import { DEFAULT_RUNTIME_BUFFER_LIMITS } from "../src/RuntimeBufferLimits.ts";

const INSTANCE_ID = ProviderInstanceId.make("linux_dev_box");
const PROJECT_ID = ProjectId.make("project-client-boundary");
const THREAD_ID = ThreadId.make("thread-client-boundary");
const APPROVAL_ID = ApprovalRequestId.make("approval-client-boundary");
const USER_INPUT_ID = ApprovalRequestId.make("user-input-client-boundary");
const NOW = "2026-08-04T00:00:00.000Z";

const operateSession: EnvironmentAuth.AuthenticatedSession = {
  sessionId: AuthSessionId.make("client-boundary-session"),
  subject: "integration-client",
  method: "bearer-access-token",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};

const projectionLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
);

const orchestrationLayer = OrchestrationEngineLive.pipe(
  Layer.provide(projectionLayer),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
);

const gatewayConfigLayer = ServerConfig.layerTest(
  process.cwd(),
  {
    prefix: "cocoa-client-boundary-engine",
  },
  { runtimeProfile: "cocoa-gateway" },
).pipe(Layer.provide(NodeServices.layer));
const boundaryTestDependencies = Layer.mergeAll(gatewayConfigLayer, NodeServices.layer);

const realBoundaryLayer = Layer.mergeAll(orchestrationLayer, projectionLayer).pipe(
  Layer.provide(gatewayConfigLayer),
  Layer.provide(NodeServices.layer),
);

const seedThread = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("client-boundary-project-create"),
    projectId: PROJECT_ID,
    providerInstanceId: INSTANCE_ID,
    title: "Remote project",
    workspaceRoot: "/srv/remote/same-path",
    defaultModelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
    createdAt: NOW,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("client-boundary-thread-create"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Remote thread",
    modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });
});

const makeAncillaryHandlerLayer = (
  engine: OrchestrationEngine.OrchestrationEngineShape,
  projections: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
) => {
  const diffs = CheckpointDiffQuery.CheckpointDiffQuery.of({
    getTurnDiff: () => Effect.die("unused"),
    getFullThreadDiff: () => Effect.die("unused"),
    getCompletedCaptureDiff: () => Effect.die("unused"),
  });
  const providers = ProviderRegistry.ProviderRegistry.of({
    getProviders: Effect.succeed([]),
    refresh: () => Effect.succeed([]),
    refreshInstance: () => Effect.succeed([]),
    getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
    setProviderMaintenanceActionState: () => Effect.succeed([]),
    streamChanges: Stream.empty,
  });
  const environment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("client-boundary-environment")),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("client-boundary-environment"),
      label: "Cocoa integration",
      serverVersion: "1.0.0",
      platform: { os: "linux", arch: "arm64" },
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
  const gate = CheckpointRevertGate.of({
    assertThreadAvailable: () => Effect.void,
    isThreadBlocked: () => Effect.succeed(false),
  });

  return Layer.mergeAll(
    Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
    Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projections),
    Layer.succeed(CheckpointDiffQuery.CheckpointDiffQuery, diffs),
    Layer.succeed(ProviderRegistry.ProviderRegistry, providers),
    Layer.succeed(ServerEnvironment.ServerEnvironment, environment),
    Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, startup),
    Layer.succeed(TerminalManager.TerminalManager, terminals),
    Layer.succeed(CheckpointRevertGate, gate),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "cocoa-client-boundary" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
};

const appendBlockingRequests = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.make("append-approval-request"),
    threadId: THREAD_ID,
    activity: {
      id: EventId.make("activity-approval-request"),
      tone: "approval",
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: { requestId: APPROVAL_ID, requestKind: "command" },
      turnId: null,
      createdAt: NOW,
    },
    createdAt: NOW,
  });
  yield* engine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.make("append-user-input-request"),
    threadId: THREAD_ID,
    activity: {
      id: EventId.make("activity-user-input-request"),
      tone: "info",
      kind: "user-input.requested",
      summary: "User input requested",
      payload: {
        requestId: USER_INPUT_ID,
        questions: [{ id: "sandbox", header: "Sandbox", question: "Choose access" }],
      },
      turnId: null,
      createdAt: NOW,
    },
    createdAt: NOW,
  });
});

it.layer(realBoundaryLayer)("Cocoa v1 real persistence boundary", (it) => {
  it.effect("restores outstanding approval and structured input after client disconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedThread;
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const handlers = yield* makeCocoaClientV1Handlers(operateSession).pipe(
          Effect.provide(makeAncillaryHandlerLayer(engine, projections)),
        );

        const initialConnection = Array.from(
          yield* handlers[COCOA_CLIENT_V1_METHODS.subscribeThread]({
            threadId: THREAD_ID,
          }).pipe(Stream.take(1), Stream.runCollect),
        );
        expect(initialConnection[0]?.kind).toBe("snapshot");

        // The first stream has ended: both requests arrive while that client is disconnected.
        yield* appendBlockingRequests;

        const reconnected = Array.from(
          yield* handlers[COCOA_CLIENT_V1_METHODS.subscribeThread]({
            threadId: THREAD_ID,
          }).pipe(Stream.take(1), Stream.runCollect),
        );
        expect(reconnected).toHaveLength(1);
        expect(reconnected[0]).toMatchObject({
          kind: "snapshot",
          snapshot: {
            thread: {
              activities: [
                {
                  id: EventId.make("activity-approval-request"),
                  kind: "approval.requested",
                  approvalRequestId: APPROVAL_ID,
                },
                {
                  id: EventId.make("activity-user-input-request"),
                  kind: "user-input.requested",
                  approvalRequestId: USER_INPUT_ID,
                },
              ],
            },
          },
        });

        yield* handlers[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
          type: "thread.approval.respond",
          commandId: CommandId.make("respond-approval-after-reconnect"),
          threadId: THREAD_ID,
          requestId: APPROVAL_ID,
          decision: "accept",
          createdAt: NOW,
        });
        yield* handlers[COCOA_CLIENT_V1_METHODS.dispatchCommand]({
          type: "thread.user-input.respond",
          commandId: CommandId.make("respond-user-input-after-reconnect"),
          threadId: THREAD_ID,
          requestId: USER_INPUT_ID,
          answers: { sandbox: { answers: ["workspace-write"] } },
          createdAt: NOW,
        });

        const events = Array.from(yield* Stream.runCollect(engine.readEvents(0, 20)));
        expect(
          events.filter((event) => event.type === "thread.approval-response-requested"),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.type === "thread.user-input-response-requested"),
        ).toHaveLength(1);
      }),
    ).pipe(Effect.provide(boundaryTestDependencies)),
  );

  it.effect(
    "returns reset_required on a real live-buffer overflow and reconnects by snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seedThread;
          const engine = yield* OrchestrationEngine.OrchestrationEngineService;
          const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          const snapshotStarted = yield* Deferred.make<void>();
          const releaseSnapshot = yield* Deferred.make<void>();
          const delayedProjections = ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
            ...projections,
            getThreadDetailSnapshot: (id) =>
              Deferred.succeed(snapshotStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSnapshot)),
                Effect.andThen(projections.getThreadDetailSnapshot(id)),
              ),
          });
          const handlers = yield* makeCocoaClientV1Handlers(operateSession).pipe(
            Effect.provide(makeAncillaryHandlerLayer(engine, delayedProjections)),
          );
          const overflowed = yield* handlers[COCOA_CLIENT_V1_METHODS.subscribeThread]({
            threadId: THREAD_ID,
          }).pipe(Stream.runDrain, Effect.flip, Effect.forkChild);

          yield* Deferred.await(snapshotStarted);
          yield* Effect.forEach(
            Array.from(
              { length: DEFAULT_RUNTIME_BUFFER_LIMITS.clientLiveEvents + 1 },
              (_, index) => index,
            ),
            (index) =>
              engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`overflow-command-${index}`),
                threadId: THREAD_ID,
                activity: {
                  id: EventId.make(`overflow-activity-${index}`),
                  tone: "info",
                  kind: "integration.buffer.event",
                  summary: `Event ${index}`,
                  payload: null,
                  turnId: null,
                  createdAt: NOW,
                },
                createdAt: NOW,
              }),
            { discard: true },
          );
          yield* Deferred.succeed(releaseSnapshot, undefined);

          expect(yield* Fiber.join(overflowed)).toEqual({
            code: "reset_required",
            message: "The live update buffer overflowed. Reconnect to load a fresh snapshot.",
            retryable: true,
          });

          const freshHandlers = yield* makeCocoaClientV1Handlers(operateSession).pipe(
            Effect.provide(makeAncillaryHandlerLayer(engine, projections)),
          );
          const fresh = Array.from(
            yield* freshHandlers[COCOA_CLIENT_V1_METHODS.subscribeThread]({
              threadId: THREAD_ID,
            }).pipe(Stream.take(1), Stream.runCollect),
          );
          expect(fresh[0]?.kind).toBe("snapshot");
          if (fresh[0]?.kind === "snapshot") {
            expect(fresh[0].snapshot.snapshotSequence).toBeGreaterThan(
              DEFAULT_RUNTIME_BUFFER_LIMITS.clientLiveEvents,
            );
          }
        }),
      ).pipe(Effect.provide(boundaryTestDependencies)),
  );
});
