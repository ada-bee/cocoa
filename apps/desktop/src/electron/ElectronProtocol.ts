// @effect-diagnostics nodeBuiltinImport:off - Electron protocol handlers read trusted ASAR renderer assets from native async callbacks.
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
export const DESKTOP_PRODUCTION_SCHEME = "t3code";
export const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

/** Electron requires custom scheme privileges before the app becomes ready. */
export function registerDesktopSchemePrivilegesSync(): void {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PRODUCTION_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
    {
      scheme: DESKTOP_DEVELOPMENT_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export const layerSchemePrivileges = Layer.effectDiscard(
  Effect.sync(registerDesktopSchemePrivilegesSync).pipe(
    Effect.withSpan("desktop.electron.protocol.registerSchemePrivileges"),
  ),
);

export class ElectronProtocolRegistrationError extends Schema.TaggedErrorClass<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedErrorClass<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

export type DesktopRendererSource =
  | { readonly _tag: "Development"; readonly origin: URL }
  | { readonly _tag: "Packaged"; readonly rootDirectory: string };

export interface DesktopProtocolRegistrationInput {
  readonly scheme: string;
  readonly renderer: DesktopRendererSource;
}

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: { readonly scheme: string }): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "connect-src 'self' http: https: ws: wss:",
    `img-src 'self' ${input.scheme}: blob: data: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${input.scheme}: data:`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function proxyDevelopmentRequest(
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return withContentSecurityPolicy(new Response(null, { status: 404 }), contentSecurityPolicy);
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headers.delete(name);
    }
  }
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function isContainedPath(rootDirectory: string, candidatePath: string): boolean {
  const relative = NodePath.relative(rootDirectory, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

export function resolvePackagedAssetRequest(input: {
  readonly rootDirectory: string;
  readonly requestUrl: string;
}): { readonly assetPath: string; readonly useSpaFallback: boolean } | null {
  const url = new URL(input.requestUrl);
  if (url.host !== DESKTOP_HOST) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;

  const rootDirectory = NodePath.resolve(input.rootDirectory);
  const assetPath = NodePath.resolve(rootDirectory, `.${decodedPath}`);
  if (!isContainedPath(rootDirectory, assetPath)) return null;

  const finalSegment = decodedPath.split("/").at(-1) ?? "";
  return {
    assetPath,
    useSpaFallback: finalSegment.length === 0 || NodePath.extname(finalSegment).length === 0,
  };
}

function isMissingAssetError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR")
  );
}

async function readPackagedAsset(
  request: Request,
  rootDirectory: string,
  contentSecurityPolicy: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withContentSecurityPolicy(new Response(null, { status: 405 }), contentSecurityPolicy);
  }
  const resolved = resolvePackagedAssetRequest({ rootDirectory, requestUrl: request.url });
  if (resolved === null) {
    return withContentSecurityPolicy(new Response(null, { status: 404 }), contentSecurityPolicy);
  }

  let assetPath = resolved.assetPath;
  let bytes: Uint8Array;
  try {
    bytes = await NodeFs.readFile(assetPath);
  } catch (error) {
    if (!resolved.useSpaFallback || !isMissingAssetError(error)) {
      const status = isMissingAssetError(error) ? 404 : 500;
      return withContentSecurityPolicy(new Response(null, { status }), contentSecurityPolicy);
    }
    assetPath = NodePath.join(NodePath.resolve(rootDirectory), "index.html");
    try {
      bytes = await NodeFs.readFile(assetPath);
    } catch (fallbackError) {
      const status = isMissingAssetError(fallbackError) ? 404 : 500;
      return withContentSecurityPolicy(new Response(null, { status }), contentSecurityPolicy);
    }
  }

  const contentType =
    MIME_TYPES[NodePath.extname(assetPath).toLowerCase()] ?? "application/octet-stream";
  const body = request.method === "HEAD" ? null : Uint8Array.from(bytes).buffer;
  return withContentSecurityPolicy(
    new Response(body, { status: 200, headers: { "Content-Type": contentType } }),
    contentSecurityPolicy,
  );
}

export const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);
      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, (request) =>
              input.renderer._tag === "Development"
                ? proxyDevelopmentRequest(request, input.renderer.origin, contentSecurityPolicy)
                : readPackagedAsset(request, input.renderer.rootDirectory, contentSecurityPolicy),
            );
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({ scheme: input.scheme, cause }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
