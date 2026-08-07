import { createFileRoute } from "@tanstack/react-router";

import { HostConnectionsSettings } from "../components/settings/HostConnectionsSettings";

export const Route = createFileRoute("/settings/connections")({
  component: HostConnectionsSettings,
});
