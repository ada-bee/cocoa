/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  type ProviderServiceError,
  ProviderCheckedRollbackUnsupportedError,
  ProviderRollbackActiveTurnError,
  ProviderRollbackOutcomeUnknownError,
  ProviderRollbackPreimageMismatchError,
  ProviderValidationError,
} from "../Errors.ts";
import {
  providerCheckedConversationRollbackMode,
  providerConversationReadMode,
  type ProviderAdapterShape,
  type ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  resolveRuntimeBufferLimits,
  type RuntimeBufferLimitOverrides,
} from "../../RuntimeBufferLimits.ts";
import {
  digestProviderTurnSequence,
  hashProviderContinuationIdentity,
  PROVIDER_TURN_SEQUENCE_DIGEST_VERSION,
  type ProviderTurnSequenceDigest,
} from "../ProviderTurnSequenceDigest.ts";
const isModelSelection = Schema.is(ModelSelection);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
  /** Internal test seams; production uses the active MCP registry functions. */
  readonly issueMcpCredential?: typeof McpSessionRegistry.issueActiveMcpCredential;
  readonly revokeMcpThread?: typeof McpSessionRegistry.revokeActiveMcpThread;
  readonly bufferLimits?: RuntimeBufferLimitOverrides;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

const ProviderTurnSequenceDigestInput = Schema.Struct({
  version: Schema.Literal(PROVIDER_TURN_SEQUENCE_DIGEST_VERSION),
  turnCount: NonNegativeInt,
  sha256: Schema.String.check(
    Schema.isMinLength(64),
    Schema.isMaxLength(64),
    Schema.makeFilter((value) => /^[0-9a-f]{64}$/.test(value) || "sha256 must be lowercase hex."),
  ),
});

const ProviderInspectConversationInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  targetTurnCount: NonNegativeInt,
});

const ProviderReadAuthoritativeConversationInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
});

const MAX_AUTHORITATIVE_TURNS = 10_000;
const MAX_AUTHORITATIVE_ITEMS = 50_000;
const MAX_AUTHORITATIVE_FINAL_ASSISTANT_BYTES = 24_000;
const MAX_AUTHORITATIVE_TOTAL_ASSISTANT_BYTES = 1_048_576;

const ProviderRollbackConversationCheckedInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  numTurns: NonNegativeInt,
  expectedPreimage: ProviderTurnSequenceDigestInput,
  expectedTarget: ProviderTurnSequenceDigestInput,
  expectedDriverKind: ProviderDriverKind,
  expectedContinuationIdentitySha256: Schema.String.check(
    Schema.isMinLength(64),
    Schema.isMaxLength(64),
    Schema.makeFilter((value) => /^[0-9a-f]{64}$/.test(value) || "sha256 must be lowercase hex."),
  ),
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const serviceScope = yield* Effect.scope;
  const bufferLimits = resolveRuntimeBufferLimits(options?.bufferLimits);
  const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
    bufferLimits.providerRuntimeEvents,
  );
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const issueMcpCredential =
    options?.issueMcpCredential ?? McpSessionRegistry.issueActiveMcpCredential;
  const revokeMcpThread = options?.revokeMcpThread ?? McpSessionRegistry.revokeActiveMcpThread;
  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    issueMcpCredential({ threadId, providerInstanceId }).pipe(
      Effect.tap((credential) =>
        credential
          ? Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config))
          : Effect.void,
      ),
    );
  const clearMcpSession = (threadId: ThreadId) =>
    revokeMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );
  const clearUnavailableMcpSession = (
    threadId: ThreadId,
    instanceInfo: ProviderAdapterRegistry.ProviderInstanceRoutingInfo,
  ) =>
    instanceInfo.gatewayMcpMode === "unavailable"
      ? clearMcpSession(threadId).pipe(
          Effect.tap(() =>
            Effect.logWarning(
              "Cocoa gateway MCP injection is unavailable for this provider instance; starting without gateway MCP tools",
              {
                providerInstanceId: instanceInfo.instanceId,
                threadId,
              },
            ),
          ),
        )
      : Effect.void;

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(Effect.andThen(publishRuntimeEvent(canonicalEvent))),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  interface RecoveredSession {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly instanceId: ProviderInstanceId;
    readonly session: ProviderSession;
  }

  type RecoveryDeferred = Deferred.Deferred<RecoveredSession, ProviderServiceError>;

  interface RecoveryFlightSelection {
    readonly deferred: RecoveryDeferred;
    readonly owner: boolean;
  }

  const recoveryFlights = yield* Ref.make(new Map<ThreadId, RecoveryDeferred>());

  const threadMutationLocks = yield* SynchronizedRef.make(
    new Map<ThreadId, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>(),
  );
  const withThreadMutationLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      SynchronizedRef.modifyEffect(threadMutationLocks, (locks) => {
        const existing = locks.get(threadId);
        if (existing) {
          const next = new Map(locks);
          next.set(threadId, { semaphore: existing.semaphore, users: existing.users + 1 });
          return Effect.succeed([existing.semaphore, next] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(locks);
            next.set(threadId, { semaphore, users: 1 });
            return [semaphore, next] as const;
          }),
        );
      }),
      (semaphore) => semaphore.withPermits(1)(effect),
      (semaphore) =>
        SynchronizedRef.update(threadMutationLocks, (locks) => {
          const current = locks.get(threadId);
          if (!current || current.semaphore !== semaphore) return locks;
          const next = new Map(locks);
          if (current.users === 1) next.delete(threadId);
          else next.set(threadId, { semaphore, users: current.users - 1 });
          return next;
        }),
    );

  const recoverSessionFromBinding = Effect.fn("recoverSessionFromBinding")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly bindingInstanceId: ProviderInstanceId;
  }): Effect.fn.Return<RecoveredSession, ProviderServiceError> {
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": input.bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const instanceInfo = yield* registry.getInstanceInfo(input.bindingInstanceId);
      yield* clearUnavailableMcpSession(input.binding.threadId, instanceInfo);
      const adapter = yield* registry.getByInstance(input.bindingInstanceId);
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          if (existing.provider !== adapter.provider) {
            return yield* toValidationError(
              "ProviderService.recoverSession",
              `Adapter/provider mismatch while adopting thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${existing.provider}'.`,
            );
          }
          if (
            existing.providerInstanceId !== undefined &&
            existing.providerInstanceId !== input.bindingInstanceId
          ) {
            return yield* toValidationError(
              "ProviderService.recoverSession",
              `Active thread '${input.binding.threadId}' belongs to provider instance '${existing.providerInstanceId}', not '${input.bindingInstanceId}'.`,
            );
          }
          const adopted = {
            ...existing,
            providerInstanceId: input.bindingInstanceId,
            ...(existing.resumeCursor === undefined
              ? { resumeCursor: input.binding.resumeCursor }
              : {}),
          };
          yield* upsertSessionBinding(adopted, input.binding.threadId);
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: adopted.resumeCursor !== undefined,
          });
          return {
            adapter,
            instanceId: input.bindingInstanceId,
            session: adopted,
          } as const;
        }
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      if (instanceInfo.gatewayMcpMode !== "unavailable") {
        yield* prepareMcpSession(input.binding.threadId, input.bindingInstanceId);
      }
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: input.bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          resumeCursor: input.binding.resumeCursor,
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(Effect.onError(() => clearMcpSession(input.binding.threadId)));
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          "ProviderService.recoverSession",
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: input.bindingInstanceId },
        input.binding.threadId,
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return {
        adapter,
        instanceId: input.bindingInstanceId,
        session: { ...resumed, providerInstanceId: input.bindingInstanceId },
      } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const runRecoverySingleFlight = Effect.fn("runRecoverySingleFlight")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly bindingInstanceId: ProviderInstanceId;
  }): Effect.fn.Return<RecoveredSession, ProviderServiceError> {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<RecoveredSession, ProviderServiceError>();
        const selected: RecoveryFlightSelection = yield* Ref.modify(
          recoveryFlights,
          (current): readonly [RecoveryFlightSelection, Map<ThreadId, RecoveryDeferred>] => {
            const existing = current.get(input.binding.threadId);
            if (existing) return [{ deferred: existing, owner: false }, current];
            const next = new Map(current);
            next.set(input.binding.threadId, candidate);
            return [{ deferred: candidate, owner: true }, next];
          },
        );

        if (selected.owner) {
          const worker = Effect.uninterruptibleMask((restoreWorker) =>
            Effect.gen(function* () {
              const result = yield* Effect.exit(restoreWorker(recoverSessionFromBinding(input)));
              yield* Deferred.done(selected.deferred, result);
              yield* Ref.update(recoveryFlights, (current) => {
                if (current.get(input.binding.threadId) !== selected.deferred) return current;
                const next = new Map(current);
                next.delete(input.binding.threadId);
                return next;
              });
            }),
          );
          yield* Effect.forkIn(worker, serviceScope, { startImmediately: true });
        }

        return yield* restore(Deferred.await(selected.deferred));
      }),
    );
  });

  const recoverSession: ProviderServiceMethod<"recoverSession"> = Effect.fn("recoverSession")(
    function* (input) {
      const operation = "ProviderService.recoverSession";
      const bindingOption = yield* directory.getBinding(input.threadId);
      const binding = Option.getOrUndefined(bindingOption);
      if (!binding) {
        return yield* toValidationError(
          operation,
          `Cannot recover thread '${input.threadId}' because no persisted provider binding exists.`,
        );
      }
      const bindingInstanceId = yield* requireBindingInstanceId(operation, binding);
      if (bindingInstanceId !== input.providerInstanceId) {
        return yield* toValidationError(
          operation,
          `Cannot recover thread '${input.threadId}' for provider instance '${input.providerInstanceId}' because it is persisted for '${bindingInstanceId}'.`,
        );
      }
      if (binding.resumeCursor === null || binding.resumeCursor === undefined) {
        return yield* toValidationError(
          operation,
          `Cannot recover thread '${input.threadId}' because no provider resume state is persisted.`,
        );
      }

      const recovered = yield* runRecoverySingleFlight({ binding, bindingInstanceId });
      return recovered.session;
    },
  );

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
    readonly expectedProviderInstanceId?: ProviderInstanceId;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    if (
      input.expectedProviderInstanceId !== undefined &&
      instanceId !== input.expectedProviderInstanceId
    ) {
      return yield* toValidationError(
        input.operation,
        `Thread '${input.threadId}' is bound to provider instance '${instanceId}', not '${input.expectedProviderInstanceId}'.`,
      );
    }
    const instanceInfo = yield* registry.getInstanceInfo(instanceId);
    const adapter = yield* registry.getByInstance(instanceId);
    if (
      binding.provider !== instanceInfo.driverKind ||
      adapter.provider !== instanceInfo.driverKind
    ) {
      return yield* toValidationError(
        input.operation,
        `Provider route mismatch for thread '${input.threadId}': binding '${binding.provider}', instance '${instanceInfo.driverKind}', adapter '${adapter.provider}'.`,
      );
    }

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
        continuationIdentity: instanceInfo.continuationIdentity,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
        continuationIdentity: instanceInfo.continuationIdentity,
      } as const;
    }

    yield* recoverSession({
      threadId: input.threadId,
      providerInstanceId: instanceId,
    });
    const recoveredInstanceInfo = yield* registry.getInstanceInfo(instanceId);
    const recoveredAdapter = yield* registry.getByInstance(instanceId);
    if (
      binding.provider !== recoveredInstanceInfo.driverKind ||
      recoveredAdapter.provider !== recoveredInstanceInfo.driverKind
    ) {
      return yield* toValidationError(
        input.operation,
        `Provider route changed while recovering thread '${input.threadId}'.`,
      );
    }
    return {
      adapter: recoveredAdapter,
      instanceId,
      threadId: input.threadId,
      isActive: true,
      continuationIdentity: recoveredInstanceInfo.continuationIdentity,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        if (instanceInfo.gatewayMcpMode === "unavailable") {
          yield* clearUnavailableMcpSession(threadId, instanceInfo);
        } else {
          yield* prepareMcpSession(threadId, resolvedInstanceId);
        }
        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(Effect.onError(() => clearMcpSession(threadId)));

        if (session.provider !== adapter.provider) {
          yield* clearMcpSession(threadId);
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
        });
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* withThreadMutationLock(
      input.threadId,
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        metricModel = input.modelSelection?.model;
        yield* Effect.annotateCurrentSpan({
          "provider.kind": routed.adapter.provider,
          ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
        });
        // A turn is the clearest sign a session is still alive. The MCP
        // credential is minted once at session start and cannot be rotated into
        // an already-spawned agent process, so we keep the existing token valid
        // rather than issuing a new one: sessions that go a long time between
        // browser tool calls used to lose the toolkit outright.
        yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
        const turn = yield* routed.adapter.sendTurn(input);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "running",
          ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          runtimePayload: {
            ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.sendTurn",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
        yield* analytics.record("provider.turn.sent", {
          provider: routed.adapter.provider,
          model: input.modelSelection?.model,
          interactionMode: input.interactionMode,
          attachmentCount: input.attachments.length,
          hasInput: typeof input.input === "string" && input.input.trim().length > 0,
        });
        return turn;
      }),
    ).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const digestSnapshot = (snapshot: ProviderThreadSnapshot) =>
    digestProviderTurnSequence(snapshot.turns.map((turn) => turn.id)).pipe(
      Effect.mapError((cause) =>
        toValidationError(
          "ProviderService.inspectConversation",
          "Provider returned an invalid ordered turn snapshot.",
          cause,
        ),
      ),
    );

  const sameDigest = (
    left: ProviderTurnSequenceDigest,
    right: ProviderTurnSequenceDigest,
  ): boolean =>
    left.version === right.version &&
    left.turnCount === right.turnCount &&
    left.sha256 === right.sha256;

  const requireCheckedCapabilities = (input: {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly instanceId: ProviderInstanceId;
  }) => {
    if (providerConversationReadMode(input.adapter.capabilities) !== "ordered-turn-ids-v1") {
      return Effect.fail(
        new ProviderCheckedRollbackUnsupportedError({
          provider: input.adapter.provider,
          providerInstanceId: input.instanceId,
          capability: "conversation-read",
        }),
      );
    }
    if (
      providerCheckedConversationRollbackMode(input.adapter.capabilities) !== "ordered-turn-ids-v1"
    ) {
      return Effect.fail(
        new ProviderCheckedRollbackUnsupportedError({
          provider: input.adapter.provider,
          providerInstanceId: input.instanceId,
          capability: "checked-rollback",
        }),
      );
    }
    return Effect.void;
  };

  const inspectConversation: ProviderServiceMethod<"inspectConversation"> = Effect.fn(
    "inspectConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.inspectConversation",
      schema: ProviderInspectConversationInput,
      payload: rawInput,
    });
    return yield* withThreadMutationLock(
      input.threadId,
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.inspectConversation",
          allowRecovery: true,
          expectedProviderInstanceId: input.providerInstanceId,
        });
        yield* requireCheckedCapabilities(routed);
        const snapshot = yield* routed.adapter.readThread(routed.threadId);
        if (snapshot.threadId !== routed.threadId) {
          return yield* toValidationError(
            "ProviderService.inspectConversation",
            `Provider returned snapshot for thread '${snapshot.threadId}', not '${routed.threadId}'.`,
          );
        }
        if (input.targetTurnCount > snapshot.turns.length) {
          return yield* toValidationError(
            "ProviderService.inspectConversation",
            "Target turn count exceeds the provider conversation preimage.",
          );
        }
        const orderedTurnIds = snapshot.turns.map((turn) => turn.id);
        return {
          threadId: routed.threadId,
          providerInstanceId: routed.instanceId,
          binding: {
            driverKind: routed.adapter.provider,
            continuationIdentitySha256: hashProviderContinuationIdentity(
              routed.continuationIdentity,
            ),
          },
          preimage: yield* digestProviderTurnSequence(orderedTurnIds).pipe(
            Effect.mapError((cause) =>
              toValidationError(
                "ProviderService.inspectConversation",
                "Provider returned an invalid ordered turn snapshot.",
                cause,
              ),
            ),
          ),
          target: yield* digestProviderTurnSequence(
            orderedTurnIds.slice(0, input.targetTurnCount),
          ).pipe(
            Effect.mapError((cause) =>
              toValidationError(
                "ProviderService.inspectConversation",
                "Provider returned an invalid ordered turn snapshot.",
                cause,
              ),
            ),
          ),
        };
      }),
    );
  });

  const rollbackConversationChecked: ProviderServiceMethod<"rollbackConversationChecked"> =
    Effect.fn("rollbackConversationChecked")(function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.rollbackConversationChecked",
        schema: ProviderRollbackConversationCheckedInput,
        payload: rawInput,
      });
      if (input.numTurns < 1) {
        return yield* toValidationError(
          "ProviderService.rollbackConversationChecked",
          "numTurns must be an integer >= 1.",
        );
      }
      return yield* withThreadMutationLock(
        input.threadId,
        Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.rollbackConversationChecked",
            allowRecovery: true,
            expectedProviderInstanceId: input.providerInstanceId,
          });
          yield* requireCheckedCapabilities(routed);
          const actualContinuationIdentitySha256 = hashProviderContinuationIdentity(
            routed.continuationIdentity,
          );
          if (
            routed.adapter.provider !== input.expectedDriverKind ||
            actualContinuationIdentitySha256 !== input.expectedContinuationIdentitySha256
          ) {
            return yield* toValidationError(
              "ProviderService.rollbackConversationChecked",
              "Provider continuation binding changed before rollback.",
            );
          }
          const activeSession = (yield* routed.adapter.listSessions()).find(
            (session) => session.threadId === input.threadId,
          );
          if (activeSession?.activeTurnId !== undefined || activeSession?.status === "running") {
            return yield* new ProviderRollbackActiveTurnError({
              providerInstanceId: routed.instanceId,
              threadId: input.threadId,
              ...(activeSession.activeTurnId !== undefined
                ? { turnId: activeSession.activeTurnId }
                : {}),
            });
          }
          const before = yield* routed.adapter.readThread(routed.threadId);
          if (before.threadId !== routed.threadId) {
            return yield* toValidationError(
              "ProviderService.rollbackConversationChecked",
              `Provider returned preimage for thread '${before.threadId}', not '${routed.threadId}'.`,
            );
          }
          const actualPreimage = yield* digestSnapshot(before);
          if (!sameDigest(actualPreimage, input.expectedPreimage)) {
            return yield* new ProviderRollbackPreimageMismatchError({
              providerInstanceId: routed.instanceId,
              threadId: input.threadId,
              expectedSha256: input.expectedPreimage.sha256,
              actualSha256: actualPreimage.sha256,
            });
          }
          if (
            actualPreimage.turnCount < input.numTurns ||
            input.expectedTarget.turnCount !== actualPreimage.turnCount - input.numTurns
          ) {
            return yield* toValidationError(
              "ProviderService.rollbackConversationChecked",
              "Expected target turn count does not match the requested rollback.",
            );
          }

          const returned = yield* routed.adapter
            .rollbackThread(routed.threadId, input.numTurns)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRollbackOutcomeUnknownError({
                    provider: routed.adapter.provider,
                    providerInstanceId: routed.instanceId,
                    threadId: input.threadId,
                    reason: "request-failed",
                    issue: "Rollback request failed after dispatch.",
                    cause,
                  }),
              ),
            );
          const returnedDigest = yield* digestProviderTurnSequence(
            returned.turns.map((turn) => turn.id),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRollbackOutcomeUnknownError({
                  provider: routed.adapter.provider,
                  providerInstanceId: routed.instanceId,
                  threadId: input.threadId,
                  reason: "returned-target-mismatch",
                  issue: "Provider returned an invalid rollback target snapshot.",
                  cause,
                }),
            ),
          );
          if (
            returned.threadId !== routed.threadId ||
            !sameDigest(returnedDigest, input.expectedTarget)
          ) {
            return yield* new ProviderRollbackOutcomeUnknownError({
              provider: routed.adapter.provider,
              providerInstanceId: routed.instanceId,
              threadId: input.threadId,
              reason: "returned-target-mismatch",
              issue: "Provider returned a rollback target that did not match the expected target.",
            });
          }
          return {
            threadId: routed.threadId,
            providerInstanceId: routed.instanceId,
            binding: {
              driverKind: routed.adapter.provider,
              continuationIdentitySha256: actualContinuationIdentitySha256,
            },
            preimage: actualPreimage,
            target: returnedDigest,
          };
        }),
      );
    });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  const readAuthoritativeConversation: ProviderServiceMethod<"readAuthoritativeConversation"> =
    Effect.fn("readAuthoritativeConversation")(function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.readAuthoritativeConversation",
        schema: ProviderReadAuthoritativeConversationInput,
        payload: rawInput,
      });
      return yield* withThreadMutationLock(
        input.threadId,
        Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.readAuthoritativeConversation",
            allowRecovery: false,
            expectedProviderInstanceId: input.providerInstanceId,
          });
          if (routed.adapter.capabilities.conversationReconciliation !== "ordered-turn-state-v1") {
            return yield* toValidationError(
              "ProviderService.readAuthoritativeConversation",
              "The routed provider does not support authoritative conversation reconciliation.",
            );
          }
          const snapshot = yield* routed.adapter.readThread(routed.threadId);
          if (snapshot.threadId !== routed.threadId) {
            return yield* toValidationError(
              "ProviderService.readAuthoritativeConversation",
              "Provider returned a snapshot for a different thread.",
            );
          }
          if (snapshot.turns.length > MAX_AUTHORITATIVE_TURNS) {
            return yield* toValidationError(
              "ProviderService.readAuthoritativeConversation",
              "Provider returned an oversized authoritative turn snapshot.",
            );
          }
          const seen = new Set<string>();
          let itemCount = 0;
          let assistantBytes = 0;
          let runningTurnIndex = -1;
          const turns = yield* Effect.forEach(
            snapshot.turns,
            (turn, index) => {
              const reconciliation = turn.reconciliation;
              itemCount += turn.items.length;
              const assistantMessages = reconciliation?.assistantMessages ?? [];
              const assistantItemIds = new Set<string>();
              for (const message of assistantMessages) {
                assistantBytes += Buffer.byteLength(message.text, "utf8");
                assistantItemIds.add(message.itemId);
              }
              const expectedFinal =
                assistantMessages.findLast((message) => message.phase === "final_answer") ??
                assistantMessages.at(-1);
              if (
                reconciliation === undefined ||
                seen.has(turn.id) ||
                itemCount > MAX_AUTHORITATIVE_ITEMS ||
                assistantBytes > MAX_AUTHORITATIVE_TOTAL_ASSISTANT_BYTES ||
                (reconciliation.status === "running" && reconciliation.completedAt !== null) ||
                (reconciliation.completedAt !== null &&
                  !Number.isFinite(Date.parse(reconciliation.completedAt))) ||
                assistantMessages.length > turn.items.length ||
                assistantItemIds.size !== assistantMessages.length ||
                assistantMessages.some(
                  (message) =>
                    message.itemId.length < 1 ||
                    message.itemId.length > 256 ||
                    (message.phase !== null &&
                      message.phase !== "commentary" &&
                      message.phase !== "final_answer") ||
                    Buffer.byteLength(message.text, "utf8") >
                      MAX_AUTHORITATIVE_FINAL_ASSISTANT_BYTES,
                ) ||
                (reconciliation.finalAssistantText === null) !==
                  (reconciliation.finalAssistantItemId === null) ||
                (expectedFinal?.itemId ?? null) !== reconciliation.finalAssistantItemId ||
                (expectedFinal?.text ?? null) !== reconciliation.finalAssistantText ||
                (reconciliation.finalAssistantItemId !== null &&
                  (reconciliation.finalAssistantItemId.length < 1 ||
                    reconciliation.finalAssistantItemId.length > 256)) ||
                (reconciliation.finalAssistantText !== null &&
                  Buffer.byteLength(reconciliation.finalAssistantText, "utf8") >
                    MAX_AUTHORITATIVE_FINAL_ASSISTANT_BYTES)
              ) {
                return toValidationError(
                  "ProviderService.readAuthoritativeConversation",
                  "Provider returned a malformed or oversized authoritative turn snapshot.",
                );
              }
              seen.add(turn.id);
              if (reconciliation.status === "running") {
                if (runningTurnIndex !== -1 || index !== snapshot.turns.length - 1) {
                  return toValidationError(
                    "ProviderService.readAuthoritativeConversation",
                    "Provider returned an ambiguous authoritative running turn snapshot.",
                  );
                }
                runningTurnIndex = index;
              }
              return Effect.succeed({ id: turn.id, ...reconciliation });
            },
            { concurrency: 1 },
          );
          return {
            threadId: routed.threadId,
            providerInstanceId: routed.instanceId,
            turns,
          };
        }),
      );
    });

  return {
    startSession,
    recoverSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    inspectConversation,
    readAuthoritativeConversation,
    rollbackConversationChecked,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
