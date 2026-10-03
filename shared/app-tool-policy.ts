/**
 * One classification of a connected-app tool, shared by the desktop broker and
 * the managed gateway so both boundaries hold the same line:
 *
 * - `read`: a bounded read. The desktop lets it run without a card; the gateway
 *   forwards it.
 * - `review`: anything that writes, sends, pays, changes or is unknown. The
 *   desktop shows the person Bud's Allow card first (per instance, exact
 *   payload); the gateway forwards only what the desktop dispatched.
 * - `blocked`: destructive, bulk or administrative. Refused at both boundaries;
 *   no approval can admit it.
 *
 * The class comes from the tool's name, read as whole `_`-separated tokens
 * (so `BANK` is not `BAN` and `LIST_ALL_CHANNELS` is a list), and, when the
 * provider supplies them, MCP-style annotations. Annotations can only make a
 * tool stricter: a `readOnlyHint` never turns a write-looking name into a read,
 * and a `destructiveHint` blocks a tool whatever its name says. Unknown stays
 * `review`. Mailbox tools (Gmail, Outlook mail) are decided by exact Composio
 * slug lists below, never by verb parsing (owner decision 2026-10-02). This is
 * used only behind the managed gateway; a direct connection keeps the older
 * review-everything default, and the project-key Gmail reader keeps its own
 * fixed three-tool allowlist.
 */
export type AppToolPolicy = "read" | "review" | "blocked";

export interface AppToolAnnotations {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
}

export const APP_TOOL_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;

/** A tool reads only when its verb is one of these… */
const READ_VERBS = new Set([
  "GET", "LIST", "FETCH", "SEARCH", "FIND", "RETRIEVE", "READ", "DESCRIBE", "LOOKUP", "CHECK", "COUNT", "VIEW", "SHOW",
  "PREVIEW", "EXPORT", "DOWNLOAD", "INSPECT", "BROWSE", "ENUMERATE", "WHOAMI",
]);
/** …and no later token says it also changes something (`GET_OR_CREATE`, `LIST_AND_SEND`, `RUN_QUERY`). */
const WRITE_TOKENS = new Set([
  "CREATE", "UPDATE", "SET", "ADD", "SEND", "MARK", "MOVE", "REPLACE", "RUN", "EXECUTE", "OR", "AND", "QUERY", "WRITE", "PUT", "POST",
  "PATCH", "EDIT", "MODIFY", "UPSERT", "INSERT", "APPEND", "SAVE", "SUBMIT", "UPLOAD", "IMPORT", "TRIGGER", "START", "STOP", "WATCH",
  "ARCHIVE", "RESTORE", "ASSIGN", "INVITE", "SHARE", "PUBLISH", "SCHEDULE", "GENERATE", "REGISTER", "SUBSCRIBE", "ENABLE", "DISABLE",
  "RENAME", "COPY", "REPLY", "FORWARD", "MERGE", "SYNC", "REFRESH", "ACCEPT", "REJECT", "PAY", "TRANSFER", "CHARGE", "REFUND", "APPROVE",
]);
/** A token that destroys, acts in bulk or administers blocks the tool outright. */
const BLOCKED_TOKENS = new Set([
  "DELETE", "REMOVE", "PURGE", "DESTROY", "WIPE", "ERASE", "TRUNCATE", "DROP", "PERMANENT", "PERMANENTLY", "BULK", "EMPTY",
  "REVOKE", "GRANT", "ADMIN", "PERMISSION", "PERMISSIONS", "ROLE", "ROLES", "OWNERSHIP", "ROTATE", "REGENERATE", "DEACTIVATE",
  "SUSPEND", "BAN", "UNINSTALL", "CLEAR", "RESET", "TERMINATE", "VOID", "FACTORY", "PASSWORD", "TOKEN", "TOKENS", "WEBHOOK", "WEBHOOKS",
  // Cancelling a meeting or booking removes it for everyone on it.
  "CANCEL",
]);
/**
 * Reviewed calendar reads whose vendor slug puts the resource before the verb
 * (`EVENTS_LIST`) or names the read with a write-looking token (`FREE_BUSY_QUERY`,
 * `GET_SCHEDULE`). Exact slugs only; annotations can still tighten them.
 */
const KNOWN_READS = new Set([
  "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", "GOOGLECALENDAR_EVENTS_GET", "GOOGLECALENDAR_EVENTS_INSTANCES",
  "GOOGLECALENDAR_FREE_BUSY_QUERY", "GOOGLECALENDAR_CALENDAR_LIST_GET", "GOOGLECALENDAR_SETTINGS_GET", "GOOGLECALENDAR_SETTINGS_LIST",
  "OUTLOOK_GET_SCHEDULE",
]);

