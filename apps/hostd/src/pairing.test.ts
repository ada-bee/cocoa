import { describe, expect, test } from "bun:test";
import { decodeCocoaHostPairingToken } from "@t3tools/contracts";

import { COCOA_HOST_PAIRING_PREFIX, decodePairingToken, encodePairingToken } from "./pairing.ts";

describe("Cocoa host pairing token", () => {
  test("round trips the versioned URL and key payload", () => {
    const payload = {
      version: 1 as const,
      url: "ws://harness.example:4501/",
      key: "pairing-key",
    };
    const token = encodePairingToken(payload);

    expect(token.startsWith(COCOA_HOST_PAIRING_PREFIX)).toBe(true);
    expect(decodePairingToken(token)).toEqual(payload);
    const decoded = decodeCocoaHostPairingToken(token);
    expect(decoded.type).toBe("cocoa-host");
    expect(decoded.url).toBe(payload.url);
    expect(String(decoded.key)).toBe(payload.key);
    expect(decoded.allowInsecureTransport).toBe(true);
  });

  test("rejects malformed or incomplete tokens", () => {
    expect(() => decodePairingToken("not-a-token")).toThrow("prefix");
    expect(() =>
      decodePairingToken(
        `${COCOA_HOST_PAIRING_PREFIX}${Buffer.from("{}", "utf8").toString("base64url")}`,
      ),
    ).toThrow("fields");
  });
});
