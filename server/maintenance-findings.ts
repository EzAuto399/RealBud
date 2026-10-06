// W4 maintenance findings (docs/SHERRY-WORKFLOWS-BUILD-PLAN-2026-10-02.md).
// Pure: no I/O, no clock, no model. Input is saved invoice records whose supplierRef
// was already resolved by the supplier-directory matcher; output is the two
// independent finding kinds Sherry reviews.
import { createHash } from "node:crypto";

/** "unverified": in the supplier list, but Gmail did not confirm the From domain, so it could be forged. */
export type SenderMatch = "listed" | "unlisted" | "conflict" | "unverified";

export interface MaintenanceInvoice {
  sourceId: string;
  propertyId: string;
  supplierRef: string | null;
  senderEmail: string;
  senderMatch: SenderMatch;
  invoiceNumber: string | null;
  invoiceVersion: string | null;
  invoiceDate: string | null; // YYYY-MM-DD
  receivedDate: string; // YYYY-MM-DD
  amountCents: number | null;
  description: string;
  /** How the sender was read, e.g. "Sent via Xero for a@b.example." Shown as a finding note. */
  senderNote?: string;
}

export interface MaintenanceCoverage {
  from: string;
  to: string;
  complete: boolean;
}

export interface MaintenanceWindowRule {
  basis: "invoiceDate" | "receivedDate";
  span: "calendarMonth" | "rolling30";
}

// Pending Sherry's confirmation: the build plan only suggests invoice date and has not
// settled calendar month versus rolling 30 days. Keep this a setting, not a fact.
export const DEFAULT_WINDOW_RULE: MaintenanceWindowRule = { basis: "invoiceDate", span: "calendarMonth" };

export interface FindingInvoice {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  receivedDate: string; // earliest copy
  amountsCents: number[]; // one amount normally; several only when unresolvedRevision
  description: string;
  sourceIds: string[]; // every copy, reminder and forward of this invoice
  unresolvedRevision: boolean;
}

export type SenderReason = "unlisted-sender" | "conflicting-sender" | "supplier-unresolved" | "unverified-sender";

interface FindingBase {
  id: string;
  evidenceVersion: string;
  propertyId: string;
  invoices: FindingInvoice[];
  notes: string[];
}

export interface SenderVerificationFinding extends FindingBase {
  kind: "sender-verification";
  senderEmail: string;
  supplierRef: string | null;
  reasons: SenderReason[];
}

export interface MultipleInvoicesFinding extends FindingBase {
  kind: "multiple-invoices";
  supplierRef: string;
  windowKey: string;
  windowStart: string;
  windowEnd: string;
}

export type MaintenanceFinding = SenderVerificationFinding | MultipleInvoicesFinding;

export interface MaintenanceFindingsInput {
  invoices: MaintenanceInvoice[];
  coverage: MaintenanceCoverage;
  rule?: MaintenanceWindowRule;
}

