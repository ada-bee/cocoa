import { assert, describe, it } from "@effect/vitest";
import {
  USAGE_CONTRACT_VERSION,
  type CocoaHostControlCapability,
  type CocoaHostControlEvent,
  ProviderHostId,
  ProviderInstanceId,
  UsageDay,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import {
  ProviderVcsOperationError,
  ProviderVcsReviewDiffByteLimit,
  ProviderVcsRevision,
  ProviderVcsStatusPathLimit,
} from "../ProviderVcsAdapter.ts";
import {
  ProviderWorkspaceBrowseMaxEntries,
  ProviderWorkspaceMaxDepth,
  ProviderWorkspaceMaxDirectories,
  ProviderWorkspaceMaxEntries,
  ProviderWorkspacePathError,
  ProviderWorkspaceReadByteLimit,
} from "../ProviderWorkspaceAdapter.ts";
import type { HostEndpointControlClient } from "./HostEndpointControlClient.ts";
import { makeHostEndpointCapabilities } from "./HostEndpointCapabilities.ts";
import {
  HostEndpointRpcRemoteError,
  HostEndpointRpcTimeoutError,
  type HostEndpointRpcRequestError,
} from "./HostEndpointRpcClient.ts";
import { makeHostEndpointTerminalAdapter } from "./HostEndpointTerminalAdapter.ts";
import { makeHostEndpointVcsAdapter, mapHostEndpointVcsError } from "./HostEndpointVcsAdapter.ts";
import { makeHostEndpointWorkspaceAdapter } from "./HostEndpointWorkspaceAdapter.ts";

const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("host-endpoint-test");
const PROVIDER_HOST_ID = ProviderHostId.make("test_host");
const GENERATION_ID = "generation:1";
const decodeBase64Bytes = Schema.decodeUnknownSync(Schema.Uint8ArrayFromBase64);

interface RecordedRequest {
  readonly operation: string;
  readonly payload: unknown;
}

const makeClient = Effect.fn("HostEndpointAdaptersTest.makeClient")(function* (options: {
  readonly capabilities: ReadonlyArray<CocoaHostControlCapability>;
  readonly selectedVersion?: 1 | 2;
  readonly response: (operation: string, payload: unknown) => unknown;
  readonly fail?: (operation: string) => HostEndpointRpcRequestError | undefined;
}) {
  const events = yield* PubSub.bounded<CocoaHostControlEvent>(32);
  const requests: Array<RecordedRequest> = [];
  const client = {
    generationId: GENERATION_ID,
    handshake: {
      protocol: "cocoa-host-control",
      requestId: "test:handshake",
      selectedVersion: options.selectedVersion ?? 1,
      host: {
        generationId: GENERATION_ID,
        implementation: "test-hostd",
        version: "1.0.0",
        platformFamily: "unix",
        platformOs: "linux",
      },
      capabilities: options.capabilities,
      providerRelays: [],
    },
    request: (
      operation: string,
      payload: unknown,
      decoder: (input: unknown) => Effect.Effect<unknown>,
    ) =>
      Effect.gen(function* () {
        requests.push({ operation, payload });
        const failure = options.fail?.(operation);
        if (failure !== undefined) return yield* failure;
        return yield* decoder(options.response(operation, payload));
      }),
    subscribeEvents: PubSub.subscribe(events),
    awaitTermination: Effect.never,
    close: Effect.void,
  } as unknown as HostEndpointControlClient;
  return { client, events, requests };
});

const responseBase = (operation: string) => ({
  protocolVersion: 1,
  requestId: `response:${operation.replaceAll(".", ":")}`,
  operation,
});

const usageInput = {
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-08"),
  timeZone: "UTC",
};

const usageResponse = (overrides: Record<string, unknown> = {}) => ({
  ...responseBase("usage.read"),
  protocolVersion: 2,
  summary: {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-08-08T12:00:00.000Z",
    ...usageInput,
    buckets: [],
    sources: [],
    pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 1,
    ...overrides,
  },
});

describe("HostEndpoint usage adapter", () => {
  it.effect("reports usage as unsupported when an older host lacks the optional capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeClient({ capabilities: [], response: () => ({}) });
      const capabilities = makeHostEndpointCapabilities({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        providerHostId: PROVIDER_HOST_ID,
        borrowClient: Effect.succeed(harness.client),
      });
      const error = yield* capabilities.usage
        .readSummary({
          sinceDay: UsageDay.make("2026-08-01"),
          untilDay: UsageDay.make("2026-08-08"),
          timeZone: "UTC",
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "unsupported");
      assert.lengthOf(harness.requests, 0);
    }),
  );

  it.effect("requires the negotiated usage read capability before sending a request", () =>
    Effect.gen(function* () {
      for (const capability of [
        { kind: "usage" as const, version: 2 as const, operations: [] },
        { kind: "usage" as const, version: 2 as const, operations: ["read" as const] },
      ]) {
        const harness = yield* makeClient({
          capabilities: [capability],
          selectedVersion: capability.operations.length === 0 ? 2 : 1,
          response: () => ({}),
        });
        const usage = makeHostEndpointCapabilities({
          providerInstanceId: PROVIDER_INSTANCE_ID,
          providerHostId: PROVIDER_HOST_ID,
          borrowClient: Effect.succeed(harness.client),
        }).usage;
        const error = yield* usage.readSummary(usageInput).pipe(Effect.flip);
        assert.equal(error.reason, "unsupported");
        assert.lengthOf(harness.requests, 0);
      }
    }),
  );

  it.effect("accepts an exactly echoed, in-window host summary", () =>
    Effect.gen(function* () {
      const harness = yield* makeClient({
        capabilities: [{ kind: "usage", version: 2, operations: ["read"] }],
        selectedVersion: 2,
        response: () => usageResponse(),
      });
      const usage = makeHostEndpointCapabilities({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        providerHostId: PROVIDER_HOST_ID,
        borrowClient: Effect.succeed(harness.client),
      }).usage;
      const result = yield* usage.readSummary(usageInput);
      assert.equal(result.timeZone, "UTC");
      assert.lengthOf(harness.requests, 1);
    }),
  );

  it.effect("rejects mismatched windows and out-of-window buckets", () =>
    Effect.gen(function* () {
      for (const overrides of [
        { timeZone: "Europe/Prague" },
        {
          buckets: [
            {
              source: { hostId: "host-a", sourceId: "codex-source" },
              day: UsageDay.make("2026-08-09"),
              provider: "codex",
              model: "gpt-test",
              totals: {
                uncachedInputTokens: 1,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
              },
              costUsd: 0,
              cacheSavingsUsd: 0,
              costSource: "unpriced",
              records: 1,
              unpricedRecords: 1,
              sessions: 1,
            },
          ],
        },
        { contractVersion: USAGE_CONTRACT_VERSION - 1 },
        { coverage: { state: "complete", hosts: [] } },
      ]) {
        const harness = yield* makeClient({
          capabilities: [{ kind: "usage", version: 2, operations: ["read"] }],
          selectedVersion: 2,
          response: () => usageResponse(overrides),
        });
        const usage = makeHostEndpointCapabilities({
          providerInstanceId: PROVIDER_INSTANCE_ID,
          providerHostId: PROVIDER_HOST_ID,
          borrowClient: Effect.succeed(harness.client),
        }).usage;
        const error = yield* usage.readSummary(usageInput).pipe(Effect.flip);
        assert.equal(error.reason, "operation-failed");
      }
    }),
  );
});

