import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProviderProjectFaviconResolver from "../project/ProviderProjectFaviconResolver.ts";
import * as ProjectWorkspace from "../project/ProjectWorkspace.ts";
import type { ProjectWorkspaceShape } from "../project/ProjectWorkspace.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const unavailableProjectWorkspace = ProjectWorkspace.ProjectWorkspace.of({
  validateRoot: () => Effect.die("unexpected validateRoot"),
  getMetadata: () => Effect.die("unexpected getMetadata"),
  listDirectory: () => Effect.die("unexpected listDirectory"),
  listEntries: () => Effect.die("unexpected listEntries"),
  readFile: () => Effect.die("unexpected readFile"),
});
const testLayer = Layer.mergeAll(
  configLayer,
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
  Layer.succeed(ProjectWorkspace.ProjectWorkspace, unavailableProjectWorkspace),
).pipe(Layer.provideMerge(NodeServices.layer));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const parseAssetUrl = (relativeUrl: string) => {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  const separatorIndex = suffix.indexOf("/");
  return {
    token: suffix.slice(0, separatorIndex),
    fileName: suffix.slice(separatorIndex + 1),
  };
};

const decodeTokenClaims = (token: string): Record<string, unknown> =>
  JSON.parse(base64UrlDecodeUtf8(token.slice(0, token.indexOf(".")))) as Record<string, unknown>;

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

const makeProjectWorkspace = (
  overrides: Pick<ProjectWorkspaceShape, "getMetadata" | "readFile">,
): ProjectWorkspace.ProjectWorkspace["Service"] =>
  ProjectWorkspace.ProjectWorkspace.of({
    ...unavailableProjectWorkspace,
    ...overrides,
  });