/**
 * Mailbox tools, by exact Composio slug (`composio tools list gmail|outlook`,
 * checked 2026-10-02). Owner decision `docs/decisions/2026-10-02-bud-office-pa-access.md`:
 *
 * - no card: search, list and read mail, attachments, profile and labels;
 *   create, edit and delete drafts; label, archive, mark read/unread, star.
 * - card per message: send, reply, forward (including sending a saved draft)
 *   and moving to Trash. Bud reads untrusted mail, so a prompt-injected email
 *   must never send on the office's behalf without the person seeing it.
 * - blocked: permanent delete, filters and forwarding rules, settings and
 *   delegation changes.
 *
 * A reviewed slug is RealBud's decision, so provider annotations do not move
 * it (Composio marks `GMAIL_SEND_DRAFT` destructive and `GMAIL_DELETE_DRAFT`
 * destructive; both are decided here). An unlisted mail tool is never a read:
 * it is reviewed, or blocked when its name destroys or administers.
 */
export const MAIL_READS = new Set([
  // Gmail: reading mail, attachments, profile, labels and contacts.
  "GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "GMAIL_LIST_MESSAGES", "GMAIL_LIST_THREADS",
  "GMAIL_LIST_HISTORY", "GMAIL_GET_ATTACHMENT", "GMAIL_GET_PROFILE", "GMAIL_WHO_AM_I", "GMAIL_LIST_LABELS", "GMAIL_GET_LABEL",
  "GMAIL_LIST_DRAFTS", "GMAIL_GET_DRAFT", "GMAIL_GET_CONTACTS", "GMAIL_GET_PEOPLE", "GMAIL_SEARCH_PEOPLE",
  // Gmail: drafts, and label edits (archive = remove INBOX, read = remove UNREAD, star = add STARRED).
  // A label edit that touches TRASH or SPAM is reviewed per call (see classifyAppToolCall).
  "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_UPDATE_DRAFT", "GMAIL_DELETE_DRAFT",
  "GMAIL_ADD_LABEL_TO_EMAIL", "GMAIL_MODIFY_THREAD_LABELS", "GMAIL_BATCH_MODIFY_MESSAGES", "GMAIL_UNTRASH_MESSAGE", "GMAIL_UNTRASH_THREAD",
  // Outlook: reading mail, folders, attachments, profile and categories.
  "OUTLOOK_LIST_MESSAGES", "OUTLOOK_GET_MESSAGE", "OUTLOOK_QUERY_EMAILS", "OUTLOOK_SEARCH_MESSAGES", "OUTLOOK_LIST_SENT_ITEMS_MESSAGES",
  "OUTLOOK_LIST_MAIL_FOLDERS", "OUTLOOK_LIST_MAIL_FOLDERS_DELTA", "OUTLOOK_LIST_CHILD_MAIL_FOLDERS", "OUTLOOK_GET_MAIL_FOLDER", "OUTLOOK_GET_CHILD_MAIL_FOLDER",
  "OUTLOOK_LIST_MAIL_FOLDER_MESSAGES", "OUTLOOK_LIST_CHILD_FOLDER_MESSAGES", "OUTLOOK_GET_MAIL_FOLDER_MESSAGE", "OUTLOOK_GET_CHILD_FOLDER_MESSAGE",
  "OUTLOOK_GET_CHILD_FOLDER_MESSAGE_CONTENT", "OUTLOOK_GET_USER_CHILD_FOLDER_MESSAGE", "OUTLOOK_GET_DRAFTS_MAIL_FOLDER", "OUTLOOK_GET_MAIL_DELTA",
  "OUTLOOK_GET_ME_MESSAGE_MIME_CONTENT", "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS", "OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT", "OUTLOOK_LIST_MAIL_FOLDER_MESSAGE_ATTACHMENTS",
  "OUTLOOK_LIST_MESSAGE_ATTACHMENTS_FROM_CHILD_FOLDER", "OUTLOOK_GET_ME_MAIL_FOLDER_MESSAGE_ATTACHMENT", "OUTLOOK_GET_NESTED_FOLDER_MESSAGE_ATTACHMENT",
  "OUTLOOK_GET_USER_MESSAGES_ATTACHMENTS", "OUTLOOK_GET_PROFILE", "OUTLOOK_WHO_AM_I", "OUTLOOK_GET_MAIL_TIPS",
  "OUTLOOK_GET_MASTER_CATEGORIES", "OUTLOOK_LIST_MASTER_CATEGORIES", "OUTLOOK_GET_MASTER_CATEGORY",
  // Outlook: drafts (new, reply, reply-all, forward), draft attachments, and
  // message updates (draft edits, read/unread, flag, categories).
  "OUTLOOK_CREATE_DRAFT", "OUTLOOK_CREATE_DRAFT_REPLY", "OUTLOOK_CREATE_REPLY_ALL_DRAFT", "OUTLOOK_CREATE_ME_REPLY_DRAFT", "OUTLOOK_CREATE_ME_REPLY_ALL_DRAFT",
  "OUTLOOK_CREATE_ME_MESSAGE_REPLY_ALL_DRAFT", "OUTLOOK_CREATE_ME_MAIL_FOLDER_MESSAGE_REPLY_ALL_DRAFT", "OUTLOOK_CREATE_USER_MAIL_FOLDER_MESSAGE_REPLY_DRAFT",
  "OUTLOOK_CREATE_FORWARD_DRAFT", "OUTLOOK_CREATE_ME_FORWARD_DRAFT", "OUTLOOK_ADD_MAIL_ATTACHMENT", "OUTLOOK_CREATE_MESSAGE_ATTACHMENT",
  "OUTLOOK_UPDATE_EMAIL", "OUTLOOK_BATCH_UPDATE_MESSAGES", "OUTLOOK_UPDATE_USER_MAIL_FOLDER_MESSAGE", "OUTLOOK_UPDATE_USER_CHILD_FOLDER_MESSAGE",
]);
/** Sends: one card per message, never inside a batch. */
export const MAIL_SENDS = new Set([
  "GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD", "GMAIL_FORWARD_MESSAGE", "GMAIL_SEND_DRAFT",
  "OUTLOOK_SEND_EMAIL", "OUTLOOK_REPLY_EMAIL", "OUTLOOK_FORWARD_MESSAGE", "OUTLOOK_SEND_DRAFT",
]);
/** Outlook archive is a move; only a move to these well-known folders runs without a card. */
export const MAIL_MOVES = new Set(["OUTLOOK_MOVE_MESSAGE", "OUTLOOK_BATCH_MOVE_MESSAGES", "OUTLOOK_MOVE_MESSAGE_FROM_FOLDER", "OUTLOOK_MOVE_MESSAGE_FROM_CHILD_FOLDER"]);
const MAIL_REVIEWS = new Set([
  ...MAIL_SENDS, ...MAIL_MOVES,
  // Trash is recoverable, but it hides mail from the office: reviewed.
  "GMAIL_MOVE_TO_TRASH", "GMAIL_MOVE_THREAD_TO_TRASH",
  // Label definitions, mailbox inserts and settings reads are not on the no-card list.
  "GMAIL_CREATE_LABEL", "GMAIL_PATCH_LABEL", "GMAIL_UPDATE_LABEL", "GMAIL_IMPORT_MESSAGE", "GMAIL_INSERT_MESSAGE",
  "GMAIL_GET_AUTO_FORWARDING", "GMAIL_GET_FILTER", "GMAIL_LIST_FILTERS", "GMAIL_LIST_FORWARDING_ADDRESSES", "GMAIL_GET_VACATION_SETTINGS",
  "GMAIL_GET_LANGUAGE_SETTINGS", "GMAIL_LIST_SEND_AS", "GMAIL_SETTINGS_SEND_AS_GET", "GMAIL_SETTINGS_GET_IMAP", "GMAIL_SETTINGS_GET_POP",
  "GMAIL_LIST_CSE_IDENTITIES", "GMAIL_LIST_CSE_KEYPAIRS", "GMAIL_LIST_SMIME_INFO",
  "OUTLOOK_LIST_EMAIL_RULES", "OUTLOOK_LIST_MAIL_FOLDER_MESSAGE_RULES", "OUTLOOK_GET_MAIL_FOLDER_MESSAGE_RULE", "OUTLOOK_GET_MAILBOX_SETTINGS",
  "OUTLOOK_COPY_MESSAGE", "OUTLOOK_CREATE_MAIL_FOLDER",
]);
const MAIL_BLOCKED = new Set([
  // Permanent delete (Gmail has no empty-trash tool; an unlisted EMPTY or PURGE is blocked by name).
  "GMAIL_DELETE_MESSAGE", "GMAIL_DELETE_THREAD", "GMAIL_BATCH_DELETE_MESSAGES", "GMAIL_DELETE_LABEL", "GMAIL_REMOVE_LABEL",
  "OUTLOOK_DELETE_MESSAGE", "OUTLOOK_PERMANENT_DELETE_MESSAGE", "OUTLOOK_DELETE_MESSAGE_PERMANENTLY_FROM_FOLDER", "OUTLOOK_DELETE_MAIL_FOLDER",
  // Filters and forwarding or inbox rules: a standing exfiltration route.
  "GMAIL_CREATE_FILTER", "GMAIL_DELETE_FILTER",
  "OUTLOOK_CREATE_EMAIL_RULE", "OUTLOOK_UPDATE_EMAIL_RULE", "OUTLOOK_DELETE_EMAIL_RULE", "OUTLOOK_CREATE_MAIL_FOLDER_MESSAGE_RULE",
  "OUTLOOK_UPDATE_USER_MAIL_FOLDER_MESSAGE_RULE", "OUTLOOK_DELETE_ME_MAIL_FOLDER_MESSAGE_RULE",
  // Settings, send-as identity, auto-reply, delegation and push watch.
  "GMAIL_UPDATE_VACATION_SETTINGS", "GMAIL_UPDATE_IMAP_SETTINGS", "GMAIL_UPDATE_POP_SETTINGS", "GMAIL_UPDATE_LANGUAGE_SETTINGS",
  "GMAIL_UPDATE_SEND_AS", "GMAIL_PATCH_SEND_AS", "GMAIL_STOP_WATCH",
  "OUTLOOK_UPDATE_MAILBOX_SETTINGS", "OUTLOOK_UPDATE_INFERENCE_CLASSIFICATION", "OUTLOOK_CREATE_ME_INFERENCE_CLASSIFICATION_OVERRIDE",
  "OUTLOOK_UPDATE_USER_INFERENCE_CLASSIFICATION_OVERRIDE",
]);
/** Outlook shares its toolkit with calendar, contacts and tasks; these name
 * tokens mark an unlisted Outlook tool as mail. Teams chat is not mail. */
