// Fast, explicit connected-app requests. These are handled by RealBud's
// connection broker before a model turn starts, so "connect Notion" cannot
// turn into a shell command plus a second, redundant permission prompt.

export interface ConnectionIntent {
  slug: string;
  label: string;
}

const ALIASES: Record<string, ConnectionIntent> = {
  "x": { slug: "x", label: "X" },
  "google calendar": { slug: "googlecalendar", label: "Google Calendar" },
  "google calendars": { slug: "googlecalendar", label: "Google Calendar" },
  "google sheets": { slug: "googlesheets", label: "Google Sheets" },
  "google docs": { slug: "googledocs", label: "Google Docs" },
  "google drive": { slug: "googledrive", label: "Google Drive" },
  "gmail": { slug: "gmail", label: "Gmail" },
  "github": { slug: "github", label: "GitHub" },
  "notion": { slug: "notion", label: "Notion" },
  "microsoft outlook": { slug: "outlook", label: "Microsoft Outlook" },
  "outlook": { slug: "outlook", label: "Microsoft Outlook" },
  "microsoft 365": { slug: "microsoft365", label: "Microsoft 365" },
};

// "connect to redbark", "set up our bank feed", "how do I connect my bank?":
// whole requests only, so property work that mentions a bank stays a turn.
const BANK_FEED = /^(?:please\s+)?(?:(?:how|where)\s+(?:do|can)\s+i\s+)?(?:(?:connect|link|set\s*up|add|hook\s+up)\s+)?(?:(?:me|us)\s+)?(?:to\s+|with\s+)?(?:(?:my|our|the|a|an)\s+)?(?:office(?:'s|’s)?\s+)?(?:redbark|bank(?:\s+(?:feeds?|accounts?))?)(?:\s+(?:feed|account|connection|app|integration))?$/i;
/** Ask renders this link as the inline Connect bank feed action. */
export const BANK_FEED_CONNECT_HREF = "#connect-bank-feed";
export function isBankFeedRequest(text: string): boolean {
  const value = text.trim().replace(/[?!.]+$/, "").replace(/\s+/g, " ");
  return value.length <= 120 && BANK_FEED.test(value) && /\b(?:connect|link|set ?up|add|hook|redbark|feeds?)\b/i.test(value);
}

/**
 * Match only a direct instruction whose whole job is connecting one app.
 * Questions such as "how do I connect Notion?" and compound work such as
 * "connect Notion and delete a page" deliberately stay ordinary turns.
 */
export function parseConnectionIntent(text: string): ConnectionIntent | null {
  const match = /^\s*(?:please\s+)?(?:connect|link|authori[sz]e|set\s*up)\s+(?:(?:me|us)\s+to\s+|to\s+|with\s+|my\s+|our\s+)?(?:the\s+)?([a-z0-9][a-z0-9 ._-]{0,48}?)(?:\s+(?:account|workspace|app|integration))?[.!]?\s*$/i.exec(
    text,
  );
  if (!match) return null;
  // The bank feed is not a connected app; parseAskControlIntent answers it.
  if (isBankFeedRequest(text)) return null;
  const name = match[1]!.trim().replace(/[._-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  if (!name || /\b(and|then|after|before|delete|send|pay|publish|submit)\b/i.test(name)) return null;
  const known = ALIASES[name];
  if (known) return known;
  const slug = name.replace(/[^a-z0-9]+/g, "");
  if (slug.length < 2 || slug.length > 40) return null;
  // An unknown app keeps the person's own wording, never a guessed product name.
  return { slug, label: match[1]!.trim().replace(/\s+/g, " ") };
}

// "Is the water connected?" is property work, so "is X connected" only names
// an office app. A question put to Bud itself ("are you connected to …") may
// name any one short target: it is always about Bud's own connections.
const APP_NAMES = `(?:${[...Object.keys(ALIASES), "google", "email", "mail", "inbox", "composio", "office apps?", "calendar", "drive"].sort((a, b) => b.length - a.length).join("|")})`;
const ANY_TARGET = "(?:(?:my|our|the|your) )?[a-z0-9][a-z0-9 ._-]{0,39}?";
const CONNECTED_STATUS = new RegExp(
  "^(?:please )?(?:" + [
    "(?:what|which) (?:services|apps|accounts|integrations|sources|tools)(?: (?:are (?:we |they |you )?|am i |is bud |does bud have |do (?:you|we) have ))?(?:connected|linked)(?: to)?",
    "what(?:'s|’s| is| are)(?: (?:we|i|you|bud))? (?:connected|linked)(?: to)?",
    "(?:show|list)(?: me)?(?: my| our| the| your)? (?:connected (?:apps|services|accounts|sources)|connections|office sources)",
    "(?:my |our |your )?(?:connected (?:apps|services|accounts|sources)|connections)",
    `(?:are (?:we|you)|am i|is bud) (?:connected|linked)(?: (?:to|with) ${ANY_TARGET})?`,
    `is (?:my |our |the |your )?${APP_NAMES}(?: account| inbox)? (?:connected|linked)(?: (?:to|with) (?:you|bud|realbud))?`,
    "(?:what|which) (?:apps|sources|tools) can (?:you|bud) use",
  ].join("|") + ")$",
  "i",
);

/** Whole-request matches only: work and pasted evidence must keep their meaning. */
export function parseConnectedStatusIntent(text: string): boolean {
  const value = text.trim().replace(/[?!.]+$/, "").replace(/\s+/g, " ");
  if (!value || value.length > 180 || /[\r\n]/.test(value)) return false;
  // A status question names at most one short target. Anything joined to more
  // work ("… and check payments") stays an ordinary turn.
  if (/[,;]|\b(?:and|then|also|after|before|to (?:check|send|pay|read|find|open|do|get|make))\b/i.test(value)) return false;
  return CONNECTED_STATUS.test(value);
}

/** Product controls are whole requests. Never interpret source text as a control. */
export function parseAskControlIntent(text: string): "schedule-status" | "schedule-edit" | "setup" | "connections" | "bank-feed" | null {
  const value = text.trim().replace(/[?!.]+$/, "");
  if (!value || value.length > 400 || /[\r\n]/.test(value)) return null;
  if (isBankFeedRequest(value)) return "bank-feed";
  if (/^(?:what(?:'s| is| have (?:we|i))|show(?: me)?|list)(?: (?:my|our|the))? (?:scheduled(?: jobs| work)?|schedule|routines|recurring jobs)(?: (?:for today|today|this week))?$/i.test(value)) return "schedule-status";
  // "change"/"reschedule" reach Bud, who offers a before → after schedule card (loop_schedule).
  if (/^(?:please )?(?:schedule|remind me|set up (?:a |an )?(?:schedule|reminder|recurring)|(?:can you |help me )?(?:add|create|make|pause|stop) (?:a |an |my |our |the |this )?(?:schedule|reminder|recurring job))\b/i.test(value)) return "schedule-edit";
  // Any one app, named in one or two words: "how do I connect Xero?" is the same
  // question as for Gmail. Bud itself is setup below; a longer phrase ("link the
  // lease to the property") is property work and stays an ordinary turn.
  if (/^(?:(?:how|where) (?:do|can) i (?:connect|link|set up) (?:my |our |the )?(?!bud\b)(?!realbud\b)[a-z0-9][a-z0-9.-]{0,24}(?: [a-z0-9][a-z0-9.-]{0,24})?(?: account| workspace| app)?|(?:help me )?(?:connect (?:an? )?(?:app|office app|new app)|set up (?:office apps|connected apps)))$/i.test(value)) return "connections";
  if (/^(?:(?:how|where) (?:do|can) i (?:set up|fix|connect) bud|(?:help me )?(?:set up|fix|connect) bud|why (?:isn't|is not) bud (?:ready|working))$/i.test(value)) return "setup";
  return null;
}


export function isAskProductControl(text: string): boolean {
  return Boolean(parseConnectedStatusIntent(text) || parseAskControlIntent(text) || parseConnectionIntent(text) || /^check (?:gmail|outlook) connection[.!?]?$/i.test(text.trim()));
}
