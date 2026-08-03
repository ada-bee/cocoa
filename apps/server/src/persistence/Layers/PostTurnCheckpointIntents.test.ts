import {
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperOperationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  PostTurnCheckpointIntentConflictError,
  PostTurnCheckpointIntentFinalizationError,
  PostTurnCheckpointIntentRepository,
} from "../Services/PostTurnCheckpointIntents.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { PostTurnCheckpointIntentRepositoryLive } from "./PostTurnCheckpointIntents.ts";

const completedAt = "2026-08-04T10:00:00.000Z";
const later = "2026-08-04T10:01:00.000Z";
const providerInstanceId = ProviderInstanceId.make("codex-post-intent");
const otherProviderInstanceId = ProviderInstanceId.make("codex-post-intent-other");
const projectId = ProjectId.make("project-post-intent");
const threadId = ThreadId.make("thread-post-intent");
const turnId = TurnId.make("turn-post-intent");
const providerTurnId = "provider-turn-post-intent";
const operationId = CodexCheckpointHelperOperationId.make("11111111-1111-4111-8111-111111111111");
const logicalCheckpointId = CodexCheckpointHelperCheckpointId.make(
  "22222222-2222-4222-8222-222222222222",
);
const baselineCheckpointId = CodexCheckpointHelperCheckpointId.make(
  "33333333-3333-4333-8333-333333333333",
);

const layer = it.layer(
  PostTurnCheckpointIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectInput = (suffix = "one") => ({
  sourceEventId: EventId.make(`event-post-intent-${suffix}`),
  sourceSequence: suffix === "one" ? 10 : suffix === "missing" ? 11 : 12,
  threadId,
  turnId,
  providerTurnId,
  outcome: "completed" as const,
  completedAt,
});

const bindInput = (
  sourceEventId: ReturnType<typeof EventId.make>,
  identity: {
    operationId: typeof operationId;
    logicalCheckpointId: typeof logicalCheckpointId;
  } = { operationId, logicalCheckpointId },
) => ({
  sourceEventId,
  providerInstanceId,
  projectId,
  baselineCheckpointTurnCount: 4,
  checkpointTurnCount: 5,
  baselineLogicalCheckpointId: baselineCheckpointId,
  baselineNotApplicableReason: null,
  ...identity,
  updatedAt: later,
});

layer("PostTurnCheckpointIntentRepository", (it) => {
  it.effect(
    "projects before dispatch correlation and binds exact immutable N to N+1 identity",
    () =>
      Effect.gen(function* () {
        const repository = yield* PostTurnCheckpointIntentRepository;
        const projected = yield* repository.projectInTransaction(projectInput());
        assert.strictEqual(projected.state, "awaiting_dispatch");
        assert.strictEqual(projected.providerInstanceId, null);

        const duplicate = yield* repository.projectInTransaction(projectInput());
        assert.deepStrictEqual(duplicate, projected);

        const bound = yield* repository.bind(bindInput(projected.sourceEventId));
        assert.strictEqual(bound.state, "bound");
        assert.strictEqual(bound.baselineCheckpointTurnCount, 4);
        assert.strictEqual(bound.checkpointTurnCount, 5);
        assert.strictEqual(bound.operationId, operationId);
        assert.deepStrictEqual(yield* repository.bind(bindInput(projected.sourceEventId)), bound);

        const conflicting = yield* Effect.result(
          repository.bind({
            ...bindInput(projected.sourceEventId),
            projectId: ProjectId.make("conflicting-project"),
          }),
        );
        assert.isTrue(Result.isFailure(conflicting));
        if (Result.isFailure(conflicting)) {
          assert.isTrue(Schema.is(PostTurnCheckpointIntentConflictError)(conflicting.failure));
        }
      }),
  );

  it.effect("persists missing provider identity as terminal and excludes it from recovery", () =>
    Effect.gen(function* () {
      const repository = yield* PostTurnCheckpointIntentRepository;
      const input = { ...projectInput("missing"), providerTurnId: null };
      const row = yield* repository.projectInTransaction(input);
      assert.strictEqual(row.state, "uncorrelatable");
      assert.strictEqual(row.finalizedSequence, 0);
      assert.isFalse(
        (yield* repository.listRecovery({ limit: 100 })).some(
          (entry) => entry.sourceEventId === input.sourceEventId,
        ),
      );
      assert.isTrue(
        Option.isSome(yield* repository.getBySourceEventId({ sourceEventId: input.sourceEventId })),
      );
    }),
  );

  it.effect("filters provider-generation recovery and CAS-finalizes one sequence", () =>
    Effect.gen(function* () {
      const repository = yield* PostTurnCheckpointIntentRepository;
      const projected = yield* repository.projectInTransaction(projectInput("two"));
      yield* repository.bind(
        bindInput(projected.sourceEventId, {
          operationId: CodexCheckpointHelperOperationId.make(
            "44444444-4444-4444-8444-444444444444",
          ),
          logicalCheckpointId: CodexCheckpointHelperCheckpointId.make(
            "55555555-5555-4555-8555-555555555555",
          ),
        }),
      );

      assert.isTrue(
        (yield* repository.listRecovery({ providerInstanceId, limit: 100 })).some(
          (entry) => entry.sourceEventId === projected.sourceEventId,
        ),
      );
      assert.strictEqual(
        (yield* repository.listRecovery({
          providerInstanceId: otherProviderInstanceId,
          limit: 100,
        })).length,
        0,
      );

      yield* repository.markFinalized({
        sourceEventId: projected.sourceEventId,
        sequence: 42,
        updatedAt: later,
      });
      yield* repository.markFinalized({
        sourceEventId: projected.sourceEventId,
        sequence: 42,
        updatedAt: later,
      });
      const conflict = yield* Effect.result(
        repository.markFinalized({
          sourceEventId: projected.sourceEventId,
          sequence: 43,
          updatedAt: later,
        }),
      );
      assert.isTrue(Result.isFailure(conflict));
      if (Result.isFailure(conflict)) {
        assert.isTrue(Schema.is(PostTurnCheckpointIntentFinalizationError)(conflict.failure));
      }
      assert.isFalse(
        (yield* repository.listRecovery({ limit: 100 })).some(
          (entry) => entry.sourceEventId === projected.sourceEventId,
        ),
      );
    }),
  );
});
