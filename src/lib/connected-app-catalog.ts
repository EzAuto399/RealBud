import { OFFICE_SOURCE_LABELS, officeAppLabel, officeSourceState, type ConnectedAppsStatus } from '@shared/office-sources';
import type { HermiosConnectionState } from '@shared/hermios-connection';
import type { ConnectorState } from '@shared/mcp-connector';
import { REDBARK_LABEL } from '@shared/redbark-connection';

type AppSuggestion = { slug: string; label: string; category: string; purpose: string; aliases?: string };
// Suggestions help people find an app. Only the service response establishes
// which connections this installation offers or which accounts are connected.
const COMMON_APPS: readonly AppSuggestion[] = [
  { slug: 'gmail', label: 'Gmail', category: 'Email', purpose: 'Work mail and conversations', aliases: 'google mail inbox' },
  { slug: 'outlook', label: 'Outlook', category: 'Email', purpose: 'Microsoft work mail', aliases: 'microsoft office inbox' },
  { slug: 'googlecalendar', label: 'Google Calendar', category: 'Calendar', purpose: 'Events and appointments', aliases: 'schedule meetings' },
  { slug: 'googledrive', label: 'Google Drive', category: 'Files', purpose: 'Shared files and folders', aliases: 'documents storage' },
  { slug: 'googlesheets', label: 'Google Sheets', category: 'Spreadsheets', purpose: 'Spreadsheets and reports', aliases: 'tables google workspace' },
  { slug: 'googledocs', label: 'Google Docs', category: 'Documents', purpose: 'Documents and written work', aliases: 'google workspace files' },
  { slug: 'xero', label: 'Xero', category: 'Accounting', purpose: 'Business accounting', aliases: 'finance bookkeeping' },
  { slug: 'slack', label: 'Slack', category: 'Team chat', purpose: 'Team conversations', aliases: 'messages collaboration' },
  { slug: 'notion', label: 'Notion', category: 'Notes', purpose: 'Notes, projects and knowledge', aliases: 'wiki documents' },
];

export interface ConnectedAppCatalogEntry extends AppSuggestion {
  /** `native`: RealBud's own connection (Hermios, Redbark), not the connection service. */
  origin: 'suggested' | 'reported' | 'native';
  /** Shown first, as its own tile. */
  featured?: boolean;
  connected: boolean;
  status: string;
  detail: string;
  action: 'connect' | 'find' | null;
}

export const HERMIOS_APP_SLUG = 'hermios-native';
/** The office shared mailbox beside the person's own Gmail (mailbox mode `both`). */
export const OFFICE_GMAIL_SLUG = 'gmail-office';
export const REDBARK_APP_SLUG = 'redbark-native';

/** What the Hermios tile says, from Bud's own Hermios connection state only. A
 *  generic connection-service app named "hermios" never counts. */
export function hermiosCatalogStatus(state: HermiosConnectionState | null): string {
  if (!state) return 'Connection not checked yet';
  switch (state.status) {
    case 'not_connected': return 'Not connected';
    case 'connecting': return 'Finish signing in to Hermios in your browser';
    case 'connected': return state.account ? `Connected as ${state.account.displayName} · ${state.account.workspaceLabel}` : 'Connection not checked yet';
    case 'needs_reconnect': return state.reason ?? "Bud's Hermios connection needs you to sign in again.";
    case 'unavailable': return state.reason ?? "Bud's Hermios connection isn't available right now.";
  }
}

/** What the bank feed tile says, from the office's Redbark connector state only. */
export function bankFeedCatalogStatus(state: ConnectorState | null): string {
  if (!state) return 'Connection not checked yet';
  switch (state.status) {
    case 'not_connected': return state.canManage ? 'Not connected' : 'Not connected. The office owner can connect it.';
    case 'connecting': return 'Finish signing in to Redbark in your browser';
    case 'connected': return state.account ? `Connected as ${state.account.label}` : 'Connection not checked yet';
    case 'needs_reconnect': return state.reason ?? 'The bank feed needs the office to sign in to Redbark again.';
    case 'unavailable': return state.reason ?? "The bank feed isn't available right now.";
  }
}

