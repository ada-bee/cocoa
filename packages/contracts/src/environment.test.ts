import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentCapabilities } from "./environment.ts";

const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);

describe("ExecutionEnvironmentCapabilities", () => {
  it("carries administrator-managed server lifecycle ownership across the network boundary", () => {
    expect(
      decodeCapabilities({
        repositoryIdentity: false,
        serverUpdateManagement: "administrator-managed",
      }).serverUpdateManagement,
    ).toBe("administrator-managed");
  });

  it("keeps an absent update capability decodable for legacy servers", () => {
    expect(decodeCapabilities({ repositoryIdentity: true }).serverSelfUpdate).toBeUndefined();
  });

  it("lets older capability decoders ignore administrator management metadata", () => {
    const decodeLegacyCapabilities = Schema.decodeUnknownSync(
      Schema.Struct({ repositoryIdentity: Schema.Boolean }),
    );

    expect(
      decodeLegacyCapabilities({
        repositoryIdentity: false,
        serverUpdateManagement: "administrator-managed",
      }),
    ).toEqual({ repositoryIdentity: false });
  });
});
