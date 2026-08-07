import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnId,
} from "../../baseSchemas.ts";
import { ProviderInstanceId } from "../../providerInstance.ts";
import { CocoaClientV1UploadChatAttachments } from "./attachments.ts";

/** Frozen Cocoa client v1 turn-input limit. Changes require a new client protocol version. */
export const COCOA_CLIENT_V1_SEND_TURN_MAX_INPUT_CHARS = 120_000;

export const CocoaClientV1RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type CocoaClientV1RuntimeMode = typeof CocoaClientV1RuntimeMode.Type;

export const CocoaClientV1InteractionMode = Schema.Literals(["default", "plan"]);
export type CocoaClientV1InteractionMode = typeof CocoaClientV1InteractionMode.Type;

export const CocoaClientV1ApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type CocoaClientV1ApprovalDecision = typeof CocoaClientV1ApprovalDecision.Type;

export const CocoaClientV1MessageRole = Schema.Literals(["user", "assistant", "system"]);
export type CocoaClientV1MessageRole = typeof CocoaClientV1MessageRole.Type;

export const CocoaClientV1ThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type CocoaClientV1ThreadActivityTone = typeof CocoaClientV1ThreadActivityTone.Type;

export const CocoaClientV1CheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type CocoaClientV1CheckpointStatus = typeof CocoaClientV1CheckpointStatus.Type;

export const CocoaClientV1ProviderOptionSelection = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.Union([TrimmedNonEmptyString, Schema.Boolean]),
});
export type CocoaClientV1ProviderOptionSelection = typeof CocoaClientV1ProviderOptionSelection.Type;

export const CocoaClientV1ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: Schema.Literals(["play", "test", "lint", "configure", "build", "debug"]),
  runOnWorktreeCreate: Schema.Boolean,
  previewUrl: Schema.optionalKey(TrimmedNonEmptyString),
  autoOpenPreview: Schema.optionalKey(Schema.Boolean),
});
export type CocoaClientV1ProjectScript = typeof CocoaClientV1ProjectScript.Type;

export const CocoaClientV1RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: Schema.Struct({
    source: Schema.Literal("git-remote"),
    remoteName: TrimmedNonEmptyString,
    remoteUrl: TrimmedNonEmptyString,
  }),
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CocoaClientV1RepositoryIdentity = typeof CocoaClientV1RepositoryIdentity.Type;

export const COCOA_CLIENT_V1_COMMAND_TYPES = [
  "project.create",
  "project.meta.update",
  "project.delete",
  "thread.create",
  "thread.delete",
  "thread.archive",
  "thread.unarchive",
  "thread.settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.meta.update",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.checkpoint.revert",
  "thread.session.stop",
] as const;

export const CocoaClientV1ModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(Schema.Array(CocoaClientV1ProviderOptionSelection)),
});
export type CocoaClientV1ModelSelection = typeof CocoaClientV1ModelSelection.Type;

const CocoaClientV1ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optionalKey(Schema.Boolean),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(CocoaClientV1ModelSelection)),
  createdAt: IsoDateTime,
});

const CocoaClientV1ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(CocoaClientV1ModelSelection)),
  scripts: Schema.optionalKey(Schema.Array(CocoaClientV1ProjectScript)),
});

const CocoaClientV1ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optionalKey(Schema.Boolean),
});

const CocoaClientV1ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: CocoaClientV1ModelSelection,
  runtimeMode: CocoaClientV1RuntimeMode,
  interactionMode: CocoaClientV1InteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const threadCommand = <Type extends string>(type: Type) =>
  Schema.Struct({
    type: Schema.Literal(type),
    commandId: CommandId,
    threadId: ThreadId,
  });

const CocoaClientV1ThreadDeleteCommand = threadCommand("thread.delete");
const CocoaClientV1ThreadArchiveCommand = threadCommand("thread.archive");
const CocoaClientV1ThreadUnarchiveCommand = threadCommand("thread.unarchive");
const CocoaClientV1ThreadSettleCommand = threadCommand("thread.settle");

const CocoaClientV1ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.Literal("user"),
});

const CocoaClientV1ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
});

const CocoaClientV1ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.Literal("user"),
});

