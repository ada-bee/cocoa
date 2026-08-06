import type { ProviderInstanceConfigMap, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { resolveCocoaGatewayProviderInstanceConfigMap } from "../../cocoa/CocoaGatewayPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { COCOA_GATEWAY_DRIVERS, type CocoaGatewayDriversEnv } from "../cocoaGatewayDrivers.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderInstanceRegistryMutableLayer } from "./ProviderInstanceRegistryLive.ts";

const settingsWatcherLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const mutator = yield* ProviderInstanceRegistryMutator;
    const serverSettings = yield* ServerSettingsService;
    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((next) =>
        resolveCocoaGatewayProviderInstanceConfigMap(next).pipe(
          Effect.flatMap(mutator.reconcile),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Cocoa provider registry rejected a settings reload; retaining current instances",
              cause,
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

/** Endpoint-only registry hydration whose import closure contains no legacy driver catalog. */
export const CocoaProviderInstanceRegistryHydrationLive: Layer.Layer<
  ProviderInstanceRegistry,
  never,
  CocoaGatewayDriversEnv | ServerConfig.ServerConfig | ServerSettingsService
> = Layer.unwrap(
  Effect.gen(function* () {
    yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const initialSettings: ServerSettings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const initialConfigMap: ProviderInstanceConfigMap =
      yield* resolveCocoaGatewayProviderInstanceConfigMap(initialSettings).pipe(Effect.orDie);
    const mutableLayer = ProviderInstanceRegistryMutableLayer({
      drivers: COCOA_GATEWAY_DRIVERS,
      configMap: initialConfigMap,
    });
    return settingsWatcherLive.pipe(Layer.provideMerge(mutableLayer));
  }),
);
