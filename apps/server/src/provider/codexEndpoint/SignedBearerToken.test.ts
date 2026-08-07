import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  CODEX_SIGNED_BEARER_TOKEN_TTL_SECONDS,
  mintCodexSignedBearerToken,
} from "./SignedBearerToken.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it("mints the exact Codex HS256 JWT header, claims, and signature", () => {
  const token = mintCodexSignedBearerToken({
    secret: "0123456789abcdef0123456789abcdef",
    issuer: "cocoa",
    audience: "codex",
    nowEpochSeconds: 1_700_000_000,
  });

  expect(token).toBe(
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjb2NvYSIsImF1ZCI6ImNvZGV4IiwiZXhwIjoxNzAwMDAwMDYwfQ.8vMM1DNvNDzxI-i8JyaZzvgIwKIYTJ9WcqTOnRGxCtg",
  );
  const [header, claims] = token.split(".");
  expect(decodeJson(Buffer.from(header!, "base64url").toString("utf8"))).toEqual({
    alg: "HS256",
    typ: "JWT",
  });
  expect(decodeJson(Buffer.from(claims!, "base64url").toString("utf8"))).toEqual({
    iss: "cocoa",
    aud: "codex",
    exp: 1_700_000_000 + CODEX_SIGNED_BEARER_TOKEN_TTL_SECONDS,
  });
});
