/** Endpoint-only OpenCode driver used by the Cocoa gateway. */
import {
  OpenCodeSettings,
  ProviderDriverKind,
  type ProviderHostConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOpenCodeEndpointTextGeneration } from "../../textGeneration/OpenCodeEndpointTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  makeOpenCodeEndpointAdapter,
  type OpenCodeEndpointAdapterEnv,
} from "../Layers/OpenCodeAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggersService.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeEndpointRuntime } from "../OpenCodeEndpointRuntime.ts";
import { makeProviderHostCapabilities } from "../hostEndpoint/ProviderHostCapabilities.ts";
import { makeOpenCodeConversationCatalog } from "../opencodeEndpoint/OpenCodeConversationCatalog.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../ProviderMaintenancePolicy.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  checkOpenCodeEndpointProviderStatus,
  makePendingOpenCodeEndpointProvider,
} from "./OpenCodeEndpointProviderSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("opencode");
const decodeSettings = Schema.decodeSync(OpenCodeSettings);

// Directory strings are owned and normalized by the remote daemon. The gateway
// compares their opaque representations and never resolves them on its host.
const sameProviderDirectory = (left: string, right: string): Effect.Effect<boolean> =>
  Effect.succeed(left === right);

export interface OpenCodeEndpointDriverDependencies {
  readonly runtime: typeof OpenCodeEndpointRuntime;
  readonly makeAdapter: typeof makeOpenCodeEndpointAdapter;
  readonly checkProviderStatus: typeof checkOpenCodeEndpointProviderStatus;
  readonly makeTextGeneration: typeof makeOpenCodeEndpointTextGeneration;
  readonly makeConversationCatalog: typeof makeOpenCodeConversationCatalog;
  /** Seam for provider-host process/terminal/VCS adapters once those are available. */
  readonly makeHostCapabilities?: (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly host: ProviderHostConfig;
  }) => Effect.Effect<
    Pick<ProviderInstance, "workspace" | "terminal" | "execution" | "vcs">,
    ProviderDriverError,
    Scope.Scope
  >;
}

const defaultDependencies: OpenCodeEndpointDriverDependencies = {
  runtime: OpenCodeEndpointRuntime,
  makeAdapter: makeOpenCodeEndpointAdapter,
  checkProviderStatus: checkOpenCodeEndpointProviderStatus,
  makeTextGeneration: makeOpenCodeEndpointTextGeneration,
  makeConversationCatalog: makeOpenCodeConversationCatalog,
  makeHostCapabilities: makeProviderHostCapabilities,
};

export type OpenCodeEndpointDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | OpenCodeEndpointAdapterEnv
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const makeOpenCodeEndpointDriver = (
  overrides: Partial<OpenCodeEndpointDriverDependencies> = {},
): ProviderDriver<OpenCodeSettings, OpenCodeEndpointDriverEnv> => {
  const dependencies = { ...defaultDependencies, ...overrides };
  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "OpenCode", supportsMultipleInstances: true },
    configSchema: OpenCodeSettings,
    defaultConfig: () => decodeSettings({}),
    create: ({ instanceId, host, displayName, accentColor, enabled, config }) =>
      Effect.gen(function* () {
        if (config.serverUrl.trim() === "") {
          return yield* new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Cocoa OpenCode instances require an explicit server URL.",
          });
        }

        const serverSettings = yield* ServerSettingsService;
        const eventLoggers = yield* ProviderEventLoggers;
        const effectiveConfig = { ...config, enabled } satisfies OpenCodeSettings;
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        });
        const stampIdentity = (snapshot: Omit<ServerProvider, "instanceId" | "driver">) => ({
          ...snapshot,
          instanceId,
          driver: DRIVER_KIND,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
        });
        const adapter = yield* dependencies.makeAdapter(effectiveConfig, dependencies.runtime, {
          instanceId,
          requireExplicitCwd: true,
          sameDirectory: sameProviderDirectory,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        });
        const textGeneration = yield* dependencies.makeTextGeneration(instanceId, effectiveConfig, {
          runtime: dependencies.runtime,
        });
        const catalogClient = dependencies.runtime.createOpenCodeSdkClient({
          baseUrl: effectiveConfig.serverUrl,
          ...(effectiveConfig.serverPassword
            ? { serverPassword: effectiveConfig.serverPassword }
            : {}),
        });
        const conversationCatalog = yield* dependencies.makeConversationCatalog({
          providerInstanceId: instanceId,
          client: catalogClient,
        });
        const hostCapabilities =
          enabled && host !== undefined && dependencies.makeHostCapabilities !== undefined
            ? yield* dependencies.makeHostCapabilities({ instanceId, host })
            : {};
        const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        });
        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const pendingSnapshot = makePendingOpenCodeEndpointProvider(effectiveConfig).pipe(
          Effect.map(stampIdentity),
        );
        const snapshot = yield* makeManagedServerProvider<
          ProviderSnapshotSettings<OpenCodeSettings>
        >({
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: () => pendingSnapshot,
          checkProvider: dependencies
            .checkProviderStatus(effectiveConfig, dependencies.runtime)
            .pipe(Effect.map(stampIdentity)),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to build OpenCode endpoint snapshot: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );

        return {
          instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          gatewayMcpMode: "unavailable",
          snapshot,
          adapter,
          conversationCatalog: conversationCatalog.catalog,
          textGeneration,
          ...hostCapabilities,
        } satisfies ProviderInstance;
      }),
  };
};

export const OpenCodeEndpointDriver = makeOpenCodeEndpointDriver();
