import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProviderSkill,
  VcsRef,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";

import {
  useEnvironmentServerConfig,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import type { TurnCommandMetadata } from "../../lib/commandMetadata";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveProjectModelSelection,
  resolveSelectableModelSelection,
} from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  appendComposerDraftAttachments,
  clearComposerDraft,
  getComposerDraftSnapshot,
  isComposerDraftEmpty,
  removeComposerDraftAttachment,
  replaceComposerDraftAttachments,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { useBranches } from "../../state/queries";
import {
  flattenQueuedThreadMessages,
  threadOutboxManager,
  updateThreadOutboxMessage,
  type QueuedThreadMessage,
} from "../../state/thread-outbox";
import {
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
  useThreadOutboxMessages,
} from "../../state/use-thread-outbox";
import {
  setPendingConnectionError,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectScope,
} from "../home/homeThreadList";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  findNewTaskPhysicalProject,
  flattenNewTaskPhysicalProjects,
  newTaskPhysicalProjectKey,
  newTaskPhysicalProjectKeyFor,
  newTaskProviderLabel,
  projectsHostingNewTaskRepository,
} from "./newTaskProjectSelection";

type WorkspaceMode = "local" | "worktree";

const EMPTY_BRANCH_REFS: ReadonlyArray<VcsRef> = [];

function pendingTaskDraftKey(messageId: string): string {
  return `pending-task:${messageId}`;
}

// The message id owned by the currently active editing session, tracked
// across provider instances. An in-flight flush from a dismissed session
// consults it so it never drops the draft or releases the drain lock out from
// under a newer session editing the same task.
let activeEditingMessageId: string | null = null;

function findQueuedPendingTask(messageId: string): QueuedThreadMessage | null {
  const message = flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).find((candidate) => candidate.messageId === messageId);
  return message?.creation !== undefined ? message : null;
}

function normalizeSelectedWorktreePath(project: EnvironmentProject, branch: VcsRef): string | null {
  if (!branch.worktreePath) {
    return null;
  }

  return branch.worktreePath === project.workspaceRoot ? null : branch.worktreePath;
}

export function branchBadgeLabel(input: {
  readonly branch: VcsRef;
  readonly project: EnvironmentProject | null;
}): string | null {
  if (input.branch.current) {
    return "current";
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot) {
    return "worktree";
  }
  if (input.branch.isDefault) {
    return "default";
  }
  if (input.branch.isRemote) {
    return "remote";
  }
  return null;
}

