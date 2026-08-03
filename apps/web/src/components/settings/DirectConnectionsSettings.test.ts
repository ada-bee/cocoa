import { describe, expect, it } from "vite-plus/test";

import { parseDirectPairingInput } from "./DirectConnectionsSettings";

describe("direct Cocoa gateway pairing", () => {
  it("accepts a full pairing link and keeps credentials out of the saved host", () => {
    expect(
      parseDirectPairingInput({
        gateway: "https://cocoa.example.test/pair#token=one-time-secret",
        pairingCode: "",
      }),
    ).toEqual({
      host: "https://cocoa.example.test",
      pairingCode: "one-time-secret",
    });
  });

  it("accepts a direct gateway URL with a separately entered code", () => {
    expect(
      parseDirectPairingInput({
        gateway: "192.168.20.99:3773/path",
        pairingCode: "pair-code",
      }),
    ).toEqual({
      host: "https://192.168.20.99:3773",
      pairingCode: "pair-code",
    });
  });

  it("rejects an input without a one-time code", () => {
    expect(() =>
      parseDirectPairingInput({ gateway: "https://cocoa.example.test", pairingCode: "" }),
    ).toThrowError("Enter the one-time pairing code from the gateway.");
  });
});
