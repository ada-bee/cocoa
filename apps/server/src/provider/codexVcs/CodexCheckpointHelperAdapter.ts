import * as NodeCrypto from "node:crypto";

import {
  CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
  CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
  CODEX_CHECKPOINT_HELPER_PROTOCOL,
  CodexCheckpointHelperRequest,
  CodexCheckpointHelperResponse,
  CodexCheckpointHelperSha256,
  type CodexCheckpointHelperConfig,
  type CodexCheckpointHelperErrorCode,
  type CodexCheckpointHelperProbeResult,
  type CodexCheckpointHelperRepositoryBinding,
  type CodexCheckpointHelperRequest as CodexCheckpointHelperRequestShape,
  type CodexCheckpointHelperResult,
  type CodexGitExecutablePath,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  type ProviderVcsCheckpointCapability,
  ProviderVcsCheckpointOutcomeUnknownError,
  ProviderVcsCheckpointRestoreIndeterminateError,
  ProviderVcsDisconnectedError,
  type ProviderVcsError,
  type ProviderVcsOperation,
  ProviderVcsOperationError,
  ProviderVcsPathError,
  ProviderVcsProtocolError,
  ProviderVcsUnsupportedError,
} from "../ProviderVcsAdapter.ts";
import type { CodexEndpointConnectionBorrow } from "../codexEndpoint/CodexEndpointSupervisor.ts";

const FRAME_HEADER_ALLOWANCE_BYTES = 128;
const COMMAND_OUTPUT_BYTES_CAP =
  CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES + FRAME_HEADER_ALLOWANCE_BYTES;
const OUTER_TIMEOUT_GRACE_MS = 1_000;

export const CODEX_CHECKPOINT_HELPER_COMMAND_TIMEOUT_MS = {
  probe: 5_000,
  open: 10_000,
  capture: 120_000,
  diff: 30_000,
  restore: 120_000,
  delete: 30_000,
  observe: 10_000,
} as const;

export const CODEX_CHECKPOINT_HELPER_COMMAND_ENV = {
  LANG: "C",
  LC_ALL: "C",
} as const;

const REQUIRED_CAPABILITIES = [
  "probe",
  "open",
  "capture",
  "diff",
  "restore",
  "delete",
  "observe",
] as const;

const decodeRequest = Schema.decodeUnknownEffect(CodexCheckpointHelperRequest);
const decodeResponse = Schema.decodeUnknownEffect(CodexCheckpointHelperResponse);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJsonSync = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const operationName = (
  operation: CodexCheckpointHelperRequestShape["operation"],
): ProviderVcsOperation => {
  switch (operation) {
    case "probe":
    case "open":
      return "openRepository";
    case "capture":
      return "captureCheckpoint";
    case "diff":
      return "diffCheckpoints";
    case "restore":
      return "restoreCheckpoint";
    case "delete":
      return "deleteCheckpoints";
    case "observe":
      return "observeCheckpointOperation";
  }
};

const disconnected = (providerInstanceId: ProviderInstanceId, operation: ProviderVcsOperation) =>
  new ProviderVcsDisconnectedError({ providerInstanceId, operation });

const unsupported = (providerInstanceId: ProviderInstanceId, operation: ProviderVcsOperation) =>
  new ProviderVcsUnsupportedError({ providerInstanceId, operation });

const protocol = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  detail: string,
) => new ProviderVcsProtocolError({ providerInstanceId, operation, detail });

const operationFailed = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  detail: string,
) => new ProviderVcsOperationError({ providerInstanceId, operation, detail });

const pathFailed = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  providerHostPath: string,
  issue: string,
) => new ProviderVcsPathError({ providerInstanceId, operation, providerHostPath, issue });

const restoreIndeterminate = (providerInstanceId: ProviderInstanceId) =>
  new ProviderVcsCheckpointRestoreIndeterminateError({
    providerInstanceId,
    operation: "restoreCheckpoint",
  });

