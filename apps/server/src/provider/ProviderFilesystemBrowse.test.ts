import {
  FILESYSTEM_BROWSE_MAX_ENTRIES,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import type { ProviderInstance } from "./ProviderDriver.ts";
import {
  ProviderWorkspaceDisconnectedError,
  ProviderWorkspaceOperationError,
  ProviderWorkspacePathError,
  ProviderWorkspaceProtocolError,
  ProviderWorkspaceUnsupportedError,
  type ProviderWorkspaceAdapter,
} from "./ProviderWorkspaceAdapter.ts";
import * as ProviderInstanceRegistry from "./Services/ProviderInstanceRegistry.ts";
import * as ProviderFilesystemBrowse from "./ProviderFilesystemBrowse.ts";

const providerA = ProviderInstanceId.make("provider-a");
const providerB = ProviderInstanceId.make("provider-b");
const missingProvider = ProviderInstanceId.make("missing-provider");

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(() => Promise.reject(new Error("gateway fs poisoned"))) };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => {
      throw new Error("gateway home poisoned");
    }),
  };
});

function providerInstance(
  instanceId: ProviderInstanceId,
  workspace: ProviderWorkspaceAdapter | undefined,
  enabled = true,
): ProviderInstance {
  return {
    instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    workspace,
    enabled,
  } as unknown as ProviderInstance;
}

function workspace(
  browseDirectory: ProviderWorkspaceAdapter["browseDirectory"],
): ProviderWorkspaceAdapter {
  return {
    browseDirectory,
    openRoot: () => Effect.die("pre-project browse must not open a project root"),
  };
}

function testLayer(instances: ReadonlyMap<ProviderInstanceId, ProviderInstance>) {
  return ProviderFilesystemBrowse.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (instanceId) => Effect.succeed(instances.get(instanceId)),
      }),
    ),
  );
}

