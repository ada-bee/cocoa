import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import layerSource from "./layer.ts?raw";
import modelSource from "./model.ts?raw";
import onboardingSource from "./onboarding.ts?raw";
import resolverSource from "./resolver.ts?raw";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import { BearerConnectionTarget, PrimaryConnectionTarget } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const environmentId = EnvironmentId.make("cocoa-gateway");

describe("Cocoa direct connection boundary", () => {
  it("keeps hosted and machine-management modules out of Cocoa roots", () => {
    const roots = `${layerSource}\n${modelSource}\n${onboardingSource}\n${resolverSource}`;
    for (const forbidden of [
      "../relay/",
      "ManagedRelay",
      "CloudSession",
      "RelayDeviceIdentity",
      "SshEnvironmentGateway",
      "authorizeDpop",
      "RelayConnectionTarget",
      "SshConnectionTarget",
      "relay-unavailable",
    ]) {
      expect(roots).not.toContain(forbidden);
    }
  });

  it.effect("constructs and prepares primary and bearer targets with direct services only", () =>
    Effect.gen(function* () {
      const credentials = new Map([
        ["bearer:cocoa-gateway", new BearerConnectionCredential({ token: "secret" })],
      ]);
      const authorized: Array<string> = [];
      const resolver = yield* ConnectionResolver.make.pipe(
        Effect.provideService(
          ClientCapabilities.PrimaryEnvironmentAuth,
          ClientCapabilities.PrimaryEnvironmentAuth.of({
            bearerToken: Effect.succeed(Option.none()),
          }),
        ),
        Effect.provideService(
          ConnectionCredentialStore.ConnectionCredentialStore,
          ConnectionCredentialStore.make({
            get: (connectionId) =>
              Effect.succeed(Option.fromUndefinedOr(credentials.get(connectionId))),
            put: (connectionId, credential) =>
              Effect.sync(() => void credentials.set(connectionId, credential)),
            remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
          }),
        ),
        Effect.provideService(
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
            authorizeBearer: (input) =>
              Effect.sync(() => {
                authorized.push(input.bearerToken);
                return {
                  environmentId: input.expectedEnvironmentId,
                  label: "Cocoa",
                  httpBaseUrl: input.httpBaseUrl,
                  socketUrl: `${input.wsBaseUrl}/ws?wsTicket=direct`,
                  httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
                };
              }),
          }),
        ),
      );

      const primary = new PrimaryConnectionTarget({
        environmentId,
        label: "Cocoa",
        httpBaseUrl: "https://cocoa.example.test",
        wsBaseUrl: "wss://cocoa.example.test",
      });
      const primaryPrepared = yield* resolver.prepare({ target: primary, profile: Option.none() });
      expect(primaryPrepared.httpAuthorization).toBeNull();

      const bearer = new BearerConnectionTarget({
        environmentId,
        label: "Cocoa",
        connectionId: "bearer:cocoa-gateway",
      });
      const entry: ConnectionCatalogEntry = {
        target: bearer,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: bearer.connectionId,
            environmentId,
            label: bearer.label,
            httpBaseUrl: "https://cocoa.example.test",
            wsBaseUrl: "wss://cocoa.example.test",
          }),
        ),
      };
      const bearerPrepared = yield* resolver.prepare(entry);
      expect(bearerPrepared.httpAuthorization).toEqual({ _tag: "Bearer", token: "secret" });
      expect(authorized).toEqual(["secret"]);
    }),
  );
});
