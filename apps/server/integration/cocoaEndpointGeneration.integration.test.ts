// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
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
import type { ProviderServiceShape } from "../src/provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import type { TextGeneration } from "../src/textGeneration/TextGeneration.ts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

type NotificationHandler = (
  params: unknown,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
type RequestHandler = (params: unknown) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;

const INSTANCE_ID = ProviderInstanceId.make("linux_dev_box");
const SSH_DRIVER_INSTANCE_ID = ProviderInstanceId.make("codex");
const SSH_PROJECT_ID = ProjectId.make("project-ssh-boundary");
const SSH_THREAD_ID = ThreadId.make("thread-ssh-boundary");
const THREAD_ID = ThreadId.make("thread-endpoint-generation");
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const ENDPOINT_CONFIG = decodeCodexSettings({
  endpointTransport: {
    type: "direct-websocket",
    url: "ws://127.0.0.1:7777",
    authentication: { type: "none" },
  },
});
const SSH_ENDPOINT_CONFIG = decodeCodexSettings({
  endpointTransport: {
    type: "ssh-proxy",
    host: "fake-codex-host",
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

interface FakeSshFixture {
  readonly directory: string;
  readonly executablePath: string;
  readonly transcriptPath: string;
}

const makeFakeSshFixture = (): FakeSshFixture => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cocoa-fake-ssh-"));
  const executablePath = NodePath.join(directory, "ssh");
  const transcriptPath = NodePath.join(directory, "transcript.ndjson");
  const source = `#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const transcriptPath = ${JSON.stringify(transcriptPath)};
const record = (entry) => appendFileSync(transcriptPath, JSON.stringify(entry) + "\\n");
record({ type: "argv", args: process.argv.slice(2) });

let input = Buffer.alloc(0);
let upgraded = false;

const sendFrame = (payload, opcode = 1) => {
  const body = Buffer.from(payload);
  const prefix = body.length < 126
    ? Buffer.from([0x80 | opcode, body.length])
    : Buffer.from([0x80 | opcode, 126, body.length >>> 8, body.length & 0xff]);
  process.stdout.write(Buffer.concat([prefix, body]));
};
const sendJson = (payload) => sendFrame(JSON.stringify(payload));

const parseFrame = () => {
  if (input.length < 2) return undefined;
  const opcode = input[0] & 0x0f;
  let length = input[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (input.length < 4) return undefined;
    length = input.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    throw new Error("Unexpected 64-bit WebSocket frame in fake SSH peer");
  }
  const masked = (input[1] & 0x80) !== 0;
  const maskOffset = offset;
  if (masked) offset += 4;
  if (input.length < offset + length) return undefined;
  const payload = Buffer.from(input.subarray(offset, offset + length));
  if (masked) {
    const mask = input.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  input = input.subarray(offset + length);
  return { opcode, payload };
};

const respond = (message) => {
  record({ type: "message", message });
  if (message.method === "initialize" && message.id !== undefined) {
    sendJson({
      id: message.id,
      result: {
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "codex_cli_rs/0.146.0 fake-ssh-boundary",
      },
    });
    return;
  }
  if (message.method === "thread/start" && typeof message.params?.cwd === "string") {
    sendJson({
      id: message.id,
      result: {
        cwd: message.params.cwd,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite" },
        thread: {
          cliVersion: "0.146.0",
          cwd: message.params.cwd,
          ephemeral: false,
          id: "native-ssh-thread",
          createdAt: 1_775_606_400,
          modelProvider: "openai",
          preview: "",
          sessionId: "native-ssh-session",
          source: "cli",
          turns: [],
          status: { type: "idle" },
          updatedAt: 1_775_606_400,
        },
      },
    });
    return;
  }
  if (message.method === "turn/start" && typeof message.params?.threadId === "string") {
    const turn = {
      id: "native-ssh-turn",
      items: [],
      status: "inProgress",
    };
    sendJson({
      method: "turn/started",
      params: { threadId: "native-ssh-thread", turn },
    });
    sendJson({
      method: "item/completed",
      params: {
        threadId: "native-ssh-thread",
        turnId: "native-ssh-turn",
        item: {
          type: "agentMessage",
          id: "native-ssh-message",
          text: "SSH boundary complete.",
          phase: "final_answer",
        },
      },
    });
    sendJson({
      method: "turn/completed",
      params: {
        threadId: "native-ssh-thread",
        turn: {
          ...turn,
          items: [{
            type: "agentMessage",
            id: "native-ssh-message",
            text: "SSH boundary complete.",
            phase: "final_answer",
          }],
          status: "completed",
        },
      },
    });
    sendJson({ id: message.id, result: { turn } });
    return;
  }
  if (message.id !== undefined) {
    sendJson({
      id: message.id,
      error: { code: -32602, message: "invalid params" },
    });
  }
};

const consume = () => {
  if (!upgraded) {
    const headerEnd = input.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const request = input.subarray(0, headerEnd + 4).toString();
    input = input.subarray(headerEnd + 4);
    const key = /^sec-websocket-key:\\s*(.+)$/imu.exec(request)?.[1]?.trim();
    if (key === undefined) throw new Error("Missing Sec-WebSocket-Key");
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    record({ type: "upgrade", request });
    process.stdout.write(
      "HTTP/1.1 101 Switching Protocols\\r\\n" +
      "Upgrade: websocket\\r\\n" +
      "Connection: Upgrade\\r\\n" +
      "Sec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n",
    );
    upgraded = true;
  }

  while (input.length > 0) {
    const frame = parseFrame();
    if (frame === undefined) return;
    if (frame.opcode === 1) respond(JSON.parse(frame.payload.toString()));
    if (frame.opcode === 8) sendFrame("", 8);
    if (frame.opcode === 9) sendFrame(frame.payload, 10);
  }
};

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  consume();
});
`;
  NodeFS.writeFileSync(executablePath, source, { mode: 0o755 });
  return { directory, executablePath, transcriptPath };
};

const readFakeSshTranscript = (path: string): ReadonlyArray<Record<string, unknown>> =>
  NodeFS.readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

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

it.live("routes an orchestrated turn through a spawned SSH WebSocket proxy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(makeFakeSshFixture),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const liveSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let capturedCommand: ChildProcess.StandardCommand | undefined;
      const fakeSshSpawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die(new Error("Expected the SSH connector to spawn one command."));
        }
        capturedCommand = command;
        return liveSpawner.spawn(
          ChildProcess.make(fixture.executablePath, command.args, command.options),
        );
      });
      const owner = yield* Scope.make("sequential");
      const nativeTurnCompleted = yield* Deferred.make<void>();
      const nativeEventLogger = {
        filePath: "in-memory://ssh-boundary",
        write: (event: unknown) =>
          typeof event === "object" &&
          event !== null &&
          "method" in event &&
          event.method === "turn/completed"
            ? Deferred.succeed(nativeTurnCompleted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        close: () => Effect.void,
      };
      let observedCompatibility:
        | CodexEndpointConnection.CodexEndpointCompatibilityMetadata
        | undefined;
      const textGeneration = {
        generateCommitMessage: () => Effect.die("unused"),
        generatePrContent: () => Effect.die("unused"),
        generateBranchName: () => Effect.die("unused"),
        generateThreadTitle: () => Effect.die("unused"),
      } as TextGeneration["Service"];
      const dependencies: Partial<CodexDriverDependencies> = {
        makeEndpointTextGeneration: (() =>
          Effect.succeed(textGeneration)) as CodexDriverDependencies["makeEndpointTextGeneration"],
        checkEndpointProviderStatus: ((_config, connection) =>
          Effect.sync(() => {
            observedCompatibility = connection.compatibility;
            return providerDraft(connection.compatibility.serverVersion ?? "unknown");
          })) as CodexDriverDependencies["checkEndpointProviderStatus"],
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
          instanceId: SSH_DRIVER_INSTANCE_ID,
          displayName: "Linux dev box",
          accentColor: undefined,
          environment: [],
          enabled: true,
          config: SSH_ENDPOINT_CONFIG,
        })
        .pipe(
          Effect.provideService(Scope.Scope, owner),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSshSpawner),
          Effect.provideService(ProviderEventLoggers, {
            native: nativeEventLogger,
            canonical: undefined,
          }),
        );

      const state = yield* awaitGeneration(
        instance.generationLifecycle!,
        (generation) => generation._tag === "Ready",
      ).pipe(Effect.timeout("3 seconds"));
      expect(state).toMatchObject({
        _tag: "Ready",
        providerInstanceId: SSH_DRIVER_INSTANCE_ID,
        generationId: 1,
      });
      expect(observedCompatibility).toMatchObject({
        userAgent: "codex_cli_rs/0.146.0 fake-ssh-boundary",
        serverVersion: "0.146.0",
        codexHome: "/remote/.codex",
        platformFamily: "unix",
        platformOs: "linux",
        versionRelation: "baseline",
        capabilities: {
          conversation: true,
          conversationRead: true,
          checkedConversationRollback: true,
          commandExec: true,
          commandExecControl: true,
        },
      });
      expect(instance.adapter.capabilities).toMatchObject({
        conversationRead: "ordered-turn-ids-v1",
        checkedConversationRollback: "ordered-turn-ids-v1",
        conversationReconciliation: "ordered-turn-state-v1",
      });
      expect(capturedCommand?.command).toBe("ssh");
      expect(capturedCommand?.args).toEqual([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ControlPersist=no",
        "--",
        "fake-codex-host",
        "codex",
        "app-server",
        "proxy",
      ]);

      const providerService: ProviderServiceShape = {
        startSession: (_threadId, input) => instance.adapter.startSession(input),
        recoverSession: () => Effect.die("unused recovery"),
        sendTurn: (input) => instance.adapter.sendTurn(input),
        interruptTurn: (input) => instance.adapter.interruptTurn(input.threadId, input.turnId),
        respondToRequest: (input) =>
          instance.adapter.respondToRequest(input.threadId, input.requestId, input.decision),
        respondToUserInput: (input) =>
          instance.adapter.respondToUserInput(input.threadId, input.requestId, input.answers),
        stopSession: (input) => instance.adapter.stopSession(input.threadId),
        listSessions: instance.adapter.listSessions,
        getCapabilities: () => Effect.succeed(instance.adapter.capabilities),
        getInstanceInfo: () =>
          Effect.succeed({
            instanceId: SSH_DRIVER_INSTANCE_ID,
            driverKind: ProviderDriverKind.make("codex"),
            displayName: "Fake SSH Codex",
            enabled: true,
            gatewayMcpMode: "unavailable" as const,
            continuationIdentity: instance.continuationIdentity,
          }),
        rollbackConversation: () => Effect.die("unused rollback"),
        inspectConversation: () => Effect.die("unused inspection"),
        readAuthoritativeConversation: () => Effect.die("unused authoritative read"),
        rollbackConversationChecked: () => Effect.die("unused checked rollback"),
        streamEvents: instance.adapter.streamEvents,
      };
      const orchestration = yield* Effect.acquireRelease(
        makeOrchestrationIntegrationHarness({
          provider: ProviderDriverKind.make("codex"),
          providerService,
        }).pipe(Effect.timeout("5 seconds")),
        (harness) => harness.dispose,
      );
      const createdAt = "2026-08-06T00:00:00.000Z";
      yield* orchestration.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ssh-boundary"),
        projectId: SSH_PROJECT_ID,
        providerInstanceId: SSH_DRIVER_INSTANCE_ID,
        title: "SSH boundary project",
        workspaceRoot: orchestration.workspaceDir,
        defaultModelSelection: {
          instanceId: SSH_DRIVER_INSTANCE_ID,
          model: "gpt-5.6-sol",
        },
        createdAt,
      });
      yield* orchestration.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ssh-boundary"),
        threadId: SSH_THREAD_ID,
        projectId: SSH_PROJECT_ID,
        title: "SSH boundary thread",
        modelSelection: {
          instanceId: SSH_DRIVER_INSTANCE_ID,
          model: "gpt-5.6-sol",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: orchestration.workspaceDir,
        createdAt,
      });
      yield* orchestration.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-ssh-boundary"),
        threadId: SSH_THREAD_ID,
        message: {
          messageId: MessageId.make("message-ssh-boundary"),
          role: "user",
          text: "Cross the SSH boundary.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      });
      yield* Deferred.await(nativeTurnCompleted).pipe(Effect.timeout("2 seconds"));
      yield* Effect.yieldNow;
      yield* orchestration.drainProviderWork.pipe(Effect.timeout("5 seconds"));
      const snapshot = yield* orchestration.snapshotQuery.getSnapshot();
      const projected = snapshot.threads.find((thread) => thread.id === SSH_THREAD_ID);
      if (projected === undefined) {
        throw new Error("SSH boundary thread was not projected.");
      }
      expect(projected.session).toMatchObject({
        providerName: "codex",
        status: "ready",
      });
      expect(projected.latestTurn).toMatchObject({
        turnId: "native-ssh-turn",
        state: "completed",
      });

      const transcript = readFakeSshTranscript(fixture.transcriptPath);
      expect(transcript[0]).toEqual({
        type: "argv",
        args: capturedCommand?.args,
      });
      const messages = transcript
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message as { readonly method?: string });
      expect(messages[0]).toMatchObject({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "cocoa_gateway", title: "Cocoa Gateway" },
          capabilities: { experimentalApi: true },
        },
      });
      expect(messages[1]).toEqual({ method: "initialized" });
      expect(
        messages
          .slice(2, 12)
          .map(({ method }) => method)
          .sort(),
      ).toEqual(
        [
          "thread/start",
          "thread/resume",
          "turn/start",
          "turn/interrupt",
          "thread/read",
          "thread/rollback",
          "command/exec",
          "command/exec/write",
          "command/exec/resize",
          "command/exec/terminate",
        ].sort(),
      );
      expect(messages.slice(12)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "thread/start" }),
          expect.objectContaining({
            method: "turn/start",
            params: expect.objectContaining({
              threadId: "native-ssh-thread",
              input: expect.arrayContaining([
                expect.objectContaining({ text: "Cross the SSH boundary." }),
              ]),
            }),
          }),
        ]),
      );
      yield* Scope.close(owner, Exit.void);
    }),
  ).pipe(Effect.provide(DriverTestLayer)),
);

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
