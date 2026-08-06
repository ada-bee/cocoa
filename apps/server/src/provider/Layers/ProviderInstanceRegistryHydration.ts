/**
 * ProviderInstanceRegistryHydration — derive a `ProviderInstanceConfigMap`
 * from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it.
 *
 * The server still reads two shapes:
 *
 *   1. `settings.providerInstances` — the new driver-agnostic map the
 *      registry expects. Keyed by `ProviderInstanceId`, values are
 *      `ProviderInstanceConfig` envelopes.
 *   2. `settings.providers.<kind>` — the legacy single-instance-per-driver
 *      fields (`providers.codex`, `providers.claudeAgent`, …). These are
 *      the source of truth for every deployment that hasn't been migrated
 *      yet to an explicit `providerInstances` entry.
 *
 * This module bridges (2) into (1) and wires the resulting map into a
 * mutable registry. For every built-in driver whose id is not already
 * present in `providerInstances` (keyed on
 * `defaultInstanceIdForDriver(driverKind)` — literally the driver kind as a
 * routing slug), we synthesize an envelope from the legacy field. The
 * registry decodes both flavours through the same `configSchema` and ends
 * up with one uniform `ProviderInstance` per entry.
 *
 * Explicit `providerInstances` entries always win — users can already
 * override the legacy `providers.<kind>` blob by authoring a
 * `providerInstances.codex` entry with a matching driver, and we don't
 * want the synthesized envelope to silently stomp their config.
 *
 * Hot-reload
 * ----------
 * On layer build we:
 *   1. Read the current `ServerSettings` once and use it to seed the
 *      registry's initial state via `ProviderInstanceRegistryMutableLayer`.
 *   2. Fork a daemon fiber (lifetime tied to the layer's scope) that
 *      subscribes to `ServerSettingsService.streamChanges` and calls
 *      `ProviderInstanceRegistryMutator.reconcile` on every emission.
 *
 * Failures inside the watcher are logged and swallowed so a single bad
 * settings emission cannot kill the registry. Unknown drivers and invalid
 * configs already round-trip through the registry's own "unavailable"
 * shadow bucket.
 *
 * @module provider/Layers/ProviderInstanceRegistryHydration
 */
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { resolveCocoaGatewayProviderInstanceConfigMap } from "../../cocoa/CocoaGatewayPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  BUILT_IN_DRIVERS,
  COCOA_GATEWAY_DRIVERS,
  type BuiltInDriversEnv,
  type CocoaGatewayDriversEnv,
} from "../builtInDrivers.ts";
import type { AnyProviderDriver } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderInstanceRegistryMutableLayer } from "./ProviderInstanceRegistryLive.ts";

/**
 * Synthesize a `ProviderInstanceConfigMap` from a `ServerSettings` snapshot.
 *
 * Strategy:
 *   1. Copy all explicit `settings.providerInstances` entries verbatim.
 *   2. For each built-in driver whose `defaultInstanceIdForDriver(id)` key
 *      is *not* already in the explicit map, synthesize an entry from the
 *      matching legacy `settings.providers.<kind>` blob.
 *
 * The returned map is the input the registry consumes; pure & exported
 * separately so the hydration logic can be exercised by unit tests
 * without layering.
 */
export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) {
      // Explicit `providerInstances` entry for this slot — user-authored
      // config always wins over the legacy mirror.
      continue;
    }

    // Only built-in drivers have a legacy mirror; the registry's
    // `providers` struct is keyed on the same literal slug as
    // `driverKind`. Access is dynamic (the driver kind is a branded string),
    // but it's constrained to `keyof settings.providers` by the union of
    // built-in driver kinds.
    const legacyKey = driver.driverKind as keyof ServerSettings["providers"];
    const legacyConfig = settings.providers[legacyKey];
    if (legacyConfig === undefined) {
      continue;
    }

    merged[instanceId] = {
      driver: driver.driverKind,
      config: legacyConfig,
    };
  }

  return merged as ProviderInstanceConfigMap;
};

export const resolveProviderInstanceConfigMap = (
  settings: ServerSettings,
  runtimeProfile: ServerConfig.RuntimeProfile,
) =>
  runtimeProfile === "cocoa-gateway"
    ? resolveCocoaGatewayProviderInstanceConfigMap(settings)
    : Effect.succeed(deriveProviderInstanceConfigMap(settings));

