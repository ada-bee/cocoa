import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import {
  CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX,
  CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
  CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
  CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
  CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX,
  type CodexCheckpointHelperErrorCode,
  CodexCheckpointHelperRequest,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import * as CodexEndpointConnection from "../codexEndpoint/CodexEndpointConnection.ts";
import {
  CodexEndpointBorrowUnavailableError,
  type CodexEndpointConnectionBorrow,
} from "../codexEndpoint/CodexEndpointSupervisor.ts";
import {
  CODEX_CHECKPOINT_HELPER_COMMAND_ENV,
  CODEX_CHECKPOINT_HELPER_COMMAND_TIMEOUT_MS,
  decodeCodexCheckpointHelperFrame,
  encodeCodexCheckpointHelperFrame,
  makeCodexCheckpointHelperAdapter,
} from "./CodexCheckpointHelperAdapter.ts";
import { CodexGitExecutablePath } from "./CodexVcsAdapter.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_checkpoint_test");
const OTHER_INSTANCE_ID = ProviderInstanceId.make("another_provider");
const GIT = CodexGitExecutablePath.make("/nix/store/git/bin/git");
const HELPER = "/nix/store/cocoa/bin/cocoa-workspace-helper";
const ROOT = "/worktrees/topic";
const COMMON = "/repos/main/.git";
const GIT_DIRECTORY = "/repos/main/.git/worktrees/topic";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const CHECKPOINT_ID = "22222222-2222-4222-a222-222222222222";
const TARGET_CHECKPOINT_ID = "33333333-3333-4333-b333-333333333333";
const OID = "a".repeat(40);
const TARGET_OID = "b".repeat(40);
const TREE_OID = "c".repeat(40);
const RECEIPT_OID = "d".repeat(40);
const REQUEST_DIGEST = "e".repeat(64);
const FINGERPRINT = "f".repeat(64);

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

type CommandExecResponse = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type Handler = (
  payload: Record<string, unknown>,
  request: CodexCheckpointHelperRequest,
) => Effect.Effect<CommandExecResponse, CodexErrors.CodexAppServerError>;

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const normalizeRequest = Schema.decodeUnknownSync(CodexCheckpointHelperRequest);

const requestDigest = (request: CodexCheckpointHelperRequest): string =>
  NodeCrypto.createHash("sha256")
    .update(new TextEncoder().encode(encodeJson(normalizeRequest(request))))
    .digest("hex");

const commandRequestDigest = (payload: Record<string, unknown>): string => {
  const command = payload.command as ReadonlyArray<string>;
  const requestJson = Result.getOrThrow(Encoding.decodeBase64String(command[1]!));
  return NodeCrypto.createHash("sha256")
    .update(new TextEncoder().encode(requestJson))
    .digest("hex");
};

const decodeRequest = (payload: Record<string, unknown>): CodexCheckpointHelperRequest => {
  const command = payload.command as ReadonlyArray<string>;
  assert.strictEqual(command.length, 2);
  assert.strictEqual(command[0], HELPER);
  return decodeJson(
    Result.getOrThrow(Encoding.decodeBase64String(command[1]!)),
  ) as CodexCheckpointHelperRequest;
};

const success = (result: unknown): CommandExecResponse => ({
  exitCode: 0,
  stderr: "",
  stdout: encodeCodexCheckpointHelperFrame({
    protocol: "cocoa.checkpoint.v1",
    ok: true,
    result,
  }),
});

const helperFailure = (code: CodexCheckpointHelperErrorCode): CommandExecResponse => ({
  exitCode: 0,
  stderr: "",
  stdout: encodeCodexCheckpointHelperFrame({
    protocol: "cocoa.checkpoint.v1",
    ok: false,
    error: { code, message: "SECRET helper stderr /srv/private", retryable: true },
  }),
});

