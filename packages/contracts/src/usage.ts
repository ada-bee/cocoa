/**
 * Usage reporting contract.
 *
 * Provider hosts scan their provider-owned transcript archive rather than
 * relying on Cocoa's orchestration projections, so usage includes turns that
 * were not driven through Cocoa. Cocoa's host implementation scans Codex.
 *
 * Environments return pre-aggregated `(source, day, provider, model)` buckets.
 * Source is an opaque identity used only for exact duplicate suppression; raw
 * transcript records never cross the wire.
 *
 * @module usage
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link UsageSummary} changes incompatibly. The
 * client renders partial coverage when an environment reports an older version
 * rather than failing the whole page.
 */
export const USAGE_CONTRACT_VERSION = 4 as const;
export const USAGE_MAX_WINDOW_DAYS = 90;
export const USAGE_MAX_BUCKETS = 25_000;
export const USAGE_MAX_SOURCES = 256;
export const USAGE_MAX_HOSTS = 256;
export const USAGE_MAX_INSTANCES_PER_HOST = 256;
export const USAGE_MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

export const UsageProviderKind = Schema.Literals(["claude", "codex"]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

/**
 * A calendar day in the reporting time zone, formatted `YYYY-MM-DD`.
 *
 * Days are bucketed server-side so that a turn always lands on the day the user
 * experienced it, not the UTC day.
 */
const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

/**
 * Why a bucket's cost is what it is.
 *
 * - `providerReported` - the transcript carried an explicit cost figure.
 * - `modelPriced` - we matched the model against a configured rate table.
 * - `unpriced` - tokens are known, rates are not. Counted in totals, excluded
 *   from cost.
 */
export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/**
 * Token counts for a bucket.
 *
 * `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 * `uncachedInputTokens`; summing all three gives total input. `reasoningTokens`
 * is a *subset* of `outputTokens` (Codex reports it that way, and Anthropic
 * folds thinking into output), so it must never be added on top.
 */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

/** Opaque provenance tying a bucket to one physical transcript source. */
export const UsageBucketSource = Schema.Struct({
  hostId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  sourceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type UsageBucketSource = typeof UsageBucketSource.Type;

/**
 * One `(source, day, provider, model)` cell. Clients normally recombine the
 * source dimension after claiming each physical source once.
 *
 * `costUsd` is the raw API-equivalent cost of these tokens. It is not money
 * spent: subscription plans bill separately. `unpricedRecords` counts records
 * whose tokens are included in the token totals but which contributed nothing
 * to `costUsd`.
 */
export const UsageBucket = Schema.Struct({
  source: UsageBucketSource,
  day: UsageDay,
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  /**
   * What the cached input would have cost at full input rates minus what it
   * actually cost. Requires the rate table, so it is computed alongside cost
   * rather than derived on the client.
   */
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  /** Distinct assistant responses, after de-duplication. */
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  /** Distinct transcript sessions that contributed to this cell. */
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

/**
 * Identifies the physical transcript directory a source read from without
 * exposing host filesystem paths or device/inode values.
 *
 * Two environments on the same machine (worktree servers, for example) resolve
 * the same provider home and would otherwise double count. The client drops
 * duplicate fingerprints before merging.
 */
export const UsageSourceFingerprint = Schema.Struct({
  /** Stable opaque installation identity generated and persisted by cocoa-hostd. */
  hostId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  provider: UsageProviderKind,
  /**
   * Stable opaque digest of the installation, provider, and local directory
   * identity. It supports duplicate suppression but cannot reveal the path.
   */
  sourceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** Human-readable, deliberately non-path label such as `Codex sessions`. */
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  /** Records that parsed but carried no recognisable usage payload. */
  malformedRecords: NonNegativeInt,
  /**
   * Distinct transcript sessions seen under this directory. Buckets also carry
   * per-bucket session counts, but a session spans days and models, so summing
   * those overcounts; this is the figure clients should total.
   */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

/**
 * Provenance for the rate table, so the UI can be honest about how good the
 * cost figures are.
 */
export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  fetchedAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

export const UsageSummaryInput = Schema.Struct({
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  /**
   * IANA zone the client wants days bucketed in. An offset would be wrong for
   * any window that crosses a DST boundary.
   */
  timeZone: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

/** Gateway-visible outcome for one physical provider host. */
export const UsageHostCoverageStatus = Schema.Literals([
  "reported",
  "unsupported",
  "failed",
  "incompatible",
]);
export type UsageHostCoverageStatus = typeof UsageHostCoverageStatus.Type;

export const UsageHostCoverage = Schema.Struct({
  providerHostId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  providerInstanceIds: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(USAGE_MAX_INSTANCES_PER_HOST),
  ),
  status: UsageHostCoverageStatus,
  message: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type UsageHostCoverage = typeof UsageHostCoverage.Type;

/**
 * Overall gateway coverage. A zero total is complete only when every physical
 * host reported successfully; callers must surface the other states.
 */
export const UsageCoverage = Schema.Struct({
  state: Schema.Literals(["complete", "partial", "allUnsupported"]),
  hosts: Schema.Array(UsageHostCoverage).check(Schema.isMaxLength(USAGE_MAX_HOSTS)),
});
export type UsageCoverage = typeof UsageCoverage.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String.check(Schema.isMaxLength(64)),
  timeZone: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: Schema.Array(UsageBucket).check(Schema.isMaxLength(USAGE_MAX_BUCKETS)),
  sources: Schema.Array(UsageSource).check(Schema.isMaxLength(USAGE_MAX_SOURCES)),
  pricing: UsagePricing,
  /** Wall-clock cost of the scan, surfaced in diagnostics. */
  scanDurationMs: NonNegativeInt,
  /** Present on gateway aggregates; absent on host-local scan responses. */
  coverage: Schema.optionalKey(UsageCoverage),
});
export type UsageSummary = typeof UsageSummary.Type;

export class UsageReadError extends Schema.TaggedErrorClass<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
