import { ProviderInstanceId, type CodexEndpointTransport, type ThreadId } from "@t3tools/contracts";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as FileSystem from "effect/FileSystem";

import { CodexSessionRuntimeEndpointUnavailableError } from "../Layers/CodexSessionRuntime.ts";
import * as CodexEndpointFactory from "./CodexEndpointFactory.ts";
import type { CodexEndpointConnection } from "./CodexEndpointConnection.ts";
import { type CodexEndpointRouter, makeCodexEndpointRouter } from "./CodexEndpointRouter.ts";

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRY_JITTER_RATIO = 0.2;

export type CodexEndpointSupervisorErrorDisposition = "permanent" | "transient";

export type CodexEndpointSupervisorState =
  | { readonly _tag: "Connecting"; readonly attempt: number }
  | {
      readonly _tag: "Ready";
      readonly generationId: number;
      readonly compatibility: CodexEndpointConnection["Service"]["compatibility"];
    }
  | {
      readonly _tag: "Retrying";
      readonly attempt: number;
      readonly error: CodexEndpointFactory.CodexEndpointFactoryError;
      readonly delay: Duration.Duration | null;
    }
  | {
      readonly _tag: "Blocked";
      readonly error: CodexEndpointFactory.CodexEndpointFactoryError;
    }
  | { readonly _tag: "Closed" };

interface CodexEndpointGeneration {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly connection: CodexEndpointConnection["Service"];
  readonly router: CodexEndpointRouter;
}

interface SupervisorInternalState {
  readonly publicState: CodexEndpointSupervisorState;
  readonly current: CodexEndpointGeneration | null;
  readonly closed: boolean;
  readonly started: boolean;
}

export interface CodexEndpointGenerationInvalidated {
  readonly generationId: number;
  readonly error: CodexEndpointFactory.CodexEndpointFactoryError;
}

export interface CodexEndpointBorrow {
  readonly generationId: number;
  readonly connection: CodexEndpointConnection["Service"];
  readonly router: CodexEndpointRouter;
  readonly ensureCurrent: Effect.Effect<void, CodexSessionRuntimeEndpointUnavailableError>;
}

export class CodexEndpointBorrowUnavailableError extends Schema.TaggedErrorClass<CodexEndpointBorrowUnavailableError>()(
  "CodexEndpointBorrowUnavailableError",
  { providerInstanceId: ProviderInstanceId },
) {
  override get message(): string {
    return `Codex endpoint provider instance '${this.providerInstanceId}' is unavailable.`;
  }
}

export interface CodexEndpointConnectionBorrow {
  readonly generationId: number;
  readonly connection: CodexEndpointConnection["Service"];
  readonly ensureCurrent: Effect.Effect<void, CodexEndpointBorrowUnavailableError>;
}

export interface CodexEndpointSupervisorDependencies {
  readonly makeEndpoint: typeof CodexEndpointFactory.make;
  readonly makeRouter: typeof makeCodexEndpointRouter;
  readonly retryDelay: (retryIndex: number) => Effect.Effect<Duration.Duration>;
  readonly sleep: (delay: Duration.Duration) => Effect.Effect<void>;
}

export interface MakeCodexEndpointSupervisorOptions {
  readonly providerInstanceId: ProviderInstanceId;
  readonly transport: CodexEndpointTransport;
  readonly dependencies?: Partial<CodexEndpointSupervisorDependencies>;
}

export interface StartCodexEndpointSupervisorOptions<E = never> {
  readonly onGenerationInvalidated: (
    event: CodexEndpointGenerationInvalidated,
  ) => Effect.Effect<void, E>;
}

export interface CodexEndpointSupervisor {
  readonly start: <E>(
    options: StartCodexEndpointSupervisorOptions<E>,
  ) => Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem>;
  readonly borrow: (
    threadId: ThreadId,
  ) => Effect.Effect<CodexEndpointBorrow, CodexSessionRuntimeEndpointUnavailableError>;
  /** Borrow the current connection for provider-scoped work unrelated to a Cocoa session. */
  readonly borrowConnection: Effect.Effect<
    CodexEndpointConnectionBorrow,
    CodexEndpointBorrowUnavailableError
  >;
  readonly getState: Effect.Effect<CodexEndpointSupervisorState>;
  readonly subscribeChanges: Effect.Effect<
    PubSub.Subscription<CodexEndpointSupervisorState>,
    never,
    Scope.Scope
  >;
}

