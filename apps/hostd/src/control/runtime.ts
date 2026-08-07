/** Generation-scoped host control runtime composed from normalized host services. */
// @effect-diagnostics nodeBuiltinImport:off - Runtime metadata and home paths belong to this host.

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  COCOA_HOST_CONTROL_MAX_DIFF_BYTES,
  COCOA_HOST_CONTROL_MAX_TERMINAL_OUTPUT_BYTES,
  COCOA_HOST_CONTROL_MAX_VCS_PATHS,
  COCOA_HOST_CONTROL_MAX_VCS_REFS,
  COCOA_HOST_CONTROL_MAX_WORKSPACE_ENTRIES,
  COCOA_HOST_CONTROL_MAX_WORKSPACE_READ_BYTES,
  COCOA_HOST_CONTROL_PROTOCOL_VERSION,
  CocoaHostControlGenerationId,
  type CocoaHostControlCapability,
  type CocoaHostControlErrorResponse,
  type CocoaHostControlEvent,
  type CocoaHostControlRequest,
  type CocoaHostControlResponse,
  type CocoaHostTerminalRequest,
  type CocoaHostVcsRequest,
} from "@t3tools/contracts";
import * as HostPty from "@t3tools/host-runtime/pty";
import * as HostVcs from "@t3tools/host-runtime/vcs";
import { openWorkspace } from "@t3tools/host-runtime/workspace";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
  makeHostControlOperations,
  makeHostTerminalControlManager,
  HOST_CONTROL_SAFE_WIRE_PATCH_BYTES,
  type HostTerminalControlManager,
} from "./operations/index.ts";

type TerminalEvent = Extract<
  CocoaHostControlEvent,
  { readonly event: "terminal.output" | "terminal.exited" }
>;

const HOST_CONTROL_SAFE_TERMINAL_OUTPUT_BYTES = 3 * 1024 * 1024 - 64 * 1024;

export interface HostControlDispatch {
  readonly response: CocoaHostControlResponse;
  readonly replayEvents: ReadonlyArray<TerminalEvent>;
}

export interface HostControlRuntime {
  readonly generationId: CocoaHostControlGenerationId;
  readonly platformFamily: "unix" | "windows";
  readonly platformOs: NodeJS.Platform;
  readonly capabilities: ReadonlyArray<CocoaHostControlCapability>;
  readonly dispatch: (request: CocoaHostControlRequest) => Promise<HostControlDispatch>;
  readonly subscribe: (listener: (event: TerminalEvent) => void) => () => void;
  readonly close: () => Promise<void>;
}

export interface MakeHostControlRuntimeOptions {
  readonly generationId?: CocoaHostControlGenerationId;
  readonly platform?: NodeJS.Platform;
  readonly homePath?: string;
  readonly gitExecutable?: string;
  readonly gitAvailable?: boolean;
}

interface RuntimeServices {
  readonly vcs: HostVcs.VcsProcess["Service"];
  readonly pty?: HostPty.PtyAdapter["Service"];
  readonly dispose: () => Promise<void>;
}

const makeRuntimeServices = (terminalSupported: boolean): RuntimeServices => {
  const vcsLayer = HostVcs.layer.pipe(Layer.provide(NodeServices.layer));
  if (!terminalSupported) {
    const runtime = ManagedRuntime.make(vcsLayer);
    return {
      vcs: runtime.runSync(HostVcs.VcsProcess),
      dispose: () => runtime.dispose(),
    };
  }

  const runtime = ManagedRuntime.make(Layer.merge(vcsLayer, HostPty.BunPtyAdapter.layer));
  return {
    vcs: runtime.runSync(HostVcs.VcsProcess),
    pty: runtime.runSync(HostPty.PtyAdapter),
    dispose: () => runtime.dispose(),
  };
};

const hostCapabilities = (
  workspaceSupported: boolean,
  vcsSupported: boolean,
  terminalSupported: boolean,
): ReadonlyArray<CocoaHostControlCapability> => [
  ...(workspaceSupported
    ? [
        {
          kind: "workspace" as const,
          version: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
          operations: ["browse", "open", "stat", "list", "read"] as const,
          maxEntries: COCOA_HOST_CONTROL_MAX_WORKSPACE_ENTRIES,
          maxReadBytes: COCOA_HOST_CONTROL_MAX_WORKSPACE_READ_BYTES,
        },
      ]
    : []),
  ...(vcsSupported
    ? [
        {
          kind: "vcs" as const,
          version: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
          driverKinds: ["git"] as const,
          operations: [
            "open",
            "status",
            "listRefs",
            "listRemotes",
            "pull",
            "createWorktree",
            "removeWorktree",
            "createRef",
            "switchRef",
            "prepareCommit",
            "commit",
            "push",
          ] as const,
          maxChangedPaths: COCOA_HOST_CONTROL_MAX_VCS_PATHS,
          maxRefs: COCOA_HOST_CONTROL_MAX_VCS_REFS,
        },
        {
          kind: "reviewDiff" as const,
          version: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
          operations: ["diff"] as const,
          maxPatchBytes: Math.min(
            COCOA_HOST_CONTROL_MAX_DIFF_BYTES,
            HOST_CONTROL_SAFE_WIRE_PATCH_BYTES,
          ),
        },
      ]
    : []),
  ...(terminalSupported
    ? [
        {
          kind: "terminal" as const,
          version: COCOA_HOST_CONTROL_PROTOCOL_VERSION,
          operations: ["start", "attach", "write", "resize", "terminate"] as const,
          maxOutputBytes: Math.min(
            COCOA_HOST_CONTROL_MAX_TERMINAL_OUTPUT_BYTES,
            HOST_CONTROL_SAFE_TERMINAL_OUTPUT_BYTES,
          ),
          supportsReconnect: true,
        },
      ]
    : []),
];