const defaultResponse = (request: CodexCheckpointHelperRequest): CommandExecResponse => {
  const exactRequestDigest = requestDigest(request);
  switch (request.operation) {
    case "probe":
      return success({
        operation: "probe",
        implementation: "test-helper",
        gitExecutablePath: GIT,
        capabilities: ["probe", "open", "capture", "diff", "restore", "delete", "observe"],
        objectFormats: ["sha1", "sha256"],
        limits: {
          maxRequestBytes: CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
          maxPatchBytes: CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
          maxResponseBytes: CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
        },
      });
    case "open":
      return success({ operation: "open", binding: BINDING, headOid: OID });
    case "capture":
      return success({
        operation: "capture",
        receipt: {
          operation: "capture",
          operationId: request.operationId,
          receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${request.operationId}`,
          requestSha256: exactRequestDigest,
          repositoryFingerprint: FINGERPRINT,
          status: "succeeded",
          checkpointId: request.checkpointId,
          checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${request.checkpointId}`,
          checkpointOid: OID,
          treeOid: TREE_OID,
        },
        receiptObjectOid: RECEIPT_OID,
      });
    case "diff":
      return success({
        operation: "diff",
        baseCheckpointId: request.baseCheckpointId,
        targetCheckpointId: request.targetCheckpointId,
        baseOid: OID,
        targetOid: TARGET_OID,
        patchBase64: "ZGlmZg==",
        byteLength: 4,
        truncated: false,
      });
    case "restore":
      return success({
        operation: "restore",
        receipt: {
          operation: "restore",
          operationId: request.operationId,
          receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${request.operationId}`,
          requestSha256: exactRequestDigest,
          repositoryFingerprint: FINGERPRINT,
          status: "succeeded",
          checkpointId: request.checkpointId,
          checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${request.checkpointId}`,
          checkpointOid: OID,
        },
        receiptObjectOid: RECEIPT_OID,
      });
    case "delete":
      return success({
        operation: "delete",
        receipt: {
          operation: "delete",
          operationId: request.operationId,
          receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${request.operationId}`,
          requestSha256: exactRequestDigest,
          repositoryFingerprint: FINGERPRINT,
          status: "succeeded",
          checkpoints: request.checkpoints.map((checkpoint) => ({
            checkpointId: checkpoint.checkpointId,
            checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${checkpoint.checkpointId}`,
            status: "deleted",
            deletedCheckpointOid: checkpoint.expectedCheckpointOid,
          })),
        },
        receiptObjectOid: RECEIPT_OID,
      });
    case "observe":
      return success({ operation: "observe", status: "not_found" });
  }
};

