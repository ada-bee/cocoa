import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperOperationId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runCocoaMigrations } from "../CocoaMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  type PrepareTurnDispatchInput,
  TurnDispatchId,
  TurnDispatchIntentConflictError,
  TurnDispatchJournalRepository,
  TurnDispatchProviderTurnId,
  TurnDispatchTransitionError,
} from "../Services/TurnDispatchJournal.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  TurnDispatchJournalRepositoryLive,
  turnDispatchTitleSeedSha256,
} from "./TurnDispatchJournal.ts";

const now = "2026-08-04T08:00:00.000Z";
const later = "2026-08-04T08:01:00.000Z";
const providerInstanceId = ProviderInstanceId.make("codex-macbook");
const projectId = ProjectId.make("cocoa");
const threadId = ThreadId.make("thread-turn-dispatch");
const baselineCheckpointId = CodexCheckpointHelperCheckpointId.make(
  "11111111-1111-4111-8111-111111111111",
);
const baselineOperationId = CodexCheckpointHelperOperationId.make(
  "22222222-2222-4222-8222-222222222222",
);

it.effect("rejects provider turn ids containing control characters", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(TurnDispatchProviderTurnId);
    assert.isTrue(Schema.isSchemaError(yield* Effect.flip(decode("provider-turn\nforged"))));
    assert.isTrue(Schema.isSchemaError(yield* Effect.flip(decode("provider-turn\u007fforged"))));
  }),
);
const isIntentConflict = Schema.is(TurnDispatchIntentConflictError);
const isTransitionError = Schema.is(TurnDispatchTransitionError);

