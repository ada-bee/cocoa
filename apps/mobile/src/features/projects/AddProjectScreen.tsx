import {
  buildProjectCreateCommand,
  canCreateProjectInEnvironment,
  findExistingAddProject,
  getAvailableProjectProviderInstances,
  getAddProjectInitialQuery,
  resolveProjectCreationProviderInstanceId,
  resolveAddProjectPath,
  resolveProjectCreationModelSelection,
} from "@t3tools/client-runtime/operations/projects";
import {
  connectionStatusText,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  appendFilesystemBrowseLeaf,
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowseInput,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  ensureBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
} from "@t3tools/client-runtime/state/projects";
import {
  CommandId,
  type EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Order from "effect/Order";
import { AsyncResult } from "effect/unstable/reactivity";
import { cn } from "../../lib/cn";

import { useProjects, useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useThemeColor } from "../../lib/useThemeColor";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import {
  resolveAddProjectEnvironment,
  resolveAddProjectProviderSelection,
} from "./AddProjectScreen.logic";

interface EnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
}

const environmentOptionOrder = Order.mapInput(
  Order.Struct({
    label: Order.String,
  }),
  (environment: EnvironmentOption) => ({ label: environment.label }),
);

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

function stringParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function providerInstanceParam(value: string | string[] | undefined): ProviderInstanceId | null {
  const instanceId = stringParam(value);
  return instanceId ? ProviderInstanceId.make(instanceId) : null;
}

function SectionTitle(props: { readonly children: string }) {
  return (
    <Text className="px-1 text-2xs font-t3-bold tracking-[0.7px] uppercase text-foreground-muted">
      {props.children}
    </Text>
  );
}

function AddProjectShell(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    // collapsable={false} is load-bearing: if this wrapper is flattened, the
    // ScrollView lands directly under RNSSafeAreaView and RNS's formSheet
    // scroll-view frame correction mistakes this full-height wrapper for a
    // "header" sibling, coercing the ScrollView to zero height (blank sheet
    // as soon as the sheet re-lays-out, e.g. when the keyboard opens).
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          gap: 10,
        }}
      >
        {props.children}
      </ScrollView>
    </View>
  );
}

function ListSection(props: { readonly children: ReactNode }) {
  return <View className="overflow-hidden rounded-[24px] bg-card">{props.children}</View>;
}

function ListRow(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly isFirst?: boolean;
  readonly right?: ReactNode;
  readonly onPress?: () => void;
}) {
  const chevronColor = useThemeColor("--color-chevron");

  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "bg-card px-3.5 py-2.5 active:opacity-70",
        !props.isFirst && "border-t border-border-subtle",
        props.disabled && "opacity-[0.45]",
      )}
    >
      <View className="flex-row items-center gap-3">
        <View
          className={
            props.selected
              ? "h-7 w-7 items-center justify-center rounded-full bg-primary"
              : "h-7 w-7 items-center justify-center"
          }
        >
          {props.icon}
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-base leading-snug font-t3-bold">{props.title}</Text>
          {props.subtitle ? (
            <Text className="text-sm leading-snug text-foreground-muted" numberOfLines={2}>
              {props.subtitle}
            </Text>
          ) : null}
        </View>
        {"right" in props ? (
          props.right
        ) : !props.disabled ? (
          <SymbolView name="chevron.right" size={13} tintColor={chevronColor} type="monochrome" />
        ) : null}
      </View>
    </Pressable>
  );
}

function PrimaryActionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress: () => void;
}) {
  const primaryForeground = useThemeColor("--color-primary-foreground");

  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-12 items-center justify-center rounded-full bg-primary active:opacity-70 disabled:opacity-45"
    >
      {props.loading ? (
        <ActivityIndicator color={String(primaryForeground)} />
      ) : (
        <Text className="text-base font-t3-bold text-primary-foreground">{props.label}</Text>
      )}
    </Pressable>
  );
}

function ProjectPathInput(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <TextInput
      className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
      value={props.value}
      onChangeText={props.onChangeText}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder="~/projects/my-app"
      returnKeyType="done"
      onSubmitEditing={props.onSubmit}
    />
  );
}

