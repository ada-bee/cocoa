/**
 * Transport configuration for Cocoa-managed Codex app-server endpoints.
 *
 * The gateway reaches Codex only through a Cocoa host daemon. The pairing
 * token is a portable bootstrap value emitted by `cocoa-hostd`; it contains
 * a bearer credential and must be handled as a secret.
 *
 * @module codexEndpoint
 */
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Version used by the first Cocoa compatibility fixtures. This is diagnostic
 * metadata, not a required or exact endpoint version.
 */
export const CODEX_APP_SERVER_TESTED_VERSION = "0.146.0";

export const COCOA_HOST_PAIRING_TOKEN_PREFIX = "cocoa-host-v1:";

const MAX_ENDPOINT_URL_CHARS = 2048;
const MAX_HOST_KEY_CHARS = 512;
const MAX_PROVIDER_EXECUTABLE_PATH_CHARS = 4096;

const isAbsoluteNormalizedPosixPath = (path: string): boolean => {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  if (path === "/") return true;
  if (path.endsWith("/") || path.includes("//")) return false;
  return path
    .split("/")
    .slice(1)
    .every((part) => part !== "" && part !== "." && part !== "..");
};

/** Explicit provider-host Git executable. Cocoa never discovers or defaults this path. */
export const CodexGitExecutablePath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PROVIDER_EXECUTABLE_PATH_CHARS),
  Schema.makeFilter((path) => isAbsoluteNormalizedPosixPath(path), {
    message: "The Git executable path must be an absolute normalized POSIX path.",
  }),
).pipe(Schema.brand("CodexGitExecutablePath"));
export type CodexGitExecutablePath = typeof CodexGitExecutablePath.Type;

function parseWebSocketUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackWebSocketHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") {
    return true;
  }
  const ipv4 = normalized.split(".");
  return ipv4.length === 4 && ipv4[0] === "127" && ipv4.every((part) => /^\d{1,3}$/.test(part));
}

const WebSocketUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_ENDPOINT_URL_CHARS),
  Schema.makeFilter((value) => {
    const parsed = parseWebSocketUrl(value);
    if (!parsed) return "Cocoa host URLs must use ws:// or wss://.";
    if (parsed.username || parsed.password) {
      return "Cocoa host URLs must not embed credentials.";
    }
    if (parsed.search || parsed.hash) {
      return "Cocoa host URLs must not contain query parameters or fragments.";
    }
    return true;
  }),
);

/** A secret bearer capability printed by `cocoa-hostd`. */
export const CocoaHostKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_HOST_KEY_CHARS),
  Schema.makeFilter((value) =>
    /^[A-Za-z0-9_-]+$/u.test(value)
      ? true
      : "Cocoa host keys must contain only base64url characters.",
  ),
).pipe(Schema.brand("CocoaHostKey"));
export type CocoaHostKey = typeof CocoaHostKey.Type;

export const CocoaHostTransport = Schema.Struct({
  type: Schema.Literal("cocoa-host"),
  url: WebSocketUrl,
  key: CocoaHostKey,
  allowInsecureTransport: Schema.optionalKey(Schema.Literal(true)),
}).check(
  Schema.makeFilter((transport) => {
    const parsed = parseWebSocketUrl(transport.url);
    if (!parsed) return true;
    const insecureNonLoopback =
      parsed.protocol === "ws:" && !isLoopbackWebSocketHost(parsed.hostname);
    if (insecureNonLoopback) {
      return (
        transport.allowInsecureTransport === true ||
        "Non-loopback ws:// Cocoa hosts require allowInsecureTransport: true."
      );
    }
    return (
      transport.allowInsecureTransport === undefined ||
      "allowInsecureTransport may only acknowledge a non-loopback ws:// Cocoa host."
    );
  }),
);
export type CocoaHostTransport = typeof CocoaHostTransport.Type;

const CocoaHostPairingPayload = Schema.Struct({
  version: Schema.Literal(1),
  url: WebSocketUrl,
  key: CocoaHostKey,
});
export type CocoaHostPairingPayload = typeof CocoaHostPairingPayload.Type;

const decodePairingPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CocoaHostPairingPayload),
);

const invalidPairingToken = (message: string) => new SchemaIssue.InvalidValue({ message });

const decodePairingToken = (
  token: string,
): Effect.Effect<typeof CocoaHostTransport.Encoded, SchemaIssue.Issue> => {
  if (!token.startsWith(COCOA_HOST_PAIRING_TOKEN_PREFIX)) {
    return Effect.fail(
      invalidPairingToken(
        `Cocoa host pairing tokens must start with ${COCOA_HOST_PAIRING_TOKEN_PREFIX}`,
      ),
    );
  }
  const encodedPayload = token.slice(COCOA_HOST_PAIRING_TOKEN_PREFIX.length);
  if (encodedPayload.length === 0) {
    return Effect.fail(invalidPairingToken("Cocoa host pairing token payload is empty."));
  }
  return Effect.fromResult(Encoding.decodeBase64UrlString(encodedPayload)).pipe(
    Effect.mapError(() =>
      invalidPairingToken("Cocoa host pairing token payload is not base64url."),
    ),
    Effect.flatMap((json) =>
      decodePairingPayloadJson(json).pipe(
        Effect.mapError(() => invalidPairingToken("Cocoa host pairing token payload is invalid.")),
      ),
    ),
    Effect.map((payload) => {
      const parsed = parseWebSocketUrl(payload.url);
      const insecureNonLoopback =
        parsed?.protocol === "ws:" && !isLoopbackWebSocketHost(parsed.hostname);
      return {
        type: "cocoa-host" as const,
        url: payload.url,
        key: payload.key,
        ...(insecureNonLoopback ? { allowInsecureTransport: true as const } : {}),
      };
    }),
  );
};

const encodePairingToken = (transport: typeof CocoaHostTransport.Encoded) => {
  const payload: typeof CocoaHostPairingPayload.Encoded = {
    version: 1,
    url: transport.url,
    key: transport.key,
  };
  return Effect.succeed(
    `${COCOA_HOST_PAIRING_TOKEN_PREFIX}${Encoding.encodeBase64Url(JSON.stringify(payload))}`,
  );
};

/**
 * A reversible schema from a pasted pairing-token string to the persisted
 * Cocoa host transport. Decoding trims surrounding whitespace and infers the
 * explicit plaintext acknowledgement for non-loopback `ws://` host URLs.
 */
export const CocoaHostPairingToken = TrimmedNonEmptyString.pipe(
  Schema.decodeTo(
    CocoaHostTransport,
    SchemaTransformation.transformOrFail({
      decode: decodePairingToken,
      encode: encodePairingToken,
    }),
  ),
);

/** Decode and validate a pairing token pasted into a Cocoa client. */
export const decodeCocoaHostPairingToken = Schema.decodeUnknownSync(CocoaHostPairingToken);

/** Encode a validated transport into the canonical pairing-token form. */
export const encodeCocoaHostPairingToken = Schema.encodeSync(CocoaHostPairingToken);

/** Cocoa reaches externally managed Codex daemons only through `cocoa-hostd`. */
export const CodexEndpointTransport = CocoaHostTransport;
export type CodexEndpointTransport = CocoaHostTransport;
