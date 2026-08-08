import { describe, expect, it, vi } from "vite-plus/test";

import { CocoaClientError, CocoaClientHttpError } from "../src/errors.ts";
import { createCocoaClientHttpSession } from "../src/http.ts";

describe("Cocoa client HTTP authentication", () => {
  it("exchanges a bootstrap credential and uses a one-use WebSocket ticket", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/oauth/token")) {
        return Response.json({
          access_token: "access-secret",
          token_type: "Bearer",
          expires_in: 300,
          scope: "orchestration:read orchestration:operate",
        });
      }
      return Response.json({ ticket: "ticket +/secret", expiresAt: "2026-08-04T01:00:00Z" });
    });

    const session = await createCocoaClientHttpSession({
      baseUrl: "https://cocoa.example.test/nested?ignored=true",
      credential: "bootstrap-secret",
      fetch,
    });
    const firstUrl = await session.issueWebSocketUrl();
    const secondUrl = await session.issueWebSocketUrl();

    expect(requests).toHaveLength(3);
    expect(requests[0]?.url).toBe("https://cocoa.example.test/oauth/token");
    const body = requests[0]?.init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(String(body)).toContain("subject_token=bootstrap-secret");
    expect(String(body)).toContain("scope=orchestration%3Aread+orchestration%3Aoperate");
    expect(requests[1]?.url).toBe("https://cocoa.example.test/api/auth/websocket-ticket");
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe(
      "Bearer access-secret",
    );
    expect(firstUrl).toBe("wss://cocoa.example.test/api/client/v1/ws?wsTicket=ticket+%2B%2Fsecret");
    expect(secondUrl).toBe(firstUrl);
  });

  it("uses a supplied bearer token without exchanging it", async () => {
    const fetch = vi.fn(async () => Response.json({ ticket: "ticket" }));
    const session = await createCocoaClientHttpSession({
      baseUrl: "http://127.0.0.1:4111",
      bearerToken: "existing-token",
      fetch,
    });

    expect(await session.issueWebSocketUrl()).toBe(
      "ws://127.0.0.1:4111/api/client/v1/ws?wsTicket=ticket",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous credentials and exposes sanitized HTTP failures", async () => {
    await expect(
      createCocoaClientHttpSession({
        baseUrl: "https://cocoa.example.test",
        credential: "one",
        bearerToken: "two",
      }),
    ).rejects.toBeInstanceOf(CocoaClientError);

    const session = await createCocoaClientHttpSession({
      baseUrl: "https://cocoa.example.test",
      bearerToken: "secret",
      fetch: async () => new Response("do not expose me", { status: 403 }),
    });
    const error = await session.issueWebSocketUrl().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CocoaClientHttpError);
    expect(String(error)).not.toContain("secret");
    expect(String(error)).not.toContain("do not expose me");
  });
});
