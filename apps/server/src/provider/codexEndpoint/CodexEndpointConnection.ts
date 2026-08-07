import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexError from "effect-codex-app-server/errors";

import { ProviderInstanceId } from "@t3tools/contracts";

import packageJson from "../../../package.json" with { type: "json" };

export const CODEX_ENDPOINT_INITIALIZE_TIMEOUT = "10 seconds" as const;
export const CODEX_ENDPOINT_CAPABILITY_PROBE_TIMEOUT = "2 seconds" as const;
export const CODEX_ENDPOINT_TESTED_BASELINE_VERSION = "0.146.0" as const;
export const CODEX_ENDPOINT_MAX_IN_FLIGHT_REQUESTS = 256;
export const CODEX_ENDPOINT_DEFAULT_REQUEST_TIMEOUT_MS = 150_000;
export const CODEX_ENDPOINT_MAX_CONCURRENT_INBOUND_REQUESTS = 32;
export const CODEX_ENDPOINT_INBOUND_REQUEST_QUEUE_CAPACITY = 64;

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
  /** Present on connections acquired through the compatibility-probing handshake. */
  readonly versionRelation?: CodexEndpointVersionRelation;
  /** Present on connections acquired through the compatibility-probing handshake. */
  readonly capabilities?: CodexEndpointNativeCapabilities;
}

export type CodexEndpointVersionRelation = "older" | "baseline" | "newer" | "unknown";

export type CodexEndpointNativeMethod =
  | "thread/start"
  | "thread/resume"
  | "thread/list"
  | "turn/start"
  | "turn/interrupt"
  | "thread/read"
  | "thread/rollback"
  | "thread/archive"
  | "thread/unarchive"
  | "thread/delete"
  | "thread/name/set"
  | "command/exec"
  | "command/exec/write"
  | "command/exec/resize"
  | "command/exec/terminate";

export type CodexEndpointNativeMethodAvailability = "available" | "unavailable";

export interface CodexEndpointNativeCapabilities {
  /** The minimum native conversation primitives Cocoa requires from every ready generation. */
  readonly conversation: true;
  /** Provider-native enumeration plus full thread reads. Required for authoritative history. */
  readonly conversationCatalog?: boolean;
  readonly conversationRead: boolean;
  /** Provider-native title, archive, unarchive, and delete mutations. */
  readonly conversationMutations?: boolean;
  readonly checkedConversationRollback: boolean;
  readonly commandExec: boolean;
  readonly commandExecControl: boolean;
  readonly methods: Readonly<
    Partial<Record<CodexEndpointNativeMethod, CodexEndpointNativeMethodAvailability>>
  >;
}

export class CodexEndpointCompatibilityError extends Schema.TaggedErrorClass<CodexEndpointCompatibilityError>()(
  "CodexEndpointCompatibilityError",
  {
    providerInstanceId: ProviderInstanceId,
    method: Schema.String,
    reason: Schema.Literals(["missing", "malformed", "timed-out"]),
  },
) {
  override get message() {
    return `Codex endpoint '${this.providerInstanceId}' is incompatible: required method '${this.method}' is ${this.reason}.`;
  }
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
  | CodexEndpointCompatibilityError
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

const parseNumericVersion = (version: string): readonly [number, number, number] | undefined => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const evaluateCodexEndpointVersion = (
  serverVersion: string | undefined,
): CodexEndpointVersionRelation => {
  const observed = serverVersion === undefined ? undefined : parseNumericVersion(serverVersion);
  const baseline = parseNumericVersion(CODEX_ENDPOINT_TESTED_BASELINE_VERSION)!;
  if (observed === undefined) return "unknown";
  for (let index = 0; index < baseline.length; index += 1) {
    if (observed[index]! < baseline[index]!) return "older";
    if (observed[index]! > baseline[index]!) return "newer";
  }
  return "baseline";
};

const REQUIRED_METHOD_PROBES = [
  ["thread/start", { cwd: false }],
  ["thread/resume", { threadId: false }],
  ["thread/list", { cursor: false }],
  ["turn/start", { threadId: false, input: false }],
  ["turn/interrupt", { threadId: false, turnId: false }],
  ["thread/read", { threadId: false }],
  ["thread/archive", { threadId: false }],
  ["thread/unarchive", { threadId: false }],
  ["thread/delete", { threadId: false }],
  ["thread/name/set", { threadId: false, name: false }],
] as const satisfies ReadonlyArray<readonly [CodexEndpointNativeMethod, unknown]>;

const OPTIONAL_METHOD_PROBES = [
  ["thread/rollback", { threadId: false, numTurns: false }],
  ["command/exec", { command: false }],
  ["command/exec/write", { processId: false }],
  ["command/exec/resize", { processId: false, size: false }],
  ["command/exec/terminate", { processId: false }],
] as const satisfies ReadonlyArray<readonly [CodexEndpointNativeMethod, unknown]>;

type ProbeResult =
  | { readonly _tag: "Available" }
  | { readonly _tag: "Unavailable"; readonly reason: "missing" | "malformed" | "timed-out" };

const probeNativeMethod = Effect.fn("CodexEndpointConnection.probeNativeMethod")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  method: CodexEndpointNativeMethod,
  invalidParams: unknown,
): Effect.fn.Return<ProbeResult, CodexError.CodexAppServerError> {
  const result = yield* client.raw
    .request(method, invalidParams)
    .pipe(Effect.timeoutOption(CODEX_ENDPOINT_CAPABILITY_PROBE_TIMEOUT), Effect.result);
  if (result._tag === "Success") {
    return Option.isNone(result.success)
      ? { _tag: "Unavailable", reason: "timed-out" }
      : { _tag: "Unavailable", reason: "malformed" };
  }
  const error = result.failure;
  if (error._tag === "CodexAppServerRequestError") {
    if (error.code === -32601) return { _tag: "Unavailable", reason: "missing" };
    // Invalid params is the expected response. Other application-level errors
    // also prove that the server routed the named method without mutating state.
    // Codex 0.146 reports invalid parameter types as -32600 rather than the
    // JSON-RPC-standard -32602, so only method-not-found means unavailable.
    return { _tag: "Available" };
  }
  if (error._tag === "CodexAppServerProtocolParseError") {
    return { _tag: "Unavailable", reason: "malformed" };
  }
  return yield* error;
});

