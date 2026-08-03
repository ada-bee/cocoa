import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CheckpointDiffQuery, layer } from "./CheckpointDiffQuery.ts";

it.layer(layer)("CheckpointDiffQuery fail-closed isolation", (it) => {
  it.effect("returns explicit unsupported for turn diff queries without reading a workspace", () =>
    Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery;
      const result = yield* query
        .getTurnDiff({
          threadId: ThreadId.make("thread-turn-diff"),
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(result.failure._tag, "CheckpointUnsupportedError");
      assert.equal(result.failure.operation, "CheckpointDiffQuery.getTurnDiff");
      assert.equal(
        result.failure.message,
        "Checkpoint diffs are unavailable until the bound provider supplies checkpoint operations.",
      );
    }),
  );

  it.effect("returns explicit unsupported for full-thread diff queries, including turn zero", () =>
    Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery;
      const result = yield* query
        .getFullThreadDiff({
          threadId: ThreadId.make("thread-full-diff"),
          toTurnCount: 0,
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(result.failure._tag, "CheckpointUnsupportedError");
      assert.equal(result.failure.operation, "CheckpointDiffQuery.getFullThreadDiff");
      assert.equal(
        result.failure.message,
        "Checkpoint diffs are unavailable until the bound provider supplies checkpoint operations.",
      );
    }),
  );
});
