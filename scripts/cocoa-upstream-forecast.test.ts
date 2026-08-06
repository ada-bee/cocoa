import { describe, expect, it } from "@effect/vitest";

import {
  buildUpstreamForecast,
  parseUpstreamIntakeLedger,
  type GitCommandResult,
  type GitRunner,
} from "./cocoa-upstream-forecast.ts";

const BASE = "1111111111111111111111111111111111111111";
const FIRST = "2222222222222222222222222222222222222222";
const SECOND = "3333333333333333333333333333333333333333";
const COCOA = "4444444444444444444444444444444444444444";
const TARGET = "5555555555555555555555555555555555555555";
const UPSTREAM_NEW = "6666666666666666666666666666666666666666";

const ledgerValue = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  remote: "upstream",
  upstreamRef: "upstream/main",
  targetRef: "main",
  baseTag: "cocoa-fork-base-20260803",
  baseCommit: BASE,
  horizons: [
    {
      reviewedAt: "2026-08-06",
      fromExclusive: BASE,
      throughInclusive: SECOND,
      commits: [
        { sha: FIRST, classification: "deferred", reason: "Review with the desktop work." },
        {
          sha: SECOND,
          classification: "imported",
          reason: "Useful normalized client fix.",
          cocoaCommit: COCOA,
        },
      ],
    },
  ],
  ...overrides,
});

const result = (exitCode: number, stdout = "", stderr = ""): GitCommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const makeRunner = (
  options: { readonly unreviewed?: boolean; readonly conflict?: string } = {},
) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const git: GitRunner = {
    run: (args) => {
      calls.push(args);
      const command = args.join(" ");
      if (command === "rev-parse cocoa-fork-base-20260803^{commit}") return result(0, `${BASE}\n`);
      if (command === "rev-parse upstream/main^{commit}") {
        return result(0, `${options.unreviewed ? UPSTREAM_NEW : SECOND}\n`);
      }
      if (command === "rev-parse main^{commit}") return result(0, `${TARGET}\n`);
      if (command === `rev-parse ${FIRST}^{commit}`) return result(0, `${FIRST}\n`);
      if (command === `rev-parse ${SECOND}^{commit}`) return result(0, `${SECOND}\n`);
      if (command === `rev-parse ${FIRST}^^{commit}`) return result(0, `${BASE}\n`);
      if (command === `rev-parse ${SECOND}^^{commit}`) return result(0, `${FIRST}\n`);
      if (command === `rev-parse ${UPSTREAM_NEW}^^{commit}`) return result(0, `${SECOND}\n`);
      if (command === `rev-list --reverse --topo-order ${BASE}..${SECOND}`) {
        return result(0, `${FIRST}\n${SECOND}\n`);
      }
      if (command === `rev-list --reverse --topo-order ${SECOND}..${SECOND}`) return result(0);
      if (command === `rev-list --reverse --topo-order ${SECOND}..${UPSTREAM_NEW}`) {
        return result(0, `${UPSTREAM_NEW}\n`);
      }
      if (command === `show -s --format=%s ${FIRST}`) return result(0, "first subject\n");
      if (command === `show -s --format=%s ${SECOND}`) return result(0, "second subject\n");
      if (command === `show -s --format=%s ${UPSTREAM_NEW}`) return result(0, "new subject\n");
      if (command === `merge-base --is-ancestor ${COCOA} main`) return result(0);
      if (command === `show -s --format=%B ${COCOA}`) {
        return result(0, `client fix\n\n(cherry picked from commit ${SECOND})\n`);
      }
      if (args[0] === "merge-tree") {
        return result(args.at(-1) === options.conflict ? 1 : 0);
      }
      throw new Error(`Unexpected git command: ${command}`);
    },
  };
  return { git, calls };
};

describe("Cocoa upstream intake forecast", () => {
  it("parses a complete ledger and requires -x evidence for imported commits", () => {
    const ledger = parseUpstreamIntakeLedger(ledgerValue());
    const { git } = makeRunner();
    const forecast = buildUpstreamForecast(ledger, git);

    expect(forecast).toMatchObject({
      baseCommit: BASE,
      targetCommit: TARGET,
      upstreamCommit: SECOND,
      reviewedThrough: SECOND,
      unreviewed: [],
      classified: [
        { sha: FIRST, classification: "deferred", conflict: false, subject: "first subject" },
        { sha: SECOND, classification: "imported", conflict: false, subject: "second subject" },
      ],
    });
  });

  it("reports new upstream commits without silently extending the reviewed horizon", () => {
    const ledger = parseUpstreamIntakeLedger(ledgerValue());
    const { git } = makeRunner({ unreviewed: true, conflict: FIRST });
    const forecast = buildUpstreamForecast(ledger, git);

    expect(forecast.unreviewed).toEqual([
      { sha: UPSTREAM_NEW, subject: "new subject", conflict: false },
    ]);
    expect(forecast.classified[0]).toMatchObject({ sha: FIRST, conflict: true });
  });

  it("rejects gaps, duplicate classifications, and unproven imported commits", () => {
    const noncontiguous = parseUpstreamIntakeLedger(
      ledgerValue({
        horizons: [
          {
            reviewedAt: "2026-08-06",
            fromExclusive: FIRST,
            throughInclusive: SECOND,
            commits: [{ sha: SECOND, classification: "skipped", reason: "Not applicable." }],
          },
        ],
      }),
    );
    expect(() => buildUpstreamForecast(noncontiguous, makeRunner().git)).toThrow(/not contiguous/);

    expect(() =>
      parseUpstreamIntakeLedger(
        ledgerValue({
          horizons: [
            {
              reviewedAt: "2026-08-06",
              fromExclusive: BASE,
              throughInclusive: SECOND,
              commits: [
                { sha: FIRST, classification: "deferred", reason: "Later." },
                { sha: FIRST, classification: "skipped", reason: "Duplicate." },
              ],
            },
          ],
        }),
      ),
    ).not.toThrow();
    const duplicate = parseUpstreamIntakeLedger(
      ledgerValue({
        horizons: [
          {
            reviewedAt: "2026-08-06",
            fromExclusive: BASE,
            throughInclusive: SECOND,
            commits: [
              { sha: FIRST, classification: "deferred", reason: "Later." },
              { sha: FIRST, classification: "skipped", reason: "Duplicate." },
            ],
          },
        ],
      }),
    );
    expect(() => buildUpstreamForecast(duplicate, makeRunner().git)).toThrow(
      /does not exactly classify/,
    );

    const imported = parseUpstreamIntakeLedger(ledgerValue());
    const baseRunner = makeRunner().git;
    const badRunner: GitRunner = {
      run: (args) =>
        args[0] === "show" && args[2] === "--format=%B"
          ? result(0, "missing provenance")
          : baseRunner.run(args),
    };
    expect(() => buildUpstreamForecast(imported, badRunner)).toThrow(/does not record -x/);
  });

  it("rejects malformed ledger classifications before invoking Git", () => {
    expect(() =>
      parseUpstreamIntakeLedger(
        ledgerValue({
          horizons: [
            {
              reviewedAt: "2026-08-06",
              fromExclusive: BASE,
              throughInclusive: FIRST,
              commits: [{ sha: FIRST, classification: "maybe", reason: "Unknown." }],
            },
          ],
        }),
      ),
    ).toThrow(/classification/);
  });
});
