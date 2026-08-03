import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  applyPreferredCodexDefaultModel,
  checkCodexEndpointProviderStatus,
  isLegacyCodexModel,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";
import { CodexEndpointConnection } from "../codexEndpoint/CodexEndpointConnection.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

type RequestCall = { readonly method: string; readonly payload: unknown };
type RequestHandler = (
  method: string,
  payload: unknown,
) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;

const makeEndpointConnection = (
  calls: RequestCall[],
  handler: RequestHandler,
  serverVersion = "0.146.0",
): CodexEndpointConnection["Service"] => {
  const request = ((method: string, payload: unknown) => {
    calls.push({ method, payload });
    return handler(method, payload);
  }) as CodexClient.CodexAppServerClient["Service"]["request"];

  return CodexEndpointConnection.of({
    identity: { providerInstanceId: ProviderInstanceId.make("remote_codex") },
    client: { request } as CodexClient.CodexAppServerClient["Service"],
    compatibility: {
      userAgent: `codex_cli_rs/${serverVersion}`,
      serverVersion,
      codexHome: "/remote/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    awaitTermination: Effect.never,
  });
};

const model = (slug: string, isDefault: boolean) => ({
  additionalSpeedTiers: [],
  defaultReasoningEffort: "medium",
  description: `${slug} description`,
  displayName: slug,
  hidden: false,
  id: slug,
  isDefault,
  model: slug,
  supportedReasoningEfforts: [],
});

it("keeps only the GPT-5.6 Codex family out of legacy models", () => {
  assert.deepStrictEqual(
    ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4"].map((model) => [
      model,
      isLegacyCodexModel(model),
    ]),
    [
      ["gpt-5.6-luna", false],
      ["gpt-5.6-terra", false],
      ["gpt-5.6-sol", false],
      ["gpt-5.4", true],
    ],
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it.effect("builds an authenticated remote snapshot from every model page", () =>
  Effect.gen(function* () {
    const calls: RequestCall[] = [];
    const connection = makeEndpointConnection(calls, (method, payload) => {
      if (method === "account/read") {
        return Effect.succeed({
          account: { type: "chatgpt", email: "ada@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        });
      }
      if (method === "model/list") {
        const cursor = (payload as { readonly cursor?: string }).cursor;
        return cursor === "page-2"
          ? Effect.succeed({ data: [model("gpt-5.6-terra", false)], nextCursor: null })
          : Effect.succeed({ data: [model("gpt-5.4", true)], nextCursor: "page-2" });
      }
      return Effect.die(new Error(`Unexpected endpoint request: ${method}`));
    });

    const status = yield* checkCodexEndpointProviderStatus(
      decodeCodexSettings({ customModels: ["custom-codex", "gpt-5.4"] }),
      connection,
    );

    assert.equal(status.status, "ready");
    assert.equal(status.version, "0.146.0");
    assert.equal(status.auth.status, "authenticated");
    assert.include(status.message, "Cocoa gateway MCP tools are deferred");
    assert.deepStrictEqual(
      status.models.map(({ slug, isCustom, isDefault }) => ({ slug, isCustom, isDefault })),
      [
        { slug: "gpt-5.4", isCustom: false, isDefault: undefined },
        { slug: "gpt-5.6-terra", isCustom: false, isDefault: true },
        { slug: "custom-codex", isCustom: true, isDefault: undefined },
      ],
    );
    assert.deepStrictEqual(status.skills, []);
    assert.deepStrictEqual(calls, [
      { method: "account/read", payload: {} },
      { method: "model/list", payload: {} },
      { method: "model/list", payload: { cursor: "page-2" } },
    ]);
    assert.isFalse(calls.some(({ method }) => method === "initialize" || method === "skills/list"));
  }),
);

it.effect("short-circuits model and skills requests when remote auth is required", () =>
  Effect.gen(function* () {
    const calls: RequestCall[] = [];
    const connection = makeEndpointConnection(calls, (method) =>
      method === "account/read"
        ? Effect.succeed({ account: null, requiresOpenaiAuth: true })
        : Effect.die(new Error(`Unexpected endpoint request: ${method}`)),
    );

    const status = yield* checkCodexEndpointProviderStatus(
      decodeCodexSettings({ customModels: ["custom-offline"] }),
      connection,
    );

    assert.equal(status.status, "error");
    assert.equal(status.auth.status, "unauthenticated");
    assert.deepStrictEqual(
      status.models.map(({ slug }) => slug),
      ["custom-offline"],
    );
    assert.deepStrictEqual(status.skills, []);
    assert.deepStrictEqual(calls, [{ method: "account/read", payload: {} }]);
  }),
);

it.effect("returns an error snapshot when the initialized endpoint request fails", () =>
  Effect.gen(function* () {
    const calls: RequestCall[] = [];
    const failure = new CodexErrors.CodexAppServerTransportError({
      operation: "read-input-stream",
      cause: new Error("endpoint disconnected"),
    });
    const connection = makeEndpointConnection(calls, () => Effect.fail(failure), "0.147.0");

    const status = yield* checkCodexEndpointProviderStatus(decodeCodexSettings({}), connection);

    assert.equal(status.status, "error");
    assert.equal(status.installed, true);
    assert.equal(status.version, "0.147.0");
    assert.include(status.message, "Codex endpoint provider status request failed");
    assert.deepStrictEqual(calls, [{ method: "account/read", payload: {} }]);
  }),
);

it.effect("returns disabled without making endpoint requests", () =>
  Effect.gen(function* () {
    const calls: RequestCall[] = [];
    const connection = makeEndpointConnection(calls, (method) =>
      Effect.die(new Error(`Unexpected endpoint request: ${method}`)),
    );

    const status = yield* checkCodexEndpointProviderStatus(
      decodeCodexSettings({ enabled: false }),
      connection,
    );

    assert.equal(status.status, "disabled");
    assert.deepStrictEqual(calls, []);
  }),
);

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
