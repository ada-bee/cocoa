import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";

export const CODEX_SIGNED_BEARER_TOKEN_TTL_SECONDS = 60;
export const CODEX_SIGNED_BEARER_MINIMUM_SECRET_BYTES = 32;

export interface CodexSignedBearerTokenInput {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowEpochSeconds: number;
}

const encodeJson = (value: unknown): string =>
  NodeBuffer.Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/** Mint the HS256 token accepted by Codex's standalone WebSocket listener. */
export const mintCodexSignedBearerToken = (input: CodexSignedBearerTokenInput): string => {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const claims = encodeJson({
    iss: input.issuer,
    aud: input.audience,
    exp: input.nowEpochSeconds + CODEX_SIGNED_BEARER_TOKEN_TTL_SECONDS,
  });
  const signingInput = `${header}.${claims}`;
  const signature = NodeCrypto.createHmac("sha256", input.secret)
    .update(signingInput, "ascii")
    .digest("base64url");
  return `${signingInput}.${signature}`;
};
