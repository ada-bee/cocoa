import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { CheckpointRevertIntentRepositoryLive } from "../../persistence/Layers/CheckpointRevertIntents.ts";
import { CheckpointRevertSagaRepositoryLive } from "../../persistence/Layers/CheckpointRevertSagas.ts";
import {
  CheckpointRevertIntentRepository,
  type CheckpointRevertIntent,
} from "../../persistence/Services/CheckpointRevertIntents.ts";
import {
  CheckpointRevertSagaRepository,
  type CheckpointRevertSaga,
} from "../../persistence/Services/CheckpointRevertSagas.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandBusyError,
  OrchestrationCommandBlockedByRevertError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  resolveRuntimeBufferLimits,
  RuntimeBufferLimitsService,
  type RuntimeBufferLimitOverrides,
} from "../../RuntimeBufferLimits.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

function isAllowedRevertSagaCommand(
  command: OrchestrationCommand,
  intent: CheckpointRevertIntent,
  saga: CheckpointRevertSaga | undefined,
): boolean {
  if (
    command.type === "thread.revert.complete" &&
    intent.sagaId !== null &&
    saga !== undefined &&
    saga.sagaId === intent.sagaId &&
    saga.threadId === intent.threadId &&
    saga.sourceRevertEventId === intent.sourceEventId &&
    saga.state === "restored" &&
    saga.finalizationStartedAt !== null &&
    command.commandId === `server:checkpoint-revert:${intent.sagaId}` &&
    command.turnCount === intent.requestedTurnCount &&
    command.createdAt === saga.finalizationStartedAt
  ) {
    return true;
  }
  if (
    command.type !== "thread.activity.append" ||
    command.activity.tone !== "error" ||
    command.activity.turnId !== null ||
    command.activity.createdAt !== intent.requestedAt ||
    command.createdAt !== intent.requestedAt
  ) {
    return false;
  }
  const outcome =
    command.activity.kind === "checkpoint.revert.failed"
      ? "failed"
      : command.activity.kind === "checkpoint.revert.indeterminate"
        ? "indeterminate"
        : null;
  if (outcome === null) return false;
  const deterministicId =
    `server:checkpoint-revert-terminal:${intent.sourceEventId}:${outcome}` as const;
  const expectedSummary =
    outcome === "failed" ? "Checkpoint revert failed" : "Checkpoint revert needs attention";
  const payload = command.activity.payload;
  return (
    command.commandId === deterministicId &&
    command.activity.id === deterministicId &&
    command.activity.summary === expectedSummary &&
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 2 &&
    "turnCount" in payload &&
    payload.turnCount === intent.requestedTurnCount &&
    "outcome" in payload &&
    payload.outcome === outcome
  );
}

function toRevertIntentLookupError(error: unknown): ProjectionRepositoryError {
  return isPersistenceSqlError(error) || isPersistenceDecodeError(error)
    ? error
    : toPersistenceSqlError("OrchestrationEngine.getActiveCheckpointRevertIntent")(error);
}

export interface OrchestrationEngineLiveOptions {
  readonly bufferLimits?: RuntimeBufferLimitOverrides;
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointRevertIntents = yield* CheckpointRevertIntentRepository;
  const checkpointRevertSagas = yield* CheckpointRevertSagaRepository;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const bufferLimits = yield* RuntimeBufferLimitsService;
  // This dropping queue is an admission gate, not a lossy work queue. A false
  // offer is surfaced as OrchestrationCommandBusyError before acceptance.
  const commandQueue = yield* Queue.dropping<CommandEnvelope>(bufferLimits.orchestrationCommands);
  // Committed events are durable. Internal consumers receive every live event;
  // a slow consumer applies bounded backpressure and replay-capable clients can
  // reconnect from their last persisted sequence.
  const eventPubSub = yield* PubSub.bounded<OrchestrationEvent>(bufferLimits.orchestrationEvents);

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const assertThreadAvailable = Effect.fn("OrchestrationEngine.assertThreadAvailable")(
          function* (threadId: ThreadId) {
            const intent = yield* checkpointRevertIntents
              .getActiveByThread({ threadId })
              .pipe(Effect.mapError(toRevertIntentLookupError));
            if (Option.isNone(intent)) return;
            const saga =
              intent.value.sagaId === null
                ? undefined
                : Option.getOrUndefined(
                    yield* checkpointRevertSagas
                      .getBySagaId({ sagaId: intent.value.sagaId })
                      .pipe(Effect.mapError(toRevertIntentLookupError)),
                  );
            if (isAllowedRevertSagaCommand(envelope.command, intent.value, saga)) return;
            return yield* new OrchestrationCommandBlockedByRevertError({
              commandId: envelope.command.commandId,
              threadId,
              retryable: true,
            });
          },
        );

        if (
          envelope.command.type === "project.meta.update" ||
          envelope.command.type === "project.delete"
        ) {
          for (const thread of commandReadModel.threads) {
            if (thread.projectId === envelope.command.projectId) {
              yield* assertThreadAvailable(thread.id);
            }
          }
        } else if (envelope.command.type !== "project.create") {
          yield* assertThreadAvailable(envelope.command.threadId);
        }

        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandInvariantError(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      const accepted = yield* Queue.offer(commandQueue, {
        command,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      if (!accepted) {
        return yield* new OrchestrationCommandBusyError({
          commandId: command.commandId,
          retryable: true,
        });
      }
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine.pipe(
    Effect.provideService(RuntimeBufferLimitsService, resolveRuntimeBufferLimits(undefined)),
  ),
).pipe(
  Layer.provide(
    Layer.mergeAll(CheckpointRevertIntentRepositoryLive, CheckpointRevertSagaRepositoryLive),
  ),
);

export function makeOrchestrationEngineLive(options?: OrchestrationEngineLiveOptions) {
  return Layer.effect(
    OrchestrationEngineService,
    makeOrchestrationEngine.pipe(
      Effect.provideService(
        RuntimeBufferLimitsService,
        resolveRuntimeBufferLimits(options?.bufferLimits),
      ),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(CheckpointRevertIntentRepositoryLive, CheckpointRevertSagaRepositoryLive),
    ),
  );
}
