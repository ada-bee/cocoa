import type { AuthClientSession, AuthPairingLink } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { CopyIcon, LinkIcon, MonitorSmartphoneIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  createServerPairingCredential,
  revokeServerClientSession,
  revokeServerPairingLink,
} from "../../environments/primary";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import { primaryAuthAccessAtom } from "../../state/auth";
import { primaryServerConfigAtom } from "../../state/server";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function clientTitle(session: AuthClientSession): string {
  return session.client.label ?? `${capitalize(session.client.deviceType)} client`;
}

function clientDescription(session: AuthClientSession): string {
  const details = [session.client.os, session.client.browser, session.client.ipAddress].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return details.length > 0 ? details.join(" · ") : capitalize(session.method.replaceAll("-", " "));
}

function clientStatus(session: AuthClientSession): string {
  if (session.current) return "This client";
  return session.connected ? "Connected" : "Offline";
}

function pairingUrl(publicUrl: string, pairingLink: AuthPairingLink): string {
  const url = new URL("/pair", publicUrl);
  return setPairingTokenOnUrl(url, pairingLink.credential).toString();
}

export function ClientsSettings() {
  const access = useAtomValue(primaryAuthAccessAtom);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const [busyId, setBusyId] = useState<string | null>(null);
  const publicUrl = serverConfig?.environment.publicUrl ?? window.location.origin;
  const clients = useMemo(
    () =>
      access.clientSessions.toSorted((left, right) => {
        if (left.current !== right.current) return left.current ? -1 : 1;
        if (left.connected !== right.connected) return left.connected ? -1 : 1;
        return DateTime.toEpochMillis(right.issuedAt) - DateTime.toEpochMillis(left.issuedAt);
      }),
    [access.clientSessions],
  );

  const run = async (id: string, operation: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await operation();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Client access update failed",
        description: cause instanceof Error ? cause.message : "Try again.",
      });
    } finally {
      setBusyId(null);
    }
  };

  const createPairingLink = () =>
    run("create", async () => {
      await createServerPairingCredential({ label: "Cocoa client" });
      toastManager.add({
        type: "success",
        title: "Pairing link created",
        description: "It can be used once and expires in five minutes.",
      });
    });

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toastManager.add({ type: "success", title: "Pairing link copied" });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("clients")}
        title="Pairing"
        icon={<LinkIcon className="size-4" />}
        headerAction={
          <Button size="sm" disabled={busyId !== null} onClick={() => void createPairingLink()}>
            Create pairing link
          </Button>
        }
      >
        <SettingsRow
          title="Gateway address"
          description="Pairing links use this public address. Set COCOA_PUBLIC_URL when Cocoa is reached through a different hostname."
          status={publicUrl}
        />
        {access.pairingLinks.map((link) => {
          const url = pairingUrl(publicUrl, link);
          return (
            <SettingsRow
              key={link.id}
              title={link.label ?? "One-time pairing link"}
              description="Scan this QR code or paste the connection string into a desktop or mobile client."
              status={`Expires ${DateTime.formatIso(link.expiresAt)}`}
              control={
                <div className="flex items-center gap-2">
                  <QRCodeSvg
                    value={url}
                    size={112}
                    marginSize={3}
                    level="M"
                    title="Cocoa pairing QR code"
                    className="rounded-md border border-border"
                  />
                  <div className="flex flex-col gap-2">
                    <Button size="sm" variant="outline" onClick={() => void copy(url)}>
                      <CopyIcon className="size-3.5" /> Copy
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId !== null}
                      onClick={() => void run(link.id, () => revokeServerPairingLink(link.id))}
                    >
                      <Trash2Icon className="size-3.5" /> Revoke
                    </Button>
                  </div>
                </div>
              }
            >
              <p className="break-all py-2 font-mono text-xs text-muted-foreground">{url}</p>
            </SettingsRow>
          );
        })}
      </SettingsSection>

      <SettingsSection
        title="Authorized clients"
        icon={<MonitorSmartphoneIcon className="size-4" />}
      >
        {clients.length === 0 ? (
          <SettingsRow
            title="No authorized clients"
            description="Desktop, mobile, tablet, and browser sessions authorized with this Cocoa gateway appear here."
          />
        ) : (
          clients.map((client) => (
            <SettingsRow
              key={client.sessionId}
              title={clientTitle(client)}
              description={clientDescription(client)}
              status={clientStatus(client)}
              control={
                client.current ? undefined : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId !== null}
                    onClick={() =>
                      void run(client.sessionId, () => revokeServerClientSession(client.sessionId))
                    }
                  >
                    Revoke
                  </Button>
                )
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
