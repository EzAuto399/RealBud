// Deterministic inspection of the bytes the person selected. No filesystem,
// shell, model, property mapping or book mutation is part of this operation.
import { createHash } from "node:crypto";
import { parseCsvTable } from "./csv-ledger.ts";
import { redactSecretsInText } from "./redact.ts";

export const ASK_CSV_REPORT_SUFFIX = ".inspection.json";
export const ASK_CSV_MAX_BYTES = 750 * 1024;
const MAX_RECORDS = 20_001; // header plus data, including blank records
const MAX_COLUMNS = 64;
const MAX_HEADER_CHARS = 128;
const ISSUE_ROW_SAMPLE = 20;

type InspectionFailure = { status: "invalid" | "unsupported"; reason: string };
const refuse = (status: InspectionFailure["status"], reason: string): never => { throw { status, reason }; };

/** The ledger parser deliberately tolerates legacy exports. Before using it
 * for an exact count, reject malformed quoting and bound its table allocation.
 * Quoted line breaks belong to a cell, not another data record. */
function validateCsv(text: string): number {
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let records = 0, columns = 1, rowStarted = false;
  const record = () => {
    if (++records > MAX_RECORDS) refuse("unsupported", "CSV exceeds the 20,001-record inspection limit, including the header and blank records.");
    columns = 1; state = "start"; rowStarted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (state === "quoted") {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else state = "closed";
      }
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record(); continue;
    }
    rowStarted = true;
    if (ch === ",") {
      if (++columns > MAX_COLUMNS) refuse("unsupported", "CSV exceeds the 64-column inspection limit.");
      state = "start"; continue;
    }
    if (state === "closed") refuse("invalid", "CSV has text after a closing quote. No exact row count is available.");
    if (ch === '"') {
      if (state !== "start") refuse("invalid", "CSV has a quote inside an unquoted field. No exact row count is available.");
      state = "quoted";
    } else state = "plain";
  }
  if (state === "quoted") refuse("invalid", "CSV has an unclosed quote. No exact row count is available.");
  if (rowStarted) record();
  return records;
}

export function inspectAskCsv(name: string, bytes: Buffer) {
  const base = {
    version: 1 as const,
    kind: "selected-csv-inspection" as const,
    source: { name: redactSecretsInText(name), sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, basis: "selected-upload-bytes" },
    propertyBookChanged: false,
    meaning: "This report describes the selected upload snapshot only. Data rows are not a verified property count. No fields, identities or mappings have been accepted into the book; source dates and freshness are unverified.",
    conventions: {
      format: "UTF-8 comma-separated CSV; first nonblank record is the header",
      dataRows: "Excludes the header and records whose fields are all whitespace; includes rows with an unexpected field count. Quoted line breaks do not create extra rows.",
      duplicateRows: "Repeated nonblank data rows after the first, comparing exact parsed field strings",
      columnValues: "Trimmed, case-sensitive strings; leading zeros retained. Missing values include absent cells. Duplicate values count nonempty occurrences after the first, not distinct duplicate groups.",
      issueRowNumbers: "One-based nonblank data rows, excluding the header",
    },
  };
  try {
    if (bytes.length > ASK_CSV_MAX_BYTES) refuse("unsupported", "CSV exceeds the 750 KB inspection limit. The original remains available; no partial count is reported.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
    catch { return { ...base, status: "unsupported" as const, coverageComplete: false, reason: "CSV is not valid UTF-8. No exact row count is available.", counts: null, columns: [] }; }
    if (text.includes("\0")) refuse("unsupported", "CSV contains null bytes or an unsupported encoding. No exact row count is available.");
    const records = validateCsv(text);
    const table = parseCsvTable(text);
    const headers = table[0]?.map(value => value.trim());
    if (!headers) refuse("invalid", "CSV has no nonblank header record. No data row count is available.");
    if (headers.some(header => header.length > MAX_HEADER_CHARS)) refuse("unsupported", "CSV has a header longer than 128 characters. No partial inspection is reported.");
    if (headers.length === 1 && /[;\t]/.test(headers[0]!)) refuse("unsupported", "This inspection supports comma-separated CSV only; the header appears to use another delimiter.");
    const rows = table.slice(1);
    const seenRows = new Set<string>(), seenHeaders = new Set<string>();
    let duplicateRows = 0, duplicateHeaders = 0, blankHeaders = 0, unevenRows = 0;
    const unevenRowSample: number[] = [];
    for (const header of headers) {
      if (!header) blankHeaders++;
      else if (seenHeaders.has(header)) duplicateHeaders++;
      else seenHeaders.add(header);
    }
    rows.forEach((row, i) => {
      if (row.length !== headers.length) {
        unevenRows++;
        if (unevenRowSample.length < ISSUE_ROW_SAMPLE) unevenRowSample.push(i + 1);
      }
      const key = JSON.stringify(row);
      if (seenRows.has(key)) duplicateRows++;
      else seenRows.add(key);
    });
    const columns = headers.map((header, index) => {
      const seen = new Set<string>();
      let missingValues = 0, duplicateValues = 0;
      for (const row of rows) {
        const value = (row[index] ?? "").trim();
        if (!value) missingValues++;
        else if (seen.has(value)) duplicateValues++;
        else seen.add(value);
      }
      const shown = redactSecretsInText(header);
      return { column: index + 1, header: shown, headerRedacted: shown !== header, missingValues, duplicateValues, distinctNonemptyValues: seen.size };
    });
    return {
      ...base,
      status: unevenRows || blankHeaders || duplicateHeaders || columns.some(column => column.headerRedacted) ? "needs-review" as const : "complete" as const,
      coverageComplete: true,
      counts: { dataRows: rows.length, columns: headers.length, blankRecords: records - table.length, duplicateRows, blankHeaders, duplicateHeaders, unevenRows },
      unevenRowSample,
      unevenRowSampleComplete: unevenRows <= ISSUE_ROW_SAMPLE,
      columns,
    };
  } catch (error) {
    const failure = error as InspectionFailure;
    if (failure.status !== "invalid" && failure.status !== "unsupported") throw error;
    return { ...base, ...failure, coverageComplete: false, counts: null, columns: [] };
  }
}
