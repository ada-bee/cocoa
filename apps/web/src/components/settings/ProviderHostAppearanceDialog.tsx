"use client";

import { DEFAULT_PROVIDER_HOST_ICON, type ProviderHostIcon } from "@t3tools/contracts";
import {
  BotIcon,
  BoxesIcon,
  BracesIcon,
  BugIcon,
  Building2Icon,
  CloudIcon,
  Code2Icon,
  ContainerIcon,
  CpuIcon,
  DatabaseIcon,
  FactoryIcon,
  FlaskConicalIcon,
  Gamepad2Icon,
  GitBranchIcon,
  GlobeIcon,
  HardDriveIcon,
  HouseIcon,
  KeyRoundIcon,
  LaptopIcon,
  LockIcon,
  MemoryStickIcon,
  MonitorIcon,
  NetworkIcon,
  RadioTowerIcon,
  RocketIcon,
  RouterIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  SmartphoneIcon,
  SparklesIcon,
  TerminalIcon,
  WifiIcon,
  WorkflowIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

interface ProviderHostIconOption {
  readonly id: ProviderHostIcon;
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
  readonly icon: LucideIcon;
}

export const PROVIDER_HOST_ICON_OPTIONS: ReadonlyArray<ProviderHostIconOption> = [
  { id: "server", label: "Server", keywords: ["host", "machine"], icon: ServerIcon },
  { id: "monitor", label: "Desktop", keywords: ["screen", "computer"], icon: MonitorIcon },
  { id: "laptop", label: "Laptop", keywords: ["notebook", "computer"], icon: LaptopIcon },
  { id: "smartphone", label: "Phone", keywords: ["mobile", "device"], icon: SmartphoneIcon },
  { id: "cloud", label: "Cloud", keywords: ["remote", "hosted"], icon: CloudIcon },
  { id: "database", label: "Database", keywords: ["storage", "data"], icon: DatabaseIcon },
  { id: "hard-drive", label: "Drive", keywords: ["disk", "storage"], icon: HardDriveIcon },
  { id: "container", label: "Container", keywords: ["docker", "pod"], icon: ContainerIcon },
  { id: "boxes", label: "Cluster", keywords: ["stack", "nodes"], icon: BoxesIcon },
  { id: "cpu", label: "Processor", keywords: ["chip", "compute"], icon: CpuIcon },
  { id: "memory-stick", label: "Memory", keywords: ["ram", "hardware"], icon: MemoryStickIcon },
  { id: "network", label: "Network", keywords: ["nodes", "lan"], icon: NetworkIcon },
  { id: "router", label: "Router", keywords: ["network", "gateway"], icon: RouterIcon },
  { id: "wifi", label: "Wireless", keywords: ["wifi", "network"], icon: WifiIcon },
  { id: "terminal", label: "Terminal", keywords: ["shell", "console"], icon: TerminalIcon },
  { id: "code", label: "Code", keywords: ["developer", "source"], icon: Code2Icon },
  { id: "braces", label: "Braces", keywords: ["code", "json"], icon: BracesIcon },
  { id: "bot", label: "Bot", keywords: ["agent", "robot"], icon: BotIcon },
  { id: "sparkles", label: "Sparkles", keywords: ["ai", "magic"], icon: SparklesIcon },
  { id: "globe", label: "Globe", keywords: ["world", "internet"], icon: GlobeIcon },
  { id: "house", label: "Home", keywords: ["local", "personal"], icon: HouseIcon },
  { id: "building", label: "Building", keywords: ["office", "work"], icon: Building2Icon },
  { id: "factory", label: "Factory", keywords: ["production", "build"], icon: FactoryIcon },
  { id: "shield", label: "Shield", keywords: ["secure", "protected"], icon: ShieldIcon },
  { id: "lock", label: "Lock", keywords: ["private", "secure"], icon: LockIcon },
  { id: "key", label: "Key", keywords: ["access", "credential"], icon: KeyRoundIcon },
  { id: "rocket", label: "Rocket", keywords: ["launch", "deploy"], icon: RocketIcon },
  { id: "zap", label: "Lightning", keywords: ["fast", "power"], icon: ZapIcon },
  { id: "workflow", label: "Workflow", keywords: ["pipeline", "automation"], icon: WorkflowIcon },
  {
    id: "git-branch",
    label: "Git branch",
    keywords: ["source", "repository"],
    icon: GitBranchIcon,
  },
  { id: "wrench", label: "Wrench", keywords: ["tools", "maintenance"], icon: WrenchIcon },
  { id: "settings", label: "Settings", keywords: ["configuration", "gear"], icon: SettingsIcon },
  { id: "flask", label: "Flask", keywords: ["experiment", "test"], icon: FlaskConicalIcon },
  { id: "bug", label: "Bug", keywords: ["debug", "development"], icon: BugIcon },
  { id: "gamepad", label: "Gamepad", keywords: ["gaming", "play"], icon: Gamepad2Icon },
  { id: "radio-tower", label: "Radio tower", keywords: ["signal", "remote"], icon: RadioTowerIcon },
];

const ICON_BY_ID = new Map(PROVIDER_HOST_ICON_OPTIONS.map((option) => [option.id, option.icon]));

export function filterProviderHostIconOptions(
  query: string,
): ReadonlyArray<ProviderHostIconOption> {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return PROVIDER_HOST_ICON_OPTIONS;
  return PROVIDER_HOST_ICON_OPTIONS.filter((option) =>
    [option.id, option.label, ...option.keywords].some((value) =>
      value.toLocaleLowerCase().includes(normalized),
    ),
  );
}

export function ProviderHostIconGlyph(props: {
  readonly icon: ProviderHostIcon | undefined;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  const Icon = ICON_BY_ID.get(props.icon ?? DEFAULT_PROVIDER_HOST_ICON) ?? ServerIcon;
  return <Icon className={props.className} style={props.style} aria-hidden />;
}

export function ProviderHostAppearanceDialog(props: {
  readonly open: boolean;
  readonly displayName: string;
  readonly icon: ProviderHostIcon | undefined;
  readonly accentColor: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (appearance: {
    readonly icon: ProviderHostIcon | undefined;
    readonly accentColor: string | undefined;
  }) => void;
}) {
  const [query, setQuery] = useState("");
  const [icon, setIcon] = useState<ProviderHostIcon>(props.icon ?? DEFAULT_PROVIDER_HOST_ICON);
  const [accentColor, setAccentColor] = useState(props.accentColor ?? "");
  const filteredIcons = useMemo(() => filterProviderHostIconOptions(query), [query]);

  const resetAppearance = () => {
    setIcon(DEFAULT_PROVIDER_HOST_ICON);
    setAccentColor("");
  };

  const saveAppearance = () => {
    props.onSave({
      icon: icon === DEFAULT_PROVIDER_HOST_ICON ? undefined : icon,
      accentColor: accentColor || undefined,
    });
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Host appearance</DialogTitle>
          <DialogDescription>
            Choose an icon and accent color for {props.displayName}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute start-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              nativeInput
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search icons"
              aria-label="Search host icons"
              autoFocus
              className="[&_[data-slot=input]]:ps-8"
            />
          </div>

          {filteredIcons.length > 0 ? (
            <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
              {filteredIcons.map((option) => {
                const selected = option.id === icon;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={cn(
                      "flex aspect-square min-w-0 items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "border-primary/70 bg-primary/10 text-foreground ring-1 ring-primary/30"
                        : "border-border/60 bg-background",
                    )}
                    style={accentColor ? { color: accentColor } : undefined}
                    onClick={() => setIcon(option.id)}
                    aria-label={option.label}
                    aria-pressed={selected}
                    title={option.label}
                  >
                    <option.icon className="size-4.5" aria-hidden />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">No matching icons.</p>
          )}

          <ProviderAccentColorPicker
            displayName={props.displayName}
            value={accentColor}
            onCommit={setAccentColor}
          />
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" className="sm:me-auto" onClick={resetAppearance}>
            Reset
          </Button>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={saveAppearance}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
