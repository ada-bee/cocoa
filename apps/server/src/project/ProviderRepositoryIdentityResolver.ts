import type { ProviderInstanceId, RepositoryIdentity } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { ProviderVcsRemoteLimit, type ProviderVcsRemote } from "../provider/ProviderVcsAdapter.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { buildRepositoryIdentity } from "./RepositoryIdentity.ts";

const DEFAULT_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);
const MAX_REMOTES = ProviderVcsRemoteLimit.make(64);

export interface ProviderRepositoryIdentityInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly workspaceRoot: string;
}

export interface ProviderRepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

export class ProviderRepositoryIdentityResolver extends Context.Service<
  ProviderRepositoryIdentityResolver,
  {
    readonly resolve: (
      input: ProviderRepositoryIdentityInput,
    ) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("t3/project/ProviderRepositoryIdentityResolver") {}

function pickPrimaryRemote(remotes: ReadonlyArray<ProviderVcsRemote>): ProviderVcsRemote | null {
  const primary = remotes.find((remote) => remote.isPrimary);
  if (primary !== undefined) return primary;

  for (const preferredName of ["upstream", "origin"] as const) {
    const preferred = remotes.find((remote) => remote.name === preferredName);
    if (preferred !== undefined) return preferred;
  }

  return remotes.toSorted((left, right) => left.name.localeCompare(right.name))[0] ?? null;
}

function cacheKey(input: ProviderRepositoryIdentityInput): string {
  return `${input.providerInstanceId}\0${input.workspaceRoot}`;
}

export const make = Effect.fn("ProviderRepositoryIdentityResolver.make")(function* (
  options: ProviderRepositoryIdentityResolverOptions = {},
) {
  const registry = yield* ProviderInstanceRegistry;

  const identities = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (key) =>
      Effect.gen(function* () {
        const separator = key.indexOf("\0");
        const providerInstanceId = key.slice(0, separator) as ProviderInstanceId;
        const workspaceRoot = key.slice(separator + 1);
        const instance = yield* registry.getInstance(providerInstanceId);
        if (instance?.vcs === undefined) return null;

        const opened = yield* instance.vcs.openRepository(workspaceRoot);
        if (opened._tag === "NotRepository") return null;

        const listing = yield* opened.repository.listRemotes({ maxRemotes: MAX_REMOTES });
        const remote = pickPrimaryRemote(listing.remotes);
        return remote === null
          ? null
          : buildRepositoryIdentity({
              remoteName: remote.name,
              remoteUrl: remote.fetchUrl,
              rootPath: opened.repository.identity.rootPath,
            });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logDebug("Provider repository identity lookup failed", {
            cause,
            key,
          }).pipe(Effect.as(null)),
        ),
      ),
    {
      capacity: options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null
            ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
            : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolve: ProviderRepositoryIdentityResolver["Service"]["resolve"] = Effect.fn(
    "ProviderRepositoryIdentityResolver.resolve",
  )((input) => Cache.get(identities, cacheKey(input)));

  return ProviderRepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(ProviderRepositoryIdentityResolver, make());
