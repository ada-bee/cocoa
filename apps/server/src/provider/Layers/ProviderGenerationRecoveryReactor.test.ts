import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ProviderValidationError, type ProviderServiceError } from "../Errors.ts";
import type {
  ProviderInstance,
  ProviderInstanceGenerationLifecycle,
  ProviderInstanceGenerationState,
} from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstanceRegistryShape } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { makeProviderGenerationRecoveryReactor } from "./ProviderGenerationRecoveryReactor.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../../orchestration/Services/ProviderCommandReactor.ts";
import {
  PostTurnCheckpointReactor,
  type PostTurnCheckpointReactorShape,
} from "../../orchestration/Services/PostTurnCheckpointReactor.ts";
import {
  CheckpointRevertReactor,
  type CheckpointRevertReactorShape,
} from "../../orchestration/Services/CheckpointRevertReactor.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const OTHER_INSTANCE_ID = ProviderInstanceId.make("codex_other");
const PROVIDER = ProviderDriverKind.make("codex");
const LAST_SEEN_AT = "2026-08-03T00:00:00.000Z";

const unavailable = (
  providerInstanceId: ProviderInstanceId = INSTANCE_ID,
): ProviderInstanceGenerationState => ({
  _tag: "Unavailable",
  providerInstanceId,
});

const ready = (
  generationId: number,
  providerInstanceId: ProviderInstanceId = INSTANCE_ID,
): ProviderInstanceGenerationState => ({
  _tag: "Ready",
  providerInstanceId,
  generationId,
});

const binding = (input: {
  readonly name: string;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly status?: "starting" | "running" | "stopped" | "error";
  readonly resumeCursor?: unknown | null;
}): ProviderRuntimeBindingWithMetadata => ({
  threadId: ThreadId.make(input.name),
  provider: PROVIDER,
  providerInstanceId: input.providerInstanceId ?? INSTANCE_ID,
  status: input.status ?? "running",
  resumeCursor:
    input.resumeCursor === undefined ? { threadId: `${input.name}-native` } : input.resumeCursor,
  runtimeMode: "full-access",
  lastSeenAt: LAST_SEEN_AT,
});

const recoveredSession = (threadId: ThreadId): ProviderSession =>
  ({
    threadId,
    provider: PROVIDER,
    providerInstanceId: INSTANCE_ID,
    status: "ready",
    runtimeMode: "full-access",
    updatedAt: LAST_SEEN_AT,
  }) as ProviderSession;

const makeLifecycle = Effect.fn("test.makeGenerationLifecycle")(function* (
  initial: ProviderInstanceGenerationState,
) {
  const state = yield* Ref.make(initial);
  const changes = yield* PubSub.unbounded<ProviderInstanceGenerationState>();
  const released = yield* Deferred.make<void>();
  let releaseCount = 0;
  const lifecycle: ProviderInstanceGenerationLifecycle = {
    getCurrent: Ref.get(state),
    subscribeChanges: Effect.acquireRelease(PubSub.subscribe(changes), () =>
      Effect.sync(() => {
        releaseCount += 1;
      }).pipe(Effect.andThen(Deferred.succeed(released, undefined)), Effect.asVoid),
    ),
  };
  const publish = (next: ProviderInstanceGenerationState) =>
    Ref.set(state, next).pipe(Effect.andThen(PubSub.publish(changes, next)), Effect.asVoid);
  return {
    lifecycle,
    publish,
    released,
    get releaseCount() {
      return releaseCount;
    },
  };
});

const makeInstance = (
  lifecycle: ProviderInstanceGenerationLifecycle,
  marker: string,
): ProviderInstance =>
  ({
    instanceId: INSTANCE_ID,
    driverKind: PROVIDER,
    continuationIdentity: {
      driverKind: PROVIDER,
      continuationKey: `codex:instance:${marker}`,
    },
    displayName: marker,
    enabled: true,
    generationLifecycle: lifecycle,
  }) as ProviderInstance;

