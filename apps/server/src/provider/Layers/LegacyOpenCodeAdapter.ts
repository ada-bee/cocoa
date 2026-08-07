import type { OpenCodeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeOpenCodeEndpointAdapter, type OpenCodeAdapterLiveOptions } from "./OpenCodeAdapter.ts";
import type { OpenCodeEndpointRuntimeShape } from "../OpenCodeEndpointRuntime.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";

export type LegacyOpenCodeAdapterOptions = Omit<OpenCodeAdapterLiveOptions, "sameDirectory">;

export function isSameOpenCodeDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) return Effect.succeed(true);
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

/** Upstream-compatible adapter wrapper which may spawn a local OpenCode daemon. */
export function makeOpenCodeAdapter(
  settings: OpenCodeSettings,
  options?: LegacyOpenCodeAdapterOptions,
) {
  return Effect.gen(function* () {
    const runtime = yield* OpenCodeRuntime;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const endpointRuntime = {
      ...runtime,
      createOpenCodeSdkClient: (input) =>
        runtime.createOpenCodeSdkClient({
          ...input,
          // Legacy OpenCode runs on this host, so its local cwd remains the
          // appropriate fallback when an endpoint-style caller omits one.
          directory: input.directory ?? path.resolve("."),
        }),
    } satisfies OpenCodeEndpointRuntimeShape;
    return yield* makeOpenCodeEndpointAdapter(settings, endpointRuntime, {
      ...options,
      sameDirectory: (left, right) => isSameOpenCodeDirectory(fileSystem, path, left, right),
    });
  });
}