interface Entry {
  key: string;
  records: MaintenanceInvoice[];
  view: FindingInvoice;
  date: string; // window date under the chosen basis
  dateFallback: boolean; // invoice-date basis but no invoice date on any copy
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareVersion = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const DAY_MS = 86_400_000;

function assertDate(value: string, sourceId: string): void {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invoice ${sourceId} has a date that is not a real YYYY-MM-DD day.`);
  }
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const distinctAmounts = (records: MaintenanceInvoice[]) =>
  [...new Set(records.map((r) => r.amountCents).filter((a): a is number => a !== null))].sort((a, b) => a - b);

function numberKey(r: MaintenanceInvoice): string | null {
  const n = r.invoiceNumber?.trim().toUpperCase().replace(/\s+/g, "");
  return n ? `n:${n}` : null;
}

// Collapse copies, reminders and forwards (same property + supplier + invoice number) into one invoice.
function distinctInvoices(records: MaintenanceInvoice[], rule: MaintenanceWindowRule): Entry[] {
  const groups = new Map<string, MaintenanceInvoice[]>();
  const add = (key: string, r: MaintenanceInvoice) => {
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  };
  const unnumbered: MaintenanceInvoice[] = [];
  for (const r of [...records].sort((a, b) => byText(a.sourceId, b.sourceId))) {
    const key = numberKey(r);
    if (key) add(key, r);
    else unnumbered.push(r);
  }
  for (const r of unnumbered) {
    // ponytail: unnumbered invoices dedupe only on exact invoice date (else received date) + amount,
    // and attach to a numbered invoice only when exactly one matches both. A forward with a later
    // received date and no invoice date, or an unnumbered record with no amount, counts as its own
    // invoice (over-alerts rather than hides a charge). Upgrade: attachment-hash matching.
    if (r.amountCents === null) {
      add(`s:${r.sourceId}`, r);
      continue;
    }
    const date = r.invoiceDate ?? r.receivedDate;
    const numbered = [...groups].filter(
      ([key, list]) =>
        key.startsWith("n:") && list.some((x) => x.invoiceDate === r.invoiceDate && r.invoiceDate !== null && x.amountCents === r.amountCents),
    );
    add(numbered.length === 1 ? numbered[0][0] : `d:${date}:${r.amountCents}`, r);
  }
  return [...groups].map(([key, list]) => toEntry(key, list, rule));
}

function toEntry(key: string, records: MaintenanceInvoice[], rule: MaintenanceWindowRule): Entry {
  let amounts = distinctAmounts(records);
  let rep = records.find((r) => r.amountCents !== null) ?? records[0];
  let unresolvedRevision = false;
  if (amounts.length > 1) {
    // Different amounts under one invoice number: only a strictly newer labelled version resolves it.
    const versioned = records.filter((r) => r.invoiceVersion?.trim());
    const top = versioned.map((r) => r.invoiceVersion!.trim()).sort(compareVersion).at(-1);
    const topRecords = versioned.filter((r) => top !== undefined && compareVersion(r.invoiceVersion!.trim(), top) === 0);
    const topAmounts = distinctAmounts(topRecords);
    if (topAmounts.length === 1) {
      amounts = topAmounts;
      rep = topRecords.find((r) => r.amountCents === topAmounts[0])!;
    } else {
      unresolvedRevision = true;
    }
  }
  const windowDates = records.map((r) => (rule.basis === "invoiceDate" ? r.invoiceDate : r.receivedDate) ?? r.receivedDate);
  return {
    key,
    records,
    date: windowDates.sort(byText)[0],
    dateFallback: rule.basis === "invoiceDate" && records.every((r) => r.invoiceDate === null),
    view: {
      invoiceNumber: rep.invoiceNumber,
      invoiceDate: rep.invoiceDate ?? records.find((r) => r.invoiceDate)?.invoiceDate ?? null,
      receivedDate: records.map((r) => r.receivedDate).sort(byText)[0],
      amountsCents: amounts,
      description: rep.description,
      sourceIds: records.map((r) => r.sourceId),
      unresolvedRevision,
    },
  };
}

function windowsOf(entries: Entry[], rule: MaintenanceWindowRule) {
  const sorted = [...entries].sort((a, b) => byText(a.date, b.date) || byText(a.key, b.key));
  const windows: { start: string; end: string; entries: Entry[] }[] = [];
  for (const entry of sorted) {
    const last = windows.at(-1);
    if (last && entry.date <= last.end) {
      last.entries.push(entry);
      continue;
    }
    if (rule.span === "calendarMonth") {
      const [y, m] = entry.date.split("-").map(Number);
      const start = `${entry.date.slice(0, 7)}-01`;
      windows.push({ start, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), entries: [entry] });
    } else {
      // ponytail: rolling 30 days are greedy windows anchored at the earliest invoice, so the id stays
      // stable as later invoices arrive; an invoice arriving dated before the anchor starts a new id.
      windows.push({ start: entry.date, end: addDays(entry.date, 29), entries: [entry] });
    }
  }
  return windows;
}

const entryEvidence = (e: Entry) => [e.key, e.view.amountsCents, e.view.unresolvedRevision];

function sharedNotes(entries: Entry[], coverage: MaintenanceCoverage): string[] {
  const notes: string[] = [];
  if (!coverage.complete) {
    notes.push(`Mail history only covers ${coverage.from} to ${coverage.to}, so earlier invoices may be missing.`);
  }
  for (const e of entries) {
    if (e.dateFallback) notes.push(`No invoice date found on ${e.view.sourceIds.join(", ")}; the received date was used.`);
    for (const note of new Set(e.records.map((r) => r.senderNote).filter((n): n is string => !!n))) notes.push(note);
    if (e.view.unresolvedRevision) {
      notes.push(`Invoice ${e.view.invoiceNumber} appears with different amounts and no newer version; check which is current.`);
    }
  }
  return notes;
}

export function computeMaintenanceFindings(input: MaintenanceFindingsInput): MaintenanceFinding[] {
  const rule = input.rule ?? DEFAULT_WINDOW_RULE;
  for (const r of input.invoices) {
    assertDate(r.receivedDate, r.sourceId);
    if (r.invoiceDate !== null) assertDate(r.invoiceDate, r.sourceId);
  }

  // Different properties are never grouped; an unresolved supplier is its own scope.
  const scopes = new Map<string, MaintenanceInvoice[]>();
  for (const r of input.invoices) {
    const key = JSON.stringify([r.propertyId, r.supplierRef]);
    const list = scopes.get(key);
    if (list) list.push(r);
    else scopes.set(key, [r]);
  }

  const findings: MaintenanceFinding[] = [];
  for (const records of scopes.values()) {
    const { propertyId, supplierRef } = records[0];
    const entries = distinctInvoices(records, rule);

    for (const entry of entries) {
      const bySender = new Map<string, SenderReason[]>();
      for (const r of entry.records) {
        const reasons: SenderReason[] = [];
        if (r.senderMatch === "unlisted") reasons.push("unlisted-sender");
        if (r.senderMatch === "conflict") reasons.push("conflicting-sender");
        if (r.senderMatch === "unverified") reasons.push("unverified-sender");
        if (supplierRef === null) reasons.push("supplier-unresolved");
        if (!reasons.length) continue;
        const sender = r.senderEmail.trim().toLowerCase();
        bySender.set(sender, [...new Set([...(bySender.get(sender) ?? []), ...reasons])].sort(byText) as SenderReason[]);
      }
      for (const [senderEmail, reasons] of bySender) {
        const notes = sharedNotes([entry], input.coverage);
        if (supplierRef === null) {
          notes.push("Supplier not matched yet, so this invoice was not compared with others from the same supplier.");
        }
        findings.push({
          kind: "sender-verification",
          id: hash(["sender-verification", propertyId, supplierRef, senderEmail, entry.key]),
          evidenceVersion: hash([entryEvidence(entry), reasons]),
          propertyId,
          supplierRef,
          senderEmail,
          reasons,
          invoices: [entry.view],
          notes,
        });
      }
    }

    if (supplierRef === null) continue;
    for (const w of windowsOf(entries, rule)) {
      if (w.entries.length < 2) continue;
      const windowKey = `${rule.basis}/${rule.span}/${w.start}`;
      findings.push({
        kind: "multiple-invoices",
        id: hash(["multiple-invoices", propertyId, supplierRef, windowKey]),
        evidenceVersion: hash(w.entries.map(entryEvidence).sort((a, b) => byText(String(a[0]), String(b[0])))),
        propertyId,
        supplierRef,
        windowKey,
        windowStart: w.start,
        windowEnd: w.end,
        invoices: w.entries.map((e) => e.view),
        notes: sharedNotes(w.entries, input.coverage),
      });
    }
  }
  return findings.sort((a, b) => byText(a.kind, b.kind) || byText(a.id, b.id));
}

/** Findings Sherry has not been notified about at this evidence version (notify once). */
export function newOrChanged(findings: MaintenanceFinding[], seen: Map<string, string>): MaintenanceFinding[] {
  return findings.filter((f) => seen.get(f.id) !== f.evidenceVersion);
}
