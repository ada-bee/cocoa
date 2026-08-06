// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import {
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";

import * as BackgroundPolicy from "../src/background/BackgroundPolicy.ts";
import { ServerConfig } from "../src/config.ts";
import type { CodexAdapterLiveOptions } from "../src/provider/Layers/CodexAdapter.ts";
import {
  CodexSessionRuntimePendingApprovalNotFoundError,
  CodexSessionRuntimePendingUserInputNotFoundError,
  makeCodexEndpointSessionRuntime,
} from "../src/provider/Layers/CodexSessionRuntime.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import type { CodexAdapterShape } from "../src/provider/Services/CodexAdapter.ts";
import type {
  ProviderInstanceGenerationLifecycle,
  ProviderInstanceGenerationState,
} from "../src/provider/ProviderDriver.ts";
import * as CodexEndpointConnection from "../src/provider/codexEndpoint/CodexEndpointConnection.ts";
import {
  type CodexEndpointRouter,
  type CodexEndpointRouterClient,
  makeCodexEndpointRouter,
} from "../src/provider/codexEndpoint/CodexEndpointRouter.ts";
import * as CodexEndpointSupervisor from "../src/provider/codexEndpoint/CodexEndpointSupervisor.ts";
import { buildServerProvider } from "../src/provider/providerSnapshot.ts";
import {
  makeCodexDriver,
  type CodexDriverDependencies,
} from "../src/provider/Drivers/CodexDriver.ts";
import {
  makeCodexEndpointDriver,
  type CodexEndpointDriverDependencies,
} from "../src/provider/Drivers/CodexEndpointDriver.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import type { TextGeneration } from "../src/textGeneration/TextGeneration.ts";

type NotificationHandler = (
  params: unknown,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
type RequestHandler = (params: unknown) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;

const INSTANCE_ID = ProviderInstanceId.make("linux_dev_box");
const DIRECT_INSTANCE_ID = ProviderInstanceId.make("codex_direct");
const DIRECT_THREAD_ID = ThreadId.make("thread-direct-boundary");
const THREAD_ID = ThreadId.make("thread-endpoint-generation");
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const ENDPOINT_CONFIG = decodeCodexSettings({
  endpointTransport: {
    type: "direct-websocket",
    url: "ws://127.0.0.1:7777",
    authentication: { type: "none" },
  },
});
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeNativeEndpointHarness() {
  const notificationHandlers = new Map<string, Array<NotificationHandler>>();
  const requestHandlers = new Map<string, RequestHandler>();
  const unknownNotificationHandlers: Array<
    (method: string, params: unknown) => Effect.Effect<void, CodexErrors.CodexAppServerError>
  > = [];

  const request = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
    params: CodexRpc.ClientRequestParamsByMethod[M],
  ): Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError> =>
    method === "thread/start"
      ? Effect.succeed({
          cwd: (params as { readonly cwd?: string }).cwd ?? "/remote/workspace",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspace-write" },
          thread: {
            id: "native-endpoint-generation",
            createdAt: "2026-08-04T00:00:00.000Z",
            source: { session: "cli" },
            turns: [],
            status: { state: "idle", activeFlags: [] },
          },
        } as never)
      : Effect.succeed({} as never);

  const client = {
    request,
    notify: () => Effect.void,
    raw: { request },
    handleServerNotification: (method: string, handler: NotificationHandler) =>
      Effect.sync(() => {
        notificationHandlers.set(method, [...(notificationHandlers.get(method) ?? []), handler]);
      }),
    handleServerRequest: (method: string, handler: RequestHandler) =>
      Effect.sync(() => {
        requestHandlers.set(method, handler);
      }),
    handleUnknownServerNotification: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<void, CodexErrors.CodexAppServerError>,
    ) => Effect.sync(() => unknownNotificationHandlers.push(handler)),
  } as unknown as CodexClient.CodexAppServerClient["Service"];

  return {
    client,
    serverRequest: (method: string, params: unknown) => {
      const handler = requestHandlers.get(method);
      assert.isDefined(handler);
      return handler!(params);
    },
  };
}

