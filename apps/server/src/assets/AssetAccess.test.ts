import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode, signPayload } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const parseAssetUrl = (relativeUrl: string) => {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  const separatorIndex = suffix.indexOf("/");
  return {
    token: suffix.slice(0, separatorIndex),
    fileName: suffix.slice(separatorIndex + 1),
  };
};

const makeLegacyToken = Effect.fn("AssetAccessTest.makeLegacyToken")(function* (
  claims: Record<string, unknown>,
) {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom("asset-access-signing-key", 32);
  const encodedPayload = base64UrlEncode(encodeUnknownJson(claims));
  return `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
});

const makeExplodingFileSystem = (fileSystem: FileSystem.FileSystem, onCall: () => void) =>
  FileSystem.FileSystem.of(
    new Proxy(fileSystem, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return () => {
          onCall();
          throw new Error("gateway filesystem must not inspect a provider workspace");
        };
      },
    }),
  );

const makeExplodingPath = (path: Path.Path, onCall: () => void) =>
  Path.Path.of(
    new Proxy(path, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return () => {
          onCall();
          throw new Error("gateway path service must not interpret a provider workspace");
        };
      },
    }),
  );

describe("AssetAccess", () => {
  it.effect("fails workspace asset issuance closed without inspecting gateway paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let fileSystemCalls = 0;
      let pathCalls = 0;
      let resolverCalls = 0;
      const resolver = ProjectFaviconResolver.ProjectFaviconResolver.of({
        resolvePath: () => {
          resolverCalls += 1;
          return Effect.die("project favicon resolver must not be called");
        },
      });

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: "/provider/workspace/report.html",
        },
        workspaceRoot: "/provider/workspace",
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          makeExplodingFileSystem(fileSystem, () => {
            fileSystemCalls += 1;
          }),
        ),
        Effect.provideService(
          Path.Path,
          makeExplodingPath(path, () => {
            pathCalls += 1;
          }),
        ),
        Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, resolver),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "AssetWorkspaceAssetNotFoundError",
        resource: { _tag: "workspace-file", path: "/provider/workspace/report.html" },
      });
      expect(fileSystemCalls).toBe(0);
      expect(pathCalls).toBe(0);
      expect(resolverCalls).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails legacy provider-owned claims closed without inspecting gateway paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const expiresAt = (yield* Clock.currentTimeMillis) + 60_000;
      let fileSystemCalls = 0;
      let pathCalls = 0;
      const legacyClaims = [
        {
          version: 1,
          kind: "workspace-file",
          workspaceRoot: "/provider/workspace",
          baseRelativePath: ".",
          expiresAt,
        },
        {
          version: 1,
          kind: "workspace-file-exact",
          workspaceRoot: "/provider/workspace",
          relativePath: "favicon.png",
          expiresAt,
        },
        {
          version: 1,
          kind: "project-favicon",
          workspaceRoot: "/provider/workspace",
          relativePath: "favicon.svg",
          expiresAt,
        },
      ];

      for (const claims of legacyClaims) {
        const token = yield* makeLegacyToken(claims);
        expect(
          yield* resolveAsset(token, "favicon.svg").pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              makeExplodingFileSystem(fileSystem, () => {
                fileSystemCalls += 1;
              }),
            ),
            Effect.provideService(
              Path.Path,
              makeExplodingPath(path, () => {
                pathCalls += 1;
              }),
            ),
          ),
        ).toBeNull();
      }

      expect(fileSystemCalls).toBe(0);
      expect(pathCalls).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps gateway-managed attachment assets enabled", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
      });
      const { token } = parseAssetUrl(result.relativeUrl);

      expect(yield* resolveAsset(token, "ignored.png")).toEqual({
        kind: "file",
        path: attachmentPath,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues a stable project favicon fallback without inspecting cwd", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let fileSystemCalls = 0;
      let pathCalls = 0;
      let resolverCalls = 0;
      const resolver = ProjectFaviconResolver.ProjectFaviconResolver.of({
        resolvePath: () => {
          resolverCalls += 1;
          return Effect.die("project favicon resolver must not be called");
        },
      });
      const provideExplodingServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            makeExplodingFileSystem(fileSystem, () => {
              fileSystemCalls += 1;
            }),
          ),
          Effect.provideService(
            Path.Path,
            makeExplodingPath(path, () => {
              pathCalls += 1;
            }),
          ),
          Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, resolver),
        );

      const result = yield* provideExplodingServices(
        issueAssetUrl({
          resource: { _tag: "project-favicon", cwd: "/provider/workspace" },
        }),
      );
      expect(result.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      expect(
        yield* provideExplodingServices(
          issueAssetUrl({
            resource: { _tag: "project-favicon", cwd: "/another/provider/workspace" },
          }),
        ),
      ).toEqual(result);

      const { token, fileName } = parseAssetUrl(result.relativeUrl);
      expect(yield* provideExplodingServices(resolveAsset(token, fileName))).toBeNull();
      expect(fileSystemCalls).toBe(0);
      expect(pathCalls).toBe(0);
      expect(resolverCalls).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );
});
