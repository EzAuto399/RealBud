import { classifyAppToolCall } from './app-tool-policy.ts';
import { CONNECTOR_ID } from './mcp-connector.ts';

/**
 * Approval settings: how often Bud asks before it uses an app, a website or an
 * office connector. Set per department (company records) or on this computer
 * (single desktop), and read through `decide`. Three choices per group:
 *
 * - `read-without-asking`: calls on the read-only allowlist run; anything else asks.
 * - `ask`: every call shows the person a card.
 * - `deny`: nothing in the group runs.
 *
 * Groups are `app:<toolkit>`, `site:<host>` and `connector:<id>`. The locked
 * "Always asks" rows are `class:<per-instance class>` and accept only `ask` or
 * `deny`: sends, payments, signatures, notices and the rest are approved one
 * at a time whatever a group says. `reviewedReads` (owner only) lists the
 * read-only tools a direct connection may run without a card; a direct
 * connection's tool names confer no authority on their own.
 */
export type ApprovalChoice = 'read-without-asking' | 'ask' | 'deny';
export const APPROVAL_CHOICES = ['read-without-asking', 'ask', 'deny'] as const satisfies readonly ApprovalChoice[];
/** The department record key in company knowledge revisions. */
export const APPROVAL_SETTINGS_KEY = 'realbud-approval-settings:v1';

/** Actions approved one instance at a time, never by a group setting, a saved rule or a task grant. */
export const PER_INSTANCE_CLASSES = ['pay', 'sign', 'send', 'notice', 'account-change', 'trash', 'upload', 'submit', 'memory', 'consequential', 'settings', 'script'] as const;
export type PerInstanceClass = typeof PER_INSTANCE_CLASSES[number];
/** The class the enforcing boundary already gave a call (`classifyAppToolCall`,
 * the connector's owner review, the browser authority). */
export type ApprovalCallClass = 'read' | 'write' | 'blocked' | PerInstanceClass;

export interface ApprovalSettings {
  version: 1;
  purpose: 'approval-settings';
  groups: Record<string, ApprovalChoice>;
  /** Owner only: exact read-only tool names a direct connection may run without a card. */
  reviewedReads: string[];
}
/** Nothing set: every group keeps its default (see `decide`). */
export const defaultApprovalSettings = (): ApprovalSettings => ({ version: 1, purpose: 'approval-settings', groups: {}, reviewedReads: [] });

/**
 * Tools that only read and change nothing, by exact Composio slug. This is
 * deliberately not `classifyAppTool`'s `read`, which also admits draft edits
 * and deletes, attachment uploads and label edits (archive, Trash or Spam by
 * argument). Every entry is also a `read` there, and argument checks still run.
 * Add a slug only after checking it cannot send, delete, upload, label or move.
 */
