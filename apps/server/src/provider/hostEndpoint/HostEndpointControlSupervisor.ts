import {
  CocoaHostControlEvent,
  type CocoaHostControlOperation,
  type CocoaHostTransport,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { makeCocoaHostControlTransportOpener } from "./CocoaHostControlTransport.ts";
import {
  type HostEndpointControlClient,
  type HostEndpointControlContract,
  type HostEndpointControlRequestPayload,
  type HostEndpointControlSuccess,
  requestHostEndpoint,
} from "./HostEndpointControlClient.ts";
import {
  HostEndpointRpcAuthenticationError,
  type HostEndpointRpcClientInfo,
  HostEndpointRpcInvalidPayloadError,
  HostEndpointRpcOpenError,
  HostEndpointRpcRemoteError,
  HostEndpointRpcResponseDecodeError,
  type HostEndpointRpcRequestError,
  makeHostEndpointRpcClient,
} from "./HostEndpointRpcClient.ts";
import { decodeHostEndpointEventFrame } from "./HostEndpointRpcWire.ts";

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRY_JITTER_RATIO = 0.2;

export type HostEndpointControlConnectError =
  | HostEndpointRpcAuthenticationError
  | HostEndpointRpcOpenError
  | HostEndpointRpcRequestError;

export type HostEndpointControlBlockedReason = "authentication" | "version";
export type HostEndpointControlErrorDisposition = HostEndpointControlBlockedReason | "transient";

export type HostEndpointControlSupervisorState =
  | { readonly _tag: "Connecting"; readonly attempt: number }
  | {
      readonly _tag: "Ready";
      /** Monotonic identity for this exact client/handshake within the supervisor. */
      readonly generationId: number;
      /** Host process generation advertised by the immutable handshake. */
      readonly hostGenerationId: string;
      readonly handshake: HostEndpointControlClient["handshake"];
      readonly capabilities: HostEndpointControlClient["handshake"]["capabilities"];
    }
  | {
      readonly _tag: "Retrying";
      readonly attempt: number;
      readonly error: HostEndpointControlConnectError;
      readonly delay: Duration.Duration | null;
    }
  | {
      readonly _tag: "Blocked";
      readonly reason: HostEndpointControlBlockedReason;
      readonly error: HostEndpointControlConnectError;
    }
  | { readonly _tag: "Closed" };

interface HostEndpointControlGeneration {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly client: HostEndpointControlClient;
}

interface SupervisorInternalState {
  readonly publicState: HostEndpointControlSupervisorState;
  readonly current: HostEndpointControlGeneration | null;
  readonly closed: boolean;
  readonly started: boolean;
}

export class HostEndpointControlUnavailableError extends Schema.TaggedErrorClass<HostEndpointControlUnavailableError>()(
  "HostEndpointControlUnavailableError",
  {},
) {
  override get message(): string {
    return "The provider host control endpoint is unavailable.";
  }
}

export type HostEndpointControlBorrowError = HostEndpointControlUnavailableError;

export class HostEndpointControlBorrowInvalidatedError extends Schema.TaggedErrorClass<HostEndpointControlBorrowInvalidatedError>()(
  "HostEndpointControlBorrowInvalidatedError",
  {
    generationId: Schema.Int,
    hostGenerationId: Schema.String,
  },
) {
  override get message(): string {
    return `Provider host control generation ${this.generationId} is no longer current.`;
  }
}

export interface HostEndpointControlBorrow {
  readonly generationId: number;
  readonly hostGenerationId: string;
  readonly client: HostEndpointControlClient;
  readonly handshake: HostEndpointControlClient["handshake"];
  readonly capabilities: HostEndpointControlClient["handshake"]["capabilities"];
  readonly ensureCurrent: Effect.Effect<void, HostEndpointControlBorrowInvalidatedError>;
  /**
   * Starts a request only while this exact generation is current. A request is
   * never moved to, or replayed against, a later generation.
   */
  readonly request: <Operation extends CocoaHostControlOperation>(
    operation: Operation,
    payload: HostEndpointControlRequestPayload<Operation>,
  ) => Effect.Effect<
    HostEndpointControlSuccess<Operation>,
    HostEndpointControlBorrowInvalidatedError | HostEndpointRpcRequestError
  >;
}

export interface HostEndpointControlSupervisor {
  readonly start: Effect.Effect<void>;
  readonly borrow: Effect.Effect<HostEndpointControlBorrow, HostEndpointControlUnavailableError>;
  /** Convenience dependency for adapters which borrow a fresh client per operation. */
  readonly borrowClient: Effect.Effect<
    HostEndpointControlClient,
    HostEndpointControlUnavailableError
  >;
  readonly getState: Effect.Effect<HostEndpointControlSupervisorState>;
  readonly getCapabilities: Effect.Effect<
    HostEndpointControlClient["handshake"]["capabilities"] | null
  >;
  readonly subscribeChanges: Effect.Effect<
    PubSub.Subscription<HostEndpointControlSupervisorState>,
    never,
    Scope.Scope
  >;
}

export interface HostEndpointControlSupervisorConnectInput {
  readonly transport: CocoaHostTransport;
  readonly clientInfo: HostEndpointRpcClientInfo;
}

export interface HostEndpointControlSupervisorDependencies {
  readonly connect: (
    input: HostEndpointControlSupervisorConnectInput,
  ) => Effect.Effect<HostEndpointControlClient, HostEndpointControlConnectError, Scope.Scope>;
  readonly retryDelay: (retryIndex: number) => Effect.Effect<Duration.Duration>;
  readonly sleep: (delay: Duration.Duration) => Effect.Effect<void>;
}

export interface MakeHostEndpointControlSupervisorOptions {
  readonly transport: CocoaHostTransport;
  readonly clientInfo: HostEndpointRpcClientInfo;
  readonly dependencies?: Partial<HostEndpointControlSupervisorDependencies>;
}

const nestedHttpStatus = (cause: unknown): number | undefined => {
  const pending: Array<unknown> = [cause];
  const seen = new Set<unknown>();
  for (let index = 0; pending.length > 0 && index < 24; index += 1) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const record = current as Readonly<Record<string, unknown>>;
    if (typeof record.httpStatus === "number") return record.httpStatus;
    if (typeof record.status === "number") return record.status;
    const response = record.response;
    if (typeof response === "object" && response !== null) {
      const status = (response as { readonly status?: unknown }).status;
      if (typeof status === "number") return status;
    }
    for (const key of ["cause", "error", "data", "body"] as const) {
      if (record[key] !== undefined) pending.push(record[key]);
    }
  }
  return undefined;
};

