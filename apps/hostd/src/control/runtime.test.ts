/* eslint-disable t3code/no-global-process-runtime -- the Bun integration test skips the unsupported native PTY platform. */

import { describe, expect, test } from "bun:test";
import * as NodeOS from "node:os";

import { CocoaHostControlGenerationId, CocoaHostControlRequestId } from "@t3tools/contracts";

import { makeHostControlRuntime } from "./runtime.ts";

describe("host control runtime", () => {
  test("omits POSIX workspace, VCS, and terminal capabilities on Windows", async () => {
    const runtime = makeHostControlRuntime({
      generationId: CocoaHostControlGenerationId.make("host:windows-test"),
      platform: "win32",
      homePath: "/Users/test",
      gitAvailable: true,
    });
    try {
      expect(runtime.platformFamily).toBe("windows");
      expect(runtime.capabilities.map(({ kind }) => kind)).toEqual([]);
      const terminalResponse = await runtime.dispatch({
        protocolVersion: 1,
        requestId: CocoaHostControlRequestId.make("terminal-start-windows"),
        operation: "terminal.start",
        cwd: "/workspace",
        shellArgv: ["/bin/sh"],
        cols: 80,
        rows: 24,
        outputByteLimit: 1_024,
      });
      expect(terminalResponse.response).toMatchObject({
        operation: "terminal.start",
        error: { code: "unsupportedOperation" },
      });
    } finally {
      await runtime.close();
    }
  });

  test("omits VCS capabilities and rejects VCS requests when Git is unavailable", async () => {
    const runtime = makeHostControlRuntime({
      generationId: CocoaHostControlGenerationId.make("host:no-git-test"),
      gitAvailable: false,
    });
    try {
      expect(runtime.capabilities.map(({ kind }) => kind)).not.toContain("vcs");
      expect(runtime.capabilities.map(({ kind }) => kind)).not.toContain("reviewDiff");
      const result = await runtime.dispatch({
        protocolVersion: 1,
        requestId: CocoaHostControlRequestId.make("vcs-open-no-git"),
        operation: "vcs.open",
        path: process.cwd(),
      });
      expect(result.response).toMatchObject({
        operation: "vcs.open",
        error: { code: "unsupportedOperation" },
      });
    } finally {
      await runtime.close();
    }
  });

  test("runs terminal sessions through the Bun PTY adapter on supported hosts", async () => {
    if (NodeOS.platform() === "win32") return;
    const runtime = makeHostControlRuntime({
      generationId: CocoaHostControlGenerationId.make("host:terminal-runtime-test"),
    });
    const events: Array<{ readonly event: string; readonly sequence: number }> = [];
    const exited = new Promise<void>((resolve) => {
      runtime.subscribe((event) => {
        events.push(event);
        if (event.event === "terminal.exited") resolve();
      });
    });
    try {
      const started = await runtime.dispatch({
        protocolVersion: 1,
        requestId: CocoaHostControlRequestId.make("terminal-start-runtime"),
        operation: "terminal.start",
        cwd: process.cwd(),
        shellArgv: ["/bin/sh", "-c", "printf runtime-terminal"],
        cols: 80,
        rows: 24,
        outputByteLimit: 1_024,
      });
      expect(started.response.operation).toBe("terminal.start");
      if ("error" in started.response) throw new Error(started.response.error.message);
      await exited;
      expect(events.map(({ event, sequence }) => ({ event, sequence }))).toEqual([
        { event: "terminal.output", sequence: 1 },
        { event: "terminal.exited", sequence: 2 },
      ]);
    } finally {
      await runtime.close();
    }
  });
});
