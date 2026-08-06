/** Codex `command/exec` implementation of bounded noninteractive execution. */
import {
  ProviderExecutionCommand,
  ProviderExecutionOutputByteLimit,
  ProviderExecutionTimeoutMs,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  type ProviderExecutionAdapter,
  ProviderExecutionDisconnectedError,
  type ProviderExecutionError,
  ProviderExecutionOperationError,
  ProviderExecutionProtocolError,
  ProviderExecutionUnsupportedError,
} from "../ProviderExecutionAdapter.ts";
import type {
  CodexEndpointBorrowUnavailableError,
  CodexEndpointConnectionBorrow,
} from "./CodexEndpointSupervisor.ts";

export interface MakeCodexExecutionAdapterOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly borrowConnection: Effect.Effect<
    CodexEndpointConnectionBorrow,
    CodexEndpointBorrowUnavailableError
  >;
}

const utf8Encoder = new TextEncoder();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const UTF8_SENTINEL_BYTES = 4;
const decodeCommand = Schema.decodeUnknownEffect(ProviderExecutionCommand);
const decodeTimeout = Schema.decodeUnknownEffect(ProviderExecutionTimeoutMs);
const decodeOutputLimit = Schema.decodeUnknownEffect(ProviderExecutionOutputByteLimit);

const disconnected = (providerInstanceId: ProviderInstanceId) =>
  new ProviderExecutionDisconnectedError({ providerInstanceId });

function mapCodexError(
  providerInstanceId: ProviderInstanceId,
  error: CodexErrors.CodexAppServerError,
): ProviderExecutionError {
  switch (error._tag) {
    case "CodexAppServerTransportError":
    case "CodexAppServerInputStreamEndedError":
    case "CodexAppServerProcessExitedError":
      return disconnected(providerInstanceId);
    case "CodexAppServerProtocolParseError":
      return new ProviderExecutionProtocolError({
        providerInstanceId,
        detail: "Codex returned a malformed command execution response.",
        cause: error,
      });
    case "CodexAppServerRequestError":
      if (error.code === -32601) {
        return new ProviderExecutionUnsupportedError({ providerInstanceId });
      }
      if ([-32700, -32600, -32602].includes(error.code)) {
        return new ProviderExecutionProtocolError({
          providerInstanceId,
          detail: "Codex rejected the command execution protocol.",
          cause: error,
        });
      }
      return new ProviderExecutionOperationError({
        providerInstanceId,
        detail: "Codex rejected the command execution request.",
        cause: error,
      });
  }
  return new ProviderExecutionOperationError({
    providerInstanceId,
    detail: "Codex command execution failed.",
    cause: error,
  });
}

function boundOutput(
  value: string,
  limit: number,
): { readonly value: string; readonly truncated: boolean } {
  const bytes = utf8Encoder.encode(value);
  if (bytes.byteLength <= limit) return { value, truncated: false };
  let end = limit;
  while (end > 0) {
    try {
      return { value: strictUtf8Decoder.decode(bytes.slice(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { value: "", truncated: true };
}

export const makeCodexExecutionAdapter = (
  options: MakeCodexExecutionAdapterOptions,
): ProviderExecutionAdapter => ({
  execute: Effect.fn("CodexExecutionAdapter.execute")(function* (input) {
    const command = yield* decodeCommand(input.command).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderExecutionProtocolError({
            providerInstanceId: options.providerInstanceId,
            detail: "The normalized command exceeded provider execution bounds.",
            cause,
          }),
      ),
    );
    const timeoutMs = yield* decodeTimeout(input.timeoutMs).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderExecutionProtocolError({
            providerInstanceId: options.providerInstanceId,
            detail: "The normalized timeout exceeded provider execution bounds.",
            cause,
          }),
      ),
    );
    const outputByteLimit = yield* decodeOutputLimit(input.outputByteLimit).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderExecutionProtocolError({
            providerInstanceId: options.providerInstanceId,
            detail: "The normalized output limit exceeded provider execution bounds.",
            cause,
          }),
      ),
    );

    const borrowed = yield* options.borrowConnection.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId)),
    );
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId)),
    );
    const response = yield* borrowed.connection.client
      .request("command/exec", {
        command,
        cwd: input.cwd,
        // Buffered command/exec responses do not carry a cap flag. Ask for one
        // full UTF-8 code point beyond the public limit so that even a server
        // dropping an incomplete trailing sequence still returns evidence that
        // the public limit was exceeded.
        outputBytesCap: outputByteLimit + UTF8_SENTINEL_BYTES,
        // Policy is owned by this provider adapter, never by client input:
        // commands may update only the resolved project root and have no network.
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [input.cwd],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
        timeoutMs,
      })
      .pipe(Effect.mapError((error) => mapCodexError(options.providerInstanceId, error)));
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId)),
    );

    if (
      utf8Encoder.encode(response.stdout).byteLength > outputByteLimit + UTF8_SENTINEL_BYTES ||
      utf8Encoder.encode(response.stderr).byteLength > outputByteLimit + UTF8_SENTINEL_BYTES
    ) {
      return yield* new ProviderExecutionProtocolError({
        providerInstanceId: options.providerInstanceId,
        detail: "Codex returned command output beyond the requested byte limit.",
      });
    }
    const stdout = boundOutput(response.stdout, outputByteLimit);
    const stderr = boundOutput(response.stderr, outputByteLimit);
    return {
      exitCode: response.exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  }),
});