const CocoaClientV1ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  regenerateTitle: Schema.optionalKey(Schema.Literal(true)),
  modelSelection: Schema.optionalKey(CocoaClientV1ModelSelection),
  branch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

const CocoaClientV1ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: CocoaClientV1RuntimeMode,
  createdAt: IsoDateTime,
});

const CocoaClientV1ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: CocoaClientV1InteractionMode,
  createdAt: IsoDateTime,
});

const CocoaClientV1SourceProposedPlan = Schema.Struct({
  threadId: ThreadId,
  planId: TrimmedNonEmptyString,
});

const CocoaClientV1ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String.check(Schema.isMaxLength(COCOA_CLIENT_V1_SEND_TURN_MAX_INPUT_CHARS)),
    attachments: CocoaClientV1UploadChatAttachments,
  }),
  modelSelection: Schema.optionalKey(CocoaClientV1ModelSelection),
  titleSeed: Schema.optionalKey(TrimmedNonEmptyString),
  runtimeMode: CocoaClientV1RuntimeMode,
  interactionMode: CocoaClientV1InteractionMode,
  sourceProposedPlan: Schema.optionalKey(CocoaClientV1SourceProposedPlan),
  createdAt: IsoDateTime,
});

const CocoaClientV1ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optionalKey(TurnId),
  createdAt: IsoDateTime,
});

const CocoaClientV1ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: CocoaClientV1ApprovalDecision,
  createdAt: IsoDateTime,
});

const CocoaClientV1ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: IsoDateTime,
});

const CocoaClientV1ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const CocoaClientV1ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const CocoaClientV1Command = Schema.Union([
  CocoaClientV1ProjectCreateCommand,
  CocoaClientV1ProjectMetaUpdateCommand,
  CocoaClientV1ProjectDeleteCommand,
  CocoaClientV1ThreadCreateCommand,
  CocoaClientV1ThreadDeleteCommand,
  CocoaClientV1ThreadArchiveCommand,
  CocoaClientV1ThreadUnarchiveCommand,
  CocoaClientV1ThreadSettleCommand,
  CocoaClientV1ThreadUnsettleCommand,
  CocoaClientV1ThreadSnoozeCommand,
  CocoaClientV1ThreadUnsnoozeCommand,
  CocoaClientV1ThreadMetaUpdateCommand,
  CocoaClientV1ThreadRuntimeModeSetCommand,
  CocoaClientV1ThreadInteractionModeSetCommand,
  CocoaClientV1ThreadTurnStartCommand,
  CocoaClientV1ThreadTurnInterruptCommand,
  CocoaClientV1ThreadApprovalRespondCommand,
  CocoaClientV1ThreadUserInputRespondCommand,
  CocoaClientV1ThreadCheckpointRevertCommand,
  CocoaClientV1ThreadSessionStopCommand,
]);
export type CocoaClientV1Command = typeof CocoaClientV1Command.Type;

export const CocoaClientV1DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type CocoaClientV1DispatchResult = typeof CocoaClientV1DispatchResult.Type;

