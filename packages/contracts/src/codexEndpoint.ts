/**
 * Transport configuration for Cocoa-managed Codex app-server endpoints.
 *
 * These contracts deliberately describe how the gateway reaches an already
 * running Codex daemon. They do not include daemon discovery, installation,
 * launch arguments, or a configurable remote command.
 *
 * @module codexEndpoint
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Version used by the first Cocoa compatibility fixtures. This is diagnostic
 * metadata, not a required or exact endpoint version.
 */
export const CODEX_APP_SERVER_TESTED_VERSION = "0.146.0";

const MAX_ENDPOINT_URL_CHARS = 2048;
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

const AbsoluteCredentialPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter((path) =>
    path.startsWith("/") ? true : "Credential file paths must be absolute.",
  ),
);

/** A gateway-local reference to secret material; secret bytes never enter settings. */
export const CodexEndpointCredentialReference = Schema.Struct({
  source: Schema.Literal("file"),
  path: AbsoluteCredentialPath,
});
export type CodexEndpointCredentialReference = typeof CodexEndpointCredentialReference.Type;

export const CodexEndpointAuthentication = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("none"),
  }),
  Schema.Struct({
    type: Schema.Literal("capability-token"),
    credential: CodexEndpointCredentialReference,
  }),
  Schema.Struct({
    type: Schema.Literal("signed-bearer-token"),
    credential: CodexEndpointCredentialReference,
    issuer: TrimmedNonEmptyString,
    audience: TrimmedNonEmptyString,
  }),
]);
export type CodexEndpointAuthentication = typeof CodexEndpointAuthentication.Type;

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
    if (!parsed) return "Codex endpoint URLs must use ws:// or wss://.";
    if (parsed.username || parsed.password) {
      return "Codex endpoint URLs must not embed credentials.";
    }
    if (parsed.search || parsed.hash) {
      return "Codex endpoint URLs must not contain query parameters or fragments.";
    }
    return true;
  }),
);

export const CodexDirectWebSocketTransport = Schema.Struct({
  type: Schema.Literal("direct-websocket"),
  url: WebSocketUrl,
  authentication: CodexEndpointAuthentication,
  allowInsecureTransport: Schema.optionalKey(Schema.Literal(true)),
}).check(
  Schema.makeFilter((transport) => {
    const parsed = parseWebSocketUrl(transport.url);
    if (!parsed) return true;
    const isLoopback = isLoopbackWebSocketHost(parsed.hostname);
    if (parsed.protocol === "wss:" || isLoopback) {
      return (
        transport.allowInsecureTransport === undefined ||
        "allowInsecureTransport may only acknowledge a non-loopback ws:// endpoint."
      );
    }
    if (transport.authentication.type === "none") {
      return "Non-loopback ws:// Codex endpoints must use explicit authentication.";
    }
    if (transport.allowInsecureTransport !== true) {
      return "Token-authenticated non-loopback ws:// Codex endpoints require allowInsecureTransport: true.";
    }
    return true;
  }),
);
export type CodexDirectWebSocketTransport = typeof CodexDirectWebSocketTransport.Type;

/** Cocoa reaches externally managed Codex daemons only through WebSocket endpoints. */
export const CodexEndpointTransport = CodexDirectWebSocketTransport;
export type CodexEndpointTransport = CodexDirectWebSocketTransport;
