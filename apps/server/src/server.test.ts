import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  GitCommandError,
  KeybindingRule,
  MessageId,
  ExternalLauncherCommandNotFoundError,
  FilesystemBrowseError,
  type OrchestrationThreadShell,
  TerminalNotRunningError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  type PreviewEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ResolvedKeybindingRule,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { RELAY_HEALTH_REQUEST_TYP, RELAY_MINT_REQUEST_TYP } from "@t3tools/shared/relayJwt";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { vi } from "vite-plus/test";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as ServerConfig from "./config.ts";
import * as HttpResponseCompression from "./httpCompression/HttpResponseCompression.ts";
import { makeRoutesLayer } from "./server.ts";
import { resolveAvailableEditorsForConfig } from "./ws.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import { CheckpointUnsupportedError } from "./checkpointing/Errors.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationListenerCallbackError } from "./orchestration/Errors.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderFilesystemBrowse from "./provider/ProviderFilesystemBrowse.ts";
import {
  ProviderWorkspaceDisconnectedError,
  ProviderWorkspaceOperationError,
  ProviderWorkspacePathError,
  ProviderWorkspaceUnsupportedError,
} from "./provider/ProviderWorkspaceAdapter.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./provider/providerMaintenance.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as ProjectWorkspace from "./project/ProjectWorkspace.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as RepositoryReadService from "./project/RepositoryReadService.ts";
import * as RepositoryStatusBroadcaster from "./project/RepositoryStatusBroadcaster.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriver from "./vcs/VcsDriver.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as Data from "effect/Data";

const defaultProjectId = ProjectId.make("project-default");
const defaultThreadId = ThreadId.make("thread-default");
const defaultDesktopBootstrapToken = "test-desktop-bootstrap-token";
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;
const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-test"),
  label: "Test environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
const makeDefaultOrchestrationReadModel = () => {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

const makeDefaultOrchestrationThreadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: defaultThreadId,
    projectId: defaultProjectId,
    title: "Default Thread",
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
};

const browserOtlpTracingLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const makeAuthTestLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
  );

const makeBrowserOtlpPayload = (spanName: string) =>
  Effect.gen(function* () {
    const collector = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const NodeHttp = await import("node:http");

        return await new Promise<{
          readonly close: () => Promise<void>;
          readonly firstRequest: Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>;
          readonly url: string;
        }>((resolve, reject) => {
          let resolveFirstRequest:
            | ((request: { readonly body: string; readonly contentType: string | null }) => void)
            | undefined;
          const firstRequest = new Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>((resolveRequest) => {
            resolveFirstRequest = resolveRequest;
          });

          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            request.on("end", () => {
              resolveFirstRequest?.({
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: request.headers["content-type"] ?? null,
              });
              resolveFirstRequest = undefined;
              response.statusCode = 204;
              response.end();
            });
          });

          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
              reject(new Error("Expected TCP collector address"));
              return;
            }

            resolve({
              url: `http://127.0.0.1:${address.port}/v1/traces`,
              firstRequest,
              close: () =>
                new Promise<void>((resolveClose, rejectClose) => {
                  server.close((error) => {
                    if (error) {
                      rejectClose(error);
                      return;
                    }
                    resolveClose();
                  });
                }),
            });
          });
        });
      }),
      ({ close }) => Effect.promise(close),
    );

    const runtime = ManagedRuntime.make(
      OtlpTracer.layer({
        url: collector.url,
        exportInterval: "10 millis",
        resource: {
          serviceName: "t3-web",
          attributes: {
            "service.runtime": "t3-web",
            "service.mode": "browser",
            "service.version": "test",
          },
        },
      }).pipe(Layer.provide(browserOtlpTracingLayer)),
    );

    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void.pipe(Effect.withSpan(spanName))));
    } finally {
      yield* Effect.promise(() => runtime.dispose());
    }

    const request = yield* Effect.raceFirst(
      Effect.promise(() => collector.firstRequest).pipe(Effect.orDie),
      Effect.sleep(Duration.seconds(1)).pipe(
        Effect.andThen(Effect.die(new Error("Timed out waiting for OTLP trace export"))),
      ),
    );
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    return JSON.parse(request.body) as OtlpTracer.TraceData;
  });

const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfig.ServerConfig["Service"]>;
  layers?: {
    keybindings?: Partial<Keybindings.Keybindings["Service"]>;
    providerRegistry?: Partial<ProviderRegistry.ProviderRegistry["Service"]>;
    serverSettings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
    externalLauncher?: Partial<ExternalLauncher.ExternalLauncher["Service"]>;
    vcsDriver?: Partial<VcsDriver.VcsDriver["Service"]>;
    vcsDriverRegistry?: Partial<VcsDriverRegistry.VcsDriverRegistry["Service"]>;
    gitVcsDriver?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
    gitManager?: Partial<GitManager.GitManager["Service"]>;
    sourceControlRepositoryService?: Partial<
      SourceControlRepositoryService.SourceControlRepositoryService["Service"]
    >;
    reviewService?: Partial<ReviewService.ReviewService["Service"]>;
    vcsStatusBroadcaster?: Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>;
    repositoryReadService?: Partial<RepositoryReadService.RepositoryReadService["Service"]>;
    repositoryStatusBroadcaster?: Partial<
      RepositoryStatusBroadcaster.RepositoryStatusBroadcaster["Service"]
    >;
    projectSetupScriptRunner?: Partial<
      ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]
    >;
    portDiscovery?: Partial<PortScanner.PortDiscovery["Service"]>;
    terminalManager?: Partial<TerminalManager.TerminalManager["Service"]>;
    orchestrationEngine?: Partial<OrchestrationEngine.OrchestrationEngineService["Service"]>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]>;
    projectWorkspace?: Partial<ProjectWorkspace.ProjectWorkspace["Service"]>;
    providerFilesystemBrowse?: Partial<
      ProviderFilesystemBrowse.ProviderFilesystemBrowse["Service"]
    >;
    workspaceEntries?: Partial<WorkspaceEntries.WorkspaceEntries["Service"]>;
    checkpointDiffQuery?: Partial<CheckpointDiffQuery.CheckpointDiffQuery["Service"]>;
    browserTraceCollector?: Partial<BrowserTraceCollector.BrowserTraceCollector["Service"]>;
    serverLifecycleEvents?: Partial<ServerLifecycleEvents.ServerLifecycleEvents["Service"]>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartup.ServerRuntimeStartup["Service"]>;
    serverEnvironment?: Partial<ServerEnvironment.ServerEnvironment["Service"]>;
    repositoryIdentityResolver?: Partial<
      RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]
    >;
    cloudManagedEndpointRuntime?: Partial<
      CloudManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"]
    >;
    relayClient?: Partial<RelayClient.RelayClient["Service"]>;
    cloudCliTokenManager?: Partial<CloudCliTokenManager.CloudCliTokenManager["Service"]>;
    nativeTelemetryClient?: Partial<NativeTelemetryClient.NativeTelemetryClient["Service"]>;
    desktopTelemetryReceiver?: Partial<
      DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"]
    >;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl);
    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "desktop",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: defaultDesktopBootstrapToken,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      ...options?.config,
    };
    const layerConfig = ServerConfig.layer(config);
    const defaultVcsDriver: VcsDriver.VcsDriver["Service"] = {
      capabilities: {
        kind: "git",
        supportsWorktrees: true,
        supportsBookmarks: false,
        supportsAtomicSnapshot: false,
        supportsPushDefaultRemote: true,
        ignoreClassifier: "native",
      },
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      detectRepository: () => Effect.succeed(null),
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () =>
        Effect.succeed({
          paths: [],
          truncated: false,
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      listRemotes: () =>
        Effect.succeed({
          remotes: [],
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
      initRepository: () => Effect.void,
      ...options?.layers?.vcsDriver,
    };
    const vcsDriverRegistryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      get: () => Effect.succeed(defaultVcsDriver),
      detect: (input) =>
        defaultVcsDriver.detectRepository(input.cwd).pipe(
          Effect.flatMap((repository) =>
            repository
              ? Effect.succeed(repository)
              : defaultVcsDriver.isInsideWorkTree(input.cwd).pipe(
                  Effect.map((isInsideWorkTree) =>
                    isInsideWorkTree
                      ? {
                          kind: "git" as const,
                          rootPath: input.cwd,
                          metadataPath: null,
                          freshness: {
                            source: "live-local" as const,
                            observedAt: TEST_EPOCH,
                            expiresAt: Option.none(),
                          },
                        }
                      : null,
                  ),
                ),
          ),
          Effect.map((repository) =>
            repository
              ? ({
                  kind: repository.kind,
                  repository,
                  driver: defaultVcsDriver,
                } satisfies VcsDriverRegistry.VcsDriverHandle)
              : null,
          ),
        ),
      resolve: (input) =>
        Effect.succeed({
          kind:
            input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
          repository: {
            kind:
              input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
            rootPath: input.cwd,
            metadataPath: null,
            freshness: {
              source: "live-local",
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: defaultVcsDriver,
        }),
      ...options?.layers?.vcsDriverRegistry,
    });
    const gitVcsDriverLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
      ...options?.layers?.gitVcsDriver,
    });
    const gitManagerLayer = Layer.mock(GitManager.GitManager)({
      ...options?.layers?.gitManager,
    });
    const workspaceEntriesLayer = options?.layers?.workspaceEntries
      ? Layer.mock(WorkspaceEntries.WorkspaceEntries)(options.layers.workspaceEntries)
      : WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(vcsDriverRegistryLayer),
        );
    const workspaceAndProjectServicesLayer = Layer.mergeAll(
      WorkspacePaths.layer,
      workspaceEntriesLayer,
      Layer.mock(ProjectWorkspace.ProjectWorkspace)(options?.layers?.projectWorkspace ?? {}),
      Layer.mock(ProviderFilesystemBrowse.ProviderFilesystemBrowse)(
        options?.layers?.providerFilesystemBrowse ?? {},
      ),
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
    );
    const gitWorkflowLayer = GitWorkflowService.layer.pipe(
      Layer.provideMerge(vcsDriverRegistryLayer),
      Layer.provideMerge(gitVcsDriverLayer),
      Layer.provideMerge(gitManagerLayer),
    );
    const vcsProvisioningLayer = VcsProvisioningService.layer.pipe(
      Layer.provide(vcsDriverRegistryLayer),
    );
    const reviewLayer = options?.layers?.reviewService
      ? Layer.mock(ReviewService.ReviewService)({
          ...options.layers.reviewService,
        })
      : ReviewService.layer.pipe(
          Layer.provideMerge(gitVcsDriverLayer),
          Layer.provide(vcsDriverRegistryLayer),
        );
    const vcsStatusBroadcasterLayer = options?.layers?.vcsStatusBroadcaster
      ? Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          ...options.layers.vcsStatusBroadcaster,
        })
      : VcsStatusBroadcaster.layer.pipe(Layer.provide(gitWorkflowLayer));
    const resourceTelemetryLayer = ResourceTelemetry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NativeTelemetryClient.layerTest(options?.layers?.nativeTelemetryClient),
          DesktopTelemetryReceiver.layerTest(options?.layers?.desktopTelemetryReceiver),
          ResourceAttribution.layer,
        ),
      ),
    );

    const servedRoutesLayer = HttpRouter.serve(
      makeRoutesLayer.pipe(Layer.provide(ServiceLauncherClient.layer)),
      {
        disableListenLog: true,
        disableLogger: true,
      },
    ).pipe(
      Layer.provide(
        Layer.mock(Keybindings.Keybindings)({
          loadConfigState: Effect.succeed({
            keybindings: [],
            issues: [],
          }),
          streamChanges: Stream.empty,
          ...options?.layers?.keybindings,
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
          getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
            ),
          setProviderMaintenanceActionState: () => Effect.succeed([]),
          streamChanges: Stream.empty,
          ...options?.layers?.providerRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettings.ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () => Effect.succeed([]),
          ...options?.layers?.externalLauncher,
        }),
      ),
      Layer.provide(
        Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
          read: Effect.succeed({
            serverPid: process.pid,
            readAt: TEST_EPOCH,
            processCount: 0,
            totalRssBytes: 0,
            totalCpuPercent: 0,
            processes: [],
            error: Option.none(),
          }),
          signal: (input) =>
            Effect.succeed({
              pid: input.pid,
              signal: input.signal,
              signaled: true,
              message: Option.none(),
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({
          readHistory: (input) =>
            Effect.succeed({
              readAt: TEST_EPOCH,
              windowMs: input.windowMs,
              bucketMs: input.bucketMs,
              sampleIntervalMs: 5_000,
              retainedSampleCount: 0,
              totalCpuSecondsApprox: 0,
              buckets: [],
              topProcesses: [],
              error: Option.none(),
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(TraceDiagnostics.TraceDiagnostics)({
          read: () =>
            Effect.succeed({
              traceFilePath: "",
              scannedFilePaths: [],
              readAt: TEST_EPOCH,
              recordCount: 0,
              parseErrorCount: 0,
              firstSpanAt: Option.none(),
              lastSpanAt: Option.none(),
              failureCount: 0,
              interruptionCount: 0,
              slowSpanThresholdMs: 1_000,
              slowSpanCount: 0,
              logLevelCounts: {},
              topSpansByCount: [],
              slowestSpans: [],
              commonFailures: [],
              latestFailures: [],
              latestWarningAndErrorLogs: [],
              partialFailure: Option.none(),
              error: Option.none(),
            }),
        }),
      ),
      Layer.provide(gitManagerLayer),
      Layer.provide(gitVcsDriverLayer),
      Layer.provide(gitWorkflowLayer),
      Layer.provide(reviewLayer),
      Layer.provide(vcsProvisioningLayer),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          ...options?.layers?.sourceControlRepositoryService,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          vcsStatusBroadcasterLayer,
          Layer.mock(RepositoryReadService.RepositoryReadService)({
            status: () => Effect.succeed({ _tag: "NotRepository" as const }),
            listRefs: () => Effect.succeed({ _tag: "NotRepository" as const }),
            getReviewDiff: () => Effect.succeed({ _tag: "NotRepository" as const }),
            ...options?.layers?.repositoryReadService,
          }),
          Layer.mock(RepositoryStatusBroadcaster.RepositoryStatusBroadcaster)({
            refreshStatus: () => Effect.succeed({ _tag: "NotRepository" as const }),
            streamStatus: () =>
              Stream.make({
                _tag: "snapshot" as const,
                status: { _tag: "NotRepository" as const },
              }),
            ...options?.layers?.repositoryStatusBroadcaster,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
          ...options?.layers?.projectSetupScriptRunner,
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          ...options?.layers?.terminalManager,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PreviewManager.PreviewManager)({
            open: () => Effect.die("PreviewManager not stubbed in this test"),
            navigate: () => Effect.die("PreviewManager not stubbed in this test"),
            resize: () => Effect.die("PreviewManager not stubbed in this test"),
            reportStatus: () => Effect.void,
            refresh: () => Effect.void,
            close: () => Effect.void,
            list: () => Effect.succeed({ sessions: [], serverEpoch: "test-server", revision: 0 }),
            events: Stream.empty,
            subscribeEvents: Effect.flatMap(PubSub.unbounded<PreviewEvent>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          }),
          Layer.mock(PortScanner.PortDiscovery)({
            scan: () => Effect.succeed([]),
            subscribe: () => Effect.void,
            retain: Effect.void,
            registerTerminalProcesses: () => Effect.void,
            unregisterTerminal: () => Effect.void,
            ...options?.layers?.portDiscovery,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 0 }),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
          ...options?.layers?.orchestrationEngine,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getCommandReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: "1970-01-01T00:00:00.000Z",
            }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: "1970-01-01T00:00:00.000Z",
            }),
          searchThreads: () => Effect.succeed({ matches: [] }),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          ...options?.layers?.projectionSnapshotQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
    );

    const appLayer = servedRoutesLayer.pipe(
      Layer.provide(resourceTelemetryLayer),
      Layer.provide(
        Layer.mock(BrowserTraceCollector.BrowserTraceCollector)({
          record: () => Effect.void,
          ...options?.layers?.browserTraceCollector,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
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
          subscribe: Effect.succeed({
            latest: {
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
            },
            changes: Stream.empty,
          }),
          hasDemand: () => Effect.succeed(false),
          shouldRunScopeWork: () => Effect.succeed(false),
          shouldRunOpportunisticWork: Effect.succeed(false),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
          getDescriptor: Effect.succeed(testEnvironmentDescriptor),
          ...options?.layers?.serverEnvironment,
        }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
          ...options?.layers?.repositoryIdentityResolver,
        }),
      ),
      Layer.provide(
        Layer.succeed(
          CloudManagedEndpointRuntime.CloudManagedEndpointRuntime,
          CloudManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
            applyConfig: () => Effect.succeed({ status: "disabled" }),
            ...options?.layers?.cloudManagedEndpointRuntime,
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "missing",
              version: RelayClient.CLOUDFLARED_VERSION,
            }),
            install: Effect.die("unused relay-client install"),
            installWithProgress: () => Effect.die("unused relay-client install"),
            ...options?.layers?.relayClient,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(CloudCliTokenManager.CloudCliTokenManager)({
          get: Effect.die(new Error("Unexpected T3 Connect CLI authorization request.")),
          getExisting: Effect.succeed(Option.none()),
          hasCredential: Effect.succeed(false),
          clear: Effect.void,
          ...options?.layers?.cloudCliTokenManager,
        }),
      ),
      Layer.provideMerge(makeAuthTestLayer()),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(HttpResponseCompression.layerNode),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly url: string } => {
  const next = new URL(wsUrl);
  const cookie = next.hash.startsWith("#cookie=")
    ? decodeURIComponent(next.hash.slice("#cookie=".length))
    : null;
  next.hash = "";
  return {
    cookie,
    url: next.toString(),
  };
};

const wsRpcProtocolLayer = (wsUrl: string) => {
  const { cookie, url } = parseSessionCookieFromWsUrl(wsUrl);
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols,
        cookie ? { headers: { cookie } } : undefined,
      ) as unknown as globalThis.WebSocket,
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

const appendSessionCookieToWsUrl = (url: string, sessionCookieHeader: string) => {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const next = new URL(url, "http://localhost");
  next.hash = `cookie=${encodeURIComponent(sessionCookieHeader)}`;
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
};

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const bootstrapBrowserSession = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/browser-session");
    const response = yield* fetchEffect(bootstrapUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options?.headers,
      },
      body: jsonRequestBody({
        credential,
      }),
    });
    const body = yield* responseJsonEffect<{
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
    }>(response);
    return {
      response,
      body,
      cookie: response.headers["set-cookie"],
    };
  });