describe("HostEndpoint workspace adapter", () => {
  it.effect(
    "borrows only for top-level operations and keeps returned roots generation-pinned",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeClient({
          capabilities: [
            {
              kind: "workspace",
              version: 1,
              operations: ["browse", "open", "read"],
              maxEntries: 10,
              maxReadBytes: 100,
            },
          ],
          response: (operation) =>
            operation === "workspace.open"
              ? {
                  ...responseBase(operation),
                  generationId: GENERATION_ID,
                  rootId: "root:pinned",
                  canonicalRoot: "/srv/repo",
                  metadata: { kind: "directory" },
                }
              : operation === "workspace.read"
                ? {
                    ...responseBase(operation),
                    dataBase64: Encoding.encodeBase64(new TextEncoder().encode("pinned")),
                    byteLength: 6,
                    truncated: false,
                  }
                : {
                    ...responseBase(operation),
                    directoryPath: "/srv",
                    parentPath: "/",
                    entries: [],
                    truncated: false,
                  },
        });
        let borrows = 0;
        const capabilities = makeHostEndpointCapabilities({
          providerInstanceId: PROVIDER_INSTANCE_ID,
          providerHostId: PROVIDER_HOST_ID,
          borrowClient: Effect.sync(() => {
            borrows += 1;
            return harness.client;
          }),
        });
        assert.isUndefined(capabilities.execution);

        const root = yield* capabilities.workspace.openRoot("/srv/repo");
        assert.equal(borrows, 1);
        const read = yield* root.readFile({
          relativePath: "README.md",
          maxBytes: ProviderWorkspaceReadByteLimit.make(100),
        });
        assert.equal(new TextDecoder().decode(read.bytes), "pinned");
        assert.equal(borrows, 1);

        yield* capabilities.workspace.browseDirectory({
          locator: { kind: "absolute", path: "/srv" },
          maxEntries: ProviderWorkspaceBrowseMaxEntries.make(10),
        });
        assert.equal(borrows, 2);
      }),
  );

  it.effect("pins root operations to the opened generation and opaque root id", () =>
    Effect.gen(function* () {
      const harness = yield* makeClient({
        capabilities: [
          {
            kind: "workspace",
            version: 1,
            operations: ["browse", "open", "stat", "list", "read"],
            maxEntries: 100,
            maxReadBytes: 1024,
          },
        ],
        response: (operation, payload) => {
          switch (operation) {
            case "workspace.browse":
              return {
                ...responseBase(operation),
                directoryPath: "/srv",
                parentPath: "/",
                entries: [{ name: "repo", kind: "directory" }],
                truncated: false,
              };
            case "workspace.open":
              return {
                ...responseBase(operation),
                generationId: GENERATION_ID,
                rootId: "root:1",
                canonicalRoot: "/srv/repo",
                metadata: { kind: "directory" },
              };
            case "workspace.list":
              if ((payload as { readonly maxDepth: number }).maxDepth > 1) {
                return {
                  ...responseBase(operation),
                  entries: [
                    { path: "src", kind: "directory" },
                    { path: "src/index.ts", kind: "file" },
                  ],
                  truncated: false,
                };
              }
              return {
                ...responseBase(operation),
                entries: [
                  { path: "README.md", kind: "file" },
                  { path: "src", kind: "directory" },
                ],
                truncated: false,
              };
            case "workspace.read":
              return {
                ...responseBase(operation),
                dataBase64: Encoding.encodeBase64(new TextEncoder().encode("hello")),
                byteLength: 5,
                truncated: false,
              };
            default:
              return { ...responseBase(operation), metadata: { kind: "directory" } };
          }
        },
      });
      const adapter = makeHostEndpointWorkspaceAdapter({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        client: harness.client,
      });

      const browse = yield* adapter.browseDirectory({
        locator: { kind: "absolute", path: "/srv" },
        maxEntries: ProviderWorkspaceBrowseMaxEntries.make(25),
      });
      assert.equal(browse.entries[0]?.name, "repo");

      const root = yield* adapter.openRoot("/srv/repo");
      const listing = yield* root.listDirectory({
        relativePath: "",
        maxEntries: ProviderWorkspaceMaxEntries.make(10),
      });
      assert.deepEqual(listing.entries, [
        { name: "README.md", kind: "file" },
        { name: "src", kind: "directory" },
      ]);
      const read = yield* root.readFile({
        relativePath: "README.md",
        maxBytes: ProviderWorkspaceReadByteLimit.make(100),
      });
      assert.equal(new TextDecoder().decode(read.bytes), "hello");

      assert.deepEqual(harness.requests.at(-2), {
        operation: "workspace.list",
        payload: {
          generationId: GENERATION_ID,
          rootId: "root:1",
          relativePath: "",
          maxEntries: 10,
          maxDepth: 1,
          maxDirectories: 10,
        },
      });
      assert.deepEqual(harness.requests.at(-1), {
        operation: "workspace.read",
        payload: {
          generationId: GENERATION_ID,
          rootId: "root:1",
          relativePath: "README.md",
          maxBytes: 100,
        },
      });

      const nested = yield* root.listEntries({
        relativePath: "",
        maxEntries: ProviderWorkspaceMaxEntries.make(20),
        maxDepth: ProviderWorkspaceMaxDepth.make(2),
        maxDirectories: ProviderWorkspaceMaxDirectories.make(10),
      });
      assert.deepEqual(nested.entries, [
        { path: "src", kind: "directory" },
        { path: "src/index.ts", kind: "file" },
      ]);
      assert.deepEqual(harness.requests.at(-1)?.payload, {
        generationId: GENERATION_ID,
        rootId: "root:1",
        relativePath: "",
        maxEntries: 20,
        maxDepth: 2,
        maxDirectories: 10,
      });
    }),
  );

  it.effect("rejects an opened root from a different host generation", () =>
    Effect.gen(function* () {
      const harness = yield* makeClient({
        capabilities: [
          {
            kind: "workspace",
            version: 1,
            operations: ["open"],
            maxEntries: 10,
            maxReadBytes: 10,
          },
        ],
        response: (operation) => ({
          ...responseBase(operation),
          generationId: "generation:replacement",
          rootId: "root:replacement",
          canonicalRoot: "/srv/repo",
          metadata: { kind: "directory" },
        }),
      });
      const adapter = makeHostEndpointWorkspaceAdapter({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        client: harness.client,
      });
      const result = yield* adapter.openRoot("/srv/repo").pipe(Effect.result);
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderWorkspaceProtocolError");
      }
    }),
  );

  it.effect("maps a missing workspace stat path to the normalized path error", () =>
    Effect.gen(function* () {
      const harness = yield* makeClient({
        capabilities: [
          {
            kind: "workspace",
            version: 1,
            operations: ["open", "stat"],
            maxEntries: 10,
            maxReadBytes: 100,
          },
        ],
        response: (operation) => ({
          ...responseBase(operation),
          generationId: GENERATION_ID,
          rootId: "root:1",
          canonicalRoot: "/srv/repo",
          metadata: { kind: "directory" },
        }),
        fail: (operation) =>
          operation === "workspace.stat"
            ? new HostEndpointRpcRemoteError({
                generationId: GENERATION_ID,
                requestId: "request:stat",
                operation,
                code: "notFound",
                remoteMessage: "Workspace path was not found.",
                retryable: false,
              })
            : undefined,
      });
      const adapter = makeHostEndpointWorkspaceAdapter({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        client: harness.client,
      });
      const root = yield* adapter.openRoot("/srv/repo");
      const error = yield* root.getMetadata({ relativePath: "favicon.svg" }).pipe(Effect.flip);

      assert.instanceOf(error, ProviderWorkspacePathError);
      assert.equal(error.issue, "path_not_found");
      assert.equal(error.path, "favicon.svg");
    }),
  );
});

