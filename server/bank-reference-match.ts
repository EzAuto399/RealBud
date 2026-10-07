import { parseBankCsv, type BankReferenceBatch, type BankReferenceRule, type BankRowDisposition, type BankTable } from "./bank-reference.ts";
import type { JevRequest, JevResult } from "./jev-client.ts";

/** First-pass reference matching for the ANZ export and bank-feed (Redbark)
 * batches (Austin Realty W1). A bank-feed row has a description and a
 * reference instead of ANZ's 8 columns: the reference is the first candidate,
 * the description the narrative. Rows held in an earlier review and carried
 * into this batch (dated before its pull window) always stay exceptions.
 * Suggestions only: nothing here writes a file. A row is `import` only when
 * exactly one property reference matched and nothing else looks wrong; every
 * exception holds or excludes, and the person still saves the review. */
export type FirstPassClass = "matched" | "invoice" | "exception" | "not-rent";
export interface FirstPassRow {
  rowId: string; date: string; amount: string; payer: string;
  class: FirstPassClass; disposition: BankRowDisposition;
  /** The matched property for `matched`; otherwise a suggestion to check. */
  propertyId?: string;
  reason: string; suggestion?: string;
  /** Set when the suggestion came from a Jev answer: data to check, never a match. */
  hintSource?: "jev";
}
export interface FirstPass {
  layout: "anz-export" | "bank-feed";
  summary: { rows: number; matched: number; invoice: number; exception: number; notRent: number; carried: number };
  rows: FirstPassRow[];
  /** Everything not matched: exceptions, then invoices, then not rent. */
  exceptions: FirstPassRow[];
}

const upper = (text: string) => text.normalize("NFKC").toUpperCase().trim();
const key = (text: string) => upper(text).replace(/[^\p{L}\p{N}]+/gu, "");
const PROCESSORS = /\b(?:PAYONEER|PAYPAL|STRIPE|WISE|AIRWALLEX|SQUARE)\b/;
const INVOICE = /\s+(?:WATER|INVOICE|INV)\b.*$/;
const ADDRESS = /\b\d+[A-Z]?\s+(?:[A-Z]+\s+)+(?:ST|STREET|RD|ROAD|AVE|AVENUE|DR|DRIVE|CT|COURT|PL|PLACE|CRES|CRESCENT|TCE|TERRACE|LANE|LN|HWY|PDE|PARADE|BLVD|WAY|CL|CLOSE)\b/;

/** The payer and any reference text after the payer name in the narrative. */
export function narrativeTail(narrative: string, payerColumn: string): { name: string; tail: string } {
  const text = upper(narrative), payer = upper(payerColumn).replace(/\s+/g, " ");
  const match = /^(PAYMENT|TRANSFER) FROM\s+(.*)$/s.exec(text);
  if (!match) return { name: payer, tail: "" };
  const rest = match[2];
  if (match[1] === "PAYMENT" && payer && rest.replace(/\s+/g, " ").startsWith(payer)) {
    // Drop the payer's words, however the bank spaced them.
    let index = 0;
    for (const word of payer.split(" ")) index = rest.indexOf(word, index) + word.length;
    return { name: payer, tail: rest.slice(index).trim() };
  }
  // Other banks pad the name from the reference with two or more spaces.
  const parts = rest.split(/\s{2,}/);
  // ANZ's own TRANSFER narrative fills (or cuts) the payer to 16 characters,
  // so a name that runs past them ends at the field when that is a word boundary.
  if (match[1] === "TRANSFER" && !payer && parts[0].length > 16 && (rest[15] === " " || rest[16] === " ")) return { name: rest.slice(0, 16).trim(), tail: rest.slice(16).trim() };
  return { name: payer || parts[0].trim(), tail: parts.slice(1).join(" ").trim() };
}

/** Ways one reference text may name a code, most exact first: as written
 * (a leading "Rent" dropped), without a trailing "-name", "rent" or "water",
 * then the leading code alone ("A2004Smithson", "1204 JORDAN"). Each also in
 * unit notation: "A5U4" is unit 4 of A5, written "A5-4". */
export function referenceVariants(text: string): string[] {
  const value = upper(text).replace(/\s+/g, " ").replace(/^RENT /, "");
  const trimmed = value.replace(/(?:\s*-\s*[A-Z]+|\s+(?:RENT|WATER))+$/, "").trim();
  const code = /^([A-Z]{0,2}\d+(?:[A-Z]\d+|-\d+)?)(?=[A-Z]{2,}|[\s-]|$)/.exec(value)?.[1];
  return [...new Set([value, trimmed, code ?? ""].flatMap(variant => [variant, variant.replace(/^([A-Z]+\d+)U(\d+)\b/, "$1-$2")])
    .filter(variant => variant && !/^(?:RENT|WATER)$/.test(variant)))];
}

