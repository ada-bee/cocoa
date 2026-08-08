// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
/** Bounded, streaming filesystem access for provider transcript scanning. */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  type UsageRecord,
} from "./usageTranscripts.ts";

export const DEFAULT_TRANSCRIPT_SCAN_LIMITS = {
  maxDirectories: 10_000,
  maxFiles: 50_000,
  maxBytes: 4_294_967_296,
  maxFileBytes: 134_217_728,
  maxRecordsPerFile: 200_000,
  maxRecords: 1_000_000,
  maxDurationMs: 20_000,
} as const;

export interface TranscriptScanLimits {
  readonly maxDirectories: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
  readonly maxRecordsPerFile: number;
  readonly maxRecords: number;
  readonly maxDurationMs: number;
}

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Stable, path-free diagnostic suitable for aggregation and wire messages. */
export type TranscriptScanIssue =
  | { readonly _tag: "ListDirectoryFailed"; readonly code: string }
  | { readonly _tag: "StatFileFailed"; readonly code: string }
  | { readonly _tag: "ReadFileFailed"; readonly code: string }
  | {
      readonly _tag: "ScanLimitReached";
      readonly limit: "directories" | "files" | "bytes" | "fileBytes" | "records" | "duration";
    };

export interface TranscriptFileList {
  readonly files: readonly TranscriptFile[];
  readonly visitedDirectories: number;
  readonly candidateBytes: number;
  readonly candidateFiles: number;
  /** Includes issues omitted from the bounded `issues` diagnostic sample. */
  readonly issueCount: number;
  readonly issues: readonly TranscriptScanIssue[];
  readonly complete: boolean;
}

const errorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && code.length > 0) return code.slice(0, 32);
  }
  return "UNKNOWN";
};

const deadlineError = Symbol("TranscriptScanDeadline");

const beforeDeadline = async <T>(promise: Promise<T>, deadlineMs: number): Promise<T> => {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw deadlineError;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(deadlineError), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Lists recent `.jsonl` files without allowing a pathological tree to consume
 * unbounded directories, file slots, bytes, or wall time. Issues deliberately
 * contain no path; callers can report partial coverage without leaking host
 * filesystem layout across the control boundary.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  limits: TranscriptScanLimits = DEFAULT_TRANSCRIPT_SCAN_LIMITS,
): Promise<TranscriptFileList> {
  const found: TranscriptFile[] = [];
  const issues: TranscriptScanIssue[] = [];
  const directories = [root];
  const deadlineMs = Date.now() + Math.max(1, limits.maxDurationMs);
  let visitedDirectories = 0;
  let candidateBytes = 0;
  let candidateFiles = 0;
  let issueCount = 0;
  const addIssue = (issue: TranscriptScanIssue): void => {
    issueCount += 1;
    if (issues.length < 64) issues.push(issue);
  };

  while (directories.length > 0) {
    if (Date.now() >= deadlineMs) {
      addIssue({ _tag: "ScanLimitReached", limit: "duration" });
      break;
    }
    if (visitedDirectories >= limits.maxDirectories) {
      addIssue({ _tag: "ScanLimitReached", limit: "directories" });
      break;
    }

    const dir = directories.shift();
    if (dir === undefined) break;
    visitedDirectories += 1;
    let directory: NodeFS.Dir | undefined;
    try {
      directory = await beforeDeadline(NodeFSP.opendir(dir), deadlineMs);
    } catch (error) {
      if (error === deadlineError) {
        addIssue({ _tag: "ScanLimitReached", limit: "duration" });
        break;
      }
      addIssue({ _tag: "ListDirectoryFailed", code: errorCode(error) });
      continue;
    }

    while (true) {
      let entry: NodeFS.Dirent | null;
      try {
        entry = await beforeDeadline(directory.read(), deadlineMs);
      } catch (error) {
        if (error === deadlineError) {
          addIssue({ _tag: "ScanLimitReached", limit: "duration" });
        } else {
          addIssue({ _tag: "ListDirectoryFailed", code: errorCode(error) });
        }
        directories.length = 0;
        break;
      }
      if (entry === null) break;
      if (entry.isDirectory()) {
        if (visitedDirectories + directories.length >= limits.maxDirectories) {
          addIssue({ _tag: "ScanLimitReached", limit: "directories" });
        } else {
          directories.push(NodePath.join(dir, entry.name));
        }
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      candidateFiles += 1;
      if (candidateFiles > limits.maxFiles) {
        addIssue({ _tag: "ScanLimitReached", limit: "files" });
        directories.length = 0;
        break;
      }
      const child = NodePath.join(dir, entry.name);
      try {
        const stats = await beforeDeadline(NodeFSP.stat(child), deadlineMs);
        if (stats.mtimeMs < sinceMs) continue;
        if (stats.size > limits.maxFileBytes) {
          addIssue({ _tag: "ScanLimitReached", limit: "fileBytes" });
          continue;
        }
        if (candidateBytes + stats.size > limits.maxBytes) {
          addIssue({ _tag: "ScanLimitReached", limit: "bytes" });
          directories.length = 0;
          break;
        }
        candidateBytes += stats.size;
        found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch (error) {
        if (error === deadlineError) {
          addIssue({ _tag: "ScanLimitReached", limit: "duration" });
          directories.length = 0;
          break;
        }
        addIssue({ _tag: "StatFileFailed", code: errorCode(error) });
      }
    }
    try {
      await directory.close();
    } catch {
      // Reading to the end auto-closes a Dir on Node/Bun.
    }
  }

  return {
    files: found,
    visitedDirectories,
    candidateBytes,
    candidateFiles,
    issueCount,
    issues,
    complete: issueCount === 0,
  };
}

/** Local directory identity. It must be hashed before crossing a boundary. */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "unavailable";
  }
}

