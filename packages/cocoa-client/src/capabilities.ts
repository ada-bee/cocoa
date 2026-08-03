import type {
  CocoaClientV1Capabilities,
  CocoaClientV1CapabilityId,
} from "@t3tools/contracts/client/v1";

import { CocoaClientCapabilityError } from "./errors.ts";

export function supportsCocoaCapability(
  capabilities: CocoaClientV1Capabilities,
  capability: CocoaClientV1CapabilityId,
): boolean {
  return capabilities.includes(capability);
}

export function requireCocoaCapability(
  capabilities: CocoaClientV1Capabilities,
  capability: CocoaClientV1CapabilityId,
): void {
  if (!supportsCocoaCapability(capabilities, capability)) {
    throw new CocoaClientCapabilityError(capability);
  }
}