const isMutationOperation = (
  operation: ProviderVcsOperation,
): operation is "captureCheckpoint" | "restoreCheckpoint" | "deleteCheckpoints" =>
  operation === "captureCheckpoint" ||
  operation === "restoreCheckpoint" ||
  operation === "deleteCheckpoints";

const outcomeUnknown = (
  providerInstanceId: ProviderInstanceId,
  operation: "captureCheckpoint" | "restoreCheckpoint" | "deleteCheckpoints",
) => new ProviderVcsCheckpointOutcomeUnknownError({ providerInstanceId, operation });

const isDisconnectedCodexError = (error: CodexErrors.CodexAppServerError): boolean =>
  error._tag === "CodexAppServerTransportError" ||
  error._tag === "CodexAppServerInputStreamEndedError" ||
  error._tag === "CodexAppServerProcessExitedError";

const mapCodexError = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  error: CodexErrors.CodexAppServerError,
): ProviderVcsError => {
  if (error._tag === "CodexAppServerRequestError" && error.code === -32601) {
    return unsupported(providerInstanceId, operation);
  }
  if (
    error._tag === "CodexAppServerRequestError" &&
    [-32700, -32600, -32602].includes(error.code)
  ) {
    return protocol(
      providerInstanceId,
      operation,
      "Codex rejected the checkpoint command protocol.",
    );
  }
  if (isMutationOperation(operation)) return outcomeUnknown(providerInstanceId, operation);
  if (isDisconnectedCodexError(error)) return disconnected(providerInstanceId, operation);
  if (error._tag === "CodexAppServerProtocolParseError") {
    return protocol(
      providerInstanceId,
      operation,
      "Codex rejected the checkpoint command protocol.",
    );
  }
  return operationFailed(
    providerInstanceId,
    operation,
    "Codex could not run the checkpoint helper.",
  );
};

const mapHelperError = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  providerHostPath: string,
  code: CodexCheckpointHelperErrorCode,
): ProviderVcsError => {
  switch (code) {
    case "unsupported_protocol":
    case "unsupported_operation":
    case "invalid_git_executable":
    case "unsupported_object_format":
      return unsupported(providerInstanceId, operation);
    case "invalid_request":
    case "request_too_large":
    case "response_too_large":
      return protocol(providerInstanceId, operation, `Checkpoint helper rejected ${code}.`);
    case "not_a_repository":
      return pathFailed(providerInstanceId, operation, providerHostPath, code);
    case "operation_failed":
      return operation === "restoreCheckpoint"
        ? restoreIndeterminate(providerInstanceId)
        : operationFailed(providerInstanceId, operation, "Checkpoint helper operation failed.");
    case "binding_changed":
    case "checkpoint_exists":
    case "checkpoint_not_found":
    case "checkpoint_oid_mismatch":
    case "repository_busy":
    case "operation_id_conflict":
      return operationFailed(providerInstanceId, operation, `Checkpoint helper reported ${code}.`);
  }
};

const encodeRequestArg = (requestJson: string): string =>
  Encoding.encodeBase64(new TextEncoder().encode(requestJson));

export function decodeCodexCheckpointHelperFrame(stdout: string): unknown {
  const newline = stdout.indexOf("\n");
  if (newline < 0 || newline > FRAME_HEADER_ALLOWANCE_BYTES) {
    throw new Error("invalid frame header");
  }
  const match = /^CCH1 ([1-9][0-9]*) ([a-f0-9]{64})$/.exec(stdout.slice(0, newline));
  if (match === null) throw new Error("invalid frame header");
  const declaredLength = Number(match[1]);
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength > CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES
  ) {
    throw new Error("invalid frame length");
  }
  const payload = stdout.slice(newline + 1);
  const payloadBytes = new TextEncoder().encode(payload);
  if (payloadBytes.byteLength !== declaredLength) throw new Error("frame length mismatch");
  const digest = NodeCrypto.createHash("sha256").update(payloadBytes).digest("hex");
  if (digest !== match[2]) throw new Error("frame checksum mismatch");
  return decodeJson(payload);
}

