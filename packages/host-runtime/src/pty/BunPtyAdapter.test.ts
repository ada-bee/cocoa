/* eslint-disable t3code/no-global-process-runtime -- the live native adapter test supplies the detected host platform explicitly. */

import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as BunPtyAdapter from "./BunPtyAdapter.ts";
import type * as PtyAdapter from "./PtyAdapter.ts";

it.effect("rejects Windows with a structured startup defect", () =>
  Effect.gen(function* () {
    const exit = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(BunPtyAdapter.BunPtyUnsupportedPlatformError);
      expect(error).toMatchObject({ platform: "win32" });
    }
  }),
);

it.live("retains fast output and exit until the host session subscribes", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform === "win32" || typeof Bun === "undefined") return;
    const adapter = yield* BunPtyAdapter.make();
    const child = yield* adapter.spawn({
      shell: "/bin/sh",
      args: ["-c", "printf fast-output"],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: process.env,
    });

    yield* Effect.sleep("50 millis");
    const chunks: Uint8Array[] = [];
    child.onData((data) => chunks.push(data));
    let exit: PtyAdapter.PtyExitEvent | undefined;
    child.onExit((event) => {
      exit = event;
    });

    expect(Buffer.concat(chunks).toString("utf8")).toBe("fast-output");
    expect(exit?.exitCode).toBe(0);
  }).pipe(Effect.provideService(HostProcessPlatform, NodeOS.platform())),
);
