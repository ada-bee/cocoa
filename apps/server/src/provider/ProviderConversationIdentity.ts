import {
  ThreadId,
  type ProviderInstanceId,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

/**
 * Stable Cocoa-facing identity for a provider-owned conversation.
 *
 * Provider thread ids are only unique within an endpoint. The length-framed
 * hash prevents cross-endpoint collisions without exposing endpoint ids or
 * accepting delimiter ambiguities into Cocoa's public thread namespace.
 */
export function providerConversationThreadId(
  providerInstanceId: ProviderInstanceId,
  providerThreadId: string,
): ThreadIdType {
  const hash = NodeCrypto.createHash("sha256");
  hash.update("xyz.brbc.cocoa.provider-conversation.v1\0", "utf8");
  for (const value of [providerInstanceId, providerThreadId]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length).update(bytes);
  }
  return ThreadId.make(`provider-${hash.digest("hex")}`);
}