const MAIL_MARKERS = new Set(["MAIL", "MAILBOX", "MESSAGE", "MESSAGES", "EMAIL", "EMAILS", "DRAFT", "DRAFTS", "INBOX", "REPLY", "FORWARD", "SEND", "RULE", "RULES"]);
const isMailTool = (name: string): boolean => name.startsWith("GMAIL_") ||
  (name.startsWith("OUTLOOK_") && ((tokens: string[]) => !tokens.includes("CHAT") && tokens.some(token => MAIL_MARKERS.has(token)))(name.split("_")));
const mailPolicy = (name: string): AppToolPolicy | undefined =>
  MAIL_BLOCKED.has(name) ? "blocked" : MAIL_REVIEWS.has(name) ? "review" : MAIL_READS.has(name) ? "read" : undefined;

/** Declining a meeting removes the person from it for the organizer: refused like a cancellation. */
const CALENDAR_DECLINES = new Set(["OUTLOOK_DECLINE_EVENT"]);

/**
 * Classify one tool by its Composio slug (`GITHUB_LIST_ISSUES`) and optional
 * annotations. `app` is the toolkit slug the tool must belong to; a name under
 * another app's namespace is `blocked` so a session cannot borrow a namespace.
 */
export function classifyAppTool(name: unknown, options: { app?: string; annotations?: AppToolAnnotations | null } = {}): AppToolPolicy {
  if (typeof name !== "string" || !APP_TOOL_NAME.test(name)) return "blocked";
  if (name.startsWith("COMPOSIO_")) return "blocked";
  let rest = name;
  if (options.app !== undefined) {
    const prefix = `${options.app.toUpperCase().replaceAll("-", "_")}_`;
    if (!name.startsWith(prefix) || name.length === prefix.length) return "blocked";
    rest = name.slice(prefix.length);
  } else {
    const cut = name.indexOf("_");
    if (cut <= 0 || cut === name.length - 1) return "blocked";
    rest = name.slice(cut + 1);
  }
  if (CALENDAR_DECLINES.has(name)) return "blocked";
  const mail = mailPolicy(name);
  if (mail) return mail;
  const policy = namedPolicy(name, rest, options.annotations ?? undefined);
  return policy === "read" && isMailTool(name) ? "review" : policy;
}

