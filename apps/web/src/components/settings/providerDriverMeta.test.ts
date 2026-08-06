import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  COCOA_PROVIDER_CLIENT_DEFINITION_BY_VALUE,
  COCOA_PROVIDER_CLIENT_DEFINITIONS,
  PROVIDER_CLIENT_DEFINITIONS,
} from "./providerDriverMeta";

describe("Cocoa provider settings boundary", () => {
  it("offers only Codex without deleting upstream-compatible metadata", () => {
    expect(COCOA_PROVIDER_CLIENT_DEFINITIONS.map((definition) => definition.value)).toEqual([
      "codex",
    ]);
    expect(COCOA_PROVIDER_CLIENT_DEFINITION_BY_VALUE[ProviderDriverKind.make("codex")]?.label).toBe(
      "Codex",
    );
    for (const driver of ["claudeAgent", "cursor", "grok", "opencode"]) {
      expect(
        COCOA_PROVIDER_CLIENT_DEFINITION_BY_VALUE[ProviderDriverKind.make(driver)],
      ).toBeUndefined();
    }

    expect(
      PROVIDER_CLIENT_DEFINITIONS.some((definition) => definition.value === "claudeAgent"),
    ).toBe(true);
  });
});