const isAuthenticationError = Schema.is(HostEndpointRpcAuthenticationError);
const isOpenError = Schema.is(HostEndpointRpcOpenError);
const isRemoteError = Schema.is(HostEndpointRpcRemoteError);
const isInvalidPayloadError = Schema.is(HostEndpointRpcInvalidPayloadError);
const isResponseDecodeError = Schema.is(HostEndpointRpcResponseDecodeError);

/** Classify only handshake/auth failures as permanent for this configuration. */
export function classifyHostEndpointControlError(
  error: HostEndpointControlConnectError,
): HostEndpointControlErrorDisposition {
  if (isAuthenticationError(error)) return "authentication";
  if (isOpenError(error)) {
    const status = nestedHttpStatus(error.cause);
    return status === 401 || status === 403 ? "authentication" : "transient";
  }
  if (isRemoteError(error) && error.operation === "handshake") {
    return error.retryable ? "transient" : "version";
  }
  if (
    (isInvalidPayloadError(error) || isResponseDecodeError(error)) &&
    error.operation === "handshake"
  ) {
    return "version";
  }
  return "transient";
}

export function calculateHostEndpointControlRetryDelay(
  retryIndex: number,
  randomValue: number,
): Duration.Duration {
  const boundedIndex = Math.max(0, Math.min(30, Math.floor(retryIndex)));
  const exponential = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** boundedIndex);
  const random = Math.max(0, Math.min(1, randomValue));
  const jittered = exponential * (1 - RETRY_JITTER_RATIO + random * RETRY_JITTER_RATIO * 2);
  return Duration.millis(Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.round(jittered))));
}

export const defaultHostEndpointControlRetryDelay = Effect.fn(
  "HostEndpointControlSupervisor.defaultRetryDelay",
)(function* (retryIndex: number) {
  return calculateHostEndpointControlRetryDelay(retryIndex, yield* Random.next);
});

const openTransport = makeCocoaHostControlTransportOpener();
const connectHostEndpointControl: HostEndpointControlSupervisorDependencies["connect"] = (input) =>
  makeHostEndpointRpcClient<HostEndpointControlContract, CocoaHostControlEvent>({
    url: input.transport.url,
    key: input.transport.key,
    client: input.clientInfo,
    openTransport,
    decodeEvent: decodeHostEndpointEventFrame,
  });

const defaultDependencies: HostEndpointControlSupervisorDependencies = {
  connect: connectHostEndpointControl,
  retryDelay: defaultHostEndpointControlRetryDelay,
  sleep: (delay) => Effect.sleep(delay),
};

const closeGeneration = (generation: HostEndpointControlGeneration) =>
  Scope.close(generation.scope, Exit.void).pipe(Effect.ignore);

