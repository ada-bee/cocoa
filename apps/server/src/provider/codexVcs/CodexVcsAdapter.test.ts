import { assert, it } from "@effect/vitest";
import {
  CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
  CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
  CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  ProviderVcsRefLimit,
  ProviderVcsRefQuery,
  ProviderVcsRemoteLimit,
  ProviderVcsReviewDiffByteLimit,
  ProviderVcsRevision,
  ProviderVcsStatusPathLimit,
} from "../ProviderVcsAdapter.ts";
import * as CodexEndpointConnection from "../codexEndpoint/CodexEndpointConnection.ts";
import {
  CodexEndpointBorrowUnavailableError,
  type CodexEndpointConnectionBorrow,
} from "../codexEndpoint/CodexEndpointSupervisor.ts";
import { encodeCodexCheckpointHelperFrame } from "./CodexCheckpointHelperAdapter.ts";
import {
  CODEX_VCS_COMMAND_ENV,
  CODEX_VCS_COMMAND_TIMEOUT_MS,
  CODEX_VCS_OPEN_OUTPUT_BYTES_CAP,
  CodexGitExecutablePath,
  makeCodexVcsAdapter,
  redactCodexVcsRemoteUrl,
} from "./CodexVcsAdapter.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_vcs_test");
const GIT = CodexGitExecutablePath.make("/nix/store/git/bin/git");
const ROOT = "/srv/project";
const COMMON = "/srv/project/.git";
const CHECKPOINT_HELPER = "/nix/store/cocoa/bin/cocoa-workspace-helper";
const CHECKPOINT_HELPER_CONFIG = {
  type: "cocoa-checkpoint-helper-v1" as const,
  executablePath: CHECKPOINT_HELPER,
  expectedProtocol: 1 as const,
};
const CHECKPOINT_BINDING = {
  worktreeRoot: { canonicalPath: ROOT, device: "1", inode: "10" },
  gitDirectoryRoot: { canonicalPath: COMMON, device: "1", inode: "11" },
  gitCommonDirectoryRoot: { canonicalPath: COMMON, device: "1", inode: "11" },
  objectFormat: "sha1" as const,
  fingerprint: "f".repeat(64),
};
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

type CommandExecResponse = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
type Handler = (
  payload: Record<string, unknown>,
) => Effect.Effect<CommandExecResponse, CodexErrors.CodexAppServerError>;

const repositoryIdentity = (root = ROOT, common = COMMON): CommandExecResponse => ({
  exitCode: 0,
  stdout: `${root}\n${common}\ntrue\n`,
  stderr: "",
});

