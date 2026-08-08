// @effect-diagnostics globalDate:off -- parsing typed calendar-day boundaries is deterministic.
/** Gateway aggregation for provider-host usage summaries. */
import {
  USAGE_CONTRACT_VERSION,
  USAGE_MAX_BUCKETS,
  USAGE_MAX_HOSTS,
  USAGE_MAX_INSTANCES_PER_HOST,
  USAGE_MAX_RESPONSE_BYTES,
  USAGE_MAX_SOURCES,
  USAGE_MAX_WINDOW_DAYS,
  type UsageBucket,
  type UsageSource,
  UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
  }
>()("t3/usage/UsageService") {}

const encodeUsageSummaryJson = Schema.encodeSync(Schema.fromJsonString(UsageSummary));

const emptySummary = (input: UsageSummaryInput): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "1970-01-01T00:00:00.000Z",
  timeZone: input.timeZone,
  sinceDay: input.sinceDay,
  untilDay: input.untilDay,
  buckets: [],
  sources: [],
  pricing: { status: "unavailable", source: "provider-host", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 0,
  coverage: { state: "allUnsupported", hosts: [] },
});

export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({ readSummary: (input) => Effect.succeed(emptySummary(input)) }),
);

const fingerprintKey = (source: UsageSource): string =>
  [source.fingerprint.hostId, source.fingerprint.provider, source.fingerprint.sourceId].join("\0");

const sourceCanContribute = (source: UsageSource): boolean =>
  source.status === "ok" || source.status === "partial";

const sourceQuality = (source: UsageSource): number =>
  source.status === "ok" ? 2 : source.status === "partial" ? 1 : 0;

