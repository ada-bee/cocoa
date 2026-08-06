// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import {
  CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX,
  CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
  CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
  CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
  CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX,
  CodexCheckpointHelperRequest,
  ProviderInstanceId,
  type CodexCheckpointHelperMutationReceipt,
  type CodexCheckpointHelperRequest as CheckpointRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import * as CodexEndpointConnection from "../src/provider/codexEndpoint/CodexEndpointConnection.ts";
import type { CodexEndpointConnectionBorrow } from "../src/provider/codexEndpoint/CodexEndpointSupervisor.ts";
import { ProviderVcsCheckpointOutcomeUnknownError } from "../src/provider/ProviderVcsAdapter.ts";
import {
  encodeCodexCheckpointHelperFrame,
  makeCodexCheckpointHelperAdapter,
} from "../src/provider/codexVcs/CodexCheckpointHelperAdapter.ts";
import { CodexGitExecutablePath } from "../src/provider/codexVcs/CodexVcsAdapter.ts";

const INSTANCE_ID = ProviderInstanceId.make("remote-checkpoint-host");
const GIT = CodexGitExecutablePath.make("/nix/store/git/bin/git");
const HELPER = "/nix/store/cocoa/bin/cocoa-workspace-helper";
const ROOT = "/remote/worktrees/topic";
const COMMON = "/remote/repository/.git";
const GIT_DIRECTORY = "/remote/repository/.git/worktrees/topic";
const FINGERPRINT = "f".repeat(64);
const BASE_CHECKPOINT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_CHECKPOINT_ID = "22222222-2222-4222-8222-222222222222";
const BASE_CAPTURE_OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_CAPTURE_OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const RESTORE_OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const DELETE_OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const BASE_OID = "a".repeat(40);
const TARGET_OID = "b".repeat(40);
const BASE_TREE_OID = "c".repeat(40);
const TARGET_TREE_OID = "d".repeat(40);

const BINDING = {
  worktreeRoot: { canonicalPath: ROOT, device: "1", inode: "10" },
  gitDirectoryRoot: { canonicalPath: GIT_DIRECTORY, device: "1", inode: "11" },
  gitCommonDirectoryRoot: { canonicalPath: COMMON, device: "1", inode: "12" },
  objectFormat: "sha1" as const,
  fingerprint: FINGERPRINT,
};

const HELPER_CONFIG = {
  type: "cocoa-checkpoint-helper-v1" as const,
  executablePath: HELPER,
  expectedProtocol: 1 as const,
};

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const normalizeRequest = Schema.decodeUnknownSync(CodexCheckpointHelperRequest);
const isOutcomeUnknown = Schema.is(ProviderVcsCheckpointOutcomeUnknownError);

const requestDigest = (request: CheckpointRequest): string =>
  NodeCrypto.createHash("sha256")
    .update(new TextEncoder().encode(encodeJson(normalizeRequest(request))))
    .digest("hex");

const decodeRequest = (payload: Record<string, unknown>): CheckpointRequest => {
  const command = payload.command as ReadonlyArray<string>;
  assert.deepStrictEqual(command.slice(0, 1), [HELPER]);
  return decodeJson(
    Result.getOrThrow(Encoding.decodeBase64String(command[1]!)),
  ) as CheckpointRequest;
};

const success = (result: unknown) => ({
  exitCode: 0,
  stderr: "",
  stdout: encodeCodexCheckpointHelperFrame({
    protocol: "cocoa.checkpoint.v1",
    ok: true,
    result,
  }),
});

interface CheckpointState {
  readonly oid: string;
  readonly treeOid: string;
}

interface RemoteHelperState {
  readonly checkpoints: Map<string, CheckpointState>;
  readonly receipts: Map<string, CodexCheckpointHelperMutationReceipt>;
  readonly requests: Array<CheckpointRequest>;
  headOid: string;
  disconnectAfterRestoreCommit: boolean;
}

const makeRemoteHelperState = (): RemoteHelperState => ({
  checkpoints: new Map(),
  receipts: new Map(),
  requests: [],
  headOid: BASE_OID,
  disconnectAfterRestoreCommit: true,
});

const receiptObjectOid = (operationId: string): string =>
  NodeCrypto.createHash("sha1").update(operationId).digest("hex");