const makeRuntime = Effect.fn("acceptance.makeEndpointRuntime")(function* () {
  const harness = makeNativeEndpointHarness();
  const router = yield* makeCodexEndpointRouter(harness.client as CodexEndpointRouterClient);
  const connection = CodexEndpointConnection.CodexEndpointConnection.of({
    identity: { providerInstanceId: INSTANCE_ID },
    client: harness.client,
    compatibility: {
      userAgent: "codex_cli_rs/0.146.0",
      serverVersion: "0.146.0",
      codexHome: "/remote/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    awaitTermination: Effect.never,
  });
  const runtimeScope = yield* Scope.make("sequential");
  const runtime = yield* makeCodexEndpointSessionRuntime({
    connection,
    router,
    options: {
      threadId: THREAD_ID,
      providerInstanceId: INSTANCE_ID,
      cwd: "/remote/workspace",
      runtimeMode: "approval-required",
    },
  }).pipe(
    Effect.provideService(Scope.Scope, runtimeScope),
    Effect.provideService(Crypto.Crypto, testCrypto),
  );
  yield* runtime.start();
  return { harness, runtime, runtimeScope };
});

it.effect(
  "cancels native callbacks on endpoint loss and makes later responses explicitly stale",
  () =>
    Effect.gen(function* () {
      const { harness, runtime, runtimeScope } = yield* makeRuntime();
      const requests = yield* runtime.events.pipe(
        Stream.filter((event) => event.kind === "request"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      const nativeApproval = yield* harness
        .serverRequest("item/commandExecution/requestApproval", {
          itemId: "command-item",
          startedAtMs: 1,
          threadId: "native-endpoint-generation",
          turnId: "native-turn",
        })
        .pipe(Effect.forkChild);
      const nativeUserInput = yield* harness
        .serverRequest("item/tool/requestUserInput", {
          itemId: "input-item",
          questions: [
            {
              id: "sandbox",
              header: "Sandbox",
              question: "Choose access",
              options: [{ label: "Workspace", description: "Workspace write access." }],
            },
          ],
          threadId: "native-endpoint-generation",
          turnId: "native-turn",
        })
        .pipe(Effect.forkChild);
      const opened = Array.from(yield* Fiber.join(requests));
      const approval = opened.find((event) => event.requestKind === "command");
      const userInput = opened.find((event) => event.method === "item/tool/requestUserInput");
      assert.isDefined(approval?.requestId);
      assert.isDefined(userInput?.requestId);

      // CodexDriver invokes adapter.stopAll on generation invalidation; closing the real
      // session runtime is the operation that settles those native callbacks.
      yield* runtime.close;
      expect(yield* Fiber.join(nativeApproval)).toEqual({ decision: "cancel" });
      expect(yield* Fiber.join(nativeUserInput)).toEqual({ answers: {} });

      const staleApproval = yield* runtime
        .respondToRequest(approval!.requestId!, "accept")
        .pipe(Effect.flip);
      const staleUserInput = yield* runtime
        .respondToUserInput(userInput!.requestId!, {
          sandbox: { answers: ["workspace-write"] },
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleApproval, CodexSessionRuntimePendingApprovalNotFoundError);
      assert.instanceOf(staleUserInput, CodexSessionRuntimePendingUserInputNotFoundError);
      yield* Scope.close(runtimeScope, Exit.void);
    }),
);

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const BackgroundPolicyNoWork = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: false,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(false),
  shouldRunScopeWork: () => Effect.succeed(false),
  shouldRunOpportunisticWork: Effect.succeed(false),
});
const HttpClientTest = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);
const DriverTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cocoa-endpoint-generation",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(BackgroundPolicyNoWork),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(HttpClientTest),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

const providerDraft = (version: string) =>
  buildServerProvider({
    presentation: { displayName: "Codex", showInteractionModeToggle: true },
    enabled: true,
    checkedAt: "2026-08-04T00:00:00.000Z",
    models: [],
    skills: [],
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });

interface FakeDirectEndpoint {
  readonly url: string;
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  readonly authorization: string | undefined;
}

const makeFakeDirectEndpoint = Effect.fn("acceptance.makeFakeDirectEndpoint")(function* () {
  const messages: Array<Record<string, unknown>> = [];
  let authorization: string | undefined;
  const server = new NodeSocket.NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
  yield* Effect.addFinalizer(() =>
    Effect.promise<void>(
      () =>
        new Promise((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );

  server.on("connection", (socket, request) => {
    authorization = request.headers.authorization;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as Record<string, unknown> & {
        readonly id?: string | number;
        readonly method?: string;
        readonly params?: Record<string, unknown>;
      };
      messages.push(message);
      const send = (value: unknown) => socket.send(JSON.stringify(value));
      if (message.method === "initialize" && message.id !== undefined) {
        send({
          id: message.id,
          result: {
            codexHome: "/remote/.codex",
            platformFamily: "unix",
            platformOs: "linux",
            userAgent: "codex_cli_rs/0.146.0 fake-direct-boundary",
          },
        });
        return;
      }
      if (
        message.method === "thread/start" &&
        message.id !== undefined &&
        typeof message.params?.cwd === "string"
      ) {
        const cwd = String(message.params?.cwd ?? "/remote/workspace");
        send({
          id: message.id,
          result: {
            cwd,
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: { type: "workspaceWrite" },
            thread: {
              cliVersion: "0.146.0",
              cwd,
              ephemeral: false,
              id: "native-direct-thread",
              createdAt: 1_775_606_400,
              modelProvider: "openai",
              preview: "",
              sessionId: "native-direct-session",
              source: "cli",
              turns: [],
              status: { type: "idle" },
              updatedAt: 1_775_606_400,
            },
          },
        });
        return;
      }
      if (
        message.method === "turn/start" &&
        message.id !== undefined &&
        typeof message.params?.threadId === "string"
      ) {
        const turn = { id: "native-direct-turn", items: [], status: "inProgress" };
        send({
          method: "turn/started",
          params: { threadId: "native-direct-thread", turn },
        });
        const item = {
          type: "agentMessage",
          id: "native-direct-message",
          text: "Direct WebSocket boundary complete.",
          phase: "final_answer",
        };
        send({
          method: "item/completed",
          params: {
            threadId: "native-direct-thread",
            turnId: "native-direct-turn",
            item,
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: "native-direct-thread",
            turn: { ...turn, items: [item], status: "completed" },
          },
        });
        send({ id: message.id, result: { turn } });
        return;
      }
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32602, message: "invalid params" } });
      }
    });
  });

  yield* Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* Effect.die(new Error("Fake direct endpoint did not bind a TCP port."));
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    messages,
    get authorization() {
      return authorization;
    },
  } satisfies FakeDirectEndpoint;
});