export const READ_ONLY_APP_TOOLS: ReadonlySet<string> = new Set([
  // Gmail: mail, threads, history, attachments, profile, labels (listed, not edited), drafts (read), contacts.
  'GMAIL_FETCH_EMAILS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GMAIL_LIST_MESSAGES', 'GMAIL_LIST_THREADS',
  'GMAIL_LIST_HISTORY', 'GMAIL_GET_ATTACHMENT', 'GMAIL_GET_PROFILE', 'GMAIL_WHO_AM_I', 'GMAIL_LIST_LABELS', 'GMAIL_GET_LABEL',
  'GMAIL_LIST_DRAFTS', 'GMAIL_GET_DRAFT', 'GMAIL_GET_CONTACTS', 'GMAIL_GET_PEOPLE', 'GMAIL_SEARCH_PEOPLE',
  // Outlook: mail, folders, attachments (listed or downloaded), profile, mail tips and categories (read).
  'OUTLOOK_LIST_MESSAGES', 'OUTLOOK_GET_MESSAGE', 'OUTLOOK_QUERY_EMAILS', 'OUTLOOK_SEARCH_MESSAGES', 'OUTLOOK_LIST_SENT_ITEMS_MESSAGES',
  'OUTLOOK_LIST_MAIL_FOLDERS', 'OUTLOOK_LIST_MAIL_FOLDERS_DELTA', 'OUTLOOK_LIST_CHILD_MAIL_FOLDERS', 'OUTLOOK_GET_MAIL_FOLDER', 'OUTLOOK_GET_CHILD_MAIL_FOLDER',
  'OUTLOOK_LIST_MAIL_FOLDER_MESSAGES', 'OUTLOOK_LIST_CHILD_FOLDER_MESSAGES', 'OUTLOOK_GET_MAIL_FOLDER_MESSAGE', 'OUTLOOK_GET_CHILD_FOLDER_MESSAGE',
  'OUTLOOK_GET_CHILD_FOLDER_MESSAGE_CONTENT', 'OUTLOOK_GET_USER_CHILD_FOLDER_MESSAGE', 'OUTLOOK_GET_DRAFTS_MAIL_FOLDER', 'OUTLOOK_GET_MAIL_DELTA',
  'OUTLOOK_GET_ME_MESSAGE_MIME_CONTENT', 'OUTLOOK_LIST_OUTLOOK_ATTACHMENTS', 'OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT', 'OUTLOOK_LIST_MAIL_FOLDER_MESSAGE_ATTACHMENTS',
  'OUTLOOK_LIST_MESSAGE_ATTACHMENTS_FROM_CHILD_FOLDER', 'OUTLOOK_GET_ME_MAIL_FOLDER_MESSAGE_ATTACHMENT', 'OUTLOOK_GET_NESTED_FOLDER_MESSAGE_ATTACHMENT',
  'OUTLOOK_GET_USER_MESSAGES_ATTACHMENTS', 'OUTLOOK_GET_PROFILE', 'OUTLOOK_WHO_AM_I', 'OUTLOOK_GET_MAIL_TIPS',
  'OUTLOOK_GET_MASTER_CATEGORIES', 'OUTLOOK_LIST_MASTER_CATEGORIES', 'OUTLOOK_GET_MASTER_CATEGORY',
  // Calendars: events, free/busy, calendar list and settings (read).
  'GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', 'GOOGLECALENDAR_EVENTS_GET', 'GOOGLECALENDAR_EVENTS_INSTANCES',
  'GOOGLECALENDAR_FREE_BUSY_QUERY', 'GOOGLECALENDAR_CALENDAR_LIST_GET', 'GOOGLECALENDAR_SETTINGS_GET', 'GOOGLECALENDAR_SETTINGS_LIST',
  'OUTLOOK_GET_SCHEDULE',
]);
/** Browser steps that only look: reading the page and opening an address on the same site. */
export const SITE_READ_TOOLS: ReadonlySet<string> = new Set(['browser_read', 'browser_navigate']);

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TOOLKIT = /^[a-z][a-z0-9_]{1,63}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const groupKind = (key: string): 'app' | 'site' | 'connector' | 'class' | null => {
  const cut = key.indexOf(':'), kind = key.slice(0, cut), rest = key.slice(cut + 1);
  if (cut < 1) return null;
  if (kind === 'app') return TOOLKIT.test(rest) ? 'app' : null;
  if (kind === 'site') return HOST.test(rest) ? 'site' : null;
  if (kind === 'connector') return CONNECTOR_ID.test(rest) ? 'connector' : null;
  if (kind === 'class') return (PER_INSTANCE_CLASSES as readonly string[]).includes(rest) ? 'class' : null;
  return null;
};
/** A group a call can belong to (not a locked `class:` row). */
export const approvalGroupKey = (key: unknown): key is string => typeof key === 'string' && ['app', 'site', 'connector'].includes(groupKind(key) ?? '');

/**
 * Exact keys, at most 200 entries and 16 KiB. `class:` rows accept only Ask or
 * Don't use; `reviewedReads` accepts only the read-only allowlist. Throws a
 * sentence the person can act on. The result is a fresh, sorted copy.
 */
