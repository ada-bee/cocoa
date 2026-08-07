export const COCOA_HOST_PAIRING_PREFIX = "cocoa-host-v1:";

export interface CocoaHostPairingPayload {
  readonly version: 1;
  readonly url: string;
  readonly key: string;
}

const isPairingPayload = (value: unknown): value is CocoaHostPairingPayload => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CocoaHostPairingPayload>;
  return (
    candidate.version === 1 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0 &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0
  );
};

export const encodePairingToken = (payload: CocoaHostPairingPayload): string =>
  `${COCOA_HOST_PAIRING_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;

export const decodePairingToken = (token: string): CocoaHostPairingPayload => {
  if (!token.startsWith(COCOA_HOST_PAIRING_PREFIX)) {
    throw new Error("Invalid Cocoa host pairing token prefix");
  }

  const encoded = token.slice(COCOA_HOST_PAIRING_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (cause) {
    throw new Error("Invalid Cocoa host pairing token payload", { cause });
  }

  if (!isPairingPayload(parsed)) {
    throw new Error("Invalid Cocoa host pairing token fields");
  }
  return parsed;
};
