import { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  MAX_REPORTED_PROVIDERS,
  type GatewayHealthSources,
  evaluateGatewayReadiness,
  probeGatewayDatabase,
} from "./GatewayHealth.ts";
import { makeCommandGate, ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

const provider = (
  instanceId: string,
  status: "ready" | "warning" | "error" | "disabled",
  enabled = true,
  authStatus: "authenticated" | "unauthenticated" | "unknown" = "authenticated",
  connectionState?: "ready" | "connecting" | "disconnected" | "blocked",
) =>
  decodeProvider({
    instanceId,
    driver: "codex",
    enabled,
    installed: enabled,
    version: null,
    status,
    auth: { status: authStatus },
    checkedAt: "2026-08-03T20:00:00.000Z",
    models: [],
    ...(connectionState === undefined ? {} : { connectionState }),
  });

const sources = (overrides: Partial<GatewayHealthSources> = {}) => ({
  startupState: Effect.succeed("ready" as const),
  databaseReady: Effect.succeed(true),
  webIndexReady: Effect.succeed(true),
  providerSnapshots: Effect.succeed([provider("macbook_air", "ready")]),
  ...overrides,
});

describe("GatewayHealth", () => {
  it.effect("reports a healthy gateway when all core checks and providers are ready", () =>
    Effect.gen(function* () {
      const report = yield* evaluateGatewayReadiness(sources());

      assert.strictEqual(report.status, "ready");
      assert.deepEqual(report.checks, {
        startup: "ready",
        database: "ready",
        webIndex: "ready",
        providers: "ready",
      });
      assert.deepEqual(report.providers, [
        { instanceId: ProviderInstanceId.make("macbook_air"), state: "ready" },
      ]);
    }),
  );

  it.effect("prefers explicit connection state while preserving disabled precedence", () =>
    Effect.gen(function* () {
      const report = yield* evaluateGatewayReadiness(
        sources({
          providerSnapshots: Effect.succeed([
            provider("protocol_blocked", "warning", true, "authenticated", "blocked"),
            provider("connected", "error", true, "authenticated", "ready"),
            provider("disabled", "disabled", false, "authenticated", "ready"),
          ]),
        }),
      );

      assert.deepEqual(report.providers, [
        { instanceId: ProviderInstanceId.make("protocol_blocked"), state: "blocked" },
        { instanceId: ProviderInstanceId.make("connected"), state: "ready" },
        { instanceId: ProviderInstanceId.make("disabled"), state: "disabled" },
      ]);
    }),
  );

  it.effect("treats connecting and disconnected providers as ready but degraded", () =>
    Effect.gen(function* () {
      const report = yield* evaluateGatewayReadiness(
        sources({
          providerSnapshots: Effect.succeed([
            provider("macbook_air", "warning"),
            provider("linux_dev_box", "error"),
            provider("blocked", "error", true, "unauthenticated"),
            provider("disabled", "disabled", false),
          ]),
        }),
      );

      assert.strictEqual(report.status, "degraded");
      assert.deepEqual(report.providers, [
        { instanceId: ProviderInstanceId.make("macbook_air"), state: "connecting" },
        { instanceId: ProviderInstanceId.make("linux_dev_box"), state: "disconnected" },
        { instanceId: ProviderInstanceId.make("blocked"), state: "blocked" },
        { instanceId: ProviderInstanceId.make("disabled"), state: "disabled" },
      ]);
    }),
  );

  it.effect("returns unready for startup, database, or web-index failures", () =>
    Effect.gen(function* () {
      const reports = yield* Effect.all([
        evaluateGatewayReadiness(sources({ startupState: Effect.succeed("pending") })),
        evaluateGatewayReadiness(sources({ databaseReady: Effect.succeed(false) })),
        evaluateGatewayReadiness(sources({ webIndexReady: Effect.succeed(false) })),
      ]);

      expect(reports.map((report) => report.status)).toEqual(["unready", "unready", "unready"]);
    }),
  );

  it.effect("bounds provider output and never includes provider messages", () =>
    Effect.gen(function* () {
      const configured = Array.from({ length: MAX_REPORTED_PROVIDERS + 10 }, (_, index) => ({
        ...provider(`provider_${index}`, "error"),
        message: `secret provider detail ${index}`,
      }));
      const report = yield* evaluateGatewayReadiness(
        sources({ providerSnapshots: Effect.succeed(configured) }),
      );

      assert.strictEqual(report.providerCount, MAX_REPORTED_PROVIDERS + 10);
      assert.strictEqual(report.providers.length, MAX_REPORTED_PROVIDERS);
      for (const providerHealth of report.providers) {
        assert.deepEqual(Object.keys(providerHealth), ["instanceId", "state"]);
      }
    }),
  );

  it.effect("reads startup state without waiting for command readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pendingGate = yield* makeCommandGate;
        assert.strictEqual(yield* pendingGate.getCommandReadinessState, "pending");
        yield* pendingGate.signalCommandReady;
        assert.strictEqual(yield* pendingGate.getCommandReadinessState, "ready");

        const failedGate = yield* makeCommandGate;
        yield* failedGate.failCommandReady(
          new ServerRuntimeStartupError({
            mode: "web",
            host: null,
            port: 3773,
            cause: new Error("private startup failure"),
          }),
        );
        assert.strictEqual(yield* failedGate.getCommandReadinessState, "failed");
      }),
    ),
  );
});

it.layer(NodeSqliteClient.layerMemory())("GatewayHealth SQLite probe", (it) => {
  it.effect("executes SELECT 1 against the configured SQLite service", () => probeGatewayDatabase);
});
