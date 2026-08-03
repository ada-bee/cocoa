import { createFileRoute } from "@tanstack/react-router";

import { DirectConnectionsSettings } from "../components/settings/DirectConnectionsSettings";

export const Route = createFileRoute("/settings/connections")({
  component: DirectConnectionsSettings,
});
