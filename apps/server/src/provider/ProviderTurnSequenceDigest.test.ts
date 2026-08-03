import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  digestProviderTurnSequence,
  PROVIDER_TURN_ID_MAX_BYTES,
  PROVIDER_TURN_SEQUENCE_DIGEST_VERSION,
  PROVIDER_TURN_SEQUENCE_MAX_TURNS,
} from "./ProviderTurnSequenceDigest.ts";

it.effect("digests only the bounded ordered turn-id sequence deterministically", () =>
  Effect.gen(function* () {
    const first = yield* digestProviderTurnSequence(["turn-a", "turn-b"]);
    const repeated = yield* digestProviderTurnSequence(["turn-a", "turn-b"]);
    const reordered = yield* digestProviderTurnSequence(["turn-b", "turn-a"]);

    assert.deepEqual(first, repeated);
    assert.equal(first.version, PROVIDER_TURN_SEQUENCE_DIGEST_VERSION);
    assert.equal(first.turnCount, 2);
    assert.equal(first.sha256, "fa8f1030d75de3dbf6fcd9235993d6c56258ace09ba7b011717c0788b611e36f");
    assert.notEqual(first.sha256, reordered.sha256);
  }),
);

it.effect("uses length framing so concatenation boundaries cannot collide", () =>
  Effect.gen(function* () {
    const split = yield* digestProviderTurnSequence(["ab", "c"]);
    const joined = yield* digestProviderTurnSequence(["a", "bc"]);
    assert.notEqual(split.sha256, joined.sha256);
  }),
);

it.effect("rejects oversized turn sequences and ids", () =>
  Effect.gen(function* () {
    const tooMany = yield* Effect.exit(
      digestProviderTurnSequence(
        Array.from({ length: PROVIDER_TURN_SEQUENCE_MAX_TURNS + 1 }, () => "t"),
      ),
    );
    const tooLarge = yield* Effect.exit(
      digestProviderTurnSequence(["x".repeat(PROVIDER_TURN_ID_MAX_BYTES + 1)]),
    );
    const tooManyUtf8Bytes = yield* Effect.exit(digestProviderTurnSequence(["é".repeat(129)]));

    assert.equal(Exit.isFailure(tooMany), true);
    assert.equal(Exit.isFailure(tooLarge), true);
    assert.equal(Exit.isFailure(tooManyUtf8Bytes), true);
  }),
);

it.effect(
  "rejects non-canonical, path-like, control, and ill-formed ids without echoing them",
  () =>
    Effect.gen(function* () {
      const invalidIds = [" spaced ", "path/turn", "path\\turn", "turn\u0000id", "turn\ud800id"];
      for (const invalidId of invalidIds) {
        const error = yield* Effect.flip(digestProviderTurnSequence([invalidId]));
        assert.equal(error._tag, "ProviderTurnSequenceDigestError");
        assert.equal(error.message.includes(invalidId), false);
        assert.equal("cause" in error, false);
      }
    }),
);
