// W1 REI reconciliation: pure, row-by-row comparisons between the reviewed
// receipt batch RealBud prepared and what REI shows. No I/O, no browser.
//   - reconcilePreview: the batch's expected rows against REI's Bulk receipting
//     import preview (not the Pending Transactions payments page) (matched / mismatched / missing / extra /
//     warnings). Only a clean preview is `ready` for the person to post.
//   - registerBaseline: the Receipt Register as it stood before the upload.
//   - classifyReadback: the batch's rows against a Receipt Register export
//     (accepted / rejected / pending), with the export's own scope checked and
//     only receipts that are new since the baseline, inside the window, counted.
// Multiplicity is preserved: two identical legitimate credits need two rows.
// A preview row is identified by reference + amount + date + the expected
// tenant: the tenant is required, and a row REI shows for another tenant, or
// for no tenant, is a mismatch. REI's own register export has no reference:
// see the readback section. Totals are reported, never used to authorise a batch.
import { parseCsvTable } from "./csv-ledger.ts";

export interface W1ExpectedRow {
  /** The batch row's stable id (Packet 1/2 lineage), carried into every outcome. */
  rowId: string;
  /** YYYY-MM-DD. */
  date: string;
  reference: string;
  /** Integer cents; a receipt is positive. */
  amountCents: number;
  /** REQUIRED: the tenant ledger the reviewer expects REI to receipt this row to, as REI names it. */
  tenant: string;
  /** REI's own tenant id from the reviewed crosswalk, when known; then a preview or register Tenant ID must equal it. */
  tenantId?: string;
}

export interface W1PreviewRow { index: number; date: string | null; reference: string; amountCents: number | null; tenant: string | null; tenantId: string | null; match: string | null; raw: Record<string, string> }
export type W1PreviewField = "date" | "amount" | "tenant";
export interface W1PreviewMismatch { expected: W1ExpectedRow; actual: W1PreviewRow; fields: W1PreviewField[] }
export interface W1PreviewWarning { code: string; message: string; rowId?: string; index?: number }

export interface W1PreviewReconciliation {
  kind: "w1-rei-preview-reconciliation";
  /** True only when every expected row matched exactly once, nothing is extra, totals agree and no warning is open. */
  ready: boolean;
  matched: Array<{ expected: W1ExpectedRow; actual: W1PreviewRow }>;
  mismatched: W1PreviewMismatch[];
  missing: W1ExpectedRow[];
  extra: W1PreviewRow[];
  warnings: W1PreviewWarning[];
  totals: { expectedRows: number; previewRows: number; expectedCents: number; previewCents: number | null };
}

const CLEAN = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();

/** Money text to integer cents: "$1,234.50", "1234.5", "(75.00)" and "-75.00". Anything else is null. */
export function amountCents(text: string | undefined | null): number | null {
  if (typeof text !== "string") return null;
  let value = text.trim().replace(/[$,\s]/g, "").replace(/^AUD/i, "");
  let negative = false;
  if (/^\(.*\)$/.test(value)) { negative = true; value = value.slice(1, -1); }
  if (value.startsWith("-")) { negative = !negative; value = value.slice(1); }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? (negative ? -cents : cents) : null;
}

/** YYYY-MM-DD or Australian DD/MM/YYYY to YYYY-MM-DD. Anything else is null (never guessed). */
export function isoDate(text: string | undefined | null): string | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  let year: number, month: number, day: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value))) [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Validates a batch's expected rows; throws a user-facing sentence. */
export function assertExpectedRows(rows: readonly W1ExpectedRow[]): void {
  if (!rows.length) throw new Error("This batch has no rows to receipt.");
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.rowId !== "string" || !row.rowId || ids.has(row.rowId)) throw new Error("Each batch row needs its own id.");
    ids.add(row.rowId);
    if (isoDate(row.date) !== row.date) throw new Error(`Batch row ${row.rowId} has no valid date.`);
    if (typeof row.reference !== "string" || !CLEAN(row.reference)) throw new Error(`Batch row ${row.rowId} has no reference.`);
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) throw new Error(`Batch row ${row.rowId} is not a positive receipt amount.`);
    if (typeof row.tenant !== "string" || !CLEAN(row.tenant)) throw new Error(`Batch row ${row.rowId} has no expected REI tenant. Map it to its tenant before import.`);
    if (row.tenantId !== undefined && (typeof row.tenantId !== "string" || !CLEAN(row.tenantId))) throw new Error(`Batch row ${row.rowId} has an empty REI tenant id.`);
  }
}