function makeConnection(handler: Handler) {
  const request = ((method: string, payload: unknown) => {
    assert.strictEqual(method, "command/exec");
    return handler(payload as Record<string, unknown>);
  }) as CodexClient.CodexAppServerClient["Service"]["request"];
  return CodexEndpointConnection.CodexEndpointConnection.of({
    identity: { providerInstanceId: INSTANCE_ID },
    client: { request } as CodexClient.CodexAppServerClient["Service"],
    compatibility: {
      userAgent: "codex/1",
      serverVersion: "1",
      codexHome: "/home/codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    awaitTermination: Effect.never,
  });
}

function makeBorrow(
  connection: ReturnType<typeof makeConnection>,
  generationId = 1,
  check?: () => Effect.Effect<void, CodexEndpointBorrowUnavailableError>,
): CodexEndpointConnectionBorrow {
  return {
    generationId,
    connection,
    ensureCurrent: Effect.suspend(() => check?.() ?? Effect.void),
  };
}

function makeAdapter(
  handler: Handler,
  check?: () => Effect.Effect<void, CodexEndpointBorrowUnavailableError>,
  checkpointHelper = false,
) {
  const requests: Array<Record<string, unknown>> = [];
  const connection = makeConnection((payload) => {
    requests.push(payload);
    return handler(payload);
  });
  let borrows = 0;
  let barriers = 0;
  const adapter = makeCodexVcsAdapter({
    providerInstanceId: INSTANCE_ID,
    gitExecutablePath: GIT,
    ...(checkpointHelper ? { checkpointHelper: CHECKPOINT_HELPER_CONFIG } : {}),
    borrowConnection: Effect.sync(() => {
      borrows += 1;
      return makeBorrow(connection, 1, () => {
        barriers += 1;
        return check?.() ?? Effect.void;
      });
    }),
  });
  return { adapter, requests, counts: () => ({ borrows, barriers }) };
}

const decodeCheckpointOperation = (payload: Record<string, unknown>): string => {
  const command = payload.command as ReadonlyArray<string>;
  const json = Result.getOrThrow(Encoding.decodeBase64String(command[1]!));
  const value = decodeUnknownJson(json) as {
    readonly operation: string;
  };
  return value.operation;
};

const checkpointSuccess = (result: unknown): CommandExecResponse => ({
  exitCode: 0,
  stderr: "",
  stdout: encodeCodexCheckpointHelperFrame({
    protocol: "cocoa.checkpoint.v1",
    ok: true,
    result,
  }),
});

const open = Effect.fn("test.open")(function* (adapter: ReturnType<typeof makeCodexVcsAdapter>) {
  const result = yield* adapter.openRepository(ROOT);
  assert.strictEqual(result._tag, "Repository");
  if (result._tag !== "Repository") return assert.fail("expected repository");
  return result.repository;
});

it.effect("pins one generation and sends exact read-only command requests", () =>
  Effect.gen(function* () {
    const { adapter, requests, counts } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("rev-parse")) return Effect.succeed(repositoryIdentity());
      if (argv.at(-1) === "remote")
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "origin\n" });
      if (argv.includes("for-each-ref"))
        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: "refs/remotes/origin/main\n",
        });
      return Effect.succeed({
        exitCode: 0,
        stderr: "secret stderr is ignored",
        stdout:
          "# branch.oid 0123456789012345678901234567890123456789\0# branch.head main\0? odd --path\0",
      });
    });
    const repository = yield* open(adapter);
    const status = yield* repository.getStatus({
      maxChangedPaths: ProviderVcsStatusPathLimit.make(10),
    });
    assert.strictEqual(status.changedPaths[0]?.path, "odd --path");
    assert.isTrue(status.hasPrimaryRemote);
    assert.strictEqual(status.defaultRef, "main");
    assert.strictEqual(status.upstreamRef, null);
    assert.deepStrictEqual(counts(), { borrows: 1, barriers: 8 });
    assert.strictEqual(requests.length, 4);
    assert.deepStrictEqual(requests[0], {
      command: [
        GIT,
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.pager=cat",
        "-c",
        "pager.status=false",
        "-c",
        "pager.branch=false",
        "-c",
        "pager.diff=false",
        "-c",
        "diff.external=",
        "-c",
        "diff.trustExitCode=false",
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "--is-inside-work-tree",
      ],
      cwd: ROOT,
      env: CODEX_VCS_COMMAND_ENV,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      timeoutMs: CODEX_VCS_COMMAND_TIMEOUT_MS,
      outputBytesCap: CODEX_VCS_OPEN_OUTPUT_BYTES_CAP,
    });
    assert.deepStrictEqual((requests[1]!.command as ReadonlyArray<string>).slice(-5), [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
    ]);
    assert.deepStrictEqual((requests[2]!.command as ReadonlyArray<string>).slice(-1), ["remote"]);
    assert.deepStrictEqual((requests[3]!.command as ReadonlyArray<string>).slice(-4), [
      "for-each-ref",
      "--format=%(symref)",
      "--",
      "refs/remotes/origin/HEAD",
    ]);
  }),
);