export type TranscriptReadResult =
  | { readonly _tag: "Success"; readonly records: readonly UsageRecord[] }
  | { readonly _tag: "Failure"; readonly issue: TranscriptScanIssue };

/** Streams one transcript under an independent byte and time budget. */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
  options?: {
    readonly maxBytes?: number;
    readonly maxRecords?: number;
    readonly deadlineMs?: number;
  },
): Promise<TranscriptReadResult> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();
  const maxBytes = options?.maxBytes ?? DEFAULT_TRANSCRIPT_SCAN_LIMITS.maxFileBytes;
  const maxRecords = options?.maxRecords ?? DEFAULT_TRANSCRIPT_SCAN_LIMITS.maxRecordsPerFile;
  const deadlineMs =
    options?.deadlineMs ?? Date.now() + DEFAULT_TRANSCRIPT_SCAN_LIMITS.maxDurationMs;
  let bytesRead = 0;
  let limit: "bytes" | "duration" | null = null;
  const stream = NodeFS.createReadStream(filePath, { encoding: "utf8" });
  const timer = setTimeout(
    () => {
      limit = "duration";
      stream.destroy(new Error("transcript read deadline exceeded"));
    },
    Math.max(1, deadlineMs - Date.now()),
  );
  stream.on("data", (chunk: string | Buffer) => {
    bytesRead += Buffer.byteLength(chunk);
    if (bytesRead > maxBytes) {
      limit = "bytes";
      stream.destroy(new Error("transcript byte limit exceeded"));
    }
  });

  try {
    const lines = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) {
          if (records.length >= maxRecords) {
            return {
              _tag: "Failure",
              issue: { _tag: "ScanLimitReached", limit: "records" },
            };
          }
          records.push(record);
        }
        continue;
      }
      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) {
        if (records.length >= maxRecords) {
          return {
            _tag: "Failure",
            issue: { _tag: "ScanLimitReached", limit: "records" },
          };
        }
        records.push(record);
      }
    }
  } catch (error) {
    if (limit !== null) return { _tag: "Failure", issue: { _tag: "ScanLimitReached", limit } };
    return { _tag: "Failure", issue: { _tag: "ReadFileFailed", code: errorCode(error) } };
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }

  return { _tag: "Success", records };
}
