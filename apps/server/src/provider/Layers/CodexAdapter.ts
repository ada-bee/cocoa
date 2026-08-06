/** Legacy local-process wrapper around the transport-neutral Codex adapter core. */
import { type CodexSettings, type ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { RuntimeBufferLimitOverrides } from "../../RuntimeBufferLimits.ts";
import { makeCodexAdapterCore, type CodexAdapterCoreOptions } from "./CodexAdapterCore.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  makeCodexSessionRuntime,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
} from "./CodexSessionRuntime.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

export interface CodexAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly enabled?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    options: CodexSessionRuntimeOptions,
  ) => Effect.Effect<
    CodexSessionRuntimeShape,
    CodexSessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly bufferLimits?: RuntimeBufferLimitOverrides;
}

/** Preserve the upstream-compatible local Codex adapter API. */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  codexConfig: CodexSettings,
  options: CodexAdapterLiveOptions = {},
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nativeEventLogger =
    options.nativeEventLogger ??
    (options.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);
  const createRuntime = options.makeRuntime ?? makeCodexSessionRuntime;

  const coreOptions: CodexAdapterCoreOptions = {
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    defaultCwd: process.cwd(),
    ...(nativeEventLogger === undefined ? {} : { nativeEventLogger }),
    closeNativeEventLoggerOnRelease:
      options.nativeEventLogger === undefined && nativeEventLogger !== undefined,
    ...(options.bufferLimits === undefined ? {} : { bufferLimits: options.bufferLimits }),
    makeRuntime: (baseOptions) => {
      const mcpSession = McpProviderSession.readMcpProviderSession(baseOptions.threadId);
      const runtimeOptions: CodexSessionRuntimeOptions = {
        ...baseOptions,
        binaryPath: codexConfig.binaryPath,
        launchArgs: resolveCodexLaunchArgs(codexConfig.launchArgs, options.environment),
        ...(options.environment ? { environment: options.environment } : {}),
        ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
        ...(mcpSession
          ? {
              environment: {
                ...(options.environment ?? process.env),
                T3_MCP_BEARER_TOKEN: mcpSession.authorizationHeader.replace(/^Bearer\s+/, ""),
              },
              appServerArgs: [
                "-c",
                `mcp_servers.t3-code.url=${mcpSession.endpoint}`,
                "-c",
                'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
              ],
            }
          : {}),
      };
      return createRuntime(runtimeOptions).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
    },
  };

  return yield* makeCodexAdapterCore(codexConfig, coreOptions);
});

export { makeCodexAdapterCore } from "./CodexAdapterCore.ts";
