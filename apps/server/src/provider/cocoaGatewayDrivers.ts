import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

export type CocoaGatewayDriversEnv = CodexDriverEnv;

/** Remote-only driver catalog. Importing this module never loads legacy drivers. */
export const COCOA_GATEWAY_DRIVERS: ReadonlyArray<AnyProviderDriver<CocoaGatewayDriversEnv>> = [
  CodexDriver,
];
