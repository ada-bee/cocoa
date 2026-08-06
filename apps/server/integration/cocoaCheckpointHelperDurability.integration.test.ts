/* eslint-disable t3code/no-manual-effect-runtime-in-tests -- This acceptance proof deliberately tears down and recreates the SQLite-backed gateway journal. */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CodexCheckpointHelperCaptureResult,
  type CodexCheckpointHelperConfig,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import { makeRestoreCheckpointOperationId } from "../src/checkpointing/CheckpointIds.ts";
import { CheckpointRevertIntentRepositoryLive } from "../src/persistence/Layers/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepositoryLive } from "../src/persistence/Layers/CheckpointRevertSagas.ts";
import { ProviderCheckpointOperationRepositoryLive } from "../src/persistence/Layers/ProviderCheckpointOperations.ts";
import { ProjectionCheckpointRepositoryLive } from "../src/persistence/Layers/ProjectionCheckpoints.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { CheckpointRevertIntentRepository } from "../src/persistence/Services/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepository } from "../src/persistence/Services/CheckpointRevertSagas.ts";
import {
  ProviderCheckpointOperationRepository,
  type PrepareProviderCheckpointOperationInput,
  type ProviderNativeCheckpoint,
} from "../src/persistence/Services/ProviderCheckpointOperations.ts";
import * as CodexEndpointConnection from "../src/provider/codexEndpoint/CodexEndpointConnection.ts";
import type { CodexEndpointConnectionBorrow } from "../src/provider/codexEndpoint/CodexEndpointSupervisor.ts";
import {
  type ProviderVcsCheckpointCapability,
  ProviderVcsCheckpointOutcomeUnknownError,
  type ProviderVcsRepository,
} from "../src/provider/ProviderVcsAdapter.ts";
import { makeCodexCheckpointHelperAdapter } from "../src/provider/codexVcs/CodexCheckpointHelperAdapter.ts";
import { CodexGitExecutablePath } from "../src/provider/codexVcs/CodexVcsAdapter.ts";
import * as ProjectRepository from "../src/project/ProjectRepository.ts";
import { makeCheckpointRevertReactor } from "../src/orchestration/Layers/CheckpointRevertReactor.ts";
import {
  CheckpointRevertReactor,
  type CheckpointRevertProcessResult,
} from "../src/orchestration/Services/CheckpointRevertReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  PostTurnCheckpointReactor,
  type PostTurnCheckpointReactorShape,
} from "../src/orchestration/Services/PostTurnCheckpointReactor.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../src/orchestration/Services/ProviderCommandReactor.ts";
import { makeProviderGenerationRecoveryReactor } from "../src/provider/Layers/ProviderGenerationRecoveryReactor.ts";
import type {
  ProviderInstance,
  ProviderInstanceGenerationLifecycle,
  ProviderInstanceGenerationState,
} from "../src/provider/ProviderDriver.ts";
import { ProviderGenerationRecoveryReactor } from "../src/provider/Services/ProviderGenerationRecoveryReactor.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../src/provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../src/provider/Services/ProviderSessionDirectory.ts";

const REPOSITORY_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);
const DEFAULT_HELPER_BIN = NodePath.join(
  REPOSITORY_ROOT,
  "native/cocoa-workspace-helper/target/debug/cocoa-workspace-helper",
);
const HELPER_BIN = process.env.COCOA_WORKSPACE_HELPER_BIN ?? DEFAULT_HELPER_BIN;
const HAS_HELPER = NodeFS.existsSync(HELPER_BIN);
const RESOLVED_HELPER_BIN = HAS_HELPER ? NodeFS.realpathSync(HELPER_BIN) : HELPER_BIN;