export function connectedAppCatalog(snapshot: ConnectedAppsStatus | null, options: { configured: boolean; readOnly: boolean; managed: boolean; hermios?: HermiosConnectionState | null; bankFeed?: ConnectorState | null }): ConnectedAppCatalogEntry[] {
  const suggestions = COMMON_APPS.filter(app => !options.readOnly || app.slug === 'gmail');
  const bySlug = new Map(suggestions.map(app => [app.slug, app]));
  for (const slug of Object.keys(snapshot?.services ?? {})) {
    if (!bySlug.has(slug) && (!options.readOnly || slug === 'gmail')) bySlug.set(slug, { slug, label: officeAppLabel(slug), category: 'Connected service', purpose: 'Listed by your connection service' });
  }
  const entries = [...bySlug.values()].map((app): ConnectedAppCatalogEntry => {
    const service = snapshot?.services[app.slug], connected = service?.connected === true;
    const sharedGmail = app.slug === 'gmail' && snapshot?.sourceKind === 'office_shared';
    const ownGmail = app.slug === 'gmail' && snapshot?.mailboxMode === 'both';
    const gmailUnchecked = app.slug === 'gmail' && options.managed && (!service || Boolean(snapshot?.error));
    const excluded = snapshot?.excludedApps?.includes(app.slug) === true;
    const state = officeSourceState(snapshot, app.slug);
    const status = !options.configured ? 'Setup needed' : excluded ? 'Off in Ask' : sharedGmail && !connected ? 'Office setup needed'
      : gmailUnchecked ? 'Check access first' : !service ? 'Availability not checked' : OFFICE_SOURCE_LABELS[state];
    return { ...app, ...(ownGmail ? { label: 'Your Gmail', purpose: 'Your own work mail on this computer' } : {}), origin: service ? 'reported' : 'suggested', connected, status,
      detail: ownGmail ? 'Only you use this mailbox. Bud uses it unless you ask for the office mailbox.' : sharedGmail ? connected ? 'Office shared account' : 'Ask the office owner to connect it, then check access again.'
        : service ? 'Reported by your connection service' : 'Bud will check whether your service offers this connection.',
      action: !options.configured || connected || excluded || sharedGmail || gmailUnchecked || state === 'signing-in' ? null : service ? 'connect' : 'find' };
  });
  if (snapshot?.mailboxMode === 'both' && !options.readOnly) {
    // Read-only here: the office owner connects it on the website and allows computers.
    const office = snapshot.officeShared, connected = office?.connected === true;
    entries.push({ slug: OFFICE_GMAIL_SLUG, label: 'Office shared Gmail', category: 'Email', purpose: 'The office mailbox the owner connected', aliases: 'gmail shared office mailbox inbox',
      origin: 'reported', connected, status: !options.configured ? 'Setup needed' : connected ? 'Ready' : 'Not allowed on this computer',
      detail: connected ? 'Bud uses it only when you ask for the office mailbox.' : 'The office owner connects it and chooses which computers may use it.', action: null });
  }
  const hermios = options.hermios ?? null;
  entries.push({ slug: HERMIOS_APP_SLUG, label: 'Hermios CRM', category: 'CRM', purpose: 'Customer records for your office', aliases: 'contacts customers pipeline crm',
    origin: 'native', featured: true, connected: hermios?.status === 'connected' && hermios.account !== null, status: hermiosCatalogStatus(hermios),
    detail: "Your Hermios window and Bud's connection are separate.", action: null });
  const bankFeed = options.bankFeed ?? null;
  entries.push({ slug: REDBARK_APP_SLUG, label: REDBARK_LABEL, category: 'Banking', purpose: 'Office bank accounts and transactions', aliases: 'bank feed redbark accounts transactions reconciliation',
    origin: 'native', connected: bankFeed?.status === 'connected' && bankFeed.account !== null, status: bankFeedCatalogStatus(bankFeed),
    detail: 'Bud can read accounts and transactions only. It cannot move money or change anything.', action: null });
  return entries.sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || Number(b.connected) - Number(a.connected));
}

export function filterConnectedAppCatalog(apps: readonly ConnectedAppCatalogEntry[], query: string, filter: 'all' | 'connected'): ConnectedAppCatalogEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return apps.filter(app => (filter !== 'connected' || app.connected) && terms.every(term =>
    [app.label, app.slug, app.category, app.purpose, app.aliases ?? ''].join(' ').toLocaleLowerCase().includes(term)));
}

/** Preserve the existing Ask connection route; catalog suggestions grant no access. */
export function appConnectionPrompt(label: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(label)) return null;
  const name = label.trim().replace(/\s+/g, ' ');
  return name && name.length <= 40 ? `connect ${name}` : null;
}
