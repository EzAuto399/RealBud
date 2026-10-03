import { createHash } from "node:crypto";
import { validateRedbarkProvenance, type BankSourceArtifact, type BankSourceUpload } from "../shared/bank-source.ts";

/** `tenant`: the REI tenant ledger this property's receipts go to, from the reviewed Desk/REI crosswalk (optional; W1 needs it).
 * `invoiceCodes`: commercial codes whose payments are invoices, not rent. `expectedRent`: cents per `rentPeriod` (default week). */
export interface BankReferenceRule {
  propertyId: string; reference: string; aliases: string[]; tenant?: string;
  invoiceCodes?: string[]; expectedRent?: number; rentPeriod?: "week" | "fortnight" | "month";
}
/** ANZ's transaction export has no header row: date, signed amount, narrative,
 * payer, payee, blank, a second reference and the reference REI reads (col 8). */
export const ANZ_EXPORT_COLUMNS = ["Date", "Amount", "Narrative", "Payer", "Payee", "Blank", "Reference 2", "Reference"] as const;
const ANZ_MAPPING = { date: "Date", amount: "Amount", narrative: "Narrative", reference: "Reference" };
export type BankTable = { cells: string[]; spans: [number, number][] }[] & { layout: "header" | "anz-export" };
const AMOUNT = /^-?(?:0|[1-9]\d{0,11})\.\d{2}$/;
export interface BankReferenceInput {
  csv: string;
  columns: { date: string; amount: string; narrative: string; reference: string };
  dateFormat: "YYYY-MM-DD" | "DD/MM/YYYY";
  rules: BankReferenceRule[];
}
export type BankReferenceUpload = Omit<BankReferenceInput, "csv"> & { source: BankSourceUpload; csv?: never };
export interface BankReferenceRow {
  id: string; date: string; amount: string; narrative: string; reference: string;
  candidates: string[]; issues: string[];
}
export interface BankReferenceBatch {
  version: 1 | 2; originalDigest: string; input: BankReferenceInput; rows: BankReferenceRow[];
  source?: BankSourceArtifact;
}
/** Every source row gets one disposition: import (with a property), hold or exclude.
 * Earlier reviews map onto them: assign = import, keep = hold. Saved decisions keep
 * `assign` for import so existing saved-review validation reads them unchanged. */
export type BankRowDisposition = "import" | "hold" | "exclude";
export interface BankReferenceDecision { rowId: string; action: "assign" | "keep" | BankRowDisposition; propertyId?: string; reason: string }
export const decisionDisposition = (action: BankReferenceDecision["action"]): BankRowDisposition =>
  action === "assign" || action === "import" ? "import" : action === "exclude" ? "exclude" : "hold";
function fail(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
export const bankDigest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safeText = (value: unknown, max: number) => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const formula = (text: string) => /^[\s\uFEFF]*[=+@\-]/u.test(text);
const normalized = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en-AU").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function decodeBankSource(source: BankSourceUpload): { csv: string; bytes: Buffer; artifact: BankSourceArtifact } {
  if (!source || typeof source.filename !== "string" || !source.filename.trim() || source.filename.length > 255 ||
      /[\\/\x00-\x1f\x7f]/.test(source.filename) || [".", ".."].includes(source.filename)) fail("Choose a bank CSV with a valid filename.");
  if (typeof source.bytesBase64 !== "string" || source.bytesBase64.length > 1_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.bytesBase64)) fail("The bank file bytes are not valid. Choose the original CSV again.");
  const bytes = Buffer.from(source.bytesBase64, "base64");
  if (!bytes.length || bytes.length > 750_000 || bytes.toString("base64") !== source.bytesBase64) fail("Choose a non-empty CSV smaller than 750 KB.");
  let csv: string;
  try { csv = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("This bank file is not UTF-8. Export a UTF-8 CSV from the bank; the source file has not been changed."); }
  if (csv.includes("\0")) fail("This bank file contains unsupported encoding or NUL bytes. Export a UTF-8 CSV from the bank.");
  // An API-generated batch carries where its rows came from. Callers admit it
  // only from the server's own Redbark pull, never from an uploaded body.
  const provenance = source.provenance === undefined ? undefined : validateRedbarkProvenance(source.provenance);
  return { csv, bytes, artifact: { filename: source.filename, bytesBase64: source.bytesBase64,
    encoding: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "utf-8-bom" : "utf-8",
    byteLength: bytes.length, digest: bankDigest(bytes), ...(provenance ? { provenance } : {}) } };
}

