import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ProviderVcsAdapter,
  ProviderVcsChangedPathKind,
  ProviderVcsDisconnectedError,
  type ProviderVcsError,
  ProviderVcsOperation,
  ProviderVcsOperationError,
  ProviderVcsPathError,
  ProviderVcsProtocolError,
  ProviderVcsReadCapabilities,
  ProviderVcsReadCapability,
  ProviderVcsRefLimit,
  ProviderVcsRefQuery,
  ProviderVcsRefScope,
  ProviderVcsRemoteLimit,
  type ProviderVcsRepository,
  ProviderVcsReviewDiffByteLimit,
  ProviderVcsReviewDiffSourceKind,
  ProviderVcsRevision,
  ProviderVcsStatusPathLimit,
  ProviderVcsUnsupportedError,
  PROVIDER_VCS_MAX_REFS,
  PROVIDER_VCS_MAX_REMOTES,
  PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES,
  PROVIDER_VCS_MAX_STATUS_PATHS,
} from "./ProviderVcsAdapter.ts";

const providerInstanceId = ProviderInstanceId.make("provider-vcs-test");
const decodeOperation = Schema.decodeUnknownSync(ProviderVcsOperation);
const decodeCapability = Schema.decodeUnknownSync(ProviderVcsReadCapability);
const decodeScope = Schema.decodeUnknownSync(ProviderVcsRefScope);
const decodeChangedPathKind = Schema.decodeUnknownSync(ProviderVcsChangedPathKind);
const decodeDiffSourceKind = Schema.decodeUnknownSync(ProviderVcsReviewDiffSourceKind);
const decodeReadCapabilities = Schema.decodeUnknownSync(ProviderVcsReadCapabilities);

it("bounds every provider VCS read", () => {
  assert.throws(() => ProviderVcsStatusPathLimit.make(0));
  assert.throws(() => ProviderVcsStatusPathLimit.make(PROVIDER_VCS_MAX_STATUS_PATHS + 1));
  assert.strictEqual(
    ProviderVcsStatusPathLimit.make(PROVIDER_VCS_MAX_STATUS_PATHS),
    PROVIDER_VCS_MAX_STATUS_PATHS,
  );

  assert.throws(() => ProviderVcsRefLimit.make(0));
  assert.throws(() => ProviderVcsRefLimit.make(PROVIDER_VCS_MAX_REFS + 1));
  assert.strictEqual(ProviderVcsRefLimit.make(PROVIDER_VCS_MAX_REFS), PROVIDER_VCS_MAX_REFS);

  assert.throws(() => ProviderVcsRemoteLimit.make(0));
  assert.throws(() => ProviderVcsRemoteLimit.make(PROVIDER_VCS_MAX_REMOTES + 1));
  assert.strictEqual(
    ProviderVcsRemoteLimit.make(PROVIDER_VCS_MAX_REMOTES),
    PROVIDER_VCS_MAX_REMOTES,
  );

  assert.throws(() => ProviderVcsReviewDiffByteLimit.make(0));
  assert.throws(() => ProviderVcsReviewDiffByteLimit.make(PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES + 1));
  assert.strictEqual(
    ProviderVcsReviewDiffByteLimit.make(PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES),
    PROVIDER_VCS_MAX_REVIEW_DIFF_BYTES,
  );
});

it("keeps operations, capabilities, scopes, and result kinds closed", () => {
  assert.deepStrictEqual(
    ["openRepository", "getStatus", "listRefs", "listRemotes", "getReviewDiff"].map((value) =>
      decodeOperation(value),
    ),
    ["openRepository", "getStatus", "listRefs", "listRemotes", "getReviewDiff"],
  );
  assert.throws(() => decodeOperation("commit"));

  assert.deepStrictEqual(
    ["status", "refs", "remotes", "reviewDiff"].map((value) => decodeCapability(value)),
    ["status", "refs", "remotes", "reviewDiff"],
  );
  assert.throws(() => decodeCapability("checkpoint"));

  assert.deepStrictEqual(
    ["local", "knownRemote", "all"].map((value) => decodeScope(value)),
    ["local", "knownRemote", "all"],
  );
  assert.throws(() => decodeScope("fetchedRemote"));

  assert.strictEqual(decodeChangedPathKind("conflicted"), "conflicted");
  assert.throws(() => decodeChangedPathKind("ignored"));
  assert.strictEqual(decodeDiffSourceKind("workingTree"), "workingTree");
  assert.throws(() => decodeDiffSourceKind("checkpoint"));

  assert.deepStrictEqual(
    decodeReadCapabilities({
      status: true,
      refs: true,
      remotes: false,
      reviewDiff: true,
    }),
    {
      status: true,
      refs: true,
      remotes: false,
      reviewDiff: true,
    },
  );
});

it("validates bounded, non-option-like ref inputs", () => {
  assert.strictEqual(ProviderVcsRefQuery.make("feature"), "feature");
  assert.throws(() => ProviderVcsRefQuery.make("x".repeat(257)));

  assert.strictEqual(ProviderVcsRevision.make("origin/main~2"), "origin/main~2");
  assert.throws(() => ProviderVcsRevision.make(""));
  assert.throws(() => ProviderVcsRevision.make("--output=/tmp/leak"));
  assert.throws(() => ProviderVcsRevision.make("main\0other"));
});

