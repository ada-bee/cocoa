import {
  type CodexSettings,
  type ModelCapabilities,
  PREFERRED_DEFAULT_CODEX_MODELS,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderState,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";

import type { CodexEndpointConnection } from "../codexEndpoint/CodexEndpointConnection.ts";

export type CodexEndpointProviderDraft = Omit<ServerProvider, "instanceId" | "driver">;

const AUTH_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_SERVICE_TIER_ID = "default";
const CURRENT_CODEX_MODELS = new Set(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
const PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: true,
} as const;

const isLegacyCodexModel = (model: string): boolean => !CURRENT_CODEX_MODELS.has(model);

const reasoningEffortLabel = (reasoningEffort: string): string => {
  const labels: Readonly<Record<string, string>> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
  };
  return labels[reasoningEffort] ?? reasoningEffort;
};

const mapModelCapabilities = (model: CodexSchema.V2ModelListResponse__Model): ModelCapabilities => {
  const reasoningOptions = model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort === model.defaultReasoningEffort
      ? { id: reasoningEffort, label: reasoningEffortLabel(reasoningEffort), isDefault: true }
      : { id: reasoningEffort, label: reasoningEffortLabel(reasoningEffort) },
  );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const serviceTiers =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers
      : (model.additionalSpeedTiers ?? []).map((id) => ({
          id,
          name: id === "fast" ? "Fast" : id,
          description: "",
        }));
  const catalogDefaultServiceTier = serviceTiers.some(
    (tier) => tier.id === model.defaultServiceTier,
  )
    ? model.defaultServiceTier
    : null;
  const defaultServiceTier = catalogDefaultServiceTier ?? DEFAULT_SERVICE_TIER_ID;
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  if (reasoningOptions.length > 0) {
    optionDescriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoningOptions,
      ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
    });
  }
  if (serviceTiers.length > 0) {
    optionDescriptors.push({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        {
          id: DEFAULT_SERVICE_TIER_ID,
          label: "Standard",
          ...(defaultServiceTier === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {}),
        },
        ...serviceTiers.map((tier) => ({
          id: tier.id,
          label: tier.name,
          ...(tier.description ? { description: tier.description } : {}),
          ...(defaultServiceTier === tier.id ? { isDefault: true } : {}),
        })),
      ],
      currentValue: defaultServiceTier,
    });
  }

  return createModelCapabilities({ optionDescriptors });
};

const parseModels = (
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> =>
  response.data.map((model) => ({
    slug: model.model,
    name: model.displayName
      .replace(/^gpt/i, "GPT")
      .replace(/-([a-z])/g, (_, character: string) => `-${character.toUpperCase()}`),
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    ...(isLegacyCodexModel(model.model) ? { isLegacy: true } : {}),
    capabilities: mapModelCapabilities(model),
  }));

const applyPreferredDefault = (
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> => {
  const preferredSlug = PREFERRED_DEFAULT_CODEX_MODELS.find((slug) =>
    models.some((model) => model.slug === slug && !model.isCustom),
  );
  if (!preferredSlug) return models;
  return models.map((model) => {
    if (model.slug === preferredSlug) {
      return model.isDefault ? model : { ...model, isDefault: true };
    }
    if (!model.isDefault) return model;
    const { isDefault: _isDefault, ...rest } = model;
    return rest;
  });
};

const appendCustomModels = (
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> => {
  const seen = new Set(models.map((model) => model.slug));
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  const customEntries: ServerProviderModel[] = [];
  for (const rawModel of customModels) {
    const slug = rawModel.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    customEntries.push({
      slug,
      name: slug,
      isCustom: true,
      capabilities: fallbackCapabilities,
    });
  }
  return customEntries.length === 0 ? models : [...models, ...customEntries];
};

const requestAllModels = Effect.fn("CodexEndpointProviderSnapshot.requestAllModels")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined;
  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseModels(response));
    cursor = response.nextCursor;
  } while (cursor);
  return models;
});

const emptyModelsFromSettings = (settings: CodexSettings): ServerProvider["models"] =>
  Array.from(
    new Set(settings.customModels.map((model) => model.trim()).filter((model) => model.length > 0)),
    (model) => ({ slug: model, name: model, isCustom: true, capabilities: null }),
  );

const buildProvider = (input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
  readonly connectionState: NonNullable<ServerProvider["connectionState"]>;
}): CodexEndpointProviderDraft => ({
  ...PRESENTATION,
  enabled: input.enabled,
  installed: input.installed,
  version: input.version,
  status: input.enabled ? input.status : "disabled",
  auth: input.auth,
  connectionState: input.connectionState,
  checkedAt: input.checkedAt,
  ...(input.message ? { message: input.message } : {}),
  models: input.models,
  slashCommands: [],
  skills: [],
});

