export const officeAppLabel = (slug) => ({
    gmail: "Gmail", outlook: "Outlook", notion: "Notion", googlecalendar: "Google Calendar",
    googledrive: "Google Drive", googlesheets: "Google Sheets", googledocs: "Google Docs",
    github: "GitHub", instagram: "Instagram", slack: "Slack",
}[slug] ?? slug.replace(/(^|[_-])([a-z])/g, (_, gap, char) => `${gap ? " " : ""}${char.toUpperCase()}`));
export function officeSourceState(access, slug, now = Date.now()) {
    if (access?.excludedApps?.includes(slug))
        return "excluded";
    if (!access?.configured)
        return "setup";
    if (access.error)
        return "degraded";
    const age = now - Date.parse(access.checkedAt);
    if (!Number.isFinite(age) || age < 0 || age > 300_000)
        return "unchecked";
    const service = access.services[slug];
    if (/init|pending/i.test(service?.status ?? ""))
        return "signing-in";
    if (!service?.connected)
        return /expir|revok|fail|error|unauth/i.test(service?.status ?? "") ? "degraded" : "connect";
    const active = service.accounts.filter(account => /^active$/i.test(account.status));
    if (service.selectedAccountId ? !active.some(account => account.id === service.selectedAccountId) : service.accountSelectionRequired || active.length !== 1)
        return "choose-account";
    if (!access.tools.available || !access.tools.names.length)
        return "degraded";
    return "ready";
}
export const OFFICE_SOURCE_LABELS = {
    setup: "Add key", unchecked: "Checking access", "signing-in": "Signing in…", connect: "Not connected",
    "choose-account": "Choose account", degraded: "Needs attention", ready: "Ready", excluded: "Off in Ask",
};
export function readyOfficeApps(access, now = Date.now()) {
    return Object.keys(access?.services ?? {}).filter(slug => officeSourceState(access, slug, now) === "ready");
}