/** Old reviews captured text only. Their UTF-8 reconstruction remains available,
 * but it must never be presented as verified original upload bytes. */
export function bankBatchSource(batch: BankReferenceBatch) {
  if (!batch || !batch.input || typeof batch.input.csv !== "string") fail("The source batch failed its integrity check.");
  if (batch.version === 2) {
    if (!batch.source) fail("The source batch failed its integrity check.");
    const decoded = decodeBankSource(batch.source);
    if (decoded.csv !== batch.input.csv || decoded.artifact.digest !== batch.originalDigest ||
        decoded.artifact.digest !== batch.source.digest || decoded.artifact.encoding !== batch.source.encoding ||
        decoded.artifact.byteLength !== batch.source.byteLength) fail("The source batch failed its integrity check.");
    // RealBud rendered an API batch itself: it is not the bank's export file.
    return { ...decoded, originalBytesCaptured: !decoded.artifact.provenance };
  }
  if (batch.version !== 1 || bankDigest(batch.input.csv) !== batch.originalDigest) fail("The source batch failed its integrity check.");
  const decoded = decodeBankSource({ filename: `bank-saved-text-${batch.originalDigest.slice(0, 12)}.csv`, bytesBase64: Buffer.from(batch.input.csv, "utf8").toString("base64") });
  if (decoded.csv !== batch.input.csv) fail("This older saved text cannot be recovered without changing it. Keep the saved review and upload the original file separately.");
  return { ...decoded, originalBytesCaptured: false };
}

/** Strict RFC-style CSV. Offsets let export replace only reference cells,
 * preserving original bytes, order, quoting, dates, signed amounts and BOM. */
export function parseBankCsv(csv: string): BankTable {
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
  // An ANZ export starts with a transaction (DD/MM/YYYY, quoted signed amount)
  // across 8 columns. Give it a zero-width virtual header so row 0 stays the
  // header everywhere; no byte of the file belongs to it.
  const first = rows[0];
  let layout: BankTable["layout"] = "header";
  if (first.cells.length === 8 && /^\d{2}\/\d{2}\/\d{4}$/.test(first.cells[0]) && csv[first.spans[1][0]] === '"' && AMOUNT.test(first.cells[1])) {
    while (rows.length > 1 && rows[rows.length - 1].cells.length === 1 && !rows[rows.length - 1].cells[0]) rows.pop(); // trailing blank lines
    rows.unshift({ cells: [...ANZ_EXPORT_COLUMNS], spans: ANZ_EXPORT_COLUMNS.map((): [number, number] => [first.spans[0][0], first.spans[0][0]]) });
    layout = "anz-export";
    if (rows.length > 3001) fail("Use batches of at most 3,000 transactions.");
  }
  if (rows.length < 2) fail("The CSV needs a header and at least one transaction.");
  const headers = rows[0].cells;
  if (headers.some(h => !h.trim() || formula(h)) || new Set(headers.map(h => h.trim().toLowerCase())).size !== headers.length) fail("CSV headers must be named, unique and plain text.");
  if (rows.some(row => row.cells.length !== headers.length)) fail("CSV rows have different column counts.");
  return Object.assign(rows, { layout });
}