it.effect("probes and binds checkpoints without coupling read-only VCS availability", () =>
  Effect.gen(function* () {
    const configured = makeAdapter(
      (payload) => {
        const argv = payload.command as ReadonlyArray<string>;
        if (argv[0] === GIT) {
          return Effect.succeed(
            argv.includes("rev-parse")
              ? repositoryIdentity()
              : {
                  exitCode: 0,
                  stderr: "",
                  stdout: "origin\thttps://host/repository.git (fetch)\n",
                },
          );
        }
        assert.strictEqual(argv[0], CHECKPOINT_HELPER);
        const operation = decodeCheckpointOperation(payload);
        return Effect.succeed(
          operation === "probe"
            ? checkpointSuccess({
                operation: "probe",
                implementation: "test-helper",
                gitExecutablePath: GIT,
                capabilities: ["probe", "open", "capture", "diff", "restore", "delete", "observe"],
                objectFormats: ["sha1", "sha256"],
                limits: {
                  maxRequestBytes: CODEX_CHECKPOINT_HELPER_MAX_REQUEST_BYTES,
                  maxPatchBytes: CODEX_CHECKPOINT_HELPER_MAX_PATCH_BYTES,
                  maxResponseBytes: CODEX_CHECKPOINT_HELPER_MAX_RESPONSE_BYTES,
                },
              })
            : checkpointSuccess({
                operation: "open",
                binding: CHECKPOINT_BINDING,
                headOid: "a".repeat(40),
              }),
        );
      },
      undefined,
      true,
    );
    const repository = yield* open(configured.adapter);
    assert.isDefined(repository.checkpoints);
    assert.deepStrictEqual(repository.checkpoints?.binding, CHECKPOINT_BINDING);
    assert.deepStrictEqual(
      configured.requests.map((payload) => (payload.command as ReadonlyArray<string>)[0]),
      [GIT, CHECKPOINT_HELPER, CHECKPOINT_HELPER],
    );

    const failedProbe = makeAdapter(
      (payload) => {
        const argv = payload.command as ReadonlyArray<string>;
        if (argv[0] === CHECKPOINT_HELPER) {
          return Effect.succeed({ exitCode: 127, stdout: "SECRET", stderr: "SECRET" });
        }
        return Effect.succeed(
          argv.includes("rev-parse")
            ? repositoryIdentity()
            : {
                exitCode: 0,
                stderr: "",
                stdout: "origin\thttps://host/repository.git (fetch)\n",
              },
        );
      },
      undefined,
      true,
    );
    const readOnlyRepository = yield* open(failedProbe.adapter);
    assert.strictEqual(readOnlyRepository.checkpoints, undefined);
    const remotes = yield* readOnlyRepository.listRemotes({
      maxRemotes: ProviderVcsRemoteLimit.make(1),
    });
    assert.strictEqual(remotes.remotes[0]?.name, "origin");
    assert.deepStrictEqual(
      failedProbe.requests.map((payload) => (payload.command as ReadonlyArray<string>)[0]),
      [GIT, CHECKPOINT_HELPER, GIT],
    );
  }),
);

it.effect("keeps handles for the same path on their captured connections", () =>
  Effect.gen(function* () {
    const calls = [0, 0];
    const connections = [0, 1].map((index) =>
      makeConnection((payload) => {
        calls[index]! += 1;
        const argv = payload.command as ReadonlyArray<string>;
        return Effect.succeed(
          argv.includes("rev-parse")
            ? repositoryIdentity()
            : {
                exitCode: 0,
                stderr: "",
                stdout: `remote${index}\thttps://host/r.git (fetch)\n`,
              },
        );
      }),
    );
    let next = 0;
    const adapter = makeCodexVcsAdapter({
      providerInstanceId: INSTANCE_ID,
      gitExecutablePath: GIT,
      borrowConnection: Effect.sync(() => makeBorrow(connections[next++]!, next)),
    });
    const first = yield* open(adapter);
    const second = yield* open(adapter);
    const one = yield* first.listRemotes({
      maxRemotes: ProviderVcsRemoteLimit.make(2),
    });
    const two = yield* second.listRemotes({
      maxRemotes: ProviderVcsRemoteLimit.make(2),
    });
    assert.strictEqual(one.remotes[0]?.name, "remote0");
    assert.strictEqual(two.remotes[0]?.name, "remote1");
    assert.deepStrictEqual(calls, [2, 2]);
  }),
);

it.effect("fails a stale generation at the after barrier without retrying", () =>
  Effect.gen(function* () {
    let checks = 0;
    let commands = 0;
    const unavailable = new CodexEndpointBorrowUnavailableError({
      providerInstanceId: INSTANCE_ID,
    });
    const { adapter, counts } = makeAdapter(
      (payload) => {
        commands += 1;
        const argv = payload.command as ReadonlyArray<string>;
        return Effect.succeed(
          argv.includes("rev-parse")
            ? repositoryIdentity()
            : { exitCode: 0, stdout: "", stderr: "" },
        );
      },
      () => {
        checks += 1;
        return checks === 4 ? Effect.fail(unavailable) : Effect.void;
      },
    );
    const repository = yield* open(adapter);
    const error = yield* Effect.flip(
      repository.listRemotes({ maxRemotes: ProviderVcsRemoteLimit.make(1) }),
    );
    assert.strictEqual(error._tag, "ProviderVcsDisconnectedError");
    assert.strictEqual(commands, 2);
    assert.strictEqual(counts().borrows, 1);
  }),
);

