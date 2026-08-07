import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type {
  ProviderVcsAdapter,
  ProviderVcsRemote,
  ProviderVcsRepository,
} from "../provider/ProviderVcsAdapter.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderRepositoryIdentityResolver from "./ProviderRepositoryIdentityResolver.ts";

const ALFREDO = ProviderInstanceId.make("alfredo");
const RAVIOLI = ProviderInstanceId.make("ravioli");

function repository(input: {
  readonly rootPath: string;
  readonly remotes: ReadonlyArray<ProviderVcsRemote>;
  readonly onListRemotes?: () => void;
}): ProviderVcsRepository {
  return {
    identity: {
      kind: "git",
      rootPath: input.rootPath,
      commonDirectoryPath: `${input.rootPath}/.git`,
    },
    capabilities: {
      status: true,
      refs: true,
      remotes: true,
      reviewDiff: true,
    },
    getStatus: () => Effect.die("unused"),
    listRefs: () => Effect.die("unused"),
    listRemotes: () =>
      Effect.sync(() => {
        input.onListRemotes?.();
        return { remotes: input.remotes, truncated: false };
      }),
    getReviewDiff: () => Effect.die("unused"),
  };
}

function providerInstance(input: {
  readonly instanceId: ProviderInstanceId;
  readonly vcs?: ProviderVcsAdapter;
}): ProviderInstance {
  return {
    instanceId: input.instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    enabled: true,
    ...(input.vcs === undefined ? {} : { vcs: input.vcs }),
  } as unknown as ProviderInstance;
}

function resolverLayer(instances: ReadonlyMap<ProviderInstanceId, ProviderInstance>) {
  return ProviderRepositoryIdentityResolver.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (instanceId) => Effect.succeed(instances.get(instanceId)),
      }),
    ),
  );
}

it.effect(
  "normalizes matching repositories across provider hosts while preserving host roots",
  () => {
    let listCalls = 0;
    const makeVcs = (rootPath: string): ProviderVcsAdapter => ({
      openRepository: () =>
        Effect.succeed({
          _tag: "Repository",
          repository: repository({
            rootPath,
            remotes: [
              {
                name: "origin",
                fetchUrl: "git@github.com:ada-bee/cocoa.git",
                pushUrl: null,
                isPrimary: true,
              },
            ],
            onListRemotes: () => {
              listCalls += 1;
            },
          }),
        }),
    });
    const instances = new Map([
      [ALFREDO, providerInstance({ instanceId: ALFREDO, vcs: makeVcs("/srv/cocoa") })],
      [RAVIOLI, providerInstance({ instanceId: RAVIOLI, vcs: makeVcs("/work/cocoa") })],
    ]);

    return Effect.gen(function* () {
      const resolver = yield* ProviderRepositoryIdentityResolver.ProviderRepositoryIdentityResolver;
      const alfredo = yield* resolver.resolve({
        providerInstanceId: ALFREDO,
        workspaceRoot: "/srv/cocoa/packages/contracts",
      });
      const ravioli = yield* resolver.resolve({
        providerInstanceId: RAVIOLI,
        workspaceRoot: "/work/cocoa/apps/web",
      });
      const cached = yield* resolver.resolve({
        providerInstanceId: ALFREDO,
        workspaceRoot: "/srv/cocoa/packages/contracts",
      });

      assert.equal(alfredo?.canonicalKey, "github.com/ada-bee/cocoa");
      assert.equal(ravioli?.canonicalKey, alfredo?.canonicalKey);
      assert.equal(alfredo?.rootPath, "/srv/cocoa");
      assert.equal(ravioli?.rootPath, "/work/cocoa");
      assert.deepStrictEqual(cached, alfredo);
      assert.equal(listCalls, 2);
    }).pipe(Effect.provide(resolverLayer(instances)));
  },
);

it.effect(
  "prefers the provider-marked primary remote and degrades unavailable hosts to null",
  () => {
    const available = providerInstance({
      instanceId: ALFREDO,
      vcs: {
        openRepository: () =>
          Effect.succeed({
            _tag: "Repository",
            repository: repository({
              rootPath: "/srv/project",
              remotes: [
                {
                  name: "origin",
                  fetchUrl: "https://github.com/example/mirror.git",
                  pushUrl: null,
                  isPrimary: false,
                },
                {
                  name: "fork",
                  fetchUrl: "https://github.com/ada-bee/project.git",
                  pushUrl: null,
                  isPrimary: true,
                },
              ],
            }),
          }),
      },
    });

    return Effect.gen(function* () {
      const resolver = yield* ProviderRepositoryIdentityResolver.ProviderRepositoryIdentityResolver;
      const primary = yield* resolver.resolve({
        providerInstanceId: ALFREDO,
        workspaceRoot: "/srv/project",
      });
      const offline = yield* resolver.resolve({
        providerInstanceId: RAVIOLI,
        workspaceRoot: "/offline/project",
      });

      assert.equal(primary?.canonicalKey, "github.com/ada-bee/project");
      assert.equal(primary?.locator.remoteName, "fork");
      assert.equal(offline, null);
    }).pipe(Effect.provide(resolverLayer(new Map([[ALFREDO, available]]))));
  },
);