function validDate(text: string, format: BankReferenceInput["dateFormat"]): boolean {
  const match = format === "YYYY-MM-DD" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) return false;
  const [y, m, d] = format === "YYYY-MM-DD" ? [+match[1], +match[2], +match[3]] : [+match[3], +match[2], +match[1]];
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2200 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function createBankReferenceBatch(upload: BankReferenceInput | BankReferenceUpload): BankReferenceBatch {
  if (!upload || !["YYYY-MM-DD", "DD/MM/YYYY"].includes(upload.dateFormat)) fail("Choose the date format used in this bank export.");
  const decoded = "source" in upload ? decodeBankSource(upload.source) : null;
  if (decoded && upload.csv !== undefined) fail("Choose one original bank file; do not supply a second text copy.");
  const csv = decoded?.csv ?? (upload as BankReferenceInput).csv, table = parseBankCsv(csv), headers = table[0].cells;
  // The ANZ profile fixes its own mapping; only the original file can be prepared.
  if (table.layout === "anz-export" && !decoded) fail("Upload the original ANZ export file; a text copy cannot be prepared.");
  const input: BankReferenceInput = table.layout === "anz-export" ? { csv, columns: { ...ANZ_MAPPING }, dateFormat: "DD/MM/YYYY", rules: upload.rules }
    : { csv, columns: upload.columns, dateFormat: upload.dateFormat, rules: upload.rules };
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
    if (rule.tenant !== undefined && (!safeText(rule.tenant, 200) || !rule.tenant.trim() || formula(rule.tenant))) fail("Each property's REI tenant must be plain text.");
    if (rule.invoiceCodes !== undefined && (!Array.isArray(rule.invoiceCodes) || rule.invoiceCodes.length > 20 || rule.invoiceCodes.some(code => !safeText(code, 50) || !code.trim() || formula(code)))) fail("Invoice codes must be short plain text.");
    if (rule.expectedRent !== undefined && (!Number.isSafeInteger(rule.expectedRent) || rule.expectedRent <= 0)) fail("Expected rent must be a positive amount in cents.");
    if (rule.rentPeriod !== undefined && !["week", "fortnight", "month"].includes(rule.rentPeriod)) fail("Rent period must be week, fortnight or month.");
  }
  // The reference directory is fixed for this batch. Normalize its aliases
  // once, including when validating historical rows against the original CSV.
  const matchingRules = input.rules.map(rule => ({ propertyId: rule.propertyId, aliases: rule.aliases.map(alias => ` ${normalized(alias)} `) }));
  const originalDigest = bankDigest(input.csv), duplicateKeys = new Map<string, number>();
  // Redbark rows keep the bank's transaction id, so overlapping pulls name the
  // same transaction identically; identical-looking payments stay distinct.
  const sourceIds = decoded?.artifact.provenance?.transactionIds;
  if (sourceIds && sourceIds.length !== table.length - 1) fail("The source batch failed its integrity check.");
  const rows = table.slice(1).map(({ cells }, index): BankReferenceRow => {
    const [date, amount, narrative, reference] = indexes.map(i => cells[i]);
    const issues: string[] = [];
    if (!validDate(date, input.dateFormat)) fail(`Transaction ${index + 1} has an invalid date for the selected format.`);
    if (!AMOUNT.test(amount)) fail(`Transaction ${index + 1} needs a signed decimal amount with two cents digits; debit/credit layouts need a separate mapping.`);
    if (BigInt(amount.replace(".", "")) <= 0n) issues.push("Not an incoming payment; keep unchanged for separate review.");
    // Never emit spreadsheet formulas from any untrusted textual field.
    if (cells.some((value, i) => i !== indexes[1] && formula(value))) fail(`Transaction ${index + 1} contains a spreadsheet formula-like value. Review the source safely before importing.`);
    const haystack = ` ${normalized(narrative)} `;
    const candidates = matchingRules.filter(rule => rule.aliases.some(alias => haystack.includes(alias))).map(rule => rule.propertyId);
    if (reference.trim()) issues.push("Existing reference; keep unless a reviewed correction is needed.");
    if (!candidates.length) issues.push("No property match; review manually.");
    if (candidates.length > 1) issues.push("More than one property matches; review manually.");
    const key = JSON.stringify([date, amount, narrative, reference]);
    duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1);
    return { id: sourceIds ? `redbark:${sourceIds[index]}` : `${originalDigest}:${index + 1}`, date, amount, narrative, reference, candidates, issues };
  });
  for (const row of rows) if (duplicateKeys.get(JSON.stringify([row.date, row.amount, row.narrative, row.reference]))! > 1) row.issues.push("Possible duplicate; both source rows are preserved. Confirm before import.");
  const batch: BankReferenceBatch = { version: decoded ? 2 : 1, originalDigest, input: structuredClone(input), rows,
    ...(decoded ? { source: decoded.artifact } : {}) };
  bankBatchSource(batch);
  return batch;
}

