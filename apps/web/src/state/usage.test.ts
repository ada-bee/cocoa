import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSourceStatus,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveUsageViewStatus, type EnvironmentUsageStatus } from "./usage";

const summary = (status: UsageSourceStatus): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-08T12:00:00.000Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-08-08"),
  untilDay: UsageDay.make("2026-08-08"),
  buckets: [],
  sources: [
    {
      fingerprint: {
        hostId: "host-installation",
        provider: "codex",
        sourceId: "source",
        label: "Codex sessions",
      },
      status,
      scannedFiles: 0,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 0,
      message: status === "ok" ? null : "Transcript source is incomplete.",
    },
  ],
  pricing: { status: "unavailable", source: "offline", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 1,
  coverage: {
    state: "complete",
    hosts: [
      {
        providerHostId: "host",
        providerInstanceIds: ["codex"],
        status: "reported",
        message: null,
      },
    ],
  },
});

const environment = (status: UsageSourceStatus): EnvironmentUsageStatus => ({
  environmentId: EnvironmentId.make("gateway"),
  label: "Gateway",
  isPending: false,
  error: null,
  summary: summary(status),
});

describe("usage view source health", () => {
  it("marks a partial source as usable but incomplete", () => {
    expect(deriveUsageViewStatus([environment("partial")])).toEqual({
      isPending: false,
      isPartial: true,
      isUnavailable: false,
    });
  });

  it("does not present all failed or missing sources as genuine zero usage", () => {
    for (const status of ["failed", "missing"] as const) {
      expect(deriveUsageViewStatus([environment(status)])).toEqual({
        isPending: false,
        isPartial: true,
        isUnavailable: true,
      });
    }
  });

  it("keeps a complete zero scan available", () => {
    expect(deriveUsageViewStatus([environment("ok")])).toEqual({
      isPending: false,
      isPartial: false,
      isUnavailable: false,
    });
  });
});
