import { describe, expect, it } from "vite-plus/test";

import { connectWithTransport } from "../src/client.ts";
import {
  CocoaClientCapabilityError,
  CocoaClientProtocolError,
  CocoaClientRequestError,
} from "../src/errors.ts";
import type { CocoaClientTransport } from "../src/transport.ts";
import { mapCocoaRpcError } from "../src/transport.ts";
import { items, testInfo } from "./fixtures.ts";

describe("Cocoa client facade", () => {
  it("negotiates before exposing requests and honors a custom protocol range", async () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const transport = {
      state: { status: "connected", attempt: 1 },
      async request(method: string, input: unknown) {
        calls.push({ method, input });
        if (method === "client.info") return testInfo;
        if (method === "client.probe") return { protocolVersion: 1 };
        throw new Error(`Unexpected ${method}`);
      },
      subscribeShell: () => items([]),
      subscribeThread: () => items([]),
      reconnect: async () => {},
      close: async () => {},
    } as unknown as CocoaClientTransport;

    const client = await connectWithTransport(transport, {
      protocolRange: { minimum: 1, maximum: 3 },
    });
    await client.probe();

    expect(calls).toEqual([
      { method: "client.info", input: { protocolRange: { minimum: 1, maximum: 3 } } },
      { method: "client.probe", input: {} },
    ]);
  });

  it("maps protocol and request failures to stable public errors", () => {
    expect(
      mapCocoaRpcError({
        code: "protocol_version_mismatch",
        clientRange: { minimum: 2, maximum: 3 },
        serverRange: { minimum: 1, maximum: 1 },
        message: "No compatible protocol.",
      }),
    ).toBeInstanceOf(CocoaClientProtocolError);
    const requestError = mapCocoaRpcError({
      code: "insufficient_scope",
      message: "Scope is required.",
      requiredScope: "orchestration:operate",
      traceId: "trace-1",
    });
    expect(requestError).toBeInstanceOf(CocoaClientRequestError);
    expect((requestError as CocoaClientRequestError).requiredScope).toBe("orchestration:operate");
  });

  it("provides capability checks from negotiated info", async () => {
    const transport = {
      state: { status: "connected", attempt: 1 },
      request: async () => testInfo,
      subscribeShell: () => items([]),
      subscribeThread: () => items([]),
      reconnect: async () => {},
      close: async () => {},
    } as unknown as CocoaClientTransport;
    const client = await connectWithTransport(transport);

    expect(client.supportsCapability("orchestration.search")).toBe(true);
    expect(client.supportsCapability("workspace.vcs")).toBe(false);
    expect(() => client.requireCapability("workspace.vcs")).toThrow(CocoaClientCapabilityError);
  });
});
