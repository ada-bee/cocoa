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
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CodexCheckpointHelperCaptureResult,
  type CodexCheckpointHelperConfig,
  type CodexCheckpointHelperRestoreResult,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import { ProviderCheckpointOperationRepositoryLive } from "../src/persistence/Layers/ProviderCheckpointOperations.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
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
} from "../src/provider/ProviderVcsAdapter.ts";
import { makeCodexCheckpointHelperAdapter } from "../src/provider/codexVcs/CodexCheckpointHelperAdapter.ts";
import { CodexGitExecutablePath } from "../src/provider/codexVcs/CodexVcsAdapter.ts";

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
const RESTORE_OPERATION_ID = "20000000-0000-4000-8000-000000000003";
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
    ProviderCheckpointOperationRepositoryLive.pipe(
      Layer.provide(persistence),
      Layer.provide(NodeServices.layer),
    ),
  );
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
            sourceRevertEventId: EventId.make("native-restore-event"),
            sourceCommandId: CommandId.make("native-restore-command"),
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
        const secondRuntime = makeJournalRuntime(dbPath);
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

          const observed = yield* generationTwo.observe({
            operationId: RESTORE_OPERATION_ID,
            expectedRequestSha256: restorePrepared.requestSha256,
          });
          assert.strictEqual(observed.status, "found");
          if (observed.status !== "found" || observed.receipt.operation !== "restore") {
            return yield* Effect.die(
              "Expected the replacement endpoint to observe restore receipt.",
            );
          }
          const restoreResult: CodexCheckpointHelperRestoreResult = {
            operation: "restore",
            receipt: observed.receipt,
            receiptObjectOid: observed.receiptObjectOid,
          };
          const durableBase = yield* Effect.promise(() =>
            secondRuntime.runPromise(
              secondJournal.getLogicalCheckpoint({ logicalCheckpointId: BASE_CHECKPOINT_ID }),
            ),
          );
          assert.isTrue(Option.isSome(durableBase));
          yield* Effect.promise(() =>
            secondRuntime.runPromise(
              secondJournal.finalizeRestore({
                completion: {
                  operationId: RESTORE_OPERATION_ID,
                  updatedAt: UPDATED_AT,
                  receipt: observed.receipt,
                  result: restoreResult,
                },
                targetCheckpoint: Option.getOrThrow(durableBase),
              }),
            ),
          );
          const recovered = yield* Effect.promise(() =>
            secondRuntime.runPromise(
              secondJournal.getByOperationId({ operationId: RESTORE_OPERATION_ID }),
            ),
          );
          assert.strictEqual(Option.getOrThrow(recovered).state, "completed");
          assert.deepStrictEqual(provider.generations, [1, 2]);
        } finally {
          yield* Effect.promise(() => secondRuntime.dispose());
        }
      } finally {
        NodeFS.rmSync(temp, { recursive: true, force: true });
      }
    }),
);
