// Fast, explicit connected-app requests. These are handled by RealBud's
// connection broker before a model turn starts, so "connect Notion" cannot
// turn into a shell command plus a second, redundant permission prompt.

export interface ConnectionIntent {
  slug: string;
  label: string;
}

const ALIASES: Record<string, ConnectionIntent> = {
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

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Match only a direct instruction whose whole job is connecting one app.
 * Questions such as "how do I connect Notion?" and compound work such as
 * "connect Notion and delete a page" deliberately stay ordinary turns.
 */
export function parseConnectionIntent(text: string): ConnectionIntent | null {
  const match = /^\s*(?:please\s+)?(?:connect|link|authori[sz]e|set\s*up)\s+(?:(?:me|us)\s+to\s+|my\s+|our\s+)?(?:the\s+)?([a-z0-9][a-z0-9 ._-]{1,48}?)(?:\s+(?:account|workspace|app|integration))?[.!]?\s*$/i.exec(
    text,
  );
  if (!match) return null;
  const name = match[1]!.trim().replace(/[._-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  if (!name || /\b(and|then|after|before|delete|send|pay|publish|submit)\b/i.test(name)) return null;
  const known = ALIASES[name];
  if (known) return known;
  const slug = name.replace(/[^a-z0-9]+/g, "");
  if (slug.length < 2 || slug.length > 40) return null;
  return { slug, label: titleCase(name) };
}
