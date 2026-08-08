import { ChevronDownIcon, InfoIcon, RefreshCwIcon } from "lucide-react";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { useMemo, useState, type ReactNode } from "react";
import type {
  BackgroundActivitySettings,
  ProviderHostId,
  ProviderInstanceId,
  SourceControlHostingProviderKind,
  SourceControlProviderKind,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@t3tools/contracts";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Skeleton } from "../ui/skeleton";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  JujutsuIcon,
  type Icon,
} from "../Icons";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import { deriveCocoaHostConnections } from "./HostConnectionsSettings.logic";
import { buildSourceControlHostingProviderPatch } from "./SourceControlSettings.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  "azure-devops": AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
};

const HOSTING_PROVIDER_DEFAULTS = [
  { kind: "github", label: "GitHub" },
  { kind: "gitlab", label: "GitLab" },
  { kind: "bitbucket", label: "Bitbucket" },
  { kind: "azure-devops", label: "Azure DevOps" },
] as const satisfies ReadonlyArray<{
  readonly kind: SourceControlHostingProviderKind;
  readonly label: string;
}>;
const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const GIT_FETCH_INTERVAL_STEP_SECONDS = 5;
type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

function normalizeFetchIntervalSeconds(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    ...current.overrides,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

function BackgroundPolicyTooltip({ children }: { readonly children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            aria-label="Background policy details"
          >
            <InfoIcon className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {children}
      </TooltipPopup>
    </Tooltip>
  );
}

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

function authPresentation(auth: SourceControlProviderAuth): {
  readonly label: string;
  readonly badge: "warning" | null;
} {
  if (auth.status === "authenticated") {
    return { label: "Authenticated", badge: null };
  }
  if (auth.status === "unauthenticated") {
    return { label: "Not authenticated", badge: "warning" };
  }
  return { label: "Status unknown", badge: null };
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Toggle source control account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
    />
  );
}

