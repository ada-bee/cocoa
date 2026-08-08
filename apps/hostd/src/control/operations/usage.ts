// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off - usage is intentionally scanned on the provider host.
/* eslint-disable t3code/no-global-process-runtime -- standalone hostd reads the provider CLI environment. */

import {
  USAGE_CONTRACT_VERSION,
  USAGE_MAX_BUCKETS,
  USAGE_MAX_WINDOW_DAYS,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  UsageAggregator,
  DEFAULT_TRANSCRIPT_SCAN_LIMITS,
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  listTranscriptFiles,
  parseRateTable,
  pruneScanCache,
  readDirectoryVolumeId,
  readTranscriptRecords,
  type RateTable,
  type ScanCache,
  type TranscriptScanIssue,
  type TranscriptScanLimits,
  type UsageRecord,
} from "@t3tools/host-runtime/usage";
import { createHash, randomUUID } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const CACHE_RETENTION_DAYS = 90;
const MAX_PENDING_SCANS = 8;
const MAX_SCAN_DURATION_MS = 30_000;
const MAX_RATES_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_FILES = 50_000;
const MAX_CACHED_RECORDS = 1_000_000;
const MAX_ESTIMATED_CACHE_BYTES = 128 * 1024 * 1024;

export interface HostUsageReaderOptions {
  readonly homePath: string;
  readonly codexHomePath?: string;
  readonly cacheDirectory?: string;
  /** Explicit stable identity for tests/embedded hosts; normally persisted automatically. */
  readonly installationId?: string;
  readonly scanLimits?: Partial<TranscriptScanLimits>;
  /** Explicit administrator-provided rate loader; omitted in offline/default operation. */
  readonly fetchRates?: () => Promise<unknown | null>;
  readonly pricingSource?: string;
}

export interface HostUsageReader {
  readonly readSummary: (input: UsageSummaryInput) => Promise<UsageSummary>;
}