describe("AssetAccess", () => {
  it.effect("serves a bounded binary workspace asset through its owning provider", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let fileSystemCalls = 0;
      let pathCalls = 0;
      const requested: Array<{ readonly operation: string; readonly relativePath: string }> = [];
      const workspace = makeProjectWorkspace({
        getMetadata: (input) => {
          requested.push({ operation: "metadata", relativePath: input.relativePath });
          return Effect.succeed({ kind: "file", size: 3 });
        },
        readFile: (input) => {
          requested.push({ operation: "read", relativePath: input.relativePath });
          return Effect.succeed({
            bytes: new Uint8Array([1, 2, 3]),
            byteLength: 3,
            truncated: false,
          });
        },
      });

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: "images/report.png",
        },
        workspaceTarget: {
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        },
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
        Effect.provideService(ProjectWorkspace.ProjectWorkspace, workspace),
      );
      const { token, fileName } = parseAssetUrl(result.relativeUrl);
      const resolved = yield* resolveAsset(token, fileName).pipe(
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
        Effect.provideService(ProjectWorkspace.ProjectWorkspace, workspace),
      );

      expect(resolved).toEqual({
        kind: "bytes",
        bytes: new Uint8Array([1, 2, 3]),
        relativePath: "images/report.png",
      });
      expect(requested).toEqual([
        { operation: "metadata", relativePath: "images/report.png" },
        { operation: "read", relativePath: "images/report.png" },
      ]);
      expect(fileSystemCalls).toBe(0);
      expect(pathCalls).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps browser-preview subresources rooted and bounded", () =>
    Effect.gen(function* () {
      const reads: Array<string> = [];
      const workspace = makeProjectWorkspace({
        getMetadata: () => Effect.succeed({ kind: "file", size: 20 }),
        readFile: (input) => {
          reads.push(input.relativePath);
          return Effect.succeed({
            bytes: new TextEncoder().encode("body{}"),
            byteLength: 6,
            truncated: false,
          });
        },
      });
      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: "site/index.html",
        },
        workspaceTarget: {
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        },
      }).pipe(Effect.provideService(ProjectWorkspace.ProjectWorkspace, workspace));
      const { token } = parseAssetUrl(result.relativeUrl);

      expect(
        yield* resolveAsset(token, "assets/site.css").pipe(
          Effect.provideService(ProjectWorkspace.ProjectWorkspace, workspace),
        ),
      ).toEqual({
        kind: "bytes",
        bytes: new TextEncoder().encode("body{}"),
        relativePath: "site/assets/site.css",
      });
      expect(yield* resolveAsset(token, "../secret.css")).toBeNull();
      expect(yield* resolveAsset(token, "payload.exe")).toBeNull();
      expect(reads).toEqual(["site/assets/site.css"]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects absolute, oversized, and truncated workspace previews", () =>
    Effect.gen(function* () {
      const target = {
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
      };
      const oversized = makeProjectWorkspace({
        getMetadata: () => Effect.succeed({ kind: "file", size: 1024 * 1024 + 1 }),
        readFile: () => Effect.die("oversized assets must not be read"),
      });
      const tooLarge = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: target.threadId,
          path: "large.png",
        },
        workspaceTarget: target,
      }).pipe(Effect.provideService(ProjectWorkspace.ProjectWorkspace, oversized), Effect.flip);
      expect(tooLarge).toMatchObject({
        _tag: "AssetWorkspaceAssetTooLargeError",
        maxBytes: 1024 * 1024,
      });

      const absolute = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: target.threadId,
          path: "/provider/workspace/image.png",
        },
        workspaceTarget: target,
      }).pipe(Effect.flip);
      expect(absolute._tag).toBe("AssetWorkspacePathValidationError");

      const truncated = makeProjectWorkspace({
        getMetadata: () => Effect.succeed({ kind: "file" }),
        readFile: () =>
          Effect.succeed({
            bytes: new Uint8Array(1024 * 1024),
            byteLength: 1024 * 1024 + 1,
            truncated: true,
          }),
      });
      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: target.threadId,
          path: "image.png",
        },
        workspaceTarget: target,
      }).pipe(Effect.provideService(ProjectWorkspace.ProjectWorkspace, truncated));
      const { token, fileName } = parseAssetUrl(result.relativeUrl);
      expect(
        yield* resolveAsset(token, fileName).pipe(
          Effect.provideService(ProjectWorkspace.ProjectWorkspace, truncated),
        ),
      ).toBeNull();
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

  it.effect("issues and serves an upstream v1 local project favicon claim", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "local-favicon-" });
      const faviconPath = path.join(cwd, "favicon.svg");
      const bytes = new TextEncoder().encode("<svg>local</svg>");
      yield* fileSystem.writeFile(faviconPath, bytes);
      const resolver = ProjectFaviconResolver.ProjectFaviconResolver.of({
        resolvePath: () => Effect.succeed(faviconPath),
      });

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd },
      }).pipe(
        Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, resolver),
        Effect.provide(WorkspacePaths.layer),
      );
      const { token, fileName } = parseAssetUrl(result.relativeUrl);
      expect(decodeTokenClaims(token)).toMatchObject({
        version: 1,
        kind: "project-favicon",
        workspaceRoot: cwd,
        relativePath: "favicon.svg",
      });
      expect(
        yield* resolveAsset(token, fileName).pipe(Effect.provide(WorkspacePaths.layer)),
      ).toEqual({ kind: "file", path: faviconPath });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "routes v2 project favicon claims by project id and serves bounded provider bytes",
    () =>
      Effect.gen(function* () {
        const firstProjectId = ProjectId.make("project-one");
        const secondProjectId = ProjectId.make("project-two");
        const requested: Array<{
          readonly projectId: ProjectId;
          readonly relativePath: string;
          readonly maxBytes: number;
        }> = [];
        const resolver = ProviderProjectFaviconResolver.ProviderProjectFaviconResolver.of({
          resolvePath: (projectId) =>
            Effect.succeed(projectId === firstProjectId ? "icons/one.svg" : "icons/two.svg"),
        });
        const workspace = makeProjectWorkspace({
          getMetadata: () => Effect.die("favicon discovery owns metadata inspection"),
          readFile: (input) => {
            requested.push({
              projectId: input.target.projectId,
              relativePath: input.relativePath,
              maxBytes: input.maxBytes,
            });
            const bytes = new TextEncoder().encode(
              input.target.projectId === firstProjectId ? "first" : "second",
            );
            return Effect.succeed({ bytes, byteLength: bytes.byteLength, truncated: false });
          },
        });
        const provideProviderServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(
              ProviderProjectFaviconResolver.ProviderProjectFaviconResolver,
              resolver,
            ),
            Effect.provideService(ProjectWorkspace.ProjectWorkspace, workspace),
          );

        const first = yield* provideProviderServices(
          issueAssetUrl({
            resource: {
              _tag: "project-favicon",
              cwd: "/same/provider/workspace",
              projectId: firstProjectId,
            },
          }),
        );
        const second = yield* provideProviderServices(
          issueAssetUrl({
            resource: {
              _tag: "project-favicon",
              cwd: "/same/provider/workspace",
              projectId: secondProjectId,
            },
          }),
        );
        expect(first.relativeUrl).not.toBe(second.relativeUrl);

        const parsed = parseAssetUrl(first.relativeUrl);
        expect(decodeTokenClaims(parsed.token)).toEqual({
          version: 2,
          kind: "project-favicon-provider",
          projectId: firstProjectId,
          relativePath: "icons/one.svg",
          expiresAt: first.expiresAt,
        });
        expect(yield* provideProviderServices(resolveAsset(parsed.token, parsed.fileName))).toEqual(
          {
            kind: "bytes",
            bytes: new TextEncoder().encode("first"),
            relativePath: "icons/one.svg",
          },
        );
        expect(requested).toEqual([
          { projectId: firstProjectId, relativePath: "icons/one.svg", maxBytes: 1024 * 1024 },
          { projectId: secondProjectId, relativePath: "icons/two.svg", maxBytes: 1024 * 1024 },
          { projectId: firstProjectId, relativePath: "icons/one.svg", maxBytes: 1024 * 1024 },
        ]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("uses the stable fallback when provider discovery finds no favicon", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-without-icon");
      const resolver = ProviderProjectFaviconResolver.ProviderProjectFaviconResolver.of({
        resolvePath: () => Effect.succeed(null),
      });
      const result = yield* issueAssetUrl({
        resource: {
          _tag: "project-favicon",
          cwd: "/provider/workspace",
          projectId,
        },
      }).pipe(
        Effect.provideService(
          ProviderProjectFaviconResolver.ProviderProjectFaviconResolver,
          resolver,
        ),
      );
      const { token, fileName } = parseAssetUrl(result.relativeUrl);

      expect(fileName).toBe(PROJECT_FAVICON_FALLBACK_MARKER);
      expect(decodeTokenClaims(token)).toEqual({
        version: 2,
        kind: "project-favicon-fallback",
        expiresAt: result.expiresAt,
      });
      expect(yield* resolveAsset(token, fileName)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );
});
