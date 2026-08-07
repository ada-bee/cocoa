import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

interface CollectState {
  readonly chunks: Uint8Array[];
  readonly bytes: number;
  readonly truncated: boolean;
}

const fitTextToUtf8ByteLimit = (text: string, maxBytes: number): string => {
  if (!Number.isFinite(maxBytes) || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let codeUnits = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    codeUnits += character.length;
  }
  return text.slice(0, codeUnits);
};

/** Drains the stream after reaching the cap so the child can exit normally. */
export const collectUint8StreamText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number;
  readonly truncatedMarker?: string | null;
}): Effect.Effect<CollectedUint8StreamText, E> => {
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const truncatedMarker = input.truncatedMarker ?? "";

  return input.stream.pipe(
    Stream.runFold(
      (): CollectState => ({ chunks: [], bytes: 0, truncated: false }),
      (state, chunk): CollectState => {
        if (state.truncated) return state;
        const remainingBytes = maxBytes - state.bytes;
        if (remainingBytes <= 0) return { ...state, truncated: true };

        const nextChunk =
          chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
        state.chunks.push(nextChunk);
        return {
          chunks: state.chunks,
          bytes: state.bytes + nextChunk.byteLength,
          truncated: chunk.byteLength > remainingBytes,
        };
      },
    ),
    Effect.map((state) => {
      // A byte cap can split a multi-byte code point. Node decodes that tail
      // as U+FFFD (three UTF-8 bytes), which would make the wire payload larger
      // than the cap. Re-fit the decoded prefix to the same encoded-byte bound.
      const text = fitTextToUtf8ByteLimit(
        Buffer.concat(state.chunks, state.bytes).toString("utf8"),
        maxBytes,
      );
      return {
        text: state.truncated && truncatedMarker.length > 0 ? `${text}${truncatedMarker}` : text,
        bytes: state.bytes,
        truncated: state.truncated,
      } satisfies CollectedUint8StreamText;
    }),
  );
};
