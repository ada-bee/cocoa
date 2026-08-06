import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ProjectExecuteCommandInput,
  PROVIDER_EXECUTION_MAX_ARGUMENTS,
  PROVIDER_EXECUTION_MAX_COMMAND_BYTES,
  PROVIDER_EXECUTION_MAX_OUTPUT_BYTES,
  PROVIDER_EXECUTION_MAX_TIMEOUT_MS,
  ProviderExecutionResult,
} from "./providerExecution.ts";

const decodeInput = Schema.decodeUnknownSync(ProjectExecuteCommandInput);

describe("provider execution boundary", () => {
  it("accepts structured argv and strips any caller-supplied cwd", () => {
    expect(
      decodeInput({
        projectId: "project-1",
        command: ["printf", "%s", "hello world"],
        timeoutMs: 5_000,
        outputByteLimit: 256,
        cwd: "/gateway/attacker-selected",
      }),
    ).toEqual({
      projectId: "project-1",
      command: ["printf", "%s", "hello world"],
      timeoutMs: 5_000,
      outputByteLimit: 256,
    });
  });

  it.each([
    [],
    [""],
    ["printf", "bad\0argument"],
    Array.from({ length: PROVIDER_EXECUTION_MAX_ARGUMENTS + 1 }, () => "x"),
    ["x".repeat(PROVIDER_EXECUTION_MAX_COMMAND_BYTES + 1)],
  ])("rejects unsafe or unbounded argv %#", (command) => {
    expect(() => decodeInput({ projectId: "project-1", command })).toThrow();
  });

  it("bounds timeout and output capture", () => {
    expect(() =>
      decodeInput({
        projectId: "project-1",
        command: ["true"],
        timeoutMs: PROVIDER_EXECUTION_MAX_TIMEOUT_MS + 1,
      }),
    ).toThrow();
    expect(() =>
      decodeInput({
        projectId: "project-1",
        command: ["true"],
        outputByteLimit: PROVIDER_EXECUTION_MAX_OUTPUT_BYTES + 1,
      }),
    ).toThrow();
  });

  it("requires explicit truncation evidence in results", () => {
    const decodeResult = Schema.decodeUnknownSync(ProviderExecutionResult);
    expect(
      decodeResult({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(() => decodeResult({ exitCode: 0, stdout: "ok", stderr: "" })).toThrow();
  });
});