const readJson = async (path: string, maxBytes: number): Promise<unknown | null> => {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(path, "r");
    const stats = await handle.stat();
    if (stats.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(1, stats.size + 1)));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) return null;
    return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const readBoundedText = async (path: string, maxBytes: number): Promise<string | null> => {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(path, "r");
    const stats = await handle.stat();
    if (stats.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > maxBytes ? null : buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const compactIssues = (
  issues: readonly TranscriptScanIssue[],
  issueCount = issues.length,
): string | null => {
  if (issueCount === 0) return null;
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const key =
      issue._tag === "ScanLimitReached" ? `limit:${issue.limit}` : `${issue._tag}:${issue.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const details = [...counts]
    .slice(0, 6)
    .map(([key, count]) => `${key}${count > 1 ? ` x${count}` : ""}`)
    .join(", ");
  return `Partial transcript scan (${issueCount} issue${issueCount === 1 ? "" : "s"}): ${details}`.slice(
    0,
    512,
  );
};

const writeJson = async (
  path: string,
  value: unknown,
  maxBytes = MAX_SCAN_CACHE_BYTES,
): Promise<void> => {
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > maxBytes) return;
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    await NodeFSP.writeFile(path, encoded, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Cache persistence only affects the next scan's speed.
  }
};

const inspectDirectory = async (path: string): Promise<"present" | "missing" | "inaccessible"> => {
  try {
    return (await NodeFSP.stat(path)).isDirectory() ? "present" : "missing";
  } catch (error) {
    return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT"
      ? "missing"
      : "inaccessible";
  }
};

/**
 * Host-local adaptation of upstream's UsageService. Provider transcript paths
 * never leave cocoa-hostd; only bounded, pre-aggregated daily buckets cross
 * the gateway boundary.
 */
export const makeHostUsageReader = (options: HostUsageReaderOptions): HostUsageReader => {
  const codexHomePath =
    options.codexHomePath ??
    (process.env.CODEX_HOME?.trim() || NodePath.join(options.homePath, ".codex"));
  const cacheDirectory =
    options.cacheDirectory ?? NodePath.join(codexHomePath, "app-server-control");
  const ratesCachePath = NodePath.join(cacheDirectory, "usage-model-rates.json");
  const scanCachePath = NodePath.join(cacheDirectory, "usage-scan-cache.json");
  const installationIdPath = NodePath.join(cacheDirectory, "host-installation-id");
  const scanLimits: TranscriptScanLimits = {
    ...DEFAULT_TRANSCRIPT_SCAN_LIMITS,
    ...options.scanLimits,
  };
  const fileCache: ScanCache = new Map();
  let scanCacheLoaded = false;
  let cachedRecords = 0;
  let estimatedCacheBytes = 0;
  let cacheDirty = false;
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";
  let scanQueue = Promise.resolve<unknown>(undefined);
  const pendingScans = new Map<string, Promise<UsageSummary>>();

  const installationIdPromise = (async (): Promise<string> => {
    if (options.installationId?.trim()) return options.installationId.trim().slice(0, 256);
    try {
      const existing = (await readBoundedText(installationIdPath, 512))?.trim() ?? "";
      if (/^[a-zA-Z0-9_-]{8,256}$/.test(existing)) return existing;
    } catch {
      // First run or an unreadable legacy identity: generate an in-memory fallback.
    }
    const generated = randomUUID();
    try {
      await NodeFSP.mkdir(NodePath.dirname(installationIdPath), { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(installationIdPath, generated, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return generated;
    } catch {
      try {
        const raced = (await readBoundedText(installationIdPath, 512))?.trim() ?? "";
        if (/^[a-zA-Z0-9_-]{8,256}$/.test(raced)) return raced;
      } catch {
        // The generated value remains stable for this daemon lifetime.
      }
      return generated;
    }
  })();

  const sourceFingerprint = async (
    provider: UsageProviderKind,
    dir: string,
  ): Promise<UsageSource["fingerprint"]> => {
    const [hostId, directoryIdentity] = await Promise.all([
      installationIdPromise,
      readDirectoryVolumeId(dir),
    ]);
    return {
      hostId,
      provider,
      sourceId: createHash("sha256")
        .update(`cocoa-usage-source-v1\0${hostId}\0${provider}\0${directoryIdentity}`)
        .digest("hex"),
      label: provider === "codex" ? "Codex sessions" : "Claude projects",
    };
  };

  const ensureRates = async (now: number): Promise<void> => {
    if (options.fetchRates === undefined) return;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;
    if (ratesFetchedAtMs === null) {
      const cached = await readJson(ratesCachePath, MAX_RATES_DOCUMENT_BYTES);
      if (typeof cached === "object" && cached !== null) {
        const fetchedAtMs = Reflect.get(cached, "fetchedAtMs");
        const document = Reflect.get(cached, "document");
        if (typeof fetchedAtMs === "number") {
          const parsed = parseRateTable(document);
          if (parsed.size > 0) {
            rates = parsed;
            ratesFetchedAtMs = fetchedAtMs;
            ratesStatus = "cached";
            if (now - fetchedAtMs < RATES_TTL_MS) return;
          }
        }
      }
    }

    const document = await options.fetchRates();
    if (document === null) {
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }
    const parsed = parseRateTable(document);
    if (parsed.size === 0) return;
    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";
    await writeJson(ratesCachePath, { fetchedAtMs: now, document }, MAX_RATES_DOCUMENT_BYTES);
  };

  const ensureScanCache = async (): Promise<void> => {
    if (scanCacheLoaded) return;
    const decoded = decodeScanCache(await readJson(scanCachePath, MAX_SCAN_CACHE_BYTES));
    for (const [path, entry] of decoded) {
      const entryBytes = entry.records.reduce(
        (total, record) =>
          total +
          128 +
          record.model.length * 2 +
          record.sessionId.length * 2 +
          (record.dedupeKey?.length ?? 0) * 2,
        0,
      );
      if (
        fileCache.size >= MAX_CACHED_FILES ||
        cachedRecords + entry.records.length > MAX_CACHED_RECORDS ||
        estimatedCacheBytes + entryBytes > MAX_ESTIMATED_CACHE_BYTES
      ) {
        break;
      }
      fileCache.set(path, entry);
      cachedRecords += entry.records.length;
      estimatedCacheBytes += entryBytes;
    }
    scanCacheLoaded = true;
  };

  const readFileRecords = async (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    deadlineMs: number,
  ): Promise<
    | { readonly _tag: "Success"; readonly records: readonly UsageRecord[] }
    | { readonly _tag: "Failure"; readonly issue: TranscriptScanIssue }
  > => {
    const cached = fileCache.get(filePath);
    if (cached?.size === size && cached.mtimeMs === mtimeMs && cached.provider === provider) {
      return { _tag: "Success", records: cached.records };
    }
    const parsed = await readTranscriptRecords(filePath, provider, {
      maxBytes: Math.min(scanLimits.maxFileBytes, size + 64 * 1024),
      maxRecords: scanLimits.maxRecordsPerFile,
      deadlineMs,
    });
    if (parsed._tag === "Failure") return parsed;
    const records = dedupeWithinFile(parsed.records);
    const estimatedBytes = records.reduce(
      (total, record) =>
        total +
        128 +
        record.model.length * 2 +
        record.sessionId.length * 2 +
        (record.dedupeKey?.length ?? 0) * 2,
      0,
    );
    if (
      fileCache.size < MAX_CACHED_FILES &&
      cachedRecords + records.length <= MAX_CACHED_RECORDS &&
      estimatedCacheBytes + estimatedBytes <= MAX_ESTIMATED_CACHE_BYTES
    ) {
      const replaced = fileCache.get(filePath);
      if (replaced !== undefined) {
        cachedRecords -= replaced.records.length;
        estimatedCacheBytes -= replaced.records.reduce(
          (total, record) =>
            total +
            128 +
            record.model.length * 2 +
            record.sessionId.length * 2 +
            (record.dedupeKey?.length ?? 0) * 2,
          0,
        );
      }
      fileCache.set(filePath, { size, mtimeMs, provider, records });
      cachedRecords += records.length;
      estimatedCacheBytes += estimatedBytes;
      cacheDirty = true;
    }
    return { _tag: "Success", records };
  };

  const scan = async (input: UsageSummaryInput): Promise<UsageSummary> => {
    if (input.sinceDay > input.untilDay) {
      throw new Error(`sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`);
    }
    const startedAtMs = Date.now();
    await Promise.all([ensureRates(startedAtMs), ensureScanCache()]);

    const dirs: ReadonlyArray<{ provider: UsageProviderKind; dir: string }> = [
      { provider: "codex", dir: NodePath.join(codexHomePath, "sessions") },
    ];
    const windowStartMs = Date.parse(`${input.sinceDay}T00:00:00Z`) - MTIME_SLACK_MS;
    const windowEndMs = Date.parse(`${input.untilDay}T00:00:00Z`);
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
      throw new Error(`sinceDay '${input.sinceDay}' is not a valid date`);
    }
    if (windowEndMs - (windowStartMs + MTIME_SLACK_MS) >= USAGE_MAX_WINDOW_DAYS * 86_400_000) {
      throw new Error(`Usage windows may not exceed ${USAGE_MAX_WINDOW_DAYS} days.`);
    }

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      rates,
    });
    const sources: UsageSource[] = [];
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];
    const scanDeadlineMs = Date.now() + MAX_SCAN_DURATION_MS;
    let scannedRecords = 0;

    for (const { provider, dir } of dirs) {
      const fingerprint = await sourceFingerprint(provider, dir);
      const directoryStatus = await inspectDirectory(dir);
      if (directoryStatus === "missing") {
        sources.push({
          fingerprint,
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "No transcript directory on this provider host.",
        });
        continue;
      }
      if (directoryStatus === "inaccessible") {
        sources.push({
          fingerprint,
          status: "failed",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "Transcript directory could not be inspected on this provider host.",
        });
        continue;
      }

      const listing = await listTranscriptFiles(dir, windowStartMs, {
        ...scanLimits,
        maxDurationMs: Math.max(1, Math.min(scanLimits.maxDurationMs, scanDeadlineMs - Date.now())),
      });
      if (listing.complete) walkedRoots.push(dir);
      const issues: TranscriptScanIssue[] = [...listing.issues];
      let issueCount = listing.issueCount;
      let scannedFiles = 0;
      let skippedFiles = 0;
      const sessionIds = new Set<string>();
      for (const file of listing.files) {
        if (Date.now() >= scanDeadlineMs) {
          issues.push({ _tag: "ScanLimitReached", limit: "duration" });
          issueCount += 1;
          break;
        }
        livePaths.add(file.path);
        const result = await readFileRecords(
          file.path,
          file.size,
          file.mtimeMs,
          provider,
          scanDeadlineMs,
        );
        if (result._tag === "Failure") {
          if (issues.length < 64) issues.push(result.issue);
          issueCount += 1;
          skippedFiles += 1;
          continue;
        }
        const { records } = result;
        if (scannedRecords + records.length > scanLimits.maxRecords) {
          if (issues.length < 64) issues.push({ _tag: "ScanLimitReached", limit: "records" });
          issueCount += 1;
          skippedFiles += 1;
          break;
        }
        scannedRecords += records.length;
        if (records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const record of records) {
          if (aggregator.add(record, fingerprint) && record.sessionId.length > 0)
            sessionIds.add(record.sessionId);
        }
      }
      sources.push({
        fingerprint,
        status: issueCount > 0 ? "partial" : "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message: compactIssues(issues, issueCount),
      });
    }

    if (
      pruneScanCache(fileCache, {
        livePaths,
        walkedRoots,
        windowStartMs,
        retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      }) > 0
    ) {
      cacheDirty = true;
    }
    if (cacheDirty) {
      await writeJson(scanCachePath, encodeScanCache(fileCache));
      cacheDirty = false;
    }

    const buckets = aggregator.finish().buckets;
    if (buckets.length > USAGE_MAX_BUCKETS) {
      throw new Error("Provider usage aggregation exceeded its bucket limit.");
    }
    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: new Date().toISOString(),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets,
      sources,
      pricing: {
        status: ratesStatus,
        source:
          options.fetchRates === undefined ? "offline" : (options.pricingSource ?? "configured"),
        fetchedAt: ratesFetchedAtMs === null ? null : new Date(ratesFetchedAtMs).toISOString(),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, Date.now() - startedAtMs),
    };
  };

  return {
    readSummary: (input) => {
      const key = `${input.sinceDay}\0${input.untilDay}\0${input.timeZone}`;
      const existing = pendingScans.get(key);
      if (existing !== undefined) return existing;
      if (pendingScans.size >= MAX_PENDING_SCANS) {
        return Promise.reject(new Error("Too many usage scans are already queued."));
      }
      const next = scanQueue.then(
        () => scan(input),
        () => scan(input),
      );
      pendingScans.set(key, next);
      scanQueue = next.catch(() => undefined);
      void next.finally(() => pendingScans.delete(key)).catch(() => undefined);
      return next;
    },
  };
};