interface RecoveryInput {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

const makeHarness = Effect.fn("test.makeRecoveryHarness")(function* (input: {
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>;
  readonly recover?: (input: RecoveryInput) => Effect.Effect<ProviderSession, ProviderServiceError>;
  readonly recoverCommands?: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
  readonly onListBindings?: () => void;
}) {
  const instances = yield* Ref.make(input.instances);
  const bindings = yield* Ref.make(input.bindings);
  const registryChanges = yield* PubSub.unbounded<void>();
  const recoveries = yield* Queue.unbounded<RecoveryInput>();
  const dispatchRecoveries = yield* Queue.unbounded<ProviderInstanceId | undefined>();
  const abandonedInteractions = yield* Queue.unbounded<ProviderInstanceId | undefined>();
  const checkpointRecoveries = yield* Queue.unbounded<ProviderInstanceId | undefined>();
  const revertRecoveries = yield* Queue.unbounded<void>();
  const registryReleased = yield* Deferred.make<void>();

  const registry: ProviderInstanceRegistryShape = {
    getInstance: (instanceId) =>
      Ref.get(instances).pipe(
        Effect.map((current) => current.find((instance) => instance.instanceId === instanceId)),
      ),
    listInstances: Ref.get(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.fromPubSub(registryChanges),
    subscribeChanges: Effect.acquireRelease(PubSub.subscribe(registryChanges), () =>
      Deferred.succeed(registryReleased, undefined).pipe(Effect.asVoid),
    ),
  };
  const directory: ProviderSessionDirectoryShape = {
    upsert: () => Effect.die("unused"),
    getProvider: () => Effect.die("unused"),
    getBinding: () => Effect.die("unused"),
    listThreadIds: () => Effect.die("unused"),
    listBindings: () =>
      Effect.sync(() => input.onListBindings?.()).pipe(Effect.andThen(Ref.get(bindings))),
  };
  const recover =
    input.recover ?? ((request) => Effect.succeed(recoveredSession(request.threadId)));
  const providerService = {
    recoverSession: (request: RecoveryInput) =>
      Queue.offer(recoveries, request).pipe(Effect.andThen(recover(request))),
  } as ProviderServiceShape;
  const providerCommandReactor: ProviderCommandReactorShape = {
    start: () => Effect.die("unused"),
    recover: (providerInstanceId) =>
      Queue.offer(dispatchRecoveries, providerInstanceId).pipe(
        Effect.andThen(
          providerInstanceId === undefined || input.recoverCommands === undefined
            ? Effect.void
            : input.recoverCommands(providerInstanceId),
        ),
      ),
    abandonPendingInteractions: (providerInstanceId) =>
      Queue.offer(abandonedInteractions, providerInstanceId).pipe(Effect.asVoid),
    drain: Effect.void,
  };
  const postTurnCheckpointReactor: PostTurnCheckpointReactorShape = {
    processTurnCompleted: () => Effect.die("unused"),
    recover: (providerInstanceId) =>
      Queue.offer(checkpointRecoveries, providerInstanceId).pipe(Effect.as([])),
    start: () => Effect.die("unused"),
    drain: Effect.void,
  };
  const checkpointRevertReactor: CheckpointRevertReactorShape = {
    process: () => Effect.die("unused"),
    recover: () => Queue.offer(revertRecoveries, undefined).pipe(Effect.as([])),
    start: () => Effect.die("unused"),
    drain: Effect.void,
  };
  const reactor = yield* makeProviderGenerationRecoveryReactor.pipe(
    Effect.provideService(ProviderInstanceRegistry, registry),
    Effect.provideService(ProviderSessionDirectory, directory),
    Effect.provideService(ProviderService, providerService),
    Effect.provideService(ProviderCommandReactor, providerCommandReactor),
    Effect.provideService(PostTurnCheckpointReactor, postTurnCheckpointReactor),
    Effect.provideService(CheckpointRevertReactor, checkpointRevertReactor),
  );
  const ownerScope = yield* Scope.make("sequential");

  return {
    reactor,
    ownerScope,
    recoveries,
    dispatchRecoveries,
    abandonedInteractions,
    checkpointRecoveries,
    revertRecoveries,
    registryReleased,
    setBindings: (next: ReadonlyArray<ProviderRuntimeBindingWithMetadata>) =>
      Ref.set(bindings, next),
    replaceInstances: (next: ReadonlyArray<ProviderInstance>) =>
      Ref.set(instances, next).pipe(
        Effect.andThen(PubSub.publish(registryChanges, undefined)),
        Effect.asVoid,
      ),
  };
});

it("recovers an initially ready generation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(ready(1));
      const expected = binding({ name: "thread-initial" });
      const harness = yield* makeHarness({
        instances: [makeInstance(lifecycle.lifecycle, "initial")],
        bindings: [expected],
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));

      assert.deepStrictEqual(yield* Queue.take(harness.recoveries), {
        threadId: expected.threadId,
        providerInstanceId: INSTANCE_ID,
      });
      assert.equal(yield* Queue.take(harness.dispatchRecoveries), INSTANCE_ID);
      assert.equal(yield* Queue.take(harness.checkpointRecoveries), INSTANCE_ID);
      yield* Queue.take(harness.revertRecoveries);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("abandons non-resumable pending interactions when a generation becomes unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(ready(1));
      const harness = yield* makeHarness({
        instances: [makeInstance(lifecycle.lifecycle, "pending-interactions")],
        bindings: [],
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));
      yield* Queue.take(harness.dispatchRecoveries);

      yield* lifecycle.publish(unavailable());
      assert.equal(yield* Queue.take(harness.abandonedInteractions), INSTANCE_ID);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("recovers later ready generations and survives an individual typed failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(unavailable());
      const expected = binding({ name: "thread-later" });
      const firstFailed = yield* Deferred.make<void>();
      let attempts = 0;
      const harness = yield* makeHarness({
        instances: [makeInstance(lifecycle.lifecycle, "later")],
        bindings: [expected],
        recover: () => {
          attempts += 1;
          return attempts === 1
            ? Deferred.succeed(firstFailed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderValidationError({
                      operation: "test.recover",
                      issue: "first generation failed",
                    }),
                  ),
                ),
              )
            : Effect.succeed(recoveredSession(expected.threadId));
        },
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));

      yield* lifecycle.publish(ready(1));
      yield* Deferred.await(firstFailed);
      yield* lifecycle.publish(ready(2));
      yield* Queue.take(harness.recoveries);
      yield* Queue.take(harness.recoveries);
      assert.deepStrictEqual(
        [
          yield* Queue.take(harness.checkpointRecoveries),
          yield* Queue.take(harness.checkpointRecoveries),
        ],
        [INSTANCE_ID, INSTANCE_ID],
      );
      yield* Queue.take(harness.revertRecoveries);
      yield* Queue.take(harness.revertRecoveries);
      assert.equal(attempts, 2);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("continues durable turn recovery when a provider session resume never settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(ready(1));
      const expected = binding({ name: "thread-hung-resume" });
      const recoveryStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        instances: [makeInstance(lifecycle.lifecycle, "hung-resume")],
        bindings: [expected],
        recover: () =>
          Deferred.succeed(recoveryStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));

      yield* Deferred.await(recoveryStarted);
      assert.equal(yield* Queue.size(harness.dispatchRecoveries), 0);
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Queue.take(harness.dispatchRecoveries), INSTANCE_ID);
      assert.equal(yield* Queue.take(harness.checkpointRecoveries), INSTANCE_ID);
      yield* Queue.take(harness.revertRecoveries);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("deduplicates repeated notifications for the same lifecycle-local generation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(ready(1));
      let listCalls = 0;
      const harness = yield* makeHarness({
        instances: [makeInstance(lifecycle.lifecycle, "dedupe")],
        bindings: [binding({ name: "thread-dedupe" })],
        onListBindings: () => void (listCalls += 1),
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));
      yield* Queue.take(harness.recoveries);

      yield* lifecycle.publish(ready(1));
      yield* lifecycle.publish(ready(2));
      yield* Queue.take(harness.recoveries);
      assert.equal(listCalls, 2);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("does not run checkpoint recovery after the ready generation changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(ready(1));
      const generationChanged = yield* Deferred.make<void>();
      const generationRechecked = yield* Deferred.make<void>();
      const observedLifecycle: ProviderInstanceGenerationLifecycle = {
        ...lifecycle.lifecycle,
        getCurrent: lifecycle.lifecycle.getCurrent.pipe(
          Effect.tap((state) =>
            state._tag === "Unavailable"
              ? Deferred.succeed(generationRechecked, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      };
      const harness = yield* makeHarness({
        instances: [makeInstance(observedLifecycle, "checkpoint-currentness")],
        bindings: [],
        recoverCommands: () =>
          lifecycle
            .publish(unavailable())
            .pipe(Effect.andThen(Deferred.succeed(generationChanged, undefined)), Effect.asVoid),
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));

      assert.equal(yield* Queue.take(harness.dispatchRecoveries), INSTANCE_ID);
      yield* Deferred.await(generationChanged);
      yield* Deferred.await(generationRechecked);
      assert.equal(yield* Queue.size(harness.checkpointRecoveries), 0);
      assert.equal(yield* Queue.size(harness.revertRecoveries), 0);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("filters by exact instance, active status, and a present resume cursor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(ready(1));
      const running = binding({ name: "thread-running", status: "running" });
      const starting = binding({ name: "thread-starting", status: "starting" });
      const harness = yield* makeHarness({
        instances: [makeInstance(lifecycle.lifecycle, "filters")],
        bindings: [
          running,
          starting,
          binding({ name: "thread-stopped", status: "stopped" }),
          binding({ name: "thread-error", status: "error" }),
          binding({ name: "thread-no-cursor", resumeCursor: null }),
          binding({ name: "thread-other", providerInstanceId: OTHER_INSTANCE_ID }),
        ],
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));

      const recovered = [
        (yield* Queue.take(harness.recoveries)).threadId,
        (yield* Queue.take(harness.recoveries)).threadId,
      ];
      assert.deepStrictEqual(
        recovered.toSorted(),
        [running.threadId, starting.threadId].toSorted(),
      );
      assert.equal(yield* Queue.size(harness.recoveries), 0);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("does not suppress generation one on a replacement materialization", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstLifecycle = yield* makeLifecycle(ready(1));
      const secondLifecycle = yield* makeLifecycle(ready(1));
      const expected = binding({ name: "thread-replacement" });
      const first = makeInstance(firstLifecycle.lifecycle, "first-materialization");
      const second = makeInstance(secondLifecycle.lifecycle, "second-materialization");
      const harness = yield* makeHarness({ instances: [first], bindings: [expected] });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));
      yield* Queue.take(harness.recoveries);

      yield* harness.replaceInstances([second]);
      yield* Queue.take(harness.recoveries);
      assert.isTrue(yield* Deferred.isDone(firstLifecycle.released));
      assert.equal(firstLifecycle.releaseCount, 1);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("stops the old generation batch when generation currentness changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(ready(1));
      const oldBindings = Array.from({ length: 8 }, (_, index) =>
        binding({ name: `thread-old-${index}` }),
      );
      const marker = binding({ name: "thread-new-generation" });
      const releaseOld = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        instances: [makeInstance(lifecycle.lifecycle, "mid-batch")],
        bindings: oldBindings,
        recover: (request) =>
          request.threadId === marker.threadId
            ? Effect.succeed(recoveredSession(request.threadId))
            : Deferred.await(releaseOld).pipe(Effect.as(recoveredSession(request.threadId))),
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));

      const startedOld = yield* Effect.forEach([0, 1, 2, 3], () => Queue.take(harness.recoveries));
      yield* harness.setBindings([marker]);
      yield* lifecycle.publish(ready(2));
      yield* lifecycle.publish(unavailable());
      yield* lifecycle.publish(ready(3));
      yield* Deferred.succeed(releaseOld, undefined);
      const recoveredMarker = yield* Queue.take(harness.recoveries);

      assert.equal(recoveredMarker.threadId, marker.threadId);
      assert.equal(new Set(startedOld.map((request) => request.threadId)).size, 4);
      assert.equal(yield* Queue.size(harness.recoveries), 0);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("bounds concurrent recovery work at four", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(ready(1));
      const bindings = Array.from({ length: 10 }, (_, index) =>
        binding({ name: `thread-concurrency-${index}` }),
      );
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      let completedCount = 0;
      const harness = yield* makeHarness({
        instances: [makeInstance(lifecycle.lifecycle, "concurrency")],
        bindings,
        recover: (request) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              active += 1;
              maximum = Math.max(maximum, active);
            }),
            () => Deferred.await(release).pipe(Effect.as(recoveredSession(request.threadId))),
            () =>
              Effect.sync(() => {
                active -= 1;
                completedCount += 1;
              }).pipe(
                Effect.flatMap(() =>
                  completedCount === bindings.length
                    ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
          ),
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));

      yield* Effect.forEach([0, 1, 2, 3], () => Queue.take(harness.recoveries));
      assert.equal(maximum, 4);
      assert.equal(active, 4);
      assert.equal(yield* Queue.size(harness.recoveries), 0);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(completed);
      assert.equal(maximum, 4);
      assert.equal(completedCount, 10);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  ));

it("closes materialized lifecycle work on replacement and registry work on shutdown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(ready(1));
      const recoveryInterrupted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        instances: [makeInstance(lifecycle.lifecycle, "cleanup")],
        bindings: [binding({ name: "thread-cleanup" })],
        recover: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Deferred.succeed(recoveryInterrupted, undefined).pipe(Effect.asVoid),
            ),
          ),
      });
      yield* harness.reactor.start().pipe(Effect.provideService(Scope.Scope, harness.ownerScope));
      yield* Queue.take(harness.recoveries);

      yield* harness.replaceInstances([]);
      yield* Deferred.await(recoveryInterrupted);
      yield* Deferred.await(lifecycle.released);
      assert.equal(lifecycle.releaseCount, 1);

      yield* Scope.close(harness.ownerScope, Exit.void);
      yield* Deferred.await(harness.registryReleased);
    }),
  ));
