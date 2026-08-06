import type {
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  ServerProvider,
} from "@t3tools/contracts";
import { ApprovalRequestId } from "@t3tools/contracts";
import type {
  CocoaClientV1CheckpointSummary,
  CocoaClientV1InfoResponse,
  CocoaClientV1LatestTurn,
  CocoaClientV1Message,
  CocoaClientV1ModelSelection,
  CocoaClientV1ProjectShell,
  CocoaClientV1ProposedPlan,
  CocoaClientV1Session,
  CocoaClientV1ShellSnapshot,
  CocoaClientV1Thread,
  CocoaClientV1ThreadActivity,
  CocoaClientV1ThreadDetailSnapshot,
  CocoaClientV1ThreadEvent,
  CocoaClientV1ThreadShell,
} from "@t3tools/contracts/client/v1";
import {
  COCOA_CLIENT_PROTOCOL_VERSION,
  COCOA_CLIENT_V1_CORE_CAPABILITIES,
  COCOA_CLIENT_V1_PROVIDER_MESSAGE_MAX_LENGTH,
  COCOA_CLIENT_V1_PROTOCOL_RANGE,
} from "@t3tools/contracts/client/v1";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeApprovalRequest = Schema.decodeUnknownOption(
  Schema.Struct({ requestId: Schema.optionalKey(ApprovalRequestId) }),
);

const projectModelSelection = (selection: ModelSelection): CocoaClientV1ModelSelection => ({
  instanceId: selection.instanceId,
  model: selection.model,
  ...(selection.options === undefined
    ? {}
    : {
        options: selection.options.map((option) => ({
          id: option.id,
          value: option.value,
        })),
      }),
});

const projectLatestTurn = (turn: OrchestrationLatestTurn | null): CocoaClientV1LatestTurn | null =>
  turn === null
    ? null
    : {
        turnId: turn.turnId,
        state: turn.state,
        requestedAt: turn.requestedAt,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        assistantMessageId: turn.assistantMessageId,
        ...(turn.sourceProposedPlan === undefined
          ? {}
          : {
              sourceProposedPlan: {
                threadId: turn.sourceProposedPlan.threadId,
                planId: turn.sourceProposedPlan.planId,
              },
            }),
      };

export const projectSession = (session: OrchestrationSession): CocoaClientV1Session => ({
  threadId: session.threadId,
  status: session.status,
  providerName: session.providerName,
  ...(session.providerInstanceId === undefined
    ? {}
    : { providerInstanceId: session.providerInstanceId }),
  runtimeMode: session.runtimeMode,
  activeTurnId: session.activeTurnId,
  lastError: session.lastError,
  updatedAt: session.updatedAt,
});

export const projectMessage = (message: OrchestrationMessage): CocoaClientV1Message => ({
  id: message.id,
  role: message.role,
  text: message.text,
  turnId: message.turnId,
  streaming: message.streaming,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

export const projectProposedPlan = (
  plan: OrchestrationProposedPlan,
): CocoaClientV1ProposedPlan => ({
  id: plan.id,
  turnId: plan.turnId,
  planMarkdown: plan.planMarkdown,
  implementedAt: plan.implementedAt,
  implementationThreadId: plan.implementationThreadId,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

export const projectActivity = (
  activity: OrchestrationThreadActivity,
): CocoaClientV1ThreadActivity => {
  const decoded = decodeApprovalRequest(activity.payload);
  const approvalRequestId = decoded._tag === "Some" ? decoded.value.requestId : undefined;
  return {
    id: activity.id,
    tone: activity.tone,
    kind: activity.kind,
    summary: activity.summary,
    turnId: activity.turnId,
    ...(activity.sequence === undefined ? {} : { sequence: activity.sequence }),
    ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
    createdAt: activity.createdAt,
  };
};

export const projectCheckpoint = (
  checkpoint: OrchestrationCheckpointSummary,
): CocoaClientV1CheckpointSummary => ({
  turnId: checkpoint.turnId,
  checkpointTurnCount: checkpoint.checkpointTurnCount,
  status: checkpoint.status,
  files: checkpoint.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    additions: file.additions,
    deletions: file.deletions,
  })),
  assistantMessageId: checkpoint.assistantMessageId,
  completedAt: checkpoint.completedAt,
});

const projectThreadLifecycle = (thread: OrchestrationThread | OrchestrationThreadShell) => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  modelSelection: projectModelSelection(thread.modelSelection),
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  latestTurn: projectLatestTurn(thread.latestTurn),
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
  settledOverride: thread.settledOverride,
  settledAt: thread.settledAt,
  ...(thread.snoozedUntil === undefined ? {} : { snoozedUntil: thread.snoozedUntil }),
  ...(thread.snoozedAt === undefined ? {} : { snoozedAt: thread.snoozedAt }),
  ...(thread.titleRegeneration === undefined
    ? {}
    : {
        titleRegeneration:
          thread.titleRegeneration === null
            ? null
            : {
                requestId: thread.titleRegeneration.requestId,
                startedAt: thread.titleRegeneration.startedAt,
              },
      }),
});

