import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ServerConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { useEnvironmentServerConfig } from "../state/entities";
import { useConnectionController } from "../features/connection/useConnectionController";
import { environmentPresentations, useEnvironmentPresentation } from "./presentation";
import {
  projectEnvironmentPresentation,
  type EnvironmentPresentation,
} from "../state/environments";
import { useWorkspaceState } from "../state/workspace";
import type { SavedRemoteConnection } from "../lib/connection";
import { appAtomRegistry } from "./atom-registry";
import type { ConnectedEnvironmentSummary, EnvironmentRuntimeState } from "./remote-runtime-types";
import { environmentSession, usePreparedConnection } from "./session";
import { environmentCatalog } from "../connection/catalog";

const connectionGatewayUrlAtom = Atom.make("").pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:connection-gateway-url"),
);

const pendingConnectionErrorAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:pending-connection-error"),
);

export function setPendingConnectionError(message: string | null): void {
  appAtomRegistry.set(pendingConnectionErrorAtom, message);
}

function toSavedConnection(
  environment: EnvironmentPresentation,
  prepared: Option.Option<PreparedConnection>,
): SavedRemoteConnection {
  const displayUrl = environment.displayUrl ?? "";
  const active = Option.getOrNull(prepared);
  const httpBaseUrl = active?.httpBaseUrl ?? displayUrl;
  const socketUrl = active?.socketUrl ?? "";
  const wsBaseUrl =
    socketUrl === ""
      ? displayUrl.startsWith("https://")
        ? displayUrl.replace(/^https:/, "wss:")
        : displayUrl.replace(/^http:/, "ws:")
      : new URL(socketUrl).origin;
  const authorization = active?.httpAuthorization ?? null;

  return {
    environmentId: environment.environmentId,
    environmentLabel: environment.label,
    displayUrl,
    httpBaseUrl,
    wsBaseUrl,
    bearerToken: authorization?._tag === "Bearer" ? authorization.token : null,
  };
}

const savedConnectionsByIdAtom = Atom.make((get) => {
  const presentationById = get(environmentPresentations.presentationsAtom);
  return Object.fromEntries(
    [...presentationById.entries()].map(([environmentId, presentation]) => [
      environmentId,
      toSavedConnection(
        projectEnvironmentPresentation(environmentId, presentation),
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      ),
    ]),
  ) as Record<EnvironmentId, SavedRemoteConnection>;
}).pipe(Atom.withLabel("mobile:saved-connections-by-id"));

function toRuntimeState(
  environment: EnvironmentPresentation,
  serverConfig: ServerConfig | null,
): EnvironmentRuntimeState {
  return {
    connectionState: environment.connection.phase,
    connectionError: environment.connection.error,
    connectionErrorTraceId: environment.connection.traceId,
    serverConfig,
  };
}

export function useSavedRemoteConnections() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const savedConnectionsById = useAtomValue(savedConnectionsByIdAtom);

  return {
    isLoadingSavedConnection: !catalog.isReady,
    savedConnectionsById,
  };
}

export function useSavedRemoteConnection(
  environmentId: EnvironmentId | null,
): SavedRemoteConnection | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const prepared = usePreparedConnection(environmentId);
  if (environmentId === null || presentation === null) {
    return null;
  }
  return toSavedConnection(projectEnvironmentPresentation(environmentId, presentation), prepared);
}

export function useRemoteEnvironmentRuntime(
  environmentId: EnvironmentId | null,
): EnvironmentRuntimeState | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const serverConfig = useEnvironmentServerConfig(environmentId);
  if (environmentId === null || presentation === null) {
    return null;
  }
  return toRuntimeState(projectEnvironmentPresentation(environmentId, presentation), serverConfig);
}

export function useRemoteConnectionStatus() {
  const workspace = useWorkspaceState();
  const pendingConnectionError = useAtomValue(pendingConnectionErrorAtom);
  const connectedEnvironments = useMemo<ReadonlyArray<ConnectedEnvironmentSummary>>(
    () =>
      workspace.environments.map((environment) => ({
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel,
        displayUrl: environment.displayUrl,
        connectionState: environment.connectionState,
        connectionError: environment.connectionError,
        connectionErrorTraceId: environment.connectionErrorTraceId,
      })),
    [workspace.environments],
  );

  return {
    connectedEnvironments,
    connectionState: workspace.state.connectionState,
    connectionError: pendingConnectionError ?? workspace.state.connectionError,
  };
}

export function useRemoteConnections() {
  const controller = useConnectionController();
  const connectionGatewayUrl = useAtomValue(connectionGatewayUrlAtom);
  const pendingConnectionError = useAtomValue(pendingConnectionErrorAtom);
  const { connectedEnvironments, connectionError, connectionState } = useRemoteConnectionStatus();

  const onChangeConnectionGatewayUrl = useCallback((gatewayUrl: string) => {
    appAtomRegistry.set(connectionGatewayUrlAtom, gatewayUrl);
  }, []);

  const onConnectPress = useCallback(
    async (gatewayUrl?: string) => {
      const nextGatewayUrl = gatewayUrl ?? connectionGatewayUrl;
      setPendingConnectionError(null);
      const result = await controller.connectGateway(nextGatewayUrl);
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        const message =
          error instanceof Error ? error.message : "Failed to connect to the Cocoa gateway.";
        setPendingConnectionError(message);
      } else {
        appAtomRegistry.set(connectionGatewayUrlAtom, "");
      }
      return result;
    },
    [connectionGatewayUrl, controller],
  );

  const onReconnectEnvironment = useCallback(
    (environmentId: EnvironmentId) => controller.retryEnvironment(environmentId),
    [controller],
  );
  const onUpdateEnvironment = useCallback(
    (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) => controller.updateEnvironment(environmentId, updates),
    [controller],
  );

  const onRemoveEnvironmentPress = useCallback(
    (environmentId: EnvironmentId) => {
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!environment) {
        return;
      }
      Alert.alert(
        "Remove environment?",
        `Disconnect and forget ${environment.environmentLabel} on this device.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => {
              void controller.removeEnvironment(environmentId);
            },
          },
        ],
      );
    },
    [connectedEnvironments, controller],
  );

  return {
    connectionGatewayUrl,
    connectionState,
    connectionError,
    gatewayConnectionError: pendingConnectionError,
    connectedEnvironments,
    connectedEnvironmentCount: connectedEnvironments.length,
    onChangeConnectionGatewayUrl,
    onConnectPress,
    onReconnectEnvironment,
    onUpdateEnvironment,
    onRemoveEnvironmentPress,
  };
}
