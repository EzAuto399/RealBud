// A consequential browser approval as the person sees it: what it does
// (kind), where (site and control), each verified fact marked confirmed or
// not confirmed on the page, and when the approval expires. The server builds
// it from the broker's persisted approval record (server/browser-approval-card.ts);
// the app re-validates it before it offers an approve button. Hash facts bind
// the approval to the page text and are never shown, so their value is null.
// Dependency-free: shared by the server and the app.
import { BROWSER_CONSEQUENTIAL_KINDS, type BrowserConsequentialKind } from "./browser-task.ts";

export const BROWSER_APPROVAL_CARD_VERSION = 1 as const;
export const BROWSER_APPROVAL_CARD_PURPOSE = "browser-approval-card" as const;
export const BROWSER_APPROVAL_FACT_NAMES = ["recipient", "amount", "currency", "reference", "document", "documentHash", "to", "subject", "bodyHash", "bodyExcerpt", "target"] as const;
export type BrowserApprovalFactName = (typeof BROWSER_APPROVAL_FACT_NAMES)[number];
/** Facts that bind the approval to page text; shown as a status, never as a value. */
export const BROWSER_APPROVAL_HASH_FACTS: readonly BrowserApprovalFactName[] = ["documentHash", "bodyHash"];

/** Every kind's facts: the required ones first, then the optional ones. */
export const BROWSER_APPROVAL_FACTS: Record<BrowserConsequentialKind, { required: readonly BrowserApprovalFactName[]; optional: readonly BrowserApprovalFactName[] }> = {
  pay: { required: ["recipient", "amount", "currency"], optional: ["reference"] },
  sign: { required: ["document", "documentHash"], optional: [] },
  notice: { required: ["document", "documentHash"], optional: [] },
  send: { required: ["to", "bodyHash"], optional: ["subject", "bodyExcerpt"] },
  delete: { required: ["target"], optional: [] },
  "account-change": { required: ["target"], optional: [] },
};

export interface BrowserApprovalCardFact {
  name: BrowserApprovalFactName;
  value: string | null;
  confirmed: boolean;
}

export interface BrowserApprovalCard {
  version: typeof BROWSER_APPROVAL_CARD_VERSION;
  purpose: typeof BROWSER_APPROVAL_CARD_PURPOSE;
  /** The persisted approval record this card asks about. */
  id: string;
  kind: BrowserConsequentialKind;
  /** Host name of the page, e.g. portal.example.com.au. */
  site: string;
  /** The control Bud would press, as the page labels it. */
  control: string;
  facts: BrowserApprovalCardFact[];
  /** Epoch milliseconds. */
  expiresAt: number;
}

const INVALID = "The details of this approval are incomplete or damaged. Decline it or stop the task.";
const invalid = (): never => { throw new Error(INVALID); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** Validates a card from the server. Unknown keys, facts that do not belong
 * to the kind, a missing required fact and a "confirmed" fact without a value
 * are all rejected. */
export function parseBrowserApprovalCard(value: unknown): BrowserApprovalCard {
  const row = exact(value, ["version", "purpose", "id", "kind", "site", "control", "facts", "expiresAt"]);
  if (row.version !== BROWSER_APPROVAL_CARD_VERSION || row.purpose !== BROWSER_APPROVAL_CARD_PURPOSE) invalid();
  if (typeof row.id !== "string" || !/^[0-9a-f-]{36}$/.test(row.id)) invalid();
  if (typeof row.kind !== "string" || !(BROWSER_CONSEQUENTIAL_KINDS as readonly string[]).includes(row.kind)) invalid();
  const kind = row.kind as BrowserConsequentialKind;
  if (typeof row.site !== "string" || row.site.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(row.site) || !row.site.includes(".")) invalid();
  if (!text(row.control, 120)) invalid();
  if (typeof row.expiresAt !== "number" || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0) invalid();
  const allowed = BROWSER_APPROVAL_FACTS[kind];
  if (!Array.isArray(row.facts) || row.facts.length > allowed.required.length + allowed.optional.length) invalid();
  const facts = (row.facts as unknown[]).map(item => {
    const fact = exact(item, ["name", "value", "confirmed"]);
    const name = fact.name as BrowserApprovalFactName;
    if (![...allowed.required, ...allowed.optional].includes(name) || typeof fact.confirmed !== "boolean") invalid();
    if (BROWSER_APPROVAL_HASH_FACTS.includes(name) ? fact.value !== null : fact.value !== null && !text(fact.value, 300)) invalid();
    if (fact.confirmed && !BROWSER_APPROVAL_HASH_FACTS.includes(name) && fact.value === null) invalid();
    return { name, value: fact.value as string | null, confirmed: fact.confirmed as boolean };
  });
  const names = facts.map(fact => fact.name);
  if (new Set(names).size !== names.length || !allowed.required.every(name => names.includes(name))) invalid();
  return {
    version: BROWSER_APPROVAL_CARD_VERSION,
    purpose: BROWSER_APPROVAL_CARD_PURPOSE,
    id: row.id as string,
    kind,
    site: (row.site as string).toLowerCase(),
    control: row.control as string,
    facts,
    expiresAt: row.expiresAt as number,
  };
}

/** The app's read: a damaged card is null, never a partial approval. */
export function readBrowserApprovalCard(value: unknown): BrowserApprovalCard | null {
  try { return parseBrowserApprovalCard(value); } catch { return null; }
}

export const browserApprovalFact = (card: BrowserApprovalCard, name: BrowserApprovalFactName): BrowserApprovalCardFact | undefined =>
  card.facts.find(fact => fact.name === name);

/** Facts the page did not confirm. Any one of them blocks approval. */
export const unconfirmedBrowserApprovalFacts = (card: BrowserApprovalCard): BrowserApprovalFactName[] =>
  card.facts.filter(fact => !fact.confirmed).map(fact => fact.name);

const SYMBOLS: Record<string, string> = { AUD: "A$", USD: "US$", NZD: "NZ$", CAD: "C$", SGD: "S$", HKD: "HK$", GBP: "£", EUR: "€", JPY: "¥", $: "$", "£": "£", "€": "€" };
/** "1240.00" + "AUD" → "A$1,240.00". Digits are grouped, never rounded. */
export function formatBrowserApprovalMoney(amount: string, currency: string): string {
  const match = amount.match(/^(\d+)(\.\d{1,2})?$/);
  const grouped = match ? `${match[1].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${match[2] ?? ""}` : amount;
  const symbol = SYMBOLS[currency.toUpperCase()] ?? SYMBOLS[currency];
  return symbol ? `${symbol}${grouped}` : `${currency} ${grouped}`;
}

/** The payment amount when the page confirmed both the amount and its currency. */
export function browserApprovalMoney(card: BrowserApprovalCard): string | null {
  const amount = browserApprovalFact(card, "amount"), currency = browserApprovalFact(card, "currency");
  return amount?.confirmed && currency?.confirmed && amount.value && currency.value ? formatBrowserApprovalMoney(amount.value, currency.value) : null;
}