type Match = { kind: "match" | "invoice"; rules: BankReferenceRule[] } | null;
/** One reference text against the office's rules: reference and aliases
 * name a tenant; an invoice code, or "water"/"invoice" after a code, is an invoice. */
export function matchReference(text: string, rules: BankReferenceRule[]): Match {
  const find = (value: string, codes: (rule: BankReferenceRule) => string[]) => {
    for (const variant of referenceVariants(value)) {
      const found = rules.filter(rule => codes(rule).some(code => key(code) === key(variant)));
      if (found.length) return found;
    }
    return [];
  };
  // The property code names the property too (an REI tenant rule's reference is "code name").
  const tenantCodes = (rule: BankReferenceRule) => [rule.reference, rule.propertyId, ...rule.aliases];
  const anyCode = (rule: BankReferenceRule) => [...tenantCodes(rule), ...(rule.invoiceCodes ?? [])];
  const value = upper(text);
  if (INVOICE.test(value)) {
    const found = find(value.replace(INVOICE, ""), anyCode);
    if (found.length) return { kind: "invoice", rules: found };
  }
  const tenant = find(value, tenantCodes);
  if (tenant.length) return { kind: "match", rules: tenant };
  const invoice = find(value, rule => rule.invoiceCodes ?? []);
  if (invoice.length) return { kind: "invoice", rules: invoice };
  const near = nearMatch(value, rules);
  return near.length ? { kind: "match", rules: near } : null;
}

/** Looser readings, only when nothing matched exactly: a code written without
 * its leading letter ("1204" for A1204) when exactly one plain letter+digits
 * code fits (never from a street address), or a street number and name at the
 * start of a property's alias. */
function nearMatch(text: string, rules: BankReferenceRule[]): BankReferenceRule[] {
  const street = ADDRESS.test(upper(text).replace(/\s+/g, " ")); // "12 Smith St" is not code 12
  for (const variant of referenceVariants(text)) {
    if (!street && /^\d+$/.test(variant)) {
      const found = rules.filter(rule => [rule.reference, rule.propertyId].some(code => /^[A-Z]\d+$/.test(upper(code)) && upper(code).slice(1) === variant));
      if (found.length === 1) return found;
    }
    const address = /^(\d+[A-Z]?\s+[A-Z]{3,})/.exec(variant)?.[1];
    if (!address) continue;
    const found = rules.filter(rule => rule.aliases.some(alias => { const a = upper(alias).replace(/\s+/g, " "); return a === address || a.startsWith(`${address} `); }));
    if (found.length) return found;
  }
  return [];
}

/** The one tenant whose whole name (any word order, case and spacing aside) is the payer's. */
function payerTenant(name: string, rules: BankReferenceRule[]): BankReferenceRule | undefined {
  const words = (text: string) => upper(text).split(/[^\p{L}]+/u).filter(Boolean).sort().join(" ");
  const payer = words(name);
  if (!payer.includes(" ")) return undefined;
  const found = rules.filter(rule => rule.aliases.some(alias => !/\d/.test(alias) && words(alias) === payer));
  return found.length === 1 ? found[0] : undefined;
}

