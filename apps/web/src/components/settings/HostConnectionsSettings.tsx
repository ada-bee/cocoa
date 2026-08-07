import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type ProviderInstanceId } from "@t3tools/contracts";
import { LinkIcon, RefreshCwIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairing as connectPairingAtom } from "../../connection/onboarding";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  buildAddCocoaHostSettingsPatch,
  buildRemoveCocoaHostSettingsPatch,
  deriveCocoaHostConnections,
  parseCocoaHostPairingInput,
  parseGatewayPairingInput,
  type GatewayPairingInput,
} from "./HostConnectionsSettings.logic";

function providerStatusLabel(status: string | undefined): string {
  switch (status) {
    case "ready":
      return "Connected";
    case "error":
      return "Unavailable";
    case "disabled":
      return "Disabled";
    default:
      return "Checking…";
  }
}

function failureMessage(result: unknown): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error ? error.message : String(error);
}

export function HostConnectionsSettings() {
  const { environments } = useEnvironments();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [pairingToken, setPairingToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [gateway, setGateway] = useState("");
  const [gatewayPairingCode, setGatewayPairingCode] = useState("");
  const [isPairingGateway, setIsPairingGateway] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const connections = useMemo(() => deriveCocoaHostConnections(settings), [settings]);
  const providerByInstanceId = useMemo(
    () => new Map(providers.map((provider) => [provider.instanceId, provider])),
    [providers],
  );
  const savedGateways = useMemo(
    () =>
      environments
        .filter((environment) => environment.entry.target._tag === "BearerConnectionTarget")
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [environments],
  );

  const addHost = () => {
    setError(null);
    try {
      const transport = parseCocoaHostPairingInput(pairingToken);
      updateSettings(buildAddCocoaHostSettingsPatch(settings, transport));
      setPairingToken("");
      toastManager.add({
        type: "success",
        title: "Cocoa host added",
        description: `The gateway will connect to ${new URL(transport.url).hostname}.`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid Cocoa host pairing token.");
    }
  };

  const removeHost = (instanceId: ProviderInstanceId) => {
    const connection = connections.find((candidate) => candidate.instanceId === instanceId);
    if (!connection) return;
    updateSettings(buildRemoveCocoaHostSettingsPatch(settings, connection));
  };

  const pairGateway = async () => {
    setGatewayError(null);
    let input: GatewayPairingInput;
    try {
      input = parseGatewayPairingInput({ gateway, pairingCode: gatewayPairingCode });
    } catch (cause) {
      setGatewayError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setIsPairingGateway(true);
    const result = await connectPairing(input);
    setIsPairingGateway(false);
    if (result._tag === "Failure") {
      setGatewayError(failureMessage(result));
      return;
    }
    setGateway("");
    setGatewayPairingCode("");
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("remote-environments")}
        icon={<ServerIcon className="size-4" />}
      >
        <SettingsRow
          title="Add host"
          description="Paste the pairing token printed by cocoa-hostd. The token is saved by this gateway, which remains the only service your clients connect to."
        >
          <div className="grid gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              aria-label="Cocoa host pairing token"
              nativeInput
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="cocoa-host-v1:…"
              value={pairingToken}
              onChange={(event) => setPairingToken(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addHost();
              }}
            />
            <Button disabled={pairingToken.trim().length === 0} onClick={addHost}>
              Add host
            </Button>
          </div>
          {error ? <p className="pb-2 text-xs text-destructive">{error}</p> : null}
        </SettingsRow>

        {connections.length === 0 ? (
          <SettingsRow
            title="No Cocoa hosts"
            description="Start cocoa-hostd on a Codex machine, then paste its printed pairing token above."
          />
        ) : (
          connections.map((connection) => {
            const provider = providerByInstanceId.get(connection.instanceId);
            return (
              <SettingsRow
                key={connection.instanceId}
                title={
                  connection.instance.displayName ?? new URL(connection.transport.url).hostname
                }
                description={connection.transport.url}
                status={providerStatusLabel(provider?.status)}
                control={
                  <Button
                    aria-label={`Remove ${connection.instance.displayName ?? connection.instanceId}`}
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => removeHost(connection.instanceId)}
                  >
                    <Trash2Icon />
                  </Button>
                }
              />
            );
          })
        )}
      </SettingsSection>

      <SettingsSection title="Cocoa gateways" icon={<LinkIcon className="size-4" />}>
        <SettingsRow
          title="Add gateway"
          description="Pair this client with another Cocoa gateway. This is separate from the gateway-to-host connection above."
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
              aria-label="Gateway pairing code"
              nativeInput
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="One-time pairing code"
              value={gatewayPairingCode}
              onChange={(event) => setGatewayPairingCode(event.currentTarget.value)}
            />
            <Button disabled={isPairingGateway} onClick={() => void pairGateway()}>
              {isPairingGateway ? "Pairing…" : "Pair"}
            </Button>
          </div>
          {gatewayError ? <p className="pb-2 text-xs text-destructive">{gatewayError}</p> : null}
        </SettingsRow>

        {savedGateways.length === 0 ? (
          <SettingsRow
            title="No additional gateways"
            description="Paste a pairing link to make another administrator-managed Cocoa gateway available on this client."
          />
        ) : (
          savedGateways.map((environment) => (
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
                    aria-label={`Remove gateway ${environment.label}`}
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
