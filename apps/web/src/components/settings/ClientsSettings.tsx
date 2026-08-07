import type { AuthClientSession } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { MonitorSmartphoneIcon } from "lucide-react";
import * as DateTime from "effect/DateTime";

import { primaryAuthAccessAtom } from "../../state/auth";
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

export function ClientsSettings() {
  const access = useAtomValue(primaryAuthAccessAtom);
  const clients = access.clientSessions.toSorted((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.connected !== right.connected) return left.connected ? -1 : 1;
    return DateTime.toEpochMillis(right.issuedAt) - DateTime.toEpochMillis(left.issuedAt);
  });

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("clients")}
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
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
