import { useAtomValue } from "@effect/atom-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderHostConfig,
  type ProviderHostId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import { ChevronDownIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionStateForInstance,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { ProviderHostIconGlyph } from "../ProviderHostIcon";
import { ProviderHostAppearanceDialog } from "./ProviderHostAppearanceDialog";
import { ProviderHostSourceControlSettings } from "./SourceControlSettings";
import { getDriverOption } from "./providerDriverMeta";
import { searchableSetting } from "./settingsSearch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  buildAddCocoaHostSettingsPatch,
  buildRemoveCocoaHostSettingsPatch,
  buildSourceControlWriterModelSelectionPatch,
  buildUpdateCocoaHostSettingsPatch,
  deriveCocoaHostConnections,
  parseCocoaHostPairingInput,
  readSourceControlWriterModelSelection,
} from "./HostConnectionsSettings.logic";

function providerStatusLabel(status: string | undefined): string {
  switch (status) {
    case "ready":
      return "Connected";
    case "error":
      return "Unavailable";
    case "disabled":
      return "Disabled";
    default:
      return "Checking…";
  }
}

export function HostConnectionsSettings() {
  return (
    <SettingsPageContainer>
      <HostConnectionsSection />
    </SettingsPageContainer>
  );
}

export function HostConnectionsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [pairingToken, setPairingToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [openHosts, setOpenHosts] = useState<Record<string, boolean>>({});
  const [openProviders, setOpenProviders] = useState<Record<string, boolean>>({});
  const [appearanceHostId, setAppearanceHostId] = useState<ProviderHostId | null>(null);
  const connections = useMemo(() => deriveCocoaHostConnections(settings), [settings]);
  const appearanceConnection = useMemo(
    () =>
      appearanceHostId === null
        ? undefined
        : connections.find((connection) => connection.hostId === appearanceHostId),
    [appearanceHostId, connections],
  );
  const providerByInstanceId = useMemo(
    () => new Map(providers.map((provider) => [provider.instanceId, provider])),
    [providers],
  );
  const instanceEntries = useMemo(
    () => applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    [providers, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );

  const addHost = () => {
    setError(null);
    try {
      const transport = parseCocoaHostPairingInput(pairingToken);
      updateSettings(buildAddCocoaHostSettingsPatch(settings, transport));
      setPairingToken("");
      toastManager.add({
        type: "success",
        title: "Provider host added",
        description: `The gateway will connect to ${new URL(transport.url).hostname}.`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid Cocoa host pairing token.");
    }
  };

  const updateInstance = (instanceId: ProviderInstanceId, next: ProviderInstanceConfig) => {
    updateSettings({
      providerInstances: {
        ...settings.providerInstances,
        [instanceId]: next,
      },
    });
  };

  const updateHost = (hostId: ProviderHostId, next: ProviderHostConfig) => {
    const connection = connections.find((candidate) => candidate.hostId === hostId);
    if (!connection) return;
    updateSettings(buildUpdateCocoaHostSettingsPatch(settings, connection, next));
  };

  const removeHost = (hostId: ProviderHostId) => {
    const connection = connections.find((candidate) => candidate.hostId === hostId);
    if (!connection) return;
    updateSettings(buildRemoveCocoaHostSettingsPatch(settings, connection));
    toastManager.add({
      type: "success",
      title: "Provider host removed",
      description:
        connection.bindings.length === 0
          ? "The host connection was removed."
          : `${connection.bindings.length} bound provider${connection.bindings.length === 1 ? " was" : "s were"} removed with it.`,
    });
  };

  const updateModelPreferences = (
    instanceId: ProviderInstanceId,
    patch: { hiddenModels?: ReadonlyArray<string>; modelOrder?: ReadonlyArray<string> },
  ) => {
    const current = settings.providerModelPreferences?.[instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    updateSettings({
      providerModelPreferences: {
        ...settings.providerModelPreferences,
        [instanceId]: { ...current, ...patch },
      },
    });
  };

  const updateFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavoriteModels, (slug) => {
          const trimmed = slug.trim();
          return trimmed.length > 0 ? Result.succeed(trimmed) : Result.failVoid;
        }),
      ),
    ];
    updateSettings({
      favorites: [
        ...(settings.favorites ?? []).filter((favorite) => favorite.provider !== instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const modelControl = (
    instanceId: ProviderInstanceId,
    selection: ModelSelection,
    onChange: (selection: ModelSelection) => void,
    ariaLabel: string,
  ) => {
    const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
    const provider = providerByInstanceId.get(instanceId);
    if (!entry || !provider) return null;
    return (
      <>
        <ProviderModelPicker
          activeInstanceId={instanceId}
          model={selection.model}
          lockedProvider={provider.driver}
          projectProviderInstanceId={instanceId}
          instanceEntries={[entry]}
          modelOptionsByInstance={modelOptionsByInstance}
          triggerVariant="outline"
          triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
          triggerAriaLabel={ariaLabel}
          onInstanceModelChange={(_nextInstanceId, model) =>
            onChange(
              resolveAppModelSelectionStateForInstance(
                instanceId,
                settings,
                providers,
                createModelSelection(instanceId, model),
              ) ?? createModelSelection(instanceId, model),
            )
          }
        />
        <TraitsPicker
          provider={provider.driver}
          models={entry.models}
          model={selection.model}
          prompt=""
          onPromptChange={() => {}}
          modelOptions={selection.options}
          allowPromptInjectedEffort={false}
          triggerVariant="outline"
          triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
          onModelOptionsChange={(options) =>
            onChange(createModelSelection(instanceId, selection.model, options))
          }
        />
      </>
    );
  };

  const sourceControlWriterControl = (instanceId: ProviderInstanceId, providerName: string) => {
    const storedSelection = readSourceControlWriterModelSelection(settings, instanceId);
    const selection = resolveAppModelSelectionStateForInstance(
      instanceId,
      settings,
      providers,
      storedSelection ?? undefined,
    );
    const enabled = storedSelection !== null;
    return (
      <div
        key={instanceId}
        className="flex flex-col gap-3 rounded-lg border border-border/50 bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">Override message model</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Select model used for commit messages and change requests text generation.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {enabled && selection
            ? modelControl(
                instanceId,
                selection,
                (nextSelection) =>
                  updateSettings(
                    buildSourceControlWriterModelSelectionPatch(
                      settings,
                      instanceId,
                      nextSelection,
                    ),
                  ),
                `${providerName} source control writer model`,
              )
            : null}
          <Switch
            checked={enabled}
            disabled={!enabled && selection === null}
            onCheckedChange={(checked) =>
              updateSettings(
                buildSourceControlWriterModelSelectionPatch(
                  settings,
                  instanceId,
                  checked ? selection : null,
                ),
              )
            }
            aria-label={`Enable ${providerName} source control writer`}
          />
        </div>
      </div>
    );
  };

  return (
    <SettingsSection
      {...searchableSetting("providers")}
      title="Provider hosts"
      icon={<ServerIcon className="size-4" />}
    >
      <SettingsRow
        title="Add provider host"
        description="Paste the pairing token printed by cocoa-hostd. Clients continue to connect only to this gateway."
      >
        <div className="grid gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            aria-label="Cocoa host pairing token"
            nativeInput
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="cocoa-host-v1:…"
            value={pairingToken}
            onChange={(event) => setPairingToken(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addHost();
            }}
          />
          <Button disabled={pairingToken.trim().length === 0} onClick={addHost}>
            Add host
          </Button>
        </div>
        {error ? <p className="pb-2 text-xs text-destructive">{error}</p> : null}
      </SettingsRow>

      {connections.length === 0 ? (
        <SettingsRow
          title="No provider hosts"
          description="Start cocoa-hostd on an execution machine, then paste its pairing token above."
        />
      ) : (
        connections.map((connection) => {
          const hostId = connection.hostId;
          const binding = connection.codexBinding;
          const instanceId = binding?.instanceId;
          const instance = binding?.instance;
          const liveProvider = instanceId ? providerByInstanceId.get(instanceId) : undefined;
          const entry = instanceId
            ? instanceEntries.find((candidate) => candidate.instanceId === instanceId)
            : undefined;
          const hostName =
            connection.host.displayName ?? new URL(connection.transport.url).hostname;
          const isHostOpen = openHosts[hostId] ?? true;
          const preferences = (instanceId
            ? settings.providerModelPreferences?.[instanceId]
            : undefined) ?? {
            hiddenModels: [],
            modelOrder: [],
          };
          const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
            instanceId && favorite.provider === instanceId
              ? Result.succeed(favorite.model)
              : Result.failVoid,
          );
          const storedDefault = instanceId
            ? settings.defaultModelSelections?.[instanceId]
            : undefined;
          const defaultSelection = instanceId
            ? resolveAppModelSelectionStateForInstance(
                instanceId,
                settings,
                providers,
                storedDefault,
              )
            : null;
          const advertisedDefault = instanceId
            ? resolveAppModelSelectionStateForInstance(instanceId, settings, providers)
            : null;
          const storedTextGeneration =
            instanceId === undefined
              ? undefined
              : (settings.textGenerationModelSelections?.[instanceId] ??
                (settings.textGenerationModelSelection.instanceId === instanceId
                  ? settings.textGenerationModelSelection
                  : undefined));
          const textGenerationSelection = instanceId
            ? resolveAppModelSelectionStateForInstance(
                instanceId,
                settings,
                providers,
                storedTextGeneration,
              )
            : null;
          const harnessName = liveProvider
            ? (PROVIDER_DISPLAY_NAMES[liveProvider.driver] ?? String(liveProvider.driver))
            : "Codex";

          return (
            <div key={hostId} className="rounded-xl border border-border/60 bg-card/30">
              <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
                <button
                  type="button"
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={
                    connection.host.accentColor ? { color: connection.host.accentColor } : undefined
                  }
                  onClick={() => setAppearanceHostId(hostId)}
                  aria-label={`Change appearance for ${hostName}`}
                  title="Change appearance"
                >
                  <ProviderHostIconGlyph icon={connection.host.icon} className="size-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-foreground">{hostName}</h3>
                    <span className="text-[11px] text-muted-foreground">
                      {providerStatusLabel(liveProvider?.status)}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {connection.transport.url}
                  </p>
                </div>
                <Button
                  aria-label={
                    connection.bindings.length === 0
                      ? `Remove ${hostName}`
                      : `Remove ${hostName} and ${connection.bindings.length} bound provider${connection.bindings.length === 1 ? "" : "s"}`
                  }
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => removeHost(hostId)}
                >
                  <Trash2Icon />
                </Button>
                <Button
                  aria-label={`Toggle ${hostName} details`}
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => setOpenHosts((current) => ({ ...current, [hostId]: !isHostOpen }))}
                >
                  <ChevronDownIcon className={isHostOpen ? "rotate-180" : undefined} />
                </Button>
              </div>

              {isHostOpen ? (
                <div className="space-y-5 border-t border-border/50 px-3 py-4 sm:px-4">
                  <label className="block">
                    <span className="text-xs font-medium text-foreground">Display name</span>
                    <DraftInput
                      className="mt-1.5"
                      value={connection.host.displayName ?? ""}
                      placeholder={new URL(connection.transport.url).hostname}
                      spellCheck={false}
                      onCommit={(value) => {
                        const trimmed = value.trim();
                        const { displayName: _displayName, ...rest } = connection.host;
                        updateHost(hostId, trimmed ? { ...rest, displayName: trimmed } : rest);
                      }}
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Label used by host selectors and project context controls.
                    </span>
                  </label>

                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Providers
                    </p>
                    {instanceId && instance && entry && liveProvider ? (
                      <ProviderInstanceCard
                        instanceId={instanceId}
                        instance={instance}
                        driverOption={getDriverOption(liveProvider.driver)}
                        liveProvider={liveProvider}
                        presentationDisplayName={harnessName}
                        showAppearanceControls={false}
                        isExpanded={openProviders[instanceId] ?? true}
                        onExpandedChange={(open) =>
                          setOpenProviders((current) => ({ ...current, [instanceId]: open }))
                        }
                        onUpdate={(next) => updateInstance(instanceId, next)}
                        connectionManaged
                        defaultModelControl={
                          defaultSelection ? (
                            <>
                              {storedDefault && !Equal.equals(storedDefault, advertisedDefault) ? (
                                <SettingResetButton
                                  label={`${hostName} default model`}
                                  onClick={() => {
                                    const next = { ...settings.defaultModelSelections };
                                    delete next[instanceId];
                                    updateSettings({ defaultModelSelections: next });
                                  }}
                                />
                              ) : null}
                              {modelControl(
                                instanceId,
                                defaultSelection,
                                (selection) =>
                                  updateSettings({
                                    defaultModelSelections: {
                                      ...settings.defaultModelSelections,
                                      [instanceId]: selection,
                                    },
                                  }),
                                `${hostName} default model`,
                              )}
                            </>
                          ) : undefined
                        }
                        textGenerationModelControl={
                          textGenerationSelection
                            ? modelControl(
                                instanceId,
                                textGenerationSelection,
                                (selection) =>
                                  updateSettings({
                                    textGenerationModelSelections: {
                                      ...settings.textGenerationModelSelections,
                                      [instanceId]: selection,
                                    },
                                  }),
                                `${hostName} text generation model`,
                              )
                            : undefined
                        }
                        hiddenModels={preferences.hiddenModels}
                        favoriteModels={favoriteModels}
                        modelOrder={preferences.modelOrder}
                        onHiddenModelsChange={(hiddenModels) =>
                          updateModelPreferences(instanceId, { hiddenModels })
                        }
                        onFavoriteModelsChange={(models) =>
                          updateFavoriteModels(instanceId, models)
                        }
                        onModelOrderChange={(modelOrder) =>
                          updateModelPreferences(instanceId, { modelOrder })
                        }
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {instance
                          ? "Waiting for this host to advertise its Codex provider."
                          : "No Codex provider is bound to this host."}
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Source Control
                    </p>
                    <ProviderHostSourceControlSettings
                      hostId={hostId}
                      providerInstanceId={connection.bindings[0]?.instanceId ?? null}
                    />
                    {connection.bindings.length > 0 ? (
                      <div className="mt-3 space-y-2">
                        {connection.bindings.map(
                          ({ instanceId: writerInstanceId, instance: writerInstance }) => {
                            const writerProvider = providerByInstanceId.get(writerInstanceId);
                            const writerProviderName =
                              writerInstance.displayName ??
                              (writerProvider
                                ? (PROVIDER_DISPLAY_NAMES[writerProvider.driver] ??
                                  String(writerProvider.driver))
                                : String(writerInstanceId));
                            return sourceControlWriterControl(writerInstanceId, writerProviderName);
                          },
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })
      )}
      {appearanceConnection ? (
        <ProviderHostAppearanceDialog
          key={appearanceConnection.hostId}
          open
          displayName={
            appearanceConnection.host.displayName ??
            new URL(appearanceConnection.transport.url).hostname
          }
          icon={appearanceConnection.host.icon}
          accentColor={appearanceConnection.host.accentColor}
          onOpenChange={(open) => {
            if (!open) setAppearanceHostId(null);
          }}
          onSave={(appearance) => {
            const {
              icon: _icon,
              iconSvg: _iconSvg,
              accentColor: _accentColor,
              ...host
            } = appearanceConnection.host;
            updateHost(appearanceConnection.hostId, {
              ...host,
              ...(appearance.icon ? { icon: appearance.icon } : {}),
              ...(appearance.accentColor ? { accentColor: appearance.accentColor } : {}),
            });
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
