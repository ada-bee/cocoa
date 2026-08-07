import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderHostConfig, ProviderHostConfigMap, ProviderHostId } from "./providerHost.ts";

const decodeProviderHostId = Schema.decodeUnknownSync(ProviderHostId);
const decodeProviderHostConfig = Schema.decodeUnknownSync(ProviderHostConfig);
const decodeProviderHostConfigMap = Schema.decodeUnknownSync(ProviderHostConfigMap);

const transport = {
  type: "cocoa-host" as const,
  url: "wss://host.example.test/",
  key: "host-key",
};

describe("ProviderHostId", () => {
  it.each(["main", "mac_studio", "linux-build-1", "HostA"])("accepts %s", (id) => {
    expect(decodeProviderHostId(id)).toBe(id);
  });

  it("trims surrounding whitespace", () => {
    expect(decodeProviderHostId("  mac_studio  ")).toBe("mac_studio");
  });

  it.each(["", "1host", "_host", "host.local", "host path", "host/path"])(
    "rejects invalid id %j",
    (id) => {
      expect(() => decodeProviderHostId(id)).toThrow();
    },
  );
});

describe("ProviderHostConfig", () => {
  it("decodes and normalizes a Cocoa host transport", () => {
    const decoded = decodeProviderHostConfig({
      displayName: "  Mac Studio  ",
      iconSvg: "  <svg><path /></svg>  ",
      accentColor: "  #dc2626  ",
      transport,
    });

    expect(decoded).toEqual({
      displayName: "Mac Studio",
      iconSvg: "<svg><path /></svg>",
      accentColor: "#dc2626",
      transport,
    });
  });

  it("accepts a transport-only host config", () => {
    expect(decodeProviderHostConfig({ transport })).toEqual({ transport });
  });

  it("retains Cocoa host transport security validation", () => {
    expect(() =>
      decodeProviderHostConfig({
        transport: {
          type: "cocoa-host",
          url: "ws://remote.example.test/",
          key: "host-key",
        },
      }),
    ).toThrow();
  });

  it("bounds inline host icons to 64 KiB", () => {
    expect(
      decodeProviderHostConfig({
        iconSvg: "x".repeat(64 * 1024),
        transport,
      }).iconSvg,
    ).toHaveLength(64 * 1024);

    expect(() =>
      decodeProviderHostConfig({
        iconSvg: "x".repeat(64 * 1024 + 1),
        transport,
      }),
    ).toThrow();
  });
});

describe("ProviderHostConfigMap", () => {
  it("decodes multiple independently configured hosts", () => {
    const decoded = decodeProviderHostConfigMap({
      mac_studio: { displayName: "Mac Studio", transport },
      linux_build: {
        transport: {
          type: "cocoa-host",
          url: "wss://linux.example.test/",
          key: "linux-key",
        },
      },
    });

    expect(Object.keys(decoded)).toEqual(["mac_studio", "linux_build"]);
    expect(decoded[ProviderHostId.make("linux_build")]?.transport.url).toBe(
      "wss://linux.example.test/",
    );
  });

  it("rejects invalid host map keys", () => {
    expect(() =>
      decodeProviderHostConfigMap({
        "1host": { transport },
      }),
    ).toThrow();
  });
});
