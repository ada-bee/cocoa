// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

import {
  COCOA_GATEWAY_FORBIDDEN_DEPENDENCY_ALLOWLIST,
  COCOA_GATEWAY_RUNTIME_DEPENDENCY_MAP,
} from "./CocoaGatewayArchitecture.ts";

const serverSource = NodeFS.readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const serverEnvironmentSource = NodeFS.readFileSync(
  new URL("../environment/ServerEnvironment.ts", import.meta.url),
  "utf8",
);

const initializer = (name: string, nextName: string): string => {
  const startToken = `const ${name} =`;
  const endToken = `const ${nextName} =`;
  const start = serverSource.indexOf(startToken);
  const end = serverSource.indexOf(endToken, start + startToken.length);
  if (start < 0 || end < 0) {
    throw new Error(`Could not locate Cocoa runtime composition '${name}'.`);
  }
  return serverSource.slice(start, end);
};

const cocoaComposition = [
  initializer("CocoaRuntimeBaseDependenciesLive", "CocoaRuntimeCoreDependenciesLive"),
  initializer("CocoaRuntimeCoreDependenciesLive", "AnalyticsLayerLive"),
  initializer("CocoaRuntimeDependenciesLive", "ServerSelfUpdateLayerLive"),
].join("\n");

const containsSymbol = (source: string, symbol: string): boolean =>
  new RegExp(
    `(?<![A-Za-z0-9_])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`,
  ).test(source);

describe("Cocoa gateway architecture", () => {
  it("has an empty forbidden dependency allowlist", () => {
    expect(COCOA_GATEWAY_FORBIDDEN_DEPENDENCY_ALLOWLIST).toEqual([]);
  });

  it("assembles every declared provider boundary and no local or hosted implementation", () => {
    for (const dependency of Object.values(COCOA_GATEWAY_RUNTIME_DEPENDENCY_MAP)) {
      for (const gatewayLayer of dependency.gatewayLayers) {
        expect(
          containsSymbol(cocoaComposition, gatewayLayer),
          `missing gateway layer ${gatewayLayer}`,
        ).toBe(true);
      }
      for (const legacyCallSite of dependency.legacyCallSites) {
        expect(
          containsSymbol(cocoaComposition, legacyCallSite),
          `forbidden Cocoa dependency ${legacyCallSite}`,
        ).toBe(false);
      }
    }
  });

  it("keeps conditional legacy process services out of the Cocoa branch", () => {
    expect(serverSource).toContain(
      "const LegacyRuntimeDependenciesWithVcsLive = LegacyRuntimeDependenciesLive.pipe(",
    );
    expect(serverSource).toContain(
      "const hostedRuntimeLayer = legacyFleetFeatures ? LegacyHostedRuntimeLayerLive : Layer.empty;",
    );
    expect(serverSource).toContain('config.runtimeProfile === "cocoa-gateway"');
    expect(serverSource).toContain("Cocoa gateway updates are administrator-managed.");
    expect(serverSource).toContain(
      'if (config.runtimeProfile !== "cocoa-gateway") {\n      yield* fixPath();',
    );
    expect(serverSource.match(/yield\* fixPath\(\);/g)).toHaveLength(1);
  });

  it("keeps Cocoa environment metadata free of host command probes", () => {
    const cocoaEnvironmentStart = serverEnvironmentSource.indexOf(
      "export const makeCocoaGateway =",
    );
    const cocoaEnvironmentEnd = serverEnvironmentSource.indexOf(
      "export const cocoaGatewayLayer =",
      cocoaEnvironmentStart,
    );
    expect(cocoaEnvironmentStart).toBeGreaterThanOrEqual(0);
    expect(cocoaEnvironmentEnd).toBeGreaterThan(cocoaEnvironmentStart);

    const cocoaEnvironment = serverEnvironmentSource.slice(
      cocoaEnvironmentStart,
      cocoaEnvironmentEnd,
    );
    expect(cocoaEnvironment).not.toContain("ProcessRunner");
    expect(cocoaEnvironment).not.toContain("resolveServerEnvironmentLabel");
    expect(cocoaEnvironment).not.toContain("resolveServiceLauncherMode");
  });
});
