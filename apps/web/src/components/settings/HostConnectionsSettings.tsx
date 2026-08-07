import { useAtomValue } from "@effect/atom-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import { ChevronDownIcon, ServerIcon, Trash2Icon, UploadIcon } from "lucide-react";
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
import { toastManager } from "../ui/toast";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
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
  deriveCocoaHostConnections,
  parseCocoaHostPairingInput,
  readCocoaHostIconSvg,
  sanitizeCocoaHostIconSvg,
  withCocoaHostIconSvg,
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

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
  const connections = useMemo(() => deriveCocoaHostConnections(settings), [settings]);
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

  const removeHost = (instanceId: ProviderInstanceId) => {
    const connection = connections.find((candidate) => candidate.instanceId === instanceId);
    if (!connection) return;
    updateSettings(buildRemoveCocoaHostSettingsPatch(settings, connection));
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
          const instanceId = connection.instanceId;
          const liveProvider = providerByInstanceId.get(instanceId);
          const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
          const hostName =
            connection.instance.displayName ?? new URL(connection.transport.url).hostname;
          const iconSvg = readCocoaHostIconSvg(connection.instance);
          const isHostOpen = openHosts[instanceId] ?? true;
          const preferences = settings.providerModelPreferences?.[instanceId] ?? {
            hiddenModels: [],
            modelOrder: [],
          };
          const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
            favorite.provider === instanceId ? Result.succeed(favorite.model) : Result.failVoid,
          );
          const storedDefault = settings.defaultModelSelections?.[instanceId];
          const defaultSelection = resolveAppModelSelectionStateForInstance(
            instanceId,
            settings,
            providers,
            storedDefault,
          );
          const advertisedDefault = resolveAppModelSelectionStateForInstance(
            instanceId,
            settings,
            providers,
          );
          const storedTextGeneration =
            settings.textGenerationModelSelections?.[instanceId] ??
            (settings.textGenerationModelSelection.instanceId === instanceId
              ? settings.textGenerationModelSelection
              : undefined);
          const textGenerationSelection = resolveAppModelSelectionStateForInstance(
            instanceId,
            settings,
            providers,
            storedTextGeneration,
          );
          const harnessName = liveProvider
            ? (PROVIDER_DISPLAY_NAMES[liveProvider.driver] ?? String(liveProvider.driver))
            : "Codex";

          return (
            <div key={instanceId} className="rounded-xl border border-border/60 bg-card/30">
              <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
                <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-background text-muted-foreground">
                  {iconSvg ? (
                    <img className="size-full object-contain" src={svgDataUrl(iconSvg)} alt="" />
                  ) : (
                    <ServerIcon className="size-4" aria-hidden />
                  )}
                </span>
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
                  aria-label={`Remove ${hostName}`}
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => removeHost(instanceId)}
                >
                  <Trash2Icon />
                </Button>
                <Button
                  aria-label={`Toggle ${hostName} details`}
                  size="icon-xs"
                  variant="ghost"
                  onClick={() =>
                    setOpenHosts((current) => ({ ...current, [instanceId]: !isHostOpen }))
                  }
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
                      value={connection.instance.displayName ?? ""}
                      placeholder={new URL(connection.transport.url).hostname}
                      spellCheck={false}
                      onCommit={(value) => {
                        const trimmed = value.trim();
                        const { displayName: _displayName, ...rest } = connection.instance;
                        updateInstance(
                          instanceId,
                          trimmed ? { ...rest, displayName: trimmed } : rest,
                        );
                      }}
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Label used by host selectors and project context controls.
                    </span>
                  </label>

                  <div>
                    <p className="text-xs font-medium text-foreground">Host icon</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground hover:bg-muted/40">
                        <UploadIcon className="size-3.5" aria-hidden />
                        Upload SVG
                        <input
                          className="sr-only"
                          type="file"
                          accept="image/svg+xml,.svg"
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            event.currentTarget.value = "";
                            if (!file) return;
                            void file
                              .text()
                              .then(sanitizeCocoaHostIconSvg)
                              .then((svg) =>
                                updateInstance(
                                  instanceId,
                                  withCocoaHostIconSvg(connection.instance, svg),
                                ),
                              )
                              .catch((cause: unknown) =>
                                toastManager.add({
                                  type: "error",
                                  title: "Could not use host icon",
                                  description:
                                    cause instanceof Error ? cause.message : "Choose a valid SVG.",
                                }),
                              );
                          }}
                        />
                      </label>
                      {iconSvg ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            updateInstance(
                              instanceId,
                              withCocoaHostIconSvg(connection.instance, null),
                            )
                          }
                        >
                          Remove icon
                        </Button>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Used for this host only. Agent providers keep their own icons.
                    </p>
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Providers
                    </p>
                    {entry && liveProvider ? (
                      <ProviderInstanceCard
                        instanceId={instanceId}
                        instance={connection.instance}
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
                        Waiting for this host to advertise its Codex provider.
                      </p>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </SettingsSection>
  );
}
