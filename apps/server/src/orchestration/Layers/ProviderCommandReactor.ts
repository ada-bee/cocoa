import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderDriverKind,
  type ProjectId,
  type ProviderInstanceId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { makeBaselineCheckpointIdentity } from "../../checkpointing/CheckpointIds.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  type TurnDispatchId,
  type TurnDispatchJournalEntry,
  TurnDispatchJournalRepository,
  type TurnDispatchError,
} from "../../persistence/Services/TurnDispatchJournal.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectWorkspace, type ProjectWorkspaceError } from "../../project/ProjectWorkspace.ts";
import {
  CheckpointCoordinator,
  CheckpointCoordinatorBlockedError,
} from "../Services/CheckpointCoordinator.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const isCheckpointCoordinatorBlockedError = Schema.is(CheckpointCoordinatorBlockedError);

const retryableBaselineBlockCodes = new Set([
  "provider_disconnected",
  "provider_protocol_error",
  "repository_unavailable",
  "checkpoint_prepare_failed",
  "checkpoint_outcome_unknown",
  "checkpoint_projection_missing",
  "persistence_failure",
]);

const indeterminateBaselineBlockCodes = new Set([
  "checkpoint_indeterminate",
  "repository_binding_changed",
  "request_digest_changed",
  "checkpoint_receipt_invalid",
]);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";

