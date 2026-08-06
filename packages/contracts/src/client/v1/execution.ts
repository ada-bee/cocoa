import * as Schema from "effect/Schema";

import { ProjectId } from "../../baseSchemas.ts";

/** Frozen Cocoa client v1 execution limits. Changes require a new client protocol version. */
export const COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENTS = 128;
export const COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENT_BYTES = 16 * 1024;
export const COCOA_CLIENT_V1_EXECUTION_MAX_COMMAND_BYTES = 64 * 1024;
export const COCOA_CLIENT_V1_EXECUTION_MAX_TIMEOUT_MS = 120_000;
export const COCOA_CLIENT_V1_EXECUTION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const utf8Encoder = new TextEncoder();

const commandFilter = Schema.makeFilter<ReadonlyArray<string>>((command) => {
  if (command.length === 0) return "command must contain an executable";
  if (command.length > COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENTS) {
    return `command must contain at most ${COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENTS} arguments`;
  }
  if (command[0]!.length === 0) return "command executable must not be empty";

  let totalBytes = 0;
  for (const argument of command) {
    if (argument.includes("\0")) return "command arguments must not contain NUL bytes";
    const argumentBytes = utf8Encoder.encode(argument).byteLength;
    if (argumentBytes > COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENT_BYTES) {
      return `each command argument must be at most ${COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENT_BYTES} UTF-8 bytes`;
    }
    totalBytes += argumentBytes;
    if (totalBytes > COCOA_CLIENT_V1_EXECUTION_MAX_COMMAND_BYTES) {
      return `command must be at most ${COCOA_CLIENT_V1_EXECUTION_MAX_COMMAND_BYTES} UTF-8 bytes`;
    }
  }
  return true;
});

export const CocoaClientV1ExecutionCommand = Schema.Array(Schema.String).check(commandFilter);
export type CocoaClientV1ExecutionCommand = typeof CocoaClientV1ExecutionCommand.Type;

export const CocoaClientV1ExecutionTimeoutMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(COCOA_CLIENT_V1_EXECUTION_MAX_TIMEOUT_MS),
).pipe(Schema.brand("ProviderExecutionTimeoutMs"));
export type CocoaClientV1ExecutionTimeoutMs = typeof CocoaClientV1ExecutionTimeoutMs.Type;

export const CocoaClientV1ExecutionOutputByteLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(COCOA_CLIENT_V1_EXECUTION_MAX_OUTPUT_BYTES),
).pipe(Schema.brand("ProviderExecutionOutputByteLimit"));
export type CocoaClientV1ExecutionOutputByteLimit =
  typeof CocoaClientV1ExecutionOutputByteLimit.Type;

const CocoaClientV1BoundedExecutionOutput = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      utf8Encoder.encode(value).byteLength <= COCOA_CLIENT_V1_EXECUTION_MAX_OUTPUT_BYTES ||
      "provider execution output exceeded the protocol byte limit",
  ),
);

/** Project-scoped argv execution; cwd is intentionally absent from the wire shape. */
export const CocoaClientV1ExecuteCommandInput = Schema.Struct({
  projectId: ProjectId,
  command: CocoaClientV1ExecutionCommand,
  timeoutMs: Schema.optionalKey(CocoaClientV1ExecutionTimeoutMs),
  outputByteLimit: Schema.optionalKey(CocoaClientV1ExecutionOutputByteLimit),
});
export type CocoaClientV1ExecuteCommandInput = typeof CocoaClientV1ExecuteCommandInput.Type;

export const CocoaClientV1ExecuteCommandResult = Schema.Struct({
  exitCode: Schema.Int,
  stdout: CocoaClientV1BoundedExecutionOutput,
  stderr: CocoaClientV1BoundedExecutionOutput,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});
export type CocoaClientV1ExecuteCommandResult = typeof CocoaClientV1ExecuteCommandResult.Type;
