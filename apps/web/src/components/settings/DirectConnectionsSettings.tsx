import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { LinkIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairing as connectPairingAtom } from "../../connection/onboarding";
import { getPairingTokenFromUrl } from "../../pairingUrl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export interface DirectPairingInput {
  readonly host: string;
  readonly pairingCode: string;
}

export function parseDirectPairingInput(input: {
  readonly gateway: string;
  readonly pairingCode: string;
}): DirectPairingInput {
  const rawGateway = input.gateway.trim();
  if (!rawGateway) throw new Error("Enter a Cocoa gateway URL or pairing link.");

  const value = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(rawGateway)
    ? rawGateway
    : `https://${rawGateway}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid Cocoa gateway URL.");
  }

  const pairingCode = getPairingTokenFromUrl(url)?.trim() || input.pairingCode.trim();
  if (!pairingCode) throw new Error("Enter the one-time pairing code from the gateway.");

  return { host: url.origin, pairingCode };
}

function failureMessage(result: unknown): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error ? error.message : String(error);
}

export function DirectConnectionsSettings() {
  const { environments } = useEnvironments();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [gateway, setGateway] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [isPairing, setIsPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useMemo(
    () =>
      environments
        .filter((environment) => environment.entry.target._tag === "BearerConnectionTarget")
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [environments],
  );

  const pair = async () => {
    setError(null);
    let input: DirectPairingInput;
    try {
      input = parseDirectPairingInput({ gateway, pairingCode });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setIsPairing(true);
    const result = await connectPairing(input);
    setIsPairing(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return;
    }
    setGateway("");
    setPairingCode("");
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Cocoa gateways" icon={<LinkIcon className="size-4" />}>
        <SettingsRow
          title="Add gateway"
          description="Paste a full pairing link, or enter the gateway URL and one-time pairing code. Cocoa connects directly; network routing and TLS are administrator-managed."
        >
          <div className="grid gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.55fr)_auto]">
            <Input
              aria-label="Gateway URL or pairing link"
              nativeInput
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://cocoa.example.test or pairing link"
              value={gateway}
              onChange={(event) => setGateway(event.currentTarget.value)}
            />
            <Input
              aria-label="Pairing code"
              nativeInput
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="One-time pairing code"
              value={pairingCode}
              onChange={(event) => setPairingCode(event.currentTarget.value)}
            />
            <Button disabled={isPairing} onClick={() => void pair()}>
              {isPairing ? "Pairing…" : "Pair"}
            </Button>
          </div>
          {error ? <p className="pb-2 text-xs text-destructive">{error}</p> : null}
        </SettingsRow>

        {saved.length === 0 ? (
          <SettingsRow
            title="No saved gateways"
            description="Create a pairing link on the Cocoa gateway, then paste or scan it on this device."
          />
        ) : (
          saved.map((environment) => (
            <SettingsRow
              key={environment.environmentId}
              title={environment.label}
              description={environment.displayUrl ?? "Direct Cocoa gateway"}
              status={connectionStatusText(environment.connection)}
              control={
                <div className="flex gap-1">
                  <Button
                    aria-label={`Retry ${environment.label}`}
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => void retryEnvironment(environment.environmentId)}
                  >
                    <RefreshCwIcon />
                  </Button>
                  <Button
                    aria-label={`Remove ${environment.label}`}
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => void removeEnvironment(environment.environmentId)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
