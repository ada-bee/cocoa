import { CodexEndpointDriver, type CodexEndpointDriverEnv } from "./Drivers/CodexEndpointDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

export type CocoaGatewayDriversEnv = CodexEndpointDriverEnv;

/** Remote-only driver catalog. Importing this module never loads legacy drivers. */
export const COCOA_GATEWAY_DRIVERS: ReadonlyArray<AnyProviderDriver<CocoaGatewayDriversEnv>> = [
  CodexEndpointDriver,
];
