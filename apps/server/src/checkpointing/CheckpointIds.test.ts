import {
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperOperationId,
  CommandId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  CheckpointIdentityInputError,
  makeBaselineCheckpointIdentity,
  makeBaselineCheckpointIdentityFromEvent,
  makeDeleteCheckpointOperationId,
  makePostTurnCheckpointIdentity,
  makeRestoreCheckpointOperationId,
  uuidV5,
} from "./CheckpointIds.ts";

const providerInstanceId = ProviderInstanceId.make("codex_air");
const threadId = ThreadId.make("thread-018f6b93");
const sourceCommandId = CommandId.make("command-turn-start-42");
const sourceEventId = EventId.make("event-turn-start-42");
const providerTurnId = TurnId.make("0198-f691-provider-turn");
const revertEventId = EventId.make("event-revert-91");

const isCheckpointId = Schema.is(CodexCheckpointHelperCheckpointId);
const isOperationId = Schema.is(CodexCheckpointHelperOperationId);

describe("uuidV5", () => {
  it("matches the RFC 4122 DNS vector", () => {
    assert.equal(
      uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.widgets.com"),
      "21f7f8de-8051-5b89-8680-0195ef798b6a",
    );
  });

  it("uses UTF-8 deterministically for Unicode names", () => {
    assert.equal(
      uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "Příliš žluťoučký 🐎"),
      "fbb80fd9-a07a-535a-8d8e-8865f21c89f0",
    );
  });

  it("rejects malformed namespaces, invalid Unicode, and oversized names without echoing input", () => {
    assert.throws(() => uuidV5("not-a-uuid", "name"), CheckpointIdentityInputError);
    assert.throws(
      () => uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "\ud800"),
      CheckpointIdentityInputError,
    );
    const secret = `/provider/private/${"x".repeat(4_096)}`;
    try {
      uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", secret);
      assert.fail("expected oversized name to fail");
    } catch (error) {
      assert.instanceOf(error, CheckpointIdentityInputError);
      assert.notInclude(error.message, secret);
    }
  });
});

describe("checkpoint identities", () => {
  it("pins stable project vectors accepted by the CCH UUID schemas", () => {
    const baseline = makeBaselineCheckpointIdentity({
      providerInstanceId,
      threadId,
      sourceCommandId,
    });
    const postTurn = makePostTurnCheckpointIdentity({
      providerInstanceId,
      threadId,
      providerTurnId,
    });
    const restore = makeRestoreCheckpointOperationId({ revertEventId });
    const remove = makeDeleteCheckpointOperationId({ revertEventId, batchOrdinal: 3 });

    assert.deepEqual(baseline, {
      logicalCheckpointId: "2329019b-4e49-5837-95b4-1723137a0935",
      operationId: "d4d5c890-2d6c-573d-a834-7bc5514182f4",
    });
    assert.deepEqual(postTurn, {
      logicalCheckpointId: "3bd23411-3097-52f3-8f0d-922baaa1d0ca",
      operationId: "08b19c46-07e8-54b4-b11c-dde38de3bc8f",
    });
    assert.equal(restore, "01c3e9d1-5fc0-5d7c-9116-cdd0361bc150");
    assert.equal(remove, "5f9e7418-0917-5cba-a4ad-3eebf5888907");
    assert.isTrue(isCheckpointId(baseline.logicalCheckpointId));
    assert.isTrue(isCheckpointId(postTurn.logicalCheckpointId));
    assert.isTrue(isOperationId(baseline.operationId));
    assert.isTrue(isOperationId(postTurn.operationId));
    assert.isTrue(isOperationId(restore));
    assert.isTrue(isOperationId(remove));
  });

  it("is deterministic and separates logical, operation, source, and operation-kind domains", () => {
    const baselineInput = { providerInstanceId, threadId, sourceCommandId };
    const baseline = makeBaselineCheckpointIdentity(baselineInput);
    assert.deepEqual(makeBaselineCheckpointIdentity(baselineInput), baseline);
    assert.notEqual(baseline.logicalCheckpointId, baseline.operationId);

    const fallback = makeBaselineCheckpointIdentityFromEvent({
      providerInstanceId,
      threadId,
      sourceEventId,
    });
    assert.notEqual(fallback.logicalCheckpointId, baseline.logicalCheckpointId);
    assert.notEqual(fallback.operationId, baseline.operationId);

    const sameOpaqueSource = "same-source-id";
    const commandDomain = makeBaselineCheckpointIdentity({
      providerInstanceId,
      threadId,
      sourceCommandId: CommandId.make(sameOpaqueSource),
    });
    const eventDomain = makeBaselineCheckpointIdentityFromEvent({
      providerInstanceId,
      threadId,
      sourceEventId: EventId.make(sameOpaqueSource),
    });
    assert.notDeepEqual(commandDomain, eventDomain);

    const restore = makeRestoreCheckpointOperationId({ revertEventId });
    const remove = makeDeleteCheckpointOperationId({ revertEventId, batchOrdinal: 0 });
    assert.notEqual(restore, remove);
    assert.notEqual(remove, makeDeleteCheckpointOperationId({ revertEventId, batchOrdinal: 1 }));
  });

  it("changes post-turn identities only for provider instance, thread, or provider turn identity", () => {
    const original = makePostTurnCheckpointIdentity({
      providerInstanceId,
      threadId,
      providerTurnId,
    });
    assert.notDeepEqual(
      makePostTurnCheckpointIdentity({
        providerInstanceId: ProviderInstanceId.make("codex_rigatoni"),
        threadId,
        providerTurnId,
      }),
      original,
    );
    assert.notDeepEqual(
      makePostTurnCheckpointIdentity({
        providerInstanceId,
        threadId: ThreadId.make("thread-other"),
        providerTurnId,
      }),
      original,
    );
    assert.notDeepEqual(
      makePostTurnCheckpointIdentity({
        providerInstanceId,
        threadId,
        providerTurnId: TurnId.make("provider-turn-other"),
      }),
      original,
    );
  });

  it("supports Unicode opaque IDs without retaining their text in generated IDs", () => {
    const unicode = makePostTurnCheckpointIdentity({
      providerInstanceId,
      threadId: ThreadId.make("vlákno-🐝"),
      providerTurnId: TurnId.make("otáčka-Žluťoučká"),
    });
    assert.isTrue(isCheckpointId(unicode.logicalCheckpointId));
    assert.notInclude(unicode.logicalCheckpointId, "vlákno");
    assert.notInclude(unicode.operationId, "otáčka");
  });

  it("rejects invalid or oversized identifiers and ordinals", () => {
    assert.throws(
      () =>
        makeBaselineCheckpointIdentity({
          providerInstanceId: "../private" as ProviderInstanceId,
          threadId,
          sourceCommandId,
        }),
      CheckpointIdentityInputError,
    );
    assert.throws(
      () =>
        makeBaselineCheckpointIdentity({
          providerInstanceId,
          threadId: "x".repeat(1_025) as ThreadId,
          sourceCommandId,
        }),
      CheckpointIdentityInputError,
    );
    assert.throws(
      () => makeDeleteCheckpointOperationId({ revertEventId, batchOrdinal: -1 }),
      CheckpointIdentityInputError,
    );
    assert.throws(
      () => makeDeleteCheckpointOperationId({ revertEventId, batchOrdinal: Number.MAX_VALUE }),
      CheckpointIdentityInputError,
    );
  });
});