const prepareInput = (
  suffix: string,
  overrides: Partial<PrepareTurnDispatchInput> = {},
): PrepareTurnDispatchInput => ({
  dispatchId: TurnDispatchId.make(`dispatch:${suffix}`),
  sourceEventId: EventId.make(`event:${suffix}`),
  sourceCommandId: CommandId.make(`command:${suffix}`),
  threadId,
  projectId,
  providerInstanceId,
  messageId: MessageId.make(`message:${suffix}`),
  checkpointTurnCount: 0,
  modelSelection: {
    instanceId: providerInstanceId,
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  titleSeedSha256: turnDispatchTitleSeedSha256("A bounded title seed"),
  createdAt: now,
  ...overrides,
});

const repositoryLayer = it.layer(
  TurnDispatchJournalRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

repositoryLayer("TurnDispatchJournalRepository", (it) => {
  it.effect("persists path-free bounded intent and returns the first dispatch identity", () =>
    Effect.gen(function* () {
      const repository = yield* TurnDispatchJournalRepository;
      const sql = yield* SqlClient.SqlClient;
      const original = prepareInput("dedupe");
      const first = yield* repository.getOrCreate(original);
      const duplicate = yield* repository.getOrCreate({
        ...original,
        dispatchId: TurnDispatchId.make("dispatch:other-caller"),
      });

      assert.isTrue(first.inserted);
      assert.isFalse(duplicate.inserted);
      assert.equal(duplicate.entry.dispatchId, original.dispatchId);
      assert.equal(duplicate.entry.state, "awaiting_baseline");

      const raw = yield* sql<{
        readonly messageId: string;
        readonly modelSelection: string;
        readonly titleSeedSha256: string;
      }>`
        SELECT message_id AS "messageId", model_selection_json AS "modelSelection",
               title_seed_sha256 AS "titleSeedSha256"
        FROM turn_dispatch_journal
        WHERE dispatch_id = ${original.dispatchId}
      `;
      assert.equal(raw[0]?.messageId, original.messageId);
      assert.notInclude(raw[0]?.modelSelection ?? "", "A bounded title seed");
      assert.equal(raw[0]?.titleSeedSha256.length, 64);

      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(turn_dispatch_journal)`;
      assert.notInclude(
        columns.map((column) => column.name),
        "message_text",
      );
      assert.notInclude(
        columns.map((column) => column.name),
        "workspace_path",
      );
    }),
  );

  it.effect("rejects immutable conflicts for the same accepted source event", () =>
    Effect.gen(function* () {
      const repository = yield* TurnDispatchJournalRepository;
      const original = prepareInput("conflict");
      yield* repository.getOrCreate(original);
      const error = yield* Effect.flip(
        repository.getOrCreate({
          ...original,
          dispatchId: TurnDispatchId.make("dispatch:conflicting-caller"),
          interactionMode: "plan",
        }),
      );
      assert.isTrue(isIntentConflict(error));
    }),
  );

  it.effect("serializes concurrent get-or-create and preserves one identity", () =>
    Effect.gen(function* () {
      const repository = yield* TurnDispatchJournalRepository;
      const original = prepareInput("concurrent");
      const results = yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          repository.getOrCreate({
            ...original,
            dispatchId: TurnDispatchId.make(`dispatch:concurrent:${index}`),
          }),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result.inserted).length, 1);
      assert.equal(new Set(results.map((result) => result.entry.dispatchId)).size, 1);
    }),
  );

  it.effect("enforces the no-replay barrier and self-finalizes started rows", () =>
    Effect.gen(function* () {
      const repository = yield* TurnDispatchJournalRepository;
      const startedProvider = ProviderInstanceId.make("codex-started-test");
      const input = prepareInput("started", { providerInstanceId: startedProvider });
      yield* repository.getOrCreate(input);
      yield* repository.markBaselineReady({
        dispatchId: input.dispatchId,
        baselineLogicalCheckpointId: baselineCheckpointId,
        baselineOperationId,
        updatedAt: later,
      });
      yield* repository.markProviderInFlight({ dispatchId: input.dispatchId, updatedAt: later });
      yield* repository.markStarted({
        dispatchId: input.dispatchId,
        providerTurnId: "provider-turn-1",
        updatedAt: later,
      });

      const started = Option.getOrThrow(
        yield* repository.getByDispatchId({ dispatchId: input.dispatchId }),
      );
      assert.equal(started.state, "started");
      assert.equal(started.finalizedSequence, 0);
      assert.equal(
        Option.getOrThrow(
          yield* repository.getStartedByProviderTurn({
            threadId: input.threadId,
            providerTurnId: "provider-turn-1",
          }),
        ).dispatchId,
        input.dispatchId,
      );
      assert.isTrue(
        Option.isNone(
          yield* repository.getStartedByProviderTurn({
            threadId: input.threadId,
            providerTurnId: "provider-turn-missing",
          }),
        ),
      );
      assert.deepStrictEqual(
        yield* repository.listRecovery({ providerInstanceId: startedProvider, limit: 100 }),
        [],
      );

      const illegal = yield* Effect.flip(
        repository.markProviderInFlight({ dispatchId: input.dispatchId, updatedAt: later }),
      );
      assert.isTrue(isTransitionError(illegal));
      assert.equal(isTransitionError(illegal) ? illegal.currentState : undefined, "started");
    }),
  );

  it.effect("allows only explicit not-applicable baselines before provider dispatch", () =>
    Effect.gen(function* () {
      const repository = yield* TurnDispatchJournalRepository;
      const input = prepareInput("not-repository");
      yield* repository.getOrCreate(input);
      yield* repository.markBaselineNotApplicable({
        dispatchId: input.dispatchId,
        reason: "not_repository",
        updatedAt: later,
      });
      yield* repository.markProviderInFlight({ dispatchId: input.dispatchId, updatedAt: later });
      yield* repository.markIndeterminate({
        dispatchId: input.dispatchId,
        error: { code: "connection_lost", summary: "Provider response unavailable" },
        updatedAt: later,
      });
      const entry = Option.getOrThrow(
        yield* repository.getByDispatchId({ dispatchId: input.dispatchId }),
      );
      assert.equal(entry.baselineNotApplicableReason, "not_repository");
      assert.isNull(entry.baselineLogicalCheckpointId);
      assert.equal(entry.state, "indeterminate");
    }),
  );

  it.effect("returns bounded stable recovery pages and drops finalized growth", () =>
    Effect.gen(function* () {
      const repository = yield* TurnDispatchJournalRepository;
      const recoveryProvider = ProviderInstanceId.make("codex-recovery-test");
      const inputs = ["a", "b", "c"].map((suffix) =>
        prepareInput(`recovery:${suffix}`, {
          providerInstanceId: recoveryProvider,
          createdAt: suffix === "c" ? later : now,
        }),
      );
      for (const input of inputs) {
        yield* repository.getOrCreate(input);
        yield* repository.markFailed({
          dispatchId: input.dispatchId,
          error: { code: "baseline_failed", summary: "Baseline capture failed" },
          updatedAt: later,
        });
      }

      const first = yield* repository.listRecovery({
        providerInstanceId: recoveryProvider,
        limit: 2,
      });
      assert.deepStrictEqual(
        first.map((entry) => entry.dispatchId),
        [inputs[0]?.dispatchId, inputs[1]?.dispatchId],
      );
      const second = yield* repository.listRecovery({
        providerInstanceId: recoveryProvider,
        after: {
          createdAt: first[1]?.createdAt ?? now,
          dispatchId: first[1]?.dispatchId ?? TurnDispatchId.make("unreachable"),
        },
        limit: 2,
      });
      assert.deepStrictEqual(
        second.map((entry) => entry.dispatchId),
        [inputs[2]?.dispatchId],
      );

      yield* repository.markFinalized({
        dispatchId: inputs[0]?.dispatchId ?? TurnDispatchId.make("unreachable"),
        sequence: 41,
        updatedAt: later,
      });
      yield* repository.markFinalized({
        dispatchId: inputs[0]?.dispatchId ?? TurnDispatchId.make("unreachable"),
        sequence: 41,
        updatedAt: later,
      });
      const finalizedTransition = yield* Effect.flip(
        repository.markFailed({
          dispatchId: inputs[0]?.dispatchId ?? TurnDispatchId.make("unreachable"),
          error: { code: "replacement_failure", summary: "Replacement failure" },
          updatedAt: later,
        }),
      );
      assert.isTrue(isTransitionError(finalizedTransition));
      assert.deepStrictEqual(
        (yield* repository.listRecovery({
          providerInstanceId: recoveryProvider,
          limit: 100,
        })).map((entry) => entry.dispatchId),
        [inputs[1]?.dispatchId, inputs[2]?.dispatchId],
      );
    }),
  );
});

it.layer(NodeServices.layer)("Turn dispatch restart recovery", (it) => {
  it.effect("reopens SQLite with baseline disposition and barrier state intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cocoa-turn-dispatch-" });
      const databasePath = path.join(directory, "state.sqlite");
      const input = prepareInput("restart");

      const databaseLayer = TurnDispatchJournalRepositoryLive.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
      );
      const runWithDatabase = <A, E>(
        effect: Effect.Effect<A, E, TurnDispatchJournalRepository | SqlClient.SqlClient>,
      ) => effect.pipe(Effect.provide(databaseLayer), Effect.scoped);

      yield* runWithDatabase(
        Effect.gen(function* () {
          yield* runCocoaMigrations();
          const repository = yield* TurnDispatchJournalRepository;
          yield* repository.getOrCreate(input);
          yield* repository.markBaselineNotApplicable({
            dispatchId: input.dispatchId,
            reason: "capability_unavailable",
            updatedAt: later,
          });
          yield* repository.markProviderInFlight({
            dispatchId: input.dispatchId,
            updatedAt: later,
          });
        }),
      );

      const recovered = yield* runWithDatabase(
        Effect.gen(function* () {
          yield* runCocoaMigrations();
          const repository = yield* TurnDispatchJournalRepository;
          const duplicate = yield* repository.getOrCreate({
            ...input,
            dispatchId: TurnDispatchId.make("dispatch:restart:other"),
          });
          assert.isFalse(duplicate.inserted);
          return yield* repository.listRecovery({ limit: 100 });
        }),
      );
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.dispatchId, input.dispatchId);
      assert.equal(recovered[0]?.state, "provider_in_flight");
      assert.equal(recovered[0]?.baselineNotApplicableReason, "capability_unavailable");
    }),
  );
});
