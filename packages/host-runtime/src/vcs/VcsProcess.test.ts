import { VcsProcessExitError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../process/ProcessRunner.ts";
import * as VcsProcess from "./VcsProcess.ts";

const baseInput = {
  operation: "host.git.status",
  command: "git",
  args: ["status", "--short"],
  cwd: "/provider/workspace",
} satisfies VcsProcess.VcsProcessInput;

const runWithResult = (result: ProcessRunner.ProcessRunOutput) =>
  VcsProcess.make.pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run: () => Effect.succeed(result) }),
    ),
    Effect.flatMap((service) => service.run(baseInput)),
  );

describe("VcsProcess", () => {
  it.effect("maps non-zero exits without retaining stderr secrets", () =>
    Effect.gen(function* () {
      const secret = "authentication failed for token provider-secret";
      const error = yield* runWithResult({
        stdout: "",
        stderr: secret,
        code: ChildProcessSpawner.ExitCode(1),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessExitError);
      expect(error).toMatchObject({
        _tag: "VcsProcessExitError",
        operation: "host.git.status",
        command: "git",
        failureKind: "authentication",
        stderrLength: secret.length,
      });
      expect(error.message).not.toContain("provider-secret");
    }),
  );

  it.effect("rejects a missing process exit code", () =>
    runWithResult({
      stdout: "",
      stderr: "",
      code: null,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toMatchObject({
          _tag: "VcsProcessMissingExitCodeError",
          operation: "host.git.status",
        });
      }),
    ),
  );
});
