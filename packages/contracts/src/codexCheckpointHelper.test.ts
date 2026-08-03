import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX,
  CODEX_CHECKPOINT_HELPER_MAX_DELETE_CHECKPOINTS,
  CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
  CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
  CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
  CODEX_CHECKPOINT_HELPER_PROTOCOL,
  CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX,
  CodexCheckpointHelperConfig,
  CodexCheckpointHelperMutationReceipt,
  CodexCheckpointHelperRequest,
  CodexCheckpointHelperResponse,
} from "./codexCheckpointHelper.ts";
import { CodexSettings, ServerSettingsPatch } from "./settings.ts";

const decodeRequest = Schema.decodeUnknownSync(CodexCheckpointHelperRequest);
const decodeResponse = Schema.decodeUnknownSync(CodexCheckpointHelperResponse);
const decodeReceipt = Schema.decodeUnknownSync(CodexCheckpointHelperMutationReceipt);
const decodeConfig = Schema.decodeUnknownSync(CodexCheckpointHelperConfig);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

const GIT = "/run/current-system/sw/bin/git";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const CHECKPOINT_ID = "22222222-2222-4222-a222-222222222222";
const SECOND_CHECKPOINT_ID = "33333333-3333-4333-b333-333333333333";
const REQUEST_SHA256 = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);
const OID = "c".repeat(40);
const SECOND_OID = "d".repeat(40);
const TREE_OID = "e".repeat(40);
const RECEIPT_OID = "f".repeat(40);

const BINDING = {
  worktreeRoot: {
    canonicalPath: "/Users/ada/Developer/cocoa",
    device: "16777234",
    inode: "101",
  },
  gitDirectoryRoot: {
    canonicalPath: "/Users/ada/Developer/cocoa/.git/worktrees/phase-7",
    device: "16777234",
    inode: "102",
  },
  gitCommonDirectoryRoot: {
    canonicalPath: "/Users/ada/Developer/cocoa/.git",
    device: "16777234",
    inode: "103",
  },
  objectFormat: "sha1",
  fingerprint: FINGERPRINT,
} as const;

const COMMON_REQUEST = {
  protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
  gitExecutablePath: GIT,
} as const;

