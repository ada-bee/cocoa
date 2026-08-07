import type { EnvironmentId } from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  DirectConnectionProfile,
  DirectConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  DirectConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";

export interface DirectConnectionInput {
  readonly httpBaseUrl: string;
}

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
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
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
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

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    scopes: presentation.scopes,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const connectionId = `bearer:${descriptor.environmentId}`;

  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({ token: access.access_token }),
  });
});

export const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registration = yield* preparePairingRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

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
const isBearerCredential = Schema.is(BearerConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer gateway connections can be edited.",
    });
  }
  if (Option.isNone(options.credential) || !isBearerCredential(options.credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
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
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
    credential: options.credential.value,
  });
});

export const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

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
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

  return ConnectionOnboarding.of({
    registerPairing: (input) =>
      registerPairingConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    updateBearer: (input) =>
      updateBearerConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
      ),
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
