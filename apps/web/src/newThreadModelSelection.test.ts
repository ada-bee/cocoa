import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadModelSelection } from "./newThreadModelSelection";

const macbookId = ProviderInstanceId.make("macbook");
const rigatoniId = ProviderInstanceId.make("rigatoni");
const codexDriver = ProviderDriverKind.make("codex");

function provider(
  instanceId: typeof macbookId,
  displayName: string,
  model: string,
): ServerProvider {
  return {
    instanceId,
    driver: codexDriver,
    displayName,
    enabled: true,
    installed: true,
    version: "0.146.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-06T00:00:00.000Z",
    models: [
      {
        slug: model,
        name: model,
        isCustom: false,
        isDefault: true,
        capabilities: {},
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

describe("resolveNewThreadModelSelection", () => {
  const macbook = provider(macbookId, "MacBook Air", "gpt-macbook");
  const rigatoni = provider(rigatoniId, "Linux dev box", "gpt-rigatoni");

  it("does not carry a selection across provider instances of the same driver", () => {
    expect(
      resolveNewThreadModelSelection({
        carriedSelection: {
          instanceId: macbookId,
          model: "gpt-macbook",
          options: [{ id: "reasoning_effort", value: "high" }],
        },
        targetProject: {
          providerInstanceId: rigatoniId,
          defaultModelSelection: {
            instanceId: rigatoniId,
            model: "project-rigatoni-default",
          },
        },
        targetEnvironmentProviders: [macbook, rigatoni],
      }),
    ).toEqual({
      instanceId: rigatoniId,
      model: "project-rigatoni-default",
    });
  });

  it("falls back only to the target endpoint default when the project default is mismatched", () => {
    expect(
      resolveNewThreadModelSelection({
        carriedSelection: { instanceId: macbookId, model: "gpt-macbook" },
        targetProject: {
          providerInstanceId: rigatoniId,
          defaultModelSelection: { instanceId: macbookId, model: "stale-project-default" },
        },
        // The non-target endpoint deliberately comes first: driver-level
        // fallback would incorrectly choose it.
        targetEnvironmentProviders: [macbook, rigatoni],
      }),
    ).toEqual({ instanceId: rigatoniId, model: "gpt-rigatoni" });
  });

  it("preserves a complete carried selection on the exact target endpoint", () => {
    const carriedSelection = {
      instanceId: rigatoniId,
      model: "gpt-rigatoni-custom",
      options: [{ id: "reasoning_effort", value: "xhigh" }],
    } as const;

    expect(
      resolveNewThreadModelSelection({
        carriedSelection,
        targetProject: {
          providerInstanceId: rigatoniId,
          defaultModelSelection: null,
        },
        targetEnvironmentProviders: [macbook, rigatoni],
      }),
    ).toBe(carriedSelection);
  });

  it("uses the configured host default after a project default and before the advertised default", () => {
    expect(
      resolveNewThreadModelSelection({
        carriedSelection: null,
        targetProject: {
          providerInstanceId: rigatoniId,
          defaultModelSelection: null,
        },
        hostDefaultSelection: {
          instanceId: rigatoniId,
          model: "gpt-rigatoni-custom-default",
          options: [{ id: "reasoning_effort", value: "high" }],
        },
        targetEnvironmentProviders: [rigatoni],
      }),
    ).toEqual({
      instanceId: rigatoniId,
      model: "gpt-rigatoni-custom-default",
      options: [{ id: "reasoning_effort", value: "high" }],
    });
  });

  it("returns null instead of carrying another instance when the target has no config or default", () => {
    expect(
      resolveNewThreadModelSelection({
        carriedSelection: { instanceId: macbookId, model: "gpt-macbook" },
        targetProject: {
          providerInstanceId: rigatoniId,
          defaultModelSelection: null,
        },
        targetEnvironmentProviders: [macbook],
      }),
    ).toBeNull();
  });
});