const TENANT = ["tenant", "tenant name", "matched tenant"];
const TENANT_ID = ["tenant id", "tenant code", "tenantid"];
/** The first of `names` (in that order of preference) the record has. An ANZ
 * preview can show the narrative beside the reference: the reference wins. */
const column = (record: Record<string, string>, names: string[]): string | undefined => {
  const entries = Object.entries(record).map(([key, value]) => [key.trim().toLowerCase(), value] as const);
  for (const name of names) { const found = entries.find(([key]) => key === name); if (found) return found[1]; }
  return undefined;
};
/** REI preview grid rows (header → cell, as the recipe runner reads them) to typed rows. */
export function previewRows(records: ReadonlyArray<Record<string, string>>): W1PreviewRow[] {
  return records.map((raw, index) => {
    const text = (names: string[]) => { const value = column(raw, names)?.trim(); return value ? value : null; };
    return { index, date: isoDate(column(raw, ["date", "transaction date"])), reference: column(raw, ["reference", "description", "narrative"]) ?? "",
      amountCents: amountCents(column(raw, ["amount", "credit"])), tenant: text(TENANT), tenantId: text(TENANT_ID), match: text(["match", "status", "match status"]), raw: { ...raw } };
  });
}

const same = (expected: W1ExpectedRow, actual: { reference: string }) => CLEAN(expected.reference) === CLEAN(actual.reference);
/** The expected tenant, and its id when the crosswalk has one, are both shown. Absent is never a match. */
const sameTenant = (expected: W1ExpectedRow, actual: { tenant: string | null; tenantId: string | null }) =>
  actual.tenant !== null && CLEAN(actual.tenant) === CLEAN(expected.tenant) && (expected.tenantId === undefined || (actual.tenantId !== null && CLEAN(actual.tenantId) === CLEAN(expected.tenantId)));
const MATCHED = /^(matched|ok|ready|allocated)$/i;