it.effect("returns NotRepository distinctly and binds linked-worktree common identity", () =>
  Effect.gen(function* () {
    const missing = makeAdapter(() =>
      Effect.succeed({
        exitCode: 128,
        stdout: "",
        stderr: "credentials must not escape",
      }),
    );
    assert.deepStrictEqual(yield* missing.adapter.openRepository(ROOT), {
      _tag: "NotRepository",
    });
    const linked = makeAdapter(() =>
      Effect.succeed(repositoryIdentity("/worktrees/topic", "/repos/main/.git")),
    );
    const result = yield* linked.adapter.openRepository("/worktrees/topic");
    assert.strictEqual(result._tag, "Repository");
    if (result._tag === "Repository")
      assert.deepStrictEqual(result.repository.identity, {
        kind: "git",
        rootPath: "/worktrees/topic",
        commonDirectoryPath: "/repos/main/.git",
      });
  }),
);

it.effect("maps invalid paths and unavailable commands to closed error tags", () =>
  Effect.gen(function* () {
    const invalid = makeAdapter(() => Effect.die("must not execute"));
    const pathError = yield* Effect.flip(invalid.adapter.openRepository("/srv/../etc"));
    assert.strictEqual(pathError._tag, "ProviderVcsPathError");
    assert.deepStrictEqual(invalid.counts(), { borrows: 0, barriers: 0 });

    const missingMethod = makeAdapter(() =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound("command/exec")),
    );
    const methodError = yield* Effect.flip(missingMethod.adapter.openRepository(ROOT));
    assert.strictEqual(methodError._tag, "ProviderVcsUnsupportedError");

    const missingGit = makeAdapter(() =>
      Effect.succeed({ exitCode: 127, stdout: "", stderr: "SECRET" }),
    );
    const executableError = yield* Effect.flip(missingGit.adapter.openRepository(ROOT));
    assert.strictEqual(executableError._tag, "ProviderVcsUnsupportedError");
    assert.notInclude(executableError.message, "SECRET");
  }),
);

it.effect("bounds status and refs, and rejects malformed structured output", () =>
  Effect.gen(function* () {
    let command = 0;
    const { adapter } = makeAdapter((payload) => {
      command += 1;
      if (command === 1) return Effect.succeed(repositoryIdentity());
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("status"))
        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout:
            "# branch.oid 0123456789012345678901234567890123456789\0# branch.head main\0? one\0? two\0",
        });
      if (argv.at(-1) === "remote") return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
      return Effect.succeed({
        exitCode: 0,
        stderr: "",
        stdout: "refs/heads/main\0not-an-oid\0*\n",
      });
    });
    const repository = yield* open(adapter);
    const status = yield* repository.getStatus({
      maxChangedPaths: ProviderVcsStatusPathLimit.make(1),
    });
    assert.strictEqual(status.changedPaths.length, 1);
    assert.isTrue(status.truncated);
    const error = yield* Effect.flip(
      repository.listRefs({
        scope: "all",
        maxRefs: ProviderVcsRefLimit.make(2),
      }),
    );
    assert.strictEqual(error._tag, "ProviderVcsProtocolError");
  }),
);

it.effect("reports provider-host worktree paths on local refs", () =>
  Effect.gen(function* () {
    const { adapter } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("--show-toplevel")) return Effect.succeed(repositoryIdentity());
      return Effect.succeed({
        exitCode: 0,
        stderr: "",
        stdout: `refs/heads/topic\0${"a".repeat(40)}\0 \0/srv/worktrees/topic\n`,
      });
    });
    const repository = yield* open(adapter);
    const refs = yield* repository.listRefs({
      scope: "local",
      maxRefs: ProviderVcsRefLimit.make(2),
    });
    assert.strictEqual(refs.refs[0]?.worktreePath, "/srv/worktrees/topic");
  }),
);

