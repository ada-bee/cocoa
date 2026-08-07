import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "./ProcessRunner.ts";

const liveLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));

const run = (input: ProcessRunner.ProcessRunInput) =>
  Effect.flatMap(ProcessRunner.ProcessRunner, (runner) => runner.run(input)).pipe(
    Effect.provide(liveLayer),
  );

describe("ProcessRunner", () => {
  it.live("bounds output while draining the child", () =>
    Effect.gen(function* () {
      const result = yield* run({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(4096))"],
        maxOutputBytes: 64,
        outputMode: "truncate",
        truncatedMarker: "[cut]",
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${"x".repeat(64)}[cut]`);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(false);
    }),
  );

  it.live("keeps a truncated UTF-8 response within the encoded byte cap", () =>
    Effect.gen(function* () {
      const result = yield* run({
        command: process.execPath,
        args: ["-e", "process.stdout.write('éé')"],
        maxOutputBytes: 3,
        outputMode: "truncate",
      });

      expect(result.stdout).toBe("é");
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(3);
      expect(result.stdoutTruncated).toBe(true);
    }),
  );

  it.live("times out a process that does not exit", () =>
    Effect.gen(function* () {
      const error = yield* run({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        timeout: "20 millis",
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ProcessTimeoutError",
        command: process.execPath,
        argumentCount: 2,
        timeoutMs: 20,
      });
    }),
  );
});