export function reconcilePreview(expected: readonly W1ExpectedRow[], records: ReadonlyArray<Record<string, string>>, options: { flags?: readonly string[]; previewComplete?: boolean } = {}): W1PreviewReconciliation {
  assertExpectedRows(expected);
  const rows = previewRows(records);
  const warnings: W1PreviewWarning[] = [];
  for (const flag of options.flags ?? []) warnings.push({ code: flag.split(" ")[0], message: `The portal run flagged: ${flag}.` });
  if (options.previewComplete === false) warnings.push({ code: "preview-incomplete", message: "The preview was not read to its last page." });
  for (const row of rows) {
    if (row.date === null || row.amountCents === null || !CLEAN(row.reference)) warnings.push({ code: "preview-row-unreadable", message: `Preview row ${row.index + 1} has an unreadable date, reference or amount.`, index: row.index });
  }
  const left = new Set(rows.map(row => row.index));
  const take = (test: (row: W1PreviewRow) => boolean) => { const found = rows.find(row => left.has(row.index) && test(row)); if (found) left.delete(found.index); return found; };
  const exact = (row: W1ExpectedRow, item: W1PreviewRow) => same(row, item) && item.amountCents === row.amountCents && item.date === row.date;
  const matched: W1PreviewReconciliation["matched"] = [];
  const unmatched: W1ExpectedRow[] = [];
  // Pass 1: exact reference + amount + date + tenant, one preview row per expected row.
  for (const row of expected) {
    const actual = take(item => exact(row, item) && sameTenant(row, item));
    if (actual) matched.push({ expected: row, actual }); else unmatched.push(row);
  }
  // Pass 2: the same reference with another tenant, amount or date is a mismatch, not a missing row plus an extra one.
  const mismatched: W1PreviewMismatch[] = []; const missing: W1ExpectedRow[] = [];
  for (const row of unmatched) {
    const actual = take(item => exact(row, item)) ?? take(item => same(row, item));
    if (!actual) { missing.push(row); continue; }
    mismatched.push({ expected: row, actual, fields: [...(actual.date !== row.date ? ["date" as const] : []), ...(actual.amountCents !== row.amountCents ? ["amount" as const] : []), ...(!sameTenant(row, actual) ? ["tenant" as const] : [])] });
  }
  // REI's own match state on matched rows.
  for (const pair of matched) {
    if (pair.actual.match !== null && !MATCHED.test(pair.actual.match)) warnings.push({ code: "preview-row-unmatched", message: `REI shows ${pair.expected.reference} as ${pair.actual.match}.`, rowId: pair.expected.rowId, index: pair.actual.index });
  }
  const extra = rows.filter(row => left.has(row.index));
  const expectedCents = expected.reduce((sum, row) => sum + row.amountCents, 0);
  const previewCents = rows.every(row => row.amountCents !== null) ? rows.reduce((sum, row) => sum + (row.amountCents ?? 0), 0) : null;
  if (previewCents !== expectedCents) warnings.push({ code: "total-differs", message: `The preview total ${previewCents === null ? "is unreadable" : `is ${(previewCents / 100).toFixed(2)}`}; the batch total is ${(expectedCents / 100).toFixed(2)}.` });
  if (rows.length !== expected.length) warnings.push({ code: "row-count-differs", message: `The preview has ${rows.length} rows; the batch has ${expected.length}.` });
  const ready = !mismatched.length && !missing.length && !extra.length && !warnings.length && matched.length === expected.length;
  return { kind: "w1-rei-preview-reconciliation", ready, matched, mismatched, missing, extra, warnings,
    totals: { expectedRows: expected.length, previewRows: rows.length, expectedCents, previewCents } };
}