export const makePendingCodexEndpointProvider = (
  settings: CodexSettings,
): Effect.Effect<CodexEndpointProviderDraft> =>
  DateTime.now.pipe(
    Effect.map(DateTime.formatIso),
    Effect.map((checkedAt) =>
      buildProvider({
        enabled: settings.enabled,
        checkedAt,
        models: emptyModelsFromSettings(settings),
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        connectionState: settings.enabled ? "connecting" : "disconnected",
        message: settings.enabled
          ? "Codex endpoint provider status has not been checked in this session yet."
          : "Codex is disabled in Cocoa settings.",
      }),
    ),
  );

const accountProbeStatus = (
  account: CodexSchema.V2GetAccountResponse,
): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} => {
  if (!account.account) {
    return account.requiresOpenaiAuth
      ? {
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Codex endpoint is not authenticated. Authenticate it on the provider host.",
        }
      : { status: "ready", auth: { status: "unknown" } };
  }
  const label = (() => {
    if (account.account.type === "apiKey") return "OpenAI API Key";
    if (account.account.type === "amazonBedrock") return "Amazon Bedrock";
    if (account.account.type !== "chatgpt") return undefined;
    switch (account.account.planType) {
      case "free":
        return "ChatGPT Free Subscription";
      case "go":
        return "ChatGPT Go Subscription";
      case "plus":
        return "ChatGPT Plus Subscription";
      case "pro":
        return "ChatGPT Pro 20x Subscription";
      case "prolite":
        return "ChatGPT Pro 5x Subscription";
      case "team":
        return "ChatGPT Team Subscription";
      case "self_serve_business_usage_based":
      case "business":
        return "ChatGPT Business Subscription";
      case "enterprise_cbp_usage_based":
      case "enterprise":
        return "ChatGPT Enterprise Subscription";
      case "edu":
        return "ChatGPT Edu Subscription";
      case "unknown":
        return "ChatGPT Subscription";
    }
  })();
  const email = account.account.type === "chatgpt" ? account.account.email : undefined;
  return {
    status: "ready",
    auth: {
      status: "authenticated",
      type: account.account.type,
      ...(label ? { label } : {}),
      ...(email ? { email } : {}),
    },
  };
};

/** Builds a provider snapshot exclusively through an initialized remote endpoint. */
export const checkCodexEndpointProviderStatus = Effect.fn("CodexEndpointProviderSnapshot.check")(
  function* (
    settings: CodexSettings,
    connection: CodexEndpointConnection["Service"],
  ): Effect.fn.Return<CodexEndpointProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const emptyModels = emptyModelsFromSettings(settings);
    if (!settings.enabled) {
      return buildProvider({
        enabled: false,
        checkedAt,
        models: emptyModels,
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        connectionState: "disconnected",
        message: "Codex is disabled in Cocoa settings.",
      });
    }

    const result = yield* Effect.gen(function* () {
      const account = yield* connection.client.request("account/read", {});
      const models =
        !account.account && account.requiresOpenaiAuth
          ? emptyModels
          : applyPreferredDefault(
              appendCustomModels(yield* requestAllModels(connection.client), settings.customModels),
            );
      return { account, models };
    }).pipe(Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)), Effect.result);

    if (Result.isFailure(result)) {
      return buildProvider({
        enabled: true,
        checkedAt,
        models: emptyModels,
        installed: true,
        version: connection.compatibility.serverVersion ?? null,
        status: "error",
        auth: { status: "unknown" },
        connectionState: "ready",
        message: `Codex endpoint provider status request failed: ${result.failure.message}.`,
      });
    }
    if (Option.isNone(result.success)) {
      return buildProvider({
        enabled: true,
        checkedAt,
        models: emptyModels,
        installed: true,
        version: connection.compatibility.serverVersion ?? null,
        status: "error",
        auth: { status: "unknown" },
        connectionState: "ready",
        message: "Timed out while checking Codex endpoint provider status.",
      });
    }

    const accountStatus = accountProbeStatus(result.success.value.account);
    return buildProvider({
      enabled: true,
      checkedAt,
      models: result.success.value.models,
      installed: true,
      version: connection.compatibility.serverVersion ?? null,
      status: accountStatus.status,
      auth: accountStatus.auth,
      connectionState: accountStatus.auth.status === "unauthenticated" ? "blocked" : "ready",
      message:
        accountStatus.message ??
        "Cocoa gateway MCP tools are deferred for endpoint-backed Codex sessions until a routable gateway MCP endpoint is configured.",
    });
  },
);
