import { assert, it } from "@effect/vitest";
import {
  CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX,
  CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ProviderVcsAdapter,
  ProviderVcsChangedPathKind,
  type ProviderVcsCheckpointCapability,
  type ProviderVcsCheckpointCaptureInput,
  type ProviderVcsCheckpointDeleteInput,
  type ProviderVcsCheckpointDiffInput,
  type ProviderVcsCheckpointObserveInput,
  ProviderVcsCheckpointOutcomeUnknownError,
  ProviderVcsCheckpointRestoreIndeterminateError,
  type ProviderVcsCheckpointRestoreInput,
  ProviderVcsCheckpointMutationOperation,
  ProviderVcsDisconnectedError,
  type ProviderVcsError,
  ProviderVcsOperation,
  ProviderVcsOperationError,
  ProviderVcsPathError,
  ProviderVcsProtocolError,
  ProviderVcsReadCapabilities,
  ProviderVcsReadCapability,
  ProviderVcsRefLimit,
  ProviderVcsRefQuery,
  ProviderVcsRefScope,
  ProviderVcsRemoteLimit,
  type ProviderVcsRepository,
  ProviderVcsReviewDiffByteLimit,
  ProviderVcsReviewDiffSourceKind,
  ProviderVcsRevision,
  ProviderVcsStatusPathLimit,
  ProviderVcsUnsupportedError,
  PROVIDER_VCS_MAX_REFS,
  PROVIDER_VCS_MAX_REMOTES,
  PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES,
  PROVIDER_VCS_MAX_STATUS_PATHS,
} from "./ProviderVcsAdapter.ts";

const providerInstanceId = ProviderInstanceId.make("provider-vcs-test");
const decodeOperation = Schema.decodeUnknownSync(ProviderVcsOperation);
const decodeCapability = Schema.decodeUnknownSync(ProviderVcsReadCapability);
const decodeScope = Schema.decodeUnknownSync(ProviderVcsRefScope);
const decodeChangedPathKind = Schema.decodeUnknownSync(ProviderVcsChangedPathKind);
const decodeDiffSourceKind = Schema.decodeUnknownSync(ProviderVcsReviewDiffSourceKind);
const decodeReadCapabilities = Schema.decodeUnknownSync(ProviderVcsReadCapabilities);
const decodeCheckpointMutationOperation = Schema.decodeUnknownSync(
  ProviderVcsCheckpointMutationOperation,
);

const operationId = "11111111-1111-4111-8111-111111111111";
const checkpointId = "22222222-2222-4222-a222-222222222222";
const targetCheckpointId = "33333333-3333-4333-b333-333333333333";
const requestSha256 = "a".repeat(64);
const fingerprint = "b".repeat(64);
const checkpointOid = "c".repeat(40);
const targetCheckpointOid = "d".repeat(40);
const treeOid = "e".repeat(40);
const receiptObjectOid = "f".repeat(40);
const checkpointRef = `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${checkpointId}`;
const receiptRef = `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${operationId}`;

const checkpointBinding = {
  worktreeRoot: { canonicalPath: "/provider/repository", device: "1", inode: "10" },
  gitDirectoryRoot: {
    canonicalPath: "/provider/repository/.git",
    device: "1",
    inode: "11",
  },
  gitCommonDirectoryRoot: {
    canonicalPath: "/provider/repository/.git",
    device: "1",
    inode: "11",
  },
  objectFormat: "sha1",
  fingerprint,
} as const;

it("bounds every provider VCS read", () => {
  assert.throws(() => ProviderVcsStatusPathLimit.make(0));
  assert.throws(() => ProviderVcsStatusPathLimit.make(PROVIDER_VCS_MAX_STATUS_PATHS + 1));
  assert.strictEqual(
    ProviderVcsStatusPathLimit.make(PROVIDER_VCS_MAX_STATUS_PATHS),
    PROVIDER_VCS_MAX_STATUS_PATHS,
  );

  assert.throws(() => ProviderVcsRefLimit.make(0));
  assert.throws(() => ProviderVcsRefLimit.make(PROVIDER_VCS_MAX_REFS + 1));
  assert.strictEqual(ProviderVcsRefLimit.make(PROVIDER_VCS_MAX_REFS), PROVIDER_VCS_MAX_REFS);

  assert.throws(() => ProviderVcsRemoteLimit.make(0));
  assert.throws(() => ProviderVcsRemoteLimit.make(PROVIDER_VCS_MAX_REMOTES + 1));
  assert.strictEqual(
    ProviderVcsRemoteLimit.make(PROVIDER_VCS_MAX_REMOTES),
    PROVIDER_VCS_MAX_REMOTES,
  );

  assert.throws(() => ProviderVcsReviewDiffByteLimit.make(0));
  assert.throws(() => ProviderVcsReviewDiffByteLimit.make(PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES + 1));
  assert.strictEqual(
    ProviderVcsReviewDiffByteLimit.make(PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES),
    PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES,
  );
});

