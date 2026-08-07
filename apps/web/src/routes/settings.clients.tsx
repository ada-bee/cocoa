import { createFileRoute } from "@tanstack/react-router";

import { ClientsSettings } from "../components/settings/ClientsSettings";

export const Route = createFileRoute("/settings/clients")({
  component: ClientsSettings,
});
