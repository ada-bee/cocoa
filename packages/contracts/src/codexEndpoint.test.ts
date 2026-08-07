import { describe, expect, it } from "vite-plus/test";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  CODEX_APP_SERVER_TESTED_VERSION,
  COCOA_HOST_PAIRING_TOKEN_PREFIX,
  CocoaHostPairingToken,
  CodexEndpointTransport,
  CodexGitExecutablePath,
  decodeCocoaHostPairingToken,
  encodeCocoaHostPairingToken,
} from "./codexEndpoint.ts";
import { CodexSettings, ServerSettingsPatch } from "./settings.ts";

const decodeTransport = Schema.decodeUnknownSync(CodexEndpointTransport);
const decodeTokenSchema = Schema.decodeUnknownSync(CocoaHostPairingToken);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const encodeCodexSettings = Schema.encodeSync(CodexSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

const tokenFor = (payload: unknown) =>
  `${COCOA_HOST_PAIRING_TOKEN_PREFIX}${Encoding.encodeBase64Url(JSON.stringify(payload))}`;

describe("CodexEndpointTransport", () => {
  it("records a tested version without making it part of endpoint validation", () => {
    expect(CODEX_APP_SERVER_TESTED_VERSION).toBe("0.146.0");
    expect(
      decodeTransport({ type: "cocoa-host", url: "ws://127.0.0.1:4510", key: "host_key" }),
    ).not.toHaveProperty("version");
  });

  it("decodes the single Cocoa host transport", () => {
    expect(
      decodeTransport({
        type: "cocoa-host",
        url: "  wss://host.example.test/control  ",
        key: "  cocoa_host_abc123  ",
      }),
    ).toEqual({
      type: "cocoa-host",
      url: "wss://host.example.test/control",
      key: "cocoa_host_abc123",
    });
  });

  it("rejects the removed direct WebSocket transport", () => {
    expect(() =>
      decodeTransport({
        type: "direct-websocket",
        url: "ws://127.0.0.1:4500",
        authentication: { type: "none" },
      }),
    ).toThrow();
  });

  it("requires an explicit acknowledgement for non-loopback plaintext hosts", () => {
    expect(() =>
      decodeTransport({ type: "cocoa-host", url: "ws://192.168.20.99:4510", key: "host_key" }),
    ).toThrow(/allowInsecureTransport/);

    expect(
      decodeTransport({
        type: "cocoa-host",
        url: "ws://192.168.20.99:4510",
        key: "host_key",
        allowInsecureTransport: true,
      }),
    ).toHaveProperty("allowInsecureTransport", true);
  });

  it.each(["wss://host.example.test", "ws://127.0.0.1:4510"])(
    "rejects a redundant insecure-transport acknowledgement for %s",
    (url) => {
      expect(() =>
        decodeTransport({ type: "cocoa-host", url, key: "host_key", allowInsecureTransport: true }),
      ).toThrow(/may only acknowledge/);
    },
  );

  it.each([
    "https://host.example.test",
    "not a URL",
    "ws://user:secret@localhost:4510",
    "ws://localhost:4510?key=secret",
    "ws://localhost:4510/#fragment",
  ])("rejects invalid or credential-bearing host URL %s", (url) => {
    expect(() => decodeTransport({ type: "cocoa-host", url, key: "host_key" })).toThrow();
  });

  it.each(["", "has spaces", "has.period", "line\nbreak", "ü"])(
    "rejects a host key that is not base64url: %j",
    (key) => {
      expect(() =>
        decodeTransport({ type: "cocoa-host", url: "ws://127.0.0.1:4510", key }),
      ).toThrow();
    },
  );
});

describe("CocoaHostPairingToken", () => {
  it("encodes the canonical v1 token and roundtrips it", () => {
    const transport = decodeTransport({
      type: "cocoa-host",
      url: "wss://host.example.test/control",
      key: "host_key_abc123",
    });
    const token = encodeCocoaHostPairingToken(transport);

    expect(token.startsWith(COCOA_HOST_PAIRING_TOKEN_PREFIX)).toBe(true);
    const encodedPayload = token.slice(COCOA_HOST_PAIRING_TOKEN_PREFIX.length);
    expect(Result.getOrThrow(Encoding.decodeBase64UrlString(encodedPayload))).toBe(
      '{"version":1,"url":"wss://host.example.test/control","key":"host_key_abc123"}',
    );
    expect(decodeCocoaHostPairingToken(token)).toEqual(transport);
    expect(decodeTokenSchema(`  ${token}  `)).toEqual(transport);
  });

  it("turns a pasted non-loopback ws token into an explicit plaintext acknowledgement", () => {
    expect(
      decodeCocoaHostPairingToken(
        tokenFor({ version: 1, url: "ws://192.168.20.99:4510", key: "host_key" }),
      ),
    ).toEqual({
      type: "cocoa-host",
      url: "ws://192.168.20.99:4510",
      key: "host_key",
      allowInsecureTransport: true,
    });
  });

  it.each([
    "not-a-token",
    COCOA_HOST_PAIRING_TOKEN_PREFIX,
    `${COCOA_HOST_PAIRING_TOKEN_PREFIX}***`,
    tokenFor({ version: 2, url: "wss://host.example.test", key: "host_key" }),
    tokenFor({ version: 1, url: "https://host.example.test", key: "host_key" }),
    tokenFor({ version: 1, url: "wss://host.example.test", key: "invalid key" }),
  ])("rejects an invalid pairing token", (token) => {
    expect(() => decodeCocoaHostPairingToken(token)).toThrow();
  });
});

describe("CodexSettings endpoint transition", () => {
  it("keeps legacy local settings decodable while the remote runtime is introduced", () => {
    const decoded = decodeCodexSettings({ binaryPath: "/opt/codex", homePath: "/tmp/codex" });
    expect(decoded.endpointTransport).toBeUndefined();
    expect(decoded.endpointTerminal).toEqual({ enabled: false });
    expect(decoded.endpointGitExecutablePath).toBeUndefined();
    expect(decoded.binaryPath).toBe("/opt/codex");
  });

  it("roundtrips an explicit provider-host Git executable path", () => {
    const decoded = decodeCodexSettings({ endpointGitExecutablePath: "/nix/store/git/bin/git" });
    expect(decoded.endpointGitExecutablePath).toBe("/nix/store/git/bin/git");
    expect(decodeCodexSettings(encodeCodexSettings(decoded))).toEqual(decoded);
  });

  it.each(["git", "./git", "/usr/../bin/git", "/usr//bin/git", "/usr/bin/git/", "C:\\git.exe"])(
    "rejects invalid endpoint Git executable path %s",
    (endpointGitExecutablePath) => {
      expect(() => decodeCodexSettings({ endpointGitExecutablePath })).toThrow();
      expect(() => CodexGitExecutablePath.make(endpointGitExecutablePath)).toThrow();
    },
  );

  it("requires an explicit sandbox mode when endpoint terminals are enabled", () => {
    expect(() => decodeCodexSettings({ endpointTerminal: { enabled: true } })).toThrow(
      /sandboxMode/,
    );
  });

  it.each(["workspaceWrite", "dangerFullAccess"] as const)(
    "roundtrips the explicit %s endpoint terminal mode",
    (sandboxMode) => {
      const decoded = decodeCodexSettings({
        endpointTerminal: { enabled: true, sandboxMode },
      });
      expect(decodeCodexSettings(encodeCodexSettings(decoded))).toEqual(decoded);
    },
  );

  it("decodes a Cocoa host transport through settings and patches", () => {
    const endpointTransport = {
      type: "cocoa-host" as const,
      url: "wss://host.example.test",
      key: "host_key",
    };
    expect(decodeCodexSettings({ endpointTransport }).endpointTransport).toEqual(endpointTransport);
    expect(
      decodeServerSettingsPatch({ providers: { codex: { endpointTransport } } }).providers?.codex
        ?.endpointTransport,
    ).toEqual(endpointTransport);
  });

  it("decodes only complete endpoint terminal settings patches", () => {
    const decoded = decodeServerSettingsPatch({
      providers: {
        codex: { endpointTerminal: { enabled: true, sandboxMode: "workspaceWrite" } },
      },
    });
    expect(decoded.providers?.codex?.endpointTerminal).toEqual({
      enabled: true,
      sandboxMode: "workspaceWrite",
    });
    expect(() =>
      decodeServerSettingsPatch({ providers: { codex: { endpointTerminal: { enabled: true } } } }),
    ).toThrow(/sandboxMode/);
  });
});
