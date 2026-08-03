import * as NodeCrypto from "node:crypto";

import {
  CODEX_WORKSPACE_HELPER_MAX_RESPONSE_BYTES,
  CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION,
  CodexWorkspaceHelperListDepthLimit,
  CodexWorkspaceHelperListDirectoryLimit,
  CodexWorkspaceHelperListEntryLimit,
  CodexWorkspaceHelperRequest,
  CodexWorkspaceHelperResponse,
  CodexWorkspaceHelperResponseByteLimit,
  type CodexWorkspaceHelperConfig,
  type CodexWorkspaceHelperErrorCode,
  type CodexWorkspaceHelperMetadata,
  type CodexWorkspaceHelperRequest as CodexWorkspaceHelperRequestShape,
  type CodexWorkspaceHelperResult,
  type CodexWorkspaceHelperRootIdentity,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  type ProviderWorkspaceAdapter,
  ProviderWorkspaceDisconnectedError,
  type ProviderWorkspaceDirectoryListing,
  type ProviderWorkspaceDirectoryEntry,
  type ProviderWorkspaceError,
  type ProviderWorkspaceFileRead,
  type ProviderWorkspaceMetadata,
  type ProviderWorkspaceOperation,
  ProviderWorkspaceOperationError,
  ProviderWorkspacePathError,
  ProviderWorkspaceProtocolError,
  ProviderWorkspaceUnsupportedError,
} from "../ProviderWorkspaceAdapter.ts";
import type {
  CodexEndpointBorrowUnavailableError,
  CodexEndpointConnectionBorrow,
} from "../codexEndpoint/CodexEndpointSupervisor.ts";
import {
  CODEX_WORKSPACE_HELPER_FRAME_PREFIX,
  CODEX_WORKSPACE_INLINE_PYTHON,
} from "./CodexWorkspaceInlinePython.ts";

const COMMAND_TIMEOUT_MS = 10_000;
const FRAME_HEADER_ALLOWANCE_BYTES = 128;
const COMMAND_OUTPUT_BYTES_CAP =
  CODEX_WORKSPACE_HELPER_MAX_RESPONSE_BYTES + FRAME_HEADER_ALLOWANCE_BYTES;

const decodeHelperRequest = Schema.decodeUnknownEffect(CodexWorkspaceHelperRequest);
const decodeHelperResponse = Schema.decodeUnknownEffect(CodexWorkspaceHelperResponse);

export interface MakeCodexWorkspaceAdapterOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly helper: CodexWorkspaceHelperConfig;
  readonly borrowConnection: Effect.Effect<
    CodexEndpointConnectionBorrow,
    CodexEndpointBorrowUnavailableError
  >;
}

const operationName = (
  operation: CodexWorkspaceHelperRequestShape["operation"],
): ProviderWorkspaceOperation => {
  switch (operation) {
    case "validate":
    case "probe":
      return "openRoot";
    case "stat":
      return "getMetadata";
    case "list":
      return "listDirectory";
    case "read":
      return "readFile";
  }
};

const disconnected = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderWorkspaceOperation,
) => new ProviderWorkspaceDisconnectedError({ providerInstanceId, operation });

const unsupported = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderWorkspaceOperation,
) => new ProviderWorkspaceUnsupportedError({ providerInstanceId, operation });

const protocol = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderWorkspaceOperation,
  detail: string,
) => new ProviderWorkspaceProtocolError({ providerInstanceId, operation, detail });

const operationFailed = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderWorkspaceOperation,
  detail: string,
) => new ProviderWorkspaceOperationError({ providerInstanceId, operation, detail });

const pathFailed = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderWorkspaceOperation,
  path: string,
  issue: string,
) => new ProviderWorkspacePathError({ providerInstanceId, operation, path, issue });

const isDisconnectedCodexError = (error: CodexErrors.CodexAppServerError): boolean =>
  error._tag === "CodexAppServerTransportError" ||
  error._tag === "CodexAppServerInputStreamEndedError" ||
  error._tag === "CodexAppServerProcessExitedError";