function namedPolicy(name: string, rest: string, annotations: AppToolAnnotations | undefined): AppToolPolicy {
  if (annotations?.destructiveHint === true) return "blocked";
  const tokens = rest.split("_").filter(Boolean);
  if (!tokens.length || tokens.some(token => BLOCKED_TOKENS.has(token))) return "blocked";
  // `BATCH_GET` is a read; `BATCH_UPDATE` a write; `BATCH_DELETE` was blocked above.
  const verb = tokens[0] === "BATCH" ? tokens[1] : tokens[0];
  const reads = KNOWN_READS.has(name) || (verb !== undefined && READ_VERBS.has(verb) && !tokens.some(token => WRITE_TOKENS.has(token)));
  return reads && annotations?.readOnlyHint !== false ? "read" : "review";
}

// Nesting past six levels is not a label list; it is held for review.
const hiddenLabel = (value: unknown, depth = 0): boolean => depth >= 6 || (typeof value === "string" ? ["TRASH", "SPAM"].includes(value.toUpperCase())
  : Array.isArray(value) ? value.some(item => hiddenLabel(item, depth + 1))
  : Boolean(value && typeof value === "object") && Object.values(value as object).some(item => hiddenLabel(item, depth + 1)));
/** Calendar arguments that cancel an event (`status: cancelled`) or decline it
 * (`rsvp_response`/`responseStatus: declined`), at any nesting a batch may use.
 * Past six levels the arguments are not an event and are refused. */
