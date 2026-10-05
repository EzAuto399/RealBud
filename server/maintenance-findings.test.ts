import { describe, expect, it } from "vitest";

import {
  computeMaintenanceFindings,
  newOrChanged,
  type MaintenanceCoverage,
  type MaintenanceFinding,
  type MaintenanceInvoice,
  type MultipleInvoicesFinding,
  type SenderVerificationFinding,
} from "./maintenance-findings.ts";

const FULL: MaintenanceCoverage = { from: "2026-07-01", to: "2026-09-30", complete: true };

let seq = 0;
function invoice(over: Partial<MaintenanceInvoice> = {}): MaintenanceInvoice {
  seq += 1;
  return {
    sourceId: `fictional-msg-${seq}`,
    propertyId: "fictional-prop-1",
    supplierRef: "FICT-PLUMB",
    senderEmail: "accounts@fictional-plumbing.test",
    senderMatch: "listed",
    invoiceNumber: `INV-${seq}`,
    invoiceVersion: null,
    invoiceDate: "2026-09-03",
    receivedDate: "2026-09-04",
    amountCents: 22_000,
    description: "Replace hot water tap washer",
    ...over,
  };
}

const run = (invoices: MaintenanceInvoice[], extra: Partial<Parameters<typeof computeMaintenanceFindings>[0]> = {}) =>
  computeMaintenanceFindings({ invoices, coverage: FULL, ...extra });
const multiples = (f: MaintenanceFinding[]) => f.filter((x): x is MultipleInvoicesFinding => x.kind === "multiple-invoices");
const senders = (f: MaintenanceFinding[]) => f.filter((x): x is SenderVerificationFinding => x.kind === "sender-verification");
const seenFrom = (f: MaintenanceFinding[]) => new Map(f.map((x) => [x.id, x.evidenceVersion]));

