import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CODEX_APP_SERVER_TESTED_VERSION,
  CODEX_SSH_PROXY_REMOTE_COMMAND,
  CodexEndpointTransport,
} from "./codexEndpoint.ts";
import { CodexSettings, ServerSettingsPatch } from "./settings.ts";

const decodeTransport = Schema.decodeUnknownSync(CodexEndpointTransport);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("CodexEndpointTransport", () => {
  it("records a tested version without making it part of endpoint validation", () => {
    expect(CODEX_APP_SERVER_TESTED_VERSION).toBe("0.146.0");
    expect(
      decodeTransport({
        type: "direct-websocket",
        url: "ws://127.0.0.1:4500",
        authentication: { type: "none" },
      }),
    ).not.toHaveProperty("version");
  });

  it("decodes direct websocket transports with explicit authentication", () => {
    expect(
      decodeTransport({
        type: "direct-websocket",
        url: "  wss://codex.example.test/control  ",
        authentication: {
          type: "capability-token",
          credential: { source: "file", path: "  /run/secrets/codex-token  " },
        },
      }),
    ).toEqual({
      type: "direct-websocket",
      url: "wss://codex.example.test/control",
      authentication: {
        type: "capability-token",
        credential: { source: "file", path: "/run/secrets/codex-token" },
      },
    });
  });

  it("supports signed bearer credentials by reference", () => {
    expect(
      decodeTransport({
        type: "direct-websocket",
        url: "wss://codex.example.test",
        authentication: {
          type: "signed-bearer-token",
          credential: { source: "file", path: "/run/secrets/codex-jwt-secret" },
          issuer: " cocoa-gateway ",
          audience: " codex-dev-box ",
        },
      }),
    ).toMatchObject({
      authentication: {
        type: "signed-bearer-token",
        issuer: "cocoa-gateway",
        audience: "codex-dev-box",
      },
    });
  });

  it.each([
    "ws://127.0.0.1:4500",
    "ws://127.23.4.5:4500",
    "ws://localhost:4500",
    "ws://[::1]:4500",
  ])("allows token authentication over plaintext only for loopback URL %s", (url) => {
    expect(() =>
      decodeTransport({
        type: "direct-websocket",
        url,
        authentication: {
          type: "capability-token",
          credential: { source: "file", path: "/tmp/codex-token" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects token authentication over a non-loopback plaintext websocket", () => {
    expect(() =>
      decodeTransport({
        type: "direct-websocket",
        url: "ws://192.168.20.99:4500",
        authentication: {
          type: "capability-token",
          credential: { source: "file", path: "/run/secrets/codex-token" },
        },
      }),
    ).toThrow(/must use wss/);
  });

  it("allows an explicit unauthenticated non-loopback plaintext endpoint", () => {
    expect(() =>
      decodeTransport({
        type: "direct-websocket",
        url: "ws://192.168.20.99:4500",
        authentication: { type: "none" },
      }),
    ).not.toThrow();
  });

  it.each([
    "https://codex.example.test",
    "not a URL",
    "ws://user:secret@localhost:4500",
    "ws://localhost:4500?token=secret",
    "ws://localhost:4500/#fragment",
  ])("rejects invalid or credential-bearing websocket URL %s", (url) => {
    expect(() =>
      decodeTransport({
        type: "direct-websocket",
        url,
        authentication: { type: "none" },
      }),
    ).toThrow();
  });

  it("decodes an SSH proxy with only structured argv-safe options", () => {
    expect(CODEX_SSH_PROXY_REMOTE_COMMAND).toEqual(["codex", "app-server", "proxy"]);
    expect(
      decodeTransport({
        type: "ssh-proxy",
        host: " rigatoni-alfredo ",
        user: " ada ",
        port: 22,
        options: {
          identityFile: "/run/secrets/codex-ssh-key",
          connectTimeoutSeconds: 15,
          serverAliveIntervalSeconds: 30,
          serverAliveCountMax: 3,
          strictHostKeyChecking: "accept-new",
        },
        command: "unsafe command is discarded and never modeled",
      }),
    ).toEqual({
      type: "ssh-proxy",
      host: "rigatoni-alfredo",
      user: "ada",
      port: 22,
      options: {
        identityFile: "/run/secrets/codex-ssh-key",
        connectTimeoutSeconds: 15,
        serverAliveIntervalSeconds: 30,
        serverAliveCountMax: 3,
        strictHostKeyChecking: "accept-new",
      },
    });
  });

  it.each(["-oProxyCommand=evil", "host name", "ada@host"])(
    "rejects unsafe SSH host %s",
    (host) => {
      expect(() => decodeTransport({ type: "ssh-proxy", host })).toThrow();
    },
  );

  it("requires absolute credential paths", () => {
    expect(() =>
      decodeTransport({
        type: "direct-websocket",
        url: "wss://codex.example.test",
        authentication: {
          type: "capability-token",
          credential: { source: "file", path: "relative/token" },
        },
      }),
    ).toThrow(/must be absolute/);
  });
});

describe("CodexSettings endpoint transition", () => {
  it("keeps legacy local settings decodable while the remote runtime is introduced", () => {
    const decoded = decodeCodexSettings({ binaryPath: "/opt/codex", homePath: "/tmp/codex" });
    expect(decoded.endpointTransport).toBeUndefined();
    expect(decoded.binaryPath).toBe("/opt/codex");
  });

  it("decodes endpoint transport alongside the legacy fields", () => {
    const decoded = decodeCodexSettings({
      endpointTransport: {
        type: "ssh-proxy",
        host: "192.168.20.61",
        user: "ada",
      },
    });
    expect(decoded.endpointTransport).toEqual({
      type: "ssh-proxy",
      host: "192.168.20.61",
      user: "ada",
    });
    expect(decoded.binaryPath).toBe("codex");
  });

  it("decodes endpoint transport through the legacy Codex settings patch", () => {
    const decoded = decodeServerSettingsPatch({
      providers: {
        codex: {
          endpointTransport: {
            type: "ssh-proxy",
            host: " rigatoni-alfredo ",
            user: " ada ",
          },
        },
      },
    });

    expect(decoded.providers?.codex?.endpointTransport).toEqual({
      type: "ssh-proxy",
      host: "rigatoni-alfredo",
      user: "ada",
    });
  });
});
