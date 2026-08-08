import * as Schema from "effect/Schema";

import { CocoaClientError, CocoaClientHttpError } from "./errors.ts";
import type {
  CocoaClientConnectOptions,
  CocoaClientFetch,
  CocoaClientScope,
} from "./public-types.ts";

const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";

export const DEFAULT_COCOA_CLIENT_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
] as const satisfies ReadonlyArray<CocoaClientScope>;

const AccessTokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
  scope: Schema.String,
});

const WebSocketTicketResponse = Schema.Struct({
  ticket: Schema.NonEmptyString,
});

export interface CocoaClientHttpSession {
  readonly baseUrl: URL;
  readonly bearerToken: string;
  issueWebSocketUrl(): Promise<string>;
}

function endpointUrl(baseUrl: URL, pathname: string): URL {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

export function normalizeCocoaBaseUrl(rawValue: string): URL {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch (cause) {
    throw new CocoaClientError("configuration", "Cocoa baseUrl must be an absolute URL.", {
      cause,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CocoaClientError("configuration", "Cocoa baseUrl must use http or https.");
  }
  if (url.username || url.password) {
    throw new CocoaClientError("configuration", "Cocoa baseUrl must not contain credentials.");
  }
  if (url.hash) {
    throw new CocoaClientError("configuration", "Cocoa baseUrl must not contain a fragment.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function readJsonResponse(response: Response, endpoint: URL): Promise<unknown> {
  if (!response.ok) {
    throw new CocoaClientHttpError({ status: response.status, endpoint: endpoint.pathname });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new CocoaClientHttpError({
      status: response.status,
      endpoint: endpoint.pathname,
      message: "Cocoa returned an invalid JSON response.",
      cause,
    });
  }
}

function decodeResponse<A>(schema: Schema.Decoder<A>, value: unknown, endpoint: URL): A {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch (cause) {
    throw new CocoaClientHttpError({
      status: 200,
      endpoint: endpoint.pathname,
      message: "Cocoa returned a response that does not match the client protocol.",
      cause,
    });
  }
}

async function exchangeCredential(input: {
  readonly baseUrl: URL;
  readonly credential: string;
  readonly scopes: ReadonlyArray<CocoaClientScope>;
  readonly fetch: CocoaClientFetch;
}): Promise<string> {
  const endpoint = endpointUrl(input.baseUrl, "/oauth/token");
  const payload = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: input.credential,
    subject_token_type: BOOTSTRAP_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    scope: input.scopes.join(" "),
  });
  let response: Response;
  try {
    response = await input.fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: payload,
    });
  } catch (cause) {
    throw new CocoaClientHttpError({
      status: 0,
      endpoint: endpoint.pathname,
      message: "Could not reach the Cocoa token endpoint.",
      cause,
    });
  }
  const decoded = decodeResponse(
    AccessTokenResponse,
    await readJsonResponse(response, endpoint),
    endpoint,
  );
  return decoded.access_token;
}

async function issueWebSocketTicket(input: {
  readonly baseUrl: URL;
  readonly bearerToken: string;
  readonly fetch: CocoaClientFetch;
}): Promise<string> {
  const endpoint = endpointUrl(input.baseUrl, "/api/auth/websocket-ticket");
  let response: Response;
  try {
    response = await input.fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.bearerToken}`,
      },
    });
  } catch (cause) {
    throw new CocoaClientHttpError({
      status: 0,
      endpoint: endpoint.pathname,
      message: "Could not reach the Cocoa WebSocket ticket endpoint.",
      cause,
    });
  }
  const decoded = decodeResponse(
    WebSocketTicketResponse,
    await readJsonResponse(response, endpoint),
    endpoint,
  );
  return decoded.ticket;
}

export async function createCocoaClientHttpSession(
  options: CocoaClientConnectOptions,
): Promise<CocoaClientHttpSession> {
  const baseUrl = normalizeCocoaBaseUrl(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new CocoaClientError(
      "configuration",
      "No fetch implementation is available. Pass connect({ fetch }).",
    );
  }

  const credential = options.credential?.trim();
  const suppliedBearerToken = options.bearerToken?.trim();
  if (credential && suppliedBearerToken) {
    throw new CocoaClientError("configuration", "Pass either credential or bearerToken, not both.");
  }
  if (!credential && !suppliedBearerToken) {
    throw new CocoaClientError(
      "configuration",
      "A Cocoa bootstrap credential or bearer token is required.",
    );
  }

  const bearerToken =
    suppliedBearerToken ??
    (await exchangeCredential({
      baseUrl,
      credential: credential!,
      scopes: options.scopes ?? DEFAULT_COCOA_CLIENT_SCOPES,
      fetch: fetchImplementation,
    }));

  return {
    baseUrl,
    bearerToken,
    async issueWebSocketUrl() {
      const ticket = await issueWebSocketTicket({
        baseUrl,
        bearerToken,
        fetch: fetchImplementation,
      });
      const url = endpointUrl(baseUrl, "/api/client/v1/ws");
      url.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", ticket);
      return url.toString();
    },
  };
}
