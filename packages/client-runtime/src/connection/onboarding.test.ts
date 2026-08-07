import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import { DirectConnectionProfile } from "./catalog.ts";
import { DirectConnectionTarget } from "./model.ts";
import { prepareDirectConnectionUpdate, prepareDirectRegistration } from "./onboarding.ts";

function descriptorHttpLayer(calls: Array<string>) {
  const fetchFn = ((input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/.well-known/t3/environment")) {
      return Promise.resolve(
        Response.json({
          environmentId: "environment-direct",
          label: "Cocoa gateway",
          platform: { os: "linux", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return remoteHttpClientLayer(fetchFn);
}

describe("connection onboarding", () => {
  it.effect("prepares a direct gateway registration without exchanging a credential", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const registration = yield* prepareDirectRegistration({
        httpBaseUrl: "https://cocoa.example.test/path",
      }).pipe(Effect.provide(descriptorHttpLayer(calls)));

      expect(registration).toMatchObject({
        _tag: "DirectConnectionRegistration",
        target: {
          _tag: "DirectConnectionTarget",
          environmentId: "environment-direct",
          label: "Cocoa gateway",
          connectionId: "direct:environment-direct",
        },
        profile: {
          _tag: "DirectConnectionProfile",
          httpBaseUrl: "https://cocoa.example.test/",
          wsBaseUrl: "wss://cocoa.example.test/",
        },
      });
      expect(calls).toEqual(["https://cocoa.example.test/.well-known/t3/environment"]);
    }),
  );

  it.effect("rejects an invalid gateway URL before making a request", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const error = yield* prepareDirectRegistration({ httpBaseUrl: "" }).pipe(
        Effect.provide(descriptorHttpLayer(calls)),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("updates direct gateway metadata without a credential", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-direct");
      const registration = yield* prepareDirectConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed gateway  ",
          httpBaseUrl: "http://192.168.20.25:7331/path",
        },
        entry: Option.some({
          target: new DirectConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "direct:environment-direct",
          }),
          profile: Option.some(
            new DirectConnectionProfile({
              connectionId: "direct:environment-direct",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
        }),
      });

      expect(registration).toMatchObject({
        target: { environmentId, label: "Renamed gateway" },
        profile: {
          environmentId,
          label: "Renamed gateway",
          httpBaseUrl: "http://192.168.20.25:7331/",
          wsBaseUrl: "ws://192.168.20.25:7331/",
        },
      });
    }),
  );
});
