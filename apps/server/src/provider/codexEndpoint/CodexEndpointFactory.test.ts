import { type CodexEndpointTransport, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexEndpointConnection from "./CodexEndpointConnection.ts";
import {
  type CodexEndpointConnectorConstructors,
  make as makeCodexEndpoint,
} from "./CodexEndpointFactory.ts";

const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("remote_codex");
const decodeJson = Schema.decodeSync(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const unusedSpawner = ChildProcessSpawner.make(() =>
  Effect.die(new Error("The injected connector should not spawn a process")),
);
const dependencies = Layer.merge(
  FileSystem.layerNoop({}),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, unusedSpawner),
);

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
              if (message.method !== "initialize" || message.id === undefined) {
                return Effect.void;
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
    directWebSocket: () => connector("direct"),
    sshProxy: () => connector("ssh"),
  };
};

it.effect("routes each transport to exactly one injected connector", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [CodexEndpointTransport, string]> = [
      [
        {
          type: "direct-websocket",
          url: "ws://127.0.0.1:4500",
          authentication: { type: "none" },
        },
        "direct",
      ],
      [
        {
          type: "ssh-proxy",
          host: "rigatoni-alfredo",
        },
        "ssh",
      ],
    ];

    for (const [transport, expected] of cases) {
      const acquired: string[] = [];
      const finalized: string[] = [];
      const constructors = makeConstructors(acquired, finalized);

      const connection = yield* makeCodexEndpoint(
        { providerInstanceId: PROVIDER_INSTANCE_ID, transport },
        constructors,
      ).pipe(Effect.scoped);

      expect(connection.identity.providerInstanceId).toBe(PROVIDER_INSTANCE_ID);
      expect(connection.compatibility.serverVersion).toBe("0.146.0");
      expect(acquired).toEqual([expected]);
      expect(finalized).toEqual([expected]);
    }
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
        transport: {
          type: "direct-websocket",
          url: "ws://127.0.0.1:4500",
          authentication: { type: "none" },
        },
      },
      constructors,
    ).pipe(Effect.flip);

    expect(error._tag).toBe("CodexEndpointInitializationError");
    expect(acquired).toEqual(["direct"]);
    expect(finalized).toEqual(["direct"]);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
