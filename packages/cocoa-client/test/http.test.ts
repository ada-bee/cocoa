import { describe, expect, it } from "vite-plus/test";

import { createCocoaClientHttpSession, normalizeCocoaBaseUrl } from "../src/http.ts";

describe("Cocoa client HTTP session", () => {
  it("connects directly without a client credential or WebSocket ticket", async () => {
    const session = await createCocoaClientHttpSession({
      baseUrl: "https://cocoa.example.test/some/path?ignored=true",
    });

    expect(session.baseUrl.toString()).toBe("https://cocoa.example.test/");
    expect(await session.issueWebSocketUrl()).toBe("wss://cocoa.example.test/api/client/v1/ws");
  });

  it("rejects credential-bearing and unsupported gateway URLs", () => {
    expect(() => normalizeCocoaBaseUrl("ssh://cocoa.example.test")).toThrow(
      "Cocoa baseUrl must use http or https.",
    );
    expect(() => normalizeCocoaBaseUrl("https://user:secret@cocoa.example.test")).toThrow(
      "Cocoa baseUrl must not contain credentials.",
    );
    expect(() => normalizeCocoaBaseUrl("https://cocoa.example.test/#secret")).toThrow(
      "Cocoa baseUrl must not contain a fragment.",
    );
  });
});
