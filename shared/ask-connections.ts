import type { AskSetupTarget } from "./ask-actions.ts";

export type AskConnectionOptionId =
  | "composio-account"
  | "incoming-mail"
  | "property-book"
  | "api-mcp"
  | "whatsapp-business"
  | "telegram"
  | "computer-use"
  | "worker"
  | "desktop-reminders";

export interface AskConnectionOption {
  id: AskConnectionOptionId;
  label: string;
  detail: string;
  target: AskSetupTarget;
  service: string;
}

export const COMMON_ASK_CONNECTION_IDS: ReadonlySet<string> = new Set([
  "property-book",
  "incoming-mail",
  "computer-use",
]);

export const ASK_CONNECTION_OPTIONS: readonly AskConnectionOption[] = [
  {
    id: "property-book",
    label: "Property book / PMS",
    detail: "Name the PMS this office already uses. Structured export first. A read API waits for the pilot.",
    target: "connections",
    service: "Property book",
  },
  {
    id: "incoming-mail",
    label: "Incoming mail and calendar",
    detail: "One named read-only inbox. Reply drafts land on Desk. Nothing sends.",
    target: "connections",
    service: "Incoming mail",
  },
  {
    id: "computer-use",
    label: "Portals on this Mac",
    detail: "The websites this office already uses. Case-scoped browser handoffs. You keep Submit.",
    target: "computer-use",
    service: "Computer use",
  },
  {
    id: "whatsapp-business",
    label: "WhatsApp Business",
    detail: "One exact PM number through Meta Cloud API. Pocket stays in You.",
    target: "connections",
    service: "WhatsApp Business",
  },
  {
    id: "telegram",
    label: "Telegram",
    detail: "One exact PM identity in a private Telegram chat.",
    target: "connections",
    service: "Telegram",
  },
  {
    id: "api-mcp",
    label: "Approved API or MCP",
    detail: "Governed read adapters only. Raw tools and pasted server URLs stay out.",
    target: "connections",
    service: "API and MCP",
  },
  {
    id: "composio-account",
    label: "Your Composio account",
    detail: "Restricted named reads later. Log in at Composio, then link the key here. Ask never sees it.",
    target: "composio-account",
    service: "Composio account",
  },
];

const OFFICE_SETUP_OPTIONS: readonly AskConnectionOption[] = [
  {
    id: "worker",
    label: "Worker and model",
    detail: "Attach the model on Bud's private worker. Keys stay in You.",
    target: "worker",
    service: "Worker",
  },
  {
    id: "desktop-reminders",
    label: "Desktop reminders",
    detail: "Local alerts when a routine fails or leaves held work. Never messages anyone.",
    target: "desktop-reminders",
    service: "Desktop reminders",
  },
];

const OPTION_PATTERNS: ReadonlyArray<{ id: AskConnectionOptionId; pattern: RegExp }> = [
  { id: "whatsapp-business", pattern: /\bwhats\s*app(?:\s+business)?\b/i },
  { id: "telegram", pattern: /\btelegram\b/i },
  { id: "composio-account", pattern: /\bcomposio\b/i },
  { id: "computer-use", pattern: /\b(?:computer\s+use|cua|portals?)\b/i },
  { id: "desktop-reminders", pattern: /\b(?:desktop\s+)?reminders?\b/i },
  { id: "worker", pattern: /\b(?:worker(?:\s+setup)?|connect(?:\s+a)?\s+model|prepare\s+bud)\b/i },
  { id: "api-mcp", pattern: /\b(?:mcp|direct\s+api|pms\s+api)\b/i },
  { id: "incoming-mail", pattern: /\b(?:gmail|outlook|hotmail|inbox|calendar|e-?mail|gcal|googlecalendar)\b/i },
  { id: "property-book", pattern: /\b(?:property\s+book|pms|portfolio|property\s*me|property\s+tree|reapit|rent\s+roll)\b/i },
];

