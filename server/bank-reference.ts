import { createHash } from "node:crypto";

export interface BankReferenceRule { propertyId: string; reference: string; aliases: string[] }
export interface BankReferenceInput {
  csv: string;
  columns: { date: string; amount: string; narrative: string; reference: string };
  dateFormat: "YYYY-MM-DD" | "DD/MM/YYYY";
  rules: BankReferenceRule[];
}
export interface BankReferenceRow {
  id: string; date: string; amount: string; narrative: string; reference: string;
  candidates: string[]; issues: string[];
}
export interface BankReferenceBatch {
  version: 1; originalDigest: string; input: BankReferenceInput; rows: BankReferenceRow[];
}
export interface BankReferenceDecision { rowId: string; action: "assign" | "keep"; propertyId?: string; reason: string }
function fail(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
export const bankDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const safeText = (value: unknown, max: number) => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const formula = (text: string) => /^[\s\uFEFF]*[=+@\-]/u.test(text);
const normalized = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en-AU").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Strict RFC-style CSV. Offsets let export replace only reference cells,
 * preserving original bytes, order, quoting, dates, signed amounts and BOM. */
export function parseBankCsv(csv: string): { cells: string[]; spans: [number, number][] }[] {
  if (typeof csv !== "string" || Buffer.byteLength(csv) > 750_000 || !csv.length) fail("Choose a non-empty CSV smaller than 750 KB.");
  const rows: { cells: string[]; spans: [number, number][] }[] = [];
  let i = csv.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < csv.length) {
    const cells: string[] = [], spans: [number, number][] = [];
    for (;;) {
      const start = i; let value = "";
      if (csv[i] === '"') {
        i++; let closed = false;
        while (i < csv.length) {
          if (csv[i] === '"') {
            i++;
            if (csv[i] === '"') { value += '"'; i++; }
            else { closed = true; break; }
          } else value += csv[i++];
        }
        if (!closed) fail("The CSV has an unfinished quoted field.");
        if (i < csv.length && ![",", "\r", "\n"].includes(csv[i])) fail("The CSV has characters after a quoted field.");
      } else {
        while (i < csv.length && ![",", "\r", "\n"].includes(csv[i])) {
          if (csv[i] === '"') fail("The CSV has an unexpected quote.");
          value += csv[i++];
        }
      }
      if (!safeText(value, 10_000)) fail("The CSV contains an unsupported or oversized field.");
      cells.push(value); spans.push([start, i]);
      if (cells.length > 100) fail("The CSV has too many columns.");
      if (csv[i] !== ",") break;
      i++;
    }
    rows.push({ cells, spans });
    if (rows.length > 3001) fail("Use batches of at most 3,000 transactions.");
    if (csv[i] === "\r") { i++; if (csv[i] === "\n") i++; }
    else if (csv[i] === "\n") i++;
  }
  if (rows.length < 2) fail("The CSV needs a header and at least one transaction.");
  const headers = rows[0].cells;
  if (headers.some(h => !h.trim() || formula(h)) || new Set(headers.map(h => h.trim().toLowerCase())).size !== headers.length) fail("CSV headers must be named, unique and plain text.");
  if (rows.some(row => row.cells.length !== headers.length)) fail("CSV rows have different column counts.");
  return rows;
}