function useBrowsePathInput(
  environment: EnvironmentOption | null,
  providerInstanceId: ProviderInstanceId | null,
) {
  const environmentId = environment?.environmentId ?? null;
  const [pathInput, commitPathInput] = useState(() => getAddProjectInitialQuery(null));
  const providerTargetKey =
    environmentId && providerInstanceId ? `${environmentId}:${providerInstanceId}` : null;
  const previousProviderTargetKeyRef = useRef(providerTargetKey);
  const environmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const [browseNavigation] = useState(createBrowseNavigationCoordinator);
  const [isBrowseNavigating, setIsBrowseNavigating] = useState(false);
  const setPathInput = useCallback(
    (path: string) => {
      browseNavigation.invalidate();
      setIsBrowseNavigating(false);
      commitPathInput(path);
    },
    [browseNavigation],
  );
  const navigateToBrowsePath = useCallback(
    async (path: string) => {
      const input = providerInstanceId ? getFilesystemBrowseInput(providerInstanceId, path) : null;
      if (!input) return false;
      setIsBrowseNavigating(true);
      const committed = await browseNavigation.run(
        async () => {
          if (environment && canPreloadBrowsePath(environmentRuntime?.connectionState)) {
            await loadBrowsePath({
              environmentId: environment.environmentId,
              input,
            });
          }
        },
        () => commitPathInput(path),
      );
      if (committed) {
        setIsBrowseNavigating(false);
      }
      return committed;
    },
    [
      browseNavigation,
      environment,
      environmentRuntime?.connectionState,
      loadBrowsePath,
      providerInstanceId,
    ],
  );

  useEffect(() => {
    if (providerTargetKey !== previousProviderTargetKeyRef.current) {
      previousProviderTargetKeyRef.current = providerTargetKey;
      setPathInput(getAddProjectInitialQuery(null));
    }
  }, [providerTargetKey, setPathInput]);

  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
  );

  return { isBrowseNavigating, pathInput, setPathInput, navigateToBrowsePath };
}

function useProviderBrowse(
  environment: EnvironmentOption | null,
  providerInstanceId: ProviderInstanceId | null,
  pathInput: string,
) {
  const browsePath = useMemo(() => getFilesystemBrowsePath(pathInput), [pathInput]);
  const browseInput = useMemo(
    () =>
      providerInstanceId
        ? getFilesystemBrowseInput(providerInstanceId, browsePath.directoryPath)
        : null,
    [browsePath.directoryPath, providerInstanceId],
  );
  const browseState = useEnvironmentQuery(
    environment && browseInput
      ? filesystemEnvironment.browse({
          environmentId: environment.environmentId,
          input: browseInput,
        })
      : null,
  );
  const resolvedPath = useMemo(() => {
    const result = browseState.data;
    if (!result || !browsePath.locator) return null;
    if (hasTrailingPathSeparator(pathInput)) return result.directoryPath;
    const { exactEntry } = filterFilesystemBrowseEntries(result.entries, browsePath.filterQuery);
    return exactEntry ? appendFilesystemBrowseLeaf(result.directoryPath, exactEntry.name) : null;
  }, [browsePath.filterQuery, browsePath.locator, browseState.data, pathInput]);

  return { browsePath, browseState, resolvedPath };
}

function useEnvironmentOptions(): ReadonlyArray<EnvironmentOption> {
  const serverConfigByEnvironmentId = useServerConfigs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { connectedEnvironments } = useRemoteConnectionStatus();

  return useMemo<ReadonlyArray<EnvironmentOption>>(() => {
    const runtimeByEnvironmentId = new Map(
      connectedEnvironments.map((environment) => [environment.environmentId, environment] as const),
    );
    const options = Object.values(savedConnectionsById).map((connection) => {
      const config = serverConfigByEnvironmentId.get(connection.environmentId);
      const runtime = runtimeByEnvironmentId.get(connection.environmentId);
      const availableProviders = getAvailableProjectProviderInstances(config?.providers ?? []);
      return {
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        providers: availableProviders,
        connectionState: runtime?.connectionState ?? "available",
        connectionError: runtime?.connectionError ?? null,
        connectionErrorTraceId: runtime?.connectionErrorTraceId ?? null,
      };
    });
    return Arr.sort(options, environmentOptionOrder);
  }, [connectedEnvironments, savedConnectionsById, serverConfigByEnvironmentId]);
}