// ── Receipt Register readback ────────────────────────────────────────────
// Three register layouts are read:
//   - "rei": REI's own Receipt Register export (seen live 7 Oct 2026, REI
//     v26.0922.0). The CSV is a Telerik export whose header is internal ids:
//     Reference1 = Date (dd/mm/yyyy), Surname1 = Rec No, Authority1 = InTrust1 =
//     the amount, textBox6 = Received From (the payer's name); every other
//     column repeats report totals or captions. The Excel export is labelled
//     (Date, Rec No, Received From, ..., Direct Credit, Total) under a business
//     name and "For The Period - <Month Year>". Neither names a business code,
//     a tenant reference or a status. A reversal is read only from a column
//     whose header is labelled "Reversal Reason" (a non-empty value = reversed,
//     i.e. rejected). Today's Telerik CSV has no such header (only a caption
//     cell reading "Reversal Reason:"), so its readback is never complete: a
//     real export that contains a reversal is needed to identify the value
//     column before that can change. The account comes from the runner's own
//     page checks around the download, and the period from the caption or a
//     period the host proves REI applied.
//   - "labelled": Date, Reference, Tenant, Amount, Status with business/from/to
//     scope lines before the header (the fictional portal).
// A receipt is attributable only when it is new since the pre-upload baseline,
// dated inside the batch window and in the export of the batch's REI account.
// With a reference, reference + amount + the expected tenant identify it.
// Without one (REI's export), owner rule 7 Oct 2026: the same date (the
// register may show the bank date or the next business day), the exact amount
// AND the payer's surname agreeing with the batch row's REI tenant. Two
// candidates, or one register row two batch rows could claim, is ambiguous:
// pending, never accepted. A blank status in a layout that has one is unknown.
export type W1RowOutcome = "accepted" | "rejected" | "pending";
export interface W1RegisterRow { line: number; receiptId: string | null; date: string | null; reference: string; amountCents: number | null; tenant: string | null; tenantId: string | null; status: string | null }
export interface W1DateWindow { from: string; to: string }
/** The REI account: its top-bar business code, and the reicid only when the office saved one. */
export interface W1Destination { urlValue?: string; marker: string }
/** The runner's own account checks on the export page, before and after the download. A missing check is never a pass. */
export interface W1PageScope { marker: string; checkedBefore: boolean; checkedAfter: boolean }
/** Host-supplied facts about how the export was made, for exports that do not name them. */
export interface W1RegisterEvidence { pageScope?: W1PageScope; exportPeriod?: W1DateWindow }
/** The register as it stood before the upload: identities of every receipt already in the window. */
export interface W1RegisterBaseline {
  kind: "w1-rei-register-baseline";
  destination: W1Destination;
  window: W1DateWindow;
  /** One entry per receipt (receipt id, else date|reference|amount|tenant); repeats are kept. */
  receipts: string[];
}
export interface W1Readback {
  kind: "w1-rei-readback";
  /** The export's own scope lines, or (when it names none) both page checks for the destination: else unverified. */
  scope: "verified" | "mismatch" | "absent";
  /** Account-scoped, every row readable and the export's period covers the window. */
  registerComplete: boolean;
  /** A complete register with no new receipt that could be any of the batch's rows: the only proof nothing of it reached REI. */
  absent: boolean;
  outcomes: Array<{ rowId: string; outcome: W1RowOutcome; register?: W1RegisterRow }>;
  accepted: number; rejected: number; pending: number;
  /** New register rows that belong to no batch row (other receipts that day, or a duplicate import). */
  unclaimed: W1RegisterRow[];
  /** Rows the baseline already held or dated outside the window: never attributed to this batch. */
  historical: number;
  warnings: W1PreviewWarning[];
  /** Every row accepted, scope verified, baseline-attributed, nothing ambiguous: the only state that may advance import progress. */
  complete: boolean;
}

const REJECTED = /^(rejected|reversed|reversal|dishonou?red|failed|cancelled|void(ed)?)$/i;
const ACCEPTED = /^(receipted|posted|processed|accepted|ok|complete(d)?)$/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "For The Period - September 2026" → that calendar month. */
function captionPeriod(text: string): W1DateWindow | null {
  const match = /^for the period\s*[-–]\s*([a-z]+)\s+(\d{4})$/i.exec(text.trim());
  const month = match ? MONTHS.indexOf(match[1].toLowerCase()) : -1;
  if (!match || month < 0) return null;
  const year = Number(match[2]), end = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { from: `${year}-${String(month + 1).padStart(2, "0")}-01`, to: `${year}-${String(month + 1).padStart(2, "0")}-${end}` };
}
/** The runner splits download lines on every comma; a quoted field ("$1,050.00", "Surname, Firstname") is put back together here. */
function cellsOf(raw: readonly string[]): string[] | null {
  if (!raw.some(cell => cell.includes("\""))) return [...raw];
  try { return parseCsvTable(raw.join(","))[0] ?? []; } catch { return null; }
}

