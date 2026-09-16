import { officeAppLabel, officeSourceState, readyOfficeApps, OFFICE_SOURCE_LABELS, type ConnectedAppsStatus } from "../shared/office-sources.ts";

export { parseConnectedStatusIntent } from "../shared/ask-controls.ts";

export function formatConnectedAppsReply(access: Omit<ConnectedAppsStatus, "checkedAt" | "services"> & {
  checkedAt?: string;
  services: Record<string, Omit<ConnectedAppsStatus["services"][string], "accountSelectionRequired"> & { accountSelectionRequired?: boolean }>;
}): string {
  if (!access.configured) return "No office apps connected yet. Open **Add** to connect one here.";
  if (access.error) return "I couldn’t verify office apps just now. Your saved settings are kept. Open **Add** to try again.";
  const snapshot: ConnectedAppsStatus = { ...access, checkedAt: access.checkedAt ?? new Date().toISOString(),
    services: Object.fromEntries(Object.entries(access.services).map(([slug, service]) => [slug, { ...service, accountSelectionRequired: service.accountSelectionRequired ?? false }])) };
  const lines = Object.keys(snapshot.services).filter(slug => ["gmail", "outlook"].includes(slug) || snapshot.services[slug]?.connected || /init|pending|expir|revok|fail/i.test(snapshot.services[slug]?.status ?? "") || snapshot.excludedApps?.includes(slug)).map(slug => {
    const status = officeSourceState(snapshot, slug);
    const service = snapshot.services[slug]!;
    const account = service.accounts.find(row => /^active$/i.test(row.status));
    return `- **${officeAppLabel(slug)}** — ${status === "ready" ? `connected${account?.label ? ` (${account.label})` : ""}` : OFFICE_SOURCE_LABELS[status]}`;
  });
  return [...lines, readyOfficeApps(snapshot).length ? `${snapshot.tools.names.length} app tools available. Manage sources in **Add**.` : "No office apps are available to this ask yet. Open **Add** to choose or reconnect a source."].join("\n");
}
