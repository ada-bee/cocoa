import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CODEX_APP_SERVER_TESTED_VERSION,
  CodexEndpointTransport,
  CodexGitExecutablePath,
} from "./codexEndpoint.ts";
import { CodexSettings, ServerSettingsPatch } from "./settings.ts";

const decodeTransport = Schema.decodeUnknownSync(CodexEndpointTransport);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const encodeCodexSettings = Schema.encodeSync(CodexSettings);
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

  it("requires an explicit acknowledgement for authenticated non-loopback plaintext", () => {
    expect(() =>
      decodeTransport({
        type: "direct-websocket",
        url: "ws://192.168.20.99:4500",
        authentication: {
          type: "capability-token",
          credential: { source: "file", path: "/run/secrets/codex-token" },
        },
      }),
    ).toThrow(/allowInsecureTransport/);

    expect(
      decodeTransport({
        type: "direct-websocket",
        url: "ws://192.168.20.99:4500",
        allowInsecureTransport: true,
        authentication: {
          type: "signed-bearer-token",
          credential: { source: "file", path: "/run/secrets/codex-token" },
          issuer: "cocoa-gateway",
          audience: "codex-macaroni",
        },
      }),
    ).toMatchObject({
      allowInsecureTransport: true,
      authentication: { type: "signed-bearer-token" },
    });
  });

  it("rejects unauthenticated non-loopback plaintext even with an acknowledgement", () => {
    expect(() =>
      decodeTransport({
        type: "direct-websocket",
        url: "ws://192.168.20.99:4500",
        allowInsecureTransport: true,
        authentication: { type: "none" },
      }),
    ).toThrow(/explicit authentication/);
  });

  it.each(["wss://codex.example.test", "ws://127.0.0.1:4500"])(
    "rejects a redundant insecure-transport acknowledgement for %s",
    (url) => {
      expect(() =>
        decodeTransport({
          type: "direct-websocket",
          url,
          allowInsecureTransport: true,
          authentication: { type: "none" },
        }),
      ).toThrow(/may only acknowledge/);
    },
  );

  it("rejects the removed SSH proxy transport", () => {
    expect(() =>
      decodeTransport({
        type: "ssh-proxy",
        host: "rigatoni-alfredo",
      }),
    ).toThrow();
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
    expect(decoded.endpointTerminal).toEqual({ enabled: false });
    expect(decoded.endpointGitExecutablePath).toBeUndefined();
    expect(decoded.binaryPath).toBe("/opt/codex");
  });

  it("roundtrips an explicit provider-host Git executable path", () => {
    const decoded = decodeCodexSettings({
      endpointGitExecutablePath: "/nix/store/git/bin/git",
    });

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

  it("decodes endpoint transport alongside the legacy fields", () => {
    const decoded = decodeCodexSettings({
      endpointTransport: {
        type: "direct-websocket",
        url: "wss://codex.example.test",
        authentication: { type: "none" },
      },
    });
    expect(decoded.endpointTransport).toEqual({
      type: "direct-websocket",
      url: "wss://codex.example.test",
      authentication: { type: "none" },
    });
    expect(decoded.binaryPath).toBe("codex");
  });

  it("decodes endpoint transport through the legacy Codex settings patch", () => {
    const decoded = decodeServerSettingsPatch({
      providers: {
        codex: {
          endpointTransport: {
            type: "direct-websocket",
            url: " wss://codex.example.test ",
            authentication: { type: "none" },
          },
        },
      },
    });

    expect(decoded.providers?.codex?.endpointTransport).toEqual({
      type: "direct-websocket",
      url: "wss://codex.example.test",
      authentication: { type: "none" },
    });
  });

  it("decodes only complete endpoint terminal settings patches", () => {
    const decoded = decodeServerSettingsPatch({
      providers: {
        codex: {
          endpointTerminal: { enabled: true, sandboxMode: "workspaceWrite" },
        },
      },
    });

    expect(decoded.providers?.codex?.endpointTerminal).toEqual({
      enabled: true,
      sandboxMode: "workspaceWrite",
    });
    expect(() =>
      decodeServerSettingsPatch({
        providers: { codex: { endpointTerminal: { enabled: true } } },
      }),
    ).toThrow(/sandboxMode/);
  });

  it("decodes an explicit endpoint Git executable through settings patches", () => {
    const decoded = decodeServerSettingsPatch({
      providers: {
        codex: { endpointGitExecutablePath: "/run/current-system/sw/bin/git" },
      },
    });

    expect(decoded.providers?.codex?.endpointGitExecutablePath).toBe(
      "/run/current-system/sw/bin/git",
    );
    expect(() =>
      decodeServerSettingsPatch({
        providers: { codex: { endpointGitExecutablePath: "git" } },
      }),
    ).toThrow(/absolute normalized POSIX path/);
  });
});