it.live("routes a signed-bearer turn through the direct WebSocket boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const endpoint = yield* makeFakeDirectEndpoint();
      const fileSystem = yield* FileSystem.FileSystem;
      const secretDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cocoa-direct-endpoint-",
      });
      const secretPath = `${secretDirectory}/shared-secret`;
      yield* fileSystem.writeFileString(
        secretPath,
        "0123456789abcdef0123456789abcdef0123456789abcdef",
      );
      const config = decodeCodexSettings({
        endpointTransport: {
          type: "direct-websocket",
          url: endpoint.url,
          authentication: {
            type: "signed-bearer-token",
            credential: { source: "file", path: secretPath },
            issuer: "cocoa-gateway",
            audience: "codex-direct",
          },
        },
      });
      const textGeneration = {
        generateCommitMessage: () => Effect.die("unused"),
        generatePrContent: () => Effect.die("unused"),
        generateBranchName: () => Effect.die("unused"),
        generateThreadTitle: () => Effect.die("unused"),
      } as TextGeneration["Service"];
      let observedCompatibility:
        | CodexEndpointConnection.CodexEndpointCompatibilityMetadata
        | undefined;
      const dependencies: Partial<CodexEndpointDriverDependencies> = {
        makeEndpointTextGeneration: (() =>
          Effect.succeed(
            textGeneration,
          )) as CodexEndpointDriverDependencies["makeEndpointTextGeneration"],
        checkEndpointProviderStatus: ((_config, connection) =>
          Effect.sync(() => {
            observedCompatibility = connection.compatibility;
            return providerDraft(connection.compatibility.serverVersion ?? "unknown");
          })) as CodexEndpointDriverDependencies["checkEndpointProviderStatus"],
      };
      const owner = yield* Scope.make("sequential");
      const instance = yield* makeCodexEndpointDriver(dependencies)
        .create({
          instanceId: DIRECT_INSTANCE_ID,
          displayName: "Direct Codex",
          accentColor: undefined,
          environment: [],
          enabled: true,
          config,
        })
        .pipe(Effect.provideService(Scope.Scope, owner));
      yield* awaitGeneration(instance.generationLifecycle!, (state) => state._tag === "Ready").pipe(
        Effect.timeout("3 seconds"),
      );

      const completed = yield* instance.adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* instance.adapter.startSession({
        threadId: DIRECT_THREAD_ID,
        provider: ProviderDriverKind.make("codex"),
        cwd: "/remote/workspace",
        runtimeMode: "approval-required",
        modelSelection: { instanceId: DIRECT_INSTANCE_ID, model: "gpt-5.6-sol" },
      });
      yield* instance.adapter.sendTurn({
        threadId: DIRECT_THREAD_ID,
        input: "Cross the direct WebSocket boundary.",
        attachments: [],
      });
      expect(Option.isSome(yield* Fiber.join(completed))).toBe(true);

      expect(observedCompatibility).toMatchObject({
        userAgent: "codex_cli_rs/0.146.0 fake-direct-boundary",
        serverVersion: "0.146.0",
        platformFamily: "unix",
        platformOs: "linux",
      });
      const bearer = endpoint.authorization?.replace(/^Bearer /u, "");
      expect(bearer).toBeDefined();
      const claims = yield* decodeUnknownJson(
        Buffer.from(bearer!.split(".")[1]!, "base64url").toString("utf8"),
      );
      expect(claims).toMatchObject({ iss: "cocoa-gateway", aud: "codex-direct" });
      expect(endpoint.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "initialize" }),
          expect.objectContaining({ method: "thread/start" }),
          expect.objectContaining({ method: "turn/start" }),
        ]),
      );
      yield* Scope.close(owner, Exit.void);
    }),
  ).pipe(Effect.provide(DriverTestLayer)),
);