describe("ProviderFilesystemBrowse", () => {
  it.effect("routes the same remote path by exact provider id without gateway path access", () => {
    const calls: Array<{ provider: string; locator: unknown; maxEntries: number }> = [];
    const makeWorkspace = (provider: string, child: string) =>
      workspace(({ locator, maxEntries }) =>
        Effect.sync(() => {
          calls.push({ provider, locator, maxEntries });
          return {
            directoryPath: "/remote/path-that-does-not-exist-on-the-gateway",
            parentPath: "/remote",
            entries: [{ name: child, kind: "directory" as const }],
            truncated: false,
          };
        }),
      );
    const instances = new Map([
      [providerA, providerInstance(providerA, makeWorkspace("a", "mac-only"))],
      [providerB, providerInstance(providerB, makeWorkspace("b", "linux-only"))],
    ]);

    return Effect.gen(function* () {
      const browse = yield* ProviderFilesystemBrowse.ProviderFilesystemBrowse;
      const input = {
        locator: {
          kind: "absolute" as const,
          path: "/remote/path-that-does-not-exist-on-the-gateway",
        },
      };
      const resultA = yield* browse.browse({ providerInstanceId: providerA, ...input });
      const resultB = yield* browse.browse({ providerInstanceId: providerB, ...input });

      assert.deepStrictEqual(resultA.entries, [{ name: "mac-only" }]);
      assert.deepStrictEqual(resultB.entries, [{ name: "linux-only" }]);
      assert.deepStrictEqual(calls, [
        {
          provider: "a",
          locator: input.locator,
          maxEntries: FILESYSTEM_BROWSE_MAX_ENTRIES,
        },
        {
          provider: "b",
          locator: input.locator,
          maxEntries: FILESYSTEM_BROWSE_MAX_ENTRIES,
        },
      ]);
      assert.strictEqual(vi.mocked(NodeFSP.readdir).mock.calls.length, 0);
      assert.strictEqual(vi.mocked(NodeOS.homedir).mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer(instances)));
  });

  it.effect("filters non-directories and preserves bounded truncation", () => {
    const entries = [
      { name: "zeta", kind: "directory" as const },
      { name: "file.txt", kind: "file" as const },
      { name: "alpha", kind: "directory" as const },
      { name: "link", kind: "symlink" as const },
    ];
    const instances = new Map([
      [
        providerA,
        providerInstance(
          providerA,
          workspace(() =>
            Effect.succeed({
              directoryPath: "/Users/ada",
              parentPath: "/Users",
              entries,
              truncated: true,
            }),
          ),
        ),
      ],
    ]);

    return Effect.gen(function* () {
      const browse = yield* ProviderFilesystemBrowse.ProviderFilesystemBrowse;
      assert.deepStrictEqual(
        yield* browse.browse({
          providerInstanceId: providerA,
          locator: { kind: "home", relativePath: "" },
        }),
        {
          directoryPath: "/Users/ada",
          parentPath: "/Users",
          entries: [{ name: "alpha" }, { name: "zeta" }],
          truncated: true,
        },
      );
    }).pipe(Effect.provide(testLayer(instances)));
  });

  it.effect("sanitizes missing, disabled, and absent-capability failures", () => {
    const instances = new Map([
      [providerA, providerInstance(providerA, undefined)],
      [
        providerB,
        providerInstance(
          providerB,
          workspace(() => Effect.die("unused")),
          false,
        ),
      ],
    ]);

    return Effect.gen(function* () {
      const browse = yield* ProviderFilesystemBrowse.ProviderFilesystemBrowse;
      const failure = (providerInstanceId: ProviderInstanceId) =>
        browse
          .browse({
            providerInstanceId,
            locator: { kind: "absolute", path: "/srv/workspace" },
          })
          .pipe(Effect.flip);

      assert.deepStrictEqual(
        {
          failure: (yield* failure(missingProvider)).failure,
          retryable: (yield* failure(missingProvider)).retryable,
        },
        { failure: "provider_instance_not_found", retryable: false },
      );
      assert.strictEqual((yield* failure(providerA)).failure, "unsupported_operation");
      assert.deepStrictEqual(
        {
          failure: (yield* failure(providerB)).failure,
          retryable: (yield* failure(providerB)).retryable,
        },
        { failure: "provider_unavailable", retryable: false },
      );
    }).pipe(Effect.provide(testLayer(instances)));
  });

  it.effect("maps provider failures to stable public categories", () => {
    const cases = [
      [
        new ProviderWorkspaceDisconnectedError({
          providerInstanceId: providerA,
          operation: "browseDirectory",
        }),
        "provider_unavailable",
        true,
      ],
      [
        new ProviderWorkspaceUnsupportedError({
          providerInstanceId: providerA,
          operation: "browseDirectory",
        }),
        "unsupported_operation",
        false,
      ],
      [
        new ProviderWorkspaceProtocolError({
          providerInstanceId: providerA,
          operation: "browseDirectory",
          detail: "secret protocol detail",
        }),
        "protocol_incompatible",
        false,
      ],
      [
        new ProviderWorkspacePathError({
          providerInstanceId: providerA,
          operation: "browseDirectory",
          path: "/secret/provider/path",
          issue: "path_not_found",
        }),
        "path_not_found",
        false,
      ],
      [
        new ProviderWorkspacePathError({
          providerInstanceId: providerA,
          operation: "browseDirectory",
          path: "/secret/provider/path",
          issue: "path_not_directory",
        }),
        "path_not_directory",
        false,
      ],
      [
        new ProviderWorkspaceOperationError({
          providerInstanceId: providerA,
          operation: "browseDirectory",
          detail: "secret helper detail",
        }),
        "operation_failed",
        true,
      ],
    ] as const;

    return Effect.gen(function* () {
      for (const [providerError, expectedFailure, expectedRetryable] of cases) {
        const instances = new Map([
          [
            providerA,
            providerInstance(
              providerA,
              workspace(() => Effect.fail(providerError)),
            ),
          ],
        ]);
        const error = yield* Effect.gen(function* () {
          const browse = yield* ProviderFilesystemBrowse.ProviderFilesystemBrowse;
          return yield* browse
            .browse({
              providerInstanceId: providerA,
              locator: { kind: "absolute", path: "/srv/workspace" },
            })
            .pipe(Effect.flip);
        }).pipe(Effect.provide(testLayer(instances)));

        assert.strictEqual(error.failure, expectedFailure);
        assert.strictEqual(error.retryable, expectedRetryable);
        assert.notInclude(error.message, "secret");
        assert.notInclude(error.message, "provider/path");
        assert.notInclude(error.message, "helper detail");
      }
    });
  });
});
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