function formatThreadTitleContext(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }>,
): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    if (message.role === "system") {
      continue;
    }
    const text = message.text.trim();
    const attachmentSummary = (message.attachments ?? [])
      .map((attachment) => attachment.name)
      .join(", ");
    const contents = [
      ...(text.length > 0 ? [text] : []),
      ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
    ].join("\n");
    if (contents.length === 0) {
      continue;
    }

    const section = `${message.role.toUpperCase()}:\n${contents}`;
    const separator = context.length > 0 ? "\n\n" : "";
    const available = MAX_THREAD_TITLE_CONTEXT_CHARS - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return {
    message: truncated ? `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${context}` : context,
    attachments: retainedAttachments.slice(-MAX_REGENERATION_ATTACHMENTS),
  };
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<unknown>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function sanitizedWorkspaceValidationDetail(error: ProjectWorkspaceError): string {
  switch (error._tag) {
    case "ProviderWorkspaceDisconnectedError":
      return "The project workspace is temporarily unavailable because its provider is disconnected.";
    case "ProviderWorkspaceUnsupportedError":
    case "ProjectWorkspaceCapabilityUnavailableError":
      return "Workspace validation is not supported by the selected provider.";
    case "ProviderWorkspacePathError":
      return "The project workspace path could not be validated by the selected provider.";
    case "ProjectWorkspaceProviderNotFoundError":
    case "ProjectWorkspaceProviderUnavailableError":
      return "The provider that owns the project workspace is unavailable.";
    case "ProjectWorkspaceProjectNotFoundError":
    case "ProjectWorkspaceThreadNotFoundError":
    case "ProjectWorkspaceThreadProjectMismatchError":
    case "ProjectWorkspaceResolveOperationError":
      return "The project workspace could not be resolved.";
    case "ProviderWorkspaceProtocolError":
    case "ProviderWorkspaceOperationError":
      return "The selected provider could not validate the project workspace.";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const projectWorkspace = yield* ProjectWorkspace;
  const checkpointCoordinator = yield* CheckpointCoordinator;
  const turnDispatchJournal = yield* TurnDispatchJournalRepository;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const threadModelSelections = new Map<string, ModelSelection>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly commandId?: CommandId;
    readonly activityId?: EventId;
  }) =>
    Effect.all({
      commandId:
        input.commandId === undefined
          ? serverCommandId("provider-failure-activity")
          : Effect.succeed(input.commandId),
      eventId: input.activityId === undefined ? serverEventId() : Effect.succeed(input.activityId),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
    readonly commandId?: CommandId;
  }) =>
    (input.commandId === undefined
      ? serverCommandId("provider-session-set")
      : Effect.succeed(input.commandId)
    ).pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
    readonly commandId?: CommandId;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
      ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      readonly runtimeMode?: RuntimeMode;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = options?.runtimeMode ?? thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const startProviderSession = Effect.fn("startProviderSession")(function* (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) {
      yield* projectWorkspace.validateRoot({ projectId: thread.projectId, threadId }).pipe(
        Effect.mapError(
          (error) =>
            new ProviderAdapterRequestError({
              provider: providerErrorLabel(String(desiredInstanceId)),
              method: "thread.turn.start",
              detail: sanitizedWorkspaceValidationDetail(error),
            }),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          const mappedError = findProviderAdapterRequestError(cause);
          return Effect.fail(
            mappedError ??
              new ProviderAdapterRequestError({
                provider: providerErrorLabel(String(desiredInstanceId)),
                method: "thread.turn.start",
                detail: "The selected provider could not validate the project workspace.",
              }),
          );
        }),
      );
      return yield* providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });
    });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly runtimeMode: RuntimeMode;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
      runtimeMode: input.runtimeMode,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly providerInstanceId: ProviderInstanceId;
      readonly fallbackModelSelection: ModelSelection;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: configuredModelSelection } =
          yield* serverSettingsService.getSettings;
        const modelSelection =
          configuredModelSelection.instanceId === input.providerInstanceId
            ? configuredModelSelection
            : input.fallbackModelSelection;

        const generated = yield* textGeneration.generateThreadTitle({
          providerInstanceId: input.providerInstanceId,
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return { _tag: "Completed", title: undefined } as const;
    }
    const cwd = resolveThreadWorkspaceCwd({ thread, projects: [project] });
    if (!cwd) {
      return { _tag: "Completed", title: undefined } as const;
    }
    const { textGenerationModelSelection: configuredModelSelection } =
      yield* serverSettingsService.getSettings;
    const modelSelection =
      configuredModelSelection.instanceId === project.providerInstanceId
        ? configuredModelSelection
        : thread.modelSelection;
    const generated = yield* textGeneration.generateThreadTitle({
      providerInstanceId: project.providerInstanceId,
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const finalizeDurableTurnDispatchFailure = Effect.fn("finalizeDurableTurnDispatchFailure")(
    function* (entry: TurnDispatchJournalEntry, detail: string) {
      if (entry.finalizedSequence !== null) return;
      const deterministicSuffix = String(entry.dispatchId);
      yield* setThreadSessionErrorOnTurnStartFailure({
        threadId: entry.threadId,
        detail,
        createdAt: entry.updatedAt,
        commandId: CommandId.make(`server:turn-dispatch-session-error:${deterministicSuffix}`),
      });
      const activity = yield* appendProviderFailureActivity({
        threadId: entry.threadId,
        kind: "provider.turn.start.failed",
        summary:
          entry.state === "indeterminate"
            ? "Provider turn start indeterminate"
            : "Provider turn start failed",
        detail,
        turnId: null,
        createdAt: entry.updatedAt,
        commandId: CommandId.make(`server:turn-dispatch-failure:${deterministicSuffix}`),
        activityId: EventId.make(`turn-dispatch-failure:${deterministicSuffix}`),
      });
      yield* turnDispatchJournal.markFinalized({
        dispatchId: entry.dispatchId,
        sequence: activity.sequence,
        updatedAt: entry.updatedAt,
      });
    },
  );

  const recordDurableTurnDispatchFailure = Effect.fn("recordDurableTurnDispatchFailure")(
    function* (input: {
      readonly entry: TurnDispatchJournalEntry;
      readonly state: "failed" | "indeterminate";
      readonly error: TurnDispatchError;
      readonly detail: string;
      readonly updatedAt: string;
    }) {
      const current = Option.getOrUndefined(
        yield* turnDispatchJournal.getByDispatchId({ dispatchId: input.entry.dispatchId }),
      );
      if (current === undefined || current.state === "started") return;
      if (current.state !== "failed" && current.state !== "indeterminate") {
        if (input.state === "indeterminate") {
          yield* turnDispatchJournal.markIndeterminate({
            dispatchId: current.dispatchId,
            error: input.error,
            updatedAt: input.updatedAt,
          });
        } else {
          yield* turnDispatchJournal.markFailed({
            dispatchId: current.dispatchId,
            error: input.error,
            updatedAt: input.updatedAt,
          });
        }
      }
      const terminal = Option.getOrUndefined(
        yield* turnDispatchJournal.getByDispatchId({ dispatchId: input.entry.dispatchId }),
      );
      if (terminal?.state === "failed" || terminal?.state === "indeterminate") {
        yield* finalizeDurableTurnDispatchFailure(terminal, input.detail);
      }
    },
  );

  const reconcileProviderInFlight = Effect.fn("reconcileProviderInFlight")(function* (
    entry: TurnDispatchJournalEntry,
  ) {
    const candidates = (yield* providerService.listSessions()).filter(
      (session) => session.threadId === entry.threadId,
    );
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (
      candidate !== undefined &&
      candidate.providerInstanceId === entry.providerInstanceId &&
      candidate.status === "running" &&
      candidate.activeTurnId !== undefined
    ) {
      yield* turnDispatchJournal.markStarted({
        dispatchId: entry.dispatchId,
        providerTurnId: candidate.activeTurnId,
        updatedAt: entry.updatedAt,
      });
      return;
    }
    yield* recordDurableTurnDispatchFailure({
      entry,
      state: "indeterminate",
      error: { code: "provider_recovery_unproven", summary: "Provider turn identity unproven" },
      detail: "The provider turn outcome could not be proven after recovery.",
      updatedAt: entry.updatedAt,
    });
  });

  type TurnStartRequestedEvent = Extract<
    ProviderIntentEvent,
    { type: "thread.turn-start-requested" }
  >;
  interface TurnDispatchWork {
    readonly entry: TurnDispatchJournalEntry;
    /** Raw title input is intentionally available only on the hot path. */
    readonly event?: TurnStartRequestedEvent;
  }

  const processTurnDispatch = Effect.fn("processTurnDispatch")(function* (work: TurnDispatchWork) {
    let entry = work.entry;

    if (entry.state === "started") return;
    if (entry.state === "failed" || entry.state === "indeterminate") {
      yield* finalizeDurableTurnDispatchFailure(
        entry,
        entry.error?.summary ?? "The provider turn did not start.",
      );
      return;
    }
    if (entry.state === "provider_in_flight") {
      yield* reconcileProviderInFlight(entry);
      return;
    }
    if (entry.sourceCommandId === null) {
      yield* recordDurableTurnDispatchFailure({
        entry,
        state: "failed",
        error: { code: "source_command_missing", summary: "Source command identity missing" },
        detail: "The accepted turn request is missing its source command identity.",
        updatedAt: entry.createdAt,
      });
      return;
    }

    if (entry.state === "awaiting_baseline") {
      const gated = yield* Effect.result(
        checkpointCoordinator.gateBaseline({
          sourceCommandId: entry.sourceCommandId,
          sourceEventId: entry.sourceEventId,
          projectId: entry.projectId,
          threadId: entry.threadId,
          messageId: entry.messageId,
          checkpointTurnCount: entry.checkpointTurnCount,
          createdAt: entry.createdAt,
        }),
      );
      if (Result.isFailure(gated)) {
        const code = isCheckpointCoordinatorBlockedError(gated.failure)
          ? gated.failure.code
          : "persistence_failure";
        if (retryableBaselineBlockCodes.has(code)) {
          yield* Effect.logWarning("baseline checkpoint remains retryable", {
            dispatchId: entry.dispatchId,
            providerInstanceId: entry.providerInstanceId,
            code,
          });
          return;
        }
        yield* recordDurableTurnDispatchFailure({
          entry,
          state: indeterminateBaselineBlockCodes.has(code) ? "indeterminate" : "failed",
          error: { code: `baseline_${code}`, summary: "Baseline checkpoint blocked" },
          detail: `Baseline checkpoint blocked (${code.replaceAll("_", " ")}).`,
          updatedAt: entry.createdAt,
        });
        return;
      }
      if (gated.success._tag === "NotApplicable") {
        yield* turnDispatchJournal.markBaselineNotApplicable({
          dispatchId: entry.dispatchId,
          reason:
            gated.success.reason === "not_repository" ? "not_repository" : "capability_unavailable",
          updatedAt: entry.createdAt,
        });
      } else {
        const identity = makeBaselineCheckpointIdentity({
          providerInstanceId: entry.providerInstanceId,
          threadId: entry.threadId,
          sourceCommandId: entry.sourceCommandId,
        });
        if (identity.logicalCheckpointId !== gated.success.logicalCheckpointId) {
          yield* recordDurableTurnDispatchFailure({
            entry,
            state: "failed",
            error: { code: "baseline_identity_mismatch", summary: "Baseline identity mismatch" },
            detail: "The baseline checkpoint identity did not match the accepted turn.",
            updatedAt: entry.createdAt,
          });
          return;
        }
        yield* turnDispatchJournal.markBaselineReady({
          dispatchId: entry.dispatchId,
          baselineLogicalCheckpointId: gated.success.logicalCheckpointId,
          baselineOperationId: identity.operationId,
          updatedAt: entry.createdAt,
        });
      }
      entry = Option.getOrThrow(
        yield* turnDispatchJournal.getByDispatchId({ dispatchId: entry.dispatchId }),
      );
    }

    const thread = yield* resolveThread(entry.threadId);
    const project = thread === undefined ? undefined : yield* resolveProject(thread.projectId);
    if (
      thread === undefined ||
      project === undefined ||
      thread.projectId !== entry.projectId ||
      project.providerInstanceId !== entry.providerInstanceId
    ) {
      yield* recordDurableTurnDispatchFailure({
        entry,
        state: "failed",
        error: { code: "turn_intent_unavailable", summary: "Turn intent unavailable" },
        detail: "The accepted provider turn intent could not be reconstructed exactly.",
        updatedAt: entry.createdAt,
      });
      return;
    }
    const message = thread.messages.find((message) => message.id === entry.messageId);
    if (message?.role !== "user") {
      yield* recordDurableTurnDispatchFailure({
        entry,
        state: "failed",
        error: { code: "turn_message_unavailable", summary: "Turn message unavailable" },
        detail: "The accepted user message is unavailable for provider dispatch.",
        updatedAt: entry.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((candidate) => candidate.role === "user").length === 1;
    if (work.event !== undefined && isFirstUserMessageTurn) {
      const generationCwd = resolveThreadWorkspaceCwd({ thread, projects: [project] });
      if (
        generationCwd !== undefined &&
        canReplaceThreadTitle(thread.title, work.event.payload.titleSeed)
      ) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: entry.threadId,
          cwd: generationCwd,
          providerInstanceId: entry.providerInstanceId,
          fallbackModelSelection: entry.modelSelection,
          messageText: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          ...(work.event.payload.titleSeed !== undefined
            ? { titleSeed: work.event.payload.titleSeed }
            : {}),
        });
      }
    }

    const preparedTurn = yield* Effect.result(
      buildSendTurnRequestForThread({
        threadId: entry.threadId,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        modelSelection: entry.modelSelection,
        interactionMode: entry.interactionMode,
        runtimeMode: entry.runtimeMode,
        createdAt: entry.createdAt,
      }),
    );
    if (Result.isFailure(preparedTurn)) {
      const detail = isProviderAdapterRequestError(preparedTurn.failure)
        ? preparedTurn.failure.detail
        : "The provider turn could not be prepared.";
      yield* recordDurableTurnDispatchFailure({
        entry,
        state: "failed",
        error: { code: "turn_prepare_failed", summary: "Provider turn preparation failed" },
        detail,
        updatedAt: entry.createdAt,
      });
      return;
    }

    yield* turnDispatchJournal.markProviderInFlight({
      dispatchId: entry.dispatchId,
      updatedAt: entry.createdAt,
    });
    entry = Option.getOrThrow(
      yield* turnDispatchJournal.getByDispatchId({ dispatchId: entry.dispatchId }),
    );
    const sent = yield* Effect.result(providerService.sendTurn(preparedTurn.success));
    if (Result.isFailure(sent) || sent.success.threadId !== entry.threadId) {
      yield* recordDurableTurnDispatchFailure({
        entry,
        state: "indeterminate",
        error: { code: "provider_turn_outcome_unknown", summary: "Provider turn outcome unknown" },
        detail: "The provider turn outcome could not be determined.",
        updatedAt: entry.createdAt,
      });
      return;
    }
    yield* turnDispatchJournal.markStarted({
      dispatchId: entry.dispatchId,
      providerTurnId: sent.success.turnId,
      updatedAt: entry.createdAt,
    });
  });

  const processTurnDispatchSafely = (work: TurnDispatchWork) =>
    processTurnDispatch(work).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning("provider command reactor failed to process durable turn", {
          dispatchId: work.entry.dispatchId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const turnDispatchWorker = yield* makeDrainableWorker(processTurnDispatchSafely);

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: TurnStartRequestedEvent,
  ) {
    const entry = Option.getOrUndefined(
      yield* turnDispatchJournal.getByIntent({ sourceEventId: event.eventId }),
    );
    if (entry === undefined) {
      return yield* Effect.die(
        `Durable turn dispatch '${event.eventId}' was not accepted before publication.`,
      );
    }
    yield* turnDispatchWorker.enqueue({ entry, event });
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const recover: ProviderCommandReactorShape["recover"] = Effect.fn(
    "ProviderCommandReactor.recover",
  )(function* (providerInstanceId) {
    yield* checkpointCoordinator.recover(providerInstanceId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("baseline checkpoint recovery remains blocked", {
          ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
          code: error.code,
        }),
      ),
    );
    let recoveryCursor:
      | { readonly createdAt: string; readonly dispatchId: TurnDispatchId }
      | undefined;
    let recoveryCount = 0;
    while (true) {
      const rows = yield* turnDispatchJournal
        .listRecovery({
          ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
          ...(recoveryCursor === undefined ? {} : { after: recoveryCursor }),
          limit: 500,
        })
        .pipe(Effect.orDie);
      recoveryCount += rows.length;
      yield* Effect.forEach(rows, (entry) => turnDispatchWorker.enqueue({ entry }), {
        discard: true,
      });
      const last = rows.at(-1);
      if (last === undefined || rows.length < 500) break;
      recoveryCursor = { createdAt: last.createdAt, dispatchId: last.dispatchId };
    }
    yield* Effect.logDebug("provider command reactor durable recovery queued").pipe(
      Effect.annotateLogs({
        ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
        recoveryCount,
      }),
    );
  });

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const isProviderIntentEvent = (event: OrchestrationEvent): event is ProviderIntentEvent =>
      (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
      event.type === "thread.runtime-mode-set" ||
      event.type === "thread.turn-start-requested" ||
      event.type === "thread.turn-interrupt-requested" ||
      event.type === "thread.approval-response-requested" ||
      event.type === "thread.user-input-response-requested" ||
      event.type === "thread.session-stop-requested";
    const processLiveEvent = Effect.fn("processLiveEvent")(function* (event: OrchestrationEvent) {
      if (!isProviderIntentEvent(event)) return;
      yield* worker.enqueue(event);
    });

    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processLiveEvent));

    yield* recover();

    // Correlated completions only clear the request captured here, leaving any
    // newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
    } else {
      yield* forkParked(clearInterrupted);
    }
  });

  return {
    start,
    recover,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* turnDispatchWorker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
