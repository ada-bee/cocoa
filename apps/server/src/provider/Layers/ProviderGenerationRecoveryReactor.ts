/**
 * Watches generation-aware provider instances and resumes durable sessions on
 * each newly-ready connection generation. Recovery is deliberately limited to
 * persisted session state: it never sends a turn or replays user input.
 *
 * @module provider/Layers/ProviderGenerationRecoveryReactor
 */
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import {
  type ProviderInstance,
  type ProviderInstanceGenerationLifecycle,
  type ProviderInstanceGenerationState,
} from "../ProviderDriver.ts";
import {
  ProviderGenerationRecoveryReactor,
  type ProviderGenerationRecoveryReactorShape,
} from "../Services/ProviderGenerationRecoveryReactor.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderCommandReactor } from "../../orchestration/Services/ProviderCommandReactor.ts";
import { PostTurnCheckpointReactor } from "../../orchestration/Services/PostTurnCheckpointReactor.ts";
import { CheckpointRevertReactor } from "../../orchestration/Services/CheckpointRevertReactor.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

const RECOVERY_CONCURRENCY = 4;
const SESSION_RECOVERY_TIMEOUT = Duration.seconds(30);

interface ActiveLifecycle {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
}

function isRecoverableStatus(status: string | undefined): boolean {
  return status === "starting" || status === "running";
}

function isExactReadyGeneration(
  state: ProviderInstanceGenerationState,
  providerInstanceId: ProviderInstanceId,
  generationId: number,
): boolean {
  return (
    state._tag === "Ready" &&
    state.providerInstanceId === providerInstanceId &&
    state.generationId === generationId
  );
}