it("keeps operations, capabilities, scopes, and result kinds closed", () => {
  assert.deepStrictEqual(
    [
      "openRepository",
      "getStatus",
      "listRefs",
      "listRemotes",
      "getReviewDiff",
      "captureCheckpoint",
      "diffCheckpoints",
      "restoreCheckpoint",
      "deleteCheckpoints",
      "observeCheckpointOperation",
    ].map((value) => decodeOperation(value)),
    [
      "openRepository",
      "getStatus",
      "listRefs",
      "listRemotes",
      "getReviewDiff",
      "captureCheckpoint",
      "diffCheckpoints",
      "restoreCheckpoint",
      "deleteCheckpoints",
      "observeCheckpointOperation",
    ],
  );
  assert.throws(() => decodeOperation("commit"));

  assert.deepStrictEqual(
    ["status", "refs", "remotes", "reviewDiff"].map((value) => decodeCapability(value)),
    ["status", "refs", "remotes", "reviewDiff"],
  );
  assert.throws(() => decodeCapability("checkpoint"));

  assert.deepStrictEqual(
    ["captureCheckpoint", "restoreCheckpoint", "deleteCheckpoints"].map((value) =>
      decodeCheckpointMutationOperation(value),
    ),
    ["captureCheckpoint", "restoreCheckpoint", "deleteCheckpoints"],
  );
  assert.throws(() => decodeCheckpointMutationOperation("diffCheckpoints"));
  assert.throws(() => decodeCheckpointMutationOperation("getStatus"));

  assert.deepStrictEqual(
    ["local", "knownRemote", "all"].map((value) => decodeScope(value)),
    ["local", "knownRemote", "all"],
  );
  assert.throws(() => decodeScope("fetchedRemote"));

  assert.strictEqual(decodeChangedPathKind("conflicted"), "conflicted");
  assert.throws(() => decodeChangedPathKind("ignored"));
  assert.strictEqual(decodeDiffSourceKind("workingTree"), "workingTree");
  assert.throws(() => decodeDiffSourceKind("checkpoint"));

  assert.deepStrictEqual(
    decodeReadCapabilities({
      status: true,
      refs: true,
      remotes: false,
      reviewDiff: true,
    }),
    {
      status: true,
      refs: true,
      remotes: false,
      reviewDiff: true,
    },
  );
});

it("validates bounded, non-option-like ref inputs", () => {
  assert.strictEqual(ProviderVcsRefQuery.make("feature"), "feature");
  assert.throws(() => ProviderVcsRefQuery.make("x".repeat(257)));

  assert.strictEqual(ProviderVcsRevision.make("origin/main~2"), "origin/main~2");
  assert.throws(() => ProviderVcsRevision.make(""));
  assert.throws(() => ProviderVcsRevision.make("--output=/tmp/leak"));
  assert.throws(() => ProviderVcsRevision.make("main\0other"));
});

type FirstArgument<Method> = Method extends (input: infer Input) => unknown ? Input : never;
type HasExecutionEscape<Input> =
  Extract<keyof Input, "cwd" | "command" | "argv"> extends never ? false : true;
type HasCheckpointTransportEscape<Input> =
  Extract<
    keyof Input,
    "cwd" | "command" | "argv" | "protocol" | "operation" | "gitExecutablePath" | "expectedBinding"
  > extends never
    ? false
    : true;
type AssertFalse<Value extends false> = Value;

const repositoryInputsHaveNoExecutionEscape: readonly [
  AssertFalse<HasExecutionEscape<FirstArgument<ProviderVcsRepository["getStatus"]>>>,
  AssertFalse<HasExecutionEscape<FirstArgument<ProviderVcsRepository["listRefs"]>>>,
  AssertFalse<HasExecutionEscape<FirstArgument<ProviderVcsRepository["listRemotes"]>>>,
  AssertFalse<HasExecutionEscape<FirstArgument<ProviderVcsRepository["getReviewDiff"]>>>,
] = [false, false, false, false];

const checkpointInputsHaveNoTransportEscape: readonly [
  AssertFalse<HasCheckpointTransportEscape<ProviderVcsCheckpointCaptureInput>>,
  AssertFalse<HasCheckpointTransportEscape<ProviderVcsCheckpointDiffInput>>,
  AssertFalse<HasCheckpointTransportEscape<ProviderVcsCheckpointRestoreInput>>,
  AssertFalse<HasCheckpointTransportEscape<ProviderVcsCheckpointDeleteInput>>,
  AssertFalse<HasCheckpointTransportEscape<ProviderVcsCheckpointObserveInput>>,
] = [false, false, false, false, false];

