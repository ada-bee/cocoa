import { describe, expect, it } from "vite-plus/test";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import { CocoaGatewayEnvironmentHttpApi, EnvironmentHttpApi } from "./environmentHttp.ts";

describe("CocoaGatewayEnvironmentHttpApi", () => {
  it("exposes password bootstrap, pairing, and per-client session endpoints", () => {
    const cocoaPaths = OpenApi.fromApi(CocoaGatewayEnvironmentHttpApi).paths;
    const legacyPaths = OpenApi.fromApi(EnvironmentHttpApi).paths;

    for (const path of [
      "/oauth/token",
      "/api/auth/browser-session",
      "/api/auth/pairing-token",
      "/api/auth/pairing-links",
      "/api/auth/pairing-links/revoke",
      "/api/auth/clients",
      "/api/auth/clients/revoke",
      "/api/auth/clients/revoke-others",
    ]) {
      expect(cocoaPaths).toHaveProperty(path);
      expect(legacyPaths).toHaveProperty(path);
    }
  });
});
