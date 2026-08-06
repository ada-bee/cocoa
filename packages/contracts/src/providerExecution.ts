import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

export const PROVIDER_EXECUTION_MAX_ARGUMENTS = 128;
export const PROVIDER_EXECUTION_MAX_ARGUMENT_BYTES = 16 * 1024;
export const PROVIDER_EXECUTION_MAX_COMMAND_BYTES = 64 * 1024;
export const PROVIDER_EXECUTION_MAX_TIMEOUT_MS = 120_000;
export const PROVIDER_EXECUTION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const PROVIDER_EXECUTION_DEFAULT_TIMEOUT_MS = 30_000;
export const PROVIDER_EXECUTION_DEFAULT_OUTPUT_BYTES = 1024 * 1024;

const utf8Encoder = new TextEncoder();

const commandFilter = Schema.makeFilter<ReadonlyArray<string>>((command) => {
  if (command.length === 0) return "command must contain an executable";
  if (command.length > PROVIDER_EXECUTION_MAX_ARGUMENTS) {
    return `command must contain at most ${PROVIDER_EXECUTION_MAX_ARGUMENTS} arguments`;
  }
  if (command[0]!.length === 0) return "command executable must not be empty";

  let totalBytes = 0;
  for (const argument of command) {
    if (argument.includes("\0")) return "command arguments must not contain NUL bytes";
    const argumentBytes = utf8Encoder.encode(argument).byteLength;
    if (argumentBytes > PROVIDER_EXECUTION_MAX_ARGUMENT_BYTES) {
      return `each command argument must be at most ${PROVIDER_EXECUTION_MAX_ARGUMENT_BYTES} UTF-8 bytes`;
    }
    totalBytes += argumentBytes;
    if (totalBytes > PROVIDER_EXECUTION_MAX_COMMAND_BYTES) {
      return `command must be at most ${PROVIDER_EXECUTION_MAX_COMMAND_BYTES} UTF-8 bytes`;
    }
  }
  return true;
});

export const ProviderExecutionCommand = Schema.Array(Schema.String).check(commandFilter);
export type ProviderExecutionCommand = typeof ProviderExecutionCommand.Type;

export const ProviderExecutionTimeoutMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_EXECUTION_MAX_TIMEOUT_MS),
).pipe(Schema.brand("ProviderExecutionTimeoutMs"));
export type ProviderExecutionTimeoutMs = typeof ProviderExecutionTimeoutMs.Type;

export const ProviderExecutionOutputByteLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(PROVIDER_EXECUTION_MAX_OUTPUT_BYTES),
).pipe(Schema.brand("ProviderExecutionOutputByteLimit"));
export type ProviderExecutionOutputByteLimit = typeof ProviderExecutionOutputByteLimit.Type;

const BoundedProviderExecutionOutput = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      utf8Encoder.encode(value).byteLength <= PROVIDER_EXECUTION_MAX_OUTPUT_BYTES ||
      "provider execution output exceeded the protocol byte limit",
  ),
);

export const ProviderExecutionResult = Schema.Struct({
  exitCode: Schema.Int,
  stdout: BoundedProviderExecutionOutput,
  stderr: BoundedProviderExecutionOutput,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});
export type ProviderExecutionResult = typeof ProviderExecutionResult.Type;

/** Public execution target. The gateway resolves the authoritative remote cwd from projectId. */
export const ProjectExecuteCommandInput = Schema.Struct({
  projectId: ProjectId,
  command: ProviderExecutionCommand,
  timeoutMs: Schema.optionalKey(ProviderExecutionTimeoutMs),
  outputByteLimit: Schema.optionalKey(ProviderExecutionOutputByteLimit),
});
export type ProjectExecuteCommandInput = typeof ProjectExecuteCommandInput.Type;
