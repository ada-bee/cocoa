import type { OpenCodeSettings, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities, normalizeCustomModelSlug } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  type OpenCodeEndpointRuntimeShape,
  type OpenCodeInventory,
  openCodeRuntimeErrorDetail,
} from "../OpenCodeEndpointRuntime.ts";
import { buildServerProvider, type ServerProviderDraft } from "../ProviderSnapshotBase.ts";

const PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: false,
} as const;
const DEFAULT_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

const customModels = (settings: OpenCodeSettings): ReadonlyArray<ServerProviderModel> => {
  const seen = new Set<string>();
  return settings.customModels.flatMap((candidate) => {
    const slug = normalizeCustomModelSlug(candidate);
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [{ slug, name: slug, isCustom: true, capabilities: DEFAULT_CAPABILITIES }];
  });
};

const inventoryModels = (
  settings: OpenCodeSettings,
  inventory: OpenCodeInventory,
): ReadonlyArray<ServerProviderModel> => {
  const connected = new Set(inventory.providerList.connected);
  const models: Array<ServerProviderModel> = [];
  for (const provider of inventory.providerList.all) {
    if (!connected.has(provider.id)) continue;
    for (const model of Object.values(provider.models)) {
      const name = model.name?.trim();
      if (!name) continue;
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(provider.name.trim() ? { subProvider: provider.name.trim() } : {}),
        isCustom: false,
        capabilities: DEFAULT_CAPABILITIES,
      });
    }
  }
  const seen = new Set(models.map((model) => model.slug));
  return [
    ...models.toSorted((left, right) => left.name.localeCompare(right.name)),
    ...customModels(settings).filter((model) => !seen.has(model.slug)),
  ];
};

export const makePendingOpenCodeEndpointProvider = (
  settings: OpenCodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: customModels(settings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "OpenCode endpoint status has not been checked in this session yet."
          : "OpenCode is disabled in Cocoa settings.",
      },
    }),
  );

export const checkOpenCodeEndpointProviderStatus = Effect.fn("checkOpenCodeEndpointProviderStatus")(
  function* (
    settings: OpenCodeSettings,
    runtime: OpenCodeEndpointRuntimeShape,
  ): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) {
      return yield* makePendingOpenCodeEndpointProvider(settings);
    }

    const inventoryExit = yield* Effect.exit(
      runtime.loadOpenCodeInventory(
        runtime.createOpenCodeSdkClient({
          baseUrl: settings.serverUrl,
          ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
        }),
      ),
    );
    if (inventoryExit._tag === "Failure") {
      const detail = openCodeRuntimeErrorDetail(Cause.squash(inventoryExit.cause));
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: customModels(settings),
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Could not reach the configured OpenCode endpoint: ${detail}`,
        },
      });
    }

    const connectedCount = inventoryExit.value.providerList.connected.length;
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: inventoryModels(settings, inventoryExit.value),
      probe: {
        installed: true,
        version: null,
        status: connectedCount > 0 ? "ready" : "warning",
        auth: {
          status: connectedCount > 0 ? "authenticated" : "unknown",
          type: "opencode",
        },
        message:
          connectedCount > 0
            ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through the configured OpenCode endpoint.`
            : "Connected to the configured OpenCode endpoint, but it did not report any connected upstream providers.",
      },
    });
  },
);