/**
 * Initialization request failures caused by a protocol/schema mismatch cannot
 * recover while this configured supervisor remains unchanged. Server-side
 * internal/overload errors remain retryable. The observed remote version is
 * deliberately not part of this decision.
 */
export function classifyCodexEndpointSupervisorError(
  error: CodexEndpointFactory.CodexEndpointFactoryError,
): CodexEndpointSupervisorErrorDisposition {
  switch (error._tag) {
    case "CodexEndpointUnsupportedAuthenticationError":
    case "CodexEndpointCredentialReadError":
    case "CodexEndpointInvalidCredentialError":
      return "permanent";
    case "CodexEndpointInitializationError":
      return error.cause._tag === "CodexAppServerRequestError" &&
        [-32700, -32600, -32601, -32602].includes(error.cause.code)
        ? "permanent"
        : "transient";
    default:
      return "transient";
  }
}

export function calculateCodexEndpointRetryDelay(
  retryIndex: number,
  randomValue: number,
): Duration.Duration {
  const boundedIndex = Math.max(0, Math.min(30, Math.floor(retryIndex)));
  const exponential = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** boundedIndex);
  const random = Math.max(0, Math.min(1, randomValue));
  const jittered = exponential * (1 - RETRY_JITTER_RATIO + random * RETRY_JITTER_RATIO * 2);
  return Duration.millis(Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.round(jittered))));
}

export const defaultCodexEndpointRetryDelay = Effect.fn(
  "CodexEndpointSupervisor.defaultRetryDelay",
)(function* (retryIndex: number) {
  return calculateCodexEndpointRetryDelay(retryIndex, yield* Random.next);
});

const defaultDependencies: CodexEndpointSupervisorDependencies = {
  makeEndpoint: CodexEndpointFactory.make,
  makeRouter: makeCodexEndpointRouter,
  retryDelay: defaultCodexEndpointRetryDelay,
  sleep: (delay) => Effect.sleep(delay),
};

const closeGeneration = (generation: CodexEndpointGeneration) =>
  Scope.close(generation.scope, Exit.void).pipe(Effect.ignore);

