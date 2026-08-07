import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { type CocoaHostTransport } from "@t3tools/contracts";
import { type makeCocoaHostConnector } from "../codexEndpoint/CocoaHostConnector.ts";
import {
  cocoaHostControlUrl,
  makeCocoaHostControlTransportOpener,
} from "./CocoaHostControlTransport.ts";

it("normalizes the control route and adapts authenticated framed transport lifecycle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const opened: Array<CocoaHostTransport> = [];
      const sent: Array<string> = [];
      const releaseCount = yield* Ref.make(0);
      const connect = Effect.fn("CocoaHostControlTransportTest.connect")(function* (
        transport: CocoaHostTransport,
      ) {
        opened.push(transport);
        yield* Effect.addFinalizer(() => Ref.update(releaseCount, (count) => count + 1));
        return {
          incoming: Stream.make("server-frame"),
          outgoing: (frames: Stream.Stream<string>) =>
            frames.pipe(
              Stream.runForEach((frame) =>
                Effect.sync(() => {
                  sent.push(frame);
                }),
              ),
            ),
          terminationError: Effect.never,
        };
      }) as typeof makeCocoaHostConnector;
      const opener = makeCocoaHostControlTransportOpener({}, { connect });
      const transport = yield* opener({
        url: "ws://127.0.0.1:4501/ignored/path",
        headers: { Authorization: "Bearer persisted_key" },
      });

      assert.equal(cocoaHostControlUrl("ws://127.0.0.1:4501/"), "ws://127.0.0.1:4501/control/v1");
      assert.lengthOf(opened, 1);
      assert.equal(opened[0]?.type, "cocoa-host");
      assert.equal(opened[0]?.url, "ws://127.0.0.1:4501/control/v1");
      assert.equal(opened[0]?.key, "persisted_key");
      assert.deepEqual(Array.from(yield* Stream.runCollect(transport.incoming)), ["server-frame"]);

      yield* transport.send("client-frame");
      assert.deepEqual(sent, ["client-frame"]);
      yield* transport.close;
      assert.equal(yield* Ref.get(releaseCount), 1);
    }),
  ));
