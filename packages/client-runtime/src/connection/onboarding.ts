import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  DirectConnectionProfile,
  DirectConnectionRegistration,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  ConnectionBlockedError,
  DirectConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";

export interface DirectConnectionInput {
  readonly httpBaseUrl: string;
}

export interface DirectConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerDirect: (
      input: DirectConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateDirect: (
      input: DirectConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const normalizeDirectUrl = (value: string) =>
  Effect.try({
    try: () => normalizeHttpBaseUrl(value),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The gateway URL is invalid.",
      }),
  });

export const prepareDirectRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareDirectRegistration",
)(function* (input: DirectConnectionInput) {
  const httpBaseUrl = yield* normalizeDirectUrl(input.httpBaseUrl);
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
  const connectionId = `direct:${descriptor.environmentId}`;

  return new DirectConnectionRegistration({
    target: new DirectConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new DirectConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
  });
});

export const registerDirectConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerDirectConnection",
)(function* (input: DirectConnectionInput) {
  const registration = yield* prepareDirectRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

const isDirectProfile = Schema.is(DirectConnectionProfile);

export const prepareDirectConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareDirectConnectionUpdate",
)(function* (options: {
  readonly input: DirectConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === null ||
    entry.target._tag !== "DirectConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isDirectProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved direct gateway connections can be edited.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* normalizeDirectUrl(options.input.httpBaseUrl);
  const connectionId = entry.target.connectionId;
  return new DirectConnectionRegistration({
    target: new DirectConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new DirectConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
  });
});

export const updateDirectConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateDirectConnection",
)(function* (input: DirectConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const registration = yield* prepareDirectConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
  });
  yield* registry.register(registration);
});

export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const httpClient = yield* HttpClient.HttpClient;

  return ConnectionOnboarding.of({
    registerDirect: (input) =>
      registerDirectConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    updateDirect: (input) =>
      updateDirectConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
