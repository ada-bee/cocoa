import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexError from "effect-codex-app-server/errors";

import { ProviderInstanceId } from "@t3tools/contracts";

import packageJson from "../../../package.json" with { type: "json" };

export const CODEX_ENDPOINT_INITIALIZE_TIMEOUT = "10 seconds" as const;

const COCOA_CLIENT_INFO = {
  name: "cocoa_gateway",
  title: "Cocoa Gateway",
  version: packageJson.version,
} as const;

export interface CodexEndpointIdentity {
  readonly providerInstanceId: ProviderInstanceId;
}

export interface CodexEndpointCompatibilityMetadata {
  readonly userAgent: string;
  readonly serverVersion: string | undefined;
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

export class CodexEndpointInitializationError extends Schema.TaggedErrorClass<CodexEndpointInitializationError>()(
  "CodexEndpointInitializationError",
  {
    providerInstanceId: ProviderInstanceId,
    cause: CodexError.CodexAppServerError,
  },
) {
  override get message() {
    return `Failed to initialize Codex endpoint '${this.providerInstanceId}'.`;
  }
}

export class CodexEndpointInitializationTimeoutError extends Schema.TaggedErrorClass<CodexEndpointInitializationTimeoutError>()(
  "CodexEndpointInitializationTimeoutError",
  {
    providerInstanceId: ProviderInstanceId,
    timeout: Schema.String,
  },
) {
  override get message() {
    return `Timed out initializing Codex endpoint '${this.providerInstanceId}' after ${this.timeout}.`;
  }
}

export class CodexEndpointTerminationError extends Schema.TaggedErrorClass<CodexEndpointTerminationError>()(
  "CodexEndpointTerminationError",
  {
    providerInstanceId: ProviderInstanceId,
    cause: CodexError.CodexAppServerError,
  },
) {
  override get message() {
    return `Codex endpoint '${this.providerInstanceId}' terminated.`;
  }
}

export type CodexEndpointConnectionError =
  | CodexEndpointInitializationError
  | CodexEndpointInitializationTimeoutError
  | CodexEndpointTerminationError;

export type CodexEndpointFramedTransport = Omit<
  CodexClient.CodexAppServerFramedClientOptions,
  "onTermination"
>;

export interface MakeCodexEndpointConnectionOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly framedTransport: CodexEndpointFramedTransport;
}

export class CodexEndpointConnection extends Context.Service<
  CodexEndpointConnection,
  {
    readonly identity: CodexEndpointIdentity;
    readonly client: CodexClient.CodexAppServerClient["Service"];
    readonly compatibility: CodexEndpointCompatibilityMetadata;
    readonly awaitTermination: Effect.Effect<never, CodexEndpointTerminationError>;
  }
>()("t3/provider/codexEndpoint/CodexEndpointConnection") {}

export const parseCodexServerVersion = (userAgent: string): string | undefined =>
  userAgent.match(/\/([^\s]+)/)?.[1];

const classifyInitializationError = (
  providerInstanceId: ProviderInstanceId,
  cause: CodexError.CodexAppServerError,
): CodexEndpointInitializationError | CodexEndpointTerminationError =>
  cause._tag === "CodexAppServerRequestError"
    ? new CodexEndpointInitializationError({ providerInstanceId, cause })
    : new CodexEndpointTerminationError({ providerInstanceId, cause });

export const make = Effect.fn("CodexEndpointConnection.make")(function* (
  options: MakeCodexEndpointConnectionOptions,
): Effect.fn.Return<CodexEndpointConnection["Service"], CodexEndpointConnectionError, Scope.Scope> {
  const parentScope = yield* Effect.scope;

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const connectionScope = yield* Scope.make("sequential");
      const acquire = Effect.gen(function* () {
        const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
        const awaitTermination = Deferred.await(terminated).pipe(
          Effect.flatMap((cause) =>
            Effect.fail(
              new CodexEndpointTerminationError({
                providerInstanceId: options.providerInstanceId,
                cause,
              }),
            ),
          ),
        );
        const client = yield* CodexClient.makeFramed({
          ...options.framedTransport,
          onTermination: (cause) => Deferred.succeed(terminated, cause).pipe(Effect.asVoid),
        });

        const handshake = Effect.gen(function* () {
          const initialized = yield* client.request("initialize", {
            clientInfo: COCOA_CLIENT_INFO,
            capabilities: {
              experimentalApi: true,
            },
          });
          yield* client.notify("initialized", undefined);
          return initialized;
        }).pipe(
          Effect.mapError((cause) =>
            classifyInitializationError(options.providerInstanceId, cause),
          ),
        );

        const initialized = yield* Effect.raceFirst(handshake, awaitTermination).pipe(
          Effect.timeout(CODEX_ENDPOINT_INITIALIZE_TIMEOUT),
          Effect.mapError((error) =>
            Cause.isTimeoutError(error)
              ? new CodexEndpointInitializationTimeoutError({
                  providerInstanceId: options.providerInstanceId,
                  timeout: CODEX_ENDPOINT_INITIALIZE_TIMEOUT,
                })
              : error,
          ),
        );

        return CodexEndpointConnection.of({
          identity: { providerInstanceId: options.providerInstanceId },
          client,
          compatibility: {
            userAgent: initialized.userAgent,
            serverVersion: parseCodexServerVersion(initialized.userAgent),
            codexHome: initialized.codexHome,
            platformFamily: initialized.platformFamily,
            platformOs: initialized.platformOs,
          },
          awaitTermination,
        });
      }).pipe(Effect.provideService(Scope.Scope, connectionScope));

      const connection = yield* restore(acquire).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Scope.close(connectionScope, Exit.void) : Effect.void,
        ),
      );
      yield* Scope.addFinalizer(
        parentScope,
        Scope.close(connectionScope, Exit.void).pipe(Effect.ignore),
      );
      return connection;
    }),
  );
});

export const layer = (
  options: MakeCodexEndpointConnectionOptions,
): Layer.Layer<CodexEndpointConnection, CodexEndpointConnectionError> =>
  Layer.effect(CodexEndpointConnection, make(options));
