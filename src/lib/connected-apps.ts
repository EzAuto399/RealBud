import type { AskWorkContext } from "./work-continuation";

export const EMAIL_APPS = [{ slug: "gmail", label: "Gmail" }, { slug: "outlook", label: "Outlook" }] as const;
export type EmailApp = typeof EMAIL_APPS[number]["slug"];
export type { ConnectedAccount, ConnectedService, ConnectedAppsStatus } from "@shared/office-sources";
import type { ConnectedAccount, ConnectedService, ConnectedAppsStatus } from "@shared/office-sources";
export interface ConnectedAppOperation {
  id: string;
  threadId: string;
  toolName: string;
  toolSlugs: string[];
  status: "started" | "succeeded" | "failed" | "unknown" | "denied";
  startedAt: string;
  finishedAt?: string;
  detail?: string;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const label = (value: unknown, max = 300) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "";

/** Project only the product status contract; never retain provider payloads. */
export function readConnectedAppsStatus(value: unknown): ConnectedAppsStatus {
  if (!record(value) || typeof value.configured !== "boolean" || !record(value.services) || !record(value.tools) ||
    typeof value.tools.available !== "boolean" || !Array.isArray(value.tools.names)) throw new Error("Connected app status was incomplete. Check access again.");
  const services: Record<string, ConnectedService> = {};
  for (const slug of Object.keys(value.services).slice(0, 100)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(slug)) continue;
    const service = value.services[slug];
    if (service === undefined) continue;
    if (!record(service) || typeof service.connected !== "boolean" || !Array.isArray(service.accounts) ||
      typeof service.accountSelectionRequired !== "boolean" || service.accounts.length > 500) throw new Error("Account status was incomplete. Check access again.");
    const seen = new Set<string>();
    const accounts = service.accounts.map((account): ConnectedAccount => {
      if (!record(account) || typeof account.id !== "string" || !account.id.trim() || account.id.length > 300 ||
        /[\u0000-\u001f\u007f]/.test(account.id) || seen.has(account.id)) throw new Error("Account identity was unclear. Check access again.");
      const id = account.id;
      seen.add(id);
      return { id, ...(label(account.label) ? { label: label(account.label) } : {}), status: label(account.status, 80) || "unknown" };
    });
    services[slug] = { ...(typeof service.selectedAccountId === "string" && accounts.some(account => account.id === service.selectedAccountId) ? { selectedAccountId: service.selectedAccountId } : {}), connected: service.connected, status: label(service.status, 80) || "unknown", accounts, accountSelectionRequired: service.accountSelectionRequired };
  }
  return {
    excludedApps: Array.isArray(value.excludedApps) ? value.excludedApps.filter((slug): slug is string => typeof slug === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(slug)).slice(0, 100) : [],
    configured: value.configured, checkedAt: timestamp(value.checkedAt), services,
    tools: { available: value.tools.available, names: [...new Set(value.tools.names.map(name => label(name, 160)).filter(Boolean))].slice(0, 200) },
    ...(label(value.error, 600) ? { error: label(value.error, 600) } : {}),
  };
}

export function activeConnectedAccounts(service?: ConnectedService): ConnectedAccount[] {
  return service?.connected ? service.accounts.filter(account => /^active$/i.test(account.status) && account.id) : [];
}

export function selectedConnectedAccount(service: ConnectedService | undefined, selectedId = ""): ConnectedAccount | null {
  const accounts = activeConnectedAccounts(service);
  selectedId ||= service?.selectedAccountId ?? "";
  if (selectedId) return accounts.find(account => account.id === selectedId) ?? null;
  return accounts.length === 1 && !service?.accountSelectionRequired ? accounts[0] : null;
}

export function canPrepareConnectedEmail(snapshot: ConnectedAppsStatus | null, app: EmailApp, selectedId = "", now = Date.now()): boolean {
  const age = now - Date.parse(snapshot?.checkedAt ?? "");
  return Boolean(snapshot?.configured && !snapshot.excludedApps?.includes(app) && !snapshot.error && Number.isFinite(age) && age >= 0 && age <= 5 * 60_000 && snapshot.tools.available &&
    snapshot.tools.names.length && selectedConnectedAccount(snapshot.services[app], selectedId));
}

