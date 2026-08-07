import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderExecutionAdapter } from "../ProviderExecutionAdapter.ts";
import {
  type ProviderTerminalAdapter,
  ProviderTerminalDisconnectedError,
} from "../ProviderTerminalAdapter.ts";
import { type ProviderVcsAdapter, ProviderVcsDisconnectedError } from "../ProviderVcsAdapter.ts";
import {
  type ProviderWorkspaceAdapter,
  ProviderWorkspaceDisconnectedError,
} from "../ProviderWorkspaceAdapter.ts";
import type { HostEndpointControlClient } from "./HostEndpointControlClient.ts";
import type { HostEndpointControlBorrowError } from "./HostEndpointControlSupervisor.ts";
import { makeHostEndpointTerminalAdapter } from "./HostEndpointTerminalAdapter.ts";
import { makeHostEndpointVcsAdapter } from "./HostEndpointVcsAdapter.ts";
import { makeHostEndpointWorkspaceAdapter } from "./HostEndpointWorkspaceAdapter.ts";

export interface HostEndpointCapabilities {
  readonly workspace: ProviderWorkspaceAdapter;
  readonly vcs: ProviderVcsAdapter;
  readonly terminal: ProviderTerminalAdapter;
  readonly execution: ProviderExecutionAdapter | undefined;
}

export interface MakeHostEndpointCapabilitiesOptions {
  readonly providerInstanceId: ProviderInstanceId;
  /** Evaluated once for each top-level operation; returned handles retain that exact client. */
  readonly borrowClient: Effect.Effect<HostEndpointControlClient, HostEndpointControlBorrowError>;
}

export const makeHostEndpointCapabilities = (
  options: MakeHostEndpointCapabilitiesOptions,
): HostEndpointCapabilities => {
  const workspace: ProviderWorkspaceAdapter = {
    browseDirectory: Effect.fn("HostEndpointCapabilities.browseDirectory")(function* (input) {
      const client = yield* options.borrowClient.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderWorkspaceDisconnectedError({
              providerInstanceId: options.providerInstanceId,
              operation: "browseDirectory",
              cause,
            }),
        ),
      );
      return yield* makeHostEndpointWorkspaceAdapter({
        providerInstanceId: options.providerInstanceId,
        client,
      }).browseDirectory(input);
    }),
    openRoot: Effect.fn("HostEndpointCapabilities.openRoot")(function* (workspaceRoot) {
      const client = yield* options.borrowClient.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderWorkspaceDisconnectedError({
              providerInstanceId: options.providerInstanceId,
              operation: "openRoot",
              cause,
            }),
        ),
      );
      return yield* makeHostEndpointWorkspaceAdapter({
        providerInstanceId: options.providerInstanceId,
        client,
      }).openRoot(workspaceRoot);
    }),
  };

  const vcs: ProviderVcsAdapter = {
    openRepository: Effect.fn("HostEndpointCapabilities.openRepository")(
      function* (providerHostPath) {
        const client = yield* options.borrowClient.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderVcsDisconnectedError({
                providerInstanceId: options.providerInstanceId,
                operation: "openRepository",
                cause,
              }),
          ),
        );
        return yield* makeHostEndpointVcsAdapter({
          providerInstanceId: options.providerInstanceId,
          client,
        }).openRepository(providerHostPath);
      },
    ),
  };

  const terminal: ProviderTerminalAdapter = {
    start: Effect.fn("HostEndpointCapabilities.startTerminal")(function* (input, onEvent) {
      const client = yield* options.borrowClient.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderTerminalDisconnectedError({
              providerInstanceId: options.providerInstanceId,
              operation: "start",
              cause,
            }),
        ),
      );
      return yield* makeHostEndpointTerminalAdapter({
        providerInstanceId: options.providerInstanceId,
        client,
      }).start(input, onEvent);
    }),
  };

  return { workspace, vcs, terminal, execution: undefined };
};
