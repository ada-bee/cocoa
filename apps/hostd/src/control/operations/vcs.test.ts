import {
  CocoaHostControlGenerationId,
  CocoaHostControlRequestId,
  CocoaHostControlResourceId,
  CocoaHostVcsRequest,
  CocoaHostVcsResponse,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeHostControlOperations } from "./index.ts";
import type { HostControlVcsRun, HostControlVcsOutput } from "./state.ts";

const decodeRequest = Schema.decodeUnknownSync(CocoaHostVcsRequest);
const decodeResponse = Schema.decodeUnknownSync(CocoaHostVcsResponse);
const generationId = CocoaHostControlGenerationId.make("generation-1");
const requestId = CocoaHostControlRequestId.make("request-1");
const repositoryId = CocoaHostControlResourceId.make("repository-1");
const output = (stdout = "", options?: Partial<HostControlVcsOutput>): HostControlVcsOutput => ({
  exitCode: 0 as HostControlVcsOutput["exitCode"],
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...options,
});

// Bun is the hostd test runner; bridge only at the outer test boundary.
const effectTest = (name: string, test: () => Effect.Effect<void, never>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Hostd intentionally uses Bun's test runner.
  it(name, () => Effect.runPromise(test()));

const makeHarness = (runVcs: HostControlVcsRun) => {
  const operations = makeHostControlOperations({
    generationId,
    homePath: "/Users/ada",
    openWorkspace: () => Effect.die("workspace was not expected in VCS tests"),
    runVcs,
    makeResourceId: () => repositoryId,
  });
  operations.state.repositories.set(repositoryId, {
    rootPath: "/repo",
    commonDirectoryPath: "/repo/.git",
  });
  return operations;
};

describe("hostd VCS control operations", () => {
  effectTest("opens a Git repository into a generation-bound opaque handle", () =>
    Effect.gen(function* () {
      const calls: Parameters<HostControlVcsRun>[0][] = [];
      const runVcs: HostControlVcsRun = (input) => {
        calls.push(input);
        if (input.operation.endsWith("detect")) return Effect.succeed(output("true\n"));
        if (input.operation.endsWith("root")) return Effect.succeed(output("/repo\n"));
        return Effect.succeed(output(".git\n"));
      };
      const operations = makeHarness(runVcs);

      const opened = yield* operations.vcs(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "vcs.open",
          path: "/repo/subdirectory",
        }),
      );
      expect(opened).toMatchObject({
        operation: "vcs.open",
        result: {
          kind: "repository",
          generationId,
          repositoryId,
          rootPath: "/repo",
          commonDirectoryPath: "/repo/.git",
          driverKind: "git",
          reviewDiff: true,
        },
      });
      expect(() => decodeResponse(opened)).not.toThrow();
      expect(
        calls.every((call) => call.args.slice(0, 2).join(" ") === "-C /repo/subdirectory"),
      ).toBe(true);
    }),
  );

  effectTest("parses bounded porcelain status and reports truncation", () =>
    Effect.gen(function* () {
      const porcelain = [
        "# branch.oid 0123456789012345678901234567890123456789",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
        "1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb src/a.ts",
        "? new.txt",
        "",
      ].join("\0");
      const runVcs: HostControlVcsRun = (input) => {
        if (input.operation.endsWith("status")) return Effect.succeed(output(porcelain));
        if (input.operation.endsWith("defaultRef")) return Effect.succeed(output("origin/main\n"));
        return Effect.succeed(output("https://example.test/repo.git\n"));
      };
      const operations = makeHarness(runVcs);
      const status = yield* operations.vcs(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "vcs.status",
          generationId,
          repositoryId,
          maxChangedPaths: 1,
        }),
      );
      expect(status).toMatchObject({
        operation: "vcs.status",
        head: {
          kind: "branch",
          name: "main",
          commit: "0123456789012345678901234567890123456789",
        },
        defaultRef: "origin/main",
        upstreamRef: "origin/main",
        aheadCount: 2,
        behindCount: 1,
        hasWorkingTreeChanges: true,
        changedPaths: [{ path: "src/a.ts", kind: "modified", staged: false, unstaged: true }],
        truncated: true,
      });
      expect(() => decodeResponse(status)).not.toThrow();
    }),
  );

  effectTest("lists refs and credential-redacted remotes through normalized commands", () =>
    Effect.gen(function* () {
      const runVcs: HostControlVcsRun = (input) => {
        if (input.operation.endsWith("listRefs")) {
          return Effect.succeed(
            output(
              ["refs/heads/main", "00123456789012345678901234567890123456789", "*", "/repo"].join(
                "\0",
              ) +
                "\n" +
                [
                  "refs/remotes/origin/main",
                  "00123456789012345678901234567890123456789",
                  " ",
                  "",
                ].join("\0") +
                "\n",
            ),
          );
        }
        if (input.operation.endsWith("defaultRef")) return Effect.succeed(output("origin/main\n"));
        return Effect.succeed(
          output(
            "origin https://token:secret@example.test/repo.git?access_token=hidden (fetch)\n" +
              "origin https://token:secret@example.test/repo.git?access_token=hidden (push)\n" +
              "backup token@example.test:team/repo.git (fetch)\n" +
              "backup token@example.test:team/repo.git (push)\n",
          ),
        );
      };
      const operations = makeHarness(runVcs);
      const refs = yield* operations.vcs(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "vcs.listRefs",
          generationId,
          repositoryId,
          scope: "all",
          maxRefs: 10,
        }),
      );
      expect(refs).toMatchObject({
        refs: [
          { kind: "local", name: "main", current: true, worktreePath: "/repo" },
          { kind: "knownRemote", name: "origin/main", isDefault: true },
        ],
      });

      const remotes = yield* operations.vcs(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "vcs.listRemotes",
          generationId,
          repositoryId,
          maxRemotes: 10,
        }),
      );
      expect(remotes).toMatchObject({
        remotes: [
          {
            name: "backup",
            fetchUrl: "example.test:team/repo.git",
            pushUrl: "example.test:team/repo.git",
            isPrimary: false,
          },
          {
            name: "origin",
            fetchUrl: "https://example.test/repo.git",
            pushUrl: "https://example.test/repo.git",
            isPrimary: true,
          },
        ],
      });
    }),
  );

  effectTest("resolves automatic review bases and preserves byte truncation evidence", () =>
    Effect.gen(function* () {
      const calls: Parameters<HostControlVcsRun>[0][] = [];
      const runVcs: HostControlVcsRun = (input) => {
        calls.push(input);
        if (input.operation.endsWith("defaultRef")) return Effect.succeed(output("origin/main\n"));
        if (input.operation.endsWith("resolveBase")) {
          const candidate = input.args.at(-1);
          return Effect.succeed(
            candidate === "@{upstream}"
              ? output("", { exitCode: 1 as HostControlVcsOutput["exitCode"] })
              : output("0123456789012345678901234567890123456789\n"),
          );
        }
        return Effect.succeed(output("diff --git a/a b/a\n", { stdoutTruncated: true }));
      };
      const operations = makeHarness(runVcs);
      const diff = yield* operations.vcs(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "vcs.diff",
          generationId,
          repositoryId,
          source: "baseRange",
          baseRef: "automatic",
          ignoreWhitespace: true,
          maxBytes: 4096,
        }),
      );
      expect(diff).toMatchObject({
        operation: "vcs.diff",
        source: "baseRange",
        baseRef: "origin/main",
        headRef: "HEAD",
        truncated: true,
      });
      expect(calls.at(-1)?.args).toEqual([
        "-C",
        "/repo",
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-all-space",
        "origin/main...HEAD",
        "--",
      ]);
    }),
  );

  effectTest("includes untracked files in working-tree review diffs", () =>
    Effect.gen(function* () {
      const calls: Parameters<HostControlVcsRun>[0][] = [];
      const runVcs: HostControlVcsRun = (input) => {
        calls.push(input);
        if (input.operation.endsWith("diff.untracked")) {
          return Effect.succeed(output("new-file.txt\0"));
        }
        if (input.operation.endsWith("diff.untrackedFile")) {
          return Effect.succeed(
            output("diff --git a/new-file.txt b/new-file.txt\nnew file mode 100644\n+new\n", {
              exitCode: 1 as HostControlVcsOutput["exitCode"],
            }),
          );
        }
        return Effect.succeed(output("diff --git a/tracked.txt b/tracked.txt\n+changed\n"));
      };
      const operations = makeHarness(runVcs);

      const diff = yield* operations.vcs(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "vcs.diff",
          generationId,
          repositoryId,
          source: "workingTree",
          ignoreWhitespace: false,
          maxBytes: 4096,
        }),
      );

      expect(diff).toMatchObject({
        operation: "vcs.diff",
        source: "workingTree",
        truncated: false,
      });
      if ("error" in diff) throw new Error(diff.error.message);
      expect(diff.patch).toContain("tracked.txt");
      expect(diff.patch).toContain("new-file.txt");
      expect(calls.at(-1)?.args).toEqual([
        "-C",
        "/repo",
        "diff",
        "--no-index",
        "--patch",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "/dev/null",
        "new-file.txt",
      ]);
    }),
  );

  effectTest(
    "maps every mutation to closed Git templates instead of accepting arbitrary argv",
    () =>
      Effect.gen(function* () {
        const calls: Parameters<HostControlVcsRun>[0][] = [];
        const runVcs: HostControlVcsRun = (input) => {
          calls.push(input);
          if (input.operation.endsWith("validateRef")) return Effect.succeed(output("main\n"));
          if (input.operation.endsWith("prepareCommit.summary")) {
            return Effect.succeed(output("M\tsrc/a.ts\n"));
          }
          if (input.operation.endsWith("prepareCommit.patch"))
            return Effect.succeed(output("patch\n"));
          if (input.operation.endsWith("prepareCommit.branch"))
            return Effect.succeed(output("main\n"));
          if (input.operation.endsWith("commit.head")) {
            return Effect.succeed(output("0123456789012345678901234567890123456789\n"));
          }
          if (input.operation.endsWith("push.branch")) return Effect.succeed(output("main\n"));
          if (input.operation.endsWith("push.upstream"))
            return Effect.succeed(output("origin/main\n"));
          if (input.operation.endsWith("push.ahead")) return Effect.succeed(output("1\n"));
          if (input.operation.endsWith("pull.branch")) return Effect.succeed(output("main\n"));
          if (input.operation.endsWith("pull.upstream"))
            return Effect.succeed(output("origin/main\n"));
          if (input.operation.endsWith("pull.before")) return Effect.succeed(output("before\n"));
          if (input.operation.endsWith("pull.after")) return Effect.succeed(output("after\n"));
          if (input.operation.endsWith("switchRef.current"))
            return Effect.succeed(output("feature\n"));
          return Effect.succeed(output());
        };
        const operations = makeHarness(runVcs);
        const base = { protocolVersion: 1, requestId, generationId, repositoryId } as const;
        const requests = [
          { ...base, operation: "vcs.pull" },
          {
            ...base,
            operation: "vcs.createWorktree",
            refName: "main",
            newRefName: "feature",
            path: "/worktrees/feature",
          },
          { ...base, operation: "vcs.removeWorktree", path: "/worktrees/feature", force: false },
          { ...base, operation: "vcs.createRef", refName: "feature", switchRef: false },
          { ...base, operation: "vcs.switchRef", refName: "feature" },
          { ...base, operation: "vcs.prepareCommit", filePaths: ["src/a.ts"] },
          { ...base, operation: "vcs.commit", subject: "Subject", body: "Body" },
          { ...base, operation: "vcs.push" },
        ] as const;
        for (const request of requests) {
          const result = yield* operations.vcs(decodeRequest(request));
          expect("error" in result).toBe(false);
          if (!("error" in result)) expect(() => decodeResponse(result)).not.toThrow();
        }

        expect(calls.some((call) => call.args.includes("--literal-pathspecs"))).toBe(true);
        expect(
          calls.some(
            (call) =>
              call.args.includes("commit") &&
              call.args.includes("Subject") &&
              call.args.includes("Body"),
          ),
        ).toBe(true);
        expect(calls.some((call) => call.args.join(" ").includes("push --set-upstream"))).toBe(
          false,
        );
        expect(calls.every((call) => call.args[0] === "-C" && call.args[1] === "/repo")).toBe(true);
      }),
  );

  effectTest("rejects stale handles without process dispatch and marks uncertain mutations", () =>
    Effect.gen(function* () {
      let calls = 0;
      const staleOperations = makeHarness((input) => {
        calls += 1;
        return Effect.succeed(output(input.operation));
      });
      const stale = yield* staleOperations.vcs(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "vcs.status",
          generationId: "generation-old",
          repositoryId,
          maxChangedPaths: 10,
        }),
      );
      expect(stale).toMatchObject({ error: { code: "staleHandle" } });
      expect(calls).toBe(0);

      const uncertainOperations = makeHarness(() =>
        Effect.fail(
          new VcsProcessTimeoutError({
            operation: "hostControl.vcs.push",
            command: "git",
            cwd: "/repo",
            timeoutMs: 30_000,
          }),
        ),
      );
      const uncertain = yield* uncertainOperations.vcs(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "vcs.push",
          generationId,
          repositoryId,
        }),
      );
      expect(uncertain).toMatchObject({
        error: { code: "outcomeUnknown", retryable: false },
      });

      const followUpFailure = makeHarness((input) => {
        if (
          input.operation.endsWith("validateRef") ||
          input.operation === "hostControl.vcs.switchRef"
        ) {
          return Effect.succeed(output());
        }
        return Effect.fail(
          new VcsProcessTimeoutError({
            operation: input.operation,
            command: "git",
            cwd: "/repo",
            timeoutMs: 30_000,
          }),
        );
      });
      const switched = yield* followUpFailure.vcs(
        decodeRequest({
          protocolVersion: 1,
          requestId,
          operation: "vcs.switchRef",
          generationId,
          repositoryId,
          refName: "feature",
        }),
      );
      expect(switched).toMatchObject({
        error: { code: "outcomeUnknown", retryable: false },
      });
    }),
  );
});
