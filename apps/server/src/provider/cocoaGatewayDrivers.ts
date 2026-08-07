import { CodexEndpointDriver, type CodexEndpointDriverEnv } from "./Drivers/CodexEndpointDriver.ts";
import {
  OpenCodeEndpointDriver,
  type OpenCodeEndpointDriverEnv,
} from "./Drivers/OpenCodeEndpointDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

export type CocoaGatewayDriversEnv = CodexEndpointDriverEnv | OpenCodeEndpointDriverEnv;

/** Remote-only driver catalog. Importing this module never loads legacy drivers. */
export const COCOA_GATEWAY_DRIVERS: ReadonlyArray<AnyProviderDriver<CocoaGatewayDriversEnv>> = [
  CodexEndpointDriver,
  OpenCodeEndpointDriver,
];