const INSTANCE_ID = ProviderInstanceId.make("native-checkpoint-provider");
const PROJECT_ID = ProjectId.make("native-checkpoint-project");
const THREAD_ID = ThreadId.make("native-checkpoint-thread");
const TURN_ID = TurnId.make("native-checkpoint-turn");
const BASE_CHECKPOINT_ID = "10000000-0000-4000-8000-000000000001";
const TARGET_CHECKPOINT_ID = "10000000-0000-4000-8000-000000000002";
const BASE_CAPTURE_OPERATION_ID = "20000000-0000-4000-8000-000000000001";
const TARGET_CAPTURE_OPERATION_ID = "20000000-0000-4000-8000-000000000002";
const REVERT_EVENT_ID = EventId.make("native-restore-event");
const REVERT_COMMAND_ID = CommandId.make("native-restore-command");
const RESTORE_OPERATION_ID = makeRestoreCheckpointOperationId({ revertEventId: REVERT_EVENT_ID });
const PREPARED_AT = "2026-08-06T10:00:00.000Z";
const UPDATED_AT = "2026-08-06T10:01:00.000Z";
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const isOutcomeUnknown = Schema.is(ProviderVcsCheckpointOutcomeUnknownError);

const resolveExecutable = (name: string): string => {
  for (const directory of (process.env.PATH ?? "").split(NodePath.delimiter)) {
    const candidate = NodePath.join(directory, name);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return NodeFS.realpathSync(candidate);
    } catch {
      // Continue through PATH exactly as a provider administrator would resolve its configured tool.
    }
  }
  throw new Error(`Could not resolve ${name} from PATH.`);
};

const run = (
  executable: string,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
) => {
  const result = NodeChildProcess.spawnSync(executable, args, {
    cwd: options?.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options?.env },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${executable} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
    );
  }
  return result.stdout.trimEnd();
};

const makeRepository = (parent: string, git: string): string => {
  const root = NodePath.join(parent, "provider-workspace");
  NodeFS.mkdirSync(root);
  run(git, ["-C", root, "init", "--quiet", "--object-format=sha1"]);
  run(git, ["-C", root, "config", "user.name", "Cocoa Acceptance"]);
  run(git, ["-C", root, "config", "user.email", "cocoa@example.invalid"]);
  NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "base\n");
  run(git, ["-C", root, "add", "tracked.txt"]);
  run(git, ["-C", root, "commit", "--quiet", "-m", "initial"]);
  return NodeFS.realpathSync(root);
};

interface ProviderBoundaryState {
  readonly generations: Array<number>;
  restoreDispatchCount: number;
  dropFirstRestoreResponse: boolean;
}

