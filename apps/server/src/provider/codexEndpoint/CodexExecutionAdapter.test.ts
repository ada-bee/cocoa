import {
  ProviderExecutionOutputByteLimit,
  ProviderExecutionTimeoutMs,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import * as CodexEndpointConnection from "./CodexEndpointConnection.ts";
import {
  CodexEndpointBorrowUnavailableError,
  type CodexEndpointConnectionBorrow,
} from "./CodexEndpointSupervisor.ts";
import { makeCodexExecutionAdapter } from "./CodexExecutionAdapter.ts";

const instanceId = ProviderInstanceId.make("codex-execution-test");

function harness(input: {
  readonly response?: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly requestError?: CodexErrors.CodexAppServerError;
  readonly disconnectAfterRequest?: boolean;
}) {
  const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
  let currentChecks = 0;
  const request = ((method: string, payload: unknown) => {
    requests.push({ method, payload });
    return input.requestError === undefined
      ? Effect.succeed(input.response ?? { exitCode: 0, stdout: "", stderr: "" })
      : Effect.fail(input.requestError);
  }) as CodexClient.CodexAppServerClient["Service"]["request"];
  const connection = CodexEndpointConnection.CodexEndpointConnection.of({
    identity: { providerInstanceId: instanceId },
    client: { request } as CodexClient.CodexAppServerClient["Service"],
    compatibility: {
      userAgent: "codex_cli_rs/0.146.0",
      serverVersion: "0.146.0",
      codexHome: "/remote/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    awaitTermination: Effect.never,
  });
  const borrow: CodexEndpointConnectionBorrow = {
    generationId: 3,
    connection,
    ensureCurrent: Effect.suspend(() => {
      currentChecks += 1;
      return input.disconnectAfterRequest === true && currentChecks > 1
        ? Effect.fail(new CodexEndpointBorrowUnavailableError({ providerInstanceId: instanceId }))
        : Effect.void;
    }),
  };
  return {
    adapter: makeCodexExecutionAdapter({
      providerInstanceId: instanceId,
      borrowConnection: Effect.succeed(borrow),
    }),
    requests,
    currentChecks: () => currentChecks,
  };
}

const commandInput = {
  cwd: "/srv/project",
  command: ["printf", "%s", "hello"],
  timeoutMs: ProviderExecutionTimeoutMs.make(5_000),
  outputByteLimit: ProviderExecutionOutputByteLimit.make(3),
} as const;

it.effect("uses one buffered request with fixed workspace-write and no-network policy", () => {
  const test = harness({ response: { exitCode: 7, stdout: "abcd", stderr: "xy" } });
  return Effect.gen(function* () {
    const result = yield* test.adapter.execute(commandInput);
    assert.deepStrictEqual(result, {
      exitCode: 7,
      stdout: "abc",
      stderr: "xy",
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    assert.deepStrictEqual(test.requests, [
      {
        method: "command/exec",
        payload: {
          command: ["printf", "%s", "hello"],
          cwd: "/srv/project",
          outputBytesCap: 7,
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/srv/project"],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          },
          timeoutMs: 5_000,
        },
      },
    ]);
    assert.strictEqual(test.currentChecks(), 2);
  });
});

it.effect("marks UTF-8 output truncation without returning a partial code point", () => {
  const test = harness({ response: { exitCode: 0, stdout: "éé", stderr: "" } });
  return Effect.gen(function* () {
    const result = yield* test.adapter.execute(commandInput);
    assert.strictEqual(result.stdout, "é");
    assert.isTrue(result.stdoutTruncated);
  });
});

it.effect("keeps enough sentinel bytes to detect truncation across a UTF-8 boundary", () => {
  const test = harness({ response: { exitCode: 0, stdout: "ééé", stderr: "" } });
  return Effect.gen(function* () {
    const result = yield* test.adapter.execute({
      ...commandInput,
      outputByteLimit: ProviderExecutionOutputByteLimit.make(2),
    });
    assert.strictEqual(result.stdout, "é");
    assert.isTrue(result.stdoutTruncated);
    assert.strictEqual(
      (test.requests[0]!.payload as { readonly outputBytesCap: number }).outputBytesCap,
      6,
    );
  });
});

it.effect("fails an indeterminate stale-generation result without replaying", () => {
  const test = harness({
    response: { exitCode: 0, stdout: "mutated", stderr: "" },
    disconnectAfterRequest: true,
  });
  return Effect.gen(function* () {
    const error = yield* test.adapter.execute(commandInput).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProviderExecutionDisconnectedError");
    assert.strictEqual(test.requests.length, 1);
    assert.strictEqual(test.currentChecks(), 2);
  });
});

it.effect("maps unavailable and unsupported endpoints distinctly", () =>
  Effect.gen(function* () {
    const unavailable = makeCodexExecutionAdapter({
      providerInstanceId: instanceId,
      borrowConnection: Effect.fail(
        new CodexEndpointBorrowUnavailableError({ providerInstanceId: instanceId }),
      ),
    });
    const unavailableError = yield* unavailable.execute(commandInput).pipe(Effect.flip);
    assert.strictEqual(unavailableError._tag, "ProviderExecutionDisconnectedError");

    const unsupported = harness({
      requestError: new CodexErrors.CodexAppServerRequestError({
        code: -32601,
        errorMessage: "method not found",
      }),
    });
    const unsupportedError = yield* unsupported.adapter.execute(commandInput).pipe(Effect.flip);
    assert.strictEqual(unsupportedError._tag, "ProviderExecutionUnsupportedError");
    assert.strictEqual(unsupported.requests.length, 1);
  }),
);

it.effect("rejects out-of-bounds internal argv before borrowing a connection", () => {
  let borrowed = 0;
  const adapter = makeCodexExecutionAdapter({
    providerInstanceId: instanceId,
    borrowConnection: Effect.sync(() => {
      borrowed += 1;
      throw new Error("must not borrow");
    }) as never,
  });
  return Effect.gen(function* () {
    const error = yield* adapter
      .execute({ ...commandInput, command: [] } as Parameters<typeof adapter.execute>[0])
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProviderExecutionProtocolError");
    assert.strictEqual(borrowed, 0);
  });
});