const terminationError = (label: string) =>
  new CodexEndpointConnection.CodexEndpointTerminationError({
    providerInstanceId: INSTANCE_ID,
    cause: new CodexErrors.CodexAppServerTransportError({
      operation: "read-input-stream",
      cause: new Error(label),
    }),
  });

const makeGenerationConnection = Effect.fn("acceptance.makeGenerationConnection")(function* (
  generationId: number,
  capabilities: CodexEndpointConnection.CodexEndpointNativeCapabilities,
) {
  const terminated = yield* Deferred.make<CodexEndpointConnection.CodexEndpointTerminationError>();
  return {
    connection: CodexEndpointConnection.CodexEndpointConnection.of({
      identity: { providerInstanceId: INSTANCE_ID },
      client: { generationId } as unknown as CodexClient.CodexAppServerClient["Service"],
      compatibility: {
        userAgent: `codex_cli_rs/0.${generationId}.0`,
        serverVersion: `0.${generationId}.0`,
        codexHome: `/remote/${generationId}/.codex`,
        platformFamily: "unix",
        platformOs: "linux",
        versionRelation: "baseline",
        capabilities,
      },
      awaitTermination: Deferred.await(terminated).pipe(Effect.flatMap(Effect.fail)),
    }),
    terminate: () => Deferred.succeed(terminated, terminationError(`generation-${generationId}`)),
  };
});

const capabilities = (
  optional: boolean,
): CodexEndpointConnection.CodexEndpointNativeCapabilities => ({
  conversation: true,
  conversationRead: optional,
  checkedConversationRollback: optional,
  commandExec: optional,
  commandExecControl: optional,
  methods: {
    "thread/start": "available",
    "thread/resume": "available",
    "turn/start": "available",
    "turn/interrupt": "available",
    "thread/read": optional ? "available" : "unavailable",
    "thread/rollback": optional ? "available" : "unavailable",
    "command/exec": optional ? "available" : "unavailable",
    "command/exec/write": optional ? "available" : "unavailable",
    "command/exec/resize": optional ? "available" : "unavailable",
    "command/exec/terminate": optional ? "available" : "unavailable",
  },
});

const awaitGeneration = Effect.fn("acceptance.awaitGeneration")(function* (
  lifecycle: ProviderInstanceGenerationLifecycle,
  predicate: (state: ProviderInstanceGenerationState) => boolean,
) {
  const changes = yield* lifecycle.subscribeChanges;
  const current = yield* lifecycle.getCurrent;
  if (predicate(current)) return current;
  return Option.getOrThrow(
    yield* Stream.fromSubscription(changes).pipe(Stream.filter(predicate), Stream.runHead),
  );
});

const awaitNextGeneration = Effect.fn("acceptance.awaitNextGeneration")(function* (
  lifecycle: ProviderInstanceGenerationLifecycle,
  predicate: (state: ProviderInstanceGenerationState) => boolean,
) {
  const changes = yield* lifecycle.subscribeChanges;
  return Option.getOrThrow(
    yield* Stream.fromSubscription(changes).pipe(Stream.filter(predicate), Stream.runHead),
  );
});