const cancelsEvent = (value: unknown, depth = 0): boolean => depth >= 6 || (Array.isArray(value) ? value.some(item => cancelsEvent(item, depth + 1))
  : Boolean(value && typeof value === "object") && Object.entries(value as object).some(([key, item]) =>
    (typeof item === "string" && ((/^(status|event_?status)$/i.test(key) && /^cancel+ed$/i.test(item.trim())) ||
      (/^(rsvp_?response|response_?status)$/i.test(key) && /^declined$/i.test(item.trim())))) ||
    (item !== null && typeof item === "object" && cancelsEvent(item, depth + 1))));

/**
 * Classify one call: the tool's class, tightened or (for one reviewed case)
 * settled by its exact arguments.
 * - A Gmail label edit touching TRASH or SPAM hides mail and is reviewed.
 * - A calendar call that cancels or declines an event is blocked, like the
 *   CANCEL tools themselves, whatever the tool is called.
 * - An Outlook move runs without a card only when it is an archive: a move to
 *   the well-known `archive` or `inbox` folder. Any other destination,
 *   including an opaque folder ID, is reviewed.
 */
export function classifyAppToolCall(name: unknown, args: unknown, options: { app?: string; annotations?: AppToolAnnotations | null } = {}): AppToolPolicy {
  const policy = classifyAppTool(name, options);
  if (policy === "blocked" || typeof name !== "string") return "blocked";
  if (/^(GOOGLECALENDAR|GOOGLE_CALENDAR|OUTLOOK|OUTLOOKCALENDAR)_/.test(name) && !isMailTool(name) && cancelsEvent(args)) return "blocked";
  if (policy === "read" && (name === "GMAIL_ADD_LABEL_TO_EMAIL" || name === "GMAIL_MODIFY_THREAD_LABELS" || name === "GMAIL_BATCH_MODIFY_MESSAGES") && hiddenLabel(args)) return "review";
  if (policy === "review" && MAIL_MOVES.has(name) && args && typeof args === "object" && !Array.isArray(args)) {
    const destination = (args as Record<string, unknown>).destination_id;
    if (typeof destination === "string" && ["archive", "inbox"].includes(destination.toLowerCase())) return "read";
  }
  return policy;
}

/** The strictest class wins across a batch; an empty batch is nothing to allow. */
export function combineAppToolPolicies(policies: readonly AppToolPolicy[]): AppToolPolicy {
  if (!policies.length) return "blocked";
  if (policies.includes("blocked")) return "blocked";
  return policies.every(policy => policy === "read") ? "read" : "review";
}

/**
 * The office owner's versioned grant that widens a shared office mailbox from
 * the three bounded reads to the mailbox policy above. The owner accepts this
 * exact sentence; the gateway refuses a grant that carries any other text.
 */
export const FULL_MAILBOX_ACCESS_VERSION = 1;
export const FULL_MAILBOX_ACCESS_WORDING = "Bud can draft, label and archive, and send after a per-message approval, from the shared mailbox";
/** What a desktop learns from connector status: a mailbox Bud may fully use, or one held to the three reads. */
export type MailboxAccess = "full" | "read_only";
