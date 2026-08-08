import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AssetResource } from "./assets.ts";

const decodeAssetResource = Schema.decodeUnknownSync(AssetResource);

describe("AssetResource", () => {
  it("accepts project identity while retaining the legacy cwd-only shape", () => {
    expect(
      decodeAssetResource({
        _tag: "project-favicon",
        cwd: "/provider/workspace",
        projectId: "project-1",
      }),
    ).toEqual({
      _tag: "project-favicon",
      cwd: "/provider/workspace",
      projectId: "project-1",
    });
    expect(
      decodeAssetResource({ _tag: "project-favicon", cwd: "/legacy/local/workspace" }),
    ).toEqual({ _tag: "project-favicon", cwd: "/legacy/local/workspace" });
  });
});