function makeConnection(handler: Handler, providerInstanceId = INSTANCE_ID) {
  const requests: Array<Record<string, unknown>> = [];
  const request = ((method: string, payload: unknown) => {
    assert.strictEqual(method, "command/exec");
    const command = payload as Record<string, unknown>;
    requests.push(command);
    return handler(command, decodeRequest(command));
  }) as CodexClient.CodexAppServerClient["Service"]["request"];
  return {
    requests,
    connection: CodexEndpointConnection.CodexEndpointConnection.of({
      identity: { providerInstanceId },
      client: { request } as CodexClient.CodexAppServerClient["Service"],
      compatibility: {
        userAgent: "codex/1",
        serverVersion: "1",
        codexHome: "/home/codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
      awaitTermination: Effect.never,
    }),
  };
}

function makeBorrow(
  connection: ReturnType<typeof makeConnection>["connection"],
  check: () => Effect.Effect<void, CodexEndpointBorrowUnavailableError> = () => Effect.void,
): CodexEndpointConnectionBorrow {
  return { generationId: 7, connection, ensureCurrent: Effect.suspend(check) };
}

const makeAdapter = () =>
  makeCodexCheckpointHelperAdapter({
    providerInstanceId: INSTANCE_ID,
    gitExecutablePath: GIT,
    helper: HELPER_CONFIG,
  });

const openCapability = Effect.fn("test.openCheckpointCapability")(function* (
  adapter: ReturnType<typeof makeAdapter>,
  borrowed: CodexEndpointConnectionBorrow,
) {
  const probe = yield* adapter.probe(borrowed, ROOT);
  return yield* adapter.open(borrowed, { rootPath: ROOT, commonDirectoryPath: COMMON }, probe);
});

it.effect("uses one fixed command per invocation and the exact sandbox matrix", () =>
  Effect.gen(function* () {
    const harness = makeConnection((_payload, request) => Effect.succeed(defaultResponse(request)));
    const borrowed = makeBorrow(harness.connection);
    const capability = yield* openCapability(makeAdapter(), borrowed);
    const preparedCapture = yield* capability.prepareCapture({
      operationId: OPERATION_ID,
      checkpointId: CHECKPOINT_ID,
      protocol: "hostile.protocol",
      operation: "observe",
      gitExecutablePath: "/tmp/hostile-git",
      expectedBinding: {
        ...BINDING,
        fingerprint: "0".repeat(64),
      },
    } as never);
    assert.strictEqual(harness.requests.length, 2);
    assert.strictEqual(preparedCapture.generationId, borrowed.generationId);
    const reconstructedCapture = yield* capability.prepareCapture({
      operationId: OPERATION_ID,
      checkpointId: CHECKPOINT_ID,
    });
    assert.strictEqual(reconstructedCapture.requestSha256, preparedCapture.requestSha256);
    assert.strictEqual(harness.requests.length, 2);
    assert.strictEqual(
      preparedCapture.requestSha256,
      requestDigest({
        protocol: "cocoa.checkpoint.v1",
        operation: "capture",
        gitExecutablePath: GIT,
        operationId: OPERATION_ID,
        checkpointId: CHECKPOINT_ID,
        expectedBinding: BINDING,
      }),
    );
    yield* preparedCapture.execute;
    assert.strictEqual(preparedCapture.requestSha256, commandRequestDigest(harness.requests[2]!));
    const repeatedExecutionError = yield* Effect.flip(preparedCapture.execute);
    assert.strictEqual(repeatedExecutionError._tag, "ProviderVcsOperationError");
    assert.strictEqual(harness.requests.length, 3);
    yield* capability.diff({
      baseCheckpointId: CHECKPOINT_ID,
      targetCheckpointId: TARGET_CHECKPOINT_ID,
      ignoreWhitespace: false,
      limits: { maxPatchBytes: 4_096 },
    });
    const preparedRestore = yield* capability.prepareRestore({
      operationId: OPERATION_ID,
      checkpointId: CHECKPOINT_ID,
      expectedCheckpointOid: OID,
    });
    yield* preparedRestore.execute;
    const preparedDelete = yield* capability.prepareDelete({
      operationId: OPERATION_ID,
      checkpoints: [{ checkpointId: CHECKPOINT_ID, expectedCheckpointOid: OID }],
    });
    yield* preparedDelete.execute;
    yield* capability.observe({
      operationId: OPERATION_ID,
      expectedRequestSha256: REQUEST_DIGEST,
    });

    assert.strictEqual(harness.requests.length, 7);
    assert.notProperty(capability, "capture");
    assert.notProperty(capability, "restore");
    assert.notProperty(capability, "delete");
    const decoded = harness.requests.map(decodeRequest);
    assert.deepStrictEqual(
      decoded.map((request) => request.operation),
      ["probe", "open", "capture", "diff", "restore", "delete", "observe"],
    );
    for (const request of decoded) assert.strictEqual(request.gitExecutablePath, GIT);
    for (const request of decoded.slice(2)) {
      assert.deepStrictEqual(
        (request as Extract<CodexCheckpointHelperRequest, { expectedBinding: unknown }>)
          .expectedBinding,
        BINDING,
      );
    }
    for (const payload of harness.requests) {
      assert.strictEqual(payload.cwd, ROOT);
      assert.deepStrictEqual(payload.env, CODEX_CHECKPOINT_HELPER_COMMAND_ENV);
      assert.strictEqual(
        payload.timeoutMs,
        CODEX_CHECKPOINT_HELPER_COMMAND_TIMEOUT_MS[
          decodeRequest(payload)
            .operation as keyof typeof CODEX_CHECKPOINT_HELPER_COMMAND_TIMEOUT_MS
        ],
      );
      assert.strictEqual(payload.outputBytesCap, CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES + 128);
    }
    const policies = harness.requests.map((payload) => payload.sandboxPolicy);
    assert.deepStrictEqual(policies, [
      { type: "readOnly", networkAccess: false },
      { type: "readOnly", networkAccess: false },
      { type: "workspaceWrite", writableRoots: [COMMON], networkAccess: false },
      { type: "readOnly", networkAccess: false },
      { type: "workspaceWrite", writableRoots: [ROOT, COMMON], networkAccess: false },
      { type: "workspaceWrite", writableRoots: [COMMON], networkAccess: false },
      { type: "readOnly", networkAccess: false },
    ]);
  }),
);

it.effect("deduplicates restore writable roots from the helper-owned binding", () =>
  Effect.gen(function* () {
    const oneRootBinding = {
      ...BINDING,
      gitDirectoryRoot: { ...BINDING.gitDirectoryRoot, canonicalPath: ROOT },
      gitCommonDirectoryRoot: { ...BINDING.gitCommonDirectoryRoot, canonicalPath: ROOT },
    };
    const harness = makeConnection((payload, request) =>
      Effect.succeed(
        request.operation === "open"
          ? success({ operation: "open", binding: oneRootBinding, headOid: OID })
          : request.operation === "restore"
            ? success({
                operation: "restore",
                receipt: {
                  operation: "restore",
                  operationId: request.operationId,
                  receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${request.operationId}`,
                  requestSha256: requestDigest(request),
                  repositoryFingerprint: FINGERPRINT,
                  status: "succeeded",
                  checkpointId: request.checkpointId,
                  checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${request.checkpointId}`,
                  checkpointOid: OID,
                },
                receiptObjectOid: RECEIPT_OID,
              })
            : defaultResponse(request),
      ),
    );
    const adapter = makeAdapter();
    const borrowed = makeBorrow(harness.connection);
    const probe = yield* adapter.probe(borrowed, ROOT);
    const capability = yield* adapter.open(
      borrowed,
      { rootPath: ROOT, commonDirectoryPath: ROOT },
      probe,
    );
    const prepared = yield* capability.prepareRestore({
      operationId: OPERATION_ID,
      checkpointId: CHECKPOINT_ID,
      expectedCheckpointOid: OID,
    });
    yield* prepared.execute;
    assert.deepStrictEqual(harness.requests[2]?.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: [ROOT],
      networkAccess: false,
    });
  }),
);