it.effect("derives the primary remote and default ref without relying on branch upstream", () =>
  Effect.gen(function* () {
    const requests: Array<ReadonlyArray<string>> = [];
    const { adapter } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      requests.push(argv);
      if (argv.includes("rev-parse")) return Effect.succeed(repositoryIdentity());
      if (argv.includes("status"))
        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: `# branch.oid ${"0".repeat(40)}\0# branch.head topic\0`,
        });
      if (argv.at(-1) === "remote")
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "zebra\nalpha\n" });
      return Effect.succeed({
        exitCode: 0,
        stderr: "",
        stdout: "refs/remotes/alpha/trunk\n",
      });
    });
    const repository = yield* open(adapter);
    const status = yield* repository.getStatus({
      maxChangedPaths: ProviderVcsStatusPathLimit.make(1),
    });
    assert.isTrue(status.hasPrimaryRemote);
    assert.strictEqual(status.defaultRef, "trunk");
    assert.strictEqual(status.upstreamRef, null);
    assert.strictEqual(requests.at(-1)?.at(-1), "refs/remotes/alpha/HEAD");
  }),
);

it.effect("keeps hostile queries and revisions as data-only single argv tokens", () =>
  Effect.gen(function* () {
    const requests: Array<Record<string, unknown>> = [];
    const { adapter } = makeAdapter((payload) => {
      requests.push(payload);
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("rev-parse")) return Effect.succeed(repositoryIdentity());
      if (argv.includes("for-each-ref"))
        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: `refs/heads/main\0${"0".repeat(40)}\0*\n`,
        });
      return Effect.succeed({ exitCode: 0, stderr: "", stdout: "patch" });
    });
    const repository = yield* open(adapter);
    yield* repository.listRefs({
      scope: "all",
      query: ProviderVcsRefQuery.make("--format=%(contents)"),
      maxRefs: ProviderVcsRefLimit.make(2),
    });
    const revision = ProviderVcsRevision.make("topic;fetch origin evil");
    yield* repository.getReviewDiff({
      baseRef: revision,
      ignoreWhitespace: true,
      maxBytes: ProviderVcsReviewDiffByteLimit.make(100),
    });
    const refCommand = requests.find((payload) =>
      (payload.command as ReadonlyArray<string>).includes("for-each-ref"),
    )!.command as ReadonlyArray<string>;
    assert.isFalse(refCommand.includes("--format=%(contents)"));
    const diffCommands = requests
      .filter((payload) => (payload.command as ReadonlyArray<string>).includes("diff"))
      .map((payload) => payload.command as ReadonlyArray<string>);
    assert.isTrue(diffCommands[1]!.includes("topic;fetch origin evil...HEAD"));
    assert.strictEqual(diffCommands[1]!.at(-1), "--");
    assert.isTrue(
      diffCommands.every(
        (argv) => argv.includes("--no-ext-diff") && argv.includes("--no-textconv"),
      ),
    );
  }),
);

it.effect("redacts credentials, userinfo, queries, and fragments from remote URLs", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      redactCodexVcsRemoteUrl("https://user:secret@example.com/repo.git?token=x#frag"),
      "https://example.com/repo.git",
    );
    assert.strictEqual(
      redactCodexVcsRemoteUrl("git@example.com:org/repo.git?token=x#frag"),
      "example.com:org/repo.git",
    );
    const { adapter } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      return Effect.succeed(
        argv.includes("rev-parse")
          ? repositoryIdentity()
          : {
              exitCode: 0,
              stderr: "password=hunter2",
              stdout:
                "origin\thttps://u:p@example.com/r.git?q=s (fetch)\norigin\tssh://git@example.com/r.git#x (push)\n",
            },
      );
    });
    const repository = yield* open(adapter);
    const listing = yield* repository.listRemotes({
      maxRemotes: ProviderVcsRemoteLimit.make(1),
    });
    assert.deepStrictEqual(listing.remotes[0], {
      name: "origin",
      fetchUrl: "https://example.com/r.git",
      pushUrl: "ssh://example.com/r.git",
      isPrimary: true,
    });
  }),
);

