import type { Message } from "@/state/store";
import { officeAppLabel, officeSourceState, type ConnectedAppsStatus, type OfficeSourceState } from "@shared/office-sources";
import { COMPOSER_SOURCE_LABELS, composerOfficeSourceSlugs } from "./composer-office-sources";
import type { ConnectedAppOperation } from "./connected-apps";

export type AskAppContextReason = "request" | "activity" | "sign-in";

export interface AskAppContextRow {
  slug: string;
  label: string;
  state: OfficeSourceState;
  statusLabel: string;
  reason: AskAppContextReason | null;
  reasonLabel: string | null;
}

export interface AskAppContext {
  /** Known connections, including ones that need recovery. */
  apps: AskAppContextRow[];
  relevantApps: AskAppContextRow[];
  /** Only checked, usable connections count as available. */
  availableCount: number;
  /** Mentions are browsable context; only sign-in or observed activity opens it. */
  shouldAutoOpen: boolean;
  /** Stable while replies stream or connection timestamps refresh. */
  contextKey: string;
}

const APP_ALIASES: Record<string, string[]> = {
  gmail: ["Google Mail"],
  outlook: ["Microsoft Outlook"],
  googlecalendar: ["Google Calendar", "GCal"],
  googledrive: ["Google Drive", "GDrive"],
  googlesheets: ["Google Sheets"],
  googledocs: ["Google Docs"],
  microsoftteams: ["Microsoft Teams"],
};

const REASON_LABELS: Record<AskAppContextReason, string> = {
  request: "Mentioned in this request",
  activity: "App activity in this request",
  "sign-in": "Finish sign-in",
};

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeWords = (value: string) => value.replace(/[_-]+/g, " ").replace(/\s+/g, " ");

function mentionedApp(text: string, slug: string): boolean {
  const names = [slug, officeAppLabel(slug), ...(APP_ALIASES[slug] ?? [])];
  const request = normalizeWords(text);
  return names.some(name => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapePattern(normalizeWords(name))}(?=$|[^\\p{L}\\p{N}])`, "iu").test(request));
}

function hasAppActivity(messages: Message[], operations: ConnectedAppOperation[], slug: string): boolean {
  // A generic dispatcher or an assistant's prose does not prove which app ran.
  // Structured activity names or scoped receipt tool slugs identify the app.
  const pattern = new RegExp(`(?:^|__)${escapePattern(slug)}(?:[_:.]|$)`, "i");
  return messages.some(message => message.role === "bot" && message.kind === "activity" && pattern.test(message.tool?.name ?? ""))
    || operations.some(operation => operation.toolSlugs.some(tool => pattern.test(tool)));
}

function sourceState(snapshot: ConnectedAppsStatus | null, slug: string, pendingService: string | null, error: string, now: number): OfficeSourceState {
  if (slug === pendingService) return "signing-in";
  if (error) return "degraded";
  const state = officeSourceState(snapshot, slug, now);
  if (state === "choose-account" && !snapshot?.services[slug]?.accounts.some(account => /^active$/i.test(account.status))) return "degraded";
  return state;
}

/** Derive display context only; this never selects accounts or grants app access.
 * Pass messages from the visible conversation branch, not the entire history. */
export function deriveAskAppContext({ messages, snapshot, pendingService = null, error = "", now = Date.now(), threadId, operations = [] }: {
  messages: Message[];
  snapshot: ConnectedAppsStatus | null;
  pendingService?: string | null;
  error?: string;
  now?: number;
  threadId?: string;
  operations?: ConnectedAppOperation[];
}): AskAppContext {
  let requestIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") { requestIndex = index; break; }
  }
  const request = messages[requestIndex];
  const activity = messages.slice(requestIndex + 1);
  // Receipts may include other chats and previous requests. Without a valid
  // current request timestamp, they cannot establish this request's context.
  const scopedOperations = threadId && request && Number.isFinite(request.at) && Number.isFinite(new Date(request.at).getTime())
    ? operations.filter(operation => {
      const startedAt = Date.parse(operation.startedAt);
      return operation.threadId === threadId && operation.status !== "denied" && Number.isFinite(startedAt) && startedAt >= request.at;
    }) : [];
  const apps = composerOfficeSourceSlugs(snapshot, pendingService)
    .map((slug): AskAppContextRow => {
      const state = sourceState(snapshot, slug, pendingService, error, now);
      const reason: AskAppContextReason | null = slug === pendingService ? "sign-in"
        : mentionedApp(request?.text ?? "", slug) ? "request"
          : hasAppActivity(activity, scopedOperations, slug) ? "activity" : null;
      return { slug, label: officeAppLabel(slug), state, statusLabel: COMPOSER_SOURCE_LABELS[state], reason, reasonLabel: reason ? REASON_LABELS[reason] : null };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  const relevantApps = apps.filter(app => app.reason !== null);
  // Status checks and sign-in completion must not reopen a card the user
  // dismissed. A different request or newly relevant app can resurface it.
  const contextKey = relevantApps.length ? JSON.stringify([
    request?.id ?? null,
    relevantApps.map(({ slug }) => slug),
  ]) : "";
  const shouldAutoOpen = relevantApps.some(app => app.reason === "sign-in" || hasAppActivity(activity, scopedOperations, app.slug));
  return { apps, relevantApps, availableCount: apps.filter(app => app.state === "ready").length, shouldAutoOpen, contextKey };
}
