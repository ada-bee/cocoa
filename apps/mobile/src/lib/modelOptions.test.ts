import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveProjectModelSelection,
  resolveSelectableModelSelection,
} from "./modelOptions";

describe("mobile model options", () => {
  it("groups models by provider and flags legacy entries", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });

  it("keeps legacy and cross-provider models out of implicit project defaults", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-current", name: "Current", isCustom: false, capabilities: null },
            {
              slug: "gpt-legacy",
              name: "Legacy",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: "codex-work",
          driver: "codex",
          displayName: "Work",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-current", name: "Current", isCustom: false, capabilities: null }],
        },
      ],
    } as unknown as ServerConfig;
    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-current" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-legacy" };
    const other = { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-current" };

    expect(resolveDefaultableModelSelection(config, current, current.instanceId)).toBe(current);
    expect(resolveDefaultableModelSelection(config, legacy, current.instanceId)).toBeNull();
    expect(resolveDefaultableModelSelection(config, other, current.instanceId)).toBeNull();
    expect(resolveDefaultableModelSelection(null, legacy, current.instanceId)).toBe(legacy);
  });

  it("rejects explicitly blocked and disconnected endpoints while preserving legacy snapshots", () => {
    const provider = (instanceId: string, connectionState?: string) => ({
      instanceId,
      driver: "codex",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      ...(connectionState === undefined ? {} : { connectionState }),
      models: [
        {
          slug: "gpt-test",
          name: "GPT Test",
          isCustom: false,
          capabilities: null,
        },
      ],
    });
    const config = {
      providers: [
        provider("legacy"),
        provider("ready", "ready"),
        provider("connecting", "connecting"),
        provider("blocked", "blocked"),
        provider("disconnected", "disconnected"),
      ],
    } as unknown as ServerConfig;
    const selection = (instanceId: string) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      model: "gpt-test",
    });

    expect(resolveSelectableModelSelection(config, selection("legacy"))).not.toBeNull();
    expect(resolveSelectableModelSelection(config, selection("ready"))).not.toBeNull();
    expect(resolveSelectableModelSelection(config, selection("connecting"))).not.toBeNull();
    expect(resolveSelectableModelSelection(config, selection("blocked"))).toBeNull();
    expect(resolveSelectableModelSelection(config, selection("disconnected"))).toBeNull();
    expect(
      buildModelOptions(config, selection("blocked")).map((option) => option.providerKey),
    ).toEqual(["legacy", "ready", "connecting"]);
  });

  it("restricts choices and stored fallbacks to the selected project's provider endpoint", () => {
    const macbookProvider = ProviderInstanceId.make("codex-macbook");
    const linuxProvider = ProviderInstanceId.make("codex-linux");
    const config = {
      providers: [
        {
          instanceId: macbookProvider,
          driver: "codex",
          displayName: "MacBook Air",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-macbook",
              name: "MacBook model",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: linuxProvider,
          driver: "codex",
          displayName: "Linux box",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-linux",
              name: "Linux model",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;
    const mismatchedStoredSelection = {
      instanceId: linuxProvider,
      model: "gpt-linux",
    };

    expect(buildModelOptions(config, mismatchedStoredSelection, macbookProvider)).toMatchObject([
      {
        key: "codex-macbook:gpt-macbook",
        selection: { instanceId: "codex-macbook", model: "gpt-macbook" },
      },
    ]);
    expect(
      resolveSelectableModelSelection(config, mismatchedStoredSelection, macbookProvider),
    ).toBeNull();
    // Project ownership is authoritative even while its environment config is offline.
    expect(
      resolveSelectableModelSelection(null, mismatchedStoredSelection, macbookProvider),
    ).toBeNull();
    const matchingFallback = {
      instanceId: macbookProvider,
      model: "gpt-macbook",
    };
    expect(
      resolveProjectModelSelection(config, macbookProvider, [
        mismatchedStoredSelection,
        matchingFallback,
      ]),
    ).toBe(matchingFallback);
    expect(
      resolveProjectModelSelection(config, macbookProvider, [mismatchedStoredSelection]),
    ).toBeNull();
  });
});