export const maskPayer = (name: string) => {
  const [first, second] = upper(name).split(/\s+/).filter(Boolean);
  return first ? `${first[0]}${first.slice(1).toLowerCase()}${second ? ` ${second[0]}.` : ""}` : "";
};
const money = (cents: bigint) => `$${(Number(cents) / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rentFits = (cents: bigint, rule: BankReferenceRule) => !rule.expectedRent || [1n, 2n, 4n].some(multiple => cents === BigInt(rule.expectedRent!) * multiple);
const PERIODLY = { week: "weekly", fortnight: "fortnightly", month: "monthly" } as const;
const amountReason = (cents: bigint, rule: BankReferenceRule) => {
  const rent = BigInt(rule.expectedRent!), stated = `Paid ${money(cents)}; ${PERIODLY[rule.rentPeriod ?? "week"]} rent ${money(rent)}`;
  return cents < rent ? `${stated} — partial or shared?` : `${stated}. Paid more than rent — in advance?`;
};
const label = (rule: BankReferenceRule) => `${rule.propertyId} (${rule.reference})`;

// ANZ: narrative, payer, reference 2, reference (col 8). Bank feed: the mapped description and reference.
const rowCells = (batch: BankReferenceBatch, table: BankTable, index: number) => {
  const row = batch.rows[index];
  return batch.source?.provenance ? ["", "", row.narrative, "", "", "", "", row.reference] : table[index + 1].cells;
};

export function bankFirstPass(batch: BankReferenceBatch): FirstPass | null {
  const table = parseBankCsv(batch.input.csv), feed = batch.source?.provenance;
  if (table.layout !== "anz-export" && !feed) return null;
  const rules = batch.input.rules;
  const payers = new Map<string, string>();
  const rows = batch.rows.map((row, index): FirstPassRow => {
    const cells = rowCells(batch, table, index), cents = BigInt(row.amount.replace(".", ""));
    const { name, tail } = narrativeTail(cells[2], cells[3]);
    const base = { rowId: row.id, date: row.date, amount: row.amount, payer: maskPayer(name) };
    payers.set(row.id, key(name));
    const sources = [cells[7], cells[6], tail].map(upper).filter(Boolean);
    const haystack = upper(`${cells[2]} ${cells[3]}`);
    if (cents <= 0n) return { ...base, class: "not-rent", disposition: "exclude", reason: "Outgoing payment: not tenant rent." };
    if (/RESIDENTIAL TENA/.test(haystack)) return { ...base, class: "not-rent", disposition: "exclude", reason: "Bond payment from the RTA: not tenant rent." };
    if (/AIRBNB/.test(haystack) && !sources.length) return { ...base, class: "not-rent", disposition: "exclude", reason: "Airbnb payout: not tenant rent." };
    if (/\bBUSACCT\b/.test(haystack) || PROCESSORS.test(haystack)) return { ...base, class: "exception", disposition: "hold", reason: "Not recognised as tenant rent: a business or payment-service transfer." };
    // The last two columns naming different properties: a person decides which.
    const [last, before] = [cells[7], cells[6]].map(cell => cell.trim() ? matchReference(cell, rules) : null);
    if (last?.rules.length === 1 && before?.rules.length === 1 && last.rules[0].propertyId !== before.rules[0].propertyId)
      return { ...base, class: "exception", disposition: "hold", reason: `The last column names ${last.rules[0].reference} but the column before it names ${before.rules[0].reference}: confirm the property.`, suggestion: `${label(last.rules[0])} or ${label(before.rules[0])}` };
    for (const source of sources) {
      const match = matchReference(source, rules);
      if (!match) continue;
      const [rule] = match.rules;
      if (match.rules.length > 1) return { ...base, class: "exception", disposition: "hold", reason: `Reference ${source} matches more than one property.`, suggestion: match.rules.map(label).join(" or ") };
      if (match.kind === "invoice") return { ...base, class: "invoice", disposition: "hold", propertyId: rule.propertyId, reason: "Invoice payment: check the invoice number.", suggestion: `${label(rule)} · ${source}` };
      if (!rentFits(cents, rule)) return { ...base, class: "exception", disposition: "hold", propertyId: rule.propertyId,
        reason: amountReason(cents, rule), suggestion: label(rule) };
      return { ...base, class: "matched", disposition: "import", propertyId: rule.propertyId, reason: `Reference matched ${rule.reference}.` };
    }
    // Nothing matched: suggest a property only from the office's own aliases.
    const named = payerTenant(name, rules);
    const suggested = row.candidates.length === 1 ? rules.find(rule => rule.propertyId === row.candidates[0]) : undefined;
    const hint = named ? { propertyId: named.propertyId, suggestion: `Matched by payer name: ${label(named)}` }
      : suggested ? { propertyId: suggested.propertyId, suggestion: `Possibly ${label(suggested)}` } : {};
    const address = sources.find(source => ADDRESS.test(source.replace(/\s+/g, " ")));
    if (address) return { ...base, class: "exception", disposition: "hold", reason: "Only an address was given: confirm the property.", ...hint };
    const unknown = sources.find(source => referenceVariants(source).length);
    if (unknown) return { ...base, class: "exception", disposition: "hold", reason: `Unknown reference ${unknown.replace(/\s+/g, " ")}.`, ...hint };
    return { ...base, class: "exception", disposition: "hold", reason: "No reference found.", ...hint };
  });
  // Several payers into one property in one batch may be shared rent.
  const rentRows = rows.filter(row => row.propertyId && (row.class === "matched" || row.reason.startsWith("Paid $")));
  for (const row of rentRows) {
    if (new Set(rentRows.filter(other => other.propertyId === row.propertyId).map(other => payers.get(other.rowId))).size < 2) continue;
    const rule = rules.find(item => item.propertyId === row.propertyId)!;
    Object.assign(row, { class: "exception", disposition: "hold", suggestion: label(rule),
      reason: `Several payers paid into ${rule.reference} in this batch (shared rent?).${row.class === "matched" ? "" : ` ${row.reason}`}` });
  }
  // A person held these before: never suggest importing them; keep the matcher's view as the suggestion.
  const carried = feed ? rows.filter(row => row.date < feed.requestedFrom) : [];
  for (const row of carried) Object.assign(row, { class: "exception", disposition: "hold", reason: `Held from an earlier pull · ${row.date}`, suggestion: row.suggestion ?? row.reason });
  const order: FirstPassClass[] = ["exception", "invoice", "not-rent"];
  const count = (kind: FirstPassClass) => rows.filter(row => row.class === kind).length;
  return { layout: feed ? "bank-feed" : "anz-export", rows,
    summary: { rows: rows.length, matched: count("matched"), invoice: count("invoice"), exception: count("exception"), notRent: count("not-rent"), carried: carried.length },
    exceptions: order.flatMap(kind => rows.filter(row => row.class === kind)) };
}

const NO_REFERENCE = "No reference found.";
/** Options for one Jev question; "none" is always offered too. */
const MAX_TENANT_OPTIONS = 63;

/**
 * Optional second pass after `bankFirstPass`: for rows still unmatched with no
 * reference and no hint, ask Jev which tenant (among those whose rent fits the
 * amount) the payer is. Off unless the caller injects `decide`. Only the hint
 * fields change (`propertyId` as a suggestion, `suggestion`, `hintSource`):
 * the row stays an exception on hold, the summary is untouched, and nothing
 * is imported on a hint. Jev sees the payer name, the amount and each
 * candidate's tenant names/aliases (no addresses), nothing else; a payer
 * that is blank or holds a digit is never sent.
 */
export async function jevPayerHints(batch: BankReferenceBatch, pass: FirstPass,
  decide: (request: JevRequest, options?: { signal?: AbortSignal }) => Promise<JevResult>, options: { signal?: AbortSignal } = {}): Promise<FirstPass> {
  const table = parseBankCsv(batch.input.csv), rules = batch.input.rules;
  const named = (rule: BankReferenceRule) => [...new Set([rule.tenant ?? "", ...rule.aliases].map(text => text.trim()).filter(text => text && !/\d/.test(text)))];
  // ponytail: sequential, one call per unmatched row; batch questions (max 8) if offices see long holds.
  for (const row of pass.rows) {
    if (options.signal?.aborted) break;
    if (row.class !== "exception" || row.reason !== NO_REFERENCE || row.propertyId || row.suggestion) continue;
    const index = batch.rows.findIndex(item => item.id === row.rowId);
    if (index < 0) continue;
    const cells = rowCells(batch, table, index), cents = BigInt(row.amount.replace(".", ""));
    // Only a plain name goes out, by the rule tenant names follow: blank or any digit
    // (account numbers, reference text the narrative ran on with) means no question.
    const payer = narrativeTail(cells[2], cells[3]).name.trim();
    if (!payer || /\d/.test(payer)) continue;
    const candidates = rules.filter(rule => rentFits(cents, rule) && named(rule).length);
    // ponytail: more fitting tenants than options means no hint rather than a truncated, biased list.
    if (!candidates.length || candidates.length > MAX_TENANT_OPTIONS) continue;
    const criteria: Record<string, string> = Object.fromEntries(candidates.map((rule, at) => [`t${at + 1}`, named(rule).join("; ")]));
    criteria.none = "None of these tenants, or not sure.";
    const result = await decide({
      state: { payer, amount: row.amount },
      questions: { tenant: { type: "choice", instructions: "Which tenant most likely made this rent payment, judged by the payer name? Choose none unless one tenant clearly fits.", criteria } },
    }, { signal: options.signal });
    if (!result.ok) continue;
    const answer = result.answers.tenant;
    // Missing confidence or probabilities count as below the threshold.
    if (answer?.type !== "choice" || answer.choice === "none" || !answer.probabilities || (answer.confidence ?? 0) < 0.9) continue;
    const [top = 0, second = 0] = Object.values(answer.probabilities).sort((a, b) => b - a);
    if (answer.probabilities[answer.choice] !== top || top - second < 0.3) continue;
    const rule = candidates[Number(answer.choice.slice(1)) - 1];
    if (!rule) continue;
    Object.assign(row, { propertyId: rule.propertyId, suggestion: `Possibly ${label(rule)} (AI reading of the payer name: check it)`, hintSource: "jev" });
  }
  return pass;
}
