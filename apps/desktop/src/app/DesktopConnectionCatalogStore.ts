import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform/storage-document";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const EncryptedConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedCatalog: Schema.String,
});
type EncryptedConnectionCatalogDocument = typeof EncryptedConnectionCatalogDocument.Type;

const EncryptedConnectionCatalogDocumentJson = fromLenientJson(EncryptedConnectionCatalogDocument);
const decodeEncryptedConnectionCatalogDocumentJson = Schema.decodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const encodeEncryptedConnectionCatalogDocumentJson = Schema.encodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const decodeConnectionCatalogDocumentJson = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

const DesktopConnectionCatalogStoreWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-catalog-file",
]);

const DesktopConnectionCatalogStoreProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "encrypt-catalog",
  "decrypt-catalog",
]);

export class DesktopConnectionCatalogStoreWriteError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreWriteError>()(
  "DesktopConnectionCatalogStoreWriteError",
  {
    operation: DesktopConnectionCatalogStoreWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopConnectionCatalogStoreDecodeError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreDecodeError>()(
  "DesktopConnectionCatalogStoreDecodeError",
  {
    resource: Schema.Literal("encryptedCatalog"),
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource} for the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreReadError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreReadError>()(
  "DesktopConnectionCatalogStoreReadError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreDocumentDecodeError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreDocumentDecodeError>()(
  "DesktopConnectionCatalogStoreDocumentDecodeError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the desktop connection catalog document at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreProtectionError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreProtectionError>()(
  "DesktopConnectionCatalogStoreProtectionError",
  {
    operation: DesktopConnectionCatalogStoreProtectionOperation,
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog protection failed during ${this.operation} at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreValidationError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreValidationError>()(
  "DesktopConnectionCatalogStoreValidationError",
  {
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Desktop connection catalog is not a direct Cocoa gateway catalog: ${this.reason}.`;
  }
}
const isDesktopConnectionCatalogStoreValidationError = Schema.is(
  DesktopConnectionCatalogStoreValidationError,
);

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      Option.Option<string>,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<
      boolean,
      | DesktopConnectionCatalogStoreWriteError
      | DesktopConnectionCatalogStoreProtectionError
      | DesktopConnectionCatalogStoreValidationError
    >;
    readonly clear: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopConnectionCatalogStore") {}

function decodeSecretBytes(
  catalogPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopConnectionCatalogStoreDecodeError> {
  return Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreDecodeError({
          resource: "encryptedCatalog",
          catalogPath,
          cause,
        }),
    ),
  );
}

function parseGatewayUrl(
  raw: string,
  protocols: readonly string[],
  field: string,
): URL | DesktopConnectionCatalogStoreValidationError {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    return new DesktopConnectionCatalogStoreValidationError({
      reason: `${field} must be an absolute URL`,
      cause,
    });
  }
  if (!protocols.includes(url.protocol)) {
    return new DesktopConnectionCatalogStoreValidationError({
      reason: `${field} uses unsupported protocol ${url.protocol}`,
    });
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return new DesktopConnectionCatalogStoreValidationError({
      reason: `${field} must identify a gateway origin without credentials, path, query, or fragment`,
    });
  }
  return url;
}

const validateDirectConnectionCatalog = Effect.fn(
  "desktop.connectionCatalogStore.validateDirectCatalog",
)(function* (catalog: string) {
  const document = yield* decodeConnectionCatalogDocumentJson(catalog).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreValidationError({
          reason: "document does not match the Primary/Bearer catalog schema",
          cause,
        }),
    ),
  );
  const targetsByConnectionId = new Map(
    document.targets.map((target) => [target.connectionId, target] as const),
  );
  for (const profile of document.profiles) {
    const target = targetsByConnectionId.get(profile.connectionId);
    if (target === undefined || target.environmentId !== profile.environmentId) {
      return yield* new DesktopConnectionCatalogStoreValidationError({
        reason: `profile ${profile.connectionId} is not paired with its bearer target`,
      });
    }
    const httpUrl = parseGatewayUrl(profile.httpBaseUrl, ["http:", "https:"], "httpBaseUrl");
    if (isDesktopConnectionCatalogStoreValidationError(httpUrl)) return yield* httpUrl;
    const wsUrl = parseGatewayUrl(profile.wsBaseUrl, ["ws:", "wss:"], "wsBaseUrl");
    if (isDesktopConnectionCatalogStoreValidationError(wsUrl)) return yield* wsUrl;
    const expectedWsProtocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    if (wsUrl.protocol !== expectedWsProtocol || wsUrl.host !== httpUrl.host) {
      return yield* new DesktopConnectionCatalogStoreValidationError({
        reason: "httpBaseUrl and wsBaseUrl must describe the same gateway origin",
      });
    }
  }
  for (const credential of document.credentials) {
    if (!targetsByConnectionId.has(credential.connectionId)) {
      return yield* new DesktopConnectionCatalogStoreValidationError({
        reason: `credential ${credential.connectionId} has no bearer target`,
      });
    }
    if (credential.credential.token.trim().length === 0) {
      return yield* new DesktopConnectionCatalogStoreValidationError({
        reason: `credential ${credential.connectionId} has an empty bearer token`,
      });
    }
  }
});

const readDocument = (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.Effect<
  Option.Option<EncryptedConnectionCatalogDocument>,
  DesktopConnectionCatalogStoreReadError | DesktopConnectionCatalogStoreDocumentDecodeError
> =>
  fileSystem.readFileString(catalogPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(
            new DesktopConnectionCatalogStoreReadError({
              catalogPath,
              cause: error,
            }),
          ),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(Option.none<EncryptedConnectionCatalogDocument>())
        : decodeEncryptedConnectionCatalogDocumentJson(raw).pipe(
            Effect.map(Option.some),
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreDocumentDecodeError({
                  catalogPath,
                  cause,
                }),
            ),
          ),
    ),
  );

const writeDocument = Effect.fn("desktop.connectionCatalogStore.writeDocument")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly catalogPath: string;
  readonly document: EncryptedConnectionCatalogDocument;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopConnectionCatalogStoreWriteError> {
  const directory = input.path.dirname(input.catalogPath);
  const tempPath = `${input.catalogPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeEncryptedConnectionCatalogDocumentJson(input.document).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "encode-document",
          path: input.catalogPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* Effect.gen(function* () {
    yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "write-temporary-file",
            path: tempPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.rename(tempPath, input.catalogPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "replace-catalog-file",
            path: input.catalogPath,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.ensuring(
      input.fileSystem.remove(tempPath, { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove a temporary connection catalog file.", {
            tempPath,
            error,
          }),
        ),
      ),
    ),
  );
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const catalogPath = environment.connectionCatalogPath;
  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreProtectionError({
          operation: "check-encryption-availability",
          catalogPath,
          cause,
        }),
    ),
  );

  const writeCatalog = Effect.fn("desktop.connectionCatalogStore.writeCatalog")(function* (
    catalog: string,
  ) {
    const encryptedCatalog = Encoding.encodeBase64(
      yield* safeStorage.encryptString(catalog).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreProtectionError({
              operation: "encrypt-catalog",
              catalogPath,
              cause,
            }),
        ),
      ),
    );
    const suffix = (yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-temporary-file-name",
            path: catalogPath,
            cause,
          }),
      ),
    )).replace(/-/g, "");
    yield* writeDocument({
      fileSystem,
      path,
      catalogPath,
      document: { version: 1, encryptedCatalog },
      suffix,
    });
  });

  return DesktopConnectionCatalogStore.of({
    get: Effect.gen(function* () {
      const document = yield* readDocument(fileSystem, catalogPath);
      if (Option.isNone(document)) {
        return Option.none<string>();
      }
      if (!(yield* encryptionAvailable)) {
        return Option.none<string>();
      }
      const decrypted = yield* decodeSecretBytes(catalogPath, document.value.encryptedCatalog).pipe(
        Effect.flatMap((encryptedCatalog) =>
          safeStorage.decryptString(encryptedCatalog).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreProtectionError({
                  operation: "decrypt-catalog",
                  catalogPath,
                  cause,
                }),
            ),
          ),
        ),
      );
      return Option.some(decrypted);
    }).pipe(Effect.withSpan("desktop.connectionCatalogStore.get")),
    set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog) {
      yield* validateDirectConnectionCatalog(catalog);
      if (!(yield* encryptionAvailable)) {
        return false;
      }
      yield* writeCatalog(catalog);
      return true;
    }),
    clear: fileSystem.remove(catalogPath, { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not clear the desktop connection catalog.", {
          catalogPath,
          error,
        }),
      ),
      Effect.withSpan("desktop.connectionCatalogStore.clear"),
    ),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