/** Merge host summaries while claiming each physical provider transcript directory once. */
export function mergeHostUsageSummaries(
  input: UsageSummaryInput,
  summaries: ReadonlyArray<UsageSummary>,
  readAt: string,
  scanDurationMs: number,
  coverage: UsageSummary["coverage"] = { state: "complete", hosts: [] },
): UsageSummary {
  const claimed = new Map<
    string,
    { readonly source: UsageSource; readonly summaryIndex: number; readonly quality: number }
  >();
  const buckets: UsageBucket[] = [];
  let pricing: UsageSummary["pricing"] = {
    status: "unavailable",
    source: "provider-host",
    fetchedAt: null,
    knownModels: 0,
  };

  for (const [summaryIndex, summary] of summaries.entries()) {
    for (const source of summary.sources) {
      const key = fingerprintKey(source);
      const quality = sourceQuality(source);
      const existing = claimed.get(key);
      if (existing === undefined) {
        if (claimed.size >= USAGE_MAX_SOURCES) {
          throw new RangeError("Provider usage aggregation exceeded its source limit.");
        }
        claimed.set(key, { source, summaryIndex, quality });
      } else if (quality > existing.quality) {
        claimed.set(key, { source, summaryIndex, quality });
      }
    }
  }

  for (const [summaryIndex, summary] of summaries.entries()) {
    const ownedSources = new Set(
      [...claimed].flatMap(([key, winner]) =>
        winner.summaryIndex === summaryIndex && sourceCanContribute(winner.source) ? [key] : [],
      ),
    );
    buckets.push(
      ...summary.buckets.filter((bucket) =>
        ownedSources.has(
          [bucket.source.hostId, bucket.provider, bucket.source.sourceId].join("\0"),
        ),
      ),
    );
    if (buckets.length > USAGE_MAX_BUCKETS) {
      throw new RangeError("Provider usage aggregation exceeded its bucket limit.");
    }

    const rank = { unavailable: 0, cached: 1, fresh: 2 } as const;
    if (
      rank[summary.pricing.status] > rank[pricing.status] ||
      (rank[summary.pricing.status] === rank[pricing.status] &&
        summary.pricing.knownModels > pricing.knownModels)
    ) {
      pricing = summary.pricing;
    }
  }

  const sources = [...claimed.values()].map(({ source }) => source);

  buckets.sort(
    (left, right) =>
      left.day.localeCompare(right.day) ||
      left.provider.localeCompare(right.provider) ||
      left.model.localeCompare(right.model) ||
      left.source.hostId.localeCompare(right.source.hostId) ||
      left.source.sourceId.localeCompare(right.source.sourceId),
  );
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt,
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    buckets,
    sources,
    pricing,
    scanDurationMs,
    coverage,
  };
}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }
    const sinceMs = Date.parse(`${input.sinceDay}T00:00:00Z`);
    const untilMs = Date.parse(`${input.untilDay}T00:00:00Z`);
    if (untilMs - sinceMs >= USAGE_MAX_WINDOW_DAYS * 86_400_000) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `Usage windows may not exceed ${USAGE_MAX_WINDOW_DAYS} days.`,
      });
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    const instances = yield* registry.listInstances;
    const adaptersByHost = new Map<
      string,
      {
        readonly adapter: NonNullable<(typeof instances)[number]["usage"]>;
        readonly providerInstanceIds: string[];
      }
    >();
    for (const instance of instances) {
      const adapter = instance.usage;
      if (adapter === undefined) continue;
      const hostId = adapter.providerHostId;
      const existing = adaptersByHost.get(hostId);
      if (existing === undefined) {
        if (adaptersByHost.size >= USAGE_MAX_HOSTS) {
          return yield* new UsageReadError({
            reason: "scanFailed",
            detail: "Provider usage aggregation exceeded its host limit.",
          });
        }
        adaptersByHost.set(hostId, {
          adapter,
          providerInstanceIds: [adapter.providerInstanceId],
        });
      } else if (!existing.providerInstanceIds.includes(adapter.providerInstanceId)) {
        if (existing.providerInstanceIds.length >= USAGE_MAX_INSTANCES_PER_HOST) {
          return yield* new UsageReadError({
            reason: "scanFailed",
            detail: "Provider usage aggregation exceeded its per-host instance limit.",
          });
        }
        existing.providerInstanceIds.push(adapter.providerInstanceId);
      }
    }
    const hostRequests = [...adaptersByHost.entries()];
    const results = yield* Effect.forEach(
      hostRequests,
      ([, host]) => host.adapter.readSummary(input).pipe(Effect.result),
      { concurrency: 4 },
    );
    const summaries: UsageSummary[] = [];
    const hosts = results.map((result, index) => {
      const [providerHostId, request] = hostRequests[index]!;
      if (result._tag === "Success") {
        if (result.success.contractVersion === USAGE_CONTRACT_VERSION) {
          summaries.push(result.success);
          return {
            providerHostId,
            providerInstanceIds: request.providerInstanceIds,
            status: "reported" as const,
            message: null,
          };
        }
        return {
          providerHostId,
          providerInstanceIds: request.providerInstanceIds,
          status: "incompatible" as const,
          message: "Provider host returned an incompatible usage contract version.",
        };
      }
      return {
        providerHostId,
        providerInstanceIds: request.providerInstanceIds,
        status:
          result.failure.reason === "unsupported" ? ("unsupported" as const) : ("failed" as const),
        message:
          result.failure.reason === "unsupported"
            ? "Provider host does not support transcript usage reporting."
            : "Provider host could not report transcript usage.",
      };
    });
    const reportedHosts = hosts.filter((host) => host.status === "reported").length;
    const coverage = {
      state:
        hosts.length === 0 || hosts.every((host) => host.status === "unsupported")
          ? ("allUnsupported" as const)
          : reportedHosts === hosts.length
            ? ("complete" as const)
            : ("partial" as const),
      hosts,
    };

    const now = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    return yield* Effect.try({
      try: () => {
        const summary = mergeHostUsageSummaries(
          input,
          summaries,
          DateTime.formatIso(now),
          Math.max(0, finishedAtMs - startedAtMs),
          coverage,
        );
        const encodedBytes = new TextEncoder().encode(encodeUsageSummaryJson(summary)).byteLength;
        if (encodedBytes > USAGE_MAX_RESPONSE_BYTES) {
          throw new RangeError("Provider usage aggregation exceeded its encoded byte limit.");
        }
        return summary;
      },
      catch: (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Provider usage aggregation exceeded its response limits.",
          cause,
        }),
    });
  });

  return { readSummary } as const;
});

export const layer = Layer.effect(UsageService, make);