it.effect("returns explicit not-repository or a permanently bound read handle", () =>
  Effect.gen(function* () {
    const openedPaths: Array<string> = [];
    const repository: ProviderVcsRepository = {
      identity: {
        kind: "git",
        rootPath: "/provider/repository",
        commonDirectoryPath: "/provider/repository/.git",
      },
      capabilities: {
        status: true,
        refs: true,
        remotes: true,
        reviewDiff: true,
      },
      getStatus: () =>
        Effect.succeed({
          head: { _tag: "Branch", name: "main", commit: "abc123" },
          defaultRef: "main",
          upstreamRef: "origin/main",
          aheadCount: 1,
          behindCount: 0,
          hasPrimaryRemote: true,
          hasWorkingTreeChanges: true,
          changedPaths: [],
          truncated: true,
        }),
      listRefs: () => Effect.succeed({ refs: [], truncated: true }),
      listRemotes: () => Effect.succeed({ remotes: [], truncated: true }),
      getReviewDiff: () => Effect.succeed({ sources: [], truncated: true }),
    };
    const adapter: ProviderVcsAdapter = {
      openRepository: (providerHostPath) => {
        openedPaths.push(providerHostPath);
        return Effect.succeed(
          providerHostPath === "/provider/plain-directory"
            ? { _tag: "NotRepository" as const }
            : { _tag: "Repository" as const, repository },
        );
      },
    };

    const notRepository = yield* adapter.openRepository("/provider/plain-directory");
    const opened = yield* adapter.openRepository("/provider/repository/subdirectory");

    assert.strictEqual(notRepository._tag, "NotRepository");
    assert.strictEqual(opened._tag, "Repository");
    if (opened._tag === "Repository") {
      assert.deepStrictEqual(opened.repository.identity, repository.identity);
      assert.strictEqual(opened.repository.checkpoints, undefined);
      assert.strictEqual(
        (yield* opened.repository.getStatus({
          maxChangedPaths: ProviderVcsStatusPathLimit.make(1),
        })).truncated,
        true,
      );
    }
    assert.deepStrictEqual(openedPaths, [
      "/provider/plain-directory",
      "/provider/repository/subdirectory",
    ]);
    assert.deepStrictEqual(repositoryInputsHaveNoExecutionEscape, [false, false, false, false]);
  }),
);

it.effect("exposes CCH1 checkpoints only through an optional bound capability", () =>
  Effect.gen(function* () {
    const captureInputs: Array<ProviderVcsCheckpointCaptureInput> = [];
    const diffInputs: Array<ProviderVcsCheckpointDiffInput> = [];
    const restoreInputs: Array<ProviderVcsCheckpointRestoreInput> = [];
    const deleteInputs: Array<ProviderVcsCheckpointDeleteInput> = [];
    const observeInputs: Array<ProviderVcsCheckpointObserveInput> = [];

    const commonReceipt = {
      operationId,
      receiptRef,
      requestSha256,
      repositoryFingerprint: fingerprint,
      status: "succeeded" as const,
    };
    const checkpoints: ProviderVcsCheckpointCapability = {
      binding: checkpointBinding,
      capture: (input) => {
        captureInputs.push(input);
        return Effect.succeed({
          operation: "capture",
          receipt: {
            ...commonReceipt,
            operation: "capture",
            checkpointId,
            checkpointRef,
            checkpointOid,
            treeOid,
          },
          receiptObjectOid,
        });
      },
      diff: (input) => {
        diffInputs.push(input);
        return Effect.succeed({
          operation: "diff",
          baseCheckpointId: checkpointId,
          targetCheckpointId,
          baseOid: checkpointOid,
          targetOid: targetCheckpointOid,
          patchBase64: "ZGlmZg==",
          byteLength: 4,
          truncated: false,
        });
      },
      restore: (input) => {
        restoreInputs.push(input);
        return Effect.succeed({
          operation: "restore",
          receipt: {
            ...commonReceipt,
            operation: "restore",
            checkpointId,
            checkpointRef,
            checkpointOid,
          },
          receiptObjectOid,
        });
      },
      delete: (input) => {
        deleteInputs.push(input);
        return Effect.succeed({
          operation: "delete",
          receipt: {
            ...commonReceipt,
            operation: "delete",
            checkpoints: [
              {
                checkpointId,
                checkpointRef,
                status: "deleted",
                deletedCheckpointOid: checkpointOid,
              },
            ],
          },
          receiptObjectOid,
        });
      },
      observe: (input) => {
        observeInputs.push(input);
        return Effect.succeed({ operation: "observe", status: "not_found" });
      },
    };

    const captureInput = { operationId, checkpointId } as const;
    const diffInput = {
      baseCheckpointId: checkpointId,
      targetCheckpointId,
      ignoreWhitespace: true,
      limits: { maxPatchBytes: 1024 },
    } as const;
    const restoreInput = {
      operationId,
      checkpointId,
      expectedCheckpointOid: checkpointOid,
    } as const;
    const deleteInput = {
      operationId,
      checkpoints: [{ checkpointId, expectedCheckpointOid: checkpointOid }],
    } as const;
    const observeInput = { operationId, expectedRequestSha256: requestSha256 } as const;

    assert.strictEqual((yield* checkpoints.capture(captureInput)).receipt.treeOid, treeOid);
    assert.strictEqual((yield* checkpoints.diff(diffInput)).byteLength, 4);
    assert.strictEqual(
      (yield* checkpoints.restore(restoreInput)).receipt.checkpointOid,
      checkpointOid,
    );
    assert.strictEqual(
      (yield* checkpoints.delete(deleteInput)).receipt.checkpoints[0]?.status,
      "deleted",
    );
    assert.strictEqual((yield* checkpoints.observe(observeInput)).status, "not_found");

    assert.deepStrictEqual(checkpoints.binding, checkpointBinding);
    assert.deepStrictEqual(captureInputs, [captureInput]);
    assert.deepStrictEqual(diffInputs, [diffInput]);
    assert.deepStrictEqual(restoreInputs, [restoreInput]);
    assert.deepStrictEqual(deleteInputs, [deleteInput]);
    assert.deepStrictEqual(observeInputs, [observeInput]);
    assert.deepStrictEqual(checkpointInputsHaveNoTransportEscape, [
      false,
      false,
      false,
      false,
      false,
    ]);
  }),
);

