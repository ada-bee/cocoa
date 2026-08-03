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

import { NonNegativeInt, PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Version used by the first Cocoa compatibility fixtures. This is diagnostic
 * metadata, not a required or exact endpoint version.
 */
export const CODEX_APP_SERVER_TESTED_VERSION = "0.146.0";

/** Fixed remote command used by the SSH transport implementation. */
export const CODEX_SSH_PROXY_REMOTE_COMMAND = ["codex", "app-server", "proxy"] as const;

const MAX_ENDPOINT_URL_CHARS = 2048;
const MAX_HOST_CHARS = 253;
const MAX_USER_CHARS = 64;
const MAX_SSH_TIMEOUT_SECONDS = 300;
const MAX_SSH_KEEPALIVE_SECONDS = 3600;
const MAX_SSH_KEEPALIVE_COUNT = 20;

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
}).check(
  Schema.makeFilter((transport) => {
    const parsed = parseWebSocketUrl(transport.url);
    if (!parsed || transport.authentication.type === "none" || parsed.protocol === "wss:") {
      return true;
    }
    return (
      isLoopbackWebSocketHost(parsed.hostname) ||
      "Token-authenticated non-loopback Codex endpoints must use wss://."
    );
  }),
);
export type CodexDirectWebSocketTransport = typeof CodexDirectWebSocketTransport.Type;

const SshHost = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_HOST_CHARS),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
);
const SshUser = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_USER_CHARS),
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/),
);

/**
 * Structured SSH options that can be rendered as individual argv entries.
 * Deliberately excludes arbitrary `-o` values and remote commands.
 */
export const CodexSshProxyOptions = Schema.Struct({
  identityFile: Schema.optional(AbsoluteCredentialPath),
  connectTimeoutSeconds: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SSH_TIMEOUT_SECONDS)),
  ),
  serverAliveIntervalSeconds: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SSH_KEEPALIVE_SECONDS)),
  ),
  serverAliveCountMax: Schema.optional(
    NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_SSH_KEEPALIVE_COUNT)),
  ),
  strictHostKeyChecking: Schema.optional(Schema.Literals(["yes", "accept-new"])),
});
export type CodexSshProxyOptions = typeof CodexSshProxyOptions.Type;

/**
 * Connect through `ssh [options] host codex app-server proxy`. The remote
 * command is fixed by the transport implementation and is not configurable.
 */
export const CodexSshProxyTransport = Schema.Struct({
  type: Schema.Literal("ssh-proxy"),
  host: SshHost,
  user: Schema.optional(SshUser),
  port: Schema.optional(PortSchema),
  options: Schema.optional(CodexSshProxyOptions),
});
export type CodexSshProxyTransport = typeof CodexSshProxyTransport.Type;

export const CodexEndpointTransport = Schema.Union([
  CodexDirectWebSocketTransport,
  CodexSshProxyTransport,
]);
export type CodexEndpointTransport = typeof CodexEndpointTransport.Type;
