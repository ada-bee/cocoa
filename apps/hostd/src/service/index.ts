export {
  HOSTD_SERVICE_LABEL,
  HOSTD_SYSTEMD_UNIT,
  HOSTD_WINDOWS_TASK,
  HostdServiceError,
  installService,
  makeServicePlan,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsTaskCommand,
  uninstallService,
} from "./service.ts";

export type {
  HostdServiceCommand,
  HostdServiceCommandResult,
  HostdServiceInstallResult,
  HostdServiceIo,
  HostdServiceOptions,
  HostdServicePlan,
  HostdServicePlatform,
} from "./service.ts";