const exchangeAccessToken = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
    readonly scope?: string;
    readonly clientMetadata?: {
      readonly label?: string;
      readonly deviceType?: string;
      readonly os?: string;
    };
  },
) =>
  Effect.gen(function* () {
    const tokenUrl = yield* getHttpServerUrl("/oauth/token");
    const response = yield* fetchEffect(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...options?.headers,
      },
      body: new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope:
          options?.scope ??
          "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write",
        ...(options?.clientMetadata?.label ? { client_label: options.clientMetadata.label } : {}),
        ...(options?.clientMetadata?.deviceType
          ? { client_device_type: options.clientMetadata.deviceType }
          : {}),
        ...(options?.clientMetadata?.os ? { client_os: options.clientMetadata.os } : {}),
      }).toString(),
    });
    const body = yield* responseJsonEffect<{
      readonly access_token?: string;
      readonly issued_token_type?: string;
      readonly token_type?: string;
      readonly expires_in?: number;
      readonly scope?: string;
      readonly _tag?: string;
      readonly code?: string;
      readonly reason?: string;
      readonly traceId?: string;
    }>(response);
    return {
      response,
      body,
    };
  });

const makeDpopProof = (input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly accessToken?: string;
  readonly jti?: string;
  readonly privateKey?: NodeCrypto.KeyObject;
  readonly publicJwk?: DpopPublicJwk;
}) => {
  const keyPair =
    input.privateKey && input.publicJwk
      ? { privateKey: input.privateKey, publicJwk: input.publicJwk }
      : (() => {
          const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
            namedCurve: "P-256",
          });
          return { privateKey, publicJwk: publicKey.export({ format: "jwk" }) as DpopPublicJwk };
        })();
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: keyPair.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti ?? "proof-1",
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    proof: `${header}.${payload}.${signature}`,
    thumbprint: computeDpopJwkThumbprint(keyPair.publicJwk),
    privateKey: keyPair.privateKey,
    publicJwk: keyPair.publicJwk,
  };
};

const makeCloudMintCredentialRequest = (input: {
  readonly privateKey: string;
  readonly environmentId: EnvironmentId;
  readonly clientProofKeyThumbprint: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly jti?: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope?: ReadonlyArray<"environment:connect">;
}) => {
  const payload = {
    iss: input.issuer ?? "https://relay.example.test",
    aud: input.audience ?? `t3-env:${input.environmentId}`,
    sub: input.subject ?? "user_123",
    jti: input.jti ?? "cloud-mint-jti-1",
    environmentId: input.environmentId,
    clientProofKeyThumbprint: input.clientProofKeyThumbprint,
    cnf: {
      jkt: input.clientProofKeyThumbprint,
    },
    nonce: input.nonce,
    iat: Math.floor(DateTime.makeUnsafe(input.issuedAt).epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.makeUnsafe(input.expiresAt).epochMilliseconds / 1_000),
    scope: input.scope ?? ["environment:connect"],
  } as const;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_MINT_REQUEST_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return {
    proof: `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`,
  };
};

const makeCloudEnvironmentHealthRequest = (input: {
  readonly privateKey: string;
  readonly environmentId: EnvironmentId;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly jti?: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope?: ReadonlyArray<"environment:status">;
}) => {
  const payload = {
    iss: input.issuer ?? "https://relay.example.test",
    aud: input.audience ?? `t3-env:${input.environmentId}`,
    sub: input.subject ?? "user_123",
    jti: input.jti ?? "cloud-health-jti-1",
    environmentId: input.environmentId,
    nonce: input.nonce,
    iat: Math.floor(DateTime.makeUnsafe(input.issuedAt).epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.makeUnsafe(input.expiresAt).epochMilliseconds / 1_000),
    scope: input.scope ?? ["environment:status"],
  } as const;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_HEALTH_REQUEST_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return {
    proof: `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`,
  };
};

const decodeCompactJwtPayload = <A>(token: string): A => {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload) {
    throw new Error("JWT does not contain a payload.");
  }
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as A;
};

class AuthenticationGetterError extends Data.TaggedError("AuthenticationGetterError")<{
  readonly message: string;
}> {}

class TestHttpRequestError extends Data.TaggedError("TestHttpRequestError")<{
  readonly cause: unknown;
}> {}

const testRequestUrl = (input: Parameters<typeof fetch>[0]): string => {
  const value = input.toString();
  if (!/^https?:\/\//i.test(value)) {
    return value;
  }
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
};

const fetchEffect = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = HttpClientRequest.make((init?.method ?? "GET") as "GET" | "POST")(
    testRequestUrl(input),
    {
      headers: init?.headers as Record<string, string> | undefined,
    },
  ).pipe(
    typeof init?.body === "string"
      ? HttpClientRequest.bodyText(
          init.body,
          (init.headers as Record<string, string> | undefined)?.["content-type"] ??
            "application/json",
        )
      : (request) => request,
  );
  const effect = HttpClient.execute(request);
  return (
    init?.redirect === "manual"
      ? effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
      : effect
  ).pipe(Effect.mapError((cause) => new TestHttpRequestError({ cause })));
};

const jsonRequestBody = (value: unknown): string => {
  return JSON.stringify(value);
};

const responseJsonEffect = <A>(response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.map((json) => json as A),
    Effect.mapError((cause) => new TestHttpRequestError({ cause })),
  );

const responseOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

const getAuthenticatedSessionCookieHeader = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, cookie } = yield* bootstrapBrowserSession(credential);
    if (!responseOk(response)) {
      return yield* new AuthenticationGetterError({
        message: `Expected bootstrap session response to succeed, got ${response.status}`,
      });
    }

    if (!cookie) {
      return yield* new AuthenticationGetterError({
        message: "Expected bootstrap session response to set a cookie.",
      });
    }

    return cookie.split(";")[0] ?? cookie;
  });

const getAuthenticatedBearerSessionToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, body } = yield* exchangeAccessToken(credential);
    if (!responseOk(response)) {
      return yield* new AuthenticationGetterError({
        message: `Expected bearer bootstrap response to succeed, got ${response.status}`,
      });
    }

    if (!body.access_token) {
      return yield* new AuthenticationGetterError({
        message: "Expected token exchange response to include an access token.",
      });
    }

    return body.access_token;
  });

const extractSessionTokenFromSetCookie = (cookieHeader: string): string => {
  const [nameValue] = cookieHeader.split(";", 1);
  const token = nameValue?.split("=", 2)[1];
  if (!token) {
    throw new Error("Expected session cookie header to contain a token value.");
  }
  return token;
};

const splitHeaderTokens = (value: string | null | undefined) =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .toSorted();

const assertBrowserApiCorsResponseHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string;
    readonly credentials?: boolean;
  },
) => {
  assert.equal(headers["access-control-allow-origin"], options?.origin ?? "*");
  assert.equal(
    headers["access-control-allow-credentials"],
    options?.credentials ? "true" : undefined,
  );
};

const assertBrowserApiCorsPreflightHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string;
    readonly credentials?: boolean;
  },
) => {
  assertBrowserApiCorsResponseHeaders(headers, options);
  assert.deepEqual(splitHeaderTokens(headers["access-control-allow-methods"] ?? null), [
    "GET",
    "OPTIONS",
    "POST",
  ]);
  assert.deepEqual(splitHeaderTokens(headers["access-control-allow-headers"]), [
    "authorization",
    "b3",
    "content-type",
    "dpop",
    "traceparent",
  ]);
};
const crossOriginClientOrigin = "http://remote-client.test:3773";