export function encodeCodexCheckpointHelperFrame(value: unknown): string {
  const payload = encodeJsonSync(value);
  const bytes = new TextEncoder().encode(payload);
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return `CCH1 ${bytes.byteLength} ${digest}\n${payload}`;
}

const isSameOrDescendant = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(`${parent}/`);

export interface CodexCheckpointRepositoryIdentity {
  readonly rootPath: string;
  readonly commonDirectoryPath: string;
}

export interface CodexCheckpointHelperAdapter {
  readonly probe: (
    borrowed: CodexEndpointConnectionBorrow,
    cwd: string,
  ) => Effect.Effect<CodexCheckpointHelperProbeResult, ProviderVcsError>;
  readonly open: (
    borrowed: CodexEndpointConnectionBorrow,
    identity: CodexCheckpointRepositoryIdentity,
    probe: CodexCheckpointHelperProbeResult,
  ) => Effect.Effect<ProviderVcsCheckpointCapability, ProviderVcsError>;
}

export interface MakeCodexCheckpointHelperAdapterOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly gitExecutablePath: CodexGitExecutablePath;
  readonly helper: CodexCheckpointHelperConfig;
}

interface PreparedCodexCheckpointInvocation {
  readonly request: CodexCheckpointHelperRequestShape;
  readonly requestJson: string;
  readonly requestSha256: CodexCheckpointHelperSha256;
}

