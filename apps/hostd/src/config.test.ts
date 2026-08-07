// @effect-diagnostics nodeBuiltinImport:off - This host-runtime test verifies native path defaults.

import { describe, expect, test } from "bun:test";
import * as NodePath from "node:path";

import { defaultCodexSocketPath, makeHostdConfig } from "./config.ts";

describe("hostd defaults", () => {
  test("resolves the Codex daemon control socket from CODEX_HOME", () => {
    expect(defaultCodexSocketPath({ CODEX_HOME: "/tmp/codex-test" })).toBe(
      NodePath.join("/tmp/codex-test", "app-server-control", "app-server-control.sock"),
    );
  });

  test("accepts runtime overrides without persisting settings", () => {
    expect(
      makeHostdConfig({
        bindHost: "127.0.0.1",
        port: 0,
        advertiseUrl: "ws://test.invalid/",
        socketPath: "/tmp/codex.sock",
        key: "test-key",
      }),
    ).toEqual({
      bindHost: "127.0.0.1",
      port: 0,
      advertiseUrl: "ws://test.invalid/",
      socketPath: "/tmp/codex.sock",
      key: "test-key",
    });
  });

  test("derives a stable base64url key from the advertised URL", () => {
    const first = makeHostdConfig({ advertiseUrl: "ws://harness.example:4501/" });
    const second = makeHostdConfig({ advertiseUrl: "ws://harness.example:4501/" });

    expect(first.key).toBe(second.key);
    expect(first.key).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