function useSelectedEnvironment(): {
  readonly environmentOptions: ReadonlyArray<EnvironmentOption>;
  readonly selectedEnvironment: EnvironmentOption | null;
  readonly setSelectedEnvironmentId: (environmentId: EnvironmentId) => void;
} {
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentOptions = useEnvironmentOptions();
  const selectedEnvironment =
    environmentOptions.find(
      (environment) =>
        environment.environmentId === selectedEnvironmentId &&
        canCreateProjectInEnvironment(environment.connectionState),
    ) ??
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ??
    null;

  return {
    environmentOptions,
    selectedEnvironment,
    setSelectedEnvironmentId,
  };
}

function EmptyEnvironmentState() {
  const navigation = useNavigation();

  return (
    <View className="items-center gap-3 rounded-2xl bg-card px-5 py-8">
      <Text className="text-center text-lg font-t3-bold">Environment unavailable</Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        Start or reconnect an environment before adding a project.
      </Text>
      <Pressable
        onPress={() => navigation.dispatch(StackActions.replace("ConnectionsNew"))}
        className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
      >
        <Text className="text-sm font-t3-bold text-primary-foreground">Add environment</Text>
      </Pressable>
    </View>
  );
}

export function AddProjectSourceScreen() {
  const navigation = useNavigation();
  const iconColor = useThemeColor("--color-icon");
  const { environmentOptions, selectedEnvironment, setSelectedEnvironmentId } =
    useSelectedEnvironment();
  const [selectedProviderTarget, setSelectedProviderTarget] = useState<{
    readonly environmentId: EnvironmentId;
    readonly providerInstanceId: ProviderInstanceId;
  } | null>(null);
  const providerSelection = selectedEnvironment
    ? resolveAddProjectProviderSelection(
        selectedEnvironment.providers,
        selectedProviderTarget?.environmentId === selectedEnvironment.environmentId
          ? selectedProviderTarget.providerInstanceId
          : null,
      )
    : null;
  const selectedProviderInstanceId = providerSelection?.selectedProviderInstanceId ?? null;
  useEffect(() => {
    if (!selectedProviderTarget) return;
    if (
      selectedEnvironment?.environmentId !== selectedProviderTarget.environmentId ||
      !selectedEnvironment.providers.some(
        (provider) => provider.instanceId === selectedProviderTarget.providerInstanceId,
      )
    ) {
      setSelectedProviderTarget(null);
    }
  }, [selectedEnvironment, selectedProviderTarget]);

  return (
    <AddProjectShell>
      {selectedEnvironment === null ? <EmptyEnvironmentState /> : null}

      {environmentOptions.length > 1 ? (
        <>
          <SectionTitle>Environments</SectionTitle>
          <ListSection>
            {environmentOptions.map((environment, index) => (
              <ListRow
                key={environment.environmentId}
                title={environment.label}
                subtitle={
                  canCreateProjectInEnvironment(environment.connectionState)
                    ? environment.environmentId
                    : connectionStatusText({
                        phase: environment.connectionState,
                        error: environment.connectionError,
                        traceId: environment.connectionErrorTraceId,
                      })
                }
                icon={
                  <SymbolView
                    name="server.rack"
                    size={17}
                    tintColor={iconColor}
                    type="monochrome"
                  />
                }
                selected={environment.environmentId === selectedEnvironment?.environmentId}
                disabled={!canCreateProjectInEnvironment(environment.connectionState)}
                isFirst={index === 0}
                right={
                  environment.environmentId === selectedEnvironment?.environmentId ? (
                    <SymbolView
                      name="checkmark"
                      size={14}
                      tintColor={iconColor}
                      type="monochrome"
                    />
                  ) : null
                }
                onPress={() => setSelectedEnvironmentId(environment.environmentId)}
              />
            ))}
          </ListSection>
        </>
      ) : null}

      {selectedEnvironment ? (
        <>
          {selectedEnvironment.providers.length > 1 ? (
            <>
              <SectionTitle>Codex endpoints</SectionTitle>
              <ListSection>
                {selectedEnvironment.providers.map((provider, index) => (
                  <ListRow
                    key={provider.instanceId}
                    title={provider.displayName ?? provider.instanceId}
                    subtitle={provider.instanceId}
                    icon={
                      <SymbolView
                        name="server.rack"
                        size={17}
                        tintColor={iconColor}
                        type="monochrome"
                      />
                    }
                    selected={provider.instanceId === selectedProviderInstanceId}
                    isFirst={index === 0}
                    right={
                      provider.instanceId === selectedProviderInstanceId ? (
                        <SymbolView
                          name="checkmark"
                          size={14}
                          tintColor={iconColor}
                          type="monochrome"
                        />
                      ) : null
                    }
                    onPress={() =>
                      setSelectedProviderTarget({
                        environmentId: selectedEnvironment.environmentId,
                        providerInstanceId: provider.instanceId,
                      })
                    }
                  />
                ))}
              </ListSection>
            </>
          ) : null}

          {selectedProviderInstanceId ? (
            <ListSection>
              <ListRow
                title="Local folder"
                subtitle="Browse a folder on disk"
                icon={
                  <SymbolView
                    name="folder.badge.plus"
                    size={17}
                    tintColor={iconColor}
                    type="monochrome"
                  />
                }
                isFirst
                onPress={() =>
                  navigation.navigate("NewTaskSheet", {
                    screen: "AddProjectLocal",
                    params: {
                      environmentId: selectedEnvironment.environmentId,
                      providerInstanceId: selectedProviderInstanceId,
                    },
                  })
                }
              />
            </ListSection>
          ) : (
            <Text className="px-1 text-sm text-foreground-muted">
              Choose the Codex endpoint that owns this workspace.
            </Text>
          )}
        </>
      ) : null}
    </AddProjectShell>
  );
}

