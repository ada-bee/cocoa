import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { ProviderHostIconGlyph } from "./ProviderHostIcon";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  envLocked: boolean;
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  availableEnvironments: readonly EnvironmentOption[];
  // Absent when there is only one environment to show: the indicator still
  // renders (as a static label) so remote projects are always identifiable.
  onEnvironmentChange?: (environmentId: EnvironmentId, projectId?: ProjectId) => void;
}

export function BranchToolbarEnvironmentIcon(props: {
  environment: EnvironmentOption | null;
  className: string;
}) {
  if (props.environment?.hostIcon) {
    return (
      <ProviderHostIconGlyph
        icon={props.environment.hostIcon}
        className={props.className}
        {...(props.environment.hostAccentColor
          ? { style: { color: props.environment.hostAccentColor } }
          : {})}
      />
    );
  }
  const Icon = props.environment?.isPrimary ? MonitorIcon : CloudIcon;
  return <Icon className={props.className} aria-hidden />;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  envLocked,
  environmentId,
  projectId,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const activeEnvironment = useMemo(() => {
    return (
      availableEnvironments.find(
        (env) =>
          env.environmentId === environmentId &&
          (projectId === undefined || env.projectId === projectId),
      ) ??
      availableEnvironments.find((env) => env.environmentId === environmentId) ??
      null
    );
  }, [availableEnvironments, environmentId, projectId]);

  const activeSelectionId =
    activeEnvironment?.selectionId ?? activeEnvironment?.environmentId ?? environmentId;

  const environmentItems = useMemo(
    () =>
      availableEnvironments.map((env) => ({
        value: env.selectionId ?? env.environmentId,
        label: env.label,
      })),
    [availableEnvironments],
  );

  if (envLocked || onEnvironmentChange === undefined) {
    return (
      <span className="inline-flex min-w-0 max-w-full items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        <BranchToolbarEnvironmentIcon environment={activeEnvironment} className="size-3 shrink-0" />
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] truncate transition-[max-width,opacity] duration-300 ease-out group-data-[compact]/composer-context:max-w-0 group-data-[compact]/composer-context:opacity-0"
        >
          {activeEnvironment?.label ?? "Run on"}
        </span>
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={activeSelectionId}
      onValueChange={(value) => {
        const selected = availableEnvironments.find(
          (environment) => (environment.selectionId ?? environment.environmentId) === value,
        );
        if (selected) onEnvironmentChange(selected.environmentId, selected.projectId);
      }}
      items={environmentItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 max-w-full font-medium"
        aria-label="Run on"
      >
        <BranchToolbarEnvironmentIcon environment={activeEnvironment} className="size-3 shrink-0" />
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] truncate transition-[max-width,opacity] duration-300 ease-out group-data-[compact]/composer-context:max-w-0 group-data-[compact]/composer-context:opacity-0"
        >
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {availableEnvironments.map((env) => (
            <SelectItem
              key={env.selectionId ?? env.environmentId}
              value={env.selectionId ?? env.environmentId}
            >
              <span className="inline-flex items-center gap-1.5">
                <BranchToolbarEnvironmentIcon environment={env} className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
