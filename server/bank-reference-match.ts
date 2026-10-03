import { parseBankCsv, type BankReferenceBatch, type BankReferenceRule, type BankRowDisposition } from "./bank-reference.ts";

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
  return { name: payer || parts[0].trim(), tail: parts.slice(1).join(" ").trim() };
}

/** Ways one reference text may name a code, most exact first: as written,
 * without a trailing "-name", "rent" or "water", then the leading code alone
 * ("A2004Smithson", "1204 JORDAN"). */
export function referenceVariants(text: string): string[] {
  const value = upper(text).replace(/\s+/g, " ");
  const trimmed = value.replace(/(?:\s*-\s*[A-Z]+|\s+(?:RENT|WATER))+$/, "").trim();
  const code = /^([A-Z]{0,2}\d+(?:[A-Z]\d+)?)(?=[A-Z]{2,}|[\s-]|$)/.exec(value)?.[1];
  return [...new Set([value, trimmed, code ?? ""].filter(variant => variant && !/^(?:RENT|WATER)$/.test(variant)))];
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
  const tenantCodes = (rule: BankReferenceRule) => [rule.reference, ...rule.aliases];
  const anyCode = (rule: BankReferenceRule) => [...tenantCodes(rule), ...(rule.invoiceCodes ?? [])];
  const value = upper(text);
  if (INVOICE.test(value)) {
    const found = find(value.replace(INVOICE, ""), anyCode);
    if (found.length) return { kind: "invoice", rules: found };
  }
  const tenant = find(value, tenantCodes);
  if (tenant.length) return { kind: "match", rules: tenant };
  const invoice = find(value, rule => rule.invoiceCodes ?? []);
  return invoice.length ? { kind: "invoice", rules: invoice } : null;
}

export const maskPayer = (name: string) => {
  const [first, second] = upper(name).split(/\s+/).filter(Boolean);
  return first ? `${first[0]}${first.slice(1).toLowerCase()}${second ? ` ${second[0]}.` : ""}` : "";
};
const money = (cents: bigint) => `$${(Number(cents) / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rentFits = (cents: bigint, rule: BankReferenceRule) => !rule.expectedRent || [1n, 2n, 4n].some(multiple => cents === BigInt(rule.expectedRent!) * multiple);
const label = (rule: BankReferenceRule) => `${rule.propertyId} (${rule.reference})`;

export function bankFirstPass(batch: BankReferenceBatch): FirstPass | null {
  const table = parseBankCsv(batch.input.csv), feed = batch.source?.provenance;
  if (table.layout !== "anz-export" && !feed) return null;
  const rules = batch.input.rules;
  const payers = new Map<string, string>();
  const rows = batch.rows.map((row, index): FirstPassRow => {
    // ANZ: narrative, payer, reference 2, reference (col 8). Bank feed: the mapped description and reference.
    const cells = feed ? ["", "", row.narrative, "", "", "", "", row.reference] : table[index + 1].cells, cents = BigInt(row.amount.replace(".", ""));
    const { name, tail } = narrativeTail(cells[2], cells[3]);
    const base = { rowId: row.id, date: row.date, amount: row.amount, payer: maskPayer(name) };
    payers.set(row.id, key(name));
    const sources = [cells[7], cells[6], tail].map(upper).filter(Boolean);
    const haystack = upper(`${cells[2]} ${cells[3]}`);
    if (cents <= 0n) return { ...base, class: "not-rent", disposition: "exclude", reason: "Outgoing payment: not tenant rent." };
    if (/AIRBNB/.test(haystack) && !sources.length) return { ...base, class: "not-rent", disposition: "exclude", reason: "Airbnb payout: not tenant rent." };
    if (/\bBUSACCT\b/.test(haystack) || PROCESSORS.test(haystack)) return { ...base, class: "exception", disposition: "hold", reason: "Not recognised as tenant rent: a business or payment-service transfer." };
    for (const source of sources) {
      const match = matchReference(source, rules);
      if (!match) continue;
      const [rule] = match.rules;
      if (match.rules.length > 1) return { ...base, class: "exception", disposition: "hold", reason: `Reference ${source} matches more than one property.`, suggestion: match.rules.map(label).join(" or ") };
      if (match.kind === "invoice") return { ...base, class: "invoice", disposition: "hold", propertyId: rule.propertyId, reason: "Invoice payment: check the invoice number.", suggestion: `${label(rule)} · ${source}` };
      if (!rentFits(cents, rule)) return { ...base, class: "exception", disposition: "hold", propertyId: rule.propertyId,
        reason: `Amount differs from the expected rent (late, overpaid or shared?): expected ${money(BigInt(rule.expectedRent!))} per ${rule.rentPeriod ?? "week"}, paid ${money(cents)}.`, suggestion: label(rule) };
      return { ...base, class: "matched", disposition: "import", propertyId: rule.propertyId, reason: `Reference matched ${rule.reference}.` };
    }
    // Nothing matched: suggest a property only from the office's own aliases.
    const suggested = row.candidates.length === 1 ? rules.find(rule => rule.propertyId === row.candidates[0]) : undefined;
    const hint = suggested ? { propertyId: suggested.propertyId, suggestion: `Possibly ${label(suggested)}` } : {};
    const address = sources.find(source => ADDRESS.test(source.replace(/\s+/g, " ")));
    if (address) return { ...base, class: "exception", disposition: "hold", reason: "Only an address was given: confirm the property.", ...hint };
    const unknown = sources.find(source => referenceVariants(source).length);
    if (unknown) return { ...base, class: "exception", disposition: "hold", reason: `Unknown reference ${unknown.replace(/\s+/g, " ")}.`, ...hint };
    return { ...base, class: "exception", disposition: "hold", reason: "No reference found.", ...hint };
  });
  // Several payers into one property in one batch may be shared rent.
  const rentRows = rows.filter(row => row.propertyId && (row.class === "matched" || row.reason.startsWith("Amount differs")));
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
