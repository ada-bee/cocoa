import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  OpenCodeEndpointRuntime,
  OpenCodeRuntimeError,
  toOpenCodeDataUrlFileParts,
} from "./OpenCodeEndpointRuntime.ts";

describe("OpenCodeEndpointRuntime", () => {
  it.effect("connects only to an explicitly configured external daemon", () =>
    Effect.gen(function* () {
      const connection = yield* OpenCodeEndpointRuntime.connectToOpenCodeServer({
        binaryPath: "/must/not/run",
        serverUrl: "  https://opencode.example.test  ",
      });

      expect(connection).toEqual({
        url: "https://opencode.example.test",
        exitCode: null,
        external: true,
      });
    }),
  );

  it.effect("rejects a missing endpoint instead of falling back to a local process", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenCodeEndpointRuntime.connectToOpenCodeServer({
          binaryPath: "/must/not/run",
          serverUrl: "   ",
        }),
      );

      expect(error).toBeInstanceOf(OpenCodeRuntimeError);
      expect(error.detail).toContain("explicit OpenCode server URL");
    }),
  );

  it("builds remote-safe file parts from bounded data URLs", () => {
    const parts = toOpenCodeDataUrlFileParts({
      attachments: [
        {
          type: "image",
          id: "image-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 3,
        },
      ],
      dataUrls: ["data:image/png;base64,AQID"],
    });

    expect(parts).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "example.png",
        url: "data:image/png;base64,AQID",
      },
    ]);
    expect(parts[0]?.url).not.toMatch(/^file:/);
  });
});
