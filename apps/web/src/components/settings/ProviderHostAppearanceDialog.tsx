"use client";

import { DEFAULT_PROVIDER_HOST_ICON, type ProviderHostIcon } from "@t3tools/contracts";
import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { PROVIDER_HOST_ICON_COMPONENTS } from "../ProviderHostIcon";
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
}

export const PROVIDER_HOST_ICON_OPTIONS: ReadonlyArray<ProviderHostIconOption> = [
  { id: "server", label: "Server", keywords: ["host", "machine"] },
  { id: "monitor", label: "Desktop", keywords: ["screen", "computer"] },
  { id: "laptop", label: "Laptop", keywords: ["notebook", "computer"] },
  { id: "smartphone", label: "Phone", keywords: ["mobile", "device"] },
  { id: "cloud", label: "Cloud", keywords: ["remote", "hosted"] },
  { id: "database", label: "Database", keywords: ["storage", "data"] },
  { id: "hard-drive", label: "Drive", keywords: ["disk", "storage"] },
  { id: "container", label: "Container", keywords: ["docker", "pod"] },
  { id: "boxes", label: "Cluster", keywords: ["stack", "nodes"] },
  { id: "cpu", label: "Processor", keywords: ["chip", "compute"] },
  { id: "memory-stick", label: "Memory", keywords: ["ram", "hardware"] },
  { id: "network", label: "Network", keywords: ["nodes", "lan"] },
  { id: "router", label: "Router", keywords: ["network", "gateway"] },
  { id: "wifi", label: "Wireless", keywords: ["wifi", "network"] },
  { id: "terminal", label: "Terminal", keywords: ["shell", "console"] },
  { id: "code", label: "Code", keywords: ["developer", "source"] },
  { id: "braces", label: "Braces", keywords: ["code", "json"] },
  { id: "bot", label: "Bot", keywords: ["agent", "robot"] },
  { id: "sparkles", label: "Sparkles", keywords: ["ai", "magic"] },
  { id: "globe", label: "Globe", keywords: ["world", "internet"] },
  { id: "house", label: "Home", keywords: ["local", "personal"] },
  { id: "building", label: "Building", keywords: ["office", "work"] },
  { id: "factory", label: "Factory", keywords: ["production", "build"] },
  { id: "shield", label: "Shield", keywords: ["secure", "protected"] },
  { id: "lock", label: "Lock", keywords: ["private", "secure"] },
  { id: "key", label: "Key", keywords: ["access", "credential"] },
  { id: "rocket", label: "Rocket", keywords: ["launch", "deploy"] },
  { id: "zap", label: "Lightning", keywords: ["fast", "power"] },
  { id: "workflow", label: "Workflow", keywords: ["pipeline", "automation"] },
  {
    id: "git-branch",
    label: "Git branch",
    keywords: ["source", "repository"],
  },
  { id: "wrench", label: "Wrench", keywords: ["tools", "maintenance"] },
  { id: "settings", label: "Settings", keywords: ["configuration", "gear"] },
  { id: "flask", label: "Flask", keywords: ["experiment", "test"] },
  { id: "bug", label: "Bug", keywords: ["debug", "development"] },
  { id: "gamepad", label: "Gamepad", keywords: ["gaming", "play"] },
  { id: "radio-tower", label: "Radio tower", keywords: ["signal", "remote"] },
];

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
                const Icon = PROVIDER_HOST_ICON_COMPONENTS[option.id];
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
                    <Icon className="size-4.5" aria-hidden />
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
