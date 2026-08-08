import {
  USAGE_CONTRACT_VERSION,
  type ProviderHostId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
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
import { requestHostEndpoint } from "./HostEndpointControlClient.ts";
import type { HostEndpointControlBorrowError } from "./HostEndpointControlSupervisor.ts";
import { type ProviderUsageAdapter, ProviderUsageError } from "../ProviderUsageAdapter.ts";
import { makeHostEndpointTerminalAdapter } from "./HostEndpointTerminalAdapter.ts";
import { makeHostEndpointVcsAdapter } from "./HostEndpointVcsAdapter.ts";
import { makeHostEndpointWorkspaceAdapter } from "./HostEndpointWorkspaceAdapter.ts";

export interface HostEndpointCapabilities {
  readonly workspace: ProviderWorkspaceAdapter;
  readonly vcs: ProviderVcsAdapter;
  readonly terminal: ProviderTerminalAdapter;
  readonly execution: ProviderExecutionAdapter | undefined;
  readonly usage: ProviderUsageAdapter;
}

export interface MakeHostEndpointCapabilitiesOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerHostId: ProviderHostId;
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

  const usage: ProviderUsageAdapter = {
    providerInstanceId: options.providerInstanceId,
    providerHostId: options.providerHostId,
    readSummary: Effect.fn("HostEndpointCapabilities.readUsageSummary")(function* (input) {
      const client = yield* options.borrowClient.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderUsageError({
              providerInstanceId: options.providerInstanceId,
              reason: "disconnected",
              cause,
            }),
        ),
      );
      const capability = client.handshake.capabilities.find(
        (candidate) => candidate.kind === "usage",
      );
      if (
        capability === undefined ||
        capability.version !== client.handshake.selectedVersion ||
        !capability.operations.includes("read")
      ) {
        return yield* new ProviderUsageError({
          providerInstanceId: options.providerInstanceId,
          reason: "unsupported",
        });
      }
      const response = yield* requestHostEndpoint(client, "usage.read", { input }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderUsageError({
              providerInstanceId: options.providerInstanceId,
              reason: "operation-failed",
              cause,
            }),
        ),
      );
      const summary = response.summary;
      const availableSourceKeys = new Set(
        summary.sources.flatMap((source) =>
          source.status === "ok" || source.status === "partial"
            ? [
                [
                  source.fingerprint.hostId,
                  source.fingerprint.provider,
                  source.fingerprint.sourceId,
                ].join("\0"),
              ]
            : [],
        ),
      );
      if (
        summary.sinceDay !== input.sinceDay ||
        summary.untilDay !== input.untilDay ||
        summary.timeZone !== input.timeZone ||
        summary.contractVersion !== USAGE_CONTRACT_VERSION ||
        summary.coverage !== undefined ||
        summary.buckets.some(
          (bucket) =>
            bucket.day < input.sinceDay ||
            bucket.day > input.untilDay ||
            !availableSourceKeys.has(
              [bucket.source.hostId, bucket.provider, bucket.source.sourceId].join("\0"),
            ),
        )
      ) {
        return yield* new ProviderUsageError({
          providerInstanceId: options.providerInstanceId,
          reason: "operation-failed",
          cause: new Error("Provider host returned an invalid usage summary."),
        });
      }
      return summary;
    }),
  };

  return { workspace, vcs, terminal, execution: undefined, usage };
};