/** A header labelled "Reversal Reason" (case and a trailing colon ignored). Never a guessed Telerik id. */
const REASON = (name: string) => name.replace(/:\s*$/, "").trim() === "reversal reason";
/** Splits the register export (rows as the runner gives them) into scope and data rows. */
export function registerRows(lines: ReadonlyArray<readonly string[]>): { scope: Record<string, string>; rows: W1RegisterRow[]; unreadable: number; layout: "rei" | "labelled" | null; period: W1DateWindow | null; reversalsRead: boolean } {
  const scope: Record<string, string> = {}; const rows: W1RegisterRow[] = []; let unreadable = 0; let period: W1DateWindow | null = null;
  let header: string[] | null = null; let layout: "rei" | "labelled" | null = null;
  let cols: { date: string[]; receipt: string[]; amount: string[]; also?: string[]; tenant: string[]; reference?: string[] } = { date: [], receipt: [], amount: [], tenant: [] };
  for (const [line, raw] of lines.entries()) {
    const cells = cellsOf(raw);
    if (!cells) { if (header) unreadable += 1; continue; }
    const lower = cells.map(cell => cell.replace(/^﻿/, "").trim().toLowerCase());
    if (!header) {
      if (["reference1", "surname1", "authority1", "textbox6"].every(name => lower.includes(name))) {
        header = lower; layout = "rei"; cols = { date: ["reference1"], receipt: ["surname1"], amount: ["authority1"], also: ["intrust1"], tenant: ["textbox6"] }; continue;
      }
      if (lower.includes("date") && lower.includes("rec no") && lower.includes("received from") && (lower.includes("total") || lower.includes("direct credit"))) {
        header = lower; layout = "rei"; cols = { date: ["date"], receipt: ["rec no"], amount: lower.includes("total") ? ["total"] : ["direct credit"], tenant: ["received from"] }; continue;
      }
      if (lower.includes("date") && lower.includes("reference") && lower.includes("amount")) {
        header = lower; layout = "labelled"; cols = { date: ["date"], receipt: ["receipt id", "receipt no", "receipt"], amount: ["amount"], tenant: TENANT, reference: ["reference"] }; continue;
      }
      for (const cell of cells) period ??= captionPeriod(cell);
      if (cells.length >= 2 && lower[0] !== "scope") scope[lower[0]] = cells[1].trim();
      continue;
    }
    if (cells.every(cell => !cell.trim())) continue;
    const at = (names: string[] | undefined) => { const i = names ? header!.findIndex(name => names.includes(name)) : -1; const value = i < 0 ? undefined : cells[i]?.trim(); return value ? value : null; };
    const hasStatus = header.includes("status");
    const reason = header.findIndex(REASON);
    if (layout === "labelled") {
      if (lower[0] === "total") continue;
      const row: W1RegisterRow = { line, receiptId: at(cols.receipt), date: isoDate(at(cols.date)), reference: at(cols.reference) ?? "", amountCents: amountCents(at(cols.amount)),
        tenant: at(cols.tenant), tenantId: at(TENANT_ID), status: at(["status"]) };
      if (row.amountCents === null || row.date === null || !CLEAN(row.reference)) { unreadable += 1; continue; }
      rows.push(row);
      continue;
    }
    // REI: a totals line has no date and no receipt number.
    if (!at(cols.date) && !at(cols.receipt) && lower.some(cell => /^total:?$/.test(cell))) continue;
    const amount = amountCents(at(cols.amount)), also = at(cols.also);
    const row: W1RegisterRow = { line, receiptId: at(cols.receipt), date: isoDate(at(cols.date)), reference: "", amountCents: amount,
      tenant: at(cols.tenant), tenantId: null, status: hasStatus ? at(["status"]) : reason >= 0 && cells[reason]?.trim() ? "Reversed" : "Receipted" };
    if (row.date === null || amount === null || !row.receiptId || !/^\d+$/.test(row.receiptId) || (also !== null && amountCents(also) !== amount)) { unreadable += 1; continue; }
    rows.push(row);
  }
  const reversalsRead = layout === "labelled" || (!!header && (header.includes("status") || header.some(REASON)));
  return { scope, rows, unreadable, layout, period, reversalsRead };
}

