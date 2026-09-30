import { officeAppLabel, officeSourceState, readyOfficeApps, OFFICE_SOURCE_LABELS, type ConnectedAppsStatus, type OfficeSourceState } from "../shared/office-sources.ts";

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
    const label = officeAppLabel(slug);
    const account = service.accounts.find(row => /^active$/i.test(row.status));
    return `- **${label}** — ${appLine(status, label, account?.label)}`;
  });
  if (!lines.length) return "No office apps are set up for this desk yet. Open **Add** here, then **Open Connections**.";
  return [...lines, readyOfficeApps(snapshot).length ? `${snapshot.tools.names.length} app tools available. Manage sources in **Add**.` : "No office apps are available to this ask yet."].join("\n");
}

/** One app's state plus the real control that moves it on. Sign-in is always the person's own. */
function appLine(status: OfficeSourceState, label: string, account?: string): string {
  switch (status) {
    case "ready": return `connected${account ? ` (${account})` : ""}`;
    case "connect": return `not connected yet. Ask **Connect ${label}** here to open sign-in in your browser; you finish it there.`;
    case "signing-in": return "sign-in started. Finish it in your browser, then ask again.";
    case "choose-account": return "connected, but choose which account Bud uses in **Add**.";
    case "degraded": return `needs attention. Ask **Connect ${label}** here to sign in again.`;
    case "excluded": return "off in Ask. Turn it on in **Add**.";
    default: return OFFICE_SOURCE_LABELS[status];
  }
}