/**
 * Layer that consumes `ProviderInstanceRegistryMutator` and forks a
 * settings-watcher fiber. The fiber's lifetime is tied to the enclosing
 * layer scope (process lifetime in production), so it is interrupted on
 * shutdown without leaking.
 *
 * Errors inside the watcher are logged and swallowed — the registry's own
 * "unavailable" bucket already absorbs unknown drivers and invalid
 * configs, so the only way the watcher could fail is a settings stream
 * tear-down, which logs and exits cleanly.
 */
const settingsWatcherLive = (runtimeProfile: ServerConfig.RuntimeProfile) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator;
      const serverSettings = yield* ServerSettingsService;
      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach((next) =>
          resolveProviderInstanceConfigMap(next, runtimeProfile).pipe(
            Effect.flatMap(mutator.reconcile),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "ProviderInstanceRegistry rejected a settings reload; retaining current instances",
                cause,
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );

/**
 * Hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
 * sync with subsequent `streamChanges` emissions.
 *
 * The Layer's two halves:
 *   - `ProviderInstanceRegistryMutableLayer` produces the registry +
 *     mutator from the initial config map. Its scope owns every
 *     per-instance child scope created during reconcile.
 *   - `SettingsWatcherLive` consumes the mutator and runs a daemon fiber
 *     in the same scope.
 *
 * Composing via `Layer.provideMerge` makes the watcher's deps available
 * from the mutable layer while still surfacing the registry as an output.
 * The mutator tag is technically also exposed; only this module imports
 * it, so the visibility leak is harmless in practice.
 */
const makeProviderInstanceRegistryHydrationLive = <R>(
  runtimeProfile: ServerConfig.RuntimeProfile,
  drivers: ReadonlyArray<AnyProviderDriver<R>>,
): Layer.Layer<
  ProviderInstanceRegistry,
  never,
  R | ServerConfig.ServerConfig | ServerSettingsService
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const initialSettings: ServerSettings | undefined =
        runtimeProfile === "cocoa-gateway"
          ? yield* serverSettings.getSettings.pipe(Effect.orDie)
          : yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
      const initialConfigMap =
        initialSettings === undefined
          ? ({} as ProviderInstanceConfigMap)
          : yield* resolveProviderInstanceConfigMap(initialSettings, runtimeProfile).pipe(
              Effect.orDie,
            );

      const mutableLayer = ProviderInstanceRegistryMutableLayer({
        drivers,
        configMap: initialConfigMap,
      });

      return settingsWatcherLive(runtimeProfile).pipe(Layer.provideMerge(mutableLayer));
    }),
  ) as Layer.Layer<
    ProviderInstanceRegistry,
    never,
    R | ServerConfig.ServerConfig | ServerSettingsService
  >;

/** Endpoint-only registry hydration used by the Cocoa gateway profile. */
export const CocoaProviderInstanceRegistryHydrationLive =
  makeProviderInstanceRegistryHydrationLive<CocoaGatewayDriversEnv>(
    "cocoa-gateway",
    COCOA_GATEWAY_DRIVERS,
  );

/** Upstream-compatible registry hydration for the legacy runtime profile. */
export const LegacyProviderInstanceRegistryHydrationLive =
  makeProviderInstanceRegistryHydrationLive<BuiltInDriversEnv>("legacy", BUILT_IN_DRIVERS);

/** Runtime-selected compatibility layer retained for callers outside server composition. */
export const ProviderInstanceRegistryHydrationLive: Layer.Layer<
  ProviderInstanceRegistry,
  never,
  BuiltInDriversEnv | ServerConfig.ServerConfig | ServerSettingsService
> = Layer.unwrap(
  ServerConfig.ServerConfig.pipe(
    Effect.map((config) =>
      config.runtimeProfile === "cocoa-gateway"
        ? CocoaProviderInstanceRegistryHydrationLive
        : LegacyProviderInstanceRegistryHydrationLive,
    ),
  ),
) as Layer.Layer<
  ProviderInstanceRegistry,
  never,
  BuiltInDriversEnv | ServerConfig.ServerConfig | ServerSettingsService
>;