function itemStatusDot(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string {
  if (isVcsNotReady(item)) return "bg-muted-foreground/35";
  if (item.status !== "available") return "bg-warning";
  if (isProviderDiscoveryItem(item) && item.auth.status !== "authenticated") return "bg-warning";
  return "bg-success";
}

function SourceControlItemMark({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const dotClassName = itemStatusDot(item);
  const Icon = isProviderDiscoveryItem(item)
    ? SOURCE_CONTROL_PROVIDER_ICONS[item.kind]
    : VCS_ICONS[item.kind];

  if (!Icon) {
    return <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden />;
  }

  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center">
      <Icon className="size-4.5 text-foreground/80" aria-hidden />
    </span>
  );
}

function itemSummary({
  item,
  auth,
  authAccount,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
}) {
  if (isVcsNotReady(item)) {
    return <span>Support for {item.label} is coming soon.</span>;
  }

  if (item.status !== "available") {
    return <span>Not available on this server: {item.installHint}</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      return (
        <>
          <span>Authenticated</span>
          {authAccount ? (
            <>
              <span aria-hidden>as</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
        </>
      );
    }

    if (!item.executable) {
      return <span>Available. {item.installHint}</span>;
    }

    if (auth.status === "unauthenticated") {
      return (
        <span>
          {item.label} is not authenticated on this server. Sign in or configure credentials using
          the <code className="rounded bg-muted px-1 py-px text-[11px]">{item.executable}</code>{" "}
          tool on the server host to enable change request features.
        </span>
      );
    }
    return (
      <span>
        Could not verify {item.label}. {item.installHint}
      </span>
    );
  }

  return <span>Available</span>;
}

function DiscoveryItemRow({
  item,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly children?: ReactNode;
}) {
  const version = optionLabel(item.version);
  const enabled = isProviderDiscoveryItem(item)
    ? item.status === "available" && item.auth.status === "authenticated"
    : item.status === "available" && item.implemented;
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authStatus = auth ? authPresentation(auth) : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetails = children !== undefined;

  return (
    <div
      className={cn(
        "rounded-xl transition-colors hover:bg-muted/20",
        isVcsNotReady(item) && "opacity-80",
      )}
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SourceControlItemMark item={item} />
              <span className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
                {item.label}
              </span>
              {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
              {isVcsNotReady(item) ? (
                <Badge variant="warning" size="sm">
                  Coming Soon
                </Badge>
              ) : null}
              {authStatus?.badge ? (
                <Badge variant={authStatus.badge} size="sm">
                  {authStatus.label}
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[13px] leading-[1.45] text-muted-foreground/80">
              {itemSummary({ item, auth, authAccount })}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {hasDetails ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setIsExpanded((open) => !open)}
                aria-expanded={isExpanded}
                aria-label={`Toggle ${item.label} details`}
              >
                <ChevronDownIcon
                  className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
                />
              </Button>
            ) : null}
            {!isVcsNotReady(item) ? (
              <Switch checked={enabled} disabled aria-label={`${item.label} availability`} />
            ) : null}
          </div>
        </div>
      </div>

      {hasDetails ? (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleContent>
            <div className="px-3 pb-4 pt-1 sm:px-4">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function GitFetchIntervalSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const defaultAutomaticGitFetchIntervalSeconds = durationToSeconds(
    getBackgroundActivityPresetSettings(
      getBackgroundActivityBaseProfile(settings.backgroundActivity),
    ).automaticGitFetchInterval,
  );
  const canResetFetchInterval =
    automaticGitFetchIntervalSeconds !== defaultAutomaticGitFetchIntervalSeconds;

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-1">
          Fetch interval
          <BackgroundPolicyTooltip>
            This interval is configured for Git only. The shared Background activity policy still
            decides whether Git refreshes may run when the timer fires. Custom intervals appear as
            Advanced in General settings.
          </BackgroundPolicyTooltip>
        </span>
      }
      description="Refresh remote branch status in the background. Set this to 0 seconds if Git credentials or security keys should only be prompted by explicit Git actions."
      resetAction={
        canResetFetchInterval ? (
          <SettingResetButton
            label="fetch interval"
            onClick={() =>
              updateSettings(
                backgroundActivityOverrideSettings(settings.backgroundActivity, {
                  automaticGitFetchInterval: undefined,
                }),
              )
            }
          />
        ) : null
      }
      control={
        <div className="flex shrink-0 items-center gap-2">
          <NumberField
            value={automaticGitFetchIntervalSeconds}
            min={0}
            step={GIT_FETCH_INTERVAL_STEP_SECONDS}
            size="sm"
            className="w-32"
            onValueChange={(value) =>
              updateSettings(
                backgroundActivityOverrideSettings(settings.backgroundActivity, {
                  automaticGitFetchInterval: Duration.seconds(normalizeFetchIntervalSeconds(value)),
                }),
              )
            }
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Decrease fetch interval" />
              <NumberFieldInput aria-label="Automatic Git fetch interval in seconds" />
              <NumberFieldIncrement aria-label="Increase fetch interval" />
            </NumberFieldGroup>
          </NumberField>
          <span className="text-xs text-muted-foreground">seconds</span>
        </div>
      }
    />
  );
}

export function ProviderHostSourceControlSettings({
  hostId,
  providerInstanceId,
}: {
  readonly hostId: ProviderHostId;
  readonly providerInstanceId: ProviderInstanceId | null;
}) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const discovery = useEnvironmentQuery(
    environmentId === null || providerInstanceId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: { providerHostId: hostId },
        }),
  );
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const items = [...result.versionControlSystems, ...result.sourceControlProviders];

  if (providerInstanceId === null) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Bind a provider to this host to inspect its Git and repository-hosting capabilities.
      </p>
    );
  }

  if (discovery.isPending && discovery.data === null) {
    return <Skeleton className="h-16 w-full rounded-lg" />;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Git, worktrees, diffs, and repository-bound hosting actions execute on this host.
        </p>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => discovery.refresh()}
          disabled={discovery.isPending}
          aria-label="Rescan this provider host's source control capabilities"
        >
          <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
        </Button>
      </div>
      {discovery.error ? (
        <p className="text-xs text-destructive">{discovery.error}</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This host does not currently advertise source-control capabilities.
        </p>
      ) : (
        <div className="divide-y divide-border/40 rounded-lg border border-border/50">
          {items.map((item) => (
            <DiscoveryItemRow
              key={`${isProviderDiscoveryItem(item) ? "provider" : "vcs"}:${item.kind}`}
              item={item}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SourceControlSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providerHosts = useMemo(() => deriveCocoaHostConnections(settings), [settings]);

  const setHostingProvider = (
    kind: SourceControlHostingProviderKind,
    hostId: ProviderHostId | null,
  ) =>
    updateSettings(
      buildSourceControlHostingProviderPatch(
        settings,
        kind,
        hostId === null ? null : (providerHosts.find((host) => host.hostId === hostId) ?? null),
      ),
    );

  return (
    <SettingsPageContainer>
      <SettingsSection id={searchableSetting("source-control").id} title="Version control defaults">
        <p className="px-3 pb-2 text-xs leading-relaxed text-muted-foreground sm:px-4">
          Choose the provider host for API-only GitHub, GitLab, Bitbucket, and Azure DevOps
          operations. Repository Git, fetch, push, diff, and worktree operations always run on the
          project&apos;s provider host.
        </p>
        {HOSTING_PROVIDER_DEFAULTS.map(({ kind, label }) => {
          const selectedHostId = settings.sourceControlHostingHostDefaults[kind];
          const selectedHost = providerHosts.find((host) => host.hostId === selectedHostId);
          const enabled =
            selectedHost !== undefined &&
            !settings.sourceControlDisabledHostingProviders.includes(kind);
          return (
            <SettingsRow
              key={kind}
              title={label}
              control={
                <div className="flex w-full items-center justify-end gap-3">
                  {enabled && selectedHost ? (
                    <Select
                      value={selectedHost.hostId}
                      onValueChange={(value) =>
                        value === null
                          ? undefined
                          : setHostingProvider(kind, value as ProviderHostId)
                      }
                    >
                      <SelectTrigger
                        className="w-full sm:w-56"
                        aria-label={`Default host for ${label}`}
                      >
                        <SelectValue>
                          {selectedHost.host.displayName ??
                            new URL(selectedHost.transport.url).hostname}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        {providerHosts.map((host) => (
                          <SelectItem key={host.hostId} hideIndicator value={host.hostId}>
                            {host.host.displayName ?? new URL(host.transport.url).hostname}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : null}
                  <Switch
                    checked={enabled}
                    disabled={!enabled && providerHosts.length === 0}
                    onCheckedChange={(checked) =>
                      setHostingProvider(
                        kind,
                        checked ? (selectedHost?.hostId ?? providerHosts[0]?.hostId ?? null) : null,
                      )
                    }
                    aria-label={`Enable ${label}`}
                  />
                </div>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="Repository activity">
        <GitFetchIntervalSettings />
      </SettingsSection>

      {environmentId !== null ? <SourceControlWritingSettingsSection /> : null}
    </SettingsPageContainer>
  );
}