it.effect("rejects instance, path, binding, and generation mismatches without replay", () =>
  Effect.gen(function* () {
    const wrongInstance = makeConnection(
      (_payload, request) => Effect.succeed(defaultResponse(request)),
      OTHER_INSTANCE_ID,
    );
    const instanceError = yield* Effect.flip(
      makeAdapter().probe(makeBorrow(wrongInstance.connection), ROOT),
    );
    assert.strictEqual(instanceError._tag, "ProviderVcsProtocolError");
    assert.strictEqual(wrongInstance.requests.length, 0);

    const mismatched = makeConnection((_payload, request) =>
      Effect.succeed(
        request.operation === "open"
          ? success({
              operation: "open",
              binding: {
                ...BINDING,
                worktreeRoot: { ...BINDING.worktreeRoot, canonicalPath: "/other" },
              },
              headOid: OID,
            })
          : defaultResponse(request),
      ),
    );
    const mismatchedBorrow = makeBorrow(mismatched.connection);
    const probe = yield* makeAdapter().probe(mismatchedBorrow, ROOT);
    const bindingError = yield* Effect.flip(
      makeAdapter().open(mismatchedBorrow, { rootPath: ROOT, commonDirectoryPath: COMMON }, probe),
    );
    assert.strictEqual(bindingError._tag, "ProviderVcsProtocolError");

    let preBarriers = 0;
    const preStale = makeConnection((_payload, request) =>
      Effect.succeed(defaultResponse(request)),
    );
    const preBorrowed = makeBorrow(preStale.connection, () => {
      preBarriers += 1;
      return preBarriers === 7
        ? Effect.fail(new CodexEndpointBorrowUnavailableError({ providerInstanceId: INSTANCE_ID }))
        : Effect.void;
    });
    const preCapability = yield* openCapability(makeAdapter(), preBorrowed);
    const preError = yield* Effect.flip(
      preCapability
        .prepareRestore({
          operationId: OPERATION_ID,
          checkpointId: CHECKPOINT_ID,
          expectedCheckpointOid: OID,
        })
        .pipe(Effect.flatMap((prepared) => prepared.execute)),
    );
    assert.strictEqual(preError._tag, "ProviderVcsDisconnectedError");
    assert.strictEqual(preStale.requests.length, 2);

    let barriers = 0;
    const stale = makeConnection((_payload, request) => Effect.succeed(defaultResponse(request)));
    const borrowed = makeBorrow(stale.connection, () => {
      barriers += 1;
      return barriers === 9
        ? Effect.fail(new CodexEndpointBorrowUnavailableError({ providerInstanceId: INSTANCE_ID }))
        : Effect.void;
    });
    const capability = yield* openCapability(makeAdapter(), borrowed);
    const staleError = yield* Effect.flip(
      capability
        .prepareRestore({
          operationId: OPERATION_ID,
          checkpointId: CHECKPOINT_ID,
          expectedCheckpointOid: OID,
        })
        .pipe(Effect.flatMap((prepared) => prepared.execute)),
    );
    assert.strictEqual(staleError._tag, "ProviderVcsCheckpointOutcomeUnknownError");
    assert.strictEqual(stale.requests.length, 3);
  }),
);