type NewTaskFlowContextValue = {
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly logicalProjects: ReadonlyArray<{
    readonly key: string;
    readonly project: EnvironmentProject;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModelKey: string | null;
  readonly workspaceMode: WorkspaceMode;
  readonly selectedBranchName: string | null;
  readonly selectedWorktreePath: string | null;
  readonly startFromOrigin: boolean;
  readonly draftKey: string | null;
  readonly editingPendingTask: QueuedThreadMessage | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly submitting: boolean;
  readonly branchQuery: string;
  readonly branchesLoading: boolean;
  readonly availableBranches: ReadonlyArray<VcsRef>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly key: string;
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly providerLabel: string;
  }>;
  readonly selectedProject: EnvironmentProject | null;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly selectedProviderSkills: ReadonlyArray<ServerProviderSkill>;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly filteredBranches: ReadonlyArray<VcsRef>;
  readonly reset: () => void;
  readonly setProject: (project: EnvironmentProject) => void;
  readonly selectEnvironment: (projectKey: string) => void;
  readonly setSelectedModelKey: (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
  readonly setWorkspaceMode: (mode: WorkspaceMode) => void;
  readonly selectBranch: (branch: VcsRef) => void;
  readonly setStartFromOrigin: (value: boolean) => void;
  readonly beginEditingPendingTask: (messageId: string) => boolean;
  readonly finishEditingPendingTask: () => void;
  readonly cancelEditingPendingTask: () => void;
  readonly buildPendingTaskMessage: (metadata: TurnCommandMetadata) => QueuedThreadMessage | null;
  readonly setPrompt: (value: string) => void;
  readonly replaceAttachments: (attachments: ReadonlyArray<DraftComposerImageAttachment>) => void;
  readonly appendAttachments: (attachments: ReadonlyArray<DraftComposerImageAttachment>) => void;
  readonly removeAttachment: (imageId: string) => void;
  readonly clearAttachments: () => void;
  readonly setSubmitting: (value: boolean) => void;
  readonly setBranchQuery: (value: string) => void;
  readonly loadBranches: () => Promise<void>;
  readonly setRuntimeMode: (value: RuntimeMode) => void;
  readonly setInteractionMode: (value: ProviderInteractionMode) => void;
  readonly setSelectedModelOptions: (
    value: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(props: React.PropsWithChildren) {
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const groupingSettings = useMobileProjectGroupingSettings();

  const projectScopes = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: buildHomeProjectScopes({
          projects,
          environmentId: null,
          projectGroupingMode: groupingSettings.sidebarProjectGroupingMode,
        }),
        threads,
        pendingTasks: [],
        projectSortOrder: "updated_at",
      }),
    [groupingSettings.sidebarProjectGroupingMode, projects, threads],
  );
  const logicalProjects = useMemo(
    () => flattenNewTaskPhysicalProjects(projectScopes),
    [projectScopes],
  );

  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingPendingTask, setEditingPendingTask] = useState<QueuedThreadMessage | null>(null);
  // Mirrors `editingPendingTask` synchronously so the unmount flush cannot act
  // on a task whose editing session already ended this render.
  const editingPendingTaskRef = useRef<QueuedThreadMessage | null>(null);

  const reset = useCallback(() => {
    setSelectedProjectKey(null);
    setSubmitting(false);
    setBranchQuery("");
    setExpandedProvider(null);
    const editing = editingPendingTaskRef.current;
    editingPendingTaskRef.current = null;
    setEditingPendingTask(null);
    if (editing) {
      if (activeEditingMessageId === editing.messageId) {
        activeEditingMessageId = null;
      }
      releaseEditingQueuedMessage(editing.messageId);
    }
  }, []);

  // Stand-in for the edited task's project while its shell is not loaded
  // (environment offline / still synchronizing), built from the metadata
  // snapshotted at enqueue time.
  const editingPendingProject = useMemo<EnvironmentProject | null>(() => {
    const creation = editingPendingTask?.creation;
    if (!editingPendingTask || !creation) {
      return null;
    }
    const providerInstanceId = editingPendingTask.modelSelection?.instanceId;
    if (!providerInstanceId) return null;
    return {
      environmentId: editingPendingTask.environmentId,
      id: creation.projectId,
      providerInstanceId,
      title: creation.projectTitle ?? "Unknown project",
      // Deliberately empty when the snapshot has no cwd — downstream consumers
      // (branch queries, worktree bootstrap) must skip it, not receive a
      // fabricated path.
      workspaceRoot: creation.projectCwd ?? "",
      repositoryIdentity: null,
      defaultModelSelection: editingPendingTask.modelSelection ?? null,
      scripts: [],
      createdAt: editingPendingTask.createdAt,
      updatedAt: editingPendingTask.createdAt,
    };
  }, [editingPendingTask]);

  const selectedProject =
    findNewTaskPhysicalProject(projects, selectedProjectKey) ??
    // While editing a queued task whose project shell is absent, keep the task
    // pinned to its own project — falling through to an arbitrary first
    // project would silently retarget it (and its reused turn identifiers).
    (editingPendingProject !== null &&
    selectedProjectKey === newTaskPhysicalProjectKeyFor(editingPendingProject)
      ? editingPendingProject
      : null);
  const selectedEnvironmentId = selectedProject?.environmentId ?? null;

  // Only offer machines that actually host the currently selected repository, so
  // switching computers moves the same repo across machines instead of jumping to
  // whatever unrelated project happens to be first on the other machine. Repository
  // identity is the primary signal; projects that haven't reported one yet (still
  // indexing) fall back to workspace basename / title so a valid host isn't hidden.
  const environments = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
      readonly providerLabel: string;
    }> = [];
    for (const project of projectsHostingNewTaskRepository(projects, selectedProject)) {
      const key = newTaskPhysicalProjectKeyFor(project);
      if (seen.has(key)) {
        continue;
      }
      const environment = savedConnectionsById[project.environmentId];
      if (!environment) {
        continue;
      }
      seen.add(key);
      result.push({
        key,
        environmentId: project.environmentId,
        environmentLabel: environment.environmentLabel,
        providerLabel: newTaskProviderLabel(serverConfigs, project),
      });
    }
    return result;
  }, [projects, savedConnectionsById, selectedProject, serverConfigs]);

  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(
    selectedProject?.environmentId ?? null,
  );
  // While a queued pending task is being edited its draft lives under a key
  // scoped to the queued message, so per-project new-task drafts stay intact.
  const selectedProjectDraftKey = editingPendingTask
    ? pendingTaskDraftKey(editingPendingTask.messageId)
    : selectedProject
      ? `new-task:${newTaskPhysicalProjectKeyFor(selectedProject)}`
      : null;
  const selectedProjectDraft = useComposerDraft(selectedProjectDraftKey);
  const prompt = selectedProjectDraft.text;
  const attachments = selectedProjectDraft.attachments;
  // The server's configured default decides the mode until the user picks one
  // explicitly — same resolution web uses for new draft threads.
  const defaultWorkspaceMode: WorkspaceMode =
    selectedEnvironmentServerConfig?.settings.defaultThreadEnvMode ?? "local";
  const workspaceMode = selectedProjectDraft.workspaceSelection?.mode ?? defaultWorkspaceMode;
  const selectedBranchName = selectedProjectDraft.workspaceSelection?.branch ?? null;
  const selectedWorktreePath = selectedProjectDraft.workspaceSelection?.worktreePath ?? null;
  // Keep the user's explicit choice separate from the resolved display value:
  // only the explicit flag is ever written back to the draft, so the resolved
  // value keeps tracking the server setting when the config loads late.
  const draftStartFromOrigin = selectedProjectDraft.workspaceSelection?.startFromOrigin;
  const startFromOrigin =
    draftStartFromOrigin ??
    selectedEnvironmentServerConfig?.settings.newWorktreesStartFromOrigin ??
    true;
  const runtimeMode = selectedProjectDraft.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = selectedProjectDraft.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;

  // Stored selections only count while their provider is usable on the
  // server; otherwise the server's default model wins instead of silently
  // targeting a disabled provider. The draft selection is an explicit pick
  // and passes through as-is; the project default is implicit and additionally
  // never resolves to a legacy model.
  const draftModelSelection = resolveSelectableModelSelection(
    selectedEnvironmentServerConfig,
    selectedProjectDraft.modelSelection ?? null,
    selectedProject?.providerInstanceId,
  );
  const projectDefaultModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    selectedProject?.defaultModelSelection ?? null,
    selectedProject?.providerInstanceId,
  );
  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        selectedEnvironmentServerConfig,
        draftModelSelection ?? projectDefaultModelSelection,
        selectedProject?.providerInstanceId,
      ),
    [
      selectedEnvironmentServerConfig,
      draftModelSelection,
      projectDefaultModelSelection,
      selectedProject?.providerInstanceId,
    ],
  );

  const selectedModel =
    draftModelSelection ??
    projectDefaultModelSelection ??
    modelOptions.find((option) => option.isDefault)?.selection ??
    modelOptions[0]?.selection ??
    null;
  const selectedModelKey = selectedModel
    ? `${selectedModel.instanceId}:${selectedModel.model}`
    : null;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.instanceId === selectedModel.instanceId &&
        option.selection.model === selectedModel.model,
    ) ?? null;
  const selectedProviderSkills = useMemo(
    () =>
      selectedEnvironmentServerConfig?.providers.find(
        (provider) => provider.instanceId === selectedModel?.instanceId,
      )?.skills ?? [],
    [selectedEnvironmentServerConfig, selectedModel?.instanceId],
  );
  const setSelectedModelKey = useCallback(
    // Options ride along in the same write: a follow-up setSelectedModelOptions
    // call would rebuild the selection from the stale pre-switch model.
    (key: string | null, options?: ReadonlyArray<ProviderOptionSelection>) => {
      if (!key || !selectedProjectDraftKey) {
        return;
      }
      const option = modelOptions.find((candidate) => candidate.key === key);
      if (!option) {
        return;
      }
      updateComposerDraftSettings(selectedProjectDraftKey, {
        modelSelection: options ? { ...option.selection, options } : option.selection,
      });
    },
    [modelOptions, selectedProjectDraftKey],
  );
  const setSelectedModelOptions = useCallback(
    (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
      if (!selectedModel || !selectedProjectDraftKey) {
        return;
      }
      const nextSelection: ModelSelection = options
        ? { ...selectedModel, options }
        : {
            instanceId: selectedModel.instanceId,
            model: selectedModel.model,
          };
      updateComposerDraftSettings(selectedProjectDraftKey, {
        modelSelection: nextSelection,
      });
    },
    [selectedModel, selectedProjectDraftKey],
  );

  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const setPrompt = useCallback(
    (value: string) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      setComposerDraftText(selectedProjectDraftKey, value);
    },
    [selectedProjectDraftKey],
  );
  const replaceAttachments = useCallback(
    (nextAttachments: ReadonlyArray<DraftComposerImageAttachment>) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      replaceComposerDraftAttachments(selectedProjectDraftKey, nextAttachments);
    },
    [selectedProjectDraftKey],
  );
  const appendAttachments = useCallback(
    (nextAttachments: ReadonlyArray<DraftComposerImageAttachment>) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      appendComposerDraftAttachments(selectedProjectDraftKey, nextAttachments);
    },
    [selectedProjectDraftKey],
  );
  const removeAttachment = useCallback(
    (imageId: string) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      removeComposerDraftAttachment(selectedProjectDraftKey, imageId);
    },
    [selectedProjectDraftKey],
  );
  const clearAttachments = useCallback(() => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, []);
  }, [selectedProjectDraftKey]);
  const branchTarget = useMemo(
    () => ({
      environmentId: selectedProject?.environmentId ?? null,
      target: selectedProject === null ? null : { projectId: selectedProject.id },
      query: null,
    }),
    [selectedProject],
  );
  const branchState = useBranches(branchTarget);
  const branchesLoading = branchState.isPending;
  const allBranchRefs = branchState.data?.refs ?? EMPTY_BRANCH_REFS;
  const availableBranches = useMemo(
    () =>
      pipe(
        allBranchRefs,
        Arr.filter((branch) => !branch.isRemote),
      ),
    [allBranchRefs],
  );

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase();
    if (query.length === 0) {
      return availableBranches;
    }

    return pipe(
      availableBranches,
      Arr.filter((branch) => branch.name.toLowerCase().includes(query)),
    );
  }, [availableBranches, branchQuery]);

  const setProject = useCallback((project: EnvironmentProject) => {
    setSelectedProjectKey(newTaskPhysicalProjectKeyFor(project));
  }, []);

  const selectEnvironment = useCallback(
    (projectKey: string) => {
      const project = findNewTaskPhysicalProject(projects, projectKey);
      if (project) {
        setProject(project);
      }
    },
    [projects, setProject],
  );

  const setWorkspaceMode = useCallback(
    (mode: WorkspaceMode) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      updateComposerDraftSettings(selectedProjectDraftKey, {
        workspaceSelection: {
          mode,
          branch: selectedBranchName,
          worktreePath: selectedWorktreePath,
          ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
        },
      });
    },
    [draftStartFromOrigin, selectedBranchName, selectedProjectDraftKey, selectedWorktreePath],
  );

  const selectBranch = useCallback(
    (branch: VcsRef) => {
      if (!selectedProject || !selectedProjectDraftKey) {
        return;
      }
      updateComposerDraftSettings(selectedProjectDraftKey, {
        workspaceSelection: {
          mode: workspaceMode,
          branch: branch.name,
          worktreePath: normalizeSelectedWorktreePath(selectedProject, branch),
          ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
        },
      });
    },
    [draftStartFromOrigin, selectedProject, selectedProjectDraftKey, workspaceMode],
  );

  const setStartFromOrigin = useCallback(
    (value: boolean) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      updateComposerDraftSettings(selectedProjectDraftKey, {
        workspaceSelection: {
          mode: workspaceMode,
          branch: selectedBranchName,
          worktreePath: selectedWorktreePath,
          startFromOrigin: value,
        },
      });
    },
    [selectedBranchName, selectedProjectDraftKey, selectedWorktreePath, workspaceMode],
  );

  const refreshBranches = branchState.refresh;
  const loadBranches = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    setPendingConnectionError(null);
    refreshBranches();
  }, [refreshBranches, selectedProject]);

  useEffect(() => {
    if (workspaceMode !== "worktree" || selectedBranchName !== null) {
      return;
    }
    // The default may only exist as origin/<default> (isRemote), which
    // availableBranches filters out — search the unfiltered refs for it.
    const preferredBranch =
      allBranchRefs.find((branch) => branch.isDefault) ??
      availableBranches.find((branch) => branch.current) ??
      null;
    if (preferredBranch) {
      selectBranch(preferredBranch);
    }
  }, [allBranchRefs, availableBranches, selectBranch, selectedBranchName, workspaceMode]);

  const setRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (selectedProjectDraftKey) {
        updateComposerDraftSettings(selectedProjectDraftKey, { runtimeMode: value });
      }
    },
    [selectedProjectDraftKey],
  );
  const setInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (selectedProjectDraftKey) {
        updateComposerDraftSettings(selectedProjectDraftKey, { interactionMode: value });
      }
    },
    [selectedProjectDraftKey],
  );

  const beginEditingPendingTask = useCallback(
    (messageId: string): boolean => {
      const message = findQueuedPendingTask(messageId);
      if (!message?.creation) {
        return false;
      }
      const draftKey = pendingTaskDraftKey(message.messageId);
      // Only hydrate a fresh editing draft; reopening mid-edit keeps newer edits.
      if (isComposerDraftEmpty(getComposerDraftSnapshot(draftKey))) {
        setComposerDraftText(draftKey, message.text);
        replaceComposerDraftAttachments(draftKey, message.attachments);
        updateComposerDraftSettings(draftKey, {
          modelSelection: message.modelSelection,
          runtimeMode: message.runtimeMode,
          interactionMode: message.interactionMode,
          workspaceSelection: {
            mode: message.creation.workspaceMode,
            branch: message.creation.branch,
            worktreePath: message.creation.worktreePath,
            startFromOrigin: message.creation.startFromOrigin ?? false,
          },
        });
      }
      const loadedProject = projects.find(
        (project) =>
          project.environmentId === message.environmentId &&
          project.id === message.creation?.projectId,
      );
      const providerInstanceId =
        loadedProject?.providerInstanceId ?? message.modelSelection?.instanceId;
      if (!providerInstanceId) {
        return false;
      }
      setSelectedProjectKey(
        newTaskPhysicalProjectKey({
          environmentId: message.environmentId,
          projectId: message.creation.projectId,
          providerInstanceId,
        }),
      );
      activeEditingMessageId = message.messageId;
      editingPendingTaskRef.current = message;
      setEditingPendingTask(message);
      // Hold the outbox drain off this task while it is open in the editor.
      holdEditingQueuedMessage(message.messageId);
      return true;
    },
    [projects],
  );

  const buildPendingTaskMessage = useCallback(
    (metadata: TurnCommandMetadata): QueuedThreadMessage | null => {
      if (!selectedProject || !selectedProjectDraftKey) {
        return null;
      }
      const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
      const text = draft.text.trim();
      // Same availability gate the composer display applies: a stored
      // selection targeting a disabled provider must not ride into the queue.
      const draftModelSelection = resolveProjectModelSelection(
        selectedEnvironmentServerConfig,
        selectedProject.providerInstanceId,
        [draft.modelSelection ?? null, selectedModel],
      );
      if (text.length === 0 || !draftModelSelection) {
        return null;
      }
      const workspaceSelection = draft.workspaceSelection;
      // Fall back to the resolved mode (server default) so queued tasks drain
      // with the same mode the composer displayed.
      const mode = workspaceSelection?.mode ?? workspaceMode;
      // When the selection is the stand-in built from the queued snapshot,
      // persist the original (possibly absent) snapshot values — the
      // stand-in's placeholder title/workspaceRoot must never be written back
      // as if they were real project metadata.
      const usingPendingSnapshot = selectedProject === editingPendingProject;
      const projectTitle = usingPendingSnapshot
        ? editingPendingTask?.creation?.projectTitle
        : selectedProject.title;
      const projectCwd = usingPendingSnapshot
        ? editingPendingTask?.creation?.projectCwd
        : selectedProject.workspaceRoot;
      return {
        environmentId: selectedProject.environmentId,
        threadId: ThreadId.make(metadata.threadId),
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments: draft.attachments,
        modelSelection: draftModelSelection,
        runtimeMode: draft.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: draft.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        creation: {
          projectId: selectedProject.id,
          ...(projectTitle !== undefined ? { projectTitle } : {}),
          ...(projectCwd !== undefined ? { projectCwd } : {}),
          workspaceMode: mode,
          branch: workspaceSelection?.branch ?? null,
          worktreePath: mode === "worktree" ? null : (workspaceSelection?.worktreePath ?? null),
          // The draft only carries the flag when the user touched it; fall
          // back to the resolved default (server settings) so queued tasks
          // drain with the same origin mode the composer displayed.
          ...((workspaceSelection?.startFromOrigin ?? startFromOrigin)
            ? { startFromOrigin: true }
            : {}),
        },
        createdAt: metadata.createdAt,
      };
    },
    [
      editingPendingProject,
      editingPendingTask,
      selectedEnvironmentServerConfig,
      selectedModel,
      selectedProject,
      selectedProjectDraftKey,
      startFromOrigin,
      workspaceMode,
    ],
  );

  const finishEditingPendingTask = useCallback(() => {
    const editing = editingPendingTaskRef.current;
    editingPendingTaskRef.current = null;
    if (editing) {
      if (activeEditingMessageId === editing.messageId) {
        activeEditingMessageId = null;
      }
      clearComposerDraft(pendingTaskDraftKey(editing.messageId));
      releaseEditingQueuedMessage(editing.messageId);
    }
    setEditingPendingTask(null);
  }, []);

  // If the queued task disappears mid-edit (deleted from the list, or
  // delivered), end the editing session immediately without saving — a later
  // flush must not resurrect it, and the composer should fall back to the
  // regular per-project draft.
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  useEffect(() => {
    const editing = editingPendingTaskRef.current;
    if (!editing) {
      return;
    }
    const stillQueued = flattenQueuedThreadMessages(queuedMessagesByThreadKey).some(
      (candidate) => candidate.messageId === editing.messageId,
    );
    if (!stillQueued) {
      finishEditingPendingTask();
    }
  }, [finishEditingPendingTask, queuedMessagesByThreadKey]);

  // Leaving the flow mid-edit (sheet dismissed or draft screen popped) saves
  // the current edits back into the queued task so nothing typed here is lost.
  const editingFlushRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    editingFlushRef.current = () => {
      const editing = editingPendingTaskRef.current;
      if (!editing) {
        return;
      }
      editingPendingTaskRef.current = null;
      setEditingPendingTask(null);
      if (activeEditingMessageId === editing.messageId) {
        activeEditingMessageId = null;
      }

      const message = buildPendingTaskMessage({
        threadId: editing.threadId,
        commandId: editing.commandId,
        messageId: editing.messageId,
        createdAt: editing.createdAt,
      });

      if (!message) {
        // The edits are currently unsendable (e.g. the prompt was cleared).
        // Keep both the draft and the drain lock: the stale queued payload
        // must not auto-send content the user just removed, and reopening the
        // task resumes from the saved draft.
        return;
      }

      // update() rewrites the task only if it is still queued — a concurrent
      // delete or delivery wins, so the flush cannot resurrect it.
      void updateThreadOutboxMessage(message)
        .then(() => {
          // If this task was reopened (possibly in a fresh provider) while
          // the save was in flight, that session owns the draft and the lock.
          if (activeEditingMessageId === editing.messageId) {
            return;
          }
          clearComposerDraft(pendingTaskDraftKey(editing.messageId));
          releaseEditingQueuedMessage(editing.messageId);
        })
        .catch((error) => {
          // Keep the drain lock and the draft: delivering the stale payload
          // would silently drop the newer edits. Reopening the task retries.
          console.warn("[new-task] failed to save edited pending task", error);
        });
    };
  }, [buildPendingTaskMessage]);
  const cancelEditingPendingTask = useCallback(() => {
    editingFlushRef.current?.();
  }, []);
  useEffect(
    () => () => {
      editingFlushRef.current?.();
    },
    [],
  );

  const value = useMemo<NewTaskFlowContextValue>(
    () => ({
      projectScopes,
      logicalProjects,
      selectedEnvironmentId,
      selectedProjectKey,
      selectedModelKey,
      workspaceMode,
      selectedBranchName,
      selectedWorktreePath,
      startFromOrigin,
      draftKey: selectedProjectDraftKey,
      editingPendingTask,
      prompt,
      attachments,
      submitting,
      branchQuery,
      branchesLoading,
      availableBranches,
      runtimeMode,
      interactionMode,
      expandedProvider,
      environments,
      selectedProject,
      modelOptions,
      selectedModel,
      selectedModelOption,
      selectedProviderSkills,
      providerGroups,
      filteredBranches,
      reset,
      setProject,
      selectEnvironment,
      setSelectedModelKey,
      setWorkspaceMode,
      selectBranch,
      setStartFromOrigin,
      beginEditingPendingTask,
      finishEditingPendingTask,
      cancelEditingPendingTask,
      buildPendingTaskMessage,
      setPrompt,
      replaceAttachments,
      appendAttachments,
      removeAttachment,
      clearAttachments,
      setSubmitting,
      setBranchQuery,
      loadBranches,
      setRuntimeMode,
      setInteractionMode,
      setSelectedModelOptions,
      setExpandedProvider,
    }),
    [
      attachments,
      availableBranches,
      beginEditingPendingTask,
      branchQuery,
      branchesLoading,
      buildPendingTaskMessage,
      cancelEditingPendingTask,
      editingPendingTask,
      environments,
      expandedProvider,
      filteredBranches,
      finishEditingPendingTask,
      interactionMode,
      loadBranches,
      projectScopes,
      logicalProjects,
      modelOptions,
      prompt,
      providerGroups,
      replaceAttachments,
      reset,
      runtimeMode,
      selectedBranchName,
      selectedEnvironmentId,
      selectedModel,
      selectedModelKey,
      selectedModelOption,
      selectedProjectDraftKey,
      selectedProviderSkills,
      setSelectedModelOptions,
      selectedProject,
      selectedProjectKey,
      selectedWorktreePath,
      setProject,
      selectBranch,
      selectEnvironment,
      setInteractionMode,
      setPrompt,
      setRuntimeMode,
      setSelectedModelKey,
      setStartFromOrigin,
      setWorkspaceMode,
      startFromOrigin,
      submitting,
      workspaceMode,
      appendAttachments,
      clearAttachments,
      removeAttachment,
    ],
  );

  return <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>;
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}