const makeConnection = (state: RemoteHelperState) => {
  const request = ((method: string, payload: unknown) => {
    assert.strictEqual(method, "command/exec");
    const helperRequest = decodeRequest(payload as Record<string, unknown>);
    state.requests.push(helperRequest);
    const digest = requestDigest(helperRequest);

    switch (helperRequest.operation) {
      case "probe":
        return Effect.succeed(
          success({
            operation: "probe",
            implementation: "stateful-test-helper",
            gitExecutablePath: GIT,
            capabilities: ["probe", "open", "capture", "diff", "restore", "delete", "observe"],
            objectFormats: ["sha1"],
            limits: {
              maxRequestBytes: CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
              maxPatchBytes: CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
              maxResponseBytes: CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
            },
          }),
        );
      case "open":
        return Effect.succeed(
          success({ operation: "open", binding: BINDING, headOid: state.headOid }),
        );
      case "capture": {
        const checkpoint =
          helperRequest.checkpointId === BASE_CHECKPOINT_ID
            ? { oid: BASE_OID, treeOid: BASE_TREE_OID }
            : { oid: TARGET_OID, treeOid: TARGET_TREE_OID };
        state.checkpoints.set(helperRequest.checkpointId, checkpoint);
        const receipt = {
          operation: "capture" as const,
          operationId: helperRequest.operationId,
          receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${helperRequest.operationId}`,
          requestSha256: digest,
          repositoryFingerprint: FINGERPRINT,
          status: "succeeded" as const,
          checkpointId: helperRequest.checkpointId,
          checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${helperRequest.checkpointId}`,
          checkpointOid: checkpoint.oid,
          treeOid: checkpoint.treeOid,
        };
        state.receipts.set(helperRequest.operationId, receipt);
        state.headOid = checkpoint.oid;
        return Effect.succeed(
          success({
            operation: "capture",
            receipt,
            receiptObjectOid: receiptObjectOid(helperRequest.operationId),
          }),
        );
      }
      case "diff":
        return Effect.succeed(
          success({
            operation: "diff",
            baseCheckpointId: helperRequest.baseCheckpointId,
            targetCheckpointId: helperRequest.targetCheckpointId,
            baseOid: BASE_OID,
            targetOid: TARGET_OID,
            patchBase64: Encoding.encodeBase64(
              new TextEncoder().encode("diff --git a/file b/file"),
            ),
            byteLength: 24,
            truncated: false,
          }),
        );
      case "restore": {
        const checkpoint = state.checkpoints.get(helperRequest.checkpointId)!;
        const receipt = {
          operation: "restore" as const,
          operationId: helperRequest.operationId,
          receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${helperRequest.operationId}`,
          requestSha256: digest,
          repositoryFingerprint: FINGERPRINT,
          status: "succeeded" as const,
          checkpointId: helperRequest.checkpointId,
          checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${helperRequest.checkpointId}`,
          checkpointOid: checkpoint.oid,
        };
        state.receipts.set(helperRequest.operationId, receipt);
        state.headOid = checkpoint.oid;
        if (state.disconnectAfterRestoreCommit) {
          state.disconnectAfterRestoreCommit = false;
          return Effect.fail(
            new CodexErrors.CodexAppServerTransportError({
              operation: "read-input-stream",
              cause: new Error("connection lost after helper commit"),
            }),
          );
        }
        return Effect.succeed(
          success({
            operation: "restore",
            receipt,
            receiptObjectOid: receiptObjectOid(helperRequest.operationId),
          }),
        );
      }
      case "delete": {
        const deleteCheckpoint = (checkpoint: (typeof helperRequest.checkpoints)[number]) => {
          state.checkpoints.delete(checkpoint.checkpointId);
          return {
            checkpointId: checkpoint.checkpointId,
            checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${checkpoint.checkpointId}`,
            status: "deleted" as const,
            deletedCheckpointOid: checkpoint.expectedCheckpointOid,
          };
        };
        const [firstCheckpoint, ...remainingCheckpoints] = helperRequest.checkpoints;
        const checkpoints = [
          deleteCheckpoint(firstCheckpoint),
          ...remainingCheckpoints.map(deleteCheckpoint),
        ] as const;
        const receipt: CodexCheckpointHelperMutationReceipt = {
          operation: "delete" as const,
          operationId: helperRequest.operationId,
          receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${helperRequest.operationId}`,
          requestSha256: digest,
          repositoryFingerprint: FINGERPRINT,
          status: "succeeded" as const,
          checkpoints,
        };
        state.receipts.set(helperRequest.operationId, receipt);
        return Effect.succeed(
          success({
            operation: "delete",
            receipt,
            receiptObjectOid: receiptObjectOid(helperRequest.operationId),
          }),
        );
      }
      case "observe": {
        const receipt = state.receipts.get(helperRequest.operationId);
        return Effect.succeed(
          success(
            receipt === undefined
              ? { operation: "observe", status: "not_found" }
              : {
                  operation: "observe",
                  status: "found",
                  receipt,
                  receiptObjectOid: receiptObjectOid(helperRequest.operationId),
                },
          ),
        );
      }
    }
  }) as CodexClient.CodexAppServerClient["Service"]["request"];

  return CodexEndpointConnection.CodexEndpointConnection.of({
    identity: { providerInstanceId: INSTANCE_ID },
    client: { request } as CodexClient.CodexAppServerClient["Service"],
    compatibility: {
      userAgent: "codex/acceptance",
      serverVersion: "acceptance",
      codexHome: "/remote/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    awaitTermination: Effect.never,
  });
};

const openCapability = Effect.fn("acceptance.openCheckpointCapability")(function* (
  state: RemoteHelperState,
  generationId: number,
) {
  const borrowed: CodexEndpointConnectionBorrow = {
    generationId,
    connection: makeConnection(state),
    ensureCurrent: Effect.void,
  };
  const adapter = makeCodexCheckpointHelperAdapter({
    providerInstanceId: INSTANCE_ID,
    gitExecutablePath: GIT,
    helper: HELPER_CONFIG,
  });
  const probe = yield* adapter.probe(borrowed, ROOT);
  return yield* adapter.open(borrowed, { rootPath: ROOT, commonDirectoryPath: COMMON }, probe);
});

it.effect(
  "keeps provider checkpoint mutations reconcilable across a gateway boundary restart",
  () =>
    Effect.gen(function* () {
      const remote = makeRemoteHelperState();
      const beforeRestart = yield* openCapability(remote, 1);

      const baseCapture = yield* beforeRestart.prepareCapture({
        operationId: BASE_CAPTURE_OPERATION_ID,
        checkpointId: BASE_CHECKPOINT_ID,
      });
      const baseResult = yield* baseCapture.execute;
      assert.strictEqual(baseResult.receipt.checkpointOid, BASE_OID);

      const targetCapture = yield* beforeRestart.prepareCapture({
        operationId: TARGET_CAPTURE_OPERATION_ID,
        checkpointId: TARGET_CHECKPOINT_ID,
      });
      const targetResult = yield* targetCapture.execute;
      assert.strictEqual(targetResult.receipt.checkpointOid, TARGET_OID);

      const diff = yield* beforeRestart.diff({
        baseCheckpointId: BASE_CHECKPOINT_ID,
        targetCheckpointId: TARGET_CHECKPOINT_ID,
        ignoreWhitespace: false,
        limits: { maxPatchBytes: 4_096 },
      });
      assert.strictEqual(diff.baseOid, BASE_OID);
      assert.strictEqual(diff.targetOid, TARGET_OID);

      const restore = yield* beforeRestart.prepareRestore({
        operationId: RESTORE_OPERATION_ID,
        checkpointId: BASE_CHECKPOINT_ID,
        expectedCheckpointOid: BASE_OID,
      });
      const ambiguousRestore = yield* Effect.flip(restore.execute);
      assert.isTrue(isOutcomeUnknown(ambiguousRestore));
      assert.strictEqual(remote.headOid, BASE_OID);

      // Recreate the complete adapter/connection boundary, as the gateway does after a restart,
      // then reconcile the exact durable request instead of replaying the restore mutation.
      const afterRestart = yield* openCapability(remote, 2);
      const observedRestore = yield* afterRestart.observe({
        operationId: RESTORE_OPERATION_ID,
        expectedRequestSha256: restore.requestSha256,
      });
      assert.strictEqual(observedRestore.status, "found");
      if (observedRestore.status === "found") {
        assert.strictEqual(observedRestore.receipt.operation, "restore");
        assert.strictEqual(observedRestore.receipt.requestSha256, restore.requestSha256);
      }
      assert.strictEqual(
        remote.requests.filter((request) => request.operation === "restore").length,
        1,
      );

      const deletion = yield* afterRestart.prepareDelete({
        operationId: DELETE_OPERATION_ID,
        checkpoints: [{ checkpointId: TARGET_CHECKPOINT_ID, expectedCheckpointOid: TARGET_OID }],
      });
      const deleted = yield* deletion.execute;
      assert.strictEqual(deleted.receipt.checkpoints[0]?.status, "deleted");
      assert.isFalse(remote.checkpoints.has(TARGET_CHECKPOINT_ID));
      assert.isTrue(remote.checkpoints.has(BASE_CHECKPOINT_ID));

      assert.deepStrictEqual(
        remote.requests.map((request) => request.operation),
        [
          "probe",
          "open",
          "capture",
          "capture",
          "diff",
          "restore",
          "probe",
          "open",
          "observe",
          "delete",
        ],
      );
      assert.isTrue(remote.requests.every((request) => request.gitExecutablePath === GIT));
    }),
);
