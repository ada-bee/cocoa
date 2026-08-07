import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type ProviderHostConfig,
  ProviderHostConfigMap,
  ProviderHostId,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const driverKind = ProviderDriverKind.make("hostAwareTest");
const instanceId = ProviderInstanceId.make("hosted_instance");
const hostId = ProviderHostId.make("main_host");
const decodeHostMap = Schema.decodeUnknownSync(ProviderHostConfigMap);

const hostedConfig: ProviderInstanceConfigMap = {
  [instanceId]: {
    driver: driverKind,
    hostId,
  },
};

const legacyConfig: ProviderInstanceConfigMap = {
  [instanceId]: {
    driver: driverKind,
  },
};

const hostMap = (url: string) =>
  decodeHostMap({
    main_host: {
      displayName: "Main Host",
      transport: {
        type: "cocoa-host",
        url,
        key: "test_host_key",
      },
    },
  });

const makeInstance = (input: ProviderDriverCreateInput<unknown>): ProviderInstance => ({
  instanceId: input.instanceId,
  driverKind,
  continuationIdentity: defaultProviderContinuationIdentity({
    driverKind,
    instanceId: input.instanceId,
  }),
  displayName: input.displayName,
  accentColor: input.accentColor,
  enabled: input.enabled,
  snapshot: {} as ProviderInstance["snapshot"],
  adapter: {} as ProviderInstance["adapter"],
  textGeneration: {} as ProviderInstance["textGeneration"],
});

const makeRecordingDriver = (
  createdHosts: Array<ProviderHostConfig | undefined>,
  releases: { count: number },
): ProviderDriver<unknown> => ({
  driverKind,
  metadata: { displayName: "Host-aware test driver" },
  configSchema: Schema.Unknown,
  defaultConfig: () => ({}),
  create: (input) =>
    Effect.gen(function* () {
      createdHosts.push(input.host);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releases.count += 1;
        }),
      );
      return makeInstance(input);
    }),
});

describe("ProviderInstanceRegistry host resolution", () => {
  it.effect("passes resolved hosts to drivers and rebuilds only when their host changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const createdHosts: Array<ProviderHostConfig | undefined> = [];
        const releases = { count: 0 };
        const initialHosts = hostMap("wss://host-one.example.test/");
        const driver = makeRecordingDriver(createdHosts, releases);
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: hostedConfig,
          providerHosts: initialHosts,
        });

        expect(createdHosts).toEqual([initialHosts[hostId]]);

        // Structurally equal settings are a no-op even when freshly decoded.
        yield* mutator.reconcile(hostedConfig, hostMap("wss://host-one.example.test/"));
        expect(createdHosts).toHaveLength(1);
        expect(releases.count).toBe(0);

        const hostsWithUnrelatedChange = decodeHostMap({
          ...initialHosts,
          spare_host: {
            transport: {
              type: "cocoa-host",
              url: "wss://spare.example.test/",
              key: "spare_host_key",
            },
          },
        });
        yield* mutator.reconcile(hostedConfig, hostsWithUnrelatedChange);
        expect(createdHosts).toHaveLength(1);
        expect(releases.count).toBe(0);

        const changedHosts = hostMap("wss://host-two.example.test/");
        yield* mutator.reconcile(hostedConfig, changedHosts);
        expect(createdHosts).toEqual([initialHosts[hostId], changedHosts[hostId]]);
        expect(releases.count).toBe(1);
        expect(yield* registry.getInstance(instanceId)).toBeDefined();
      }),
    ),
  );

  it.effect("fails closed for a missing host reference and recovers when it is configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const createdHosts: Array<ProviderHostConfig | undefined> = [];
        const releases = { count: 0 };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [makeRecordingDriver(createdHosts, releases)],
          configMap: hostedConfig,
        });

        expect(createdHosts).toEqual([]);
        expect(yield* registry.listInstances).toEqual([]);
        expect((yield* registry.listUnavailable)[0]?.unavailableReason).toContain("main_host");

        const configuredHosts = hostMap("wss://host.example.test/");
        yield* mutator.reconcile(hostedConfig, configuredHosts);
        expect(createdHosts).toEqual([configuredHosts[hostId]]);
        expect(yield* registry.listUnavailable).toEqual([]);

        yield* mutator.reconcile(hostedConfig, {});
        expect(yield* registry.listInstances).toEqual([]);
        expect((yield* registry.listUnavailable)[0]?.unavailableReason).toContain("main_host");
        expect(releases.count).toBe(1);
      }),
    ),
  );

  it.effect("preserves legacy hostless instance creation and no-op reconciliation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const createdHosts: Array<ProviderHostConfig | undefined> = [];
        const releases = { count: 0 };
        const { mutator } = yield* makeProviderInstanceRegistry({
          drivers: [makeRecordingDriver(createdHosts, releases)],
          configMap: legacyConfig,
        });

        expect(createdHosts).toEqual([undefined]);
        yield* mutator.reconcile(legacyConfig);
        expect(createdHosts).toEqual([undefined]);
        expect(releases.count).toBe(0);
      }),
    ),
  );
});
