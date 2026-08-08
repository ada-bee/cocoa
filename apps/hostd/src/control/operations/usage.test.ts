// @effect-diagnostics nodeBuiltinImport:off - integration fixture exercises host-local files.
import { afterEach, describe, expect, test } from "bun:test";
import { UsageDay } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { makeHostUsageReader } from "./usage.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

describe("provider-host usage scan", () => {
  test("rejects windows longer than the bounded 90-day reporting range", async () => {
    const reader = makeHostUsageReader({
      homePath: "/missing-test-home",
      fetchRates: async () => null,
    });
    await expect(
      reader.readSummary({
        sinceDay: UsageDay.make("2026-05-10"),
        untilDay: UsageDay.make("2026-08-08"),
        timeZone: "UTC",
      }),
    ).rejects.toThrow("may not exceed 90 days");
  });

  test("reads Codex transcripts on the host and returns only aggregate buckets", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-host-usage-"));
    temporaryDirectories.push(root);
    const codexHomePath = NodePath.join(root, ".codex");
    const sessionsPath = NodePath.join(codexHomePath, "sessions", "2026", "08", "08");
    await NodeFSP.mkdir(sessionsPath, { recursive: true });
    const lines = [
      {
        type: "session_meta",
        timestamp: "2026-08-08T10:00:00.000Z",
        payload: { type: "session_meta", id: "session-1" },
      },
      {
        type: "turn_context",
        timestamp: "2026-08-08T10:00:01.000Z",
        payload: { type: "turn_context", model: "gpt-test" },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-08T10:00:02.000Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 10,
              reasoning_output_tokens: 2,
            },
          },
        },
      },
    ];
    await NodeFSP.writeFile(
      NodePath.join(sessionsPath, "rollout.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );

    const reader = makeHostUsageReader({
      homePath: root,
      codexHomePath,
      cacheDirectory: NodePath.join(root, "cache"),
      installationId: "host-installation-test",
      fetchRates: async () => ({
        "gpt-test": { input_cost_per_token: 0.001, output_cost_per_token: 0.002 },
      }),
    });
    const summary = await reader.readSummary({
      sinceDay: UsageDay.make("2026-08-08"),
      untilDay: UsageDay.make("2026-08-08"),
      timeZone: "UTC",
    });

    expect(summary.buckets).toHaveLength(1);
    const codexSource = summary.sources.find((source) => source.fingerprint.provider === "codex");
    expect(summary.buckets[0]).toMatchObject({
      source: {
        hostId: codexSource?.fingerprint.hostId,
        sourceId: codexSource?.fingerprint.sourceId,
      },
      provider: "codex",
      model: "gpt-test",
      totals: { uncachedInputTokens: 60, cachedInputTokens: 40, outputTokens: 10 },
      records: 1,
    });
    expect(codexSource).toMatchObject({
      fingerprint: {
        hostId: "host-installation-test",
        label: "Codex sessions",
      },
      status: "ok",
      scannedFiles: 1,
      distinctSessions: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("rollout.jsonl");
    expect(JSON.stringify(summary)).not.toContain(root);
  });

  test("marks a source partial when a bounded scan limit is reached", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-host-usage-"));
    temporaryDirectories.push(root);
    const codexHomePath = NodePath.join(root, ".codex");
    const sessionsPath = NodePath.join(codexHomePath, "sessions");
    await NodeFSP.mkdir(sessionsPath, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(sessionsPath, "bounded.jsonl"), "{}\n");

    const reader = makeHostUsageReader({
      homePath: root,
      codexHomePath,
      cacheDirectory: NodePath.join(root, "cache"),
      installationId: "bounded-installation",
      scanLimits: { maxFiles: 0 },
      fetchRates: async () => null,
    });
    const summary = await reader.readSummary({
      sinceDay: UsageDay.make("2026-08-08"),
      untilDay: UsageDay.make("2026-08-08"),
      timeZone: "UTC",
    });
    const source = summary.sources.find((item) => item.fingerprint.provider === "codex");
    expect(source?.status).toBe("partial");
    expect(source?.message).toContain("limit:files");
  });

  test("coalesces identical in-flight requests", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-host-usage-"));
    temporaryDirectories.push(root);
    let releaseRates: (() => void) | undefined;
    const ratesBlocked = new Promise<void>((resolve) => {
      releaseRates = resolve;
    });
    let fetches = 0;
    const reader = makeHostUsageReader({
      homePath: root,
      codexHomePath: NodePath.join(root, ".codex"),
      cacheDirectory: NodePath.join(root, "cache"),
      installationId: "coalesced-installation",
      fetchRates: async () => {
        fetches += 1;
        await ratesBlocked;
        return null;
      },
    });
    const input = {
      sinceDay: UsageDay.make("2026-08-08"),
      untilDay: UsageDay.make("2026-08-08"),
      timeZone: "UTC",
    };
    const first = reader.readSummary(input);
    const second = reader.readSummary(input);
    expect(first).toBe(second);
    releaseRates?.();
    await first;
    expect(fetches).toBe(1);
  });

  test("persists an opaque installation identity without exposing host paths", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-host-usage-"));
    temporaryDirectories.push(root);
    const cacheDirectory = NodePath.join(root, "cache");
    const input = {
      sinceDay: UsageDay.make("2026-08-08"),
      untilDay: UsageDay.make("2026-08-08"),
      timeZone: "UTC",
    };
    const first = await makeHostUsageReader({
      homePath: root,
      codexHomePath: NodePath.join(root, ".codex"),
      cacheDirectory,
      fetchRates: async () => null,
    }).readSummary(input);
    const second = await makeHostUsageReader({
      homePath: root,
      codexHomePath: NodePath.join(root, ".codex"),
      cacheDirectory,
      fetchRates: async () => null,
    }).readSummary(input);

    expect(second.sources[0]?.fingerprint.hostId).toBe(first.sources[0]?.fingerprint.hostId);
    expect(second.sources[0]?.fingerprint.sourceId).toBe(first.sources[0]?.fingerprint.sourceId);
    expect(JSON.stringify(second)).not.toContain(root);
  });

  test("reports unreadable directories and files as path-free partial coverage", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-host-usage-"));
    temporaryDirectories.push(root);
    const codexHomePath = NodePath.join(root, ".codex");
    const sessionsPath = NodePath.join(codexHomePath, "sessions");
    const transcriptPath = NodePath.join(sessionsPath, "private.jsonl");
    await NodeFSP.mkdir(sessionsPath, { recursive: true });
    await NodeFSP.writeFile(transcriptPath, "{}\n");
    const input = {
      sinceDay: UsageDay.make("2026-08-08"),
      untilDay: UsageDay.make("2026-08-08"),
      timeZone: "UTC",
    };

    try {
      await NodeFSP.chmod(transcriptPath, 0);
      const fileSummary = await makeHostUsageReader({
        homePath: root,
        codexHomePath,
        cacheDirectory: NodePath.join(root, "file-cache"),
        installationId: "unreadable-file-installation",
        fetchRates: async () => null,
      }).readSummary(input);
      const fileSource = fileSummary.sources.find(
        (source) => source.fingerprint.provider === "codex",
      );
      expect(fileSource?.status).toBe("partial");
      expect(fileSource?.skippedFiles).toBe(1);
      expect(JSON.stringify(fileSource)).not.toContain(root);

      await NodeFSP.chmod(transcriptPath, 0o600);
      await NodeFSP.chmod(sessionsPath, 0);
      const directorySummary = await makeHostUsageReader({
        homePath: root,
        codexHomePath,
        cacheDirectory: NodePath.join(root, "directory-cache"),
        installationId: "unreadable-directory-installation",
        fetchRates: async () => null,
      }).readSummary(input);
      const directorySource = directorySummary.sources.find(
        (source) => source.fingerprint.provider === "codex",
      );
      expect(directorySource?.status).not.toBe("missing");
      expect(["partial", "failed"]).toContain(directorySource?.status ?? "missing");
      expect(JSON.stringify(directorySource)).not.toContain(root);
    } finally {
      await NodeFSP.chmod(sessionsPath, 0o700).catch(() => undefined);
      await NodeFSP.chmod(transcriptPath, 0o600).catch(() => undefined);
    }
  });

  test("rejects scans beyond the bounded pending queue", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-host-usage-"));
    temporaryDirectories.push(root);
    let releaseRates: (() => void) | undefined;
    const ratesBlocked = new Promise<void>((resolve) => {
      releaseRates = resolve;
    });
    const reader = makeHostUsageReader({
      homePath: root,
      codexHomePath: NodePath.join(root, ".codex"),
      cacheDirectory: NodePath.join(root, "cache"),
      installationId: "bounded-queue-installation",
      fetchRates: async () => {
        await ratesBlocked;
        return null;
      },
    });
    const queued = Array.from({ length: 8 }, (_, index) =>
      reader.readSummary({
        sinceDay: UsageDay.make(`2026-08-0${index + 1}`),
        untilDay: UsageDay.make("2026-08-08"),
        timeZone: "UTC",
      }),
    );
    await expect(
      reader.readSummary({
        sinceDay: UsageDay.make("2026-08-09"),
        untilDay: UsageDay.make("2026-08-09"),
        timeZone: "UTC",
      }),
    ).rejects.toThrow("Too many usage scans");
    releaseRates?.();
    await Promise.all(queued);
  });

  test("marks the source partial when the per-file record limit is reached", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-host-usage-"));
    temporaryDirectories.push(root);
    const codexHomePath = NodePath.join(root, ".codex");
    const sessionsPath = NodePath.join(codexHomePath, "sessions");
    await NodeFSP.mkdir(sessionsPath, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(sessionsPath, "records.jsonl"),
      [
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-08-08T10:00:00.000Z",
          payload: { type: "turn_context", model: "gpt-test" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-08T10:00:01.000Z",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } },
          },
        }),
      ].join("\n"),
    );
    const summary = await makeHostUsageReader({
      homePath: root,
      codexHomePath,
      cacheDirectory: NodePath.join(root, "cache"),
      installationId: "record-limit-installation",
      scanLimits: { maxRecordsPerFile: 0 },
    }).readSummary({
      sinceDay: UsageDay.make("2026-08-08"),
      untilDay: UsageDay.make("2026-08-08"),
      timeZone: "UTC",
    });
    expect(summary.sources[0]?.status).toBe("partial");
    expect(summary.sources[0]?.message).toContain("limit:records");
    expect(summary.buckets).toHaveLength(0);
  });
});