export const CocoaClientV1ProjectShell = Schema.Struct({
  id: ProjectId,
  providerInstanceId: ProviderInstanceId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optionalKey(Schema.NullOr(CocoaClientV1RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(CocoaClientV1ModelSelection),
  scripts: Schema.Array(CocoaClientV1ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CocoaClientV1ProjectShell = typeof CocoaClientV1ProjectShell.Type;

export const CocoaClientV1SessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type CocoaClientV1SessionStatus = typeof CocoaClientV1SessionStatus.Type;

export const CocoaClientV1Session = Schema.Struct({
  threadId: ThreadId,
  status: CocoaClientV1SessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  runtimeMode: CocoaClientV1RuntimeMode,
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type CocoaClientV1Session = typeof CocoaClientV1Session.Type;

export const CocoaClientV1LatestTurn = Schema.Struct({
  turnId: TurnId,
  state: Schema.Literals(["running", "interrupted", "completed", "error"]),
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optionalKey(CocoaClientV1SourceProposedPlan),
});
export type CocoaClientV1LatestTurn = typeof CocoaClientV1LatestTurn.Type;

export const CocoaClientV1TitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type CocoaClientV1TitleRegeneration = typeof CocoaClientV1TitleRegeneration.Type;

const CocoaClientV1ThreadLifecycleFields = {
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: CocoaClientV1ModelSelection,
  runtimeMode: CocoaClientV1RuntimeMode,
  interactionMode: CocoaClientV1InteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(CocoaClientV1LatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  titleRegeneration: Schema.optionalKey(Schema.NullOr(CocoaClientV1TitleRegeneration)),
} as const;

export const CocoaClientV1ThreadShell = Schema.Struct({
  ...CocoaClientV1ThreadLifecycleFields,
  session: Schema.NullOr(CocoaClientV1Session),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
});
export type CocoaClientV1ThreadShell = typeof CocoaClientV1ThreadShell.Type;

export const CocoaClientV1ShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  cacheEpoch: Schema.optionalKey(Schema.String),
  cacheRevision: Schema.optionalKey(NonNegativeInt),
  projects: Schema.Array(CocoaClientV1ProjectShell),
  threads: Schema.Array(CocoaClientV1ThreadShell),
  updatedAt: IsoDateTime,
});
export type CocoaClientV1ShellSnapshot = typeof CocoaClientV1ShellSnapshot.Type;

export const CocoaClientV1SubscribeShellInput = Schema.Struct({
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type CocoaClientV1SubscribeShellInput = typeof CocoaClientV1SubscribeShellInput.Type;

export const COCOA_CLIENT_V1_SHELL_STREAM_KINDS = [
  "synchronized",
  "snapshot",
  "project-upserted",
  "project-removed",
  "thread-upserted",
  "thread-removed",
] as const;

export const CocoaClientV1ShellStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: CocoaClientV1ShellSnapshot }),
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: CocoaClientV1ProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: CocoaClientV1ThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type CocoaClientV1ShellStreamItem = typeof CocoaClientV1ShellStreamItem.Type;

export const CocoaClientV1SubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type CocoaClientV1SubscribeThreadInput = typeof CocoaClientV1SubscribeThreadInput.Type;

export const CocoaClientV1Message = Schema.Struct({
  id: MessageId,
  role: CocoaClientV1MessageRole,
  text: Schema.String,
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CocoaClientV1Message = typeof CocoaClientV1Message.Type;

export const CocoaClientV1ProposedPlan = Schema.Struct({
  id: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime),
  implementationThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CocoaClientV1ProposedPlan = typeof CocoaClientV1ProposedPlan.Type;

export const CocoaClientV1ThreadActivity = Schema.Struct({
  id: EventId,
  tone: CocoaClientV1ThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optionalKey(NonNegativeInt),
  approvalRequestId: Schema.optionalKey(ApprovalRequestId),
  createdAt: IsoDateTime,
});
export type CocoaClientV1ThreadActivity = typeof CocoaClientV1ThreadActivity.Type;

export const CocoaClientV1CheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  status: CocoaClientV1CheckpointStatus,
  files: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      kind: TrimmedNonEmptyString,
      additions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type CocoaClientV1CheckpointSummary = typeof CocoaClientV1CheckpointSummary.Type;

export const CocoaClientV1Thread = Schema.Struct({
  ...CocoaClientV1ThreadLifecycleFields,
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(CocoaClientV1Message),
  proposedPlans: Schema.Array(CocoaClientV1ProposedPlan),
  activities: Schema.Array(CocoaClientV1ThreadActivity),
  checkpoints: Schema.Array(CocoaClientV1CheckpointSummary),
  session: Schema.NullOr(CocoaClientV1Session),
});
export type CocoaClientV1Thread = typeof CocoaClientV1Thread.Type;

export const CocoaClientV1ThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  cacheEpoch: Schema.optionalKey(Schema.String),
  cacheRevision: Schema.optionalKey(NonNegativeInt),
  thread: CocoaClientV1Thread,
});
export type CocoaClientV1ThreadDetailSnapshot = typeof CocoaClientV1ThreadDetailSnapshot.Type;

export const CocoaClientV1GetShellSnapshotInput = Schema.Struct({});
export type CocoaClientV1GetShellSnapshotInput = typeof CocoaClientV1GetShellSnapshotInput.Type;

export const CocoaClientV1GetThreadSnapshotInput = Schema.Struct({ threadId: ThreadId });
export type CocoaClientV1GetThreadSnapshotInput = typeof CocoaClientV1GetThreadSnapshotInput.Type;

const CocoaClientV1EventBase = {
  sequence: NonNegativeInt,
  eventId: EventId,
  threadId: ThreadId,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
} as const;

export const COCOA_CLIENT_V1_THREAD_EVENT_TYPES = [
  "thread.deleted",
  "thread.message-sent",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "thread.reverted",
  "thread.session-set",
] as const;

const CocoaClientV1ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

const CocoaClientV1ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: CocoaClientV1MessageRole,
  text: Schema.String,
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const CocoaClientV1ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: CocoaClientV1ProposedPlan,
});

const CocoaClientV1ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  status: CocoaClientV1CheckpointStatus,
  files: CocoaClientV1CheckpointSummary.fields.files,
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

const CocoaClientV1ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: CocoaClientV1ThreadActivity,
});

const CocoaClientV1ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

const CocoaClientV1ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: CocoaClientV1Session,
});

export const CocoaClientV1ThreadEvent = Schema.Union([
  Schema.Struct({
    ...CocoaClientV1EventBase,
    type: Schema.Literal("thread.deleted"),
    payload: CocoaClientV1ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...CocoaClientV1EventBase,
    type: Schema.Literal("thread.message-sent"),
    payload: CocoaClientV1ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...CocoaClientV1EventBase,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: CocoaClientV1ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...CocoaClientV1EventBase,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: CocoaClientV1ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...CocoaClientV1EventBase,
    type: Schema.Literal("thread.activity-appended"),
    payload: CocoaClientV1ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...CocoaClientV1EventBase,
    type: Schema.Literal("thread.reverted"),
    payload: CocoaClientV1ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...CocoaClientV1EventBase,
    type: Schema.Literal("thread.session-set"),
    payload: CocoaClientV1ThreadSessionSetPayload,
  }),
]);
export type CocoaClientV1ThreadEvent = typeof CocoaClientV1ThreadEvent.Type;

export const CocoaClientV1ThreadStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: CocoaClientV1ThreadDetailSnapshot,
  }),
  Schema.Struct({ kind: Schema.Literal("event"), event: CocoaClientV1ThreadEvent }),
]);
export type CocoaClientV1ThreadStreamItem = typeof CocoaClientV1ThreadStreamItem.Type;

