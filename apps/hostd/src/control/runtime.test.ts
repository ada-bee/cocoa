/* eslint-disable t3code/no-global-process-runtime -- the Bun integration test skips the unsupported native PTY platform. */

import { describe, expect, test } from "bun:test";
import * as NodeOS from "node:os";

import {
  CocoaHostControlGenerationId,
  CocoaHostControlRequestId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
} from "@t3tools/contracts";

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
      expect(runtime.capabilities.map(({ kind }) => kind)).toEqual(["usage"]);
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

  test("advertises and dispatches pre-aggregated provider-host usage", async () => {
    const sinceDay = UsageDay.make("2026-08-01");
    const untilDay = UsageDay.make("2026-08-08");
    const runtime = makeHostControlRuntime({
      generationId: CocoaHostControlGenerationId.make("host:usage-test"),
      platform: "win32",
      homePath: "/Users/test",
      usageReader: {
        readSummary: async (input) => ({
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-08-08T12:00:00.000Z",
          ...input,
          buckets: [],
          sources: [],
          pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
          scanDurationMs: 1,
        }),
      },
    });
    try {
      const result = await runtime.dispatch({
        protocolVersion: 2,
        requestId: CocoaHostControlRequestId.make("usage-read"),
        operation: "usage.read",
        input: { sinceDay, untilDay, timeZone: "UTC" },
      });
      expect(result.response).toMatchObject({
        operation: "usage.read",
        summary: { sinceDay, untilDay, timeZone: "UTC" },
      });
    } finally {
      await runtime.close();
    }
  });

  test("uses the configured host installation identity and stays offline by default", async () => {
    const day = UsageDay.make("2026-08-08");
    const runtime = makeHostControlRuntime({
      generationId: CocoaHostControlGenerationId.make("host:usage-identity-test"),
      platform: "win32",
      homePath: "/definitely/missing/cocoa-host-home",
      installationId: "configured-host-installation",
      gitAvailable: false,
    });
    try {
      const result = await runtime.dispatch({
        protocolVersion: 2,
        requestId: CocoaHostControlRequestId.make("usage-read-identity"),
        operation: "usage.read",
        input: { sinceDay: day, untilDay: day, timeZone: "UTC" },
      });
      if ("error" in result.response) throw new Error(result.response.error.message);
      if (result.response.operation !== "usage.read") throw new Error("Unexpected response");
      expect(result.response.summary.pricing).toMatchObject({
        status: "unavailable",
        source: "offline",
      });
      expect(
        result.response.summary.sources.every(
          ({ fingerprint }) => fingerprint.hostId === "configured-host-installation",
        ),
      ).toBe(true);
      expect(JSON.stringify(result.response.summary)).not.toContain("/definitely/missing");
    } finally {
      await runtime.close();
    }
  });

  test("rejects an oversized usage summary before it reaches the control transport", async () => {
    const sinceDay = UsageDay.make("2026-08-08");
    const runtime = makeHostControlRuntime({
      generationId: CocoaHostControlGenerationId.make("host:usage-limit-test"),
      platform: "win32",
      homePath: "/Users/test",
      usageReader: {
        readSummary: async (input) => ({
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-08-08T12:00:00.000Z",
          ...input,
          buckets: [],
          sources: [],
          pricing: {
            status: "unavailable",
            source: "x".repeat(3 * 1024 * 1024),
            fetchedAt: null,
            knownModels: 0,
          },
          scanDurationMs: 1,
        }),
      },
    });
    try {
      const result = await runtime.dispatch({
        protocolVersion: 2,
        requestId: CocoaHostControlRequestId.make("usage-read-oversized"),
        operation: "usage.read",
        input: { sinceDay, untilDay: sinceDay, timeZone: "UTC" },
      });
      expect(result.response).toMatchObject({
        operation: "usage.read",
        error: { code: "limitExceeded", retryable: false },
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
