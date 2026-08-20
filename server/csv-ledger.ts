// Read-only PMS/ledger CSV. Strict types — a bad cell rejects the batch.
// Fixture CSVs keep `propertyId`. Live exports may key by address or property code.
import { asFiniteInteger, asNonEmptyString, asNullableNumber } from "./decode.ts";
import type { LedgerFacts, Property } from "../shared/contracts.ts";

export interface CsvBatch {
  sourceId: string;
  observedAt: number;
  rows: LedgerFacts[];
}

export type ExportIdentityKind = "id" | "address" | "code";

export interface ExportIdentity {
  kind: ExportIdentityKind;
  value: string;
}

export interface ExportRow {
  identity: ExportIdentity;
  daysSinceDue: number;
  rentLanded: boolean;
  levyPaid: boolean;
  daysSinceCourtesy: number | null;
  amountPaidCents: number | null;
  reversed: boolean;
}

export interface PmsExportBatch {
  sourceId: string;
  observedAt: number;
  rows: ExportRow[];
}

export type MatchOk = { ok: true; propertyId: string };
export type MatchFail = { ok: false; reason: "unmatched" } | { ok: false; reason: "ambiguous"; ids: string[] };
export type MatchResult = MatchOk | MatchFail;

export type ResolvedExport =
  | { ok: true; matched: LedgerFacts[]; unmatched: ExportRow[] }
  | { ok: false; reason: "ambiguous"; message: string };

const STREET: Record<string, string> = {
  street: "st",
  st: "st",
  road: "rd",
  rd: "rd",
  avenue: "ave",
  ave: "ave",
  close: "cl",
  cl: "cl",
  drive: "dr",
  dr: "dr",
  place: "pl",
  pl: "pl",
};

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_-]+/g, "");
}

function pickHeader(headers: string[], aliases: string[]): string | null {
  const wanted = new Set(aliases.map(normHeader));
  return headers.find((h) => wanted.has(normHeader(h))) ?? null;
}

/** Quoted CSV (RFC 4180-ish). Addresses often contain commas. */
export function parseCsvTable(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (quoted) throw Object.assign(new Error("csv has an unclosed quote"), { status: 400 });
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((c) => c.trim())) rows.push(row);
  }
  return rows;
}

function parseBoolCell(raw: string, field: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw Object.assign(new Error(`${field} must be true or false`), { status: 400, field });
}

function cell(rec: Record<string, string>, key: string | null): string {
  if (!key) return "";
  return rec[key] ?? rec[key.toLowerCase()] ?? "";
}

export function normalizeAddress(value: string): string {
  const words = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET[w] ?? w);
  return words.join(" ");
}

export function matchExportRow(properties: Pick<Property, "id" | "address">[], row: ExportRow): MatchResult {
  const hits: string[] = [];
  for (const property of properties) {
    if (row.identity.kind === "id" || row.identity.kind === "code") {
      if (property.id.toLowerCase() === row.identity.value.trim().toLowerCase()) hits.push(property.id);
    } else if (normalizeAddress(property.address) === normalizeAddress(row.identity.value)) {
      hits.push(property.id);
    }
  }
  const unique = [...new Set(hits)];
  if (unique.length === 1) return { ok: true, propertyId: unique[0]! };
  if (unique.length > 1) return { ok: false, reason: "ambiguous", ids: unique };
  return { ok: false, reason: "unmatched" };
}

export function resolveExportRows(properties: Pick<Property, "id" | "address">[], rows: ExportRow[]): ResolvedExport {
  const matched: LedgerFacts[] = [];
  const unmatched: ExportRow[] = [];
  for (const row of rows) {
    const hit = matchExportRow(properties, row);
    if (!hit.ok && hit.reason === "ambiguous") {
      return {
        ok: false,
        reason: "ambiguous",
        message: `csv row matches ${hit.ids.length} properties equally (${hit.ids.join(", ")})`,
      };
    }
    if (!hit.ok) {
      unmatched.push(row);
      continue;
    }
    matched.push({
      propertyId: hit.propertyId,
      daysSinceDue: row.daysSinceDue,
      rentLanded: row.rentLanded,
      levyPaid: row.levyPaid,
      daysSinceCourtesy: row.daysSinceCourtesy,
      amountPaidCents: row.amountPaidCents,
      reversed: row.reversed,
    });
  }
  return { ok: true, matched, unmatched };
}

