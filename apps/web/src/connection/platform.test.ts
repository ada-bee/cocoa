import { describe, expect, it } from "@effect/vitest";

import { readPrimaryEnvironmentTargetResult } from "./platform.ts";

describe("Cocoa primary gateway target", () => {
  it("captures synchronous target read failures", () => {
    const cause = new Error("invalid primary target");
    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("allows reference clients without an implicit primary gateway", () => {
    expect(readPrimaryEnvironmentTargetResult(() => null)).toEqual({
      _tag: "Success",
      target: null,
    });
  });
});