export const make = Effect.fn("CodexEndpointSupervisor.make")(function* (
  options: MakeCodexEndpointSupervisorOptions,
): Effect.fn.Return<CodexEndpointSupervisor, never, Scope.Scope> {
  const dependencies: CodexEndpointSupervisorDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  };
  const parentScope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<CodexEndpointSupervisorState>();
  const firstAttemptSettled = yield* Deferred.make<void>();
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
                readonly publicState: CodexEndpointSupervisorState;
              }
          ),
          SupervisorInternalState,
        ] => {
          const result = transition(state);
          if (result === null) {
            return [{ _tag: "Skipped" } as const, state] as const;
          }
          const [value, next] = result;
          return [
            { _tag: "Applied", value, publicState: next.publicState } as const,
            next,
          ] as const;
        },
      ).pipe(
        Effect.flatMap((result) =>
          result._tag === "Skipped"
            ? Effect.succeed(null)
            : PubSub.publish(changes, result.publicState).pipe(Effect.as(result.value)),
        ),
      ),
    );

  const sessionUnavailable = (threadId: ThreadId) =>
    new CodexSessionRuntimeEndpointUnavailableError({
      threadId,
      providerInstanceId: options.providerInstanceId,
    });

  const connectionUnavailable = () =>
    new CodexEndpointBorrowUnavailableError({
      providerInstanceId: options.providerInstanceId,
    });

  const isGenerationCurrent = (
    state: SupervisorInternalState,
    generation: CodexEndpointGeneration,
  ): boolean => !state.closed && state.current === generation && state.publicState._tag === "Ready";

  const ensureGenerationCurrent = <E>(generation: CodexEndpointGeneration, unavailable: () => E) =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.flatMap((state) =>
        isGenerationCurrent(state, generation) ? Effect.void : Effect.fail(unavailable()),
      ),
    );

  const currentGeneration = <E>(unavailable: () => E): Effect.Effect<CodexEndpointGeneration, E> =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.flatMap((state) =>
        state.current !== null && isGenerationCurrent(state, state.current)
          ? Effect.succeed(state.current)
          : Effect.fail(unavailable()),
      ),
    );

  const borrow: CodexEndpointSupervisor["borrow"] = Effect.fn("CodexEndpointSupervisor.borrow")(
    function* (threadId) {
      const unavailable = () => sessionUnavailable(threadId);
      const generation = yield* currentGeneration(unavailable);
      return {
        generationId: generation.id,
        connection: generation.connection,
        router: generation.router,
        ensureCurrent: ensureGenerationCurrent(generation, unavailable),
      } satisfies CodexEndpointBorrow;
    },
  );

  const borrowConnection: CodexEndpointSupervisor["borrowConnection"] = currentGeneration(
    connectionUnavailable,
  ).pipe(
    Effect.map(
      (generation) =>
        ({
          generationId: generation.id,
          connection: generation.connection,
          ensureCurrent: ensureGenerationCurrent(generation, connectionUnavailable),
        }) satisfies CodexEndpointConnectionBorrow,
    ),
    Effect.withSpan("CodexEndpointSupervisor.borrowConnection"),
  );

  const acquireGeneration = Effect.fn("CodexEndpointSupervisor.acquireGeneration")(function* () {
    const generationScope = yield* Scope.make("sequential");
    const acquire = Effect.gen(function* () {
      const connection = yield* dependencies.makeEndpoint({
        providerInstanceId: options.providerInstanceId,
        transport: options.transport,
      });
      const router = yield* dependencies.makeRouter(connection.client);
      return {
        id: nextGenerationId++,
        scope: generationScope,
        connection,
        router,
      } satisfies CodexEndpointGeneration;
    }).pipe(Effect.provideService(Scope.Scope, generationScope));

    return yield* acquire.pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Scope.close(generationScope, Exit.void) : Effect.void,
      ),
    );
  });

  const settleFirstAttempt = Deferred.succeed(firstAttemptSettled, undefined).pipe(Effect.asVoid);

  const run = Effect.fn("CodexEndpointSupervisor.run")(function* <E>(
    startOptions: StartCodexEndpointSupervisorOptions<E>,
  ) {
    let acquisitionAttempt = 1;
    let retryIndex = 0;

    const waitBeforeRetry = Effect.fn("CodexEndpointSupervisor.waitBeforeRetry")(function* (
      error: CodexEndpointFactory.CodexEndpointFactoryError,
    ) {
      const retryAttempt = acquisitionAttempt + 1;
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
      retryIndex += 1;
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
        if (classifyCodexEndpointSupervisorError(error) === "permanent") {
          yield* publishTransition((state) =>
            state.closed
              ? null
              : [
                  true,
                  {
                    ...state,
                    current: null,
                    publicState: { _tag: "Blocked", error },
                  },
                ],
          );
          yield* settleFirstAttempt;
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
                    attempt: acquisitionAttempt + 1,
                    error,
                    delay: null,
                  },
                },
              ],
        );
        yield* settleFirstAttempt;
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
                  compatibility: generation.connection.compatibility,
                },
              },
            ],
      );
      yield* settleFirstAttempt;
      if (installed === null) {
        yield* closeGeneration(generation);
        return;
      }

      acquisitionAttempt = 1;
      retryIndex = 0;
      const termination = yield* generation.connection.awaitTermination.pipe(Effect.flip);
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

      yield* startOptions
        .onGenerationInvalidated({ generationId: generation.id, error: termination })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("Codex endpoint generation invalidation callback failed", {
                  providerInstanceId: options.providerInstanceId,
                  generationId: generation.id,
                  cause,
                }),
          ),
          Effect.ensuring(closeGeneration(generation)),
        );
      if (!(yield* waitBeforeRetry(termination))) return;
    }
  });

  const start: CodexEndpointSupervisor["start"] = Effect.fn("CodexEndpointSupervisor.start")(
    function* (startOptions) {
      const shouldStart = yield* SynchronizedRef.modify(stateRef, (state) =>
        state.closed || state.started
          ? ([false, state] as const)
          : ([true, { ...state, started: true }] as const),
      );
      if (shouldStart) {
        yield* run(startOptions).pipe(Effect.forkIn(parentScope));
      }
      yield* Deferred.await(firstAttemptSettled);
    },
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
      if (generation !== null) {
        yield* closeGeneration(generation);
      }
      yield* settleFirstAttempt;
      yield* PubSub.shutdown(changes);
    }),
  );

  return {
    start,
    borrow,
    borrowConnection,
    getState: SynchronizedRef.get(stateRef).pipe(Effect.map((state) => state.publicState)),
    subscribeChanges: PubSub.subscribe(changes),
  } satisfies CodexEndpointSupervisor;
});
