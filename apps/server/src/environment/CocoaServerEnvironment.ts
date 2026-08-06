import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessHostname,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "./ServerEnvironmentService.ts";

export class CocoaEnvironmentIdPersistenceError extends Schema.TaggedErrorClass<CocoaEnvironmentIdPersistenceError>()(
  "CocoaEnvironmentIdPersistenceError",
  {
    operation: Schema.Literals(["check", "read", "write"]),
    environmentIdPath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const platformOs = (platform: NodeJS.Platform): ExecutionEnvironmentDescriptor["platform"]["os"] =>
  platform === "darwin"
    ? "darwin"
    : platform === "linux"
      ? "linux"
      : platform === "win32"
        ? "windows"
        : "unknown";

const platformArch = (
  architecture: NodeJS.Architecture,
): ExecutionEnvironmentDescriptor["platform"]["arch"] =>
  architecture === "arm64" ? "arm64" : architecture === "x64" ? "x64" : "other";

const loadOrCreateEnvironmentId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const persisted = yield* fileSystem.exists(serverConfig.environmentIdPath).pipe(
    Effect.mapError(
      (cause) =>
        new CocoaEnvironmentIdPersistenceError({
          operation: "check",
          environmentIdPath: serverConfig.environmentIdPath,
          cause,
        }),
    ),
    Effect.flatMap((exists) =>
      exists
        ? fileSystem.readFileString(serverConfig.environmentIdPath).pipe(
            Effect.map((value) => value.trim()),
            Effect.mapError(
              (cause) =>
                new CocoaEnvironmentIdPersistenceError({
                  operation: "read",
                  environmentIdPath: serverConfig.environmentIdPath,
                  cause,
                }),
            ),
          )
        : Effect.succeed(""),
    ),
  );
  const value = persisted.length > 0 ? persisted : yield* crypto.randomUUIDv4;
  if (persisted.length === 0) {
    yield* fileSystem.writeFileString(serverConfig.environmentIdPath, `${value}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new CocoaEnvironmentIdPersistenceError({
            operation: "write",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );
  }
  return EnvironmentId.make(value);
});

export const make = Effect.gen(function* () {
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const hostName = (yield* HostProcessHostname).trim();
  const environmentId = yield* loadOrCreateEnvironmentId;
  const descriptor: ExecutionEnvironmentDescriptor = {
    environmentId,
    label: hostName.length > 0 ? hostName : "Cocoa Gateway",
    platform: { os: platformOs(hostPlatform), arch: platformArch(hostArchitecture) },
    serverVersion: packageJson.version,
    capabilities: {
      repositoryIdentity: false,
      connectionProbe: true,
      threadSettlement: true,
      threadSnooze: true,
      threadTitleRegeneration: true,
      serverUpdateManagement: "administrator-managed",
    },
  };
  return ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.succeed(descriptor),
  });
});

export const layer = Layer.effect(ServerEnvironment, make);
