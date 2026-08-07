import { CodexEndpointTransport, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CodexEndpointConnection from "./CodexEndpointConnection.ts";
import {
  type CodexEndpointConnectorConstructors,
  make as makeCodexEndpoint,
} from "./CodexEndpointFactory.ts";

const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("remote_codex");
const decodeTransport = Schema.decodeUnknownSync(CodexEndpointTransport);
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const dependencies = FileSystem.layerNoop({});

const makeConstructors = (
  acquired: string[],
  finalized: string[],
  initializeResult: "valid" | "invalid" = "valid",
): CodexEndpointConnectorConstructors => {
  const connector = Effect.fn("CodexEndpointFactoryTest.connector")(function* (label: string) {
    acquired.push(label);
    const incoming = yield* Queue.unbounded<string, Cause.Done>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        finalized.push(label);
        Queue.endUnsafe(incoming);
      }),
    );

    return {
      incoming: Stream.fromQueue(incoming),
      outgoing: (frames: Stream.Stream<string>) =>
        frames.pipe(
          Stream.runForEach((frame) =>
            Effect.suspend(() => {
              const message = decodeJson(frame) as {
                readonly id?: string | number;
                readonly method?: string;
              };
              if (message.id === undefined) {
                return Effect.void;
              }
              if (message.method !== "initialize") {
                return Queue.offer(
                  incoming,
                  encodeJson({
                    id: message.id,
                    error: { code: -32602, message: "Invalid params" },
                  }),
                ).pipe(Effect.asVoid);
              }
              return Queue.offer(
                incoming,
                encodeJson({
                  id: message.id,
                  result:
                    initializeResult === "valid"
                      ? {
                          userAgent: "codex_cli_rs/0.146.0",
                          codexHome: "/srv/codex",
                          platformFamily: "unix",
                          platformOs: "linux",
                        }
                      : { userAgent: "incomplete" },
                }),
              ).pipe(Effect.asVoid);
            }),
          ),
        ),
    } satisfies CodexEndpointConnection.CodexEndpointFramedTransport;
  });

  return {
    cocoaHost: () => connector("host"),
  };
};

it.effect("routes the endpoint to exactly one Cocoa host connector", () =>
  Effect.gen(function* () {
    const transport = decodeTransport({
      type: "cocoa-host",
      url: "ws://127.0.0.1:4510",
      key: "host_key",
    });
    const acquired: string[] = [];
    const finalized: string[] = [];
    const constructors = makeConstructors(acquired, finalized);

    const connection = yield* makeCodexEndpoint(
      { providerInstanceId: PROVIDER_INSTANCE_ID, transport },
      constructors,
    ).pipe(Effect.scoped);

    expect(connection.identity.providerInstanceId).toBe(PROVIDER_INSTANCE_ID);
    expect(connection.compatibility.serverVersion).toBe("0.146.0");
    expect(acquired).toEqual(["host"]);
    expect(finalized).toEqual(["host"]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("closes the selected connector immediately when connection initialization fails", () =>
  Effect.gen(function* () {
    const acquired: string[] = [];
    const finalized: string[] = [];
    const constructors = makeConstructors(acquired, finalized, "invalid");

    const error = yield* makeCodexEndpoint(
      {
        providerInstanceId: PROVIDER_INSTANCE_ID,
        transport: decodeTransport({
          type: "cocoa-host",
          url: "ws://127.0.0.1:4510",
          key: "host_key",
        }),
      },
      constructors,
    ).pipe(Effect.flip);

    expect(error._tag).toBe("CodexEndpointInitializationError");
    expect(acquired).toEqual(["host"]);
    expect(finalized).toEqual(["host"]);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