it.layer(DriverTestLayer)("CodexDriver real supervisor boundary", (it) => {
  it.effect("replaces a generation and gates optional capabilities to the new probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* Scope.make("sequential");
        const first = yield* makeGenerationConnection(1, capabilities(true));
        const second = yield* makeGenerationConnection(2, capabilities(false));
        const retryRequests = yield* Queue.unbounded<Deferred.Deferred<void>>();
        let factoryCalls = 0;
        let stopAllCalls = 0;
        const nativeAdapter = {
          capabilities: {
            sessionModelSwitch: "in-session",
            conversationRead: "ordered-turn-ids-v1",
            checkedConversationRollback: "ordered-turn-ids-v1",
            conversationReconciliation: "ordered-turn-state-v1",
          },
          stopAll: () => Effect.sync(() => void (stopAllCalls += 1)),
        } as unknown as CodexAdapterShape;
        const textGeneration = {
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
        } as TextGeneration["Service"];
        const supervisorOverride: CodexDriverDependencies["makeEndpointSupervisor"] = ((options) =>
          CodexEndpointSupervisor.make({
            ...options,
            dependencies: {
              ...options.dependencies,
              retryDelay: () => Effect.succeed(Duration.zero),
              sleep: () =>
                Effect.gen(function* () {
                  const release = yield* Deferred.make<void>();
                  yield* Queue.offer(retryRequests, release);
                  yield* Deferred.await(release);
                }),
            },
          })) as CodexDriverDependencies["makeEndpointSupervisor"];
        const dependencies: Partial<CodexDriverDependencies> = {
          makeEndpointSupervisor: supervisorOverride,
          makeEndpoint: (() =>
            Effect.sync(() =>
              ++factoryCalls === 1 ? first.connection : second.connection,
            )) as CodexDriverDependencies["makeEndpoint"],
          makeEndpointRouter: (() =>
            Effect.succeed({
              registerSession: () => Effect.die("unused"),
              registerInternalOperation: () => Effect.die("unused"),
            } as CodexEndpointRouter)) as CodexDriverDependencies["makeEndpointRouter"],
          makeAdapter: ((_config: CodexSettings, _options?: CodexAdapterLiveOptions) =>
            Effect.succeed(nativeAdapter)) as CodexDriverDependencies["makeAdapter"],
          makeEndpointTextGeneration: (() =>
            Effect.succeed(
              textGeneration,
            )) as CodexDriverDependencies["makeEndpointTextGeneration"],
          checkEndpointProviderStatus: ((
            _config: CodexSettings,
            connection: typeof first.connection,
          ) =>
            Effect.succeed(
              providerDraft(connection.compatibility.serverVersion ?? "unknown"),
            )) as CodexDriverDependencies["checkEndpointProviderStatus"],
          resolveHomeLayout: (() =>
            Effect.die("local home lookup")) as CodexDriverDependencies["resolveHomeLayout"],
          materializeShadowHome: (() =>
            Effect.die(
              "local home materialization",
            )) as CodexDriverDependencies["materializeShadowHome"],
          makeLocalTextGeneration: (() =>
            Effect.die(
              "local text generation",
            )) as CodexDriverDependencies["makeLocalTextGeneration"],
          checkLocalProviderStatus: (() =>
            Effect.die(
              "local provider probe",
            )) as CodexDriverDependencies["checkLocalProviderStatus"],
        };
        const instance = yield* makeCodexDriver(dependencies)
          .create({
            instanceId: INSTANCE_ID,
            displayName: "Linux dev box",
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: ENDPOINT_CONFIG,
          })
          .pipe(Effect.provideService(Scope.Scope, owner));
        const lifecycle = instance.generationLifecycle!;

        yield* awaitGeneration(
          lifecycle,
          (state) => state._tag === "Ready" && state.generationId === 1,
        );
        expect(instance.adapter.capabilities).toMatchObject({
          conversationRead: "ordered-turn-ids-v1",
          checkedConversationRollback: "ordered-turn-ids-v1",
          conversationReconciliation: "ordered-turn-state-v1",
        });

        const unavailable = yield* awaitNextGeneration(
          lifecycle,
          (state) => state._tag === "Unavailable",
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* first.terminate();
        yield* Fiber.join(unavailable);
        expect(instance.adapter.capabilities).toMatchObject({
          conversationRead: "unsupported",
          checkedConversationRollback: "unsupported",
          conversationReconciliation: "unsupported",
        });
        expect(stopAllCalls).toBe(1);

        const readyTwo = yield* awaitNextGeneration(
          lifecycle,
          (state) => state._tag === "Ready" && state.generationId === 2,
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(yield* Queue.take(retryRequests), undefined);
        yield* Fiber.join(readyTwo);
        expect(factoryCalls).toBe(2);
        expect(instance.adapter.capabilities).toMatchObject({
          conversationRead: "unsupported",
          checkedConversationRollback: "unsupported",
          conversationReconciliation: "unsupported",
        });
        yield* Scope.close(owner, Exit.void);
      }),
    ),
  );
});