export const CocoaClientV1SearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type CocoaClientV1SearchThreadsInput = typeof CocoaClientV1SearchThreadsInput.Type;

export const CocoaClientV1ThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: Schema.Literals(["user", "assistant"]),
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type CocoaClientV1ThreadSearchMatch = typeof CocoaClientV1ThreadSearchMatch.Type;

export const CocoaClientV1SearchThreadsResult = Schema.Struct({
  matches: Schema.Array(CocoaClientV1ThreadSearchMatch),
});
export type CocoaClientV1SearchThreadsResult = typeof CocoaClientV1SearchThreadsResult.Type;

const CocoaClientV1TurnCountRange = {
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
} as const;

export const CocoaClientV1GetTurnDiffInput = Schema.Struct({
  threadId: ThreadId,
  ...CocoaClientV1TurnCountRange,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      "fromTurnCount must be less than or equal to toTurnCount",
  ),
);
export type CocoaClientV1GetTurnDiffInput = typeof CocoaClientV1GetTurnDiffInput.Type;

export const CocoaClientV1GetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type CocoaClientV1GetFullThreadDiffInput = typeof CocoaClientV1GetFullThreadDiffInput.Type;

const CocoaClientV1DiffResult = Schema.Struct({
  threadId: ThreadId,
  ...CocoaClientV1TurnCountRange,
  diff: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (result) =>
      new TextEncoder().encode(result.diff).byteLength === result.byteLength ||
      "byteLength must equal the UTF-8 encoded diff length",
  ),
);

export const CocoaClientV1GetTurnDiffResult = CocoaClientV1DiffResult;
export type CocoaClientV1GetTurnDiffResult = typeof CocoaClientV1GetTurnDiffResult.Type;

export const CocoaClientV1GetFullThreadDiffResult = CocoaClientV1DiffResult;
export type CocoaClientV1GetFullThreadDiffResult = typeof CocoaClientV1GetFullThreadDiffResult.Type;