export function parsePmsExport(text: string, observedAt: number, sourceId = "src-csv"): PmsExportBatch {
  const table = parseCsvTable(text);
  if (table.length < 2) {
    throw Object.assign(new Error("csv batch is empty"), { status: 400 });
  }
  const headers = table[0]!.map((h) => h.trim());
  const idCol = pickHeader(headers, ["propertyId", "property_id", "id"]);
  const addressCol = pickHeader(headers, ["address", "propertyAddress", "property_address", "property address"]);
  const codeCol = pickHeader(headers, ["propertyCode", "property_code", "code", "property code"]);
  const daysCol = pickHeader(headers, ["daysSinceDue", "daysLate", "days_late", "days late", "daysOverdue", "days overdue"]);
  const rentCol = pickHeader(headers, ["rentLanded", "rent_landed", "rentPaid", "rent_paid", "rentIn", "rent in"]);
  const levyCol = pickHeader(headers, ["levyPaid", "levy_paid"]);
  if (!idCol && !addressCol && !codeCol) {
    throw Object.assign(new Error("csv missing column propertyId"), { status: 400 });
  }
  if (!daysCol) throw Object.assign(new Error("csv missing column daysSinceDue"), { status: 400 });
  if (!rentCol) throw Object.assign(new Error("csv missing column rentLanded"), { status: 400 });
  if (!levyCol) throw Object.assign(new Error("csv missing column levyPaid"), { status: 400 });
  const courtesyCol = pickHeader(headers, ["daysSinceCourtesy", "days_since_courtesy"]);
  const amountCol = pickHeader(headers, ["amountPaidCents", "amount_paid_cents"]);
  const reversedCol = pickHeader(headers, ["reversed"]);

  const rows: ExportRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cols = table[i]!;
    if (cols.length !== headers.length) {
      throw Object.assign(new Error(`csv row ${i} is incomplete`), { status: 400 });
    }
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => {
      rec[h] = cols[idx] ?? "";
    });
    let identity: ExportIdentity;
    const idVal = cell(rec, idCol).trim();
    const codeVal = cell(rec, codeCol).trim();
    const addressVal = cell(rec, addressCol).trim();
    if (idCol) identity = { kind: "id", value: asNonEmptyString(idVal, "propertyId") };
    else if (codeCol) identity = { kind: "code", value: asNonEmptyString(codeVal, "propertyCode") };
    else identity = { kind: "address", value: asNonEmptyString(addressVal, "address") };

    const daysRaw = cell(rec, daysCol).trim();
    if (!daysRaw) throw Object.assign(new Error("daysSinceDue is missing"), { status: 400, field: "daysSinceDue" });
    const daysSinceDue = asFiniteInteger(Number(daysRaw), "daysSinceDue");
    const rentLanded = parseBoolCell(cell(rec, rentCol), "rentLanded");
    const levyPaid = parseBoolCell(cell(rec, levyCol), "levyPaid");
    const courtesyRaw = cell(rec, courtesyCol).trim();
    const daysSinceCourtesy =
      courtesyRaw === "" || courtesyRaw === "null" ? null : asNullableNumber(Number(courtesyRaw), "daysSinceCourtesy");
    const amountRaw = cell(rec, amountCol).trim();
    const amountPaidCents = amountRaw === "" ? null : asFiniteInteger(Number(amountRaw), "amountPaidCents");
    const reversedRaw = cell(rec, reversedCol).trim();
    const reversed = reversedRaw === "" ? false : parseBoolCell(reversedRaw, "reversed");
    rows.push({ identity, daysSinceDue, rentLanded, levyPaid, daysSinceCourtesy, amountPaidCents, reversed });
  }
  if (!rows.length) throw Object.assign(new Error("csv batch has no rows"), { status: 400 });
  return { sourceId, observedAt, rows };
}

/** Fixture-shaped import: identity becomes `propertyId` (unmatched until Desk maps it). */
export function parseLedgerCsv(text: string, observedAt: number, sourceId = "src-csv"): CsvBatch {
  const batch = parsePmsExport(text, observedAt, sourceId);
  return {
    sourceId: batch.sourceId,
    observedAt: batch.observedAt,
    rows: batch.rows.map((row) => ({
      propertyId: row.identity.value,
      daysSinceDue: row.daysSinceDue,
      rentLanded: row.rentLanded,
      levyPaid: row.levyPaid,
      daysSinceCourtesy: row.daysSinceCourtesy,
      amountPaidCents: row.amountPaidCents,
      reversed: row.reversed,
    })),
  };
}

export { asBoolean } from "./decode.ts";
