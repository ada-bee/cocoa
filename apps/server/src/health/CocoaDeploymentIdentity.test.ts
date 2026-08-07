import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  computeCocoaSettingsIdentity,
  normalizeCocoaBuildIdentity,
} from "./CocoaDeploymentIdentity.ts";

const INSTANCE_ID = ProviderInstanceId.make("macbook");
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [INSTANCE_ID]: {
      driver: ProviderDriverKind.make("codex"),
      displayName: "MacBook",
      enabled: true,
      config: {
        endpointTransport: {
          type: "cocoa-host",
          url: "wss://macbook.example.test/codex",
          key: "test_host_key",
        },
      },
    },
  },
  textGenerationModelSelection: {
    instanceId: INSTANCE_ID,
    model: "gpt-5.4",
  },
};
const baseInstance = settings.providerInstances[INSTANCE_ID]!;

describe("Cocoa deployment identities", () => {
  it("normalizes a bounded public build identity", () => {
    expect(normalizeCocoaBuildIdentity(undefined)).toBe("development");
    expect(normalizeCocoaBuildIdentity(" git:abc123 ")).toBe("git:abc123");
    expect(() => normalizeCocoaBuildIdentity("contains a space")).toThrow(/URI-safe/);
  });

  it("is stable across object key order and changes with loaded provider configuration", () => {
    const reordered = {
      ...settings,
      providerInstances: Object.fromEntries(
        Object.entries(settings.providerInstances).toReversed(),
      ),
    };
    expect(computeCocoaSettingsIdentity(reordered)).toBe(computeCocoaSettingsIdentity(settings));
    expect(
      computeCocoaSettingsIdentity({
        ...settings,
        textGenerationModelSelection: {
          instanceId: INSTANCE_ID,
          model: "gpt-5.5",
        },
      }),
    ).not.toBe(computeCocoaSettingsIdentity(settings));
  });

  it("does not hash ignored provider process-environment credential contents", () => {
    const withEnvironment = (value: string) => ({
      ...settings,
      providerInstances: {
        [INSTANCE_ID]: {
          ...baseInstance,
          environment: [{ name: "SECRET", value, sensitive: true }],
        },
      },
    });
    expect(computeCocoaSettingsIdentity(withEnvironment("first-secret"))).toBe(
      computeCocoaSettingsIdentity(withEnvironment("second-secret")),
    );
  });
});