const getWsServerUrl = (
  pathname = "",
  options?: { authenticated?: boolean; credential?: string },
) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const baseUrl = `ws://127.0.0.1:${address.port}${pathname}`;
    if (options?.authenticated === false) {
      return baseUrl;
    }
    return appendSessionCookieToWsUrl(
      baseUrl,
      yield* getAuthenticatedSessionCookieHeader(options?.credential),
    );
  });

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("parks HTTP ingress until command readiness", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-gate-" });
      yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "ready");
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();

      yield* buildAppUnderTest({
        config: { staticDir },
        layers: {
          serverRuntimeStartup: {
            awaitCommandReady: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(ready)),
            ),
          },
        },
      });
      const request = yield* HttpClient.get("/").pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      assert.isFalse(yield* Deferred.isDone(completed));

      yield* Deferred.succeed(ready, undefined);
      assert.equal((yield* Fiber.join(request)).status, 200);
      assert.isTrue(yield* Deferred.isDone(completed));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar?token=test-token");
      const response = yield* fetchEffect(url, { redirect: "manual" });

      assert.equal(response.status, 302);
      assert.equal(response.headers.location, "http://127.0.0.1:5173/foo/bar?token=test-token");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the public environment descriptor without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* fetchEffect(url);
      const body = yield* responseJsonEffect<typeof testEnvironmentDescriptor>(response);

      assert.equal(response.status, 200);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("compresses large JSON responses through the composed routes", () =>
    Effect.gen(function* () {
      const descriptor = {
        ...testEnvironmentDescriptor,
        label: "Test environment".repeat(100),
      };
      yield* buildAppUnderTest({
        layers: {
          serverEnvironment: {
            getDescriptor: Effect.succeed(descriptor),
          },
        },
      });

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* fetchEffect(url, {
        headers: {
          "accept-encoding": "gzip",
        },
      });
      const body = yield* responseJsonEffect<typeof descriptor>(response);

      assert.equal(response.status, 200);
      assert.equal(response.headers["content-encoding"], "gzip");
      assert.equal(response.headers.vary, "Accept-Encoding");
      assert.deepEqual(body, descriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on public environment descriptor responses", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* fetchEffect(url, {
        headers: {
          origin: crossOriginClientOrigin,
        },
      });
      const body = yield* responseJsonEffect<typeof testEnvironmentDescriptor>(response);

      assert.equal(response.status, 200);
      assertBrowserApiCorsResponseHeaders(response.headers);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports unauthenticated session state without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* fetchEffect(url);
      const body = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly auth: {
          readonly policy: string;
          readonly bootstrapMethods: ReadonlyArray<string>;
          readonly sessionMethods: ReadonlyArray<string>;
          readonly sessionCookieName: string;
        };
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(body.authenticated, false);
      assert.equal(body.auth.policy, "desktop-managed-local");
      assert.deepEqual(body.auth.bootstrapMethods, ["desktop-bootstrap"]);
      assert.deepEqual(body.auth.sessionMethods, [
        "browser-session-cookie",
        "bearer-access-token",
        "dpop-access-token",
      ]);
      // Desktop, so port-scoped: instances scan for a free port and share
      // 127.0.0.1, and cookies are not scoped by port.
      assert.isTrue(body.auth.sessionCookieName.startsWith("t3_session_"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("bootstraps a browser session and authenticates the session endpoint via cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const {
        response: bootstrapResponse,
        body: bootstrapBody,
        cookie: setCookie,
      } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.equal(bootstrapBody.authenticated, true);
      assert.equal(bootstrapBody.sessionMethod, "browser-session-cookie");
      assert.isUndefined((bootstrapBody as { readonly sessionToken?: string }).sessionToken);
      assert.isDefined(setCookie);

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          cookie: setCookie?.split(";")[0] ?? "",
        },
      });
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "browser-session-cookie");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("exchanges a bootstrap grant for a scoped bearer access token", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken();

      assert.equal(tokenResponse.status, 200);
      assert.equal(tokenBody.issued_token_type, AuthAccessTokenType);
      assert.equal(tokenBody.token_type, "Bearer");
      assert.equal(
        tokenBody.scope,
        "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write",
      );
      assert.equal(typeof tokenBody.access_token, "string");

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
      });
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
        readonly scopes?: ReadonlyArray<string>;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "bearer-access-token");
      assert.deepEqual(sessionBody.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("persists token exchange client display metadata for authorized-client listings", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string;
      };

      const { response } = yield* exchangeAccessToken(pairingBody.credential, {
        headers: {
          "user-agent": "undici",
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
        clientMetadata: {
          label: "T3 Code Mobile",
          deviceType: "mobile",
          os: "iOS",
        },
      });

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly current: boolean;
        readonly client: {
          readonly label?: string;
          readonly deviceType: string;
          readonly ipAddress?: string;
          readonly os?: string;
          readonly userAgent?: string;
        };
      }>;
      const mobileClient = clients.find((client) => !client.current);

      assert.equal(pairingResponse.status, 200);
      assert.equal(response.status, 200);
      assert.equal(clientsResponse.status, 200);
      assert.deepInclude(mobileClient?.client, {
        label: "T3 Code Mobile",
        deviceType: "mobile",
        os: "iOS",
        ipAddress: "127.0.0.1",
        userAgent: "undici",
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "exchanges a bootstrap credential for a DPoP-bound access token without bearer downgrade",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: { cookie: ownerCookie },
          body: yield* HttpBody.json({}),
        });
        const credential = (yield* credentialResponse.json) as { readonly credential: string };
        const tokenUrl = yield* getHttpServerUrl("/oauth/token");
        const now = yield* DateTime.now;
        const tokenProof = makeDpopProof({
          method: "POST",
          url: tokenUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000),
          jti: "token-exchange-proof",
        });
        const tokenResponse = yield* fetchEffect(tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: tokenProof.proof,
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: credential.credential,
            subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            scope: "orchestration:read orchestration:operate terminal:operate review:write",
          }).toString(),
        });
        const token = yield* responseJsonEffect<{
          readonly access_token: string;
          readonly token_type: string;
        }>(tokenResponse);

        assert.equal(tokenResponse.status, 200);
        assert.equal(tokenResponse.headers["cache-control"], "no-store");
        assert.equal(token.token_type, "DPoP");

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const bearerResponse = yield* fetchEffect(sessionUrl, {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        const bearerState = yield* responseJsonEffect<{ readonly authenticated: boolean }>(
          bearerResponse,
        );
        assert.equal(bearerState.authenticated, false);

        const sessionProof = makeDpopProof({
          method: "GET",
          url: sessionUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000),
          jti: "session-proof",
          accessToken: token.access_token,
          privateKey: tokenProof.privateKey,
          publicJwk: tokenProof.publicJwk,
        });
        const dpopResponse = yield* fetchEffect(sessionUrl, {
          headers: {
            authorization: `DPoP ${token.access_token}`,
            dpop: sessionProof.proof,
          },
        });
        const dpopState = yield* responseJsonEffect<{
          readonly authenticated: boolean;
          readonly sessionMethod?: string;
        }>(dpopResponse);
        assert.equal(dpopState.authenticated, true);
        assert.equal(dpopState.sessionMethod, "dpop-access-token");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects replayed DPoP proofs across token exchanges", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const firstCredentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const firstCredential = (yield* firstCredentialResponse.json) as {
        readonly credential: string;
      };
      const secondCredentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const secondCredential = (yield* secondCredentialResponse.json) as {
        readonly credential: string;
      };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });

      const firstBootstrap = yield* exchangeAccessToken(firstCredential.credential, {
        headers: {
          dpop: dpop.proof,
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });
      const replayBootstrap = yield* exchangeAccessToken(secondCredential.credential, {
        headers: {
          dpop: dpop.proof,
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });

      assert.equal(firstBootstrap.response.status, 200);
      assert.equal(replayBootstrap.response.status, 401);
      assert.equal(replayBootstrap.body._tag, "EnvironmentAuthInvalidError");
      assert.equal(replayBootstrap.body.code, "auth_invalid");
      assert.equal(replayBootstrap.body.reason, "invalid_credential");
      assert.equal(typeof replayBootstrap.body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("ignores forwarded host headers when validating token exchange DPoP URLs", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as {
        readonly credential: string;
      };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });

      const bootstrap = yield* exchangeAccessToken(credential.credential, {
        headers: {
          dpop: dpop.proof,
          "x-forwarded-host": "environment.example.test",
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });

      assert.equal(bootstrap.response.status, 200);
      assert.equal(bootstrap.body.token_type, "DPoP");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects token exchange DPoP proofs bound to spoofed forwarded hosts", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as {
        readonly credential: string;
      };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const spoofedUrl = new URL(tokenUrl);
      spoofedUrl.hostname = "environment.example.test";
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: spoofedUrl.href,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });

      const bootstrap = yield* exchangeAccessToken(credential.credential, {
        headers: {
          dpop: dpop.proof,
          "x-forwarded-host": spoofedUrl.host,
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });

      assert.equal(bootstrap.response.status, 401);
      assert.equal(bootstrap.body._tag, "EnvironmentAuthInvalidError");
      assert.equal(bootstrap.body.code, "auth_invalid");
      assert.equal(bootstrap.body.reason, "invalid_credential");
      assert.equal(typeof bootstrap.body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs for non-loopback managed endpoint origins", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const linkProofResponse = yield* fetchEffect(linkProofUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          challenge: "relay-link-challenge",
          relayIssuer: "https://relay.example.test",
          endpoint: {
            httpBaseUrl: "https://environment.example.test/",
            wsBaseUrl: "wss://environment.example.test/ws",
            providerKind: "manual",
          },
          origin: {
            localHttpHost: "192.168.1.42",
            localHttpPort: 3773,
          },
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(linkProofResponse);

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs for unsupported endpoint providers", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* fetchEffect(linkProofUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          challenge: "relay-link-challenge",
          relayIssuer: "https://relay.example.test",
          endpoint: {
            httpBaseUrl: linkProofUrl.replace("/api/connect/link-proof", ""),
            wsBaseUrl: linkProofUrl
              .replace("http://", "ws://")
              .replace("/api/connect/link-proof", "/ws"),
            // "manual" and "cloudflare_tunnel" are supported; "t3_relay" is not.
            providerKind: "t3_relay",
          },
          origin: {
            localHttpHost: "127.0.0.1",
            localHttpPort: serverPort,
          },
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(linkProofResponse);

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs requested through a public managed endpoint", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* HttpClient.post("/api/connect/link-proof", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          host: "environment.example.test",
          "x-forwarded-host": "environment.example.test",
          "x-forwarded-proto": "https",
        },
        body: HttpBody.text(
          jsonRequestBody({
            challenge: "relay-link-challenge",
            relayIssuer: "https://relay.example.test",
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "manual",
            },
            origin: {
              localHttpHost: "127.0.0.1",
              localHttpPort: serverPort,
            },
          }),
          "application/json",
        ),
      });
      const body = (yield* linkProofResponse.json) as {
        readonly _tag?: string;
        readonly message?: string;
      };

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "rejects cloud link proofs when a public request spoofs loopback forwarded headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
        const serverPort = Number(new URL(linkProofUrl).port);
        const linkProofResponse = yield* HttpClient.post("/api/connect/link-proof", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
            host: "environment.example.test",
            "x-forwarded-host": `127.0.0.1:${serverPort}`,
            "x-forwarded-proto": "http",
          },
          body: HttpBody.text(
            jsonRequestBody({
              challenge: "relay-link-challenge",
              relayIssuer: "https://relay.example.test",
              endpoint: {
                httpBaseUrl: "https://environment.example.test/",
                wsBaseUrl: "wss://environment.example.test/ws",
                providerKind: "manual",
              },
              origin: {
                localHttpHost: "127.0.0.1",
                localHttpPort: serverPort,
              },
            }),
            "application/json",
          ),
        });
        const body = (yield* linkProofResponse.json) as {
          readonly _tag?: string;
          readonly message?: string;
        };

        assert.equal(linkProofResponse.status, 400);
        assert.equal(body._tag, "EnvironmentHttpBadRequestError");
        assert.equal(body.message, "Invalid managed endpoint origin.");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs with malformed forwarded request hosts", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* HttpClient.post("/api/connect/link-proof", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          host: "bad host",
          "x-forwarded-host": "bad host",
          "x-forwarded-proto": "https",
        },
        body: HttpBody.text(
          jsonRequestBody({
            challenge: "relay-link-challenge",
            relayIssuer: "https://relay.example.test",
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "manual",
            },
            origin: {
              localHttpHost: "127.0.0.1",
              localHttpPort: serverPort,
            },
          }),
          "application/json",
        ),
      });
      const body = (yield* linkProofResponse.json) as {
        readonly _tag?: string;
        readonly message?: string;
      };

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects local cloud link proofs for a different loopback port", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* fetchEffect(linkProofUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          challenge: "relay-link-challenge",
          relayIssuer: "https://relay.example.test",
          endpoint: {
            httpBaseUrl: "https://environment.example.test/",
            wsBaseUrl: "wss://environment.example.test/ws",
            providerKind: "manual",
          },
          origin: {
            localHttpHost: "127.0.0.1",
            localHttpPort: serverPort === 65_535 ? serverPort - 1 : serverPort + 1,
          },
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(linkProofResponse);

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows standard clients to read managed relay configuration state", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: ownerCookie },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as { readonly credential: string };
      const pairedCookie = yield* getAuthenticatedSessionCookieHeader(credential.credential);
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
      const response = yield* fetchEffect(linkStateUrl, {
        headers: { cookie: pairedCookie },
      });
      const body = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly publishAgentActivity?: boolean;
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(body.linked, false);
      assert.equal(body.publishAgentActivity, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "reports relay client status and streams installation progress over environment RPC",
    () =>
      Effect.gen(function* () {
        const installedRelayClient = {
          status: "available" as const,
          executablePath: "/tmp/t3/tools/cloudflared",
          source: "managed" as const,
          version: RelayClient.CLOUDFLARED_VERSION,
        };
        yield* buildAppUnderTest({
          layers: {
            relayClient: {
              resolve: Effect.succeed({
                status: "missing",
                version: RelayClient.CLOUDFLARED_VERSION,
              }),
              install: Effect.succeed(installedRelayClient),
              installWithProgress: (report) =>
                report({ type: "progress", stage: "checking" }).pipe(
                  Effect.andThen(report({ type: "progress", stage: "downloading" })),
                  Effect.as(installedRelayClient),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const status = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.cloudGetRelayClientStatus]({})),
        );
        const installEvents = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.cloudInstallRelayClient]({}).pipe(Stream.runCollect),
          ),
        );

        assert.equal(status.status, "missing");
        assert.deepEqual(Array.from(installEvents), [
          { type: "progress", stage: "checking" },
          { type: "progress", stage: "downloading" },
          { type: "complete", status: installedRelayClient },
        ]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("requires relay write scope to update agent activity publication", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const preferencesUrl = yield* getHttpServerUrl("/api/connect/preferences");
      const ownerResponse = yield* fetchEffect(preferencesUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({ publishAgentActivity: true }),
      });
      const ownerBody = yield* responseJsonEffect<{
        readonly publishAgentActivity?: boolean;
      }>(ownerResponse);
      assert.equal(ownerResponse.status, 200);
      assert.equal(ownerBody.publishAgentActivity, true);

      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: ownerCookie },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as { readonly credential: string };
      const pairedCookie = yield* getAuthenticatedSessionCookieHeader(credential.credential);
      const pairedResponse = yield* fetchEffect(preferencesUrl, {
        method: "POST",
        headers: {
          cookie: pairedCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({ publishAgentActivity: false }),
      });
      const pairedBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly requiredScope?: string;
      }>(pairedResponse);
      assert.equal(pairedResponse.status, 403);
      assert.equal(pairedBody._tag, "EnvironmentScopeRequiredError");
      assert.equal(pairedBody.requiredScope, "relay:write");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects relay config with an invalid cloud mint public key", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: "not-a-public-key",
          endpointRuntime: null,
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(relayConfigResponse);

      assert.equal(relayConfigResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Cloud mint public key must be a valid Ed25519 public key.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects relay config with insecure relay metadata or empty credentials", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const postRelayConfig = (body: {
        readonly relayUrl: string;
        readonly relayIssuer?: string;
        readonly cloudUserId: string;
        readonly environmentCredential: string;
      }) =>
        fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            ...body,
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });

      const insecureRelayUrl = yield* postRelayConfig({
        relayUrl: "http://relay.example.test",
        cloudUserId: "user_123",
        environmentCredential: "t3env_test_credential",
      });
      const insecureRelayIssuer = yield* postRelayConfig({
        relayUrl: "https://relay.example.test",
        cloudUserId: "user_123",
        relayIssuer: "http://relay.example.test",
        environmentCredential: "t3env_test_credential",
      });
      const nonOriginRelayUrl = yield* postRelayConfig({
        relayUrl: "https://relay.example.test/path",
        cloudUserId: "user_123",
        environmentCredential: "t3env_test_credential",
      });
      const emptyCredential = yield* postRelayConfig({
        relayUrl: "https://relay.example.test",
        cloudUserId: "user_123",
        environmentCredential: "   ",
      });
      const insecureRelayUrlBody = yield* responseJsonEffect<{ readonly message?: string }>(
        insecureRelayUrl,
      );
      const insecureRelayIssuerBody = yield* responseJsonEffect<{ readonly message?: string }>(
        insecureRelayIssuer,
      );
      const nonOriginRelayUrlBody = yield* responseJsonEffect<{ readonly message?: string }>(
        nonOriginRelayUrl,
      );
      const emptyCredentialBody = yield* responseJsonEffect<{ readonly message?: string }>(
        emptyCredential,
      );

      assert.equal(insecureRelayUrl.status, 400);
      assert.equal(insecureRelayUrlBody.message, "Relay URL must be a secure absolute HTTPS URL.");
      assert.equal(insecureRelayIssuer.status, 400);
      assert.equal(
        insecureRelayIssuerBody.message,
        "Relay issuer must be a secure absolute HTTPS URL.",
      );
      assert.equal(nonOriginRelayUrl.status, 400);
      assert.equal(nonOriginRelayUrlBody.message, "Relay URL must be a secure absolute HTTPS URL.");
      assert.equal(emptyCredential.status, 400);
      assert.equal(emptyCredentialBody.message, "Relay environment credential is required.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects relay config replacement from a different cloud account", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const postRelayConfig = (cloudUserId: string, environmentCredential: string) =>
        fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://relay.example.test",
            cloudUserId,
            environmentCredential,
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });

      const firstResponse = yield* postRelayConfig("user_123", "t3env_first_credential");
      const replacementResponse = yield* postRelayConfig("user_456", "t3env_second_credential");
      const replacementBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(replacementResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replacementResponse.status, 409);
      assert.equal(replacementBody._tag, "EnvironmentHttpConflictError");
      assert.equal(
        replacementBody.message,
        "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports local cloud link state from persisted relay config", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");

      const initialResponse = yield* fetchEffect(linkStateUrl, {
        headers: {
          cookie: ownerCookie,
        },
      });
      const initialBody = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly cloudUserId?: string | null;
      }>(initialResponse);
      assert.equal(initialResponse.status, 200);
      assert.equal(initialBody.linked, false);
      assert.equal(initialBody.cloudUserId, null);

      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://transport.example.test",
          relayIssuer: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const linkedResponse = yield* fetchEffect(linkStateUrl, {
        headers: {
          cookie: ownerCookie,
        },
      });
      const linkedBody = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly cloudUserId?: string | null;
        readonly relayUrl?: string | null;
        readonly relayIssuer?: string | null;
      }>(linkedResponse);

      assert.equal(linkedResponse.status, 200);
      assert.equal(linkedBody.linked, true);
      assert.equal(linkedBody.cloudUserId, "user_123");
      assert.equal(linkedBody.relayUrl, "https://transport.example.test");
      assert.equal(linkedBody.relayIssuer, "https://relay.example.test");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not expose internal cloud reconciliation over HTTP", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const reconcileUrl = yield* getHttpServerUrl("/api/connect/reconcile");
      const response = yield* fetchEffect(reconcileUrl, {
        method: "POST",
      });

      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("unlinks local cloud state and disables the managed endpoint runtime", () =>
    Effect.gen(function* () {
      const appliedRuntimeConfigs: Array<unknown> = [];
      yield* buildAppUnderTest({
        layers: {
          cloudManagedEndpointRuntime: {
            applyConfig: (config) => {
              appliedRuntimeConfigs.push(config);
              if (!config) {
                return Effect.succeed({ status: "disabled" });
              }
              return Effect.succeed({
                status: "running",
                providerKind: "cloudflare_tunnel",
                pid: 123,
                ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
                ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
              });
            },
          },
        },
      });

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const unlinkUrl = yield* getHttpServerUrl("/api/connect/unlink");
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");

      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://transport.example.test",
          relayIssuer: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-id",
            tunnelName: "tunnel-name",
          },
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const unlinkResponse = yield* fetchEffect(unlinkUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
        },
      });
      const unlinkBody = yield* responseJsonEffect<{
        readonly ok?: boolean;
        readonly endpointRuntimeStatus?: { readonly status?: string };
      }>(unlinkResponse);
      assert.equal(unlinkResponse.status, 200);
      assert.equal(unlinkBody.ok, true);
      assert.equal(unlinkBody.endpointRuntimeStatus?.status, "disabled");

      const linkStateResponse = yield* fetchEffect(linkStateUrl, {
        headers: {
          cookie: ownerCookie,
        },
      });
      const linkStateBody = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly cloudUserId?: string | null;
        readonly relayUrl?: string | null;
        readonly relayIssuer?: string | null;
      }>(linkStateResponse);
      assert.equal(linkStateResponse.status, 200);
      assert.equal(linkStateBody.linked, false);
      assert.equal(linkStateBody.cloudUserId, null);
      assert.equal(linkStateBody.relayUrl, null);
      assert.equal(linkStateBody.relayIssuer, null);
      assert.deepEqual(appliedRuntimeConfigs, [
        {
          providerKind: "cloudflare_tunnel",
          connectorToken: "connector-token",
          tunnelId: "tunnel-id",
          tunnelName: "tunnel-name",
        },
        null,
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects replayed cloud mint requests atomically", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudMintCredentialRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        nonce: "cloud-mint-nonce-1",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const mintUrl = yield* getHttpServerUrl("/api/connect/mint-credential");
      const postMint = () =>
        fetchEffect(mintUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const firstResponse = yield* postMint();
      const replayResponse = yield* postMint();
      const replayBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(replayResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replayResponse.status, 409);
      assert.equal(replayBody._tag, "EnvironmentHttpConflictError");
      assert.equal(replayBody.message, "Cloud mint request was already consumed.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the documented T3 Connect mint credential endpoint", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudMintCredentialRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        jti: "cloud-mint-jti-documented-endpoint",
        nonce: "cloud-mint-nonce-documented-endpoint",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
      const response = yield* fetchEffect(mintUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(request),
      });

      assert.equal(response.status, 200);
      const body = yield* responseJsonEffect<{
        readonly credential?: string;
        readonly proof?: string;
      }>(response);
      assert.equal(typeof body.credential, "string");
      assert.equal(typeof body.proof, "string");
      assert.equal(
        decodeCompactJwtPayload<{ readonly requestNonce?: string }>(body.proof!).requestNonce,
        "cloud-mint-nonce-documented-endpoint",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves signed T3 Connect environment health checks", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudEnvironmentHealthRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        jti: "cloud-health-jti-documented-endpoint",
        nonce: "cloud-health-nonce-documented-endpoint",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const response = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(request),
      });

      assert.equal(response.status, 200);
      const body = yield* responseJsonEffect<{
        readonly status?: string;
        readonly descriptor?: { readonly environmentId?: string };
        readonly proof?: string;
      }>(response);
      assert.equal(body.status, "online");
      assert.equal(body.descriptor?.environmentId, testEnvironmentDescriptor.environmentId);
      assert.equal(typeof body.proof, "string");
      assert.equal(
        decodeCompactJwtPayload<{ readonly requestNonce?: string }>(body.proof!).requestNonce,
        "cloud-health-nonce-documented-endpoint",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects replayed cloud health requests atomically", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudEnvironmentHealthRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        jti: "cloud-health-jti-replay",
        nonce: "cloud-health-nonce-replay",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const postHealth = () =>
        fetchEffect(healthUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const firstResponse = yield* postHealth();
      const replayResponse = yield* postHealth();
      const replayBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(replayResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replayResponse.status, 409);
      assert.equal(replayBody._tag, "EnvironmentHttpConflictError");
      assert.equal(replayBody.message, "Cloud health request was already consumed.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "validates cloud proofs against the configured relay issuer, not the transport URL",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
        const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://transport.example.test",
            cloudUserId: "user_123",
            relayIssuer: "https://relay.example.test",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });
        assert.equal(relayConfigResponse.status, 200);

        const now = yield* DateTime.now;
        const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
        const postMint = (request: ReturnType<typeof makeCloudMintCredentialRequest>) =>
          fetchEffect(mintUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: jsonRequestBody(request),
          });

        const acceptedResponse = yield* postMint(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            issuer: "https://relay.example.test",
            jti: "cloud-mint-jti-explicit-relay-issuer",
            nonce: "cloud-mint-nonce-explicit-relay-issuer",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        );
        const rejectedResponse = yield* postMint(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            issuer: "https://transport.example.test",
            jti: "cloud-mint-jti-transport-url",
            nonce: "cloud-mint-nonce-transport-url",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        );

        assert.equal(acceptedResponse.status, 200);
        assert.equal(rejectedResponse.status, 401);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("fails relay config when the managed endpoint connector cannot start", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          cloudManagedEndpointRuntime: {
            applyConfig: () =>
              Effect.succeed({
                status: "failed",
                providerKind: "cloudflare_tunnel",
                reason: "cloudflared missing",
                tunnelId: "tunnel-1",
              }),
          },
        },
      });

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-1",
          },
        }),
      });

      assert.equal(relayConfigResponse.status, 503);
      const relayConfigBody = yield* responseJsonEffect<{
        _tag?: string;
        message?: string;
        endpointRuntimeStatus?: { status?: string; reason?: string };
      }>(relayConfigResponse);
      assert.equal(relayConfigBody._tag, "EnvironmentCloudEndpointUnavailableError");
      assert.equal(relayConfigBody.message, "Managed endpoint runtime could not be started.");
      assert.equal(relayConfigBody.endpointRuntimeStatus?.status, "failed");
      assert.equal(relayConfigBody.endpointRuntimeStatus?.reason, "cloudflared missing");

      const now = yield* DateTime.now;
      const healthRequest = makeCloudEnvironmentHealthRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        nonce: "cloud-health-after-failed-runtime",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const healthResponse = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(healthRequest),
      });
      const healthBody = yield* responseJsonEffect<{
        _tag?: string;
        message?: string;
      }>(healthResponse);
      assert.equal(healthResponse.status, 500);
      assert.equal(healthBody._tag, "EnvironmentHttpInternalServerError");
      assert.equal(
        healthBody.message,
        "Cloud mint public key is not installed for this environment.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud mint requests with the wrong issuer or audience", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const mintUrl = yield* getHttpServerUrl("/api/connect/mint-credential");
      const postMint = (request: ReturnType<typeof makeCloudMintCredentialRequest>) =>
        fetchEffect(mintUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const wrongIssuer = yield* postMint(
        makeCloudMintCredentialRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
          issuer: "https://attacker.example.test",
          jti: "cloud-mint-jti-wrong-issuer",
          nonce: "cloud-mint-nonce-wrong-issuer",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );
      const wrongAudience = yield* postMint(
        makeCloudMintCredentialRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
          audience: "t3-env:other-environment",
          jti: "cloud-mint-jti-wrong-audience",
          nonce: "cloud-mint-nonce-wrong-audience",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );

      assert.equal(wrongIssuer.status, 401);
      assert.equal(wrongAudience.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud mint requests for a cloud subject other than the linked user", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
      const response = yield* fetchEffect(mintUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            subject: "user_other",
            jti: "cloud-mint-jti-wrong-subject",
            nonce: "cloud-mint-nonce-wrong-subject",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud mint requests without the exact connect scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
      const response = yield* fetchEffect(mintUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            jti: "cloud-mint-jti-duplicate-scope",
            nonce: "cloud-mint-nonce-duplicate-scope",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            scope: ["environment:connect", "environment:connect"],
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud health requests with the wrong issuer or audience", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const postHealth = (request: ReturnType<typeof makeCloudEnvironmentHealthRequest>) =>
        fetchEffect(healthUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const wrongIssuer = yield* postHealth(
        makeCloudEnvironmentHealthRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          issuer: "https://attacker.example.test",
          jti: "cloud-health-jti-wrong-issuer",
          nonce: "cloud-health-nonce-wrong-issuer",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );
      const wrongAudience = yield* postHealth(
        makeCloudEnvironmentHealthRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          audience: "t3-env:other-environment",
          jti: "cloud-health-jti-wrong-audience",
          nonce: "cloud-health-nonce-wrong-audience",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );

      assert.equal(wrongIssuer.status, 401);
      assert.equal(wrongAudience.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud health requests for a cloud subject other than the linked user", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const response = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudEnvironmentHealthRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            subject: "user_other",
            jti: "cloud-health-jti-wrong-subject",
            nonce: "cloud-health-nonce-wrong-subject",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud health requests without the exact status scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const response = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudEnvironmentHealthRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            jti: "cloud-health-jti-duplicate-scope",
            nonce: "cloud-health-nonce-duplicate-scope",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            scope: ["environment:status", "environment:status"],
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("negotiates permessage-deflate with clients that offer it", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { cookie, url } = parseSessionCookieFromWsUrl(yield* getWsServerUrl("/ws"));
      const openSocket = (perMessageDeflate: boolean) =>
        Effect.acquireRelease(
          Effect.callback<NodeSocket.NodeWS.WebSocket, Error>((resume) => {
            const socket = new NodeSocket.NodeWS.WebSocket(url, {
              perMessageDeflate,
              ...(cookie ? { headers: { cookie } } : {}),
            });
            socket.on("open", () => resume(Effect.succeed(socket)));
            socket.on("error", (error) => resume(Effect.fail(error)));
          }),
          (socket) => Effect.sync(() => socket.close()),
        );

      const compressed = yield* openSocket(true);
      // The ws client records the negotiated extension only when the server's
      // 101 response accepted the offer.
      assert.include(compressed.extensions, "permessage-deflate");

      const plain = yield* openSocket(false);
      assert.notInclude(plain.extensions, "permessage-deflate");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues short-lived websocket tickets for authenticated bearer sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
      });
      const wsTicketBody = yield* responseJsonEffect<{
        readonly ticket: string;
        readonly expiresAt: string;
      }>(wsTicketResponse);

      assert.equal(wsTicketResponse.status, 200);
      assert.equal(typeof wsTicketBody.ticket, "string");
      assert.isTrue(wsTicketBody.ticket.length > 0);
      assert.equal(typeof wsTicketBody.expiresAt, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not allow management-only access tokens to operate the environment", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: exchangeResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        { scope: "access:write" },
      );
      assert.equal(exchangeResponse.status, 200);
      assert.equal(tokenBody.scope, "access:write");
      assert.isDefined(tokenBody.access_token);

      const overbroadPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
        body: yield* HttpBody.json({}),
      });
      const overbroadPairingBody = (yield* overbroadPairingResponse.json) as {
        readonly requiredScope: string;
      };
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
        body: yield* HttpBody.json({ scopes: ["access:write"] }),
      });
      const wsTicketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
      });
      const wsTicketBody = (yield* wsTicketResponse.json) as { readonly ticket: string };
      assert.equal(overbroadPairingResponse.status, 403);
      assert.equal(overbroadPairingBody.requiredScope, "orchestration:read");
      assert.equal(pairingResponse.status, 200);
      assert.equal(wsTicketResponse.status, 200);
      const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;
      const rpcError = yield* Effect.flip(
        Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
      );
      assert.equal(rpcError._tag, "EnvironmentAuthorizationError");
      if (rpcError._tag === "EnvironmentAuthorizationError") {
        assert.equal(rpcError.requiredScope, "orchestration:read");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on remote auth success responses", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const origin = crossOriginClientOrigin;
      const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        {
          headers: { origin },
        },
      );

      assert.equal(tokenResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(tokenResponse.headers);
      assert.equal(tokenBody.token_type, "Bearer");
      assert.equal(typeof tokenBody.access_token, "string");

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          origin,
        },
      });
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(sessionResponse.headers);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "bearer-access-token");

      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          origin,
        },
      });
      const wsTicketBody = yield* responseJsonEffect<{
        readonly ticket: string;
      }>(wsTicketResponse);

      assert.equal(wsTicketResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(wsTicketResponse.headers);
      assert.equal(typeof wsTicketBody.ticket, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "responds to remote auth websocket-ticket preflight requests with authorization CORS headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
        const response = yield* fetchEffect(wsTicketUrl, {
          method: "OPTIONS",
          headers: {
            origin: crossOriginClientOrigin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization",
          },
        });

        assert.equal(response.status, 204);
        assertBrowserApiCorsPreflightHeaders(response.headers);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows credentialed cloud link proof preflights from the configured dev UI", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL(crossOriginClientOrigin) },
      });

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const response = yield* fetchEffect(linkProofUrl, {
        method: "OPTIONS",
        headers: {
          origin: crossOriginClientOrigin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assertBrowserApiCorsPreflightHeaders(response.headers, {
        origin: crossOriginClientOrigin,
        credentials: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows configured development origins through ServerConfig", () =>
    Effect.gen(function* () {
      const tailnetOrigin = "https://host.example.ts.net";
      yield* buildAppUnderTest({
        config: {
          devUrl: new URL(crossOriginClientOrigin),
          devAllowedOrigins: [tailnetOrigin],
        },
      });

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* fetchEffect(sessionUrl, {
        method: "OPTIONS",
        headers: {
          origin: tailnetOrigin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assertBrowserApiCorsPreflightHeaders(response.headers, {
        origin: tailnetOrigin,
        credentials: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const desktopOrigin of ["t3code://app", "t3code-dev://app"]) {
    it.effect(`allows credentialed preflights from ${desktopOrigin} in development`, () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: { devUrl: new URL(crossOriginClientOrigin) },
        });

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const response = yield* fetchEffect(sessionUrl, {
          method: "OPTIONS",
          headers: {
            origin: desktopOrigin,
            "access-control-request-method": "GET",
            "access-control-request-headers": "content-type",
          },
        });

        assert.equal(response.status, 204);
        assertBrowserApiCorsPreflightHeaders(response.headers, {
          origin: desktopOrigin,
          credentials: true,
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  }

  it.effect("includes CORS headers on remote websocket-ticket auth failures", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const response = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          origin: crossOriginClientOrigin,
        },
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly code?: string;
        readonly reason?: string;
        readonly traceId?: string;
      }>(response);

      assert.equal(response.status, 401);
      assertBrowserApiCorsResponseHeaders(response.headers);
      assert.equal(body._tag, "EnvironmentAuthInvalidError");
      assert.equal(body.code, "auth_invalid");
      assert.equal(body.reason, "missing_credential");
      assert.equal(typeof body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues authenticated one-time pairing credentials for additional clients", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({}),
      });
      const body = (yield* response.json) as {
        readonly credential: string;
        readonly expiresAt: string;
      };

      assert.equal(response.status, 200);
      assert.equal(typeof body.credential, "string");
      assert.isTrue(body.credential.length > 0);
      assert.equal(typeof body.expiresAt, "string");

      const bootstrapResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(bootstrapResult.response.status, 200);

      const reusedResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(reusedResult.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues pairing credentials for bearer sessions with access management scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
        body: yield* HttpBody.json({ label: "Hosted web" }),
      });
      const body = (yield* response.json) as {
        readonly credential: string;
        readonly label?: string;
      };

      assert.equal(response.status, 200);
      assert.isTrue(body.credential.length > 0);
      assert.equal(body.label, "Hosted web");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects pairing credentials with an empty scope grant", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({ scopes: [] }),
      });
      const body = (yield* response.json) as {
        readonly code: string;
        readonly reason: string;
      };

      assert.equal(response.status, 400);
      assert.equal(body.code, "invalid_request");
      assert.equal(body.reason, "invalid_scope");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects unauthenticated pairing credential requests", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        body: yield* HttpBody.json({}),
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists and revokes pairing links for access management sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const createdBody = (yield* createdResponse.json) as {
        readonly id: string;
        readonly credential: string;
      };

      const listResponse = yield* HttpClient.get("/api/auth/pairing-links", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const listedLinks = (yield* listResponse.json) as ReadonlyArray<{
        readonly id: string;
        readonly credential: string;
      }>;

      const revokeResponse = yield* HttpClient.post("/api/auth/pairing-links/revoke", {
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: HttpBody.text(jsonRequestBody({ id: createdBody.id }), "application/json"),
      });
      const revokedBootstrap = yield* bootstrapBrowserSession(createdBody.credential);

      assert.equal(createdResponse.status, 200);
      assert.equal(listResponse.status, 200);
      assert.isTrue(listedLinks.some((entry) => entry.id === createdBody.id));
      assert.equal(revokeResponse.status, 200);
      assert.equal(revokedBootstrap.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects pairing credential requests without access management scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({}),
      });
      const ownerBody = (yield* ownerResponse.json) as {
        readonly credential: string;
      };
      assert.equal(ownerResponse.status, 200);

      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(ownerBody.credential);
      const pairedResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const pairedBody = (yield* pairedResponse.json) as {
        readonly _tag: string;
        readonly code: string;
        readonly requiredScope: string;
        readonly traceId: string;
      };

      assert.equal(pairedResponse.status, 403);
      assert.equal(pairedBody._tag, "EnvironmentScopeRequiredError");
      assert.equal(pairedBody.code, "insufficient_scope");
      assert.equal(pairedBody.requiredScope, "access:write");
      assert.equal(typeof pairedBody.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists paired clients and revokes other sessions while keeping the administrator", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingTokenUrl = yield* getHttpServerUrl("/api/auth/pairing-token");
      const ownerPairingResponse = yield* fetchEffect(pairingTokenUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          label: "Julius iPhone",
        }),
      });
      const ownerPairingBody = yield* responseJsonEffect<{
        readonly credential: string;
        readonly label?: string;
      }>(ownerPairingResponse);
      assert.equal(ownerPairingResponse.status, 200);
      const pairedSessionBootstrap = yield* bootstrapBrowserSession(ownerPairingBody.credential, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        },
      });
      const pairedSessionCookie = pairedSessionBootstrap.cookie?.split(";")[0];
      assert.isDefined(pairedSessionCookie);

      const pairedSessionCookieHeader = pairedSessionCookie ?? "";
      const listBeforeResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clientsBefore = (yield* listBeforeResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
        readonly client: {
          readonly label?: string;
          readonly deviceType: string;
          readonly ipAddress?: string;
          readonly os?: string;
          readonly browser?: string;
        };
      }>;
      const pairedClientBefore = clientsBefore.find((entry) => !entry.current);
      const pairedSessionId = clientsBefore.find((entry) => !entry.current)?.sessionId;

      const revokeOthersResponse = yield* HttpClient.post("/api/auth/clients/revoke-others", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const revokeOthersBody = (yield* revokeOthersResponse.json) as {
        readonly revokedCount: number;
      };

      const listAfterResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clientsAfter = (yield* listAfterResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;

      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookieHeader,
        },
        body: yield* HttpBody.json({}),
      });
      const pairedClientPairingBody = (yield* pairedClientPairingResponse.json) as {
        readonly _tag: string;
        readonly code: string;
        readonly reason: string;
        readonly traceId: string;
      };

      assert.equal(listBeforeResponse.status, 200);
      assert.equal(ownerPairingBody.label, "Julius iPhone");
      assert.lengthOf(clientsBefore, 2);
      assert.isDefined(pairedSessionId);
      assert.isDefined(pairedClientBefore);
      assert.deepInclude(pairedClientBefore?.client, {
        label: "Julius iPhone",
        deviceType: "mobile",
        os: "iOS",
        browser: "Safari",
        ipAddress: "127.0.0.1",
      });
      assert.equal(revokeOthersResponse.status, 200);
      assert.equal(revokeOthersBody.revokedCount, 1);
      assert.equal(listAfterResponse.status, 200);
      assert.lengthOf(clientsAfter, 1);
      assert.equal(clientsAfter[0]?.current, true);
      assert.equal(pairedClientPairingResponse.status, 401);
      assert.equal(pairedClientPairingBody._tag, "EnvironmentAuthInvalidError");
      assert.equal(pairedClientPairingBody.code, "auth_invalid");
      assert.equal(pairedClientPairingBody.reason, "invalid_credential");
      assert.equal(typeof pairedClientPairingBody.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("separates access inventory reads from credential management writes", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const issueScopedSession = Effect.fnUntraced(function* (
        scope: "access:read" | "access:write",
      ) {
        const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: ownerCookie,
          },
          body: yield* HttpBody.json({ scopes: [scope] }),
        });
        assert.equal(pairingResponse.status, 200);
        const pairingBody = (yield* pairingResponse.json) as {
          readonly credential: string;
        };
        return yield* getAuthenticatedSessionCookieHeader(pairingBody.credential);
      });

      const readCookie = yield* issueScopedSession("access:read");
      const readListResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: readCookie,
        },
      });
      const readWriteResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: readCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const readWriteBody = (yield* readWriteResponse.json) as {
        readonly requiredScope: string;
      };

      const writeCookie = yield* issueScopedSession("access:write");
      const writeListResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: writeCookie,
        },
      });
      const writeListBody = (yield* writeListResponse.json) as {
        readonly requiredScope: string;
      };

      assert.equal(readListResponse.status, 200);
      assert.equal(readWriteResponse.status, 403);
      assert.equal(readWriteBody.requiredScope, "access:write");
      assert.equal(writeListResponse.status, 403);
      assert.equal(writeListBody.requiredScope, "access:read");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revokes an individual paired client session", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string;
      };
      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(
        pairingBody.credential,
      );

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;
      const pairedSessionId = clients.find((entry) => !entry.current)?.sessionId;
      assert.isDefined(pairedSessionId);

      const revokeResponse = yield* HttpClient.post("/api/auth/clients/revoke", {
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: HttpBody.text(jsonRequestBody({ sessionId: pairedSessionId }), "application/json"),
      });
      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
        body: yield* HttpBody.json({}),
      });

      assert.equal(revokeResponse.status, 200);
      assert.equal(pairedClientPairingResponse.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows reusing the desktop bootstrap credential", () =>
    Effect.gen(function* () {
      // The desktop-bootstrap grant is delivered over trusted IPC at
      // backend launch and needs to stay claimable after a renderer
      // refresh, so it's intentionally reusable (unlike user-facing
      // one-time pairing credentials).
      yield* buildAppUnderTest();

      const first = yield* bootstrapBrowserSession();
      const second = yield* bootstrapBrowserSession();

      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 200);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts websocket rpc handshake with a bootstrapped browser session cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: bootstrapResponse, cookie } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.isDefined(cookie);

      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl("/ws", { authenticated: false }),
        cookie?.split(";")[0] ?? "",
      );
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );

      assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
      assert.equal(response.auth.policy, "desktop-managed-local");
      assert.notProperty(response, "cwd");
      assert.equal(response.environment.capabilities.workspaceMutations, false);
      assert.equal(response.shellResumeCompletionMarker, true);
      assert.equal(response.threadResumeCompletionMarker, true);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not block server config when editor discovery never resolves", () =>
    Effect.gen(function* () {
      const discoveryInterrupted = yield* Deferred.make<void>();
      const responseFiber = yield* resolveAvailableEditorsForConfig(
        Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
        ),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(5));

      const availableEditors = yield* Fiber.join(responseFiber);
      yield* Deferred.await(discoveryInterrupted);
      assert.deepEqual(availableEditors, []);
    }),
  );

  it.effect(
    "rejects websocket rpc handshake when a session token is only provided via query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { cookie } = yield* bootstrapBrowserSession();
        assert.isDefined(cookie);
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?token=${encodeURIComponent(sessionToken)}`;

        const error = yield* Effect.flip(
          Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
        );

        assert.equal(error._tag, "RpcClientError");
        assertInclude(String(error), "SocketOpenError");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "accepts websocket rpc handshake with a dedicated websocket ticket in the query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const bearerToken = yield* getAuthenticatedBearerSessionToken();
        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
        const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
          },
        });
        const wsTicketBody = yield* responseJsonEffect<{
          readonly ticket: string;
        }>(wsTicketResponse);
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;

        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        );

        assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
        assert.equal(response.auth.policy, "desktop-managed-local");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("proxies browser OTLP trace exports through the server", () =>
    Effect.gen(function* () {
      const upstreamRequests: Array<{
        readonly body: string;
        readonly contentType: string | null;
      }> = [];
      const localTraceRecords: Array<unknown> = [];
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "t3-web" },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: "effect",
                  version: "4.0.0-beta.43",
                },
                spans: [
                  {
                    traceId: "11111111111111111111111111111111",
                    spanId: "2222222222222222",
                    parentSpanId: "3333333333333333",
                    name: "RpcClient.server.getSettings",
                    kind: 3,
                    startTimeUnixNano: "1000000",
                    endTimeUnixNano: "2000000",
                    attributes: [
                      {
                        key: "rpc.method",
                        value: { stringValue: "server.getSettings" },
                      },
                    ],
                    events: [
                      {
                        name: "http.request",
                        timeUnixNano: "1500000",
                        attributes: [
                          {
                            key: "http.status_code",
                            value: { intValue: "200" },
                          },
                        ],
                      },
                    ],
                    links: [],
                    status: {
                      code: "STATUS_CODE_OK",
                    },
                    flags: 1,
                  },
                ],
              },
            ],
          },
        ],
      };

      const collector = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const NodeHttp = await import("node:http");

          return await new Promise<{
            readonly close: () => Promise<void>;
            readonly url: string;
          }>((resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              const chunks: Buffer[] = [];
              request.on("data", (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              });
              request.on("end", () => {
                upstreamRequests.push({
                  body: Buffer.concat(chunks).toString("utf8"),
                  contentType: request.headers["content-type"] ?? null,
                });
                response.statusCode = 204;
                response.end();
              });
            });

            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                reject(new Error("Expected TCP collector address"));
                return;
              }

              resolve({
                url: `http://127.0.0.1:${address.port}/v1/traces`,
                close: () =>
                  new Promise<void>((resolveClose, rejectClose) => {
                    server.close((error) => {
                      if (error) {
                        rejectClose(error);
                        return;
                      }
                      resolveClose();
                    });
                  }),
              });
            });
          });
        }),
        ({ close }) => Effect.promise(close),
      );

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: collector.url,
        },
        layers: {
          browserTraceCollector: {
            record: (records) =>
              Effect.sync(() => {
                localTraceRecords.push(...records);
              }),
          },
        },
      });

      const response = yield* HttpClient.post("/api/observability/v1/traces", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          origin: "http://localhost:5733",
        },
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        body: HttpBody.text(JSON.stringify(payload), "application/json"),
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.deepEqual(localTraceRecords, [
        {
          type: "otlp-span",
          name: "RpcClient.server.getSettings",
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          parentSpanId: "3333333333333333",
          sampled: true,
          kind: "client",
          startTimeUnixNano: "1000000",
          endTimeUnixNano: "2000000",
          durationMs: 1,
          attributes: {
            "rpc.method": "server.getSettings",
          },
          resourceAttributes: {
            "service.name": "t3-web",
          },
          scope: {
            name: "effect",
            version: "4.0.0-beta.43",
            attributes: {},
          },
          events: [
            {
              name: "http.request",
              timeUnixNano: "1500000",
              attributes: {
                "http.status_code": "200",
              },
            },
          ],
          links: [],
          status: {
            code: "STATUS_CODE_OK",
          },
        },
      ]);
      assert.deepEqual(upstreamRequests, [
        {
          body: jsonRequestBody(payload),
          contentType: "application/json",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("responds to browser OTLP trace preflight requests with CORS headers", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.options("/api/observability/v1/traces", {
        headers: {
          origin: "http://localhost:5733",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.deepEqual(splitHeaderTokens(response.headers["access-control-allow-methods"]), [
        "GET",
        "OPTIONS",
        "POST",
      ]);
      assert.deepEqual(splitHeaderTokens(response.headers["access-control-allow-headers"]), [
        "authorization",
        "b3",
        "content-type",
        "dpop",
        "traceparent",
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "stores browser OTLP trace exports locally when no upstream collector is configured",
    () =>
      Effect.gen(function* () {
        const localTraceRecords: Array<unknown> = [];
        const payload = yield* makeBrowserOtlpPayload("client.test");
        const resourceSpan = payload.resourceSpans[0];
        const scopeSpan = resourceSpan?.scopeSpans[0];
        const span = scopeSpan?.spans[0];

        assert.notEqual(resourceSpan, undefined);
        assert.notEqual(scopeSpan, undefined);
        assert.notEqual(span, undefined);
        if (!resourceSpan || !scopeSpan || !span) {
          return;
        }

        yield* buildAppUnderTest({
          layers: {
            browserTraceCollector: {
              record: (records) =>
                Effect.sync(() => {
                  localTraceRecords.push(...records);
                }),
            },
          },
        });

        const response = yield* HttpClient.post("/api/observability/v1/traces", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
          },
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          body: HttpBody.text(JSON.stringify(payload), "application/json"),
        });

        assert.equal(response.status, 204);
        assert.equal(localTraceRecords.length, 1);
        const record = localTraceRecords[0] as {
          readonly type: string;
          readonly name: string;
          readonly traceId: string;
          readonly spanId: string;
          readonly kind: string;
          readonly attributes: Readonly<Record<string, unknown>>;
          readonly events: ReadonlyArray<unknown>;
          readonly links: ReadonlyArray<unknown>;
          readonly scope: {
            readonly name?: string;
            readonly attributes: Readonly<Record<string, unknown>>;
          };
          readonly resourceAttributes: Readonly<Record<string, unknown>>;
          readonly status?: {
            readonly code?: string;
          };
        };

        assert.equal(record.type, "otlp-span");
        assert.equal(record.name, span.name);
        assert.equal(record.traceId, span.traceId);
        assert.equal(record.spanId, span.spanId);
        assert.equal(record.kind, "internal");
        assert.deepEqual(record.attributes, {});
        assert.deepEqual(record.events, []);
        assert.deepEqual(record.links, []);
        assert.equal(record.scope.name, scopeSpan.scope.name);
        assert.deepEqual(record.scope.attributes, {});
        assert.equal(record.resourceAttributes["service.name"], "t3-web");
        assert.equal(record.status?.code, String(span.status.code));
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.removeKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            removeKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverRemoveKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("shares one preview automation broker across websocket sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const firstConnected = yield* Deferred.make<string>();
        const firstClosed = yield* Deferred.make<void>();
        const host = {
          clientId: "shared-preview-host",
          environmentId: testEnvironmentDescriptor.environmentId,
        } as const;

        yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(
            Stream.tap((event) =>
              event.type === "connected"
                ? Deferred.succeed(firstConnected, event.connectionId)
                : Effect.void,
            ),
            Stream.runDrain,
            Effect.ensuring(Deferred.succeed(firstClosed, undefined)),
          ),
        ).pipe(Effect.forkScoped);

        const firstConnectionId = yield* Deferred.await(firstConnected);
        const replacementEvent = yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(Stream.runHead),
        ).pipe(Effect.map(Option.getOrThrow));
        const firstStreamClosed = yield* Deferred.await(firstClosed).pipe(
          Effect.timeoutOption("2 seconds"),
        );

        assert.equal(replacementEvent.type, "connected");
        assert.notEqual(replacementEvent.connectionId, firstConnectionId);
        assert.isTrue(Option.isSome(firstStreamClosed));
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when session authentication is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            target: { projectId: defaultProjectId },
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      const failureMessage = String(result.failure);
      assertTrue(
        failureMessage.includes("SocketOpenError") || failureMessage.includes("SocketCloseError"),
      );
      assertTrue(
        failureMessage.includes("Unauthorized") ||
          failureMessage.includes("An error occurred during Open"),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const providers = [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.equal(first.config.observability.logsDirectoryPath.endsWith("/logs"), true);
        assert.equal(first.config.observability.localTracingEnabled, true);
        assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(first.config.observability.otlpTracesEnabled, true);
        assert.equal(first.config.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(first.config.observability.otlpMetricsEnabled, true);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: { keybindings: [], issues: [] },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket resource telemetry through the subscription", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const snapshot = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeResourceTelemetry]({}).pipe(Stream.runHead),
        ),
      );

      assertTrue(Option.isSome(snapshot));
      assert.equal(snapshot.value.processes.length, 0);
      assert.equal(snapshot.value.groups.backend.processCount, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig emits provider status updates", () =>
    Effect.gen(function* () {
      const nextProviders = [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.succeed(nextProviders),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.deepEqual(first.config.providers, []);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "providerStatuses",
        payload: { providers: nextProviders },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              environment: testEnvironmentDescriptor,
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: "2026-01-01T00:00:00.000Z", environment: testEnvironmentDescriptor },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        assert.equal(second?.type, "ready");
        assert.equal(second?.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports project search RPCs as unsupported without local fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-search-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest({
        layers: {
          projectWorkspace: {
            listEntries: () => Effect.die("project search must not list provider entries"),
            readFile: () => Effect.die("project search must not read provider files"),
          },
          workspaceEntries: {
            search: () => Effect.die("project search must not use local path search"),
            searchContents: () => Effect.die("project search must not use local content search"),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            entries: client[WS_METHODS.projectsSearchEntries]({
              target: { projectId: defaultProjectId },
              query: "needle",
              limit: 10,
            }).pipe(Effect.result),
            contents: client[WS_METHODS.projectsSearchContents]({
              target: { projectId: defaultProjectId },
              query: "needle = 1",
              limit: 10,
              caseSensitive: true,
              wholeWord: false,
              useRegex: false,
            }).pipe(Effect.result),
          }),
        ),
      );

      for (const result of [response.entries, response.contents]) {
        if (
          result._tag !== "Failure" ||
          (result.failure._tag !== "ProjectSearchEntriesError" &&
            result.failure._tag !== "ProjectSearchContentsError")
        ) {
          assert.fail("Expected unsupported project search.");
        }
        assert.equal(result.failure.failure, "unsupported_operation");
        assert.equal(result.failure.retryable, false);
        assert.notProperty(result.failure, "cause");
        assert.notProperty(result.failure, "query");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("routes websocket rpc projects.listEntries and projects.readFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-files-" });
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "index.ts"),
        "export const answer = 42;\n",
      );

      const calls: Array<{ readonly operation: string; readonly input: object }> = [];
      yield* buildAppUnderTest({
        layers: {
          projectWorkspace: {
            listEntries: (input) =>
              Effect.sync(() => {
                calls.push({ operation: "listEntries", input });
                return {
                  entries: [
                    { path: "src", kind: "directory" as const },
                    { path: "src/index.ts", kind: "file" as const },
                    { path: "vendor-link", kind: "symlink" as const },
                    { path: "socket", kind: "other" as const },
                  ],
                  truncated: true,
                };
              }),
            readFile: (input) =>
              Effect.sync(() => {
                calls.push({ operation: "readFile", input });
                return {
                  bytes: new TextEncoder().encode("export const answer = 42;\n"),
                  byteLength: 2 * 1024 * 1024,
                  truncated: true,
                };
              }),
          },
          workspaceEntries: {
            list: () => Effect.die("project listing must not use the gateway filesystem"),
            search: () => Effect.die("project listing must not use local path search"),
            searchContents: () => Effect.die("project listing must not use local content search"),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            listing: client[WS_METHODS.projectsListEntries]({
              target: { projectId: defaultProjectId },
            }),
            file: client[WS_METHODS.projectsReadFile]({
              target: { projectId: defaultProjectId },
              relativePath: "src/index.ts",
            }),
          }),
        ),
      );

      assert.deepEqual(response.listing, {
        entries: [
          { path: "src", kind: "directory" },
          { path: "src/index.ts", kind: "file" },
        ],
        truncated: true,
      });
      assert.deepEqual(response.file, {
        relativePath: "src/index.ts",
        contents: "export const answer = 42;\n",
        byteLength: 2 * 1024 * 1024,
        truncated: true,
      });
      assert.deepEqual(calls, [
        {
          operation: "listEntries",
          input: {
            target: { projectId: defaultProjectId },
            relativePath: "",
            maxEntries: 25_000,
            maxDepth: 64,
            maxDirectories: 10_000,
          },
        },
        {
          operation: "readFile",
          input: {
            target: { projectId: defaultProjectId },
            relativePath: "src/index.ts",
            maxBytes: 1024 * 1024,
          },
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("resolves project workspace targets from persisted project and thread state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-root-" });
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-worktree-root-" });
      const spoofedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-spoofed-root-" });
      yield* fs.writeFileString(path.join(projectRoot, "marker.txt"), "project-root");
      yield* fs.writeFileString(path.join(worktreeRoot, "marker.txt"), "worktree-root");
      yield* fs.writeFileString(path.join(spoofedRoot, "marker.txt"), "spoofed-root");

      const worktreeThreadId = ThreadId.make("thread-worktree-target");
      const mismatchThreadId = ThreadId.make("thread-project-mismatch");
      const otherProjectId = ProjectId.make("project-other");
      const missingProjectId = ProjectId.make("project-missing");
      const queryFailureProjectId = ProjectId.make("project-query-failure");
      const missingThreadId = ThreadId.make("thread-missing");
      yield* buildAppUnderTest({
        layers: {
          projectWorkspace: {
            readFile: (input) =>
              Effect.succeed({
                bytes: new TextEncoder().encode(
                  input.target.threadId === worktreeThreadId ? "worktree-root" : "project-root",
                ),
                byteLength: 12,
                truncated: false,
              }),
            listEntries: (input) => {
              if (input.target.projectId === missingProjectId) {
                return Effect.fail(
                  new ProjectWorkspace.ProjectWorkspaceProjectNotFoundError({
                    projectId: missingProjectId,
                  }),
                );
              }
              if (input.target.threadId === missingThreadId) {
                return Effect.fail(
                  new ProjectWorkspace.ProjectWorkspaceThreadNotFoundError({
                    projectId: defaultProjectId,
                    threadId: missingThreadId,
                  }),
                );
              }
              if (input.target.threadId === mismatchThreadId) {
                return Effect.fail(
                  new ProjectWorkspace.ProjectWorkspaceThreadProjectMismatchError({
                    projectId: defaultProjectId,
                    threadId: mismatchThreadId,
                    actualProjectId: otherProjectId,
                  }),
                );
              }
              return Effect.fail(
                new ProjectWorkspace.ProjectWorkspaceResolveOperationError({
                  projectId: queryFailureProjectId,
                  operation: "resolveProject",
                  cause: new PersistenceSqlError({
                    operation: "resolve secret-token at /private/workspace",
                    cause: new Error("authorization: Bearer secret-token"),
                  }),
                }),
              );
            },
          },
          workspaceEntries: {
            list: () => Effect.die("project RPC must not use local listing"),
            search: () => Effect.die("project RPC must not use local search"),
            searchContents: () => Effect.die("project RPC must not use local content search"),
          },
        },
      });

      const spoofedInput = {
        target: { projectId: defaultProjectId },
        cwd: spoofedRoot,
        relativePath: "marker.txt",
      };
      const wsUrl = yield* getWsServerUrl("/ws");
      const results = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            project: client[WS_METHODS.projectsReadFile](spoofedInput),
            worktree: client[WS_METHODS.projectsReadFile]({
              target: { projectId: defaultProjectId, threadId: worktreeThreadId },
              relativePath: "marker.txt",
            }),
            missingProject: client[WS_METHODS.projectsListEntries]({
              target: { projectId: missingProjectId },
            }).pipe(Effect.result),
            missingThread: client[WS_METHODS.projectsListEntries]({
              target: { projectId: defaultProjectId, threadId: missingThreadId },
            }).pipe(Effect.result),
            mismatch: client[WS_METHODS.projectsListEntries]({
              target: { projectId: defaultProjectId, threadId: mismatchThreadId },
            }).pipe(Effect.result),
            resolutionFailure: client[WS_METHODS.projectsListEntries]({
              target: { projectId: queryFailureProjectId },
            }).pipe(Effect.result),
          }),
        ),
      );

      assert.equal(results.project.contents, "project-root");
      assert.equal(results.worktree.contents, "worktree-root");
      for (const [result, failure] of [
        [results.missingProject, "project_not_found"],
        [results.missingThread, "thread_not_found"],
        [results.mismatch, "thread_project_mismatch"],
      ] as const) {
        if (result._tag !== "Failure" || result.failure._tag !== "ProjectListEntriesError") {
          assert.fail(`Expected ProjectListEntriesError with failure '${failure}'.`);
        }
        assert.equal(result.failure.failure, failure);
        assert.equal(result.failure.operation, "list-entries");
        assert.equal(result.failure.retryable, false);
        assert.notProperty(result.failure, "cause");
        assert.notProperty(result.failure, "cwd");
        assert.notProperty(result.failure, "workspaceRoot");
        assert.notProperty(result.failure, "resolvedPath");
        assert.notProperty(result.failure, "normalizedCwd");
      }
      if (
        results.resolutionFailure._tag !== "Failure" ||
        results.resolutionFailure.failure._tag !== "ProjectListEntriesError"
      ) {
        assert.fail("Expected a sanitized ProjectListEntriesError for projection failure.");
      }
      const resolutionFailure = results.resolutionFailure.failure;
      assert.equal(resolutionFailure.failure, "operation_failed");
      assert.equal(resolutionFailure.retryable, true);
      assert.equal(resolutionFailure.message, "Failed to list workspace entries.");
      assert.notProperty(resolutionFailure, "cause");
      assert.notProperty(resolutionFailure, "detail");
      assert.notProperty(resolutionFailure, "cwd");
      assert.notInclude(resolutionFailure.message, "secret-token");
      assert.notInclude(resolutionFailure.message, "/private/workspace");
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("rejects binary provider file previews", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-project-search-gitignored-",
      });
      yield* fs.writeFileString(path.join(workspaceDir, ".gitignore"), ".venv/\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".venv", "lib"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, ".venv", "lib", "ignored-search-target.ts"),
        "export const ignored = true;",
      );
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "tracked.ts"),
        "export const ok = 1;",
      );

      yield* buildAppUnderTest({
        layers: {
          projectWorkspace: {
            readFile: () =>
              Effect.succeed({
                bytes: Uint8Array.from([65, 0, 66]),
                byteLength: 3,
                truncated: false,
              }),
          },
          workspaceEntries: {
            list: () => Effect.die("provider file reads must not use local listing"),
            search: () => Effect.die("provider file reads must not use local search"),
            searchContents: () =>
              Effect.die("provider file reads must not use local content search"),
          },
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
            listWorkspaceFiles: () =>
              Effect.succeed({
                paths: ["src/tracked.ts"],
                truncated: false,
                freshness: {
                  source: "live-local",
                  observedAt: TEST_EPOCH,
                  expiresAt: Option.none(),
                },
              }),
            filterIgnoredPaths: (_cwd, relativePaths) =>
              Effect.succeed(
                relativePaths.filter((relativePath) => !relativePath.startsWith(".venv/")),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsReadFile]({
            target: { projectId: defaultProjectId },
            relativePath: "binary.dat",
          }).pipe(Effect.result),
        ),
      );

      if (response._tag !== "Failure" || response.failure._tag !== "ProjectReadFileError") {
        assert.fail("Expected ProjectReadFileError for a binary provider file.");
      }
      assert.equal(response.failure.failure, "binary_file");
      assert.equal(response.failure.retryable, false);
      assert.notProperty(response.failure, "cause");
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("preserves structured workspace rpc failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-errors-",
      });
      const outsideDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-errors-outside-",
      });
      const outsideFile = path.join(outsideDir, "outside.txt");
      yield* fs.writeFileString(outsideFile, "outside\n");
      yield* fs.symlink(outsideFile, path.join(workspaceDir, "linked-outside.txt"));

      const sensitiveQuery = "authorization: Bearer secret-token";
      const readProjectId = ProjectId.make("project-read-safe-error");
      yield* buildAppUnderTest({
        layers: {
          projectWorkspace: {
            listEntries: () =>
              Effect.fail(
                new ProviderWorkspaceDisconnectedError({
                  providerInstanceId: ProviderInstanceId.make("provider-secret"),
                  operation: "listEntries",
                  cause: new Error("authorization: Bearer secret-token at /private/root"),
                }),
              ),
            readFile: () =>
              Effect.fail(
                new ProviderWorkspacePathError({
                  providerInstanceId: ProviderInstanceId.make("provider-secret"),
                  operation: "readFile",
                  path: "/private/root/linked-outside.txt",
                  issue: "invalid_path",
                  cause: new Error("authorization: Bearer secret-token"),
                }),
              ),
          },
          providerFilesystemBrowse: {
            browse: (input) =>
              Effect.fail(
                new FilesystemBrowseError({
                  providerInstanceId: input.providerInstanceId,
                  failure: "path_not_found",
                  retryable: false,
                }),
              ),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const results = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            search: client[WS_METHODS.projectsSearchEntries]({
              target: { projectId: defaultProjectId },
              query: sensitiveQuery,
              limit: 10,
            }).pipe(Effect.result),
            list: client[WS_METHODS.projectsListEntries]({
              target: { projectId: defaultProjectId },
            }).pipe(Effect.result),
            read: client[WS_METHODS.projectsReadFile]({
              target: { projectId: readProjectId },
              relativePath: "linked-outside.txt",
            }).pipe(Effect.result),
            browse: client[WS_METHODS.filesystemBrowse]({
              providerInstanceId: ProviderInstanceId.make("provider-secret"),
              locator: { kind: "absolute", path: "/private/root/missing-browse" },
            }).pipe(Effect.result),
          }),
        ),
      );

      if (
        results.search._tag !== "Failure" ||
        results.search.failure._tag !== "ProjectSearchEntriesError"
      ) {
        assert.fail("Expected a ProjectSearchEntriesError");
      }
      const searchError = results.search.failure;
      assert.equal(searchError.message, "Failed to search workspace entries.");
      assert.deepEqual(searchError.target, { projectId: defaultProjectId });
      assert.equal(searchError.operation, "search-entries");
      assert.equal(searchError.queryLength, sensitiveQuery.length);
      assert.notProperty(searchError, "query");
      assert.notInclude(searchError.message, "Bearer");
      assert.notInclude(searchError.message, "secret-token");
      assert.equal(searchError.limit, 10);
      assert.equal(searchError.failure, "unsupported_operation");
      assert.equal(searchError.retryable, false);
      assert.notProperty(searchError, "cause");
      assert.notProperty(searchError, "cwd");
      assert.notProperty(searchError, "normalizedCwd");

      if (
        results.list._tag !== "Failure" ||
        results.list.failure._tag !== "ProjectListEntriesError"
      ) {
        assert.fail("Expected a ProjectListEntriesError");
      }
      const listError = results.list.failure;
      assert.equal(listError.message, "Failed to list workspace entries.");
      assert.deepEqual(listError.target, { projectId: defaultProjectId });
      assert.equal(listError.operation, "list-entries");
      assert.equal(listError.failure, "provider_unavailable");
      assert.equal(listError.retryable, true);
      assert.notProperty(listError, "cause");
      assert.notProperty(listError, "cwd");
      assert.notProperty(listError, "workspaceRoot");
      assert.notProperty(listError, "normalizedCwd");
      assert.notInclude(listError.message, "provider-secret");
      assert.notInclude(listError.message, "/private/root");

      if (results.read._tag !== "Failure" || results.read.failure._tag !== "ProjectReadFileError") {
        assert.fail("Expected a ProjectReadFileError");
      }
      const readError = results.read.failure;
      assert.equal(readError.message, "Failed to read workspace file 'linked-outside.txt'.");
      assert.deepEqual(readError.target, { projectId: readProjectId });
      assert.equal(readError.operation, "read-file");
      assert.equal(readError.relativePath, "linked-outside.txt");
      assert.equal(readError.failure, "path_outside_workspace");
      assert.equal(readError.retryable, false);
      assert.notProperty(readError, "cause");
      assert.notProperty(readError, "resolvedPath");
      assert.notProperty(readError, "workspaceRoot");

      if (
        results.browse._tag !== "Failure" ||
        results.browse.failure._tag !== "FilesystemBrowseError"
      ) {
        assert.fail("Expected a FilesystemBrowseError");
      }
      const browseError = results.browse.failure;
      assert.equal(browseError.message, "The folder was not found.");
      assert.equal(browseError.providerInstanceId, "provider-secret");
      assert.equal(browseError.failure, "path_not_found");
      assert.equal(browseError.retryable, false);
      assert.notProperty(browseError, "cwd");
      assert.notProperty(browseError, "partialPath");
      assert.notProperty(browseError, "parentPath");
      assert.notProperty(browseError, "platform");
      assert.notProperty(browseError, "cause");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("sanitizes provider workspace operation failures", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const blockedRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-stat-error-",
      });
      const workspaceRoot = path.join(blockedRoot, "workspace");
      yield* fs.makeDirectory(workspaceRoot);
      yield* fs.chmod(blockedRoot, 0o000);

      const result = yield* Effect.gen(function* () {
        yield* buildAppUnderTest({
          layers: {
            projectWorkspace: {
              listEntries: () =>
                Effect.fail(
                  new ProviderWorkspaceOperationError({
                    providerInstanceId: ProviderInstanceId.make("provider-secret"),
                    operation: "listEntries",
                    detail: `failed at ${workspaceRoot} with secret-token`,
                    cause: new Error("authorization: Bearer secret-token"),
                  }),
                ),
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        return yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsListEntries]({
              target: { projectId: defaultProjectId },
            }).pipe(Effect.result),
          ),
        );
      }).pipe(Effect.ensuring(fs.chmod(blockedRoot, 0o700).pipe(Effect.ignore)));

      if (result._tag !== "Failure" || result.failure._tag !== "ProjectListEntriesError") {
        assert.fail("Expected a ProjectListEntriesError");
      }
      const error = result.failure;
      assert.equal(error.failure, "operation_failed");
      assert.equal(error.retryable, true);
      assert.notProperty(error, "workspaceRoot");
      assert.notProperty(error, "normalizedCwd");
      assert.notProperty(error, "cause");
      assert.notProperty(error, "detail");
      assert.notInclude(error.message, workspaceRoot);
      assert.notInclude(error.message, "secret-token");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports project writes as unsupported without local fallback", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          projectWorkspace: {
            readFile: () => Effect.die("project writes must not read provider files"),
            listEntries: () => Effect.die("project writes must not list provider entries"),
          },
          workspaceEntries: {
            list: () => Effect.die("project writes must not use local listing"),
            search: () => Effect.die("project writes must not use local search"),
            searchContents: () => Effect.die("project writes must not use local content search"),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            target: { projectId: defaultProjectId },
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }).pipe(Effect.result),
        ),
      );

      if (response._tag !== "Failure" || response.failure._tag !== "ProjectWriteFileError") {
        assert.fail("Expected unsupported ProjectWriteFileError.");
      }
      assert.equal(response.failure.failure, "unsupported_operation");
      assert.equal(response.failure.retryable, false);
      assert.notProperty(response.failure, "cause");
      assert.notProperty(response.failure, "contents");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not create a remote workspace root on project.create dispatch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-create-" });
      const missingWorkspaceRoot = path.join(parentDir, "nested", "new-project");

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-missing-root"),
            projectId: ProjectId.make("project-create-missing-root"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            title: "New Project",
            workspaceRoot: missingWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
      assert.isAtLeast(response.sequence, 0);
      assert.isFalse(yield* fs.exists(missingWorkspaceRoot));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("maps provider workspace unsupported failures", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          projectWorkspace: {
            listEntries: () =>
              Effect.fail(
                new ProviderWorkspaceUnsupportedError({
                  providerInstanceId: ProviderInstanceId.make("provider-secret"),
                  operation: "listEntries",
                  cause: new Error("authorization: Bearer secret-token at /private/root"),
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsListEntries]({
            target: { projectId: defaultProjectId },
          }),
        ).pipe(Effect.result),
      );

      if (result._tag !== "Failure" || result.failure._tag !== "ProjectListEntriesError") {
        assert.fail("Expected a ProjectListEntriesError");
      }
      const listError = result.failure;
      assert.equal(listError.failure, "unsupported_operation");
      assert.equal(listError.retryable, false);
      assert.notProperty(listError, "cause");
      assert.notProperty(listError, "providerInstanceId");
      assert.notInclude(listError.message, "provider-secret");
      assert.notInclude(listError.message, "/private/root");
      assert.notInclude(listError.message, "secret-token");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("fails closed for gateway-local workspace and source-control operations", () =>
    Effect.gen(function* () {
      const unreachable = (operation: string) => Effect.die(`unexpected local call: ${operation}`);
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            resolveAvailableEditors: () => unreachable("resolveAvailableEditors"),
            launchEditor: () => unreachable("launchEditor"),
          },
          vcsDriver: {
            initRepository: () => unreachable("initRepository"),
          },
          gitVcsDriver: {
            pullCurrentBranch: () => unreachable("pullCurrentBranch"),
            createWorktree: () => unreachable("createWorktree"),
            removeWorktree: () => unreachable("removeWorktree"),
            createRef: () => unreachable("createRef"),
            switchRef: () => unreachable("switchRef"),
          },
          gitManager: {
            runStackedAction: () => unreachable("runStackedAction"),
            resolvePullRequest: () => unreachable("resolvePullRequest"),
            preparePullRequestThread: () => unreachable("preparePullRequestThread"),
          },
          sourceControlRepositoryService: {
            lookupRepository: () => unreachable("lookupRepository"),
            cloneRepository: () => unreachable("cloneRepository"),
            publishRepository: () => unreachable("publishRepository"),
          },
          portDiscovery: {
            scan: () => unreachable("portDiscovery.scan"),
            subscribe: () => unreachable("portDiscovery.subscribe"),
            retain: unreachable("portDiscovery.retain"),
          },
          repositoryStatusBroadcaster: {
            refreshStatus: () => Effect.succeed({ _tag: "NotRepository" as const }),
          },
          repositoryReadService: {
            listRefs: () => Effect.succeed({ _tag: "NotRepository" as const }),
            getReviewDiff: () => Effect.succeed({ _tag: "NotRepository" as const }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const run = <A, E, R>(use: Parameters<typeof withWsRpcClient<A, E, R>>[1]) =>
        Effect.scoped(withWsRpcClient(wsUrl, use).pipe(Effect.result));

      const pull = yield* run((client) => client[WS_METHODS.vcsPull]({ cwd: "/remote/repo" }));
      assert.equal(pull._tag, "Failure");
      if (pull._tag === "Failure") assert.equal(pull.failure._tag, "GitCommandError");

      const stacked = yield* run((client) =>
        client[WS_METHODS.gitRunStackedAction]({
          actionId: "action-1",
          cwd: "/remote/repo",
          action: "commit",
        }).pipe(Stream.runCollect),
      );
      assert.equal(stacked._tag, "Failure");
      if (stacked._tag === "Failure") assert.equal(stacked.failure._tag, "GitManagerError");

      const resolvedPr = yield* run((client) =>
        client[WS_METHODS.gitResolvePullRequest]({ cwd: "/remote/repo", reference: "1" }),
      );
      assert.equal(resolvedPr._tag, "Failure");
      if (resolvedPr._tag === "Failure") assert.equal(resolvedPr.failure._tag, "GitManagerError");

      const preparedPr = yield* run((client) =>
        client[WS_METHODS.gitPreparePullRequestThread]({
          cwd: "/remote/repo",
          reference: "1",
          mode: "local",
        }),
      );
      assert.equal(preparedPr._tag, "Failure");
      if (preparedPr._tag === "Failure") assert.equal(preparedPr.failure._tag, "GitManagerError");

      const createWorktree = yield* run((client) =>
        client[WS_METHODS.vcsCreateWorktree]({
          cwd: "/remote/repo",
          refName: "main",
          path: null,
        }),
      );
      assert.equal(createWorktree._tag, "Failure");
      if (createWorktree._tag === "Failure")
        assert.equal(createWorktree.failure._tag, "GitCommandError");

      const removeWorktree = yield* run((client) =>
        client[WS_METHODS.vcsRemoveWorktree]({
          cwd: "/remote/repo",
          path: "/remote/worktree",
        }),
      );
      assert.equal(removeWorktree._tag, "Failure");
      if (removeWorktree._tag === "Failure")
        assert.equal(removeWorktree.failure._tag, "GitCommandError");

      const createRef = yield* run((client) =>
        client[WS_METHODS.vcsCreateRef]({ cwd: "/remote/repo", refName: "feature/demo" }),
      );
      assert.equal(createRef._tag, "Failure");
      if (createRef._tag === "Failure") assert.equal(createRef.failure._tag, "GitCommandError");

      const switchRef = yield* run((client) =>
        client[WS_METHODS.vcsSwitchRef]({ cwd: "/remote/repo", refName: "main" }),
      );
      assert.equal(switchRef._tag, "Failure");
      if (switchRef._tag === "Failure") assert.equal(switchRef.failure._tag, "GitCommandError");

      const init = yield* run((client) => client[WS_METHODS.vcsInit]({ cwd: "/remote/repo" }));
      assert.equal(init._tag, "Failure");
      if (init._tag === "Failure") assert.equal(init.failure._tag, "VcsUnsupportedOperationError");

      const lookup = yield* run((client) =>
        client[WS_METHODS.sourceControlLookupRepository]({
          provider: "github",
          repository: "owner/repo",
          cwd: "/remote/repo",
        }),
      );
      assert.equal(lookup._tag, "Failure");
      if (lookup._tag === "Failure")
        assert.equal(lookup.failure._tag, "SourceControlRepositoryError");

      const clone = yield* run((client) =>
        client[WS_METHODS.sourceControlCloneRepository]({
          provider: "github",
          repository: "owner/repo",
          destinationPath: "/remote/repo",
        }),
      );
      assert.equal(clone._tag, "Failure");
      if (clone._tag === "Failure")
        assert.equal(clone.failure._tag, "SourceControlRepositoryError");

      const publish = yield* run((client) =>
        client[WS_METHODS.sourceControlPublishRepository]({
          cwd: "/remote/repo",
          provider: "github",
          repository: "owner/repo",
          visibility: "private",
        }),
      );
      assert.equal(publish._tag, "Failure");
      if (publish._tag === "Failure")
        assert.equal(publish.failure._tag, "SourceControlRepositoryError");

      const editor = yield* run((client) =>
        client[WS_METHODS.shellOpenInEditor]({ cwd: "/remote/repo", editor: "cursor" }),
      );
      assert.equal(editor._tag, "Failure");
      if (editor._tag === "Failure")
        assert.equal(editor.failure._tag, "ExternalLauncherUnsupportedEditorError");

      const updateProvider = yield* run((client) =>
        client[WS_METHODS.serverUpdateProvider]({ provider: ProviderDriverKind.make("codex") }),
      );
      assert.equal(updateProvider._tag, "Failure");
      if (updateProvider._tag === "Failure")
        assert.equal(updateProvider.failure._tag, "ServerProviderUpdateError");

      const discovery = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverDiscoverSourceControl]({})),
      );
      assert.deepEqual(discovery, { versionControlSystems: [], sourceControlProviders: [] });

      const discoveredServers = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeDiscoveredLocalServers]({}).pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
          ),
        ),
      );
      assert.deepEqual(discoveredServers[0]?.servers, []);

      const status = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRefreshStatus]({
            target: { projectId: defaultProjectId },
            maxChangedPaths: 1_000,
          }),
        ),
      );
      assert.equal(status._tag, "NotRepository");

      const refs = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsListRefs]({
            target: { projectId: defaultProjectId },
            scope: "all",
            maxRefs: 100,
          }),
        ),
      );
      assert.equal(refs._tag, "NotRepository");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("fails closed for unsupported provider checkpoint operations", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.fail(
                new CheckpointUnsupportedError({
                  operation: "CheckpointDiffQuery.getTurnDiff",
                }),
              ),
            getFullThreadDiff: () =>
              Effect.fail(
                new CheckpointUnsupportedError({
                  operation: "CheckpointDiffQuery.getFullThreadDiff",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const revertResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.checkpoint.revert",
            commandId: CommandId.make("cmd-checkpoint-revert-unsupported"),
            threadId: defaultThreadId,
            turnCount: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ).pipe(Effect.result),
      );
      assert.equal(revertResult._tag, "Failure");
      if (revertResult._tag === "Failure") {
        assert.equal(revertResult.failure._tag, "OrchestrationDispatchCommandError");
        assert.equal(
          revertResult.failure.message,
          "Checkpoint revert is unavailable until the bound provider supplies checkpoint operations.",
        );
        assert.notProperty(revertResult.failure, "cause");
      }
      assert.deepEqual(dispatchedCommands, []);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: defaultThreadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ).pipe(Effect.result),
      );
      assert.equal(turnDiffResult._tag, "Failure");
      if (turnDiffResult._tag === "Failure") {
        assert.equal(turnDiffResult.failure._tag, "OrchestrationGetTurnDiffError");
        assert.equal(
          turnDiffResult.failure.message,
          "Checkpoint diffs are unavailable until the bound provider supplies checkpoint operations.",
        );
        assert.notProperty(turnDiffResult.failure, "cause");
      }

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: defaultThreadId,
            toTurnCount: 1,
          }),
        ).pipe(Effect.result),
      );
      assert.equal(fullDiffResult._tag, "Failure");
      if (fullDiffResult._tag === "Failure") {
        assert.equal(fullDiffResult.failure._tag, "OrchestrationGetFullThreadDiffError");
        assert.equal(
          fullDiffResult.failure.message,
          "Checkpoint diffs are unavailable until the bound provider supplies checkpoint operations.",
        );
        assert.notProperty(fullDiffResult.failure, "cause");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration methods", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.make("project-a"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "Thread A",
            modelSelection: defaultModelSelection,
            interactionMode: "default" as const,
            runtimeMode: "full-access" as const,
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            latestTurn: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () => Effect.succeed(snapshot),
            searchThreads: () =>
              Effect.succeed({
                matches: [
                  {
                    threadId: ThreadId.make("thread-1"),
                    projectId: ProjectId.make("project-a"),
                    source: "assistant",
                    snippet: "Search reached the final response.",
                    messageCreatedAt: now,
                  },
                ],
              }),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "turn-diff",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "full-diff",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-1"),
            threadId: ThreadId.make("thread-1"),
            createdAt: now,
          }),
        ),
      );
      assert.equal(dispatchResult.sequence, 7);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.make("thread-1"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(turnDiffResult.diff, "turn-diff");

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.make("thread-1"),
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(fullDiffResult.diff, "full-diff");

      const searchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.searchThreads]({
            query: "final response",
          }),
        ),
      );
      assert.deepEqual(searchResult.matches, [
        {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-a"),
          source: "assistant",
          snippet: "Search reached the final response.",
          messageCreatedAt: now,
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration shell snapshot errors", () =>
    Effect.gen(function* () {
      const projectionError = new PersistenceSqlError({
        operation: "ProjectionSnapshotQuery.getShellSnapshot:test",
        detail: "failed to read projection shell snapshot",
      });
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getShellSnapshot: () => Effect.fail(projectionError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(Stream.runCollect),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationGetSnapshotError");
      assertTrue(result.failure.cause instanceof Error);
      assert.include(result.failure.cause.message, projectionError.message);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("marks an empty shell catch-up replay as synchronized when requested", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEvents: () => Stream.empty,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const firstItem = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.runHead),
        ),
      );

      assert.deepEqual(Option.getOrThrow(firstItem), { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("marks a socket thread snapshot as synchronized when requested", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 1, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      assert.equal(items[0]?.kind, "snapshot");
      assert.deepEqual(items[1], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("buffers shell events published while the fallback snapshot loads", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const deletedEvent = {
        sequence: 2,
        eventId: EventId.make("event-shell-thread-deleted"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.deleted",
        payload: {
          threadId: defaultThreadId,
          deletedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.gen(function* () {
                yield* PubSub.publish(liveEvents, deletedEvent);
                return {
                  snapshotSequence: 1,
                  projects: [],
                  threads: [makeDefaultOrchestrationThreadShell()],
                  updatedAt: "2026-01-01T00:00:00.000Z",
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "thread-removed");
      assert.deepEqual(items[2], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("buffers thread events published while the initial snapshot loads", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const messageEvent = {
        sequence: 2,
        eventId: EventId.make("event-message"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: defaultThreadId,
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "First message",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* Effect.sleep("25 millis");
                yield* PubSub.publish(liveEvents, messageEvent);
                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "event");
      assert.equal(items[1]?.kind === "event" ? items[1].event.sequence : null, 2);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("subscribeThread sends a fresh snapshot instead of replaying a large gap", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            // Head is far ahead of the client's afterSequence (gap > 1000).
            latestSequence: Effect.succeed(100_000),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 100_000, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(items);
      // Large gap => fresh thread snapshot, and the global replay never starts.
      assert.equal(first?.kind, "snapshot");
      if (first?.kind === "snapshot") {
        assert.equal(first.snapshot.thread.id, defaultThreadId);
        assert.equal(first.snapshot.snapshotSequence, 100_000);
      }
      assert.equal(second?.kind, "synchronized");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread replaces a cursor ahead of the authoritative head", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 5, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 10,
          }).pipe(Stream.runHead),
        ),
      );

      assert.equal(Option.getOrThrow(first).kind, "snapshot");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread bounds catch-up replay to the captured head", () =>
    Effect.gen(function* () {
      let replayLimit: number | undefined;
      const now = "2026-01-01T00:00:00.000Z";
      const messageEvent = {
        sequence: 3,
        eventId: EventId.make("event-replay-message"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: defaultThreadId,
          messageId: MessageId.make("message-replay"),
          role: "user",
          text: "Replayed message",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(50),
            readEvents: (_afterSequence, limit) => {
              replayLimit = limit;
              return Stream.make(messageEvent);
            },
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(items);
      assert.equal(first?.kind, "event");
      assert.equal(first?.kind === "event" ? first.event.sequence : null, 3);
      assert.equal(second?.kind, "synchronized");
      // The replay is bounded to the head captured before the read, not
      // Number.MAX_SAFE_INTEGER.
      assert.equal(replayLimit, 50);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell sends a fresh snapshot instead of replaying a large gap", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const snapshotThreadId = ThreadId.make("thread-from-snapshot");
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            // Head is far ahead of the client's afterSequence (gap > 1000).
            latestSequence: Effect.succeed(100_000),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {
                  sequence: 1,
                  eventId: EventId.make("event-should-not-be-read"),
                  aggregateKind: "thread",
                  aggregateId: snapshotThreadId,
                  occurredAt: now,
                  commandId: null,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  type: "thread.created",
                  payload: {} as never,
                } satisfies OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 100_000,
                projects: [],
                threads: [makeDefaultOrchestrationThreadShell({ id: snapshotThreadId })],
                updatedAt: now,
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(items);
      // Large gap => fresh snapshot, and the unbounded replay is never started.
      assert.equal(first?.kind, "snapshot");
      if (first?.kind === "snapshot") {
        assert.equal(first.snapshot.threads[0]?.id, snapshotThreadId);
      }
      assert.equal(second?.kind, "synchronized");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell replaces a cursor ahead of the authoritative head", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 5,
                projects: [],
                threads: [],
                updatedAt: "2026-01-01T00:00:00.000Z",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 10 }).pipe(
            Stream.runHead,
          ),
        ),
      );

      assert.equal(Option.getOrThrow(first).kind, "snapshot");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalesces a per-thread burst without stalling other threads", () =>
    Effect.gen(function* () {
      const busyThreadId = ThreadId.make("thread-busy");
      const newThreadId = ThreadId.make("thread-new");
      const now = "2026-01-01T00:00:00.000Z";
      const shellFetches: Array<string> = [];
      let replayLimit: number | undefined;

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: busyThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {} as never,
        }) satisfies OrchestrationEvent;

      const createdEvent: OrchestrationEvent = {
        sequence: 50,
        eventId: EventId.make("event-created"),
        aggregateKind: "thread",
        aggregateId: newThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.created",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(50),
            // A burst of message-sent deltas for the busy thread, plus one
            // thread.created for a different thread, all within one batch.
            readEvents: (_afterSequence, limit) => {
              replayLimit = limit;
              return Stream.fromIterable([
                ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
                createdEvent,
              ]);
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() => {
                shellFetches.push(threadId);
                return Option.some(makeDefaultOrchestrationThreadShell({ id: threadId }));
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      );

      const collected = Array.from(items);
      const upsertedIds = collected.flatMap((item) =>
        item.kind === "thread-upserted" ? [item.thread.id] : [],
      );
      // Both threads surface, and the busy thread's 20-event burst collapses to
      // a single shell refetch (not 20). The new thread is not stuck behind it.
      assert.include(upsertedIds, busyThreadId);
      assert.include(upsertedIds, newThreadId);
      assert.equal(collected[2]?.kind, "synchronized");
      assert.equal(shellFetches.filter((id) => id === busyThreadId).length, 1);
      assert.equal(replayLimit, 50);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalesces live bursts after the synchronization marker", () =>
    Effect.gen(function* () {
      const busyThreadId = ThreadId.make("thread-live-busy");
      const newThreadId = ThreadId.make("thread-live-new");
      const now = "2026-01-01T00:00:00.000Z";
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const synchronized = yield* Deferred.make<void>();
      const shellFetches: Array<string> = [];
      const observedLiveThreadIds = new Set<string>();

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-live-${sequence}`),
          aggregateKind: "thread",
          aggregateId: busyThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {} as never,
        }) satisfies OrchestrationEvent;

      const createdEvent: OrchestrationEvent = {
        sequence: 50,
        eventId: EventId.make("event-live-created"),
        aggregateKind: "thread",
        aggregateId: newThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.created",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() => {
                shellFetches.push(threadId);
                return Option.some(makeDefaultOrchestrationThreadShell({ id: threadId }));
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        Effect.gen(function* () {
          const itemsFiber = yield* withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.subscribeShell]({
              requestCompletionMarker: true,
            }).pipe(
              Stream.tap((item) =>
                item.kind === "synchronized"
                  ? Deferred.succeed(synchronized, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Stream.takeUntil((item) => {
                if (item.kind === "thread-upserted") {
                  observedLiveThreadIds.add(item.thread.id);
                }
                return (
                  observedLiveThreadIds.has(busyThreadId) && observedLiveThreadIds.has(newThreadId)
                );
              }),
              Stream.runCollect,
            ),
          ).pipe(Effect.forkScoped);

          yield* Deferred.await(synchronized);
          for (const event of [
            ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
            createdEvent,
          ]) {
            yield* PubSub.publish(liveEvents, event);
          }

          return yield* Fiber.join(itemsFiber);
        }),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "synchronized");
      const liveUpsertedIds = Array.from(items)
        .slice(2)
        .flatMap((item) => (item.kind === "thread-upserted" ? [item.thread.id] : []));
      assert.include(liveUpsertedIds, busyThreadId);
      assert.include(liveUpsertedIds, newThreadId);
      assert.isBelow(shellFetches.filter((id) => id === busyThreadId).length, 20);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("subscribeShell coalescing still emits a removal for a deleted thread", () =>
    Effect.gen(function* () {
      const goneThreadId = ThreadId.make("thread-gone");
      const now = "2026-01-01T00:00:00.000Z";

      const makeThreadEvent = (
        sequence: number,
        type: "thread.deleted" | "thread.message-sent",
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: goneThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload: type === "thread.deleted" ? { threadId: goneThreadId, deletedAt: now } : {},
        }) as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            // A thread.deleted followed, within the same coalescing window, by a
            // later refetchable event for the same thread. The later event wins
            // coalescing; its shell refetch returns none (the row is gone), which
            // must still surface a removal rather than be swallowed.
            readEvents: () =>
              Stream.fromIterable([
                makeThreadEvent(1, "thread.deleted"),
                makeThreadEvent(2, "thread.message-sent"),
              ]),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.none()),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "thread-removed");
      assert.equal(first?.kind === "thread-removed" ? first.threadId : null, goneThreadId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell retries a transient shell projection refetch failure", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-transient-refetch");
      const now = "2026-01-01T00:00:00.000Z";
      let attempts = 0;

      const event: OrchestrationEvent = {
        sequence: 1,
        eventId: EventId.make("event-transient-refetch"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(1),
            readEvents: () => Stream.make(event),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.suspend(() => {
                attempts += 1;
                return attempts === 1
                  ? Effect.fail(
                      new PersistenceSqlError({
                        operation: "test.shell-refetch",
                        detail: "transient failure",
                      }),
                    )
                  : Effect.succeed(
                      Option.some(makeDefaultOrchestrationThreadShell({ id: threadId })),
                    );
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "thread-upserted");
      assert.equal(first?.kind === "thread-upserted" ? first.thread.id : null, threadId);
      assert.equal(attempts, 2);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalescing still removes a project after a trailing update", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-gone");
      const now = "2026-01-01T00:00:00.000Z";

      const makeProjectEvent = (
        sequence: number,
        type: "project.deleted" | "project.meta-updated",
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-project-${sequence}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload:
            type === "project.deleted"
              ? { projectId, deletedAt: now }
              : { projectId, title: "Still deleted", updatedAt: now },
        }) as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            readEvents: () =>
              Stream.fromIterable([
                makeProjectEvent(1, "project.deleted"),
                makeProjectEvent(2, "project.meta-updated"),
              ]),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () => Effect.succeed(Option.none()),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "project-removed");
      assert.equal(first?.kind === "project-removed" ? first.projectId : null, projectId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("stops the provider session and closes thread terminals after archive", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      const sessionStopCommand = dispatchedCommands[1];
      assert.equal(sessionStopCommand?.type, "thread.session.stop");
      if (sessionStopCommand?.type === "thread.session.stop") {
        assert.equal(sessionStopCommand.threadId, threadId);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("checks session status before archiving removes the thread from active lookups", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-precheck");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";
      let archived = false;

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                if (command.type === "thread.archive") {
                  archived = true;
                }
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.sync(() => {
                effects.push(`query:thread-shell:${archived ? "archived" : "active"}`);
                return archived
                  ? Option.none()
                  : Option.some(
                      makeDefaultOrchestrationThreadShell({
                        id: threadId,
                        updatedAt: now,
                        session: {
                          threadId,
                          status: "ready",
                          providerName: "claudeAgent",
                          runtimeMode: "full-access",
                          activeTurnId: null,
                          lastError: null,
                          updatedAt: now,
                        },
                      }),
                    );
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-precheck"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "query:thread-shell:active",
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives without dispatching session stop when the thread has no session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-no-session");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(makeDefaultOrchestrationThreadShell({ id: threadId, session: null })),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-no-session"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "archives without dispatching session stop when the thread session is already stopped",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-archive-stopped-session");
        const effects: string[] = [];
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const now = "2026-01-01T00:00:00.000Z";

        yield* buildAppUnderTest({
          layers: {
            terminalManager: {
              close: (input) =>
                Effect.sync(() => {
                  effects.push(`terminal.close:${input.threadId}`);
                }),
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  effects.push(`dispatch:${command.type}`);
                  return { sequence: dispatchedCommands.length };
                }),
            },
            projectionSnapshotQuery: {
              getThreadShellById: () =>
                Effect.succeed(
                  Option.some(
                    makeDefaultOrchestrationThreadShell({
                      id: threadId,
                      updatedAt: now,
                      session: {
                        threadId,
                        status: "stopped",
                        providerName: "claudeAgent",
                        runtimeMode: "full-access",
                        activeTurnId: null,
                        lastError: null,
                        updatedAt: now,
                      },
                    }),
                  ),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const dispatchResult = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.archive",
              commandId: CommandId.make("cmd-thread-archive-stopped-session"),
              threadId,
            }),
          ),
        );

        assert.equal(dispatchResult.sequence, 1);
        assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.archive"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-failure");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "simulated archive stop failure",
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-failure"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop defects", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-defect");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.die(new Error("simulated archive stop defect"));
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-defect"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects bootstrap worktree preparation before creating a thread or calling Git", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const unreachable = (operation: string) => Effect.die(`unexpected local call: ${operation}`);
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            fetchRemote: () => unreachable("fetchRemote"),
            resolveRemoteTrackingCommit: () => unreachable("resolveRemoteTrackingCommit"),
            createWorktree: () => unreachable("createWorktree"),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread: () => unreachable("runForThread"),
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-rejected"),
            threadId: ThreadId.make("thread-bootstrap-rejected"),
            message: {
              messageId: MessageId.make("msg-bootstrap-rejected"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/remote/project",
                baseBranch: "main",
                branch: "cocoa/bootstrap",
                startFromOrigin: true,
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "OrchestrationDispatchCommandError");
        assert.include(result.failure.message, "provider instance");
      }
      assert.deepEqual(dispatchedCommands, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "Primary",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
