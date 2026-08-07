import { type ProviderInstanceId } from "@t3tools/contracts";
import { ServerIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { primaryServerProvidersAtom } from "../../state/server";
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

export function HostConnectionsSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [pairingToken, setPairingToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connections = useMemo(() => deriveCocoaHostConnections(settings), [settings]);
  const providerByInstanceId = useMemo(
    () => new Map(providers.map((provider) => [provider.instanceId, provider])),
    [providers],
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
    </SettingsPageContainer>
  );
}