it.effect("marks exact-cap patches truncated and reports unborn HEAD without leaking stderr", () =>
  Effect.gen(function* () {
    let diffs = 0;
    const { adapter } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("rev-parse")) return Effect.succeed(repositoryIdentity());
      diffs += 1;
      return diffs === 1
        ? Effect.succeed({ exitCode: 0, stderr: "", stdout: "12345" })
        : Effect.succeed({
            exitCode: 128,
            stderr: "token=super-secret",
            stdout: "",
          });
    });
    const repository = yield* open(adapter);
    const exact = yield* repository.getReviewDiff({
      ignoreWhitespace: false,
      maxBytes: ProviderVcsReviewDiffByteLimit.make(5),
    });
    assert.isTrue(exact.truncated);
    assert.isTrue(exact.sources[0]?.truncated);
    const error = yield* Effect.flip(
      repository.getReviewDiff({
        ignoreWhitespace: false,
        maxBytes: ProviderVcsReviewDiffByteLimit.make(6),
      }),
    );
    assert.strictEqual(error._tag, "ProviderVcsOperationError");
    assert.notInclude(error.message, "super-secret");
  }),
);

it.effect("runs branch and worktree mutations only through provider command execution", () =>
  Effect.gen(function* () {
    const { adapter, requests } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("--show-toplevel")) return Effect.succeed(repositoryIdentity());
      if (argv.at(-1) === "--show-current") {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "topic\n" });
      }
      return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
    });
    const repository = yield* open(adapter);
    const created = yield* repository.createWorktree!({
      refName: "origin/main",
      newRefName: "topic",
      baseRefName: "main",
      path: null,
    });
    yield* repository.createRef!({ refName: "another-topic", switchRef: true });
    const switched = yield* repository.switchRef!({ refName: "topic" });

    assert.deepStrictEqual(created, {
      worktree: { path: "/srv/.cocoa-worktrees/project/topic", refName: "topic" },
    });
    assert.deepStrictEqual(switched, { refName: "topic" });
    const mutations = requests.slice(1).filter((payload) => {
      const sandbox = payload.sandboxPolicy as { readonly type?: string };
      return sandbox.type === "workspaceWrite";
    });
    assert.deepStrictEqual((mutations[0]!.command as ReadonlyArray<string>).slice(-6), [
      "worktree",
      "add",
      "-b",
      "topic",
      "/srv/.cocoa-worktrees/project/topic",
      "origin/main",
    ]);
    assert.deepStrictEqual((mutations[1]!.command as ReadonlyArray<string>).slice(-3), [
      "config",
      "branch.topic.gh-merge-base",
      "main",
    ]);
    assert.deepStrictEqual((mutations[2]!.command as ReadonlyArray<string>).slice(-2), [
      "branch",
      "another-topic",
    ]);
    assert.deepStrictEqual((mutations[3]!.command as ReadonlyArray<string>).slice(-2), [
      "checkout",
      "another-topic",
    ]);
    const switchCheckout = mutations.find((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      return argv.at(-2) === "checkout" && argv.at(-1) === "topic";
    });
    assert.isDefined(switchCheckout);
    assert.deepStrictEqual(mutations[0]!.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: [ROOT, "/srv/.cocoa-worktrees/project/topic"],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    });
  }),
);

it.effect("pulls with network access only on the provider host", () =>
  Effect.gen(function* () {
    let headReads = 0;
    const { adapter, requests } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("--show-toplevel")) return Effect.succeed(repositoryIdentity());
      if (argv.includes("--show-current")) {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "main\n" });
      }
      if (argv.includes("@{upstream}")) {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "origin/main\n" });
      }
      if (argv.at(-1) === "HEAD") {
        headReads += 1;
        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: `${headReads === 1 ? "a" : "b".repeat(40)}\n`,
        });
      }
      return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
    });
    const repository = yield* open(adapter);
    const result = yield* repository.pull!();
    assert.deepStrictEqual(result, {
      status: "pulled",
      refName: "main",
      upstreamRef: "origin/main",
    });
    const pullRequest = requests.find((payload) =>
      (payload.command as ReadonlyArray<string>).includes("pull"),
    );
    assert.isDefined(pullRequest);
    assert.strictEqual(
      (pullRequest!.sandboxPolicy as { readonly networkAccess: boolean }).networkAccess,
      true,
    );
    assert.isTrue(
      requests
        .filter((payload) => payload !== pullRequest)
        .every(
          (payload) =>
            (payload.sandboxPolicy as { readonly networkAccess: boolean }).networkAccess === false,
        ),
    );
  }),
);

