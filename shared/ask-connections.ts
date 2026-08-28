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
  { id: "incoming-mail", pattern: /\b(?:gmail|outlook|hotmail|inbox|calendar|e-?mail|gcal|google[\s_-]*(?:calendar|calandar|calender|clandar|cal)|googlecalendar)\b/i },
  { id: "property-book", pattern: /\b(?:property\s+book|pms|portfolio|property\s*me|property\s+tree|reapit|rent\s+roll)\b/i },
];

const SETUP_VERB = /\b(?:con+e+c[a-z]{0,2}t|set\s*up|setup|link|configure|enable|activate|add|open|show|prepare|we\s+use|our\s+(?:pms|inbox|portal))\b/i;
const SETUP_NEGATION = /\b(?:do\s+not|don't|dont|never)\b/i;
const SETUP_FORBIDDEN = /\b(?:tenant|owner|tradie|contractor|group|send|pay|notice)\b/i;
const CHOOSER = /\b(?:tools?|connections?|integrations?|accounts?|sources?|pocket|mobile\s+(?:message|messaging|channel))\b/i;
const GENERIC_CONNECT_NAME = /^(?:a\s+|the\s+|my\s+|our\s+)?(?:tool|connection|integration|account|source|bud)s?$/i;
const KNOWN_OFFICE_NAME = /^(?:property book|property tree|property\s*me|reapit|whatsapp(?: business)?|telegram|composio(?: account)?|computer use|worker|desktop reminders|api and mcp|incoming mail|incoming calendar)$/i;

export type AskConnectionSpeech =
  | { kind: "none" }
  | { kind: "chooser" }
  | { kind: "option"; option: AskConnectionOption }
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

export function extractSpokenConnectName(text: string): string | null {
  const match = text.match(/\b(?:con+e+c[a-z]{0,2}t|link|set\s*up|setup)\s+(?:(?:me|us|bud)\s+)?(?:to\s+|with\s+)?(.+)$/i);
  if (!match) return null;
  const name = match[1]!.replace(/[.?!]+$/g, "").trim();
  if (!name || name.length < 2 || name.length > 40) return null;
  if (GENERIC_CONNECT_NAME.test(name)) return null;
  if (/\b(?:so|because|and then|that can)\b/i.test(name)) return null;
  return prettyOfficeName(name);
}

export function matchAskConnectionSpeech(text: string): AskConnectionSpeech {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
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
  if (CHOOSER.test(clean) || /^(?:con+e+c[a-z]{0,2}t|set\s*up|setup|link)(?:\s+bud)?\.?$/i.test(clean)) {
    return { kind: "chooser" };
  }
  const named = extractSpokenConnectName(clean);
  if (named && !isKnownOfficeService(named)) {
    return { kind: "unsupported", name: named };
  }
  return { kind: "none" };
}

export function askConnectionOption(id: string): AskConnectionOption | undefined {
  return ASK_CONNECTION_OPTIONS.find((item) => item.id === id)
    ?? OFFICE_SETUP_OPTIONS.find((item) => item.id === id);
}

export type AskOfficeToolKind = "mail" | "calendar";

export interface AskOfficeTool {
  id: "gmail" | "google-calendar" | "outlook" | "hotmail" | "incoming-mail";
  label: string;
  kind: AskOfficeToolKind;
  /** Restricted Composio toolkit slug, when one exists for this office tool. */
  composioSlug: "gmail" | "googlecalendar" | "outlook" | null;
}

const GOOGLE_CALENDAR = /\b(?:google[\s_-]*(?:calendar|calandar|calender|clandar|cal)|googlecalendar|gcal)\b/i;

/** Resolve the office tool the PM named, including worker slugs and typos. */
export function resolveAskOfficeTool(text: string): AskOfficeTool | null {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (GOOGLE_CALENDAR.test(clean) || /^google calendar$/i.test(clean)) {
    return { id: "google-calendar", label: "Google Calendar", kind: "calendar", composioSlug: "googlecalendar" };
  }
  if (/\bgmail\b/i.test(clean)) return { id: "gmail", label: "Gmail", kind: "mail", composioSlug: "gmail" };
  if (/\boutlook\b/i.test(clean)) return { id: "outlook", label: "Outlook", kind: "mail", composioSlug: "outlook" };
  if (/\bhotmail\b/i.test(clean)) return { id: "hotmail", label: "Hotmail", kind: "mail", composioSlug: null };
  if (/\b(?:inbox|incoming mail|e-?mail)\b/i.test(clean)) {
    return { id: "incoming-mail", label: "Incoming mail", kind: "mail", composioSlug: null };
  }
  if (/\bcalendar\b/i.test(clean)) {
    return { id: "incoming-mail", label: "Incoming calendar", kind: "calendar", composioSlug: null };
  }
  return null;
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
