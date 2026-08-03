// @effect-diagnostics nodeBuiltinImport:off - Protocol integration uses an isolated real renderer directory.
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

type ProtocolHandler = (request: Request) => Promise<Response>;

function captureHandler(): { readonly get: () => ProtocolHandler } {
  let handler: ProtocolHandler | undefined;
  handleMock.mockImplementation((_scheme, nextHandler) => {
    handler = nextHandler;
  });
  return {
    get: () => {
      assert.isDefined(handler);
      return handler!;
    },
  };
}

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    unhandleMock.mockReset();
  });

  it.effect("proxies the stable development origin to Vite with transient retry", () =>
    Effect.gen(function* () {
      const captured = captureHandler();
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            renderer: {
              _tag: "Development",
              origin: new URL("http://127.0.0.1:5733/"),
            },
          });
          return yield* Effect.promise(() =>
            captured.get()(new Request("t3code-dev://app/settings?tab=connections")),
          );
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
      assert.equal(
        netFetchMock.mock.calls[1]?.[0],
        "http://127.0.0.1:5733/settings?tab=connections",
      );
      assert.deepEqual(unhandleMock.mock.calls, [["t3code-dev"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("serves packaged assets with MIME, SPA fallback, asset 404, and CSP", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "cocoa-renderer-"))),
      (rootDirectory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              NodeFs.writeFile(NodePath.join(rootDirectory, "index.html"), "<main>Cocoa</main>"),
              NodeFs.writeFile(NodePath.join(rootDirectory, "app.css"), "body{}"),
            ]),
          );
          const captured = captureHandler();

          yield* Effect.scoped(
            Effect.gen(function* () {
              const protocol = yield* ElectronProtocol.ElectronProtocol;
              yield* protocol.registerDesktopProtocol({
                scheme: "t3code",
                renderer: { _tag: "Packaged", rootDirectory },
              });

              const css = yield* Effect.promise(() =>
                captured.get()(new Request("t3code://app/app.css")),
              );
              assert.equal(css.status, 200);
              assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
              assert.equal(yield* Effect.promise(() => css.text()), "body{}");

              const route = yield* Effect.promise(() =>
                captured.get()(new Request("t3code://app/settings/connections")),
              );
              assert.equal(route.status, 200);
              assert.equal(route.headers.get("content-type"), "text/html; charset=utf-8");
              assert.equal(yield* Effect.promise(() => route.text()), "<main>Cocoa</main>");

              const missingAsset = yield* Effect.promise(() =>
                captured.get()(new Request("t3code://app/assets/missing.js")),
              );
              assert.equal(missingAsset.status, 404);
              assert.include(
                missingAsset.headers.get("content-security-policy") ?? "",
                "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
              );
              assert.notInclude(missingAsset.headers.get("content-security-policy") ?? "", "clerk");
              assert.equal(missingAsset.headers.get("x-content-type-options"), "nosniff");

              const wrongHost = yield* Effect.promise(() =>
                captured.get()(new Request("t3code://other/app.css")),
              );
              assert.equal(wrongHost.status, 404);
            }),
          );
        }),
      (rootDirectory) => Effect.promise(() => NodeFs.rm(rootDirectory, { recursive: true })),
    ).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("contains encoded traversal and prefix-collision paths", () => {
    assert.isNull(
      ElectronProtocol.resolvePackagedAssetRequest({
        rootDirectory: "/tmp/cocoa-app",
        requestUrl: "t3code://app/..%2fsecret.txt",
      }),
    );
    assert.isNull(
      ElectronProtocol.resolvePackagedAssetRequest({
        rootDirectory: "/tmp/cocoa-app",
        requestUrl: "t3code://other/index.html",
      }),
    );
    const contained = ElectronProtocol.resolvePackagedAssetRequest({
      rootDirectory: "/tmp/cocoa-app",
      requestUrl: "t3code://app/assets/app.js",
    });
    assert.deepEqual(contained, {
      assetPath: "/tmp/cocoa-app/assets/app.js",
      useSpaFallback: false,
    });
    assert.isFalse(
      ElectronProtocol.isContainedPath("/tmp/cocoa-app", "/tmp/cocoa-application/app.js"),
    );
  });

  it.effect("preserves protocol registration and unregistration failures", () =>
    Effect.gen(function* () {
      const registrationCause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw registrationCause;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const registrationError = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "t3code",
          renderer: { _tag: "Packaged", rootDirectory: "/tmp/cocoa-renderer" },
        }),
      ).pipe(Effect.flip);
      assert.instanceOf(registrationError, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.strictEqual(registrationError.cause, registrationCause);

      handleMock.mockReset();
      unhandleMock.mockImplementationOnce(() => {
        throw new Error("protocol unregistration failed");
      });
      const freshProtocol = yield* ElectronProtocol.make;
      const exit = yield* Effect.exit(
        Effect.scoped(
          freshProtocol.registerDesktopProtocol({
            scheme: "t3code",
            renderer: { _tag: "Packaged", rootDirectory: "/tmp/cocoa-renderer" },
          }),
        ),
      );
      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assert.instanceOf(
          Cause.squash(exit.cause),
          ElectronProtocol.ElectronProtocolUnregistrationError,
        );
      }
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("keeps executable sources host-restricted while allowing gateway connections", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({ scheme: "t3code" });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );
    assert.deepEqual(directives["script-src"], ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]);
    assert.deepEqual(directives["connect-src"], ["'self'", "http:", "https:", "ws:", "wss:"]);
    assert.deepEqual(directives["frame-src"], ["'self'"]);
  });
});