it.effect("prepares, commits, and pushes through normalized provider-host operations", () =>
  Effect.gen(function* () {
    const { adapter, requests } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("--show-toplevel")) return Effect.succeed(repositoryIdentity());
      if (argv.includes("--name-status")) {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "M\ta.txt\n" });
      }
      if (argv.includes("--patch")) {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "diff --git a/a.txt b/a.txt\n" });
      }
      if (argv.includes("--show-current")) {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "topic\n" });
      }
      if (argv.at(-1) === "HEAD") {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: `${"a".repeat(40)}\n` });
      }
      if (argv.includes("@{upstream}")) {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "origin/topic\n" });
      }
      if (argv.includes("rev-list")) {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "1\n" });
      }
      return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
    });
    const repository = yield* open(adapter);
    const prepared = yield* repository.prepareCommit!({ filePaths: ["a.txt"] });
    const committed = yield* repository.commit!({ subject: "Update a", body: "Details" });
    const pushed = yield* repository.push!();

    assert.deepStrictEqual(prepared, {
      branch: "topic",
      stagedSummary: "M\ta.txt",
      stagedPatch: "diff --git a/a.txt b/a.txt\n",
    });
    assert.deepStrictEqual(committed, { commitSha: "a".repeat(40) });
    assert.deepStrictEqual(pushed, {
      status: "pushed",
      branch: "topic",
      upstreamBranch: "origin/topic",
      setUpstream: false,
    });
    const commands = requests.map((request) => request.command as ReadonlyArray<string>);
    assert.isTrue(commands.some((argv) => argv.includes("--literal-pathspecs")));
    assert.isTrue(commands.some((argv) => argv.includes("commit") && argv.includes("Update a")));
    const pushRequest = requests.find((request) =>
      (request.command as ReadonlyArray<string>).includes("push"),
    );
    assert.isDefined(pushRequest);
    assert.strictEqual(
      (pushRequest!.sandboxPolicy as { readonly networkAccess: boolean }).networkAccess,
      true,
    );
  }),
);

it.effect("rejects unsafe selected commit paths before dispatch", () =>
  Effect.gen(function* () {
    const { adapter, requests } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("--show-toplevel")) return Effect.succeed(repositoryIdentity());
      return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
    });
    const repository = yield* open(adapter);
    const error = yield* Effect.flip(repository.prepareCommit!({ filePaths: ["../secret"] }));
    assert.strictEqual(error._tag, "ProviderVcsPathError");
    assert.strictEqual(requests.length, 1);
  }),
);

it.effect("materializes a local tracking branch when switching a known remote ref", () =>
  Effect.gen(function* () {
    const { adapter, requests } = makeAdapter((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      if (argv.includes("--show-toplevel")) return Effect.succeed(repositoryIdentity());
      if (argv.includes("refs/heads/origin/topic")) {
        return Effect.succeed({ exitCode: 1, stderr: "", stdout: "" });
      }
      if (argv.includes("refs/remotes/origin/topic")) {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
      }
      if (argv.includes("refs/heads/topic")) {
        return Effect.succeed({ exitCode: 1, stderr: "", stdout: "" });
      }
      if (argv.at(-1) === "--show-current") {
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "topic\n" });
      }
      return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
    });
    const repository = yield* open(adapter);
    assert.deepStrictEqual(yield* repository.switchRef!({ refName: "origin/topic" }), {
      refName: "topic",
    });
    const checkout = requests.find((payload) => {
      const argv = payload.command as ReadonlyArray<string>;
      return argv.includes("--track");
    });
    assert.isDefined(checkout);
    assert.deepStrictEqual((checkout!.command as ReadonlyArray<string>).slice(-5), [
      "checkout",
      "--track",
      "-b",
      "topic",
      "origin/topic",
    ]);
  }),
);

it("requires an explicit absolute POSIX Git executable and keeps argv structured", () => {
  assert.throws(() => CodexGitExecutablePath.make("git"));
  assert.throws(() => CodexGitExecutablePath.make("/usr/../bin/git"));
  const supportedCommands = new Set([
    "rev-parse",
    "status",
    "for-each-ref",
    "remote",
    "diff",
    "pull",
    "branch",
    "checkout",
    "worktree",
  ]);
  assert.isFalse(supportedCommands.has("shell"));
  assert.isFalse(supportedCommands.has("eval"));
});
