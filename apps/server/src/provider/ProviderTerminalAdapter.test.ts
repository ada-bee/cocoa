import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  ProviderTerminalColumns,
  ProviderTerminalCwdError,
  ProviderTerminalDisconnectedError,
  type ProviderTerminalError,
  ProviderTerminalExitReason,
  ProviderTerminalOperation,
  ProviderTerminalOperationError,
  ProviderTerminalOutputByteLimit,
  ProviderTerminalProtocolError,
  ProviderTerminalRows,
  ProviderTerminalUnsupportedError,
  PROVIDER_TERMINAL_MAX_COLUMNS,
  PROVIDER_TERMINAL_MAX_OUTPUT_BYTES,
  PROVIDER_TERMINAL_MAX_ROWS,
} from "./ProviderTerminalAdapter.ts";

const providerInstanceId = ProviderInstanceId.make("provider-terminal-test");

it("bounds terminal geometry and cumulative output", () => {
  assert.throws(() => ProviderTerminalColumns.make(0));
  assert.throws(() => ProviderTerminalColumns.make(PROVIDER_TERMINAL_MAX_COLUMNS + 1));
  assert.strictEqual(
    ProviderTerminalColumns.make(PROVIDER_TERMINAL_MAX_COLUMNS),
    PROVIDER_TERMINAL_MAX_COLUMNS,
  );

  assert.throws(() => ProviderTerminalRows.make(0));
  assert.throws(() => ProviderTerminalRows.make(PROVIDER_TERMINAL_MAX_ROWS + 1));
  assert.strictEqual(
    ProviderTerminalRows.make(PROVIDER_TERMINAL_MAX_ROWS),
    PROVIDER_TERMINAL_MAX_ROWS,
  );

  assert.throws(() => ProviderTerminalOutputByteLimit.make(0));
  assert.throws(() => ProviderTerminalOutputByteLimit.make(PROVIDER_TERMINAL_MAX_OUTPUT_BYTES + 1));
  assert.strictEqual(
    ProviderTerminalOutputByteLimit.make(PROVIDER_TERMINAL_MAX_OUTPUT_BYTES),
    PROVIDER_TERMINAL_MAX_OUTPUT_BYTES,
  );
});

it("keeps terminal operations and exit reasons closed", () => {
  const decodeOperation = Schema.decodeUnknownSync(ProviderTerminalOperation);
  const decodeExitReason = Schema.decodeUnknownSync(ProviderTerminalExitReason);

  assert.deepStrictEqual(
    ["start", "write", "resize", "terminate"].map((value) => decodeOperation(value)),
    ["start", "write", "resize", "terminate"],
  );
  assert.throws(() => decodeOperation("attach"));

  assert.deepStrictEqual(
    ["completed", "terminated", "disconnected", "outputLimit", "failed"].map((value) =>
      decodeExitReason(value),
    ),
    ["completed", "terminated", "disconnected", "outputLimit", "failed"],
  );
  assert.throws(() => decodeExitReason("unknown"));
});

function describeError(error: ProviderTerminalError): string {
  switch (error._tag) {
    case "ProviderTerminalDisconnectedError":
    case "ProviderTerminalUnsupportedError":
      return `${error._tag}:${error.operation}`;
    case "ProviderTerminalProtocolError":
    case "ProviderTerminalOperationError":
      return `${error._tag}:${error.detail}`;
    case "ProviderTerminalCwdError":
      return `${error._tag}:${error.cwd}:${error.issue}`;
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

it("preserves exhaustive provider terminal failure categories", () => {
  const errors: ReadonlyArray<ProviderTerminalError> = [
    new ProviderTerminalDisconnectedError({
      providerInstanceId,
      operation: "start",
    }),
    new ProviderTerminalUnsupportedError({
      providerInstanceId,
      operation: "resize",
    }),
    new ProviderTerminalProtocolError({
      providerInstanceId,
      operation: "write",
      detail: "invalid response",
    }),
    new ProviderTerminalCwdError({
      providerInstanceId,
      operation: "start",
      cwd: "/missing",
      issue: "directory does not exist",
    }),
    new ProviderTerminalOperationError({
      providerInstanceId,
      operation: "terminate",
      detail: "remote process rejected the request",
    }),
  ];

  assert.deepStrictEqual(errors.map(describeError), [
    "ProviderTerminalDisconnectedError:start",
    "ProviderTerminalUnsupportedError:resize",
    "ProviderTerminalProtocolError:invalid response",
    "ProviderTerminalCwdError:/missing:directory does not exist",
    "ProviderTerminalOperationError:remote process rejected the request",
  ]);
  assert.match(errors[0]!.message, /provider-terminal-test.*disconnected.*start/i);
  assert.match(errors[3]!.message, /\/missing.*provider-terminal-test.*start/i);
});
