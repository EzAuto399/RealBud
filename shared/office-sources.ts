/** Public observations only. Credentials and provider payloads never belong here. */
export interface ConnectedAccount { id: string; label?: string; status: string }
export interface ConnectedService {
  connected: boolean;
  status: string;
  accounts: ConnectedAccount[];
  accountSelectionRequired: boolean;
  selectedAccountId?: string;
}
export interface ConnectedAppsStatus {
  configured: boolean;
  checkedAt: string;
  services: Record<string, ConnectedService>;
  tools: { available: boolean; names: string[] };
  excludedApps?: string[];
  error?: string;
}
export const officeAppLabel = (slug: string): string => ({
  gmail: "Gmail", outlook: "Outlook", notion: "Notion", googlecalendar: "Google Calendar",
  googledrive: "Google Drive", googlesheets: "Google Sheets", googledocs: "Google Docs",
  github: "GitHub", instagram: "Instagram", slack: "Slack",
}[slug] ?? slug.replace(/(^|[_-])([a-z])/g, (_, gap: string, char: string) => `${gap ? " " : ""}${char.toUpperCase()}`));

export type OfficeSourceState = "setup" | "unchecked" | "signing-in" | "connect" | "choose-account" | "degraded" | "ready" | "excluded";
export function officeSourceState(access: ConnectedAppsStatus | null, slug: string, now = Date.now()): OfficeSourceState {
  if (access?.excludedApps?.includes(slug)) return "excluded";
  if (!access?.configured) return "setup";
  if (access.error) return "degraded";
  const age = now - Date.parse(access.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > 300_000) return "unchecked";
  const service = access.services[slug];
  if (/init|pending/i.test(service?.status ?? "")) return "signing-in";
  if (!service?.connected) return /expir|revok|fail|error|unauth/i.test(service?.status ?? "") ? "degraded" : "connect";
  const active = service.accounts.filter(account => /^active$/i.test(account.status));
  if (service.selectedAccountId ? !active.some(account => account.id === service.selectedAccountId) : service.accountSelectionRequired || active.length !== 1) return "choose-account";
  if (!access.tools.available || !access.tools.names.length) return "degraded";
  return "ready";
}
export const OFFICE_SOURCE_LABELS: Record<OfficeSourceState, string> = {
  setup: "Add key", unchecked: "Checking access", "signing-in": "Signing in…", connect: "Not connected",
  "choose-account": "Choose account", degraded: "Needs attention", ready: "Ready", excluded: "Off in Ask",
};
export function readyOfficeApps(access: ConnectedAppsStatus | null, now = Date.now()): string[] {
  return Object.keys(access?.services ?? {}).filter(slug => officeSourceState(access, slug, now) === "ready");
}
