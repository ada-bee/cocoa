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
import type { CSSProperties } from "react";

export const PROVIDER_HOST_ICON_COMPONENTS: Readonly<Record<ProviderHostIcon, LucideIcon>> = {
  server: ServerIcon,
  monitor: MonitorIcon,
  laptop: LaptopIcon,
  smartphone: SmartphoneIcon,
  cloud: CloudIcon,
  database: DatabaseIcon,
  "hard-drive": HardDriveIcon,
  container: ContainerIcon,
  boxes: BoxesIcon,
  cpu: CpuIcon,
  "memory-stick": MemoryStickIcon,
  network: NetworkIcon,
  router: RouterIcon,
  wifi: WifiIcon,
  terminal: TerminalIcon,
  code: Code2Icon,
  braces: BracesIcon,
  bot: BotIcon,
  sparkles: SparklesIcon,
  globe: GlobeIcon,
  house: HouseIcon,
  building: Building2Icon,
  factory: FactoryIcon,
  shield: ShieldIcon,
  lock: LockIcon,
  key: KeyRoundIcon,
  rocket: RocketIcon,
  zap: ZapIcon,
  workflow: WorkflowIcon,
  "git-branch": GitBranchIcon,
  wrench: WrenchIcon,
  settings: SettingsIcon,
  flask: FlaskConicalIcon,
  bug: BugIcon,
  gamepad: Gamepad2Icon,
  "radio-tower": RadioTowerIcon,
};

export function ProviderHostIconGlyph(props: {
  readonly icon: ProviderHostIcon | undefined;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  const Icon = PROVIDER_HOST_ICON_COMPONENTS[props.icon ?? DEFAULT_PROVIDER_HOST_ICON];
  return <Icon className={props.className} style={props.style} aria-hidden />;
}