const probeNativeCapabilities = Effect.fn("CodexEndpointConnection.probeNativeCapabilities")(
  function* (
    providerInstanceId: ProviderInstanceId,
    client: CodexClient.CodexAppServerClient["Service"],
  ): Effect.fn.Return<
    CodexEndpointNativeCapabilities,
    CodexEndpointCompatibilityError | CodexError.CodexAppServerError
  > {
    const required = yield* Effect.forEach(
      REQUIRED_METHOD_PROBES,
      ([method, params]) =>
        probeNativeMethod(client, method, params).pipe(
          Effect.map((result) => [method, result] as const),
        ),
      { concurrency: 4 },
    );
    for (const [method, result] of required) {
      if (result._tag === "Unavailable") {
        return yield* new CodexEndpointCompatibilityError({
          providerInstanceId,
          method,
          reason: result.reason,
        });
      }
    }
    const optional = yield* Effect.forEach(
      OPTIONAL_METHOD_PROBES,
      ([method, params]) =>
        probeNativeMethod(client, method, params).pipe(
          Effect.map((result) => [method, result] as const),
        ),
      { concurrency: 4 },
    );
    const methods = Object.fromEntries(
      [...required, ...optional].map(([method, result]) => [
        method,
        result._tag === "Available" ? "available" : "unavailable",
      ]),
    ) as Record<CodexEndpointNativeMethod, CodexEndpointNativeMethodAvailability>;
    const available = (method: CodexEndpointNativeMethod) => methods[method] === "available";
    const commandExec = available("command/exec");
    return {
      conversation: true,
      conversationCatalog: true,
      conversationRead: true,
      conversationMutations: true,
      checkedConversationRollback: available("thread/rollback"),
      commandExec,
      commandExecControl:
        commandExec &&
        available("command/exec/write") &&
        available("command/exec/resize") &&
        available("command/exec/terminate"),
      methods,
    };
  },
);

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
          clientRequests: {
            maxInFlight: CODEX_ENDPOINT_MAX_IN_FLIGHT_REQUESTS,
            defaultTimeoutMs: CODEX_ENDPOINT_DEFAULT_REQUEST_TIMEOUT_MS,
          },
          inboundRequests: {
            maxConcurrent: CODEX_ENDPOINT_MAX_CONCURRENT_INBOUND_REQUESTS,
            queueCapacity: CODEX_ENDPOINT_INBOUND_REQUEST_QUEUE_CAPACITY,
          },
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
          const capabilities = yield* probeNativeCapabilities(options.providerInstanceId, client);
          return { initialized, capabilities };
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "CodexEndpointCompatibilityError"
              ? cause
              : classifyInitializationError(options.providerInstanceId, cause),
          ),
        );

        const { initialized, capabilities } = yield* Effect.raceFirst(
          handshake,
          awaitTermination,
        ).pipe(
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
            versionRelation: evaluateCodexEndpointVersion(
              parseCodexServerVersion(initialized.userAgent),
            ),
            capabilities,
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