const mapCodexError = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderWorkspaceOperation,
  error: CodexErrors.CodexAppServerError,
): ProviderWorkspaceError => {
  if (isDisconnectedCodexError(error)) return disconnected(providerInstanceId, operation);
  if (error._tag === "CodexAppServerRequestError" && error.code === -32601) {
    return unsupported(providerInstanceId, operation);
  }
  if (
    error._tag === "CodexAppServerProtocolParseError" ||
    (error._tag === "CodexAppServerRequestError" && [-32700, -32600, -32602].includes(error.code))
  ) {
    return protocol(providerInstanceId, operation, "Codex rejected the helper protocol.");
  }
  return operationFailed(
    providerInstanceId,
    operation,
    "Codex could not run the workspace helper.",
  );
};

const mapHelperError = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderWorkspaceOperation,
  relativePath: string,
  code: CodexWorkspaceHelperErrorCode,
): ProviderWorkspaceError => {
  switch (code) {
    case "unsupported_protocol":
    case "unsupported_operation":
      return unsupported(providerInstanceId, operation);
    case "invalid_root":
      return pathFailed(providerInstanceId, operation, "<workspace-root>", code);
    case "invalid_path":
    case "path_not_found":
    case "path_not_file":
    case "path_not_directory":
    case "path_is_symlink":
    case "file_too_large":
      return pathFailed(providerInstanceId, operation, relativePath, code);
    case "limit_exceeded":
      return operationFailed(providerInstanceId, operation, "Workspace helper limit exceeded.");
    default:
      return operationFailed(providerInstanceId, operation, "Workspace helper operation failed.");
  }
};

export function encodeCodexWorkspaceHelperFrame(value: unknown): string {
  const payload = JSON.stringify(value);
  const bytes = new TextEncoder().encode(payload);
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return `${CODEX_WORKSPACE_HELPER_FRAME_PREFIX} ${bytes.byteLength} ${digest}\n${payload}`;
}

export function decodeCodexWorkspaceHelperFrame(stdout: string): unknown {
  const newline = stdout.indexOf("\n");
  if (newline < 0 || newline > FRAME_HEADER_ALLOWANCE_BYTES) {
    throw new Error("invalid frame header");
  }
  const header = stdout.slice(0, newline);
  const match = /^CWH1 ([1-9][0-9]*) ([a-f0-9]{64})$/.exec(header);
  if (match === null) throw new Error("invalid frame header");
  const declaredLength = Number(match[1]);
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength > CODEX_WORKSPACE_HELPER_MAX_RESPONSE_BYTES
  ) {
    throw new Error("invalid frame length");
  }
  const payload = stdout.slice(newline + 1);
  const payloadBytes = new TextEncoder().encode(payload);
  if (payloadBytes.byteLength !== declaredLength) throw new Error("frame length mismatch");
  const digest = NodeCrypto.createHash("sha256").update(payloadBytes).digest("hex");
  if (digest !== match[2]) throw new Error("frame checksum mismatch");
  return JSON.parse(payload) as unknown;
}

const toProviderMetadata = (metadata: CodexWorkspaceHelperMetadata): ProviderWorkspaceMetadata => ({
  kind: metadata.kind,
  ...(metadata.size === undefined ? {} : { size: metadata.size }),
  ...(metadata.createdAtMs === undefined ? {} : { createdAtMs: metadata.createdAtMs }),
  ...(metadata.modifiedAtMs === undefined ? {} : { modifiedAtMs: metadata.modifiedAtMs }),
});

const encodeRequestArg = (request: CodexWorkspaceHelperRequestShape): string =>
  Encoding.encodeBase64(new TextEncoder().encode(JSON.stringify(request)));

