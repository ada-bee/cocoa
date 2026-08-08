import { describe, expect, it } from "@effect/vitest";
import {
  ProviderHostId,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { type ProviderUsageAdapter, ProviderUsageError } from "../provider/ProviderUsageAdapter.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../provider/Services/ProviderInstanceRegistry.ts";
import { make, mergeHostUsageSummaries } from "./UsageService.ts";

const input: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-08"),
  timeZone: "UTC",
};

const summary = (hostId: string): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-08T12:00:00.000Z",
  ...input,
  buckets: [
    {
      source: { hostId, sourceId: "codex-source" },
      day: UsageDay.make("2026-08-08"),
      provider: "codex",
      model: "gpt-test",
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 1,
      },
      costUsd: 0.01,
      cacheSavingsUsd: 0,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [
    {
      fingerprint: {
        hostId,
        provider: "codex",
        sourceId: "codex-source",
        label: "Codex sessions",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: { status: "fresh", source: "test-rates", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 4,
});

describe("gateway usage aggregation", () => {
  it("claims duplicate physical host transcript sources exactly once", () => {
    const merged = mergeHostUsageSummaries(
      input,
      [summary("host-a"), summary("host-a")],
      "2026-08-08T12:00:01.000Z",
      5,
    );
    expect(merged.sources).toHaveLength(1);
    expect(merged.buckets).toHaveLength(1);
    expect(merged.buckets[0]?.totals.uncachedInputTokens).toBe(10);
  });

  it("retains summaries from distinct physical hosts", () => {
    const merged = mergeHostUsageSummaries(
      input,
      [summary("host-a"), summary("host-b")],
      "2026-08-08T12:00:01.000Z",
      5,
    );
    expect(merged.sources).toHaveLength(2);
    expect(merged.buckets).toHaveLength(2);
  });

  it("deduplicates repeated missing-source diagnostics", () => {
    const missing = {
      ...summary("host-a"),
      buckets: [],
      sources: summary("host-a").sources.map((source) => ({
        ...source,
        status: "missing" as const,
      })),
    };
    const merged = mergeHostUsageSummaries(
      input,
      [missing, missing],
      "2026-08-08T12:00:01.000Z",
      5,
    );
    expect(merged.sources).toHaveLength(1);
    expect(merged.buckets).toHaveLength(0);
  });

  it("prefers a complete duplicate source over an earlier partial scan", () => {
    const partial = {
      ...summary("host-a"),
      sources: summary("host-a").sources.map((source) => ({
        ...source,
        status: "partial" as const,
        message: "Bounded scan stopped early.",
      })),
    };
    const complete = {
      ...summary("host-a"),
      buckets: summary("host-a").buckets.map((bucket) => ({
        ...bucket,
        costUsd: 0.02,
        totals: { ...bucket.totals, uncachedInputTokens: 20 },
      })),
    };
    const merged = mergeHostUsageSummaries(
      input,
      [partial, complete],
      "2026-08-08T12:00:01.000Z",
      5,
    );

    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0]?.status).toBe("ok");
    expect(merged.buckets).toHaveLength(1);
    expect(merged.buckets[0]?.costUsd).toBe(0.02);
    expect(merged.buckets[0]?.totals.uncachedInputTokens).toBe(20);
  });

  it.effect("calls each physical provider host once across provider instances", () =>
    Effect.gen(function* () {
      const providerHostId = ProviderHostId.make("shared_host");
      const instanceIds = [ProviderInstanceId.make("codex_a"), ProviderInstanceId.make("codex_b")];
      let calls = 0;
      const instances = instanceIds.map((providerInstanceId) => {
        const usage: ProviderUsageAdapter = {
          providerHostId,
          providerInstanceId,
          readSummary: () =>
            Effect.sync(() => {
              calls += 1;
              return summary("host-a");
            }),
        };
        return { usage } as ProviderInstance;
      });
      const registry = {
        listInstances: Effect.succeed(instances),
      } as unknown as ProviderInstanceRegistryShape;
      const service = yield* make.pipe(Effect.provideService(ProviderInstanceRegistry, registry));

      const result = yield* service.readSummary(input);

      expect(calls).toBe(1);
      expect(result.coverage?.state).toBe("complete");
      expect(result.coverage?.hosts).toEqual([
        {
          providerHostId,
          providerInstanceIds: instanceIds,
          status: "reported",
          message: null,
        },
      ]);
    }),
  );

  it.effect("reports an explicit all-unsupported coverage state", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("old_codex");
      const usage: ProviderUsageAdapter = {
        providerHostId: ProviderHostId.make("old_host"),
        providerInstanceId,
        readSummary: () =>
          Effect.fail(new ProviderUsageError({ providerInstanceId, reason: "unsupported" })),
      };
      const registry = {
        listInstances: Effect.succeed([{ usage } as ProviderInstance]),
      } as unknown as ProviderInstanceRegistryShape;
      const service = yield* make.pipe(Effect.provideService(ProviderInstanceRegistry, registry));

      const result = yield* service.readSummary(input);

      expect(result.buckets).toEqual([]);
      expect(result.coverage?.state).toBe("allUnsupported");
      expect(result.coverage?.hosts[0]?.status).toBe("unsupported");
    }),
  );
});