function validDate(text: string, format: BankReferenceInput["dateFormat"]): boolean {
  const match = format === "YYYY-MM-DD" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) return false;
  const [y, m, d] = format === "YYYY-MM-DD" ? [+match[1], +match[2], +match[3]] : [+match[3], +match[2], +match[1]];
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2200 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function createBankReferenceBatch(input: BankReferenceInput): BankReferenceBatch {
  if (!input || !["YYYY-MM-DD", "DD/MM/YYYY"].includes(input.dateFormat)) fail("Choose the date format used in this bank export.");
  const table = parseBankCsv(input.csv), headers = table[0].cells;
  const names = input.columns && [input.columns.date, input.columns.amount, input.columns.narrative, input.columns.reference];
  if (!names || new Set(names).size !== 4 || names.some(n => typeof n !== "string" || !headers.includes(n))) fail("Map four different existing columns: date, signed amount, description and reference.");
  const indexes = names.map(n => headers.indexOf(n));
  if (!Array.isArray(input.rules) || input.rules.length > 2000) fail("Use at most 2,000 property reference rules.");
  const ids = new Set<string>(), references = new Set<string>();
  for (const rule of input.rules) {
    if (!rule || !safeText(rule.propertyId, 100) || !rule.propertyId.trim() || !safeText(rule.reference, 100) || !rule.reference.trim() || formula(rule.reference) || /[\r\n\t]/.test(rule.reference)) fail("Each property needs a valid identity and a plain reference number.");
    if (ids.has(rule.propertyId) || references.has(rule.reference)) fail("Property identities and reference numbers must be unique.");
    ids.add(rule.propertyId); references.add(rule.reference);
    if (!Array.isArray(rule.aliases) || rule.aliases.length > 20 || rule.aliases.some(a => !safeText(a, 200) || normalized(a).length < 3)) fail("Use clear payer aliases with at least three letters or digits.");
  }
  const originalDigest = bankDigest(input.csv), duplicateKeys = new Map<string, number>();
  const rows = table.slice(1).map(({ cells }, index): BankReferenceRow => {
    const [date, amount, narrative, reference] = indexes.map(i => cells[i]);
    const issues: string[] = [];
    if (!validDate(date, input.dateFormat)) fail(`Transaction ${index + 1} has an invalid date for the selected format.`);
    if (!/^-?(?:0|[1-9]\d{0,11})\.\d{2}$/.test(amount)) fail(`Transaction ${index + 1} needs a signed decimal amount with two cents digits; debit/credit layouts need a separate mapping.`);
    if (BigInt(amount.replace(".", "")) <= 0n) issues.push("Not an incoming payment; keep unchanged for separate review.");
    // Never emit spreadsheet formulas from any untrusted textual field.
    if (cells.some((value, i) => i !== indexes[1] && formula(value))) fail(`Transaction ${index + 1} contains a spreadsheet formula-like value. Review the source safely before importing.`);
    const haystack = ` ${normalized(narrative)} `;
    const candidates = input.rules.filter(rule => rule.aliases.some(a => haystack.includes(` ${normalized(a)} `))).map(rule => rule.propertyId);
    if (reference.trim()) issues.push("Existing reference; keep unless a reviewed correction is needed.");
    if (!candidates.length) issues.push("No property match; review manually.");
    if (candidates.length > 1) issues.push("More than one property matches; review manually.");
    const key = JSON.stringify([date, amount, narrative, reference]);
    duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1);
    return { id: `${originalDigest}:${index + 1}`, date, amount, narrative, reference, candidates, issues };
  });
  for (const row of rows) if (duplicateKeys.get(JSON.stringify([row.date, row.amount, row.narrative, row.reference]))! > 1) row.issues.push("Possible duplicate; both source rows are preserved. Confirm before import.");
  return { version: 1, originalDigest, input: structuredClone(input), rows };
}

export function reviewBankReferences(batch: BankReferenceBatch, decisions: BankReferenceDecision[]) {
  // Re-derive from the immutable original; do not trust client candidate rows.
  if (batch.version !== 1 || bankDigest(batch.input.csv) !== batch.originalDigest) fail("The source batch failed its integrity check.");
  const fresh = createBankReferenceBatch(batch.input), table = parseBankCsv(batch.input.csv);
  if (!Array.isArray(decisions) || decisions.length !== fresh.rows.length || new Set(decisions.map(d => d?.rowId)).size !== decisions.length) fail("Review every row exactly once before preparing the export.");
  const refIndex = table[0].cells.indexOf(batch.input.columns.reference);
  const changes: { rowId: string; from: string; to: string; reason: string }[] = [];
  const replacements: { span: [number, number]; text: string }[] = [];
  const map = new Map(decisions.map(d => [d.rowId, d]));
  fresh.rows.forEach((row, index) => {
    const decision = map.get(row.id);
    if (!decision || !["assign", "keep"].includes(decision.action) || !safeText(decision.reason, 500) || !decision.reason.trim()) fail("Every row needs a decision and a short review reason.");
    if (decision.action === "keep") { if (decision.propertyId) fail("A keep decision cannot assign a property."); return; }
    if (BigInt(row.amount.replace(".", "")) <= 0n) fail("Only incoming payments can receive a property reference in this workflow.");
    const rule = batch.input.rules.find(r => r.propertyId === decision.propertyId);
    if (!rule) fail("Choose a property from this batch's saved reference directory.");
    if (rule.reference === row.reference) return;
    changes.push({ rowId: row.id, from: row.reference, to: rule.reference, reason: decision.reason.trim() });
    replacements.push({ span: table[index + 1].spans[refIndex], text: /[",\r\n]/.test(rule.reference) ? `"${rule.reference.replaceAll('"', '""')}"` : rule.reference });
  });
  let csv = batch.input.csv;
  for (const { span: [start, end], text } of replacements.reverse()) csv = csv.slice(0, start) + text + csv.slice(end);
  const output = parseBankCsv(csv);
  if (output.length !== table.length || output.some((row, i) => row.cells.some((value, c) => c !== refIndex && value !== table[i].cells[c]))) fail("The output failed its transaction integrity check.");
  return { csv, changes, originalDigest: batch.originalDigest, outputDigest: bankDigest(csv) };
}
