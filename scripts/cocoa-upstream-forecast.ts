#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off - This repository-maintenance CLI runs Git and reads its ledger before an Effect runtime exists.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export type IntakeClassification = "imported" | "skipped" | "deferred";

export interface IntakeCommit {
  readonly sha: string;
  readonly classification: IntakeClassification;
  readonly reason: string;
  readonly cocoaCommit?: string;
}

export interface IntakeHorizon {
  readonly reviewedAt: string;
  readonly fromExclusive: string;
  readonly throughInclusive: string;
  readonly commits: ReadonlyArray<IntakeCommit>;
}

export interface UpstreamIntakeLedger {
  readonly version: 1;
  readonly remote: string;
  readonly upstreamRef: string;
  readonly targetRef: string;
  readonly baseTag: string;
  readonly baseCommit: string;
  readonly horizons: ReadonlyArray<IntakeHorizon>;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  readonly run: (args: ReadonlyArray<string>) => GitCommandResult;
}

export interface ForecastCommit extends IntakeCommit {
  readonly subject: string;
  readonly conflict: boolean;
}

export interface UpstreamForecast {
  readonly baseTag: string;
  readonly baseCommit: string;
  readonly targetRef: string;
  readonly targetCommit: string;
  readonly upstreamRef: string;
  readonly upstreamCommit: string;
  readonly reviewedThrough: string;
  readonly classified: ReadonlyArray<ForecastCommit>;
  readonly unreviewed: ReadonlyArray<{
    readonly sha: string;
    readonly subject: string;
    readonly conflict: boolean;
  }>;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const REVIEW_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLASSIFICATIONS = new Set<IntakeClassification>(["imported", "skipped", "deferred"]);

const fail = (message: string): never => {
  throw new Error(message);
};

const expectString = (value: unknown, field: string): string =>
  typeof value === "string" && value.length > 0
    ? value
    : fail(`${field} must be a non-empty string`);

const expectFullSha = (value: unknown, field: string): string => {
  const sha = expectString(value, field);
  return FULL_SHA.test(sha) ? sha : fail(`${field} must be a full lowercase Git commit SHA`);
};

const expectObject = (value: unknown, field: string): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(`${field} must be an object`);

const expectArray = (value: unknown, field: string): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : fail(`${field} must be an array`);

export const parseUpstreamIntakeLedger = (value: unknown): UpstreamIntakeLedger => {
  const ledger = expectObject(value, "ledger");
  if (ledger.version !== 1) fail("ledger.version must be 1");

  const horizons = expectArray(ledger.horizons, "ledger.horizons").map((rawHorizon, index) => {
    const horizon = expectObject(rawHorizon, `ledger.horizons[${index}]`);
    const reviewedAt = expectString(horizon.reviewedAt, `ledger.horizons[${index}].reviewedAt`);
    if (!REVIEW_DATE.test(reviewedAt)) {
      fail(`ledger.horizons[${index}].reviewedAt must use YYYY-MM-DD`);
    }
    const commits = expectArray(horizon.commits, `ledger.horizons[${index}].commits`).map(
      (rawCommit, commitIndex) => {
        const prefix = `ledger.horizons[${index}].commits[${commitIndex}]`;
        const commit = expectObject(rawCommit, prefix);
        const classification = expectString(commit.classification, `${prefix}.classification`);
        if (!CLASSIFICATIONS.has(classification as IntakeClassification)) {
          fail(`${prefix}.classification must be imported, skipped, or deferred`);
        }
        const parsed: IntakeCommit = {
          sha: expectFullSha(commit.sha, `${prefix}.sha`),
          classification: classification as IntakeClassification,
          reason: expectString(commit.reason, `${prefix}.reason`),
          ...(commit.cocoaCommit === undefined
            ? {}
            : { cocoaCommit: expectFullSha(commit.cocoaCommit, `${prefix}.cocoaCommit`) }),
        };
        if (parsed.classification === "imported" && parsed.cocoaCommit === undefined) {
          fail(`${prefix}.cocoaCommit is required for imported commits`);
        }
        if (parsed.classification !== "imported" && parsed.cocoaCommit !== undefined) {
          fail(`${prefix}.cocoaCommit is only valid for imported commits`);
        }
        return parsed;
      },
    );
    return {
      reviewedAt,
      fromExclusive: expectFullSha(
        horizon.fromExclusive,
        `ledger.horizons[${index}].fromExclusive`,
      ),
      throughInclusive: expectFullSha(
        horizon.throughInclusive,
        `ledger.horizons[${index}].throughInclusive`,
      ),
      commits,
    } satisfies IntakeHorizon;
  });

  if (horizons.length === 0) fail("ledger.horizons must contain at least one reviewed horizon");
  return {
    version: 1,
    remote: expectString(ledger.remote, "ledger.remote"),
    upstreamRef: expectString(ledger.upstreamRef, "ledger.upstreamRef"),
    targetRef: expectString(ledger.targetRef, "ledger.targetRef"),
    baseTag: expectString(ledger.baseTag, "ledger.baseTag"),
    baseCommit: expectFullSha(ledger.baseCommit, "ledger.baseCommit"),
    horizons,
  };
};

const runOrFail = (git: GitRunner, args: ReadonlyArray<string>): string => {
  const result = git.run(args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    return fail(`git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
};

const revParse = (git: GitRunner, ref: string): string =>
  expectFullSha(runOrFail(git, ["rev-parse", `${ref}^{commit}`]), `resolved ref ${ref}`);

const listCommits = (git: GitRunner, range: string): ReadonlyArray<string> => {
  const output = runOrFail(git, ["rev-list", "--reverse", "--topo-order", range]);
  return output === ""
    ? []
    : output.split("\n").map((sha) => expectFullSha(sha, `commit in ${range}`));
};

const subjectFor = (git: GitRunner, sha: string): string =>
  runOrFail(git, ["show", "-s", "--format=%s", sha]);

const assertImportedCommit = (
  git: GitRunner,
  targetRef: string,
  upstreamCommit: string,
  cocoaCommit: string,
): void => {
  const ancestry = git.run(["merge-base", "--is-ancestor", cocoaCommit, targetRef]);
  if (ancestry.exitCode !== 0) {
    fail(`imported Cocoa commit ${cocoaCommit} is not an ancestor of ${targetRef}`);
  }
  const message = runOrFail(git, ["show", "-s", "--format=%B", cocoaCommit]);
  if (message.includes(`(cherry picked from commit ${upstreamCommit})`)) return;

  const parents = runOrFail(git, ["show", "-s", "--format=%P", cocoaCommit])
    .split(" ")
    .filter((parent) => parent.length > 0);
  if (parents.length > 1) {
    const wasAlreadyPresent = git.run(["merge-base", "--is-ancestor", upstreamCommit, parents[0]!]);
    const mergedParentContainsCommit = parents
      .slice(1)
      .some(
        (parent) => git.run(["merge-base", "--is-ancestor", upstreamCommit, parent]).exitCode === 0,
      );
    if (wasAlreadyPresent.exitCode === 1 && mergedParentContainsCommit) return;
  }

  fail(
    `imported Cocoa commit ${cocoaCommit} has neither -x provenance nor merge ancestry for ${upstreamCommit}`,
  );
};

const forecastConflict = (git: GitRunner, targetRef: string, upstreamCommit: string): boolean => {
  const parent = revParse(git, `${upstreamCommit}^`);
  const result = git.run([
    "merge-tree",
    "--write-tree",
    "--quiet",
    `--merge-base=${parent}`,
    targetRef,
    upstreamCommit,
  ]);
  if (result.exitCode === 0) return false;
  if (result.exitCode === 1) return true;
  const detail = result.stderr.trim();
  return fail(`git merge-tree failed for ${upstreamCommit}${detail ? `: ${detail}` : ""}`);
};

export const buildUpstreamForecast = (
  ledger: UpstreamIntakeLedger,
  git: GitRunner,
  targetOverride?: string,
): UpstreamForecast => {
  const targetRef = targetOverride ?? ledger.targetRef;
  const baseTagCommit = revParse(git, ledger.baseTag);
  if (baseTagCommit !== ledger.baseCommit) {
    fail(
      `immutable base tag ${ledger.baseTag} resolves to ${baseTagCommit}, expected ${ledger.baseCommit}`,
    );
  }

  let expectedFrom = ledger.baseCommit;
  const seen = new Set<string>();
  const entries: Array<IntakeCommit> = [];
  for (const [index, horizon] of ledger.horizons.entries()) {
    if (horizon.fromExclusive !== expectedFrom) {
      fail(`ledger.horizons[${index}] is not contiguous: expected fromExclusive ${expectedFrom}`);
    }
    const actual = listCommits(git, `${horizon.fromExclusive}..${horizon.throughInclusive}`);
    const recorded = horizon.commits.map((commit) => commit.sha);
    if (
      actual.length !== recorded.length ||
      actual.some((sha, offset) => sha !== recorded[offset])
    ) {
      fail(`ledger.horizons[${index}] does not exactly classify its Git commit range`);
    }
    for (const commit of horizon.commits) {
      if (seen.has(commit.sha)) fail(`upstream commit ${commit.sha} is classified more than once`);
      seen.add(commit.sha);
      entries.push(commit);
    }
    expectedFrom = horizon.throughInclusive;
  }

  const upstreamCommit = revParse(git, ledger.upstreamRef);
  const targetCommit = revParse(git, targetRef);
  const unreviewedShas = listCommits(git, `${expectedFrom}..${upstreamCommit}`);
  const classified = entries.map((commit) => {
    if (commit.classification === "imported") {
      assertImportedCommit(git, targetRef, commit.sha, commit.cocoaCommit!);
    }
    return {
      ...commit,
      subject: subjectFor(git, commit.sha),
      conflict:
        commit.classification === "imported" ? false : forecastConflict(git, targetRef, commit.sha),
    } satisfies ForecastCommit;
  });

  return {
    baseTag: ledger.baseTag,
    baseCommit: ledger.baseCommit,
    targetRef,
    targetCommit,
    upstreamRef: ledger.upstreamRef,
    upstreamCommit,
    reviewedThrough: expectedFrom,
    classified,
    unreviewed: unreviewedShas.map((sha) => ({
      sha,
      subject: subjectFor(git, sha),
      conflict: forecastConflict(git, targetRef, sha),
    })),
  };
};

export const makeGitRunner = (cwd: string): GitRunner => ({
  run: (args) => {
    const result = NodeChildProcess.spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    return {
      exitCode: result.status ?? 2,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
});

const formatHuman = (forecast: UpstreamForecast): string => {
  const lines = [
    `Cocoa upstream intake: ${forecast.baseTag} -> ${forecast.upstreamRef}`,
    `Target: ${forecast.targetRef} (${forecast.targetCommit.slice(0, 12)})`,
    `Reviewed through: ${forecast.reviewedThrough}`,
  ];
  for (const commit of forecast.classified) {
    const forecastState =
      commit.classification === "imported" ? "applied" : commit.conflict ? "conflict" : "clean";
    lines.push(
      `${commit.sha.slice(0, 12)}  ${commit.classification.padEnd(8)}  ${forecastState.padEnd(8)}  ${commit.subject}`,
    );
  }
  if (forecast.unreviewed.length === 0) {
    lines.push("Unreviewed upstream commits: 0");
  } else {
    lines.push(`Unreviewed upstream commits: ${forecast.unreviewed.length}`);
    for (const commit of forecast.unreviewed) {
      lines.push(
        `  ${commit.sha.slice(0, 12)}  ${commit.conflict ? "conflict" : "clean"}  ${commit.subject}`,
      );
    }
  }
  return lines.join("\n");
};

interface CliOptions {
  readonly cwd: string;
  readonly ledgerPath: string;
  readonly targetRef?: string;
  readonly fetch: boolean;
  readonly json: boolean;
}

const parseCliOptions = (args: ReadonlyArray<string>): CliOptions => {
  let cwd = process.cwd();
  let ledgerPath = "upstream-intake.json";
  let targetRef: string | undefined;
  let fetch = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--fetch") fetch = true;
    else if (arg === "--json") json = true;
    else if (arg === "--cwd") cwd = args[++index] ?? fail("--cwd requires a value");
    else if (arg === "--ledger") ledgerPath = args[++index] ?? fail("--ledger requires a value");
    else if (arg === "--target") targetRef = args[++index] ?? fail("--target requires a value");
    else if (arg === "--help") {
      process.stdout.write(
        "Usage: bun scripts/cocoa-upstream-forecast.ts [--fetch] [--json] [--target REF] [--ledger PATH] [--cwd PATH]\n",
      );
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  return {
    cwd,
    ledgerPath,
    ...(targetRef === undefined ? {} : { targetRef }),
    fetch,
    json,
  };
};

const main = (): void => {
  const options = parseCliOptions(process.argv.slice(2));
  const cwd = NodePath.resolve(options.cwd);
  const ledgerFile = NodePath.resolve(cwd, options.ledgerPath);
  const ledger = parseUpstreamIntakeLedger(JSON.parse(NodeFS.readFileSync(ledgerFile, "utf8")));
  const git = makeGitRunner(cwd);
  if (options.fetch) {
    const prefix = `${ledger.remote}/`;
    if (!ledger.upstreamRef.startsWith(prefix)) {
      fail(`ledger.upstreamRef must begin with ${prefix} when --fetch is used`);
    }
    runOrFail(git, ["fetch", "--quiet", ledger.remote, ledger.upstreamRef.slice(prefix.length)]);
  }
  const forecast = buildUpstreamForecast(ledger, git, options.targetRef);
  process.stdout.write(
    `${options.json ? JSON.stringify(forecast, null, 2) : formatHuman(forecast)}\n`,
  );
  if (forecast.unreviewed.length > 0) process.exitCode = 1;
};

const invokedPath = process.argv[1] === undefined ? undefined : NodePath.resolve(process.argv[1]);
if (invokedPath !== undefined && import.meta.url === NodeURL.pathToFileURL(invokedPath).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
