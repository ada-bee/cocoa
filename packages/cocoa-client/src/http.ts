import { CocoaClientError } from "./errors.ts";
import type { CocoaClientConnectOptions } from "./public-types.ts";

export interface CocoaClientHttpSession {
  readonly baseUrl: URL;
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

export async function createCocoaClientHttpSession(
  options: CocoaClientConnectOptions,
): Promise<CocoaClientHttpSession> {
  const baseUrl = normalizeCocoaBaseUrl(options.baseUrl);
  return {
    baseUrl,
    async issueWebSocketUrl() {
      const url = endpointUrl(baseUrl, "/api/client/v1/ws");
      url.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    },
  };
}