const makeConnection = (
  generationId: number,
  state: ProviderBoundaryState,
): CodexEndpointConnection.CodexEndpointConnection["Service"] => {
  state.generations.push(generationId);
  const request = ((method: string, input: unknown) => {
    assert.strictEqual(method, "command/exec");
    const payload = input as {
      readonly command: ReadonlyArray<string>;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
      readonly outputBytesCap: number;
    };
    const executable = payload.command[0];
    if (executable === undefined) return Effect.die("Checkpoint command had no executable.");
    assert.strictEqual(executable, RESOLVED_HELPER_BIN);
    return Effect.suspend(() => {
      const result = NodeChildProcess.spawnSync(executable, payload.command.slice(1), {
        cwd: payload.cwd,
        encoding: "utf8",
        env: { ...process.env, ...payload.env },
        maxBuffer: payload.outputBytesCap,
        timeout: payload.timeoutMs,
      });
      if (result.error !== undefined) {
        return Effect.fail(
          new CodexErrors.CodexAppServerTransportError({
            operation: "read-input-stream",
            cause: result.error,
          }),
        );
      }
      const commandResult = {
        exitCode: result.status ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      const encodedRequest = payload.command[1] ?? "";
      const decodedRequest = decodeJson(Buffer.from(encodedRequest, "base64").toString("utf8")) as {
        readonly operation?: string;
      };
      if (decodedRequest.operation === "restore") state.restoreDispatchCount += 1;
      if (
        generationId === 1 &&
        decodedRequest.operation === "restore" &&
        state.dropFirstRestoreResponse
      ) {
        state.dropFirstRestoreResponse = false;
        assert.strictEqual(commandResult.exitCode, 0);
        return Effect.fail(
          new CodexErrors.CodexAppServerTransportError({
            operation: "read-input-stream",
            cause: new Error("provider connection replaced after helper committed restore"),
          }),
        );
      }
      return Effect.succeed(commandResult);
    });
  }) as CodexClient.CodexAppServerClient["Service"]["request"];

  return CodexEndpointConnection.CodexEndpointConnection.of({
    identity: { providerInstanceId: INSTANCE_ID },
    client: { request } as CodexClient.CodexAppServerClient["Service"],
    compatibility: {
      userAgent: "codex/native-helper-acceptance",
      serverVersion: "0.146.0",
      codexHome: "/provider/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    awaitTermination: Effect.never,
  });
};

const openCapability = Effect.fn("acceptance.openNativeCheckpointCapability")(function* (
  generationId: number,
  state: ProviderBoundaryState,
  root: string,
  commonDirectoryPath: string,
  gitExecutablePath: ReturnType<typeof CodexGitExecutablePath.make>,
  helper: CodexCheckpointHelperConfig,
) {
  const borrowed: CodexEndpointConnectionBorrow = {
    generationId,
    connection: makeConnection(generationId, state),
    ensureCurrent: Effect.void,
  };
  const adapter = makeCodexCheckpointHelperAdapter({
    providerInstanceId: INSTANCE_ID,
    gitExecutablePath,
    helper,
  });
  const probe = yield* adapter.probe(borrowed, root);
  return yield* adapter.open(borrowed, { rootPath: root, commonDirectoryPath }, probe);
});

const makeJournalRuntime = (dbPath: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  return ManagedRuntime.make(
    Layer.mergeAll(
      CheckpointRevertIntentRepositoryLive,
      CheckpointRevertSagaRepositoryLive,
      ProviderCheckpointOperationRepositoryLive,
      ProjectionCheckpointRepositoryLive,
    ).pipe(Layer.provide(persistence), Layer.provide(NodeServices.layer)),
  );
};

const makeRecoveryRuntime = (
  dbPath: string,
  checkpointCapability: ProviderVcsCheckpointCapability,
  rootPath: string,
  commonDirectoryPath: string,
  recoveryCompleted: Deferred.Deferred<ReadonlyArray<CheckpointRevertProcessResult>>,
) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const repositories = Layer.mergeAll(
    CheckpointRevertIntentRepositoryLive,
    CheckpointRevertSagaRepositoryLive,
    ProviderCheckpointOperationRepositoryLive,
    ProjectionCheckpointRepositoryLive,
  ).pipe(Layer.provide(persistence), Layer.provide(NodeServices.layer));
  const registry = Layer.effect(
    ProviderInstanceRegistry,
    Effect.gen(function* () {
      const generationChanges = yield* PubSub.unbounded<ProviderInstanceGenerationState>();
      const registryChanges = yield* PubSub.unbounded<void>();
      const lifecycle: ProviderInstanceGenerationLifecycle = {
        getCurrent: Effect.succeed({
          _tag: "Ready",
          providerInstanceId: INSTANCE_ID,
          generationId: 2,
        }),
        subscribeChanges: PubSub.subscribe(generationChanges),
      };
      const instance = {
        instanceId: INSTANCE_ID,
        driverKind: ProviderDriverKind.make("codex"),
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("codex"),
          continuationKey: "codex:native-checkpoint-provider",
        },
        displayName: "native checkpoint provider generation 2",
        enabled: true,
        generationLifecycle: lifecycle,
      } as ProviderInstance;
      return ProviderInstanceRegistry.of({
        getInstance: (instanceId) =>
          Effect.succeed(instanceId === INSTANCE_ID ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.fromPubSub(registryChanges),
        subscribeChanges: PubSub.subscribe(registryChanges),
      } satisfies ProviderInstanceRegistryShape);
    }),
  );
  const providerRepository: ProviderVcsRepository = {
    identity: { kind: "git", rootPath, commonDirectoryPath },
    capabilities: { status: true, refs: true, remotes: true, reviewDiff: true },
    checkpoints: checkpointCapability,
    getStatus: () => Effect.die("unused"),
    listRefs: () => Effect.die("unused"),
    listRemotes: () => Effect.die("unused"),
    getReviewDiff: () => Effect.die("unused"),
  };
  const providerService = {} as ProviderServiceShape;
  const directory = {
    upsert: () => Effect.die("unused"),
    getProvider: () => Effect.die("unused"),
    getBinding: () => Effect.die("unused"),
    listThreadIds: () => Effect.die("unused"),
    listBindings: () => Effect.succeed([]),
  } satisfies ProviderSessionDirectoryShape;
  const providerCommands = {
    start: () => Effect.die("unused"),
    recover: () => Effect.void,
    drain: Effect.void,
  } satisfies ProviderCommandReactorShape;
  const postTurnCheckpoints = {
    processTurnCompleted: () => Effect.die("unused"),
    recover: () => Effect.succeed([]),
    start: () => Effect.die("unused"),
    drain: Effect.void,
  } satisfies PostTurnCheckpointReactorShape;
  const orchestration = {
    dispatch: (command) => {
      assert.strictEqual(command.type, "thread.revert.complete");
      return Effect.succeed({ sequence: 777 });
    },
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  } satisfies OrchestrationEngineShape;
  const dependencies = Layer.mergeAll(
    repositories,
    registry,
    Layer.succeed(ProviderSessionDirectory, directory),
    Layer.succeed(ProviderService, providerService),
    Layer.succeed(ProviderCommandReactor, providerCommands),
    Layer.succeed(PostTurnCheckpointReactor, postTurnCheckpoints),
    Layer.succeed(ProjectRepository.ProjectRepository, {
      resolve: () => Effect.succeed(providerRepository),
    }),
    Layer.succeed(ProjectionSnapshotQuery, {} as ProjectionSnapshotQueryShape),
    Layer.succeed(OrchestrationEngineService, orchestration),
  );
  const recovery = Layer.effect(
    ProviderGenerationRecoveryReactor,
    Effect.gen(function* () {
      const checkpointReverts = yield* makeCheckpointRevertReactor;
      const observedCheckpointReverts = CheckpointRevertReactor.of({
        ...checkpointReverts,
        recover: () =>
          checkpointReverts
            .recover()
            .pipe(Effect.tap((outcomes) => Deferred.succeed(recoveryCompleted, outcomes))),
      });
      return yield* makeProviderGenerationRecoveryReactor.pipe(
        Effect.provideService(CheckpointRevertReactor, observedCheckpointReverts),
      );
    }),
  ).pipe(Layer.provideMerge(dependencies));
  return ManagedRuntime.make(recovery);
};

const captureInput = (
  capability: ProviderVcsCheckpointCapability,
  prepared: { readonly requestSha256: string; readonly generationId: number },
  operationId: string,
  logicalCheckpointId: string,
  kind: "baseline" | "post_turn",
): PrepareProviderCheckpointOperationInput => ({
  operationId,
  logicalCheckpointId,
  providerInstanceId: INSTANCE_ID,
  projectId: PROJECT_ID,
  threadId: THREAD_ID,
  turnId: kind === "post_turn" ? TURN_ID : null,
  operationKind: "capture",
  canonicalRequest: { operation: "capture", operationId, checkpointId: logicalCheckpointId },
  requestSha256: prepared.requestSha256,
  repository: {
    fingerprint: capability.binding.fingerprint,
    objectFormat: capability.binding.objectFormat,
  },
  providerGeneration: prepared.generationId,
  preparedAt: PREPARED_AT,
  intentContext:
    kind === "baseline"
      ? {
          kind,
          sourceCommandId: CommandId.make("native-capture-baseline-command"),
          sourceEventId: EventId.make("native-capture-baseline-event"),
          messageId: MessageId.make("native-capture-baseline-message"),
          checkpointTurnCount: 0,
        }
      : {
          kind,
          sourceEventId: EventId.make("native-capture-target-event"),
          turnId: TURN_ID,
          baselineCheckpointId: BASE_CHECKPOINT_ID,
          checkpointTurnCount: 1,
          completedAt: UPDATED_AT,
          outcome: "completed",
        },
});

const nativeCheckpoint = (
  result: CodexCheckpointHelperCaptureResult,
  logicalCheckpointId: string,
  operationId: string,
  turnId: TurnId | null,
): ProviderNativeCheckpoint => ({
  logicalCheckpointId,
  providerInstanceId: INSTANCE_ID,
  projectId: PROJECT_ID,
  threadId: THREAD_ID,
  turnId,
  repository: {
    fingerprint: result.receipt.repositoryFingerprint,
    objectFormat: "sha1",
  },
  captureOperationId: operationId,
  checkpointRef: result.receipt.checkpointRef,
  checkpointOid: result.receipt.checkpointOid,
  treeOid: result.receipt.treeOid,
  receiptRef: result.receipt.receiptRef,
  receiptObjectOid: result.receiptObjectOid,
  createdAt: PREPARED_AT,
  updatedAt: UPDATED_AT,
});

it.live.skipIf(!HAS_HELPER)(
  "reconciles native helper checkpoint state through SQLite after endpoint replacement",
  () =>
    Effect.gen(function* () {
      const temp = NodeFS.mkdtempSync(
        NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "cocoa-native-checkpoint-"),
      );
      try {
        const git = CodexGitExecutablePath.make(resolveExecutable("git"));
        const root = makeRepository(temp, git);
        const commonDirectoryPath = NodeFS.realpathSync(NodePath.join(root, ".git"));
        const dbPath = NodePath.join(temp, "gateway.sqlite");
        const helper = {
          type: "cocoa-checkpoint-helper-v1" as const,
          executablePath: RESOLVED_HELPER_BIN,
          expectedProtocol: 1 as const,
        } satisfies CodexCheckpointHelperConfig;
        const provider: ProviderBoundaryState = {
          generations: [],
          restoreDispatchCount: 0,
          dropFirstRestoreResponse: true,
        };

        const generationOne = yield* openCapability(
          1,
          provider,
          root,
          commonDirectoryPath,
          git,
          helper,
        );
        const firstRuntime = makeJournalRuntime(dbPath);
        const firstJournal = yield* Effect.promise(() =>
          firstRuntime.runPromise(Effect.service(ProviderCheckpointOperationRepository)),
        );

        const basePrepared = yield* generationOne.prepareCapture({
          operationId: BASE_CAPTURE_OPERATION_ID,
          checkpointId: BASE_CHECKPOINT_ID,
        });
        const baseInput = captureInput(
          generationOne,
          basePrepared,
          BASE_CAPTURE_OPERATION_ID,
          BASE_CHECKPOINT_ID,
          "baseline",
        );
        yield* Effect.promise(() => firstRuntime.runPromise(firstJournal.prepare(baseInput)));
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstJournal.markInFlight({
              operationId: BASE_CAPTURE_OPERATION_ID,
              providerGeneration: 1,
              updatedAt: UPDATED_AT,
            }),
          ),
        );
        const baseResult = yield* basePrepared.execute;
        const baseCheckpoint = nativeCheckpoint(
          baseResult,
          BASE_CHECKPOINT_ID,
          BASE_CAPTURE_OPERATION_ID,
          null,
        );
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstJournal.finalizeCapture({
              completion: {
                operationId: BASE_CAPTURE_OPERATION_ID,
                updatedAt: UPDATED_AT,
                receipt: baseResult.receipt,
                result: baseResult,
              },
              checkpoint: baseCheckpoint,
            }),
          ),
        );

        NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "target\n");
        const targetPrepared = yield* generationOne.prepareCapture({
          operationId: TARGET_CAPTURE_OPERATION_ID,
          checkpointId: TARGET_CHECKPOINT_ID,
        });
        const targetInput = captureInput(
          generationOne,
          targetPrepared,
          TARGET_CAPTURE_OPERATION_ID,
          TARGET_CHECKPOINT_ID,
          "post_turn",
        );
        yield* Effect.promise(() => firstRuntime.runPromise(firstJournal.prepare(targetInput)));
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstJournal.markInFlight({
              operationId: TARGET_CAPTURE_OPERATION_ID,
              providerGeneration: 1,
              updatedAt: UPDATED_AT,
            }),
          ),
        );
        const targetResult = yield* targetPrepared.execute;
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstJournal.finalizeCapture({
              completion: {
                operationId: TARGET_CAPTURE_OPERATION_ID,
                updatedAt: UPDATED_AT,
                receipt: targetResult.receipt,
                result: targetResult,
              },
              checkpoint: nativeCheckpoint(
                targetResult,
                TARGET_CHECKPOINT_ID,
                TARGET_CAPTURE_OPERATION_ID,
                TURN_ID,
              ),
            }),
          ),
        );

        const diff = yield* generationOne.diff({
          baseCheckpointId: BASE_CHECKPOINT_ID,
          targetCheckpointId: TARGET_CHECKPOINT_ID,
          ignoreWhitespace: false,
          limits: { maxPatchBytes: 16_384 },
        });
        assert.include(Buffer.from(diff.patchBase64, "base64").toString("utf8"), "+target");

        const restorePrepared = yield* generationOne.prepareRestore({
          operationId: RESTORE_OPERATION_ID,
          checkpointId: BASE_CHECKPOINT_ID,
          expectedCheckpointOid: baseResult.receipt.checkpointOid,
        });
        const restoreInput: PrepareProviderCheckpointOperationInput = {
          operationId: RESTORE_OPERATION_ID,
          logicalCheckpointId: BASE_CHECKPOINT_ID,
          providerInstanceId: INSTANCE_ID,
          projectId: PROJECT_ID,
          threadId: THREAD_ID,
          turnId: null,
          operationKind: "restore",
          canonicalRequest: {
            operation: "restore",
            operationId: RESTORE_OPERATION_ID,
            checkpointId: BASE_CHECKPOINT_ID,
            expectedCheckpointOid: baseResult.receipt.checkpointOid,
          },
          requestSha256: restorePrepared.requestSha256,
          repository: {
            fingerprint: generationOne.binding.fingerprint,
            objectFormat: generationOne.binding.objectFormat,
          },
          providerGeneration: restorePrepared.generationId,
          preparedAt: PREPARED_AT,
          intentContext: {
            kind: "restore",
            sourceRevertEventId: REVERT_EVENT_ID,
            sourceCommandId: REVERT_COMMAND_ID,
            requestedTurnCount: 0,
          },
        };
        yield* Effect.promise(() => firstRuntime.runPromise(firstJournal.prepare(restoreInput)));
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstJournal.markInFlight({
              operationId: RESTORE_OPERATION_ID,
              providerGeneration: 1,
              updatedAt: UPDATED_AT,
            }),
          ),
        );
        const firstIntents = yield* Effect.promise(() =>
          firstRuntime.runPromise(Effect.service(CheckpointRevertIntentRepository)),
        );
        const firstSagas = yield* Effect.promise(() =>
          firstRuntime.runPromise(Effect.service(CheckpointRevertSagaRepository)),
        );
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstIntents.projectInTransaction({
              sourceEventId: REVERT_EVENT_ID,
              sourceSequence: 10,
              sourceCommandId: REVERT_COMMAND_ID,
              threadId: THREAD_ID,
              requestedTurnCount: 0,
              requestedAt: PREPARED_AT,
              createdAt: PREPARED_AT,
            }),
          ),
        );
        const createdSaga = yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstSagas.getOrCreate({
              sourceRevertEventId: REVERT_EVENT_ID,
              sourceCommandId: REVERT_COMMAND_ID,
              providerInstanceId: INSTANCE_ID,
              projectId: PROJECT_ID,
              threadId: THREAD_ID,
              providerDriverKind: ProviderDriverKind.make("codex"),
              continuationIdentitySha256: "a".repeat(64),
              requestedTurnCount: 0,
              preimageTurnCount: 1,
              preimage: { count: 1, sha256: "b".repeat(64) },
              target: { count: 0, sha256: "c".repeat(64) },
              retainedLogicalCheckpointId: BASE_CHECKPOINT_ID,
              retainedExpectedCheckpointOid: baseResult.receipt.checkpointOid,
              repositoryFingerprint: generationOne.binding.fingerprint,
              repositoryObjectFormat: generationOne.binding.objectFormat,
              restoreOperationId: RESTORE_OPERATION_ID,
              staleTargets: [],
              createdAt: PREPARED_AT,
            }),
          ),
        );
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstIntents.linkSaga({
              sourceEventId: REVERT_EVENT_ID,
              sagaId: createdSaga.saga.sagaId,
            }),
          ),
        );
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstSagas.markRollbackInFlight({
              sagaId: createdSaga.saga.sagaId,
              updatedAt: UPDATED_AT,
            }),
          ),
        );
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstSagas.markRollbackCompleted({
              sagaId: createdSaga.saga.sagaId,
              updatedAt: UPDATED_AT,
            }),
          ),
        );
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstSagas.markRestoring({
              sagaId: createdSaga.saga.sagaId,
              updatedAt: UPDATED_AT,
            }),
          ),
        );
        const lostRestore = yield* Effect.flip(restorePrepared.execute);
        assert.isTrue(isOutcomeUnknown(lostRestore));
        yield* Effect.promise(() =>
          firstRuntime.runPromise(
            firstJournal.markOutcomeUnknown({
              operationId: RESTORE_OPERATION_ID,
              updatedAt: UPDATED_AT,
              error: { code: "provider_disconnected" },
            }),
          ),
        );
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(root, "tracked.txt"), "utf8"),
          "base\n",
        );
        yield* Effect.promise(() => firstRuntime.dispose());

        const generationTwo = yield* openCapability(
          2,
          provider,
          root,
          commonDirectoryPath,
          git,
          helper,
        );
        const recoveryCompleted =
          yield* Deferred.make<ReadonlyArray<CheckpointRevertProcessResult>>();
        const secondRuntime = makeRecoveryRuntime(
          dbPath,
          generationTwo,
          root,
          commonDirectoryPath,
          recoveryCompleted,
        );
        try {
          const secondJournal = yield* Effect.promise(() =>
            secondRuntime.runPromise(Effect.service(ProviderCheckpointOperationRepository)),
          );
          const durableBeforeRecovery = yield* Effect.promise(() =>
            secondRuntime.runPromise(
              secondJournal.getByOperationId({ operationId: RESTORE_OPERATION_ID }),
            ),
          );
          assert.isTrue(Option.isSome(durableBeforeRecovery));
          assert.strictEqual(Option.getOrThrow(durableBeforeRecovery).state, "outcome_unknown");
          const outcomes = yield* Effect.promise(() =>
            secondRuntime.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const recovery = yield* ProviderGenerationRecoveryReactor;
                  yield* recovery.start();
                  return yield* Deferred.await(recoveryCompleted);
                }),
              ),
            ),
          );
          assert.deepStrictEqual(outcomes, [
            {
              sourceEventId: REVERT_EVENT_ID,
              sagaId: createdSaga.saga.sagaId,
              status: "completed",
              sequence: 777,
            },
          ]);
          const recovered = yield* Effect.promise(() =>
            secondRuntime.runPromise(
              secondJournal.getByOperationId({ operationId: RESTORE_OPERATION_ID }),
            ),
          );
          assert.strictEqual(Option.getOrThrow(recovered).state, "completed");
          const secondSagas = yield* Effect.promise(() =>
            secondRuntime.runPromise(Effect.service(CheckpointRevertSagaRepository)),
          );
          const durableSaga = yield* Effect.promise(() =>
            secondRuntime.runPromise(secondSagas.getBySagaId({ sagaId: createdSaga.saga.sagaId })),
          );
          assert.strictEqual(Option.getOrThrow(durableSaga).state, "completed");
          const secondIntents = yield* Effect.promise(() =>
            secondRuntime.runPromise(Effect.service(CheckpointRevertIntentRepository)),
          );
          const durableIntent = yield* Effect.promise(() =>
            secondRuntime.runPromise(
              secondIntents.getBySourceEventId({ sourceEventId: REVERT_EVENT_ID }),
            ),
          );
          assert.strictEqual(Option.getOrThrow(durableIntent).state, "terminal");
          assert.strictEqual(Option.getOrThrow(durableIntent).terminalOutcome, "completed");
          assert.deepStrictEqual(provider.generations, [1, 2]);
          assert.strictEqual(provider.restoreDispatchCount, 1);
        } finally {
          yield* Effect.promise(() => secondRuntime.dispose());
        }
      } finally {
        NodeFS.rmSync(temp, { recursive: true, force: true });
      }
    }),
);