describe("CodexCheckpointHelperConfig", () => {
  it("decodes only the fixed v1 executable helper", () => {
    expect(
      decodeConfig({
        type: "cocoa-checkpoint-helper-v1",
        executablePath: "/run/current-system/sw/bin/cocoa-checkpoint-helper",
        expectedProtocol: 1,
      }),
    ).toEqual({
      type: "cocoa-checkpoint-helper-v1",
      executablePath: "/run/current-system/sw/bin/cocoa-checkpoint-helper",
      expectedProtocol: 1,
    });
  });

  it.each([
    "cocoa-checkpoint-helper",
    "./cocoa-checkpoint-helper",
    "",
    "/",
    "/opt//cocoa-checkpoint-helper",
    "/opt/../cocoa-checkpoint-helper",
    "/opt/cocoa-checkpoint-helper/",
    "/opt/cocoa-checkpoint-helper\0evil",
  ])("rejects unsafe helper executable path %j", (executablePath) => {
    expect(() =>
      decodeConfig({
        type: "cocoa-checkpoint-helper-v1",
        executablePath,
        expectedProtocol: 1,
      }),
    ).toThrow();
  });

  it("requires the exact helper type and protocol without arbitrary command fields", () => {
    expect(() =>
      decodeConfig({
        type: "cocoa-checkpoint-helper-v1",
        executablePath: "/opt/cocoa-checkpoint-helper",
      }),
    ).toThrow();
    expect(() =>
      decodeConfig({
        type: "cocoa-checkpoint-helper-v1",
        executablePath: "/opt/cocoa-checkpoint-helper",
        expectedProtocol: 2,
      }),
    ).toThrow();
    expect(() =>
      decodeConfig({
        type: "custom-helper",
        executablePath: "/opt/cocoa-checkpoint-helper",
        expectedProtocol: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeConfig({
        type: "cocoa-checkpoint-helper-v1",
        executablePath: "/opt/cocoa-checkpoint-helper",
        expectedProtocol: 1,
        command: ["sh", "-c", "unsafe"],
      }),
    ).toThrow(/command/);
  });

  it("round-trips through Codex settings and settings patches without adding a default", () => {
    const checkpointHelper = {
      type: "cocoa-checkpoint-helper-v1" as const,
      executablePath: "/run/current-system/sw/bin/cocoa-checkpoint-helper",
      expectedProtocol: 1 as const,
    };

    expect(decodeCodexSettings({}).checkpointHelper).toBeUndefined();
    expect(decodeCodexSettings({ checkpointHelper }).checkpointHelper).toEqual(checkpointHelper);
    expect(
      decodeServerSettingsPatch({ providers: { codex: { checkpointHelper } } }).providers?.codex
        ?.checkpointHelper,
    ).toEqual(checkpointHelper);
  });
});

const CAPTURE_RECEIPT = {
  operation: "capture",
  operationId: OPERATION_ID,
  receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${OPERATION_ID}`,
  requestSha256: REQUEST_SHA256,
  repositoryFingerprint: FINGERPRINT,
  status: "succeeded",
  checkpointId: CHECKPOINT_ID,
  checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${CHECKPOINT_ID}`,
  checkpointOid: OID,
  treeOid: TREE_OID,
} as const;

const RESTORE_RECEIPT = {
  operation: "restore",
  operationId: OPERATION_ID,
  receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${OPERATION_ID}`,
  requestSha256: REQUEST_SHA256,
  repositoryFingerprint: FINGERPRINT,
  status: "succeeded",
  checkpointId: CHECKPOINT_ID,
  checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${CHECKPOINT_ID}`,
  checkpointOid: OID,
} as const;

const DELETE_RECEIPT = {
  operation: "delete",
  operationId: OPERATION_ID,
  receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${OPERATION_ID}`,
  requestSha256: REQUEST_SHA256,
  repositoryFingerprint: FINGERPRINT,
  status: "succeeded",
  checkpoints: [
    {
      checkpointId: CHECKPOINT_ID,
      checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${CHECKPOINT_ID}`,
      status: "deleted",
      deletedCheckpointOid: OID,
    },
    {
      checkpointId: SECOND_CHECKPOINT_ID,
      checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${SECOND_CHECKPOINT_ID}`,
      status: "already_absent",
    },
  ],
} as const;

const REQUESTS = [
  { ...COMMON_REQUEST, operation: "probe" },
  { ...COMMON_REQUEST, operation: "open", workspaceRoot: "/Users/ada/Developer/cocoa" },
  {
    ...COMMON_REQUEST,
    operation: "capture",
    operationId: OPERATION_ID,
    checkpointId: CHECKPOINT_ID,
    expectedBinding: BINDING,
  },
  {
    ...COMMON_REQUEST,
    operation: "diff",
    baseCheckpointId: CHECKPOINT_ID,
    targetCheckpointId: SECOND_CHECKPOINT_ID,
    expectedBinding: BINDING,
    ignoreWhitespace: false,
    limits: { maxPatchBytes: CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES },
  },
  {
    ...COMMON_REQUEST,
    operation: "restore",
    operationId: OPERATION_ID,
    checkpointId: CHECKPOINT_ID,
    expectedCheckpointOid: OID,
    expectedBinding: BINDING,
  },
  {
    ...COMMON_REQUEST,
    operation: "delete",
    operationId: OPERATION_ID,
    checkpoints: [{ checkpointId: CHECKPOINT_ID, expectedCheckpointOid: OID }],
    expectedBinding: BINDING,
  },
  {
    ...COMMON_REQUEST,
    operation: "observe",
    operationId: OPERATION_ID,
    expectedRequestSha256: REQUEST_SHA256,
    expectedBinding: BINDING,
  },
] as const;

const success = (result: unknown) => ({
  protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
  ok: true,
  result,
});

describe("CodexCheckpointHelper CCH1 requests", () => {
  it("decodes every strict operation variant", () => {
    expect(REQUESTS.map((request) => decodeRequest(request).operation)).toEqual([
      "probe",
      "open",
      "capture",
      "diff",
      "restore",
      "delete",
      "observe",
    ]);
  });

  it("requires the separate protocol discriminator and configured Git path on every variant", () => {
    for (const request of REQUESTS) {
      expect(() => decodeRequest({ ...request, protocol: 1 })).toThrow();
      const { gitExecutablePath: _, ...withoutGit } = request;
      expect(() => decodeRequest(withoutGit)).toThrow();
    }
  });

  it.each([
    "git",
    "./git",
    "",
    "/usr/bin/../bin/git",
    "/usr//bin/git",
    "/usr/bin/git/",
    "/usr\\bin\\git",
    "/usr/bin/git\0--upload-pack",
    "/",
  ])("rejects unsafe configured Git path %j", (gitExecutablePath) => {
    expect(() =>
      decodeRequest({ ...COMMON_REQUEST, operation: "probe", gitExecutablePath }),
    ).toThrow();
  });

  it.each([
    "workspace",
    "/workspace/../secret",
    "/workspace//nested",
    "/workspace/",
    "/workspace\\nested",
    "/workspace\0evil",
  ])("rejects unsafe workspace path %j", (workspaceRoot) => {
    expect(() => decodeRequest({ ...COMMON_REQUEST, operation: "open", workspaceRoot })).toThrow();
  });

  it.each([
    "",
    "not-a-uuid",
    "00000000-0000-0000-0000-000000000000",
    "11111111-1111-0111-8111-111111111111",
    "11111111-1111-4111-7111-111111111111",
    "11111111-1111-4111-8111-11111111111Z",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(),
  ])("rejects hostile operation UUID %j", (operationId) => {
    expect(() => decodeRequest({ ...REQUESTS[2], operationId })).toThrow();
  });

  it.each([
    "",
    "checkpoint",
    "00000000-0000-0000-0000-000000000000",
    CHECKPOINT_ID.toUpperCase(),
    `${CHECKPOINT_ID}^`,
  ])("rejects hostile checkpoint UUID %j", (checkpointId) => {
    expect(() => decodeRequest({ ...REQUESTS[2], checkpointId })).toThrow();
  });

  it("rejects arbitrary refs, argv, mutation options, and excess fields on every request", () => {
    for (const request of REQUESTS) {
      expect(() => decodeRequest({ ...request, excess: true })).toThrow(/excess/);
    }
    expect(() => decodeRequest({ ...REQUESTS[2], ref: "refs/heads/main" })).toThrow(/ref/);
    expect(() => decodeRequest({ ...REQUESTS[4], force: true })).toThrow(/force/);
    expect(() => decodeRequest({ ...REQUESTS[5], options: { prune: true } })).toThrow(/options/);
    expect(() => decodeRequest({ ...REQUESTS[0], argv: ["git", "status"] })).toThrow(/argv/);
  });

  it("rejects excess fields in all security-sensitive nested structures", () => {
    expect(() =>
      decodeRequest({
        ...REQUESTS[2],
        expectedBinding: { ...BINDING, workspaceRoot: "/tmp" },
      }),
    ).toThrow(/workspaceRoot/);
    expect(() =>
      decodeRequest({
        ...REQUESTS[2],
        expectedBinding: {
          ...BINDING,
          worktreeRoot: { ...BINDING.worktreeRoot, mode: "write" },
        },
      }),
    ).toThrow(/mode/);
    expect(() =>
      decodeRequest({ ...REQUESTS[3], limits: { maxPatchBytes: 1, contextLines: 3 } }),
    ).toThrow(/contextLines/);
    expect(() =>
      decodeRequest({
        ...REQUESTS[5],
        checkpoints: [{ checkpointId: CHECKPOINT_ID, expectedCheckpointOid: OID, ref: "x" }],
      }),
    ).toThrow(/ref/);
  });

  it("enforces diff and atomic delete bounds", () => {
    expect(() => decodeRequest({ ...REQUESTS[3], limits: { maxPatchBytes: 0 } })).toThrow();
    expect(() =>
      decodeRequest({
        ...REQUESTS[3],
        limits: { maxPatchBytes: CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES + 1 },
      }),
    ).toThrow();
    expect(() => decodeRequest({ ...REQUESTS[5], checkpoints: [] })).toThrow();
    expect(() =>
      decodeRequest({
        ...REQUESTS[5],
        checkpoints: Array.from(
          { length: CODEX_CHECKPOINT_HELPER_MAX_DELETE_CHECKPOINTS + 1 },
          (_, index) => ({
            checkpointId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            expectedCheckpointOid: OID,
          }),
        ),
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        ...REQUESTS[5],
        checkpoints: [
          { checkpointId: CHECKPOINT_ID, expectedCheckpointOid: OID },
          { checkpointId: CHECKPOINT_ID, expectedCheckpointOid: SECOND_OID },
        ],
      }),
    ).toThrow(/repeat/);
  });

  it("rejects malformed binding identities, fingerprints, and CAS OIDs", () => {
    expect(() =>
      decodeRequest({
        ...REQUESTS[2],
        expectedBinding: {
          ...BINDING,
          gitCommonDirectoryRoot: { ...BINDING.gitCommonDirectoryRoot, inode: "-1" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        ...REQUESTS[2],
        expectedBinding: { ...BINDING, fingerprint: "A".repeat(64) },
      }),
    ).toThrow();
    for (const expectedCheckpointOid of ["abc", `g${OID.slice(1)}`, OID.toUpperCase()]) {
      expect(() => decodeRequest({ ...REQUESTS[4], expectedCheckpointOid })).toThrow();
    }
  });
});

describe("CodexCheckpointHelper CCH1 receipts and responses", () => {
  it("decodes every committed-success receipt variant", () => {
    expect(decodeReceipt(CAPTURE_RECEIPT).operation).toBe("capture");
    expect(decodeReceipt(RESTORE_RECEIPT).operation).toBe("restore");
    expect(decodeReceipt(DELETE_RECEIPT).operation).toBe("delete");
  });

  it("decodes every success result and both observe variants", () => {
    const results = [
      {
        operation: "probe",
        implementation: "cocoa-checkpoint-helper",
        buildId: "test-build",
        gitExecutablePath: GIT,
        capabilities: ["probe", "open", "capture", "diff", "restore", "delete", "observe"],
        objectFormats: ["sha1", "sha256"],
        limits: {
          maxRequestBytes: CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
          maxPatchBytes: CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
          maxResponseBytes: CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
        },
      },
      { operation: "open", binding: BINDING, headOid: null },
      { operation: "capture", receipt: CAPTURE_RECEIPT, receiptObjectOid: RECEIPT_OID },
      {
        operation: "diff",
        baseCheckpointId: CHECKPOINT_ID,
        targetCheckpointId: SECOND_CHECKPOINT_ID,
        baseOid: OID,
        targetOid: SECOND_OID,
        patchBase64: "ZGlmZg==",
        byteLength: 4,
        truncated: false,
      },
      { operation: "restore", receipt: RESTORE_RECEIPT, receiptObjectOid: RECEIPT_OID },
      { operation: "delete", receipt: DELETE_RECEIPT, receiptObjectOid: RECEIPT_OID },
      { operation: "observe", status: "not_found" },
      {
        operation: "observe",
        status: "found",
        receipt: DELETE_RECEIPT,
        receiptObjectOid: RECEIPT_OID,
      },
    ];

    expect(
      results.map((result) => {
        const response = decodeResponse(success(result));
        if (!response.ok) throw new Error("Expected success response.");
        return response.result.operation;
      }),
    ).toEqual(["probe", "open", "capture", "diff", "restore", "delete", "observe", "observe"]);
  });

  it("decodes every closed helper error code", () => {
    const codes = [
      "unsupported_protocol",
      "unsupported_operation",
      "invalid_request",
      "invalid_git_executable",
      "not_a_repository",
      "unsupported_object_format",
      "binding_changed",
      "checkpoint_exists",
      "checkpoint_not_found",
      "checkpoint_oid_mismatch",
      "repository_busy",
      "operation_id_conflict",
      "request_too_large",
      "response_too_large",
      "operation_failed",
    ];

    for (const code of codes) {
      expect(
        decodeResponse({
          protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
          ok: false,
          error: { code, message: "Sanitized helper failure.", retryable: false },
        }).ok,
      ).toBe(false);
    }
  });

  it("keeps receipt object identity outside the persisted receipt", () => {
    expect(() => decodeReceipt({ ...CAPTURE_RECEIPT, receiptObjectOid: RECEIPT_OID })).toThrow(
      /receiptObjectOid/,
    );
    expect(
      decodeResponse(
        success({ operation: "capture", receipt: CAPTURE_RECEIPT, receiptObjectOid: RECEIPT_OID }),
      ),
    ).toMatchObject({ result: { receiptObjectOid: RECEIPT_OID } });
  });

  it("requires helper-derived checkpoint and receipt ref namespaces and matching IDs", () => {
    expect(() => decodeReceipt({ ...CAPTURE_RECEIPT, checkpointRef: "refs/heads/main" })).toThrow();
    expect(() =>
      decodeReceipt({
        ...CAPTURE_RECEIPT,
        checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${SECOND_CHECKPOINT_ID}`,
      }),
    ).toThrow(/derived/);
    expect(() =>
      decodeReceipt({
        ...CAPTURE_RECEIPT,
        receiptRef: `${CODEX_CHECKPOINT_HELPER_RECEIPT_REF_PREFIX}${SECOND_CHECKPOINT_ID}`,
      }),
    ).toThrow(/derived/);
    expect(() =>
      decodeReceipt({
        ...CAPTURE_RECEIPT,
        checkpointRef: `refs/cocoa/checkpoints/${CHECKPOINT_ID}`,
      }),
    ).toThrow();
  });

  it("does not admit failed or pending mutation receipts", () => {
    expect(() =>
      decodeReceipt({
        ...RESTORE_RECEIPT,
        status: "failed",
        error: { code: "operation_failed", message: "failed", retryable: false },
      }),
    ).toThrow();
    expect(() => decodeReceipt({ ...CAPTURE_RECEIPT, status: "pending" })).toThrow();
  });

  it("strictly validates deleted and already-absent receipt entries", () => {
    expect(() =>
      decodeReceipt({
        ...DELETE_RECEIPT,
        checkpoints: [
          {
            checkpointId: CHECKPOINT_ID,
            checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${CHECKPOINT_ID}`,
            status: "deleted",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeReceipt({
        ...DELETE_RECEIPT,
        checkpoints: [
          {
            checkpointId: CHECKPOINT_ID,
            checkpointRef: `${CODEX_CHECKPOINT_HELPER_CHECKPOINT_REF_PREFIX}${CHECKPOINT_ID}`,
            status: "already_absent",
            deletedCheckpointOid: OID,
          },
        ],
      }),
    ).toThrow(/deletedCheckpointOid/);
  });

  it("enforces strict response nesting and bounded probe arrays", () => {
    expect(() =>
      decodeResponse({
        ...success({ operation: "observe", status: "not_found" }),
        command: "git",
      }),
    ).toThrow(/command/);
    expect(() =>
      decodeResponse(success({ operation: "observe", status: "not_found", extra: true })),
    ).toThrow(/extra/);
    expect(() =>
      decodeResponse({
        protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
        ok: false,
        error: { code: "operation_failed", message: "failed", retryable: false, stderr: "x" },
      }),
    ).toThrow(/stderr/);

    const probe = {
      operation: "probe",
      implementation: "helper",
      gitExecutablePath: GIT,
      capabilities: ["probe"],
      objectFormats: ["sha1"],
      limits: {
        maxRequestBytes: CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
        maxPatchBytes: CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
        maxResponseBytes: CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
      },
    };
    expect(() => decodeResponse(success({ ...probe, capabilities: ["probe", "probe"] }))).toThrow(
      /duplicates/,
    );
    expect(() => decodeResponse(success({ ...probe, objectFormats: ["sha1", "sha1"] }))).toThrow(
      /duplicates/,
    );
    expect(() => decodeResponse(success({ ...probe, objectFormats: [] }))).toThrow();
  });

  it("validates full lowercase OIDs and exact diff base64 byte lengths", () => {
    expect(() =>
      decodeResponse(success({ operation: "open", binding: BINDING, headOid: "abc123" })),
    ).toThrow();
    expect(() =>
      decodeResponse(success({ operation: "open", binding: BINDING, headOid: OID.toUpperCase() })),
    ).toThrow();
    expect(() =>
      decodeResponse(
        success({
          operation: "diff",
          baseCheckpointId: CHECKPOINT_ID,
          targetCheckpointId: SECOND_CHECKPOINT_ID,
          baseOid: OID,
          targetOid: SECOND_OID,
          patchBase64: "not base64!",
          byteLength: 11,
          truncated: false,
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeResponse(
        success({
          operation: "diff",
          baseCheckpointId: CHECKPOINT_ID,
          targetCheckpointId: SECOND_CHECKPOINT_ID,
          baseOid: OID,
          targetOid: SECOND_OID,
          patchBase64: "ZGlmZg==",
          byteLength: 3,
          truncated: false,
        }),
      ),
    ).toThrow(/byteLength/);

    const encodesMoreThanPatchLimit = "A".repeat(
      Math.ceil(CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES / 3) * 4,
    );
    expect(() =>
      decodeResponse(
        success({
          operation: "diff",
          baseCheckpointId: CHECKPOINT_ID,
          targetCheckpointId: SECOND_CHECKPOINT_ID,
          baseOid: OID,
          targetOid: SECOND_OID,
          patchBase64: encodesMoreThanPatchLimit,
          byteLength: CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
          truncated: true,
        }),
      ),
    ).toThrow();
  });
});
