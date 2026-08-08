import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasIncompleteUsageSources,
  hasNoReportedUsageCoverage,
  mergeUsage,
  type EnvironmentUsage,
} from "./usageMerge";

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    source: { hostId: "default-host", sourceId: "default-source" },
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly {
    provider: UsageProviderKind;
    hostId: string;
    homePath: string;
    volumeId?: string;
    distinctSessions?: number;
    status?: "ok" | "missing" | "partial" | "failed";
    message?: string | null;
  }[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets: buckets.map((item) => {
      if (item.source.hostId !== "default-host") return item;
      const source = sources.find((candidate) => candidate.provider === item.provider);
      return source === undefined
        ? item
        : {
            ...item,
            source: {
              hostId: source.hostId,
              sourceId: `${source.volumeId ?? `vol-${source.hostId}`}:${source.homePath}`,
            },
          };
    }),
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        sourceId: `${source.volumeId ?? `vol-${source.hostId}`}:${source.homePath}`,
        label: `${source.provider} sessions`,
      },
      status: source.status ?? ("ok" as const),
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: source.message ?? null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("mergeUsage", () => {
  it("sums environments that read different transcript directories", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }]),
        ),
        environment(
          "env-b",
          summary([bucket()], [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.records).toBe(10);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("counts a shared transcript directory once", () => {
    // Two worktree servers on one machine resolve the same provider home.
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [shared])),
        environment("env-b", summary([bucket()], [shared])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
  });

  it("prefers a complete duplicate source over an earlier partial environment", () => {
    const shared = {
      provider: "codex" as const,
      hostId: "host-1",
      homePath: "/one/.codex",
    };
    const partial = summary(
      [bucket({ provider: "codex", costUsd: 7 })],
      [{ ...shared, status: "partial", message: "Bounded scan stopped early." }],
    );
    const complete = summary([bucket({ provider: "codex", costUsd: 10 })], [shared]);
    const merged = mergeUsage(
      [environment("env-a", partial), environment("env-z", complete)],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.contributingEnvironments).toEqual(["env-z"]);
    expect(merged.duplicateSources).toContain("env-a: codex sessions");
  });

  it("deduplicates an overlapping source without dropping a distinct same-provider host", () => {
    const h1 = {
      provider: "codex" as const,
      hostId: "host-1",
      homePath: "/one/.codex",
      volumeId: "vol-1",
    };
    const h2 = {
      provider: "codex" as const,
      hostId: "host-2",
      homePath: "/two/.codex",
      volumeId: "vol-2",
    };
    const forSource = (source: typeof h1): UsageBucket =>
      bucket({
        provider: "codex",
        model: "gpt-5.6-sol",
        source: {
          hostId: source.hostId,
          sourceId: `${source.volumeId}:${source.homePath}`,
        },
      });
    const merged = mergeUsage(
      [
        // Stable id ordering lets the subset claim H1 before the aggregate.
        environment("env-a", summary([forSource(h1)], [h1])),
        environment("env-z", summary([forSource(h1), forSource(h2)], [h1, h2])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.records).toBe(10);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments.toSorted()).toEqual(["env-a", "env-z"]);
  });

  it("drops only the duplicated provider, keeping the environment's other one", () => {
    const sharedClaude = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [sharedClaude])),
        environment(
          "env-b",
          summary(
            [bucket(), bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 })],
            [sharedClaude, { provider: "codex", hostId: "mac", homePath: "/home/theo/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    // env-b's claude bucket is dropped, its codex bucket survives.
    expect(merged.costUsd).toBe(14);
    expect(merged.providers.map((provider) => provider.provider).sort()).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("excludes an environment reporting an older contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.staleEnvironments).toEqual(["env-b"]);
  });

  it("derives provider shares and cost quality", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 25, unpricedRecords: 5 }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers[0]?.provider).toBe("claude");
    expect(merged.providers[0]?.costShare).toBeCloseTo(0.75, 5);
    expect(merged.costQuality.unpricedShare).toBeCloseTo(0.5, 5);
    expect(merged.costQuality.cacheSavingsUsd).toBe(4);
  });

  it("keeps two machines apart when hostname and home path collide", () => {
    // Every Mac resolves /Users/theo/.claude, so a hostname clash used to make
    // one machine's usage vanish. Filesystem identity separates them.
    const shape = { provider: "claude" as const, hostId: "mac", homePath: "/Users/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [{ ...shape, volumeId: "16777220:1234" }])),
        environment("env-b", summary([bucket()], [{ ...shape, volumeId: "16777221:9999" }])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("still collapses two servers reading the same directory", () => {
    const same = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/Users/theo/.claude",
      volumeId: "16777220:1234",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [same])),
        environment("env-b", summary([bucket()], [same])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("totals sessions from per-directory distinct counts, not per-bucket sums", () => {
    // One session that spans two days appears in two buckets. Summing bucket
    // sessions would say 2; the source's distinct count says 1.
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ day: "2026-08-06" as UsageDay }), bucket({ day: "2026-08-07" as UsageDay })],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 1,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.sessions).toBe(1);
  });

  it("returns empty totals with no environments", () => {
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.daily).toHaveLength(0);
  });
});

describe("hasNoReportedUsageCoverage", () => {
  it("distinguishes unavailable coverage from complete zero usage", () => {
    const unavailable: UsageSummary = {
      ...summary([], []),
      coverage: {
        state: "allUnsupported",
        hosts: [
          {
            providerHostId: "old_host",
            providerInstanceIds: ["codex"],
            status: "unsupported",
            message: "Upgrade hostd.",
          },
        ],
      },
    };
    const complete: UsageSummary = {
      ...summary([], []),
      coverage: {
        state: "complete",
        hosts: [
          {
            providerHostId: "new_host",
            providerInstanceIds: ["codex"],
            status: "reported",
            message: null,
          },
        ],
      },
    };

    expect(hasNoReportedUsageCoverage([environment("old", unavailable)])).toBe(true);
    expect(hasNoReportedUsageCoverage([environment("new", complete)])).toBe(false);
    expect(hasNoReportedUsageCoverage([])).toBe(false);
  });

  it("treats partial sources as usable but incomplete", () => {
    const partial = summary(
      [],
      [
        {
          provider: "codex",
          hostId: "host",
          homePath: "/opaque",
          status: "partial",
          message: "Bounded scan stopped early.",
        },
      ],
    );

    expect(hasNoReportedUsageCoverage([environment("partial", partial)])).toBe(false);
    expect(hasIncompleteUsageSources([environment("partial", partial)])).toBe(true);
  });

  it("treats all failed or missing sources as unavailable", () => {
    for (const status of ["failed", "missing"] as const) {
      const unavailable = summary(
        [],
        [
          {
            provider: "codex",
            hostId: "host",
            homePath: "/opaque",
            status,
            message: "Source unavailable.",
          },
        ],
      );
      expect(hasNoReportedUsageCoverage([environment(status, unavailable)])).toBe(true);
      expect(hasIncompleteUsageSources([environment(status, unavailable)])).toBe(true);
    }
  });
});