describe("HostEndpoint VCS adapter", () => {
  it.effect("normalizes repository reads and exposes only advertised mutations", () =>
    Effect.gen(function* () {
      const harness = yield* makeClient({
        capabilities: [
          {
            kind: "vcs",
            version: 1,
            driverKinds: ["git"],
            operations: ["open", "status", "listRefs", "listRemotes", "createWorktree", "commit"],
            maxChangedPaths: 100,
            maxRefs: 100,
          },
          {
            kind: "reviewDiff",
            version: 1,
            operations: ["diff"],
            maxPatchBytes: 4096,
          },
        ],
        response: (operation, payload) => {
          switch (operation) {
            case "vcs.open":
              return {
                ...responseBase(operation),
                result: {
                  kind: "repository",
                  generationId: GENERATION_ID,
                  repositoryId: "repository:1",
                  driverKind: "git",
                  rootPath: "/srv/repo",
                  commonDirectoryPath: "/srv/repo/.git",
                  operations: ["status", "listRefs", "listRemotes", "createWorktree", "commit"],
                  reviewDiff: true,
                },
              };
            case "vcs.status":
              return {
                ...responseBase(operation),
                head: { kind: "branch", name: "main", commit: "abc123" },
                defaultRef: "main",
                upstreamRef: "origin/main",
                aheadCount: 1,
                behindCount: 0,
                hasPrimaryRemote: true,
                hasWorkingTreeChanges: false,
                changedPaths: [],
                truncated: false,
              };
            case "vcs.createWorktree":
              return {
                ...responseBase(operation),
                path: "/srv/repo-feature",
                refName: "feature",
              };
            case "vcs.commit":
              return { ...responseBase(operation), commitSha: "def456" };
            case "vcs.diff": {
              const source = (payload as { readonly source: "workingTree" | "baseRange" }).source;
              const patch = source === "workingTree" ? "work" : "base";
              return {
                ...responseBase(operation),
                source,
                baseRef: source === "workingTree" ? null : "main",
                headRef: source === "workingTree" ? null : "HEAD",
                patch,
                byteLength: new TextEncoder().encode(patch).byteLength,
                truncated: false,
              };
            }
            default:
              throw new Error(`Unexpected operation ${operation}`);
          }
        },
      });
      const adapter = makeHostEndpointVcsAdapter({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        client: harness.client,
      });
      const opened = yield* adapter.openRepository("/srv/repo");
      assert.equal(opened._tag, "Repository");
      if (opened._tag !== "Repository") return;
      const repository = opened.repository;
      assert.deepEqual(repository.identity, {
        kind: "git",
        rootPath: "/srv/repo",
        commonDirectoryPath: "/srv/repo/.git",
      });
      assert.isDefined(repository.createWorktree);
      assert.isDefined(repository.commit);
      assert.isUndefined(repository.pull);
      assert.isUndefined(repository.checkpoints);

      const status = yield* repository.getStatus({
        maxChangedPaths: ProviderVcsStatusPathLimit.make(20),
      });
      assert.deepEqual(status.head, { _tag: "Branch", name: "main", commit: "abc123" });
      const worktree = yield* repository.createWorktree!({
        refName: "main",
        newRefName: "feature",
        baseRefName: "main",
        path: "/srv/repo-feature",
      });
      assert.deepEqual(worktree, {
        worktree: { path: "/srv/repo-feature", refName: "feature" },
      });
      assert.deepEqual(harness.requests.at(-1)?.payload, {
        generationId: GENERATION_ID,
        repositoryId: "repository:1",
        refName: "main",
        newRefName: "feature",
        baseRefName: "main",
        path: "/srv/repo-feature",
      });

      const diff = yield* repository.getReviewDiff({
        baseRef: ProviderVcsRevision.make("main"),
        ignoreWhitespace: false,
        maxBytes: ProviderVcsReviewDiffByteLimit.make(8192),
      });
      assert.deepEqual(diff, {
        sources: [
          {
            kind: "workingTree",
            baseRef: null,
            headRef: null,
            patch: "work",
            byteLength: 4,
            truncated: false,
          },
          {
            kind: "baseRange",
            baseRef: "main",
            headRef: "HEAD",
            patch: "base",
            byteLength: 4,
            truncated: false,
          },
        ],
        truncated: false,
      });
      assert.deepEqual(
        harness.requests
          .filter((request) => request.operation === "vcs.diff")
          .map((request) => (request.payload as { readonly maxBytes: number }).maxBytes),
        [4096, 4096],
      );
    }),
  );

  it("maps ambiguous mutation failures to an explicit do-not-retry operation error", () => {
    const timeout = new HostEndpointRpcTimeoutError({
      generationId: GENERATION_ID,
      requestId: "request:1",
      operation: "vcs.commit",
      timeoutMs: 1000,
    });
    const mappedTimeout = mapHostEndpointVcsError(
      PROVIDER_INSTANCE_ID,
      "commit",
      "/srv/repo",
      timeout,
    );
    assert.instanceOf(mappedTimeout, ProviderVcsOperationError);
    assert.match(mappedTimeout.message, /outcome unknown.*do not retry/i);

    const remote = new HostEndpointRpcRemoteError({
      generationId: GENERATION_ID,
      requestId: "request:2",
      operation: "vcs.push",
      code: "outcomeUnknown",
      remoteMessage: "receipt unavailable",
      retryable: false,
    });
    const mappedRemote = mapHostEndpointVcsError(PROVIDER_INSTANCE_ID, "push", "/srv/repo", remote);
    assert.instanceOf(mappedRemote, ProviderVcsOperationError);
    assert.match(mappedRemote.message, /outcome unknown.*do not retry/i);
  });

  it.effect("dispatches a disconnected mutation once and surfaces outcome unknown", () =>
    Effect.gen(function* () {
      const harness = yield* makeClient({
        capabilities: [
          {
            kind: "vcs",
            version: 1,
            driverKinds: ["git"],
            operations: ["open", "commit"],
            maxChangedPaths: 10,
            maxRefs: 10,
          },
        ],
        response: (operation) => ({
          ...responseBase(operation),
          result: {
            kind: "repository",
            generationId: GENERATION_ID,
            repositoryId: "repository:mutation",
            driverKind: "git",
            rootPath: "/srv/repo",
            commonDirectoryPath: "/srv/repo/.git",
            operations: ["commit"],
            reviewDiff: false,
          },
        }),
        fail: (operation) =>
          operation === "vcs.commit"
            ? new HostEndpointRpcTimeoutError({
                generationId: GENERATION_ID,
                requestId: "request:commit",
                operation,
                timeoutMs: 1000,
              })
            : undefined,
      });
      const adapter = makeHostEndpointVcsAdapter({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        client: harness.client,
      });
      const opened = yield* adapter.openRepository("/srv/repo");
      assert.equal(opened._tag, "Repository");
      if (opened._tag !== "Repository") return;
      const result = yield* opened.repository.commit!({ subject: "subject", body: "body" }).pipe(
        Effect.result,
      );
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ProviderVcsOperationError);
        assert.match(result.failure.message, /outcome unknown.*do not retry/i);
      }
      assert.equal(
        harness.requests.filter((request) => request.operation === "vcs.commit").length,
        1,
      );
    }),
  );
});