describe("computeMaintenanceFindings", () => {
  it("raises nothing for a single invoice from a listed sender mapped to its supplier", () => {
    expect(run([invoice()])).toEqual([]);
  });

  it("flags an unlisted sender for verification even with one invoice, never as fraud", () => {
    const [finding, ...rest] = run([invoice({ senderEmail: "Billing@New-Fictional.test", senderMatch: "unlisted" })]);
    expect(rest).toEqual([]);
    expect(finding.kind).toBe("sender-verification");
    const sv = finding as SenderVerificationFinding;
    expect(sv.reasons).toEqual(["unlisted-sender"]);
    expect(sv.senderEmail).toBe("billing@new-fictional.test");
    expect(JSON.stringify(finding).toLowerCase()).not.toContain("fraud");
  });

  it("flags a conflicting sender", () => {
    expect(senders(run([invoice({ senderMatch: "conflict" })]))[0].reasons).toEqual(["conflicting-sender"]);
  });

  it("compares two distinct invoices in one month even when the sender is approved, keeping unrelated work distinguishable", () => {
    const a = invoice({ invoiceDate: "2026-09-03", amountCents: 22_000, description: "Replace hot water tap washer" });
    const b = invoice({ invoiceDate: "2026-09-21", amountCents: 48_500, description: "Clear blocked stormwater drain" });
    const findings = run([a, b]);
    expect(senders(findings)).toEqual([]);
    const [m] = multiples(findings);
    expect(multiples(findings)).toHaveLength(1);
    expect(m).toMatchObject({ propertyId: "fictional-prop-1", supplierRef: "FICT-PLUMB", windowStart: "2026-09-01", windowEnd: "2026-09-30" });
    expect(m.invoices.map((i) => [i.invoiceDate, i.amountsCents, i.description, i.sourceIds])).toEqual([
      ["2026-09-03", [22_000], "Replace hot water tap washer", [a.sourceId]],
      ["2026-09-21", [48_500], "Clear blocked stormwater drain", [b.sourceId]],
    ]);
    expect(m.notes).toEqual([]);
  });

  it("raises both findings independently for one unlisted invoice that is also the second that month", () => {
    const findings = run([invoice(), invoice({ invoiceDate: "2026-09-10", senderMatch: "unlisted", senderEmail: "x@fictional.test" })]);
    expect(multiples(findings)).toHaveLength(1);
    expect(senders(findings)).toHaveLength(1);
  });

  it("never groups invoices for different properties", () => {
    expect(run([invoice({ propertyId: "fictional-prop-1" }), invoice({ propertyId: "fictional-prop-2" })])).toEqual([]);
  });

  it("does not count a forwarded copy or a reminder of the same invoice twice", () => {
    const original = invoice({ invoiceNumber: "INV-500" });
    const forward = { ...original, sourceId: "fictional-fwd", receivedDate: "2026-09-08", senderEmail: "sherry@fictional-agency.test", senderMatch: "listed" as const };
    const reminder = { ...original, sourceId: "fictional-reminder", invoiceNumber: " inv-500 ", receivedDate: "2026-09-25" };
    expect(run([original, forward, reminder])).toEqual([]);
    const withSecond = run([original, forward, reminder, invoice({ invoiceDate: "2026-09-15" })]);
    const [m] = multiples(withSecond);
    expect(m.invoices).toHaveLength(2);
    expect(m.invoices[0].sourceIds.sort()).toEqual([original.sourceId, "fictional-fwd", "fictional-reminder"].sort());
  });

  it("creates no new alert on rerun, nor when a later copy arrives", () => {
    const a = invoice();
    const b = invoice({ invoiceDate: "2026-09-12" });
    const first = run([a, b]);
    expect(newOrChanged(first, new Map())).toHaveLength(1);
    const seen = seenFrom(first);
    expect(run([b, a])).toEqual(first);
    expect(newOrChanged(run([b, a]), seen)).toEqual([]);
    expect(newOrChanged(run([a, b, { ...a, sourceId: "fictional-late-copy", receivedDate: "2026-09-30" }]), seen)).toEqual([]);
  });

  it("keeps the finding id and changes its evidence version when a third distinct invoice arrives", () => {
    const a = invoice();
    const b = invoice({ invoiceDate: "2026-09-12" });
    const [before] = multiples(run([a, b]));
    const after = run([a, b, invoice({ invoiceDate: "2026-09-28" })]);
    const [updated] = multiples(after);
    expect(multiples(after)).toHaveLength(1);
    expect(updated.id).toBe(before.id);
    expect(updated.evidenceVersion).not.toBe(before.evidenceVersion);
    expect(updated.invoices).toHaveLength(3);
    expect(newOrChanged(after, seenFrom([before]))).toEqual([updated]);
  });

  it("keeps partial evidence visible with a plain coverage note", () => {
    const partial = { from: "2026-09-10", to: "2026-09-30", complete: false };
    const findings = run([invoice({ senderMatch: "unlisted" }), invoice({ invoiceDate: "2026-09-20" })], { coverage: partial });
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.notes).toContain("Mail history only covers 2026-09-10 to 2026-09-30, so earlier invoices may be missing.");
    }
  });

  it("splits at the calendar-month boundary but groups the same pair under rolling 30 days", () => {
    const pair = [invoice({ invoiceDate: "2026-09-30" }), invoice({ invoiceDate: "2026-10-01" })];
    expect(run(pair)).toEqual([]);
    const [m] = multiples(run(pair, { rule: { basis: "invoiceDate", span: "rolling30" } }));
    expect(m).toMatchObject({ windowStart: "2026-09-30", windowEnd: "2026-10-29", windowKey: "invoiceDate/rolling30/2026-09-30" });
    expect(run([invoice({ invoiceDate: "2026-09-01" }), invoice({ invoiceDate: "2026-10-01" })], { rule: { basis: "invoiceDate", span: "rolling30" } })).toEqual([]);
  });

  it("counts by received date when that basis is chosen", () => {
    const pair = [invoice({ invoiceDate: "2026-08-28", receivedDate: "2026-09-02" }), invoice({ invoiceDate: "2026-09-05", receivedDate: "2026-09-06" })];
    expect(run(pair)).toEqual([]);
    const [m] = multiples(run(pair, { rule: { basis: "receivedDate", span: "calendarMonth" } }));
    expect(m.windowKey).toBe("receivedDate/calendarMonth/2026-09-01");
  });

  it("falls back to received date when an invoice date is missing and says so", () => {
    const [m] = multiples(run([invoice({ invoiceDate: null, receivedDate: "2026-09-09" }), invoice()]));
    expect(m.notes.some((n) => n.includes("the received date was used"))).toBe(true);
  });

  it("marks one invoice number with different amounts and no newer version as an unresolved revision, counted once", () => {
    const first = invoice({ invoiceNumber: "INV-77", amountCents: 30_000 });
    const second = invoice({ invoiceNumber: "INV-77", amountCents: 33_000 });
    expect(run([first, second])).toEqual([]);
    const [m] = multiples(run([first, second, invoice({ invoiceDate: "2026-09-20" })]));
    const revised = m.invoices.find((i) => i.invoiceNumber === "INV-77")!;
    expect(m.invoices).toHaveLength(2);
    expect(revised).toMatchObject({ unresolvedRevision: true, amountsCents: [30_000, 33_000] });
    expect(m.notes.some((n) => n.includes("INV-77") && n.includes("no newer version"))).toBe(true);
  });

  it("resolves a revision when a newer labelled version exists", () => {
    const original = invoice({ invoiceNumber: "INV-78", amountCents: 30_000, description: "Gutter clean" });
    const revised = invoice({ invoiceNumber: "INV-78", invoiceVersion: "2", amountCents: 27_500, description: "Gutter clean (credit applied)" });
    const [m] = multiples(run([original, revised, invoice({ invoiceDate: "2026-09-20" })]));
    expect(m.invoices.find((i) => i.invoiceNumber === "INV-78")).toMatchObject({
      unresolvedRevision: false,
      amountsCents: [27_500],
      description: "Gutter clean (credit applied)",
    });
  });

  it("dedupes unnumbered copies with identical date and amount but never merges different amounts", () => {
    const base = { invoiceNumber: null, invoiceDate: "2026-09-04", amountCents: 15_000 };
    const a = invoice(base);
    const copy = invoice({ ...base, receivedDate: "2026-09-11" });
    expect(run([a, copy])).toEqual([]);
    expect(multiples(run([a, invoice({ ...base, amountCents: 15_500 })]))).toHaveLength(1);
    // An unnumbered scan of a numbered invoice attaches to it.
    expect(run([invoice({ invoiceNumber: "INV-9", invoiceDate: "2026-09-04", amountCents: 15_000 }), a])).toEqual([]);
  });

  it("keeps a sender finding but leaves supplier comparison unresolved when the supplier is not mapped", () => {
    const findings = run([
      invoice({ supplierRef: null, senderMatch: "unlisted", senderEmail: "new@fictional.test" }),
      invoice({ supplierRef: null, senderMatch: "unlisted", senderEmail: "new@fictional.test", invoiceDate: "2026-09-12" }),
    ]);
    expect(multiples(findings)).toEqual([]);
    expect(senders(findings)).toHaveLength(2);
    for (const f of senders(findings)) {
      expect(f.reasons).toEqual(["supplier-unresolved", "unlisted-sender"]);
      expect(f.notes).toContain("Supplier not matched yet, so this invoice was not compared with others from the same supplier.");
    }
  });

  it("rejects an impossible date instead of guessing", () => {
    expect(() => run([invoice({ invoiceDate: "2026-02-30" })])).toThrow(/not a real YYYY-MM-DD day/);
  });
});