function useCreateProject(
  environment: EnvironmentOption | null,
  preferredProviderInstanceId: ProviderInstanceId | null,
) {
  const navigation = useNavigation();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const projects = useProjects();

  return useCallback(
    async (workspaceRoot: string) => {
      if (!environment || !canCreateProjectInEnvironment(environment.connectionState)) return;
      if (
        !preferredProviderInstanceId ||
        !environment.providers.some(
          (provider) => provider.instanceId === preferredProviderInstanceId,
        )
      ) {
        Alert.alert("Endpoint unavailable", "Choose an available Codex endpoint and try again.");
        return;
      }
      const providerInstanceId = resolveProjectCreationProviderInstanceId(
        environment.providers,
        preferredProviderInstanceId,
      );
      if (!providerInstanceId) {
        Alert.alert("Choose a provider", "Select a Codex endpoint before adding this project.");
        return;
      }
      const defaultModelSelection = resolveProjectCreationModelSelection(
        environment.providers,
        providerInstanceId,
      );
      if (!defaultModelSelection) {
        Alert.alert(
          "Endpoint unavailable",
          "The selected Codex endpoint does not advertise a usable model.",
        );
        return;
      }

      const existing = findExistingAddProject({
        projects,
        environmentId: environment.environmentId,
        providerInstanceId,
        path: workspaceRoot,
      });
      if (existing) {
        Alert.alert("Project already exists", existing.title);
        navigation.dispatch(
          StackActions.replace("NewTaskDraft", {
            environmentId: existing.environmentId,
            projectId: existing.id,
            title: existing.title,
          }),
        );
        return;
      }

      const projectId = ProjectId.make(uuidv4());
      const command = buildProjectCreateCommand({
        commandId: CommandId.make(uuidv4()),
        projectId,
        providerInstanceId,
        defaultModelSelection,
        workspaceRoot,
        createdAt: new Date().toISOString(),
      });
      const result = await createProject({
        environmentId: environment.environmentId,
        input: command,
      });
      if (AsyncResult.isFailure(result)) {
        return result;
      }
      navigation.dispatch(
        StackActions.replace("NewTaskDraft", {
          environmentId: environment.environmentId,
          projectId,
          title: inferProjectTitleFromPath(workspaceRoot),
        }),
      );
      return result;
    },
    [createProject, environment, navigation, preferredProviderInstanceId, projects],
  );
}

function useEnvironmentFromParam(
  environmentIdParam: string | string[] | undefined,
): EnvironmentOption | null {
  const environmentOptions = useEnvironmentOptions();
  const environmentId = stringParam(environmentIdParam) as EnvironmentId | null;
  return resolveAddProjectEnvironment(environmentOptions, environmentId);
}

export function AddProjectRepositoryScreen(props: {
  readonly environmentId?: string | string[];
  readonly providerInstanceId?: string | string[];
  readonly source?: string | string[];
}) {
  void props;
  return (
    <AddProjectShell>
      <ErrorBanner message="Remote cloning is unavailable until source control runs on the selected Codex endpoint." />
    </AddProjectShell>
  );
}