it.effect("strictly rejects malformed frames and sanitizes helper and transport errors", () =>
  Effect.gen(function* () {
    const malformedCases: ReadonlyArray<CommandExecResponse> = [
      { exitCode: 0, stderr: "", stdout: "CCH1 2 " + "0".repeat(64) + "\n{}" },
      { exitCode: 0, stderr: "", stdout: "CCH1 99 " + "0".repeat(64) + "\n{}" },
      {
        exitCode: 0,
        stderr: "SECRET stderr /srv/private",
        stdout: encodeCodexCheckpointHelperFrame({
          protocol: "cocoa.checkpoint.v1",
          ok: true,
          result: { operation: "observe", status: "not_found" },
        }),
      },
    ];
    for (const malformed of malformedCases) {
      let calls = 0;
      const harness = makeConnection((_payload, request) => {
        calls += 1;
        return Effect.succeed(calls <= 2 ? defaultResponse(request) : malformed);
      });
      const capability = yield* openCapability(makeAdapter(), makeBorrow(harness.connection));
      const error = yield* Effect.flip(
        capability.observe({ operationId: OPERATION_ID, expectedRequestSha256: REQUEST_DIGEST }),
      );
      assert.strictEqual(error._tag, "ProviderVcsProtocolError");
      assert.notInclude(error.message, "SECRET");
      assert.notInclude(error.message, "/srv/private");
    }

    let calls = 0;
    const helperSecret = makeConnection((_payload, request) => {
      calls += 1;
      return Effect.succeed(
        calls <= 2 ? defaultResponse(request) : helperFailure("repository_busy"),
      );
    });
    const capability = yield* openCapability(makeAdapter(), makeBorrow(helperSecret.connection));
    const helperError = yield* Effect.flip(
      capability
        .prepareCapture({ operationId: OPERATION_ID, checkpointId: CHECKPOINT_ID })
        .pipe(Effect.flatMap((prepared) => prepared.execute)),
    );
    assert.strictEqual(helperError._tag, "ProviderVcsOperationError");
    assert.notInclude(helperError.message, "SECRET");

    const transportSecret = makeConnection((_payload, request) =>
      request.operation === "restore"
        ? Effect.fail(
            new CodexErrors.CodexAppServerTransportError({
              operation: "read-input-stream",
              cause: new Error("SECRET endpoint /srv/private"),
            }),
          )
        : Effect.succeed(defaultResponse(request)),
    );
    const restoreCapability = yield* openCapability(
      makeAdapter(),
      makeBorrow(transportSecret.connection),
    );
    const restoreError = yield* Effect.flip(
      restoreCapability
        .prepareRestore({
          operationId: OPERATION_ID,
          checkpointId: CHECKPOINT_ID,
          expectedCheckpointOid: OID,
        })
        .pipe(Effect.flatMap((prepared) => prepared.execute)),
    );
    assert.strictEqual(restoreError._tag, "ProviderVcsCheckpointOutcomeUnknownError");
    assert.notInclude(restoreError.message, "SECRET");

    const ambiguousResults: ReadonlyArray<CommandExecResponse> = [
      { exitCode: 1, stdout: "SECRET stdout", stderr: "SECRET stderr" },
      { exitCode: 127, stdout: "SECRET stdout", stderr: "SECRET stderr" },
      {
        exitCode: 0,
        stdout: encodeCodexCheckpointHelperFrame({
          protocol: "cocoa.checkpoint.v1",
          ok: true,
          result: { operation: "observe", status: "not_found" },
        }),
        stderr: "SECRET stderr",
      },
      {
        exitCode: 0,
        stdout: encodeCodexCheckpointHelperFrame({
          protocol: "cocoa.checkpoint.v1",
          ok: true,
          result: { operation: "observe", status: "not_found" },
        }),
        stderr: "",
      },
      success({
        operation: "capture",
        receipt: {
          operation: "capture",
          operationId: OPERATION_ID,
          receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${OPERATION_ID}`,
          requestSha256: REQUEST_DIGEST,
          repositoryFingerprint: FINGERPRINT,
          status: "succeeded",
          checkpointId: CHECKPOINT_ID,
          checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${CHECKPOINT_ID}`,
          checkpointOid: OID,
          treeOid: TREE_OID,
        },
        receiptObjectOid: RECEIPT_OID,
      }),
      { exitCode: 0, stdout: "CCH1 2 " + "0".repeat(64) + "\n{}", stderr: "" },
    ];
    for (const ambiguous of ambiguousResults) {
      let ambiguousCalls = 0;
      const ambiguousHarness = makeConnection((_payload, request) => {
        ambiguousCalls += 1;
        return Effect.succeed(ambiguousCalls <= 2 ? defaultResponse(request) : ambiguous);
      });
      const ambiguousCapability = yield* openCapability(
        makeAdapter(),
        makeBorrow(ambiguousHarness.connection),
      );
      const error = yield* Effect.flip(
        ambiguousCapability
          .prepareCapture({ operationId: OPERATION_ID, checkpointId: CHECKPOINT_ID })
          .pipe(Effect.flatMap((prepared) => prepared.execute)),
      );
      assert.strictEqual(error._tag, "ProviderVcsCheckpointOutcomeUnknownError");
      assert.strictEqual(ambiguousHarness.requests.length, 3);
      assert.notInclude(error.message, "SECRET");
    }

    let explicitCalls = 0;
    const explicitRestoreFailure = makeConnection((_payload, request) => {
      explicitCalls += 1;
      return Effect.succeed(
        explicitCalls <= 2 ? defaultResponse(request) : helperFailure("operation_failed"),
      );
    });
    const explicitCapability = yield* openCapability(
      makeAdapter(),
      makeBorrow(explicitRestoreFailure.connection),
    );
    const explicitError = yield* Effect.flip(
      explicitCapability
        .prepareRestore({
          operationId: OPERATION_ID,
          checkpointId: CHECKPOINT_ID,
          expectedCheckpointOid: OID,
        })
        .pipe(Effect.flatMap((prepared) => prepared.execute)),
    );
    assert.strictEqual(explicitError._tag, "ProviderVcsCheckpointRestoreIndeterminateError");

    const missingMethod = makeConnection((_payload, request) =>
      request.operation === "capture"
        ? Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound("command/exec"))
        : Effect.succeed(defaultResponse(request)),
    );
    const missingMethodCapability = yield* openCapability(
      makeAdapter(),
      makeBorrow(missingMethod.connection),
    );
    const unsupportedError = yield* Effect.flip(
      missingMethodCapability
        .prepareCapture({ operationId: OPERATION_ID, checkpointId: CHECKPOINT_ID })
        .pipe(Effect.flatMap((prepared) => prepared.execute)),
    );
    assert.strictEqual(unsupportedError._tag, "ProviderVcsUnsupportedError");
  }),
);