/** The next weekday after a YYYY-MM-DD date. */
function nextBusinessDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  do day.setUTCDate(day.getUTCDate() + 1); while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}
// ponytail: weekends only; public holidays push REI's date two business days out and then the row stays pending. Add the office's holiday calendar if that shows up live.
const sameDay = (bankDate: string, shown: string | null) => shown === bankDate || shown === nextBusinessDay(bankDate);
const NAME_NOISE = new Set(["PTY", "LTD", "LIMITED", "INC", "CO", "THE", "AND", "ATF", "MR", "MRS", "MS", "MISS", "DR"]);
/** Surname tokens: the words before the first comma ("Surname, Firstname", "A & B, C & D"), else the last word ("Firstname Surname"). */
function surnames(name: string): Set<string> {
  const text = CLEAN(name).replace(/['’]/g, "");
  const words = (part: string) => part.split(/[^A-Z0-9]+/).filter(word => word && !NAME_NOISE.has(word));
  const comma = text.indexOf(",");
  if (comma >= 0) return new Set(words(text.slice(0, comma)));
  const all = words(text);
  return new Set(all.slice(-1));
}
// ponytail: surname-token overlap; a payer who is not the tenant (a parent, an agency) stays pending. Match on REI's tenant id if a later export shows one.
const samePayer = (tenant: string, payer: string | null) => { if (payer === null) return false; const theirs = surnames(payer); return [...surnames(tenant)].some(word => theirs.has(word)); };

const receiptKey = (row: W1RegisterRow) => row.receiptId ? `id:${CLEAN(row.receiptId)}` : `row:${row.date}|${CLEAN(row.reference)}|${row.amountCents}|${CLEAN(row.tenantId ?? row.tenant ?? "")}`;
const validWindow = (window: W1DateWindow | undefined | null): window is W1DateWindow => !!window && isoDate(window.from) === window.from && isoDate(window.to) === window.to && window.from <= window.to;
const money = (cents: number | null) => cents === null ? "an unreadable amount" : (cents / 100).toFixed(2);
const label = (row: W1RegisterRow) => row.reference || `receipt ${row.receiptId ?? `on line ${row.line + 1}`}`;

function readRegister(lines: ReadonlyArray<readonly string[]>, destination: W1Destination, window: W1DateWindow | undefined, evidence: W1RegisterEvidence) {
  const { scope: fileScope, rows, unreadable, layout, period: caption, reversalsRead } = registerRows(lines);
  const warnings: W1PreviewWarning[] = [];
  // The file's business code decides; a reicid shown beside it must equal a saved one. A file that names no business is
  // verified only by both of the runner's page checks for this destination. Any other account named anywhere is a mismatch.
  const page = evidence.pageScope;
  const pageChecked = !!page && page.marker === destination.marker && page.checkedBefore === true && page.checkedAfter === true;
  const other = (fileScope.business !== undefined && fileScope.business !== destination.marker) ||
    (fileScope.reicid !== undefined && destination.urlValue !== undefined && fileScope.reicid !== destination.urlValue) ||
    (page !== undefined && page.marker !== destination.marker);
  const scope: W1Readback["scope"] = other ? "mismatch" : fileScope.business === destination.marker || (fileScope.business === undefined && pageChecked) ? "verified" : "absent";
  if (scope === "mismatch") warnings.push({ code: "register-scope-mismatch", message: "The Receipt Register export is for a different account. Nothing is confirmed from it." });
  if (scope === "absent") warnings.push({ code: "register-scope-absent", message: "The Receipt Register export does not name its account, and the account was not checked on the page before and after the export. Confirm it in REI." });
  if (layout === null) warnings.push({ code: "register-layout-unknown", message: "The Receipt Register export's columns were not recognised." });
  if (unreadable) warnings.push({ code: "register-row-unreadable", message: `${unreadable} Receipt Register row${unreadable === 1 ? " is" : "s are"} unreadable.` });
  if (layout !== null && !reversalsRead) warnings.push({ code: "register-reversals-unread", message: "The Receipt Register export has no Reversal Reason column, so a reversal can't be ruled out. Check reversals in REI." });
  // The export's own period (scope lines, else REI's "For The Period" caption); without one, a period the host proves REI
  // applied, and then every row must fall inside it.
  const named = fileScope.from !== undefined || fileScope.to !== undefined;
  const from = isoDate(fileScope.from), to = isoDate(fileScope.to);
  const own = named ? (from !== null && to !== null ? { from, to } : null) : caption;
  const period = named || caption ? own : validWindow(evidence.exportPeriod) ? evidence.exportPeriod : null;
  const inside = named || caption !== null || !period || rows.every(row => row.date! >= period.from && row.date! <= period.to);
  const covers = validWindow(window) && validWindow(period) && period.from <= window.from && period.to >= window.to && inside;
  if (!covers) warnings.push({ code: "register-period-unproven", message: inside ? "The Receipt Register export does not show that it covers the whole date range." : "The Receipt Register export has receipts outside the period it was asked for." });
  // The baseline only lists receipt identities; reversals matter to the readback alone.
  return { rows, warnings, scope, layout, reversalsRead, registerComplete: scope === "verified" && layout !== null && !unreadable && covers };
}

/** The pre-upload register: refused unless it is account-scoped and complete for the window. */
export function registerBaseline(lines: ReadonlyArray<readonly string[]>, destination: W1Destination, window: W1DateWindow, evidence: W1RegisterEvidence = {}): W1RegisterBaseline {
  if (!validWindow(window)) throw new Error("Choose the Receipt Register dates to read.");
  const read = readRegister(lines, destination, window, evidence);
  if (!read.registerComplete) throw new Error(read.warnings.find(item => item.code !== "register-reversals-unread")?.message ?? "The Receipt Register export is incomplete.");
  return { kind: "w1-rei-register-baseline", destination: { ...(destination.urlValue !== undefined ? { urlValue: destination.urlValue } : {}), marker: destination.marker }, window: { ...window }, receipts: read.rows.map(receiptKey) };
}

export function classifyReadback(expected: readonly W1ExpectedRow[], lines: ReadonlyArray<readonly string[]>, destination: W1Destination,
  attribution: { window?: W1DateWindow; baseline?: W1RegisterBaseline } & W1RegisterEvidence = {}): W1Readback {
  assertExpectedRows(expected);
  const window = attribution.window ?? attribution.baseline?.window;
  const read = readRegister(lines, destination, window, attribution);
  const { rows, warnings, scope, layout } = read;
  const registerComplete = read.registerComplete && read.reversalsRead;
  const baseline = attribution.baseline;
  if (!baseline) warnings.push({ code: "register-baseline-absent", message: "There is no pre-upload Receipt Register to tell new receipts from older ones." });
  else if (baseline.destination.urlValue !== destination.urlValue || baseline.destination.marker !== destination.marker || !validWindow(window) || baseline.window.from > window.from)
    warnings.push({ code: "register-baseline-mismatch", message: "The pre-upload Receipt Register is for another account or does not cover this date range." });
  // Receipts the baseline already held, or dated outside the window, are history: never this batch.
  const before = new Map<string, number>();
  for (const key of baseline?.receipts ?? []) before.set(key, (before.get(key) ?? 0) + 1);
  const fresh: W1RegisterRow[] = [];
  /** Every receipt the baseline did not hold, whatever its date: the pool for proving absence. */
  const added: W1RegisterRow[] = [];
  for (const row of rows) {
    const key = receiptKey(row), held = before.get(key) ?? 0;
    if (held > 0) { before.set(key, held - 1); continue; }
    added.push(row);
    if (validWindow(window) && (row.date! < window.from || row.date! > window.to)) continue;
    fresh.push(row);
  }
  const byReference = layout === "labelled";
  /** Could this register row be this batch row at all (for absence and duplicates)? */
  const related = (row: W1ExpectedRow, item: W1RegisterRow) => byReference ? same(row, item) : item.amountCents === row.amountCents && sameDay(row.date, item.date);
  const left = new Set(fresh.map(row => row.line));
  const outcomes: W1Readback["outcomes"] = [];
  const settle = (row: W1ExpectedRow, found: W1RegisterRow) => {
    left.delete(found.line);
    const status = found.status ?? "";
    if (REJECTED.test(status)) outcomes.push({ rowId: row.rowId, outcome: "rejected", register: found });
    else if (ACCEPTED.test(status)) outcomes.push({ rowId: row.rowId, outcome: "accepted", register: found });
    else { outcomes.push({ rowId: row.rowId, outcome: "pending", register: found }); warnings.push({ code: "register-status-unknown", message: `The register shows ${row.reference} ${status ? `as ${status}` : "without a status"}.`, rowId: row.rowId }); }
  };
  if (byReference) {
    for (const row of expected) {
      // A receipt's register date can differ from the bank date: reference + amount + tenant identify it, one register row per batch row.
      const candidates = fresh.filter(item => left.has(item.line) && same(row, item) && item.amountCents === row.amountCents && sameTenant(row, item));
      const found = candidates.find(item => item.date === row.date) ?? candidates[0];
      if (found) { settle(row, found); continue; }
      outcomes.push({ rowId: row.rowId, outcome: "pending" });
      if (fresh.some(item => left.has(item.line) && same(row, item) && item.amountCents === row.amountCents))
        warnings.push({ code: "register-tenant-differs", message: `The register has ${row.reference} for another or no tenant.`, rowId: row.rowId });
    }
  } else {
    // No reference: date (or the next business day) + exact amount + the payer's surname. Exactly one candidate,
    // claimed by no other batch row, or the row stays pending.
    const candidates = expected.map(row => fresh.filter(item => item.amountCents === row.amountCents && sameDay(row.date, item.date) && samePayer(row.tenant, item.tenant)));
    const claims = new Map<number, number>();
    for (const list of candidates) for (const item of list) claims.set(item.line, (claims.get(item.line) ?? 0) + 1);
    for (const [index, row] of expected.entries()) {
      const list = candidates[index];
      if (list.length === 1 && claims.get(list[0].line) === 1) { settle(row, list[0]); continue; }
      outcomes.push({ rowId: row.rowId, outcome: "pending" });
      if (list.length) warnings.push({ code: "register-match-ambiguous", message: `More than one receipt in the register could be ${row.reference} (${money(row.amountCents)} on ${row.date}). Check it in REI.`, rowId: row.rowId });
      else if (fresh.some(item => related(row, item)))
        warnings.push({ code: "register-tenant-differs", message: `The register has ${money(row.amountCents)} on ${row.date} from another payer than ${row.tenant}.`, rowId: row.rowId });
    }
  }
  const unclaimed = fresh.filter(row => left.has(row.line));
  // A related register row left over may be a second import of the same receipt.
  for (const row of unclaimed) if (expected.some(item => related(item, row) && (byReference || samePayer(item.tenant, row.tenant))))
    warnings.push({ code: "register-possible-duplicate", message: `The register has another ${label(row)} receipt (${money(row.amountCents)}) that is not in this batch.` });
  if (scope === "mismatch") for (const outcome of outcomes) { outcome.outcome = "pending"; delete outcome.register; }
  const count = (kind: W1RowOutcome) => outcomes.filter(item => item.outcome === kind).length;
  const accepted = count("accepted");
  // Absence ignores dates and payers: REI can date a receipt days later (a holiday, later posting), and calling a receipt
  // absent that did land would let a retry import it twice. Any new receipt in the export with a batch row's amount (or,
  // with references, its reference) holds it. Without a baseline every such receipt in the export counts as present.
  const absent = registerComplete && !added.some(row => expected.some(item => byReference ? same(item, row) : item.amountCents === row.amountCents));
  return { kind: "w1-rei-readback", scope, registerComplete, absent, outcomes, accepted, rejected: count("rejected"), pending: count("pending"), unclaimed, historical: rows.length - fresh.length, warnings,
    complete: scope === "verified" && registerComplete && !!baseline && accepted === expected.length && !warnings.length };
}
