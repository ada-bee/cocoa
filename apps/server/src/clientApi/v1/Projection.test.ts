import { describe, expect, it } from "vite-plus/test";
import { OrchestrationEvent, OrchestrationThreadDetailSnapshot } from "@t3tools/contracts";
import { CocoaClientV1ThreadEvent } from "@t3tools/contracts/client/v1";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { projectThreadEvent, projectThreadSnapshot } from "./Projection.ts";

const createdAt = "2026-08-04T00:00:00.000Z";

describe("Cocoa client v1 projections", () => {
  it("rebuilds thread events without provider-native metadata or activity payloads", () => {
    const event = Schema.decodeUnknownSync(OrchestrationEvent)({
      sequence: 9,
      eventId: "event-9",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: createdAt,
      commandId: "command-9",
      causationEventId: null,
      correlationId: null,
      metadata: {
        providerTurnId: "native-turn-9",
        providerItemId: "native-item-9",
        adapterKey: "codex",
        requestId: "approval-9",
      },
      type: "thread.activity-appended",
      payload: {
        threadId: "thread-1",
        providerTurnId: "native-turn-9",
        activity: {
          id: "activity-9",
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval needed",
          payload: {
            requestId: "approval-9",
            nativeRequestId: "native-request-9",
            path: "/secret/provider/path",
          },
          turnId: "turn-9",
          createdAt,
        },
      },
    });

    const projected = projectThreadEvent(event);
    expect(Option.isSome(projected)).toBe(true);
    if (Option.isNone(projected)) throw new Error("Expected a projected event");
    expect(Schema.decodeUnknownSync(CocoaClientV1ThreadEvent)(projected.value)).toEqual(
      projected.value,
    );
    expect(projected.value).toMatchObject({
      sequence: 9,
      threadId: "thread-1",
      type: "thread.activity-appended",
      payload: {
        activity: {
          approvalRequestId: "approval-9",
        },
      },
    });
    expect(JSON.stringify(projected.value)).not.toMatch(
      /providerTurnId|providerItemId|adapterKey|nativeRequestId|secret\/provider\/path/,
    );
  });

  it("removes attachment blobs, checkpoint refs, and opaque activity payloads from snapshots", () => {
    const snapshot = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot)({
      snapshotSequence: 12,
      thread: {
        id: "thread-1",
        projectId: "project-1",
        title: "Safe thread",
        modelSelection: { instanceId: "codex-main", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/provider/workspace",
        latestTurn: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [
          {
            id: "message-1",
            role: "user",
            text: "hello",
            attachments: [
              {
                type: "image",
                id: "private-attachment",
                name: "secret.png",
                mimeType: "image/png",
                sizeBytes: 42,
              },
            ],
            turnId: "turn-1",
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        ],
        proposedPlans: [],
        activities: [
          {
            id: "activity-1",
            tone: "tool",
            kind: "tool.completed",
            summary: "Tool completed",
            payload: { providerItemId: "native-item-1", path: "/private/path" },
            turnId: "turn-1",
            createdAt,
          },
        ],
        checkpoints: [
          {
            turnId: "turn-1",
            checkpointTurnCount: 1,
            checkpointRef: "native-checkpoint-1",
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: createdAt,
          },
        ],
        session: null,
      },
    });

    const projected = projectThreadSnapshot(snapshot);
    expect(projected.thread.messages[0]).not.toHaveProperty("attachments");
    expect(projected.thread.activities[0]).not.toHaveProperty("payload");
    expect(projected.thread.checkpoints[0]).not.toHaveProperty("checkpointRef");
    expect(JSON.stringify(projected)).not.toMatch(
      /private-attachment|native-checkpoint|private\/path/,
    );
  });
});