const isGitAvailable = (executable: string): boolean => {
  try {
    return (
      Bun.spawnSync([executable, "--version"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    );
  } catch {
    return false;
  }
};

const unsupportedVcs = (request: CocoaHostVcsRequest): CocoaHostControlErrorResponse => ({
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  operation: request.operation,
  error: {
    code: "unsupportedOperation",
    message: "Git VCS control is unavailable on this host.",
    retryable: false,
  },
});

const unsupportedWorkspace = (request: CocoaHostControlRequest): CocoaHostControlErrorResponse => ({
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  operation: request.operation,
  error: {
    code: "unsupportedOperation",
    message: "POSIX workspace control is unavailable on this host platform.",
    retryable: false,
  },
});

const unsupportedTerminal = (request: CocoaHostTerminalRequest): CocoaHostControlErrorResponse => ({
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  operation: request.operation,
  error: {
    code: "unsupportedOperation",
    message: "Terminal control is unavailable on this host platform.",
    retryable: false,
  },
});

const runtimeDisconnected = (request: CocoaHostControlRequest): CocoaHostControlErrorResponse => ({
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  operation: request.operation,
  error: {
    code: "disconnected",
    message: "The host control runtime is shutting down.",
    retryable: false,
  },
});

export const makeHostControlRuntime = (
  options: MakeHostControlRuntimeOptions = {},
): HostControlRuntime => {
  const platform = options.platform ?? NodeProcess.platform;
  const workspaceSupported = platform !== "win32";
  const terminalSupported = platform !== "win32";
  const gitExecutable = options.gitExecutable ?? "git";
  const vcsSupported =
    workspaceSupported && (options.gitAvailable ?? isGitAvailable(gitExecutable));
  const generationId =
    options.generationId ?? CocoaHostControlGenerationId.make(`host:${NodeCrypto.randomUUID()}`);
  const services = makeRuntimeServices(terminalSupported);
  const listeners = new Set<(event: TerminalEvent) => void>();
  const operations = makeHostControlOperations({
    generationId,
    homePath: options.homePath ?? NodeOS.homedir(),
    gitExecutable,
    openWorkspace,
    runVcs: services.vcs.run,
  });
  const terminal: HostTerminalControlManager | undefined =
    services.pty === undefined
      ? undefined
      : makeHostTerminalControlManager({
          generationId,
          spawn: services.pty.spawn,
          maxOutputBytes: HOST_CONTROL_SAFE_TERMINAL_OUTPUT_BYTES,
          emit: (event) => {
            for (const listener of listeners) listener(event);
          },
        });
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const dispatch = async (request: CocoaHostControlRequest): Promise<HostControlDispatch> => {
    if (closed) return { response: runtimeDisconnected(request), replayEvents: [] };
    switch (request.operation) {
      case "workspace.browse":
      case "workspace.open":
      case "workspace.stat":
      case "workspace.list":
      case "workspace.read":
        if (!workspaceSupported) {
          return { response: unsupportedWorkspace(request), replayEvents: [] };
        }
        return {
          response: await Effect.runPromise(operations.workspace(request)),
          replayEvents: [],
        };
      case "vcs.open":
      case "vcs.status":
      case "vcs.listRefs":
      case "vcs.listRemotes":
      case "vcs.diff":
      case "vcs.pull":
      case "vcs.createWorktree":
      case "vcs.removeWorktree":
      case "vcs.createRef":
      case "vcs.switchRef":
      case "vcs.prepareCommit":
      case "vcs.commit":
      case "vcs.push":
        if (!vcsSupported) return { response: unsupportedVcs(request), replayEvents: [] };
        return {
          response: await Effect.runPromise(operations.vcs(request)),
          replayEvents: [],
        };
      case "terminal.start":
      case "terminal.attach":
      case "terminal.write":
      case "terminal.resize":
      case "terminal.terminate":
        return terminal === undefined
          ? { response: unsupportedTerminal(request), replayEvents: [] }
          : Effect.runPromise(terminal.handle(request));
    }
  };

  return {
    generationId,
    platformFamily: platform === "win32" ? "windows" : "unix",
    platformOs: platform,
    capabilities: hostCapabilities(workspaceSupported, vcsSupported, terminalSupported),
    dispatch,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      terminal?.close();
      listeners.clear();
      closePromise = services.dispose();
      return closePromise;
    },
  };
};