function FolderBrowser(props: {
  readonly browser: ReturnType<typeof useProviderBrowse>;
  readonly pathInput: string;
  readonly navigateToBrowsePath: (path: string) => Promise<boolean>;
}) {
  const accentColor = useThemeColor("--color-icon-muted");
  const { browsePath, browseState } = props.browser;
  const { visibleEntries: visibleBrowseEntries } = useMemo(
    () => filterFilesystemBrowseEntries(browseState.data?.entries ?? [], browsePath.filterQuery),
    [browsePath.filterQuery, browseState.data?.entries],
  );

  return (
    <>
      <SectionTitle>Browse folders</SectionTitle>
      {browseState.error ? <ErrorBanner message={browseState.error} /> : null}
      <ListSection>
        {browseState.isPending && browseState.data === null ? (
          <View className="items-center py-5">
            <ActivityIndicator color={accentColor} />
          </View>
        ) : null}
        {browseState.data?.parentPath ? (
          <ListRow
            title=".."
            icon={
              <SymbolView
                name="arrow.turn.left.up"
                size={17}
                tintColor={accentColor}
                type="monochrome"
              />
            }
            isFirst
            right={null}
            onPress={() => {
              if (browseState.data?.parentPath) {
                void props.navigateToBrowsePath(
                  ensureBrowseDirectoryPath(browseState.data.parentPath),
                );
              }
            }}
          />
        ) : null}
        {visibleBrowseEntries.map((entry, index) => (
          <ListRow
            key={entry.name}
            title={entry.name}
            icon={<SymbolView name="folder" size={17} tintColor={accentColor} type="monochrome" />}
            isFirst={index === 0 && !browseState.data?.parentPath}
            right={null}
            onPress={() => {
              const nextPath = browseState.data
                ? appendFilesystemBrowseLeaf(browseState.data.directoryPath, entry.name)
                : null;
              if (nextPath) void props.navigateToBrowsePath(ensureBrowseDirectoryPath(nextPath));
            }}
          />
        ))}
      </ListSection>
    </>
  );
}

export function AddProjectLocalFolderScreen(props: {
  readonly environmentId?: string | string[];
  readonly providerInstanceId?: string | string[];
}) {
  const environment = useEnvironmentFromParam(props.environmentId);
  const providerInstanceId = providerInstanceParam(props.providerInstanceId);
  const createProject = useCreateProject(environment, providerInstanceId);
  const { isBrowseNavigating, navigateToBrowsePath, pathInput, setPathInput } = useBrowsePathInput(
    environment,
    providerInstanceId,
  );
  const browser = useProviderBrowse(environment, providerInstanceId, pathInput);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitPath = useCallback(async () => {
    if (!environment || isBrowseNavigating || isSubmitting) return;
    setError(null);
    const resolved = resolveAddProjectPath({ rawPath: browser.resolvedPath ?? "" });
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }

    setIsSubmitting(true);
    const result = await createProject(resolved.path);
    if (result && AsyncResult.isFailure(result)) {
      setError(errorMessage(Cause.squash(result.cause)));
    }
    setIsSubmitting(false);
  }, [browser.resolvedPath, createProject, environment, isBrowseNavigating, isSubmitting]);

  return (
    <AddProjectShell>
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        <>
          <ProjectPathInput
            value={pathInput}
            onChangeText={setPathInput}
            onSubmit={() => void submitPath()}
          />
          <PrimaryActionButton
            label="Add project"
            disabled={isBrowseNavigating || isSubmitting}
            onPress={() => void submitPath()}
            loading={isSubmitting}
          />
          <FolderBrowser
            browser={browser}
            navigateToBrowsePath={navigateToBrowsePath}
            pathInput={pathInput}
          />
        </>
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}

export function AddProjectDestinationScreen(props: {
  readonly environmentId?: string | string[];
  readonly providerInstanceId?: string | string[];
  readonly remoteUrl?: string | string[];
  readonly repositoryTitle?: string | string[];
}) {
  void props;
  return (
    <AddProjectShell>
      <ErrorBanner message="Remote cloning is unavailable until source control runs on the selected Codex endpoint." />
    </AddProjectShell>
  );
}