export const makeHostEndpointControlSupervisor = Effect.fn("HostEndpointControlSupervisor.make")(
  function* (
    options: MakeHostEndpointControlSupervisorOptions,
  ): Effect.fn.Return<HostEndpointControlSupervisor, never, Scope.Scope> {
    const dependencies: HostEndpointControlSupervisorDependencies = {
      ...defaultDependencies,
      ...options.dependencies,
    };
    const parentScope = yield* Effect.scope;
    const changes = yield* PubSub.unbounded<HostEndpointControlSupervisorState>();
    const transitionSemaphore = yield* Semaphore.make(1);
    const stateRef = yield* SynchronizedRef.make<SupervisorInternalState>({
      publicState: { _tag: "Connecting", attempt: 1 },
      current: null,
      closed: false,
      started: false,
    });
    let nextGenerationId = 1;

    const publishTransition = <A>(
      transition: (state: SupervisorInternalState) => readonly [A, SupervisorInternalState] | null,
    ): Effect.Effect<A | null> =>
      transitionSemaphore.withPermits(1)(
        SynchronizedRef.modify(
          stateRef,
          (
            state,
          ): readonly [
            (
              | { readonly _tag: "Skipped" }
              | {
                  readonly _tag: "Applied";
                  readonly value: A;
                  readonly publicState: HostEndpointControlSupervisorState;
                }
            ),
            SupervisorInternalState,
          ] => {
            const result = transition(state);
            if (result === null) return [{ _tag: "Skipped" }, state] as const;
            const [value, next] = result;
            return [{ _tag: "Applied", value, publicState: next.publicState } as const, next];
          },
        ).pipe(
          Effect.flatMap((result) =>
            result._tag === "Skipped"
              ? Effect.succeed(null)
              : PubSub.publish(changes, result.publicState).pipe(Effect.as(result.value)),
          ),
        ),
      );

    const isGenerationCurrent = (
      state: SupervisorInternalState,
      generation: HostEndpointControlGeneration,
    ): boolean =>
      !state.closed && state.current === generation && state.publicState._tag === "Ready";

    const ensureGenerationCurrent = (generation: HostEndpointControlGeneration) =>
      SynchronizedRef.get(stateRef).pipe(
        Effect.flatMap((state) =>
          isGenerationCurrent(state, generation)
            ? Effect.void
            : Effect.fail(
                new HostEndpointControlBorrowInvalidatedError({
                  generationId: generation.id,
                  hostGenerationId: generation.client.generationId,
                }),
              ),
        ),
      );

    const currentGeneration = SynchronizedRef.get(stateRef).pipe(
      Effect.flatMap((state) =>
        state.current !== null && isGenerationCurrent(state, state.current)
          ? Effect.succeed(state.current)
          : Effect.fail(new HostEndpointControlUnavailableError()),
      ),
    );

    const borrow: HostEndpointControlSupervisor["borrow"] = currentGeneration.pipe(
      Effect.map((generation) => {
        const ensureCurrent = ensureGenerationCurrent(generation);
        return {
          generationId: generation.id,
          hostGenerationId: generation.client.generationId,
          client: generation.client,
          handshake: generation.client.handshake,
          capabilities: generation.client.handshake.capabilities,
          ensureCurrent,
          request: (operation, payload) =>
            ensureCurrent.pipe(
              Effect.andThen(requestHostEndpoint(generation.client, operation, payload)),
            ),
        } satisfies HostEndpointControlBorrow;
      }),
      Effect.withSpan("HostEndpointControlSupervisor.borrow"),
    );

    const acquireGeneration = Effect.fn("HostEndpointControlSupervisor.acquireGeneration")(
      function* () {
        const generationScope = yield* Scope.make("sequential");
        const acquire = Effect.gen(function* () {
          const client = yield* dependencies.connect({
            transport: options.transport,
            clientInfo: options.clientInfo,
          });
          yield* Scope.addFinalizer(generationScope, client.close.pipe(Effect.ignore));
          return {
            id: nextGenerationId++,
            scope: generationScope,
            client,
          } satisfies HostEndpointControlGeneration;
        }).pipe(Effect.provideService(Scope.Scope, generationScope));
        return yield* acquire.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(generationScope, Exit.void) : Effect.void,
          ),
        );
      },
    );

    const run = Effect.fn("HostEndpointControlSupervisor.run")(function* () {
      let acquisitionAttempt = 1;
      let retryIndex = 0;

      const waitBeforeRetry = Effect.fn("HostEndpointControlSupervisor.waitBeforeRetry")(function* (
        error: HostEndpointControlConnectError,
      ) {
        const retryAttempt = Math.min(Number.MAX_SAFE_INTEGER, acquisitionAttempt + 1);
        const delay = yield* dependencies.retryDelay(retryIndex);
        const updated = yield* publishTransition((state) =>
          state.closed || state.publicState._tag !== "Retrying" || state.publicState.error !== error
            ? null
            : [
                true,
                {
                  ...state,
                  publicState: {
                    _tag: "Retrying",
                    attempt: retryAttempt,
                    error,
                    delay,
                  },
                },
              ],
        );
        if (updated === null) return false;
        yield* dependencies.sleep(delay);
        acquisitionAttempt = retryAttempt;
        retryIndex = Math.min(30, retryIndex + 1);
        const connecting = yield* publishTransition((state) =>
          state.closed
            ? null
            : [
                true,
                {
                  ...state,
                  publicState: { _tag: "Connecting", attempt: acquisitionAttempt },
                },
              ],
        );
        return connecting !== null;
      });

      while (true) {
        const acquired = yield* acquireGeneration().pipe(Effect.result);
        if (acquired._tag === "Failure") {
          const error = acquired.failure;
          const disposition = classifyHostEndpointControlError(error);
          if (disposition !== "transient") {
            yield* publishTransition((state) =>
              state.closed
                ? null
                : [
                    true,
                    {
                      ...state,
                      current: null,
                      publicState: { _tag: "Blocked", reason: disposition, error },
                    },
                  ],
            );
            return;
          }
          yield* publishTransition((state) =>
            state.closed
              ? null
              : [
                  true,
                  {
                    ...state,
                    current: null,
                    publicState: {
                      _tag: "Retrying",
                      attempt: Math.min(Number.MAX_SAFE_INTEGER, acquisitionAttempt + 1),
                      error,
                      delay: null,
                    },
                  },
                ],
          );
          if (!(yield* waitBeforeRetry(error))) return;
          continue;
        }

        const generation = acquired.success;
        const installed = yield* publishTransition((state) =>
          state.closed
            ? null
            : [
                true,
                {
                  ...state,
                  current: generation,
                  publicState: {
                    _tag: "Ready",
                    generationId: generation.id,
                    hostGenerationId: generation.client.generationId,
                    handshake: generation.client.handshake,
                    capabilities: generation.client.handshake.capabilities,
                  },
                },
              ],
        );
        if (installed === null) {
          yield* closeGeneration(generation);
          return;
        }

        acquisitionAttempt = 1;
        retryIndex = 0;
        const termination = yield* generation.client.awaitTermination.pipe(Effect.flip);
        const invalidated = yield* publishTransition((state) =>
          state.closed || state.current !== generation
            ? null
            : [
                true,
                {
                  ...state,
                  current: null,
                  publicState: {
                    _tag: "Retrying",
                    attempt: 2,
                    error: termination,
                    delay: null,
                  },
                },
              ],
        );
        if (invalidated === null) return;
        yield* closeGeneration(generation);
        if (!(yield* waitBeforeRetry(termination))) return;
      }
    });

    const start: HostEndpointControlSupervisor["start"] = SynchronizedRef.modify(
      stateRef,
      (state) =>
        state.closed || state.started
          ? ([false, state] as const)
          : ([true, { ...state, started: true }] as const),
    ).pipe(
      Effect.flatMap((shouldStart) =>
        shouldStart
          ? run().pipe(Effect.forkIn(parentScope, { startImmediately: false }), Effect.asVoid)
          : Effect.void,
      ),
      Effect.withSpan("HostEndpointControlSupervisor.start"),
    );

    yield* Scope.addFinalizer(
      parentScope,
      Effect.gen(function* () {
        const generation = yield* publishTransition((state) =>
          state.closed
            ? null
            : [
                state.current,
                {
                  ...state,
                  closed: true,
                  current: null,
                  publicState: { _tag: "Closed" },
                },
              ],
        );
        if (generation !== null) yield* closeGeneration(generation);
        yield* PubSub.shutdown(changes);
      }),
    );

    return {
      start,
      borrow,
      borrowClient: currentGeneration.pipe(Effect.map((generation) => generation.client)),
      getState: SynchronizedRef.get(stateRef).pipe(Effect.map((state) => state.publicState)),
      getCapabilities: SynchronizedRef.get(stateRef).pipe(
        Effect.map((state) =>
          state.current !== null && isGenerationCurrent(state, state.current)
            ? state.current.client.handshake.capabilities
            : null,
        ),
      ),
      subscribeChanges: PubSub.subscribe(changes),
    } satisfies HostEndpointControlSupervisor;
  },
);
