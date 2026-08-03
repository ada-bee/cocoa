import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-provider-binding");
const threadId = ThreadId.make("thread-provider-binding");
const owningProviderInstanceId = ProviderInstanceId.make("codex");
const otherProviderInstanceId = ProviderInstanceId.make("codex-remote");
const owningModelSelection = {
  instanceId: owningProviderInstanceId,
  model: "gpt-5-codex",
} as const;
const otherModelSelection = {
  instanceId: otherProviderInstanceId,
  model: "gpt-5-codex",
} as const;

const makeReadModel = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("evt-project-provider-binding"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-project-provider-binding"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project-provider-binding"),
    metadata: {},
    payload: {
      projectId,
      providerInstanceId: owningProviderInstanceId,
      title: "Provider binding",
      workspaceRoot: "/tmp/provider-binding",
      defaultModelSelection: owningModelSelection,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("evt-thread-provider-binding"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-thread-provider-binding"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread-provider-binding"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Provider binding",
      modelSelection: owningModelSelection,
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

const expectProviderMismatch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(effect);
    expect(String(failure)).toContain(
      "must match owning project 'project-provider-binding' provider instance 'codex'",
    );
  });

it.layer(NodeServices.layer)("decider provider binding", (it) => {
  it.effect("rejects a project.create default model from another provider", () =>
    expectProviderMismatch(
      decideOrchestrationCommand({
        readModel: createEmptyReadModel(now),
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-provider-mismatch"),
          projectId,
          providerInstanceId: owningProviderInstanceId,
          title: "Provider binding",
          workspaceRoot: "/tmp/provider-binding",
          defaultModelSelection: otherModelSelection,
          createdAt: now,
        },
      }),
    ),
  );

  it.effect("rejects a project.meta.update default model from another provider", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel;
      yield* expectProviderMismatch(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-project-meta-provider-mismatch"),
            projectId,
            defaultModelSelection: otherModelSelection,
          },
        }),
      );
    }),
  );

  it.effect("rejects a thread.create model from another provider", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel;
      yield* expectProviderMismatch(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-create-provider-mismatch"),
            threadId: ThreadId.make("thread-provider-mismatch"),
            projectId,
            title: "Provider mismatch",
            modelSelection: otherModelSelection,
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
        }),
      );
    }),
  );

  it.effect("rejects a thread.meta.update model from another provider", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel;
      yield* expectProviderMismatch(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-thread-meta-provider-mismatch"),
            threadId,
            modelSelection: otherModelSelection,
          },
        }),
      );
    }),
  );

  it.effect("rejects a thread.turn.start model from another provider", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel;
      yield* expectProviderMismatch(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-thread-turn-provider-mismatch"),
            threadId,
            message: {
              messageId: MessageId.make("message-provider-mismatch"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: otherModelSelection,
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
          },
        }),
      );
    }),
  );
});