it.effect("maps every closed helper error code without propagating helper messages", () =>
  Effect.gen(function* () {
    const expected = {
      unsupported_protocol: "ProviderVcsUnsupportedError",
      unsupported_operation: "ProviderVcsUnsupportedError",
      invalid_request: "ProviderVcsProtocolError",
      invalid_git_executable: "ProviderVcsUnsupportedError",
      not_a_repository: "ProviderVcsPathError",
      unsupported_object_format: "ProviderVcsUnsupportedError",
      binding_changed: "ProviderVcsOperationError",
      checkpoint_exists: "ProviderVcsOperationError",
      checkpoint_not_found: "ProviderVcsOperationError",
      checkpoint_oid_mismatch: "ProviderVcsOperationError",
      repository_busy: "ProviderVcsOperationError",
      operation_id_conflict: "ProviderVcsOperationError",
      request_too_large: "ProviderVcsProtocolError",
      response_too_large: "ProviderVcsProtocolError",
      operation_failed: "ProviderVcsOperationError",
    } as const satisfies Record<CodexCheckpointHelperErrorCode, string>;

    for (const [code, tag] of Object.entries(expected) as ReadonlyArray<
      [CodexCheckpointHelperErrorCode, string]
    >) {
      let calls = 0;
      const harness = makeConnection((_payload, request) => {
        calls += 1;
        return Effect.succeed(calls <= 2 ? defaultResponse(request) : helperFailure(code));
      });
      const capability = yield* openCapability(makeAdapter(), makeBorrow(harness.connection));
      const error = yield* Effect.flip(
        capability
          .prepareCapture({ operationId: OPERATION_ID, checkpointId: CHECKPOINT_ID })
          .pipe(Effect.flatMap((prepared) => prepared.execute)),
      );
      assert.strictEqual(error._tag, tag, code);
      assert.notInclude(error.message, "SECRET", code);
      assert.notInclude(error.message, "/srv/private", code);
    }

    assert.deepStrictEqual(
      decodeCodexCheckpointHelperFrame(
        defaultResponse({
          protocol: "cocoa.checkpoint.v1",
          operation: "observe",
          gitExecutablePath: GIT,
          expectedBinding: BINDING,
          operationId: OPERATION_ID,
          expectedRequestSha256: REQUEST_DIGEST,
        }).stdout,
      ),
      {
        protocol: "cocoa.checkpoint.v1",
        ok: true,
        result: { operation: "observe", status: "not_found" },
      },
    );
  }),
);