describe("HostEndpoint terminal adapter", () => {
  it.effect("pins events and chunks writes without replay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeClient({
          capabilities: [
            {
              kind: "terminal",
              version: 1,
              operations: ["start", "attach", "write", "resize", "terminate"],
              maxOutputBytes: 4096,
              supportsReconnect: true,
            },
          ],
          response: (operation) => {
            if (operation === "terminal.start") {
              return {
                ...responseBase(operation),
                snapshot: {
                  generationId: GENERATION_ID,
                  sessionId: "terminal:1",
                  cwd: "/srv/repo",
                  status: "running",
                  sequence: 0,
                  historyBase64: "",
                  historyTruncated: false,
                  exitCode: null,
                  exitSignal: null,
                  exitReason: null,
                },
              };
            }
            return responseBase(operation);
          },
        });
        const adapter = makeHostEndpointTerminalAdapter({
          providerInstanceId: PROVIDER_INSTANCE_ID,
          client: harness.client,
        });
        const observed: Array<
          | { readonly type: "output"; readonly text: string }
          | { readonly type: "exited"; readonly reason: string }
        > = [];
        const exited = yield* Deferred.make<void>();
        const session = yield* adapter.start(
          {
            cwd: "/srv/repo",
            shellArgv: ["/bin/zsh", "-l"],
            cols: 80 as never,
            rows: 24 as never,
            outputByteLimit: 4096 as never,
          },
          (event) =>
            Effect.gen(function* () {
              if (event.type === "output") {
                observed.push({ type: "output", text: new TextDecoder().decode(event.bytes) });
              } else {
                observed.push({ type: "exited", reason: event.reason });
                yield* Deferred.succeed(exited, undefined);
              }
            }),
        );

        const exactLimitOutput = "x".repeat(4096);
        yield* PubSub.publish(harness.events, {
          protocolVersion: 1,
          event: "terminal.output",
          generationId: GENERATION_ID as never,
          sessionId: "terminal:1" as never,
          sequence: 1,
          dataBase64: Encoding.encodeBase64(new TextEncoder().encode(exactLimitOutput)),
        });

        const input = new Uint8Array(70 * 1024);
        yield* session.write(input);
        const writes = harness.requests.filter((request) => request.operation === "terminal.write");
        assert.lengthOf(writes, 2);
        assert.deepEqual(
          writes.map((request) => {
            const payload = request.payload as { readonly dataBase64: string };
            return decodeBase64Bytes(payload.dataBase64).byteLength;
          }),
          [64 * 1024, 6 * 1024],
        );
        for (const write of writes) {
          assert.deepInclude(write.payload as object, {
            generationId: GENERATION_ID,
            sessionId: "terminal:1",
          });
        }

        yield* PubSub.publish(harness.events, {
          protocolVersion: 1,
          event: "terminal.exited",
          generationId: GENERATION_ID as never,
          sessionId: "terminal:1" as never,
          sequence: 2,
          exitCode: 0,
          exitSignal: null,
          reason: "completed",
        });
        yield* Deferred.await(exited);
        assert.deepEqual(observed, [
          { type: "output", text: exactLimitOutput },
          { type: "exited", reason: "completed" },
        ]);

        yield* session.terminate;
        assert.equal(
          harness.requests.filter((request) => request.operation === "terminal.terminate").length,
          0,
        );
      }),
    ),
  );
});