export const projectProjectShell = (
  project: OrchestrationProjectShell,
): CocoaClientV1ProjectShell => ({
  id: project.id,
  providerInstanceId: project.providerInstanceId,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  ...(project.repositoryIdentity === undefined
    ? {}
    : {
        repositoryIdentity:
          project.repositoryIdentity === null
            ? null
            : {
                canonicalKey: project.repositoryIdentity.canonicalKey,
                locator: {
                  source: "git-remote",
                  remoteName: project.repositoryIdentity.locator.remoteName,
                  remoteUrl: project.repositoryIdentity.locator.remoteUrl,
                },
                ...(project.repositoryIdentity.rootPath === undefined
                  ? {}
                  : { rootPath: project.repositoryIdentity.rootPath }),
                ...(project.repositoryIdentity.displayName === undefined
                  ? {}
                  : { displayName: project.repositoryIdentity.displayName }),
                ...(project.repositoryIdentity.provider === undefined
                  ? {}
                  : { provider: project.repositoryIdentity.provider }),
                ...(project.repositoryIdentity.owner === undefined
                  ? {}
                  : { owner: project.repositoryIdentity.owner }),
                ...(project.repositoryIdentity.name === undefined
                  ? {}
                  : { name: project.repositoryIdentity.name }),
              },
      }),
  defaultModelSelection:
    project.defaultModelSelection === null
      ? null
      : projectModelSelection(project.defaultModelSelection),
  scripts: project.scripts.map((script) => ({
    id: script.id,
    name: script.name,
    command: script.command,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    ...(script.previewUrl === undefined ? {} : { previewUrl: script.previewUrl }),
    ...(script.autoOpenPreview === undefined ? {} : { autoOpenPreview: script.autoOpenPreview }),
  })),
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

export const projectThreadShell = (thread: OrchestrationThreadShell): CocoaClientV1ThreadShell => ({
  ...projectThreadLifecycle(thread),
  session: thread.session === null ? null : projectSession(thread.session),
  latestUserMessageAt: thread.latestUserMessageAt,
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  hasActionableProposedPlan: thread.hasActionableProposedPlan,
});

export const projectThread = (thread: OrchestrationThread): CocoaClientV1Thread => ({
  ...projectThreadLifecycle(thread),
  deletedAt: thread.deletedAt,
  messages: thread.messages.map(projectMessage),
  proposedPlans: thread.proposedPlans.map(projectProposedPlan),
  activities: thread.activities.map(projectActivity),
  checkpoints: thread.checkpoints.map(projectCheckpoint),
  session: thread.session === null ? null : projectSession(thread.session),
});

export const projectShellSnapshot = (
  snapshot: OrchestrationShellSnapshot,
): CocoaClientV1ShellSnapshot => ({
  snapshotSequence: snapshot.snapshotSequence,
  projects: snapshot.projects.map(projectProjectShell),
  threads: snapshot.threads.map(projectThreadShell),
  updatedAt: snapshot.updatedAt,
});

export const projectThreadSnapshot = (
  snapshot: OrchestrationThreadDetailSnapshot,
): CocoaClientV1ThreadDetailSnapshot => ({
  snapshotSequence: snapshot.snapshotSequence,
  thread: projectThread(snapshot.thread),
});

const eventBase = (event: OrchestrationEvent, threadId: CocoaClientV1ThreadEvent["threadId"]) => ({
  sequence: event.sequence,
  eventId: event.eventId,
  threadId,
  occurredAt: event.occurredAt,
  commandId: event.commandId,
});

export function projectThreadEvent(
  event: OrchestrationEvent,
): Option.Option<CocoaClientV1ThreadEvent> {
  switch (event.type) {
    case "thread.deleted":
      return Option.some({
        ...eventBase(event, event.payload.threadId),
        type: event.type,
        payload: {
          threadId: event.payload.threadId,
          deletedAt: event.payload.deletedAt,
        },
      });
    case "thread.message-sent":
      return Option.some({
        ...eventBase(event, event.payload.threadId),
        type: event.type,
        payload: {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          role: event.payload.role,
          text: event.payload.text,
          turnId: event.payload.turnId,
          streaming: event.payload.streaming,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        },
      });
    case "thread.proposed-plan-upserted":
      return Option.some({
        ...eventBase(event, event.payload.threadId),
        type: event.type,
        payload: {
          threadId: event.payload.threadId,
          proposedPlan: projectProposedPlan(event.payload.proposedPlan),
        },
      });
    case "thread.turn-diff-completed":
      return Option.some({
        ...eventBase(event, event.payload.threadId),
        type: event.type,
        payload: {
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          status: event.payload.status,
          files: event.payload.files.map((file) => ({
            path: file.path,
            kind: file.kind,
            additions: file.additions,
            deletions: file.deletions,
          })),
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        },
      });
    case "thread.activity-appended":
      return Option.some({
        ...eventBase(event, event.payload.threadId),
        type: event.type,
        payload: {
          threadId: event.payload.threadId,
          activity: projectActivity(event.payload.activity),
        },
      });
    case "thread.reverted":
      return Option.some({
        ...eventBase(event, event.payload.threadId),
        type: event.type,
        payload: {
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
        },
      });
    case "thread.session-set":
      return Option.some({
        ...eventBase(event, event.payload.threadId),
        type: event.type,
        payload: {
          threadId: event.payload.threadId,
          session: projectSession(event.payload.session),
        },
      });
    default:
      return Option.none();
  }
}

export const projectInfo = (input: {
  readonly environment: {
    readonly environmentId: CocoaClientV1InfoResponse["environment"]["environmentId"];
    readonly label: string;
    readonly serverVersion: string;
  };
  readonly providers: ReadonlyArray<ServerProvider>;
}): CocoaClientV1InfoResponse => ({
  protocolVersion: COCOA_CLIENT_PROTOCOL_VERSION,
  protocolRange: COCOA_CLIENT_V1_PROTOCOL_RANGE,
  capabilities: [...COCOA_CLIENT_V1_CORE_CAPABILITIES, "workspace.execution"],
  environment: {
    environmentId: input.environment.environmentId,
    label: input.environment.label,
    serverVersion: input.environment.serverVersion,
  },
  providers: input.providers.map((provider) => ({
    instanceId: provider.instanceId,
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    enabled: provider.enabled,
    available: provider.availability !== "unavailable" && provider.installed,
    status: provider.status,
    authStatus: provider.auth.status,
    ...(provider.connectionState === undefined
      ? {}
      : { connectionState: provider.connectionState }),
    ...(provider.message === undefined
      ? {}
      : {
          message: provider.message.slice(0, COCOA_CLIENT_V1_PROVIDER_MESSAGE_MAX_LENGTH).trimEnd(),
        }),
    models: provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      ...(model.shortName === undefined ? {} : { shortName: model.shortName }),
      ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
    })),
  })),
});