export const makeProviderGenerationRecoveryReactor = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const directory = yield* ProviderSessionDirectory;
  const providerService = yield* ProviderService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const postTurnCheckpointReactor = yield* PostTurnCheckpointReactor;
  const checkpointRevertReactor = yield* CheckpointRevertReactor;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const startedRef = yield* Ref.make(false);

  const recoverGeneration = Effect.fn("ProviderGenerationRecoveryReactor.recoverGeneration")(
    function* (
      instance: ProviderInstance,
      lifecycle: ProviderInstanceGenerationLifecycle,
      generationId: number,
    ) {
      const bindings = yield* directory.listBindings().pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to list provider sessions for generation recovery", {
            providerInstanceId: instance.instanceId,
            generationId,
            error,
          }).pipe(Effect.as([])),
        ),
      );
      const projectedStartingThreadIds = yield* projectionSnapshotQuery.getCommandReadModel().pipe(
        Effect.map(
          (model) =>
            new Set(
              model.threads
                .filter((thread) => thread.session?.status === "starting")
                .map((thread) => thread.id),
            ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Failed to read projected sessions for generation recovery", {
            providerInstanceId: instance.instanceId,
            generationId,
            error,
          }).pipe(Effect.as(new Set<ThreadId>())),
        ),
      );
      const recoverable = bindings.filter(
        (binding) =>
          binding.providerInstanceId === instance.instanceId &&
          (isRecoverableStatus(binding.status) ||
            projectedStartingThreadIds.has(binding.threadId)) &&
          binding.resumeCursor !== null &&
          binding.resumeCursor !== undefined,
      );

      yield* Effect.forEach(
        recoverable,
        (binding) =>
          lifecycle.getCurrent.pipe(
            Effect.flatMap((current) =>
              isExactReadyGeneration(current, instance.instanceId, generationId)
                ? providerService
                    .recoverSession({
                      threadId: binding.threadId,
                      providerInstanceId: instance.instanceId,
                    })
                    .pipe(
                      Effect.catch((error) =>
                        Effect.logWarning(
                          "Failed to recover provider session on ready generation",
                          {
                            providerInstanceId: instance.instanceId,
                            generationId,
                            threadId: binding.threadId,
                            error,
                          },
                        ),
                      ),
                      Effect.asVoid,
                    )
                : Effect.void,
            ),
          ),
        { concurrency: RECOVERY_CONCURRENCY, discard: true },
      ).pipe(
        Effect.timeoutOption(SESSION_RECOVERY_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.logWarning(
                "Provider session recovery batch timed out; continuing durable turn reconciliation",
                {
                  providerInstanceId: instance.instanceId,
                  generationId,
                  recoverableSessionCount: recoverable.length,
                  timeoutMs: Duration.toMillis(SESSION_RECOVERY_TIMEOUT),
                },
              ),
            onSome: () => Effect.void,
          }),
        ),
      );
      const current = yield* lifecycle.getCurrent;
      if (isExactReadyGeneration(current, instance.instanceId, generationId)) {
        yield* providerCommandReactor.recover(instance.instanceId);
      }
      const afterCommandRecovery = yield* lifecycle.getCurrent;
      if (isExactReadyGeneration(afterCommandRecovery, instance.instanceId, generationId)) {
        yield* postTurnCheckpointReactor.recover(instance.instanceId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to recover post-turn checkpoints on ready generation", {
              providerInstanceId: instance.instanceId,
              generationId,
              code: error.code,
            }),
          ),
          Effect.asVoid,
        );
      }
      const afterCheckpointRecovery = yield* lifecycle.getCurrent;
      if (isExactReadyGeneration(afterCheckpointRecovery, instance.instanceId, generationId)) {
        yield* checkpointRevertReactor.recover().pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to recover checkpoint reverts on ready generation", {
              providerInstanceId: instance.instanceId,
              generationId,
              code: error.code,
            }),
          ),
          Effect.asVoid,
        );
      }
    },
  );

  const attachLifecycle = Effect.fn("ProviderGenerationRecoveryReactor.attachLifecycle")(function* (
    instance: ProviderInstance,
    parentScope: Scope.Scope,
  ) {
    const lifecycle = instance.generationLifecycle;
    if (!lifecycle) return null;

    const childScope = yield* Scope.fork(parentScope, "sequential");
    const subscription = yield* lifecycle.subscribeChanges.pipe(
      Effect.provideService(Scope.Scope, childScope),
    );
    const initial = yield* lifecycle.getCurrent;
    let lastHandledGenerationId: number | undefined;

    const handleState = Effect.fn("ProviderGenerationRecoveryReactor.handleState")(function* (
      state: ProviderInstanceGenerationState,
    ) {
      if (state._tag === "Unavailable" && state.providerInstanceId === instance.instanceId) {
        yield* providerCommandReactor.abandonPendingInteractions(instance.instanceId);
        return;
      }
      if (
        state._tag !== "Ready" ||
        state.providerInstanceId !== instance.instanceId ||
        state.generationId === lastHandledGenerationId
      ) {
        return;
      }
      lastHandledGenerationId = state.generationId;
      yield* recoverGeneration(instance, lifecycle, state.generationId).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Provider generation recovery failed", {
                providerInstanceId: instance.instanceId,
                generationId: state.generationId,
                cause,
              }),
        ),
      );
    });

    const consume = handleState(initial).pipe(
      Effect.andThen(
        Effect.forever(
          PubSub.take(subscription).pipe(Effect.flatMap((state) => handleState(state))),
        ),
      ),
    );
    yield* Effect.forkIn(consume, childScope, { startImmediately: true });
    return { instance, scope: childScope } satisfies ActiveLifecycle;
  });

  const start: ProviderGenerationRecoveryReactorShape["start"] = Effect.fn(
    "ProviderGenerationRecoveryReactor.start",
  )(() =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const alreadyStarted = yield* Ref.getAndSet(startedRef, true);
        if (alreadyStarted) return;

        const acquire = Effect.gen(function* () {
          const parentScope = yield* Effect.scope;
          const registryChanges = yield* registry.subscribeChanges;
          const active = new Map<ProviderInstanceId, ActiveLifecycle>();

          const reconcile = Effect.fn("ProviderGenerationRecoveryReactor.reconcile")(function* () {
            const instances = yield* registry.listInstances;
            const nextById = new Map(instances.map((instance) => [instance.instanceId, instance]));

            for (const [instanceId, current] of active) {
              const next = nextById.get(instanceId);
              if (next !== current.instance || next.generationLifecycle === undefined) {
                active.delete(instanceId);
                yield* Scope.close(current.scope, Exit.void).pipe(Effect.ignore);
              }
            }

            for (const instance of instances) {
              if (
                !instance.generationLifecycle ||
                active.get(instance.instanceId)?.instance === instance
              ) {
                continue;
              }
              const attached = yield* attachLifecycle(instance, parentScope);
              if (attached) active.set(instance.instanceId, attached);
            }
          });

          yield* reconcile();
          yield* Effect.forever(
            PubSub.take(registryChanges).pipe(Effect.andThen(reconcile())),
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("Provider generation recovery registry consumer failed", {
                    cause,
                  }),
            ),
            Effect.forkIn(parentScope, { startImmediately: true }),
          );
        });

        yield* restore(acquire).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Ref.set(startedRef, false) : Effect.void,
          ),
        );
      }),
    ),
  );

  return { start } satisfies ProviderGenerationRecoveryReactorShape;
});

export const ProviderGenerationRecoveryReactorLive = Layer.effect(
  ProviderGenerationRecoveryReactor,
  makeProviderGenerationRecoveryReactor,
);