export const makeCodexCheckpointHelperAdapter = (
  options: MakeCodexCheckpointHelperAdapterOptions,
): CodexCheckpointHelperAdapter => {
  const prepareInvocation = Effect.fn("CodexCheckpointHelperAdapter.prepareInvocation")(function* (
    borrowed: CodexEndpointConnectionBorrow,
    input: CodexCheckpointHelperRequestShape,
  ) {
    const operation = operationName(input.operation);
    if (borrowed.connection.identity.providerInstanceId !== options.providerInstanceId) {
      return yield* protocol(
        options.providerInstanceId,
        operation,
        "Checkpoint connection belonged to another provider instance.",
      );
    }
    const request = yield* decodeRequest(input).pipe(
      Effect.mapError(() =>
        protocol(options.providerInstanceId, operation, "Checkpoint helper request was invalid."),
      ),
    );
    const requestJson = yield* encodeJson(request).pipe(
      Effect.mapError(() =>
        protocol(options.providerInstanceId, operation, "Checkpoint helper request was invalid."),
      ),
    );
    const encodedBytes = new TextEncoder().encode(requestJson);
    if (encodedBytes.byteLength > CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES) {
      return yield* protocol(
        options.providerInstanceId,
        operation,
        "Checkpoint helper request exceeded its byte limit.",
      );
    }
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, operation)),
    );
    return {
      request,
      requestJson,
      requestSha256: CodexCheckpointHelperSha256.make(
        NodeCrypto.createHash("sha256").update(encodedBytes).digest("hex"),
      ),
    };
  });

  const executeInvocation = Effect.fn("CodexCheckpointHelperAdapter.executeInvocation")(function* (
    borrowed: CodexEndpointConnectionBorrow,
    cwd: string,
    prepared: PreparedCodexCheckpointInvocation,
    binding?: CodexCheckpointHelperRepositoryBinding,
  ): Effect.fn.Return<CodexCheckpointHelperResult, ProviderVcsError> {
    const { request, requestJson } = prepared;
    const operation = operationName(request.operation);
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, operation)),
    );
    const timeoutMs = CODEX_CHECKPOINT_HELPER_COMMAND_TIMEOUT_MS[request.operation];
    const writableRoots =
      binding === undefined
        ? undefined
        : request.operation === "restore"
          ? [
              ...new Set([
                binding.worktreeRoot.canonicalPath,
                binding.gitCommonDirectoryRoot.canonicalPath,
              ]),
            ]
          : request.operation === "capture" || request.operation === "delete"
            ? [binding.gitCommonDirectoryRoot.canonicalPath]
            : undefined;
    const sandboxPolicy =
      writableRoots === undefined
        ? ({ type: "readOnly", networkAccess: false } as const)
        : ({ type: "workspaceWrite", writableRoots, networkAccess: false } as const);
    const requestExit = yield* borrowed.connection.client
      .request("command/exec", {
        command: [options.helper.executablePath, encodeRequestArg(requestJson)],
        cwd,
        env: CODEX_CHECKPOINT_HELPER_COMMAND_ENV,
        sandboxPolicy,
        timeoutMs,
        outputBytesCap: COMMAND_OUTPUT_BYTES_CAP,
      })
      .pipe(Effect.timeout(`${timeoutMs + OUTER_TIMEOUT_GRACE_MS} millis`), Effect.result);
    if (requestExit._tag === "Failure") {
      if (Cause.isTimeoutError(requestExit.failure)) {
        return yield* isMutationOperation(operation)
          ? outcomeUnknown(options.providerInstanceId, operation)
          : operationFailed(options.providerInstanceId, operation, "Checkpoint helper timed out.");
      }
      const current = yield* borrowed.ensureCurrent.pipe(Effect.result);
      if (current._tag === "Failure") {
        return yield* isMutationOperation(operation)
          ? outcomeUnknown(options.providerInstanceId, operation)
          : disconnected(options.providerInstanceId, operation);
      }
      return yield* mapCodexError(
        options.providerInstanceId,
        operation,
        requestExit.failure as CodexErrors.CodexAppServerError,
      );
    }
    const current = yield* borrowed.ensureCurrent.pipe(Effect.result);
    if (current._tag === "Failure") {
      return yield* isMutationOperation(operation)
        ? outcomeUnknown(options.providerInstanceId, operation)
        : disconnected(options.providerInstanceId, operation);
    }
    const commandResult = requestExit.success;
    if (
      !isMutationOperation(operation) &&
      (commandResult.exitCode === 126 || commandResult.exitCode === 127)
    ) {
      return yield* unsupported(options.providerInstanceId, operation);
    }
    if (commandResult.exitCode !== 0) {
      return yield* isMutationOperation(operation)
        ? outcomeUnknown(options.providerInstanceId, operation)
        : operationFailed(
            options.providerInstanceId,
            operation,
            "Checkpoint helper exited unsuccessfully.",
          );
    }
    if (commandResult.stderr !== "") {
      return yield* isMutationOperation(operation)
        ? outcomeUnknown(options.providerInstanceId, operation)
        : protocol(
            options.providerInstanceId,
            operation,
            "Checkpoint helper emitted unexpected stderr.",
          );
    }
    const untrusted = yield* Effect.try(() =>
      decodeCodexCheckpointHelperFrame(commandResult.stdout),
    ).pipe(
      Effect.mapError(() =>
        isMutationOperation(operation)
          ? outcomeUnknown(options.providerInstanceId, operation)
          : protocol(options.providerInstanceId, operation, "Checkpoint helper frame was invalid."),
      ),
    );
    const response = yield* decodeResponse(untrusted).pipe(
      Effect.mapError(() =>
        isMutationOperation(operation)
          ? outcomeUnknown(options.providerInstanceId, operation)
          : protocol(
              options.providerInstanceId,
              operation,
              "Checkpoint helper response was invalid.",
            ),
      ),
    );
    if (!response.ok) {
      return yield* mapHelperError(options.providerInstanceId, operation, cwd, response.error.code);
    }
    if (response.result.operation !== request.operation) {
      return yield* isMutationOperation(operation)
        ? outcomeUnknown(options.providerInstanceId, operation)
        : protocol(
            options.providerInstanceId,
            operation,
            "Checkpoint helper returned the wrong operation.",
          );
    }
    if (
      response.result.operation === "capture" ||
      response.result.operation === "restore" ||
      response.result.operation === "delete"
    ) {
      const mutationOperation =
        response.result.operation === "capture"
          ? "captureCheckpoint"
          : response.result.operation === "restore"
            ? "restoreCheckpoint"
            : "deleteCheckpoints";
      if (
        !("operationId" in request) ||
        response.result.receipt.requestSha256 !== prepared.requestSha256 ||
        response.result.receipt.operationId !== request.operationId ||
        response.result.receipt.repositoryFingerprint !== binding?.fingerprint
      ) {
        return yield* outcomeUnknown(options.providerInstanceId, mutationOperation);
      }
    }
    return response.result;
  });

  const invoke = Effect.fn("CodexCheckpointHelperAdapter.invoke")(function* (
    borrowed: CodexEndpointConnectionBorrow,
    cwd: string,
    input: CodexCheckpointHelperRequestShape,
    binding?: CodexCheckpointHelperRepositoryBinding,
  ): Effect.fn.Return<CodexCheckpointHelperResult, ProviderVcsError> {
    const prepared = yield* prepareInvocation(borrowed, input);
    return yield* executeInvocation(borrowed, cwd, prepared, binding);
  });

  const singleUse = <A>(
    operation: "captureCheckpoint" | "restoreCheckpoint" | "deleteCheckpoints",
    execution: Effect.Effect<A, ProviderVcsError>,
  ): Effect.Effect<A, ProviderVcsError> => {
    let executed = false;
    return Effect.suspend(() => {
      if (executed) {
        return Effect.fail(
          operationFailed(
            options.providerInstanceId,
            operation,
            "Prepared checkpoint mutation was already executed.",
          ),
        );
      }
      executed = true;
      return execution;
    });
  };

  const probe: CodexCheckpointHelperAdapter["probe"] = Effect.fn(
    "CodexCheckpointHelperAdapter.probe",
  )(function* (borrowed, cwd) {
    if (options.helper.expectedProtocol !== 1) {
      return yield* unsupported(options.providerInstanceId, "openRepository");
    }
    const result = yield* invoke(borrowed, cwd, {
      protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
      operation: "probe",
      gitExecutablePath: options.gitExecutablePath,
    });
    if (result.operation !== "probe") {
      return yield* protocol(
        options.providerInstanceId,
        "openRepository",
        "Checkpoint helper returned the wrong probe operation.",
      );
    }
    if (
      result.gitExecutablePath !== options.gitExecutablePath ||
      REQUIRED_CAPABILITIES.some((capability) => !result.capabilities.includes(capability))
    ) {
      return yield* unsupported(options.providerInstanceId, "openRepository");
    }
    return result;
  });

  const open: CodexCheckpointHelperAdapter["open"] = Effect.fn("CodexCheckpointHelperAdapter.open")(
    function* (borrowed, identity, probeResult) {
      const result = yield* invoke(borrowed, identity.rootPath, {
        protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
        operation: "open",
        gitExecutablePath: options.gitExecutablePath,
        workspaceRoot: identity.rootPath,
      });
      if (result.operation !== "open") {
        return yield* protocol(
          options.providerInstanceId,
          "openRepository",
          "Checkpoint helper returned the wrong open operation.",
        );
      }
      const binding = result.binding;
      if (
        binding.worktreeRoot.canonicalPath !== identity.rootPath ||
        binding.gitCommonDirectoryRoot.canonicalPath !== identity.commonDirectoryPath ||
        !isSameOrDescendant(
          binding.gitDirectoryRoot.canonicalPath,
          binding.gitCommonDirectoryRoot.canonicalPath,
        ) ||
        !probeResult.objectFormats.includes(binding.objectFormat)
      ) {
        return yield* protocol(
          options.providerInstanceId,
          "openRepository",
          "Checkpoint helper repository binding did not match the VCS repository.",
        );
      }

      const capability: ProviderVcsCheckpointCapability = {
        binding,
        prepareCapture: Effect.fn("CodexCheckpointHelperAdapter.prepareCapture")(function* (input) {
          const prepared = yield* prepareInvocation(borrowed, {
            ...input,
            protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
            operation: "capture",
            gitExecutablePath: options.gitExecutablePath,
            expectedBinding: binding,
          });
          return {
            generationId: borrowed.generationId,
            requestSha256: prepared.requestSha256,
            execute: singleUse(
              "captureCheckpoint",
              Effect.gen(function* () {
                const captureResult = yield* executeInvocation(
                  borrowed,
                  identity.rootPath,
                  prepared,
                  binding,
                );
                if (captureResult.operation !== "capture") {
                  return yield* protocol(
                    options.providerInstanceId,
                    "captureCheckpoint",
                    "Checkpoint helper returned the wrong capture operation.",
                  );
                }
                return captureResult;
              }),
            ),
          };
        }),
        diff: Effect.fn("CodexCheckpointHelperAdapter.diff")(function* (input) {
          const diffResult = yield* invoke(
            borrowed,
            identity.rootPath,
            {
              ...input,
              protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
              operation: "diff",
              gitExecutablePath: options.gitExecutablePath,
              expectedBinding: binding,
            },
            binding,
          );
          if (diffResult.operation !== "diff") {
            return yield* protocol(
              options.providerInstanceId,
              "diffCheckpoints",
              "Checkpoint helper returned the wrong diff operation.",
            );
          }
          return diffResult;
        }),
        prepareRestore: Effect.fn("CodexCheckpointHelperAdapter.prepareRestore")(function* (input) {
          const prepared = yield* prepareInvocation(borrowed, {
            ...input,
            protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
            operation: "restore",
            gitExecutablePath: options.gitExecutablePath,
            expectedBinding: binding,
          });
          return {
            generationId: borrowed.generationId,
            requestSha256: prepared.requestSha256,
            execute: singleUse(
              "restoreCheckpoint",
              Effect.gen(function* () {
                const restoreResult = yield* executeInvocation(
                  borrowed,
                  identity.rootPath,
                  prepared,
                  binding,
                );
                if (restoreResult.operation !== "restore") {
                  return yield* restoreIndeterminate(options.providerInstanceId);
                }
                return restoreResult;
              }),
            ),
          };
        }),
        prepareDelete: Effect.fn("CodexCheckpointHelperAdapter.prepareDelete")(function* (input) {
          const prepared = yield* prepareInvocation(borrowed, {
            ...input,
            protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
            operation: "delete",
            gitExecutablePath: options.gitExecutablePath,
            expectedBinding: binding,
          });
          return {
            generationId: borrowed.generationId,
            requestSha256: prepared.requestSha256,
            execute: singleUse(
              "deleteCheckpoints",
              Effect.gen(function* () {
                const deleteResult = yield* executeInvocation(
                  borrowed,
                  identity.rootPath,
                  prepared,
                  binding,
                );
                if (deleteResult.operation !== "delete") {
                  return yield* protocol(
                    options.providerInstanceId,
                    "deleteCheckpoints",
                    "Checkpoint helper returned the wrong delete operation.",
                  );
                }
                return deleteResult;
              }),
            ),
          };
        }),
        observe: Effect.fn("CodexCheckpointHelperAdapter.observe")(function* (input) {
          const observeResult = yield* invoke(
            borrowed,
            identity.rootPath,
            {
              ...input,
              protocol: CODEX_CHECKPOINT_HELPER_PROTOCOL,
              operation: "observe",
              gitExecutablePath: options.gitExecutablePath,
              expectedBinding: binding,
            },
            binding,
          );
          if (observeResult.operation !== "observe") {
            return yield* protocol(
              options.providerInstanceId,
              "observeCheckpointOperation",
              "Checkpoint helper returned the wrong observe operation.",
            );
          }
          return observeResult;
        }),
      };
      return capability;
    },
  );

  return { probe, open };
};