export const makeCodexWorkspaceAdapter = (
  options: MakeCodexWorkspaceAdapterOptions,
): ProviderWorkspaceAdapter => {
  const execute = Effect.fn("CodexWorkspaceAdapter.execute")(function* (
    input: CodexWorkspaceHelperRequestShape,
  ): Effect.fn.Return<CodexWorkspaceHelperResult, ProviderWorkspaceError> {
    const operation = operationName(input.operation);
    const relativePath = "relativePath" in input ? input.relativePath : "<workspace-root>";
    if (
      options.helper.type === "cocoa-workspace-helper-v1" &&
      options.helper.expectedProtocol !== CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION
    ) {
      return yield* unsupported(options.providerInstanceId, operation);
    }
    const request = yield* decodeHelperRequest(input).pipe(
      Effect.mapError(() =>
        pathFailed(options.providerInstanceId, operation, relativePath, "invalid_path"),
      ),
    );
    const requestArg = encodeRequestArg(request);
    const command =
      options.helper.type === "inline-python3-v1"
        ? [
            options.helper.executablePath,
            "-I",
            "-S",
            "-c",
            CODEX_WORKSPACE_INLINE_PYTHON,
            requestArg,
          ]
        : [options.helper.executablePath, requestArg];
    const borrowed = yield* options.borrowConnection.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, operation)),
    );
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, operation)),
    );

    const exit = yield* borrowed.connection.client
      .request("command/exec", {
        command,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: COMMAND_TIMEOUT_MS,
        outputBytesCap: COMMAND_OUTPUT_BYTES_CAP,
      })
      .pipe(Effect.result);

    if (exit._tag === "Failure") {
      const current = yield* borrowed.ensureCurrent.pipe(Effect.result);
      if (current._tag === "Failure") {
        return yield* disconnected(options.providerInstanceId, operation);
      }
      return yield* mapCodexError(options.providerInstanceId, operation, exit.failure);
    }
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, operation)),
    );

    const commandResult = exit.success;
    if (commandResult.exitCode === 126 || commandResult.exitCode === 127) {
      return yield* unsupported(options.providerInstanceId, operation);
    }
    if (commandResult.exitCode !== 0) {
      return yield* operationFailed(
        options.providerInstanceId,
        operation,
        "Workspace helper exited unsuccessfully.",
      );
    }
    if (commandResult.stderr !== "") {
      return yield* protocol(
        options.providerInstanceId,
        operation,
        "Workspace helper emitted unexpected stderr.",
      );
    }

    const untrusted = yield* Effect.try(() =>
      decodeCodexWorkspaceHelperFrame(commandResult.stdout),
    ).pipe(
      Effect.mapError(() =>
        protocol(options.providerInstanceId, operation, "Workspace helper frame was invalid."),
      ),
    );
    const response = yield* decodeHelperResponse(untrusted).pipe(
      Effect.mapError(() =>
        protocol(options.providerInstanceId, operation, "Workspace helper response was invalid."),
      ),
    );
    if (!response.ok) {
      return yield* mapHelperError(
        options.providerInstanceId,
        operation,
        relativePath,
        response.error.code,
      );
    }
    if (response.result.operation !== input.operation) {
      return yield* protocol(
        options.providerInstanceId,
        operation,
        "Workspace helper returned the wrong operation.",
      );
    }
    return response.result;
  });

  const openRoot: ProviderWorkspaceAdapter["openRoot"] = Effect.fn(
    "CodexWorkspaceAdapter.openRoot",
  )(function* (workspaceRoot) {
    const result = yield* execute({
      protocol: CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION,
      operation: "validate",
      root: workspaceRoot,
    } as CodexWorkspaceHelperRequestShape);
    if (result.operation !== "validate") {
      return yield* protocol(
        options.providerInstanceId,
        "openRoot",
        "Workspace helper returned the wrong validation result.",
      );
    }
    if (result.metadata.kind !== "directory") {
      return yield* pathFailed(
        options.providerInstanceId,
        "openRoot",
        "<workspace-root>",
        "path_not_directory",
      );
    }

    const root: CodexWorkspaceHelperRootIdentity = result.root;
    const requestRoot = root.canonicalRoot;

    return {
      getMetadata: Effect.fn("CodexWorkspaceAdapter.getMetadata")(function* (input) {
        const metadataResult = yield* execute({
          protocol: CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION,
          operation: "stat",
          root: requestRoot,
          expectedRoot: root,
          relativePath: input.relativePath,
        } as CodexWorkspaceHelperRequestShape);
        if (metadataResult.operation !== "stat") {
          return yield* protocol(
            options.providerInstanceId,
            "getMetadata",
            "Workspace helper returned the wrong metadata result.",
          );
        }
        return toProviderMetadata(metadataResult.metadata);
      }),
      listDirectory: Effect.fn("CodexWorkspaceAdapter.listDirectory")(function* (input) {
        const maxEntries = Math.min(input.maxEntries, 25_000);
        const listResult = yield* execute({
          protocol: CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION,
          operation: "list",
          root: requestRoot,
          expectedRoot: root,
          relativePath: input.relativePath,
          limits: {
            maxEntries: CodexWorkspaceHelperListEntryLimit.make(maxEntries),
            maxDepth: CodexWorkspaceHelperListDepthLimit.make(1),
            maxDirectories: CodexWorkspaceHelperListDirectoryLimit.make(1),
            maxResponseBytes: CodexWorkspaceHelperResponseByteLimit.make(
              CODEX_WORKSPACE_HELPER_MAX_RESPONSE_BYTES,
            ),
          },
        } as CodexWorkspaceHelperRequestShape);
        if (listResult.operation !== "list") {
          return yield* protocol(
            options.providerInstanceId,
            "listDirectory",
            "Workspace helper returned the wrong listing result.",
          );
        }
        const entries: Array<ProviderWorkspaceDirectoryEntry> = [];
        for (const entry of listResult.entries) {
          if (
            entry.path === "" ||
            entry.path.includes("/") ||
            entry.path.includes("\\") ||
            entry.path === "." ||
            entry.path === ".."
          ) {
            return yield* protocol(
              options.providerInstanceId,
              "listDirectory",
              "Workspace helper returned a non-child entry.",
            );
          }
          entries.push({ name: entry.path, kind: entry.kind });
        }
        return {
          entries,
          truncated: listResult.truncated,
        } satisfies ProviderWorkspaceDirectoryListing;
      }),
      readFile: Effect.fn("CodexWorkspaceAdapter.readFile")(function* (input) {
        const readResult = yield* execute({
          protocol: CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION,
          operation: "read",
          root: requestRoot,
          expectedRoot: root,
          relativePath: input.relativePath,
          maxBytes: input.maxBytes,
        } as CodexWorkspaceHelperRequestShape);
        if (readResult.operation !== "read") {
          return yield* protocol(
            options.providerInstanceId,
            "readFile",
            "Workspace helper returned the wrong read result.",
          );
        }
        const bytes = yield* Effect.fromResult(Encoding.decodeBase64(readResult.dataBase64)).pipe(
          Effect.mapError(() =>
            protocol(
              options.providerInstanceId,
              "readFile",
              "Workspace helper returned invalid base64 data.",
            ),
          ),
        );
        if (
          bytes.byteLength > input.maxBytes ||
          (!readResult.truncated && readResult.byteLength !== bytes.byteLength) ||
          (readResult.truncated && readResult.byteLength <= bytes.byteLength)
        ) {
          return yield* protocol(
            options.providerInstanceId,
            "readFile",
            "Workspace helper returned inconsistent read bounds.",
          );
        }
        return {
          bytes,
          byteLength: readResult.byteLength,
          truncated: readResult.truncated,
        } satisfies ProviderWorkspaceFileRead;
      }),
    };
  });

  return { openRoot };
};