export function normalizeApprovalSettings(value: unknown): ApprovalSettings {
  const fail = (message: string): never => { throw new Error(message); };
  const shape = 'These approval settings are not in a form RealBud can use. Reload them and try again.';
  let size = Infinity;
  try { size = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { fail(shape); }
  if (size > 16_384) fail('These approval settings are too large. Keep them under 200 entries.');
  if (!object(value) || Object.keys(value).sort().join(',') !== 'groups,purpose,reviewedReads,version' ||
    value.version !== 1 || value.purpose !== 'approval-settings' || !object(value.groups) || !Array.isArray(value.reviewedReads)) return fail(shape);
  const entries = Object.entries(value.groups), reviewed = value.reviewedReads as unknown[];
  if (entries.length + reviewed.length > 200) fail('These approval settings are too large. Keep them under 200 entries.');
  const groups: Record<string, ApprovalChoice> = {};
  for (const [key, choice] of entries.sort(([a], [b]) => a < b ? -1 : 1)) {
    const kind = groupKind(key);
    if (!kind) fail('Choose an app, website or office connector for each approval setting.');
    if (!(APPROVAL_CHOICES as readonly unknown[]).includes(choice)) fail("Choose Read without asking, Ask every time or Don't use.");
    if (kind === 'class' && choice === 'read-without-asking') fail("Bud always asks before it sends, pays, signs, files a notice, changes an account or deletes. Choose Ask every time or Don't use.");
    groups[key] = choice as ApprovalChoice;
  }
  if (reviewed.some(tool => typeof tool !== 'string' || !READ_ONLY_APP_TOOLS.has(tool)) || new Set(reviewed).size !== reviewed.length) {
    fail('Only tools that only read can be marked as reviewed.');
  }
  return { version: 1, purpose: 'approval-settings', groups, reviewedReads: [...reviewed as string[]].sort() };
}

export interface ApprovalCall {
  /** `app:<toolkit>`, `site:<host>` or `connector:<id>`. */
  group: string;
  /** The exact tool name the boundary is about to dispatch. */
  tool: string;
  /** The exact arguments; read-only checks run on them. */
  args?: unknown;
  cls: ApprovalCallClass;
  /** A direct (not managed) connection: its reads also need `reviewedReads`. */
  direct?: boolean;
}
export type ApprovalDecision = 'run' | 'card' | 'refuse';

const RANK: Record<ApprovalChoice, number> = { 'read-without-asking': 0, ask: 1, deny: 2 };
const strictest = (choices: ApprovalChoice[]): ApprovalChoice => choices.reduce((a, b) => RANK[b] > RANK[a] ? b : a);
/** Unset groups keep today's behaviour: managed apps and office connectors read
 * without asking; direct connections and websites ask. A default never widens. */
const groupDefault = (call: ApprovalCall): ApprovalChoice =>
  call.direct || call.group.startsWith('site:') ? 'ask' : 'read-without-asking';
/** One department's (or this computer's) answer for one call. */
function resolve(settings: ApprovalSettings, call: ApprovalCall): ApprovalChoice {
  const choice = Object.hasOwn(settings.groups, call.group) ? settings.groups[call.group] : groupDefault(call);
  return choice === 'read-without-asking' && call.direct && !settings.reviewedReads.includes(call.tool) ? 'ask' : choice;
}
/** True when this exact call is on the read-only allowlist and its arguments pass. */
function readOnlyCall(call: ApprovalCall): boolean {
  if (call.args !== undefined && !object(call.args)) return false;
  const args = (call.args ?? {}) as Record<string, unknown>;
  const kind = groupKind(call.group), rest = call.group.slice(call.group.indexOf(':') + 1);
  if (kind === 'app') return READ_ONLY_APP_TOOLS.has(call.tool) && classifyAppToolCall(call.tool, args, { app: rest }) === 'read';
  if (kind === 'site') {
    if (!SITE_READ_TOOLS.has(call.tool)) return false;
    if (call.tool !== 'browser_navigate') return true;
    try {
      const target = new URL(String(args.url));
      return target.protocol === 'https:' && (target.hostname === rest || target.hostname.endsWith(`.${rest}`));
    } catch { return false; }
  }
  // An office connector's allowlist is the owner's own tool review: the
  // boundary passes `read` only for tools that review marked read.
  return kind === 'connector';
}

/**
 * The one widening authority for a connected-app, website or connector call.
 * Pure: it reads only the settings that govern this desktop (one per
 * department, strictest-first; or this computer's own) and the call.
 *
 * Contract: only `run` lets a call skip its card. A `card` is answered by the
 * person, one instance at a time; a `refuse` is final. No local saved rule, bot
 * `alwaysAllow` or this-task grant may turn either into a run (so none can
 * override an effective Ask or Don't use), which is why none of them is an
 * input here. Callers may only make the answer stricter. Blocked classes stay
 * refused, and the boundary's own checks (capability, receipt, argument and
 * fence checks) still run before and after.
 */
export function decide(settingsList: readonly ApprovalSettings[], call: ApprovalCall): ApprovalDecision {
  if (call.cls === 'blocked' || typeof call.tool !== 'string' || !approvalGroupKey(call.group)) return 'refuse';
  const list = settingsList.length ? settingsList : [defaultApprovalSettings()];
  const choice = strictest(list.map(settings => resolve(settings, call)));
  if (choice === 'deny') return 'refuse';
  if ((PER_INSTANCE_CLASSES as readonly string[]).includes(call.cls)) {
    return list.some(settings => settings.groups[`class:${call.cls}`] === 'deny') ? 'refuse' : 'card';
  }
  return call.cls === 'read' && choice === 'read-without-asking' && readOnlyCall(call) ? 'run' : 'card';
}

/** Card metadata shared by the approval packets. Types only until each packet
 * gives it behaviour. */
export interface ApprovalCardMeta {
  /** ISO time the request stops waiting. */
  deadline?: string;
  /** Why the card closed. */
  resolution?: 'user' | 'timeout' | 'phone' | 'stopped';
  /** Who answered and where. */
  answeredBy?: { name: string; via: 'desktop' | 'telegram' | 'discord' | 'slack' };
  /** What a phone may do with this card; absent means desktop only. */
  remote?: 'read' | 'write' | 'send' | 'desktop-only';
}