const SETUP_VERB = /\b(?:con+e+c[a-z]{0,2}t|set\s*up|setup|link|configure|enable|activate|add|open|show|prepare|we\s+use|our\s+(?:pms|inbox|portal))\b/i;
const PEEK_VERB = /\b(?:what(?:'s|s| is)?\s+(?:in|inside)|see\s+inside|can you see|could you see|fetch|read(?:\s+from)?|show me|list(?:\s+(?:the\s+)?)?pages|look(?:\s+in(?:side)?)?|inside of)\b/i;
const SETUP_NEGATION = /\b(?:do\s+not|don't|dont|never)\b/i;
const SETUP_FORBIDDEN = /\b(?:tenant|owner|tradie|contractor|group|send|pay|notice)\b/i;
const CHOOSER = /\b(?:tools?|connections?|integrations?|accounts?|sources?|pocket|mobile\s+(?:message|messaging|channel))\b/i;
const GENERIC_CONNECT_NAME = /^(?:a\s+|the\s+|my\s+|our\s+)?(?:tool|connection|integration|account|source|bud)s?$/i;
const KNOWN_OFFICE_NAME = /^(?:property book|property tree|property\s*me|reapit|whatsapp(?: business)?|telegram|composio(?: account)?|computer use|worker|desktop reminders|api and mcp|incoming mail|incoming calendar)$/i;

export type AskConnectionSpeech =
  | { kind: "none" }
  | { kind: "chooser" }
  | { kind: "option"; option: AskConnectionOption }
  | { kind: "tool"; tool: AskOfficeTool }
  | { kind: "unsupported"; name: string };

/** Title-case a spoken product name without inventing a catalog slot. */
export function prettyOfficeName(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** True only for a closed office source — not a social or marketplace name. */
export function isKnownOfficeService(service?: string): boolean {
  const clean = (service ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return false;
  if (resolveAskOfficeTool(clean)) return true;
  if (KNOWN_OFFICE_NAME.test(clean)) return true;
  return ASK_CONNECTION_OPTIONS.some((item) => (
    item.service.toLowerCase() === clean.toLowerCase() || item.label.toLowerCase() === clean.toLowerCase()
  ));
}

/** Any named app RealBud can open a connect card for — office sources plus a spoken toolkit. */
export function isConnectableService(service?: string): boolean {
  if (isKnownOfficeService(service)) return true;
  return Boolean(resolveConnectableTool(service ?? ""));
}

/** Drop credential-shaped tokens so “connect Notion ntn_…” still names Notion. */
export function stripCredentialLooks(text: string): string {
  return text
    .replace(/\b(?:sk-(?:ant-|proj-|live-|test-)?|ntn_|ck_|secret_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|AKIA|AIza|npm_|eyJ)[A-Za-z0-9._~+/=-]{8,}/g, " ")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSpokenConnectName(text: string): string | null {
  const match = stripCredentialLooks(text).match(/\b(?:con+e+c[a-z]{0,2}t|link|set\s*up|setup)\s+(?:(?:me|us|bud)\s+)?(?:to\s+|with\s+)?(.+)$/i);
  if (!match) return null;
  const name = match[1]!.replace(/[.?!]+$/g, "").trim();
  if (!name || name.length < 2 || name.length > 40) return null;
  if (GENERIC_CONNECT_NAME.test(name)) return null;
  if (/\b(?:so|because|and then|that can)\b/i.test(name)) return null;
  return prettyOfficeName(name);
}

export function matchAskConnectionSpeech(text: string): AskConnectionSpeech {
  const clean = stripCredentialLooks(text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim());
  if (!clean || clean.length > 500 || !SETUP_VERB.test(clean) || SETUP_NEGATION.test(clean) || SETUP_FORBIDDEN.test(clean)) {
    return { kind: "none" };
  }
  const matched = OPTION_PATTERNS.filter(({ pattern }) => pattern.test(clean));
  if (matched.length > 1) {
    return { kind: "chooser" };
  }
  if (matched[0]) {
    const option = ASK_CONNECTION_OPTIONS.find((item) => item.id === matched[0]!.id)
      ?? OFFICE_SETUP_OPTIONS.find((item) => item.id === matched[0]!.id);
    return option ? { kind: "option", option } : { kind: "none" };
  }
  const officeTool = speechForResolvedOfficeTool(clean);
  if (officeTool) return officeTool;
  if (CHOOSER.test(clean) || /^(?:con+e+c[a-z]{0,2}t|set\s*up|setup|link)(?:\s+bud)?\.?$/i.test(clean)) {
    return { kind: "chooser" };
  }
  const named = extractSpokenConnectName(clean);
  if (named) {
    const namedTool = speechForResolvedOfficeTool(named);
    if (namedTool) return namedTool;
    const app = resolveConnectableTool(named);
    if (app?.kind === "app") return { kind: "tool", tool: app };
    if (!isKnownOfficeService(named)) return { kind: "unsupported", name: named };
  }
  return { kind: "none" };
}

function speechForResolvedOfficeTool(text: string): AskConnectionSpeech | null {
  if (!resolveAskOfficeTool(text)) return null;
  const option = ASK_CONNECTION_OPTIONS.find((item) => item.id === "incoming-mail");
  return option ? { kind: "option", option } : null;
}

export function askConnectionOption(id: string): AskConnectionOption | undefined {
  return ASK_CONNECTION_OPTIONS.find((item) => item.id === id)
    ?? OFFICE_SETUP_OPTIONS.find((item) => item.id === id);
}

export type AskOfficeToolKind = "mail" | "calendar" | "app";

export interface AskOfficeTool {
  id: string;
  label: string;
  kind: AskOfficeToolKind;
  /** Composio toolkit slug, when the spoken name maps to one. */
  composioSlug: string | null;
}

const GOOGLE_CALENDAR: AskOfficeTool = {
  id: "google-calendar",
  label: "Google Calendar",
  kind: "calendar",
  composioSlug: "googlecalendar",
};

function officeWords(text: string): string[] {
  return text.toLowerCase().split(" ").filter(Boolean);
}

/** Damerau-Levenshtein, capped. Closed office names only — not a catalog search. */
function officeEditDistance(left: string, right: string): number {
  if (left === right) return 0;
  const limit = 2;
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const grid: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) grid[i]![0] = i;
  for (let j = 0; j < cols; j += 1) grid[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let next = Math.min(grid[i - 1]![j]! + 1, grid[i]![j - 1]! + 1, grid[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        next = Math.min(next, grid[i - 2]![j - 2]! + 1);
      }
      grid[i]![j] = next;
    }
  }
  return grid[left.length]![right.length]!;
}

function closeOfficeWord(spoken: string, target: string): boolean {
  if (spoken === target) return true;
  const longer = Math.max(spoken.length, target.length);
  if (longer < 5) return false;
  const allowed = longer <= 6 ? 1 : 2;
  return officeEditDistance(spoken, target) <= allowed;
}

function looksLikeGoogle(word: string): boolean {
  return word === "google" || closeOfficeWord(word, "google");
}

function looksLikeCalendar(word: string, withGoogle: boolean): boolean {
  if (word === "gcal") return true;
  if (word === "cal") return withGoogle;
  return word === "calendar" || closeOfficeWord(word, "calendar");
}

function looksLikeNamedMail(word: string, name: "gmail" | "outlook" | "hotmail"): boolean {
  if (word === name) return true;
  return word.startsWith(name[0]!) && closeOfficeWord(word, name);
}

/** Resolve the office tool the PM named, including worker slugs and typos. */
export function resolveAskOfficeTool(text: string): AskOfficeTool | null {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const words = officeWords(clean);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const next = words[index + 1];
    if (word === "googlecalendar" || (word.startsWith("google") && looksLikeCalendar(word.slice(6), true))) {
      return GOOGLE_CALENDAR;
    }
    if (looksLikeGoogle(word) && next && looksLikeCalendar(next, true)) return GOOGLE_CALENDAR;
    if (word === "gcal") return GOOGLE_CALENDAR;
  }
  if (words.some((word) => looksLikeNamedMail(word, "gmail"))) {
    return { id: "gmail", label: "Gmail", kind: "mail", composioSlug: "gmail" };
  }
  if (words.some((word) => looksLikeNamedMail(word, "outlook"))) {
    return { id: "outlook", label: "Outlook", kind: "mail", composioSlug: "outlook" };
  }
  if (words.some((word) => looksLikeNamedMail(word, "hotmail"))) {
    return { id: "hotmail", label: "Hotmail", kind: "mail", composioSlug: null };
  }
  if (
    words.includes("inbox")
    || words.includes("email")
    || (words.includes("e") && words.includes("mail"))
    || (words.includes("incoming") && words.includes("mail"))
    || words.includes("mail")
  ) {
    return { id: "incoming-mail", label: "Incoming mail", kind: "mail", composioSlug: null };
  }
  if (words.some((word) => looksLikeCalendar(word, false))) {
    return { id: "incoming-mail", label: "Incoming calendar", kind: "calendar", composioSlug: null };
  }
  return null;
}

const TOOLKIT_ALIASES: Readonly<Record<string, { slug: string; label: string }>> = {
  notion: { slug: "notion", label: "Notion" },
  slack: { slug: "slack", label: "Slack" },
  instagram: { slug: "instagram", label: "Instagram" },
  github: { slug: "github", label: "GitHub" },
  linear: { slug: "linear", label: "Linear" },
  discord: { slug: "discord", label: "Discord" },
  hubspot: { slug: "hubspot", label: "HubSpot" },
  salesforce: { slug: "salesforce", label: "Salesforce" },
  jira: { slug: "jira", label: "Jira" },
  asana: { slug: "asana", label: "Asana" },
  trello: { slug: "trello", label: "Trello" },
  dropbox: { slug: "dropbox", label: "Dropbox" },
  airtable: { slug: "airtable", label: "Airtable" },
  figma: { slug: "figma", label: "Figma" },
  stripe: { slug: "stripe", label: "Stripe" },
  googledrive: { slug: "googledrive", label: "Google Drive" },
  googledocs: { slug: "googledocs", label: "Google Docs" },
  googlesheets: { slug: "googlesheets", label: "Google Sheets" },
  googlephotos: { slug: "googlephotos", label: "Google Photos" },
  x: { slug: "x", label: "X" },
  twitter: { slug: "x", label: "X" },
  reddit: { slug: "reddit", label: "Reddit" },
  zapier: { slug: "zapier", label: "Zapier" },
  sentry: { slug: "sentry", label: "Sentry" },
  posthog: { slug: "posthog", label: "PostHog" },
  facebook: { slug: "facebook", label: "Facebook" },
  linkedin: { slug: "linkedin", label: "LinkedIn" },
};

const RESERVED_TOOL_SLUGS = new Set([
  "token", "secret", "password", "passwd", "key", "apikey", "api", "mcp", "connect", "tool", "tools",
]);

/** Safe Composio-style slug from a spoken product name. */
export function toolkitSlug(name: string): string | null {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!/^[a-z][a-z0-9]{1,31}$/.test(slug)) return null;
  if (RESERVED_TOOL_SLUGS.has(slug)) return null;
  return slug;
}

function appTool(slug: string, label: string): AskOfficeTool {
  return { id: slug, label, kind: "app", composioSlug: slug };
}

/** Office mail/calendar first, then a named app — including an unknown spoken name. */
export function resolveConnectableTool(text: string): AskOfficeTool | null {
  const office = resolveAskOfficeTool(text);
  if (office) return office;
  const clean = stripCredentialLooks(text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim());
  if (!clean || clean.length > 40) return null;
  const collapsed = clean.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const aliased = TOOLKIT_ALIASES[collapsed];
  if (aliased) return appTool(aliased.slug, aliased.label);
  const slug = toolkitSlug(clean);
  if (!slug) return null;
  if (/\b(?:so|because|and then|that can)\b/i.test(clean)) return null;
  return appTool(slug, prettyOfficeName(clean));
}

/** “What can you see in Notion” is a peek of the saved key, not a reconnect. */
export function matchAskToolPeekSpeech(text: string): AskOfficeTool | null {
  const clean = stripCredentialLooks(text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim());
  if (!clean || clean.length > 500 || SETUP_NEGATION.test(clean) || SETUP_FORBIDDEN.test(clean)) return null;
  if (!PEEK_VERB.test(clean)) return null;
  const office = resolveAskOfficeTool(clean);
  if (office) return office;
  const collapsed = clean.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const [alias, meta] of Object.entries(TOOLKIT_ALIASES)) {
    if (collapsed.includes(alias) || new RegExp(`\\b${alias}\\b`, "i").test(clean)) {
      return appTool(meta.slug, meta.label);
    }
  }
  const named = extractSpokenConnectName(clean);
  return named ? resolveConnectableTool(named) : null;
}

/** Use the name the office said when it is more specific than the catalog slot. */
export function namedOfficeService(option: AskConnectionOption, text: string): string {
  const named = resolveAskOfficeTool(text);
  if (option.id === "incoming-mail" && named) return named.label;
  if (option.id === "property-book") {
    if (/property\s*me\b/i.test(text)) return "PropertyMe";
    if (/property\s+tree/i.test(text)) return "Property Tree";
    if (/\breapit\b/i.test(text)) return "Reapit";
  }
  return option.service;
}
