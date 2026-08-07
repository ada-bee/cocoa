import * as Schema from "effect/Schema";

const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

function isIpLiteral(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    if (hostname.includes(":")) return true;

    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

function parseDirectHttpUrl(value: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Pairing links must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Gateway URLs must not contain embedded credentials.");
  }
  return parsed;
}

export class PairingQrPayloadEmptyError extends Schema.TaggedErrorClass<PairingQrPayloadEmptyError>()(
  "PairingQrPayloadEmptyError",
  {},
) {
  override get message(): string {
    return "Scanned QR code did not contain a pairing URL.";
  }
}

export function buildPairingUrl(host: string, code: string): string {
  const h = host.trim();
  const c = code.trim();
  if (!h) return "";
  if (!c) throw new Error("Enter the one-time pairing code from the gateway.");

  try {
    const url = parseDirectHttpUrl(
      h.includes("://") ? h : `${isIpLiteral(h) ? "http" : "https"}://${h}`,
    );
    if (url.hash) {
      throw new Error("Enter the gateway URL without a fragment.");
    }
    url.hash = new URLSearchParams([["token", c]]).toString();
    return url.toString();
  } catch (cause) {
    if (cause instanceof Error) throw cause;
    throw new Error("Enter a valid Cocoa gateway URL.");
  }
}

export function parsePairingUrl(url: string): { host: string; code: string } {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "" };

  try {
    const parsed = parseDirectHttpUrl(trimmed);

    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    if (
      parsed.hash &&
      (!hashParams.has("token") || [...hashParams.keys()].some((key) => key !== "token"))
    ) {
      throw new Error("Pairing links may only use a token fragment.");
    }
    const hashToken = hashParams.get("token");
    const queryToken = parsed.searchParams.get("token");
    const code = hashToken || queryToken || "";

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return { host: parsed.toString().replace(/\/$/, ""), code };
  } catch (cause) {
    if (cause instanceof Error) throw cause;
    throw new Error("Enter a valid Cocoa gateway URL.");
  }
}

export function extractPairingUrlFromQrPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new PairingQrPayloadEmptyError({});
  }

  const url = new URL(trimmed);
  if (url.protocol === "t3code:") {
    const pairingUrl = url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() ?? "";
    if (pairingUrl.length > 0) {
      parsePairingUrl(pairingUrl);
      return pairingUrl;
    }
  }

  parsePairingUrl(trimmed);
  return trimmed;
}