function describeError(error: ProviderVcsError): string {
  switch (error._tag) {
    case "ProviderVcsDisconnectedError":
    case "ProviderVcsUnsupportedError":
      return `${error._tag}:${error.operation}`;
    case "ProviderVcsProtocolError":
    case "ProviderVcsOperationError":
      return `${error._tag}:${error.detail}`;
    case "ProviderVcsPathError":
      return `${error._tag}:${error.providerHostPath}:${error.issue}`;
    case "ProviderVcsCheckpointRestoreIndeterminateError":
    case "ProviderVcsCheckpointOutcomeUnknownError":
      return `${error._tag}:${error.operation}`;
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

it("preserves exhaustive provider VCS failure categories", () => {
  const errors: ReadonlyArray<ProviderVcsError> = [
    new ProviderVcsDisconnectedError({
      providerInstanceId,
      operation: "getStatus",
    }),
    new ProviderVcsUnsupportedError({
      providerInstanceId,
      operation: "listRefs",
    }),
    new ProviderVcsProtocolError({
      providerInstanceId,
      operation: "listRemotes",
      detail: "invalid response",
    }),
    new ProviderVcsPathError({
      providerInstanceId,
      operation: "openRepository",
      providerHostPath: "/missing",
      issue: "directory does not exist",
    }),
    new ProviderVcsOperationError({
      providerInstanceId,
      operation: "getReviewDiff",
      detail: "provider helper rejected the request",
    }),
    new ProviderVcsCheckpointRestoreIndeterminateError({
      providerInstanceId,
      operation: "restoreCheckpoint",
    }),
    new ProviderVcsCheckpointOutcomeUnknownError({
      providerInstanceId,
      operation: "captureCheckpoint",
    }),
  ];

  assert.deepStrictEqual(errors.map(describeError), [
    "ProviderVcsDisconnectedError:getStatus",
    "ProviderVcsUnsupportedError:listRefs",
    "ProviderVcsProtocolError:invalid response",
    "ProviderVcsPathError:/missing:directory does not exist",
    "ProviderVcsOperationError:provider helper rejected the request",
    "ProviderVcsCheckpointRestoreIndeterminateError:restoreCheckpoint",
    "ProviderVcsCheckpointOutcomeUnknownError:captureCheckpoint",
  ]);
  assert.match(errors[0]!.message, /provider-vcs-test.*disconnected.*getStatus/i);
  assert.match(errors[3]!.message, /\/missing.*provider-vcs-test.*openRepository/i);
  assert.match(errors[5]!.message, /indeterminate.*restore.*provider-vcs-test.*not retry/i);
  assert.strictEqual("cause" in errors[5]!, false);
  assert.strictEqual("detail" in errors[5]!, false);
  assert.match(
    errors[6]!.message,
    /unknown.*provider-vcs-test.*captureCheckpoint.*receipt.*retry/i,
  );
  assert.strictEqual("cause" in errors[6]!, false);
  assert.strictEqual("detail" in errors[6]!, false);
});