export function connectedEmailContext(snapshot: ConnectedAppsStatus | null, app: EmailApp, selectedId: string, id: string, now = Date.now()): AskWorkContext | null {
  if (!canPrepareConnectedEmail(snapshot, app, selectedId, now) || !Number.isFinite(new Date(now).getTime()) || !Number.isFinite(new Date(now - 7 * 86_400_000).getTime())) return null;
  const account = selectedConnectedAccount(snapshot!.services[app], selectedId)!;
  const appLabel = EMAIL_APPS.find(row => row.slug === app)!.label;
  const from = new Date(now - 7 * 86_400_000).toISOString();
  const until = new Date(now).toISOString();
  const instruction = `Prepare email follow-ups from ${appLabel} for the selected account, using the attached scope. Read at most 10 threads from the last 7 days, group them by property, and prepare source-linked next steps and reply text here for my review. Do not send, save mailbox drafts, mark read, archive, label, delete, or change anything in the mailbox.`;
  return {
    id, sourceKey: `connected-email-${app}-${encodeURIComponent(account.id)}`, title: `${appLabel} follow-up scope`, instruction,
    text: [
      "Selected task scope from RealBud. This is reference for the PM's editable request, not an execution approval.",
      `App: ${appLabel}; selected account ID: ${JSON.stringify(account.id)}${account.label ? `; provider label: ${JSON.stringify(account.label)}` : ""}.`,
      `Connection and tool discovery checked: ${snapshot!.checkedAt}. This does not prove mailbox access, current messages, or granted scopes.`,
      `Read only the selected account, from ${from} through ${until}. Maximum 10 threads in total. Explain the selection and any unreviewed remainder; do not claim to have reviewed the whole inbox.`,
      "Confirm the tool's account binding before reading. This account choice is advisory: if the provider cannot target it unambiguously, stop and ask. Each app operation still requires RealBud's separate review.",
      "Group related messages by property using source evidence. Flag unclear property matches and urgent issues. Include message IDs or links, source dates, who owes the next response, and proposed reply text. Recheck newer replies within this bounded scope before proposing follow-ups.",
      "Prepare the result locally in Ask. Do not send messages, create or update mailbox drafts, mark messages read, archive, label, delete, dispatch contractors, or change records. If access or inputs are missing, explain what is missing. No recurring email run is created.",
    ].join("\n\n"),
  };
}

export function readConnectedAppOperations(value: unknown): ConnectedAppOperation[] {
  if (!record(value) || !Array.isArray(value.operations)) throw new Error("Recent app activity could not be read.");
  const statuses = new Set(["started", "succeeded", "failed", "unknown", "denied"]);
  return value.operations.slice(0, 200).map((entry): ConnectedAppOperation => {
    if (!record(entry) || !label(entry.id) || !timestamp(entry.startedAt) || !statuses.has(String(entry.status)) || !Array.isArray(entry.toolSlugs)) throw new Error("Recent app activity was incomplete.");
    return {
      id: label(entry.id), threadId: label(entry.threadId), toolName: label(entry.toolName, 160),
      toolSlugs: entry.toolSlugs.map(slug => label(slug, 160)).filter(Boolean).slice(0, 50),
      status: entry.status as ConnectedAppOperation["status"], startedAt: timestamp(entry.startedAt),
      ...(timestamp(entry.finishedAt) ? { finishedAt: timestamp(entry.finishedAt) } : {}),
      ...(label(entry.detail, 600) ? { detail: label(entry.detail, 600) } : {}),
    };
  }).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export const APP_OPERATION_LABELS: Record<ConnectedAppOperation["status"], string> = {
  started: "In progress", succeeded: "Result returned", failed: "Failed", unknown: "Outcome needs checking", denied: "Not allowed",
};

export function connectedAppOperationContext(operation: ConnectedAppOperation, id: string): AskWorkContext {
  return {
    id, sourceKey: `connected-app-operation-${operation.id}`, title: "Connected app operation",
    instruction: "Help me review this connected-app receipt and understand the next safe step. Do not repeat the operation or start another app action from this receipt.",
    text: [
      "Recorded connected-app receipt. Reference only; no permission to execute or retry.",
      `Operation: ${operation.id}; Ask thread: ${operation.threadId}; recorded state: ${operation.status}.`,
      `Tool: ${operation.toolName}; app operations: ${operation.toolSlugs.join(", ") || "not supplied"}.`,
      `Started: ${operation.startedAt}; finished: ${operation.finishedAt || "not recorded"}.`,
      operation.detail || "No further outcome detail recorded.",
      "An allowed request is not proof of success. For an unknown outcome, check the app before any new action. This receipt contains no message contents or confirmation of current mailbox state.",
    ].join("\n\n"),
  };
}
