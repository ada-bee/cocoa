import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  CodexAppServerClient,
  make as makeClient,
  type CodexAppServerClientOptions,
} from "./client.ts";
import { makeChildStdio, makeTerminationError } from "./_internal/stdio.ts";

export const make = Effect.fn("effect-codex-app-server/child-process-client/make")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: CodexAppServerClientOptions = {},
) {
  yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkScoped);
  return yield* makeClient(makeChildStdio(handle), options, makeTerminationError(handle));
});

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: CodexAppServerClientOptions = {},
): Layer.Layer<CodexAppServerClient> => Layer.effect(CodexAppServerClient, make(handle, options));
