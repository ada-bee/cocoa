// @effect-diagnostics globalDate:off -- This standalone CLI test injects a fixed JavaScript clock.

import { describe, expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { computeCocoaSettingsIdentity } from "@t3tools/shared/cocoaDeploymentIdentity";

import {
  type CocoaAcceptancePreflightDependencies,
  type CocoaAcceptancePreflightOptions,
  parseCocoaAcceptancePreflightOptions,
  runCocoaAcceptancePreflight,
} from "./cocoa-acceptance-preflight.ts";

const FIXED_NOW = new Date("2026-08-06T16:00:00.000Z");

const settings = (providers: Record<string, { readonly enabled?: boolean }> = {}) =>
  JSON.stringify({
    providerInstances: Object.fromEntries(
      Object.entries(providers).map(([instanceId, provider]) => [
        instanceId,
        { driver: "codex", ...provider },
      ]),
    ),
  });

const health = { status: "ok", identity: { build: "git:test-build" } };
const readiness = (
  status: "ready" | "degraded" = "ready",
  providers: ReadonlyArray<{ readonly instanceId: string; readonly state: string }> = [
    { instanceId: "macbook", state: "ready" },
    { instanceId: "linux", state: "ready" },
  ],
) => ({
  status,
  identity: { build: "git:test-build", settings: `sha256:${"a".repeat(64)}` },
  checks: {
    startup: "ready",
    database: "ready",
    webIndex: "ready",
    providers: status === "ready" ? "ready" : "degraded",
  },
  providerCount: providers.length,
  providers,
});

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const options = (overrides: Partial<CocoaAcceptancePreflightOptions> = {}) => ({
  gatewayBaseUrl: "http://gateway.test:7331/",
  settingsFile: "/config/settings.json",
  timeoutMs: 100,
  ...overrides,
});

const dependencies = (
  overrides: Partial<CocoaAcceptancePreflightDependencies> = {},
): CocoaAcceptancePreflightDependencies => ({
  fetch: (async (input: string | URL | Request) =>
    String(input).endsWith("/healthz") ? response(health) : response(readiness())) as typeof fetch,
  readTextFile: async () => settings({ macbook: {}, linux: {} }),
  statFile: async () => ({ regularFile: true, mode: 0o600 }),
  now: () => FIXED_NOW,
  ...overrides,
});

describe("Cocoa deployment acceptance preflight", () => {
  it("derives enabled providers and emits stable passing JSON evidence", async () => {
    const calls: Array<{ readonly url: string; readonly method: string | undefined }> = [];
    const evidence = await runCocoaAcceptancePreflight(
      options(),
      dependencies({
        readTextFile: async () =>
          settings({ macbook: {}, disabled: { enabled: false }, linux: {} }),
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(input), method: init?.method });
          return String(input).endsWith("/healthz") ? response(health) : response(readiness());
        }) as typeof fetch,
      }),
    );

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      timestamp: "2026-08-06T16:00:00.000Z",
      gateway: {
        baseUrl: "http://gateway.test:7331/",
        healthzUrl: "http://gateway.test:7331/healthz",
        readyzUrl: "http://gateway.test:7331/readyz",
        timeoutMs: 100,
      },
      expected: { source: "settings", providerIds: ["linux", "macbook"] },
      checks: {
        settings: {
          status: "pass",
          enabledProviderIds: ["linux", "macbook"],
        },
        secrets: { status: "skipped", files: [] },
        healthz: { status: "pass", httpStatus: 200, reportedStatus: "ok" },
        readyz: { status: "pass", httpStatus: 200, reportedStatus: "ready" },
        providers: { status: "pass", expectedCount: 2, reportedCount: 2 },
      },
      success: true,
      failures: [],
    });
    expect(calls).toEqual([
      { url: "http://gateway.test:7331/healthz", method: "GET" },
      { url: "http://gateway.test:7331/readyz", method: "GET" },
    ]);
  });

  it("rejects degraded readiness even when HTTP status is 200", async () => {
    const evidence = await runCocoaAcceptancePreflight(
      options(),
      dependencies({
        fetch: (async (input: string | URL | Request) =>
          String(input).endsWith("/healthz")
            ? response(health)
            : response(
                readiness("degraded", [
                  { instanceId: "macbook", state: "ready" },
                  { instanceId: "linux", state: "disconnected" },
                ]),
              )) as typeof fetch,
      }),
    );

    expect(evidence.success).toBe(false);
    expect(evidence.checks.readyz).toMatchObject({
      status: "fail",
      httpStatus: 200,
      reportedStatus: "degraded",
    });
    expect(evidence.failures.map(({ code }) => code)).toEqual([
      "readiness.not_ready",
      "readiness.check_not_ready",
      "providers.not_ready",
    ]);
  });

  it("fails when an expected provider is missing and when any reported ID is duplicated", async () => {
    const evidence = await runCocoaAcceptancePreflight(
      options(),
      dependencies({
        fetch: (async (input: string | URL | Request) =>
          String(input).endsWith("/healthz")
            ? response(health)
            : response(
                readiness("ready", [
                  { instanceId: "macbook", state: "ready" },
                  { instanceId: "unexpected", state: "ready" },
                  { instanceId: "unexpected", state: "ready" },
                ]),
              )) as typeof fetch,
      }),
    );

    expect(evidence.checks.providers.status).toBe("fail");
    expect(evidence.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "providers.duplicate", target: "unexpected" }),
        expect.objectContaining({ code: "providers.missing", target: "linux" }),
      ]),
    );
  });

  it("reports bounded timeouts and malformed JSON without throwing", async () => {
    let request = 0;
    const evidence = await runCocoaAcceptancePreflight(
      options({ timeoutMs: 5, providerIds: ["macbook"] }),
      dependencies({
        fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
          request += 1;
          if (request === 1) {
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            });
          }
          return new Response("not-json", { status: 200 });
        }) as typeof fetch,
      }),
    );

    expect(evidence.success).toBe(false);
    expect(evidence.failures.map(({ code }) => code)).toEqual([
      "http.timeout",
      "http.malformed_json",
    ]);
    expect(evidence.checks.healthz.status).toBe("fail");
    expect(evidence.checks.readyz.status).toBe("fail");
    expect(evidence.checks.providers.status).toBe("skipped");
  });

  it("checks secret metadata without reading secret contents", async () => {
    const statCalls: Array<string> = [];
    let settingsReads = 0;
    const evidence = await runCocoaAcceptancePreflight(
      options({
        sshIdentity: "/secrets/id_ed25519",
        sshKnownHosts: "/secrets/known_hosts",
      }),
      dependencies({
        readTextFile: async () => {
          settingsReads += 1;
          return settings({ macbook: {}, linux: {} });
        },
        statFile: async (path) => {
          statCalls.push(path);
          return path.endsWith("id_ed25519")
            ? { regularFile: true, mode: 0o644 }
            : { regularFile: false, mode: 0o444 };
        },
      }),
    );

    expect(settingsReads).toBe(1);
    expect(statCalls).toEqual(["/secrets/id_ed25519", "/secrets/known_hosts"]);
    expect(evidence.checks.secrets).toMatchObject({
      status: "fail",
      files: [
        { kind: "identity", status: "fail", regularFile: true, mode: "0644" },
        { kind: "known-hosts", status: "fail", regularFile: false, mode: "0444" },
      ],
    });
    expect(evidence.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "secret.identity_readable_by_others" }),
        expect.objectContaining({ code: "secret.not_regular_file" }),
      ]),
    );
  });

  it("supports explicit provider overrides and validates CLI bounds", async () => {
    const parsed = parseCocoaAcceptancePreflightOptions([
      "--gateway",
      "https://cocoa.example.test/base",
      "--settings",
      "/config/cocoa.json",
      "--provider",
      "macbook",
      "--provider",
      "linux",
      "--timeout-ms",
      "2500",
    ]);
    expect(parsed).toEqual({
      gatewayBaseUrl: "https://cocoa.example.test/base",
      settingsFile: "/config/cocoa.json",
      providerIds: ["macbook", "linux"],
      timeoutMs: 2_500,
    });
    expect(() => parseCocoaAcceptancePreflightOptions(["--timeout-ms", "0"])).toThrow(
      /1 through 120000/,
    );
    expect(() => parseCocoaAcceptancePreflightOptions(["--gateway", "ssh://gateway.test"])).toThrow(
      /http/,
    );
  });

  it("explicitly attests the baked build and loaded provider configuration identities", async () => {
    const settingsText = settings({ macbook: {}, linux: {} });
    const expectedSettings = computeCocoaSettingsIdentity(
      Schema.decodeUnknownSync(ServerSettings)(JSON.parse(settingsText)),
    );
    const evidence = await runCocoaAcceptancePreflight(
      options({ expectedBuildIdentity: "git:test-build", verifySettingsIdentity: true }),
      dependencies({
        readTextFile: async () => settingsText,
        fetch: (async (input: string | URL | Request) =>
          String(input).endsWith("/healthz")
            ? response(health)
            : response({
                ...readiness(),
                identity: { build: "git:test-build", settings: expectedSettings },
              })) as typeof fetch,
      }),
    );

    expect(evidence.checks.identity).toEqual({
      status: "pass",
      expectedBuild: "git:test-build",
      reportedBuild: "git:test-build",
      expectedSettings,
      reportedSettings: expectedSettings,
    });
    expect(evidence.success).toBe(true);
  });

  it("rejects a different running build or loaded provider configuration", async () => {
    const evidence = await runCocoaAcceptancePreflight(
      options({ expectedBuildIdentity: "git:expected", verifySettingsIdentity: true }),
      dependencies(),
    );

    expect(evidence.checks.identity.status).toBe("fail");
    expect(evidence.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["identity.build_mismatch", "identity.settings_mismatch"]),
    );
  });

  it("generates help flags for deployment attestation", () => {
    const parsed = parseCocoaAcceptancePreflightOptions([
      "--expected-build-identity",
      "git:abc123",
      "--verify-settings-identity",
    ]);
    expect(parsed).toMatchObject({
      expectedBuildIdentity: "git:abc123",
      verifySettingsIdentity: true,
    });
  });
});
