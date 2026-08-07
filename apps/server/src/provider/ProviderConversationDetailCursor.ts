import type { ThreadId } from "@t3tools/contracts";

/**
 * Stable provider-history boundary. Provider turn ids survive cache refreshes,
 * unlike database row ids, and the Cocoa thread id prevents cross-thread use.
 */
export interface ProviderConversationDetailCursor {
  readonly threadId: ThreadId;
  readonly beforeTurnId: string;
}

export function encodeProviderConversationDetailCursor(
  cursor: ProviderConversationDetailCursor,
): string {
  return Buffer.from(JSON.stringify({ t: cursor.threadId, i: cursor.beforeTurnId })).toString(
    "base64url",
  );
}

export function decodeProviderConversationDetailCursor(
  encoded: string,
): ProviderConversationDetailCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.t !== "string" || record.t.length === 0) return null;
  if (typeof record.i !== "string" || record.i.length === 0) return null;
  return { threadId: record.t as ThreadId, beforeTurnId: record.i };
}
