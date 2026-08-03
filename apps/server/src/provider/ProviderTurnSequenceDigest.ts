// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PROVIDER_TURN_SEQUENCE_DIGEST_VERSION = "ordered-turn-ids-sha256-v1" as const;
export const PROVIDER_TURN_SEQUENCE_MAX_TURNS = 100_000;
export const PROVIDER_TURN_ID_MAX_BYTES = 256;

const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const ProviderTurnIdForDigest = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isTrimmed(),
  Schema.isMaxLength(PROVIDER_TURN_ID_MAX_BYTES),
  Schema.makeFilter(
    (id) =>
      (!/[\\/\p{Cc}]/u.test(id) && isWellFormedUnicode(id)) ||
      "Provider turn ids must be path-free, control-free, well-formed Unicode.",
  ),
  Schema.makeFilter((id) =>
    Buffer.byteLength(id, "utf8") <= PROVIDER_TURN_ID_MAX_BYTES
      ? true
      : `Provider turn ids must be at most ${PROVIDER_TURN_ID_MAX_BYTES} UTF-8 bytes.`,
  ),
);

const ProviderTurnIdsForDigest = Schema.Array(ProviderTurnIdForDigest).check(
  Schema.isMaxLength(PROVIDER_TURN_SEQUENCE_MAX_TURNS),
);

export interface ProviderTurnSequenceDigest {
  readonly version: typeof PROVIDER_TURN_SEQUENCE_DIGEST_VERSION;
  readonly turnCount: number;
  readonly sha256: string;
}

export class ProviderTurnSequenceDigestError extends Schema.TaggedErrorClass<ProviderTurnSequenceDigestError>()(
  "ProviderTurnSequenceDigestError",
  {
    issue: Schema.String,
  },
) {
  override get message(): string {
    return `Provider turn sequence cannot be digested: ${this.issue}`;
  }
}

/**
 * Hashes only the ordered provider-native turn ids. Turn bodies, workspace
 * paths, and other snapshot fields are deliberately excluded.
 */
export const digestProviderTurnSequence = Effect.fn("digestProviderTurnSequence")(function* (
  turnIds: ReadonlyArray<unknown>,
) {
  const decoded = yield* Schema.decodeUnknownEffect(ProviderTurnIdsForDigest)(turnIds).pipe(
    Effect.mapError(
      () =>
        new ProviderTurnSequenceDigestError({
          issue: "Turn id sequence violates the bounded canonical format.",
        }),
    ),
  );
  const hash = createHash("sha256");
  hash.update("cocoa.provider-turn-sequence.v1\0", "utf8");
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32BE(decoded.length);
  hash.update(count);
  for (const id of decoded) {
    const bytes = Buffer.from(id, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return {
    version: PROVIDER_TURN_SEQUENCE_DIGEST_VERSION,
    turnCount: decoded.length,
    sha256: hash.digest("hex"),
  } satisfies ProviderTurnSequenceDigest;
});

export const hashProviderContinuationIdentity = (input: {
  readonly driverKind: string;
  readonly continuationKey: string;
}): string => {
  const hash = createHash("sha256");
  hash.update("cocoa.provider-continuation-identity.v1\0", "utf8");
  for (const value of [input.driverKind, input.continuationKey]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
};