export function reviewBankReferences(batch: BankReferenceBatch, decisions: BankReferenceDecision[]) {
  // Re-derive from the immutable original; do not trust client candidate rows.
  const source = bankBatchSource(batch);
  // Re-derive from the captured source so API-sourced row identities hold.
  const fresh = createBankReferenceBatch(batch.version === 2 ? { source: source.artifact, columns: batch.input.columns, dateFormat: batch.input.dateFormat, rules: batch.input.rules } : batch.input);
  const table = parseBankCsv(batch.input.csv);
  if (!Array.isArray(decisions) || decisions.length !== fresh.rows.length || new Set(decisions.map(d => d?.rowId)).size !== decisions.length) fail("Review every row exactly once before preparing the export.");
  const refIndex = table[0].cells.indexOf(batch.input.columns.reference);
  const changes: { rowId: string; from: string; to: string; reason: string }[] = [];
  const replacements: { span: [number, number]; text: string }[] = [];
  const map = new Map(decisions.map(d => [d.rowId, d]));
  fresh.rows.forEach((row, index) => {
    const decision = map.get(row.id);
    if (!decision || !["assign", "keep", "import", "hold", "exclude"].includes(decision.action) || !safeText(decision.reason, 500) || !decision.reason.trim()) fail("Every row needs a decision and a short review reason.");
    if (decisionDisposition(decision.action) !== "import") { if (decision.propertyId) fail(`A ${decision.action} decision cannot assign a property.`); return; }
    if (BigInt(row.amount.replace(".", "")) <= 0n) fail("Only incoming payments can receive a property reference in this workflow.");
    const rule = batch.input.rules.find(r => r.propertyId === decision.propertyId);
    if (!rule) fail("Choose a property from this batch's saved reference directory.");
    if (rule.reference === row.reference) return;
    changes.push({ rowId: row.id, from: row.reference, to: rule.reference, reason: decision.reason.trim() });
    const span = table[index + 1].spans[refIndex];
    replacements.push({ span, text: batch.input.csv[span[0]] === '"' || /[",\r\n]/.test(rule.reference) ? `"${rule.reference.replaceAll('"', '""')}"` : rule.reference });
  });
  // Slice unchanged bytes from the captured source. Convert UTF-16 parser
  // offsets incrementally so multibyte characters cannot shift a replacement.
  const chunks: Buffer[] = [];
  let charOffset = 0, byteOffset = 0;
  for (const { span: [start, end], text } of replacements) {
    const byteStart = byteOffset + Buffer.byteLength(batch.input.csv.slice(charOffset, start), "utf8");
    chunks.push(source.bytes.subarray(byteOffset, byteStart), Buffer.from(text, "utf8"));
    byteOffset = byteStart + Buffer.byteLength(batch.input.csv.slice(start, end), "utf8");
    charOffset = end;
  }
  chunks.push(source.bytes.subarray(byteOffset));
  const bytes = Buffer.concat(chunks), csv = bytes.toString("utf8");
  const output = parseBankCsv(csv);
  if (output.length !== table.length || output.some((row, i) => row.cells.some((value, c) => c !== refIndex && value !== table[i].cells[c]))) fail("The output failed its transaction integrity check.");
  return { csv, bytesBase64: bytes.toString("base64"), byteLength: bytes.length, encoding: source.artifact.encoding,
    changes, originalDigest: batch.originalDigest, outputDigest: bankDigest(bytes) };
}

/** Import unless anything is unresolved: a debit, no or several property matches, an existing reference or a possible duplicate holds. */
export const defaultDisposition = (row: BankReferenceRow): BankRowDisposition =>
  BigInt(row.amount.replace(".", "")) > 0n && row.candidates.length === 1 && !row.issues.length ? "import" : "hold";

/** One line of ANZ's transaction export (no header, LF line ends as in ANZ's
 * file): DD/MM/YYYY, quoted signed amount, narrative, columns 4-7 empty, the
 * reference REI reads in column 8. A cell is quoted only when it must be. */
const anzLine = (isoDate: string, amount: string, narrative: string, reference: string) => {
  const cell = (text: string) => /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)},"${amount}",${cell(narrative)},,,,,${cell(reference)}\n`;
};

/** The separate REI import file, read by REI with File Format `ANZ(csv file)`
 * (the office default seen on REI's Bulk Receipting page, 2 Oct 2026). An ANZ
 * upload keeps its original bytes: only column 8 corrected, rows not imported
 * removed as whole lines, no header added. Any other upload keeps its header
 * and the import rows, each exactly as in the reviewed copy. A Redbark batch is
 * rendered in ANZ's layout from the reviewed rows; PROVISIONAL until one real
 * REI preview confirms REI reads it. Every source row is listed with its disposition. */
export function bankImportArtifact(batch: BankReferenceBatch, decisions: BankReferenceDecision[]) {
  const reviewed = reviewBankReferences(batch, decisions);
  const byRow = new Map(decisions.map(decision => [decision.rowId, decision]));
  const table = parseBankCsv(reviewed.csv), header = table[0].cells, refIndex = header.indexOf(batch.input.columns.reference);
  if (table.length !== batch.rows.length + 1) fail("The output failed its transaction integrity check.");
  const rows = batch.rows.map((row, index) => {
    const decision = byRow.get(row.id)!, disposition = decisionDisposition(decision.action);
    const rule = disposition === "import" ? batch.input.rules.find(r => r.propertyId === decision.propertyId) : undefined;
    return { rowId: row.id, disposition, date: row.date, amount: row.amount, reference: table[index + 1].cells[refIndex],
      ...(rule ? { propertyId: rule.propertyId, ...(rule.tenant ? { tenant: rule.tenant } : {}) } : {}) };
  });
  const count = (kind: BankRowDisposition) => rows.filter(row => row.disposition === kind).length;
  const summary = { rows: rows.length, import: count("import"), hold: count("hold"), exclude: count("exclude") };
  if (!summary.import) return { rows, summary, artifact: null };
  if (batch.source?.provenance) {
    if (batch.input.dateFormat !== "YYYY-MM-DD" || table.layout !== "header") fail("The import file failed its transaction integrity check.");
    const csv = rows.map((row, index) => row.disposition === "import" ? anzLine(row.date, row.amount, batch.rows[index].narrative, row.reference) : "").join("");
    const output = parseBankCsv(csv), kept = rows.filter(row => row.disposition === "import");
    if (output.layout !== "anz-export" || output.length !== kept.length + 1 ||
        output.slice(1).some(({ cells }, i) => cells[1] !== kept[i].amount || cells[7] !== kept[i].reference || cells.slice(3, 7).some(Boolean))) fail("The import file failed its transaction integrity check.");
    const bytes = Buffer.from(csv, "utf8");
    return { rows, summary, artifact: { csv, bytesBase64: bytes.toString("base64"), byteLength: bytes.length, encoding: "utf-8" as const, digest: bankDigest(bytes) } };
  }
  const start = (index: number) => index < table.length ? table[index].spans[0][0] : reviewed.csv.length;
  let csv = reviewed.csv.slice(0, start(1));
  rows.forEach((row, index) => { if (row.disposition === "import") csv += reviewed.csv.slice(start(index + 1), start(index + 2)); });
  const output = parseBankCsv(csv), kept = table.filter((_, index) => index === 0 || rows[index - 1].disposition === "import");
  if (output.length !== kept.length || output.some((row, i) => row.cells.length !== kept[i].cells.length || row.cells.some((value, c) => value !== kept[i].cells[c]))) fail("The import file failed its transaction integrity check.");
  const bytes = Buffer.from(csv, "utf8");
  return { rows, summary, artifact: { csv, bytesBase64: bytes.toString("base64"), byteLength: bytes.length, encoding: reviewed.encoding, digest: bankDigest(bytes) } };
}