type FirstArgument<Method> = Method extends (input: infer Input) => unknown ? Input : never;
type HasExecutionEscape<Input> =
  Extract<keyof Input, "cwd" | "command" | "argv"> extends never ? false : true;
type AssertFalse<Value extends false> = Value;

const repositoryInputsHaveNoExecutionEscape: readonly [
  AssertFalse<HasExecutionEscape<FirstArgument<ProviderVcsRepository["getStatus"]>>>,
  AssertFalse<HasExecutionEscape<FirstArgument<ProviderVcsRepository["listRefs"]>>>,
  AssertFalse<HasExecutionEscape<FirstArgument<ProviderVcsRepository["listRemotes"]>>>,
  AssertFalse<HasExecutionEscape<FirstArgument<ProviderVcsRepository["getReviewDiff"]>>>,
] = [false, false, false, false];

it.effect("returns explicit not-repository or a permanently bound read handle", () =>
  Effect.gen(function* () {
    const openedPaths: Array<string> = [];
    const repository: ProviderVcsRepository = {
      identity: {
        kind: "git",
        rootPath: "/provider/repository",
        commonDirectoryPath: "/provider/repository/.git",
      },
      capabilities: {
        status: true,
        refs: true,
        remotes: true,
        reviewDiff: true,
      },
      getStatus: () =>
        Effect.succeed({
          head: { _tag: "Branch", name: "main", commit: "abc123" },
          defaultRef: "main",
          upstreamRef: "origin/main",
          aheadCount: 1,
          behindCount: 0,
          hasPrimaryRemote: true,
          hasWorkingTreeChanges: true,
          changedPaths: [],
          truncated: true,
        }),
      listRefs: () => Effect.succeed({ refs: [], truncated: true }),
      listRemotes: () => Effect.succeed({ remotes: [], truncated: true }),
      getReviewDiff: () => Effect.succeed({ sources: [], truncated: true }),
    };
    const adapter: ProviderVcsAdapter = {
      openRepository: (providerHostPath) => {
        openedPaths.push(providerHostPath);
        return Effect.succeed(
          providerHostPath === "/provider/plain-directory"
            ? { _tag: "NotRepository" as const }
            : { _tag: "Repository" as const, repository },
        );
      },
    };

    const notRepository = yield* adapter.openRepository("/provider/plain-directory");
    const opened = yield* adapter.openRepository("/provider/repository/subdirectory");

    assert.strictEqual(notRepository._tag, "NotRepository");
    assert.strictEqual(opened._tag, "Repository");
    if (opened._tag === "Repository") {
      assert.deepStrictEqual(opened.repository.identity, repository.identity);
      assert.strictEqual(
        (yield* opened.repository.getStatus({
          maxChangedPaths: ProviderVcsStatusPathLimit.make(1),
        })).truncated,
        true,
      );
    }
    assert.deepStrictEqual(openedPaths, [
      "/provider/plain-directory",
      "/provider/repository/subdirectory",
    ]);
    assert.deepStrictEqual(repositoryInputsHaveNoExecutionEscape, [false, false, false, false]);
  }),
);

function describeError(error: ProviderVcsError): string {
  switch (error._tag) {
    case "ProviderVcsDisconnectedError":
    case "ProviderVcsUnsupportedError":
      return `${error._tag}:${error.operation}`;
    case "ProviderVcsProtocolError":
    case "ProviderVcsOperationError":
      return `${error._tag}:${error.detail}`;
    case "ProviderVcsPathError":
      return `${error._tag}:${error.providerHostPath}:${error.issue}`;
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

it("preserves exhaustive provider VCS failure categories", () => {
  const errors: ReadonlyArray<ProviderVcsError> = [
    new ProviderVcsDisconnectedError({
      providerInstanceId,
      operation: "getStatus",
    }),
    new ProviderVcsUnsupportedError({
      providerInstanceId,
      operation: "listRefs",
    }),
    new ProviderVcsProtocolError({
      providerInstanceId,
      operation: "listRemotes",
      detail: "invalid response",
    }),
    new ProviderVcsPathError({
      providerInstanceId,
      operation: "openRepository",
      providerHostPath: "/missing",
      issue: "directory does not exist",
    }),
    new ProviderVcsOperationError({
      providerInstanceId,
      operation: "getReviewDiff",
      detail: "provider helper rejected the request",
    }),
  ];

  assert.deepStrictEqual(errors.map(describeError), [
    "ProviderVcsDisconnectedError:getStatus",
    "ProviderVcsUnsupportedError:listRefs",
    "ProviderVcsProtocolError:invalid response",
    "ProviderVcsPathError:/missing:directory does not exist",
    "ProviderVcsOperationError:provider helper rejected the request",
  ]);
  assert.match(errors[0]!.message, /provider-vcs-test.*disconnected.*getStatus/i);
  assert.match(errors[3]!.message, /\/missing.*provider-vcs-test.*openRepository/i);
});
