// Pure W1 reconciliation: fictional rows only.
import { describe, expect, it } from "vitest";
import { amountCents, classifyReadback, isoDate, reconcilePreview, registerBaseline, type W1ExpectedRow } from "./w1-rei-reconciliation.ts";

const ROWS: W1ExpectedRow[] = [
  { rowId: "r1", date: "2026-09-25", reference: "FT-BRAVO", amountCents: 54000, tenant: "Fictional Tenant Bravo" },
  { rowId: "r2", date: "2026-09-26", reference: "FT-CHARLIE", amountCents: 36000, tenant: "Fictional Tenant Charlie" },
];
const preview = (rows: string[][]) => rows.map(([Date, Reference, Tenant, Amount, Match]) => ({ Date, Reference, Tenant, Amount, Match }));
const DEST = { urlValue: "fictional-reicid-1", marker: "FICT1" };
const WINDOW = { from: "2026-09-25", to: "2026-09-30" };
const SCOPE = [["reicid", DEST.urlValue], ["business", DEST.marker], ["from", WINDOW.from], ["to", WINDOW.to]];
/** FICTIONAL register rows: [receipt id, date, reference, tenant, amount, status]. */
const register = (rows: string[][], scope: string[][] = SCOPE) =>
  [["Scope", "Value"], ...scope, ["Receipt ID", "Date", "Reference", "Tenant", "Amount", "Status"], ...rows, ["Total", "", "", "", "0"]];
const BASELINE = registerBaseline(register([]), DEST, WINDOW);

describe("money and dates", () => {
  it("parses amounts to cents and dates without guessing", () => {
    expect([amountCents("$1,234.50"), amountCents("540"), amountCents("(75.00)"), amountCents("-0.5"), amountCents("12.345"), amountCents("abc")]).toEqual([123450, 54000, -7500, -50, null, null]);
    expect([isoDate("2026-09-25"), isoDate("25/09/2026"), isoDate("2026-02-30"), isoDate("09-25-2026")]).toEqual(["2026-09-25", "2026-09-25", null, null]);
  });
});

describe("preview reconciliation", () => {
  it("is ready only when every row matches once, totals agree and REI matched each tenant", () => {
    const result = reconcilePreview(ROWS, preview([["2026-09-25", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Matched"], ["26/09/2026", "ft-charlie ", "Fictional Tenant Charlie", "360", "Matched"]]));
    expect(result).toMatchObject({ ready: true, mismatched: [], missing: [], extra: [], warnings: [], totals: { expectedRows: 2, previewRows: 2, expectedCents: 90000, previewCents: 90000 } });
    expect(result.matched.map(pair => pair.expected.rowId)).toEqual(["r1", "r2"]);
  });
  it("reports mismatched, missing, extra rows and warnings row by row", () => {
    const result = reconcilePreview([...ROWS, { rowId: "r3", date: "2026-09-27", reference: "FT-ECHO", amountCents: 2000, tenant: "Fictional Tenant Echo" }], preview([
      ["2026-09-25", "FT-BRAVO", "Fictional Tenant Hotel", "540.00", "Matched"],
      ["2026-09-26", "FT-CHARLIE", "Fictional Tenant Charlie", "306.00", "Matched"],
      ["2026-09-25", "UNKNOWN REF", "", "75.00", "Unmatched"],
    ]));
    expect(result.ready).toBe(false);
    expect(result.mismatched.map(item => [item.expected.rowId, item.fields])).toEqual([["r1", ["tenant"]], ["r2", ["amount"]]]);
    expect(result.missing.map(row => row.rowId)).toEqual(["r3"]);
    expect(result.extra.map(row => row.reference)).toEqual(["UNKNOWN REF"]);
    expect(result.warnings.map(item => item.code)).toEqual(expect.arrayContaining(["total-differs"]));
  });
  it("keeps two legitimate identical credits as two rows", () => {
    const twins: W1ExpectedRow[] = [{ rowId: "a", date: "2026-09-25", reference: "FT-GOLF", amountCents: 7800, tenant: "Fictional Tenant Golf" }, { rowId: "b", date: "2026-09-25", reference: "FT-GOLF", amountCents: 7800, tenant: "Fictional Tenant Golf" }];
    const one = reconcilePreview(twins, preview([["2026-09-25", "FT-GOLF", "Fictional Tenant Golf", "78.00", "Matched"]]));
    expect(one.missing.map(row => row.rowId)).toEqual(["b"]);
    expect(one.warnings.map(item => item.code)).toEqual(expect.arrayContaining(["row-count-differs", "total-differs"]));
    expect(reconcilePreview(twins, preview([["2026-09-25", "FT-GOLF", "Fictional Tenant Golf", "78.00", "Matched"], ["2026-09-25", "FT-GOLF", "Fictional Tenant Golf", "78.00", "Matched"]])).ready).toBe(true);
  });
  it("an unmatched REI row, a truncated page or an incomplete read is never ready", () => {
    expect(reconcilePreview([ROWS[1]], preview([["2026-09-26", "FT-CHARLIE", "Fictional Tenant Charlie", "360.00", "Unmatched"]])).warnings.map(item => item.code)).toEqual(["preview-row-unmatched"]);
    const clean = preview([["2026-09-26", "FT-CHARLIE", "Fictional Tenant Charlie", "360.00", "Matched"]]);
    expect(reconcilePreview([ROWS[1]], clean, { flags: ["page-truncated"] }).ready).toBe(false);
    expect(reconcilePreview([ROWS[1]], clean, { previewComplete: false }).ready).toBe(false);
  });
  it("a row with the right date, reference and amount but another or no tenant is a mismatch, never matched", () => {
    for (const records of [preview([["2026-09-26", "FT-CHARLIE", "Fictional Tenant Hotel", "360.00", "Matched"]]), preview([["2026-09-26", "FT-CHARLIE", "", "360.00", "Matched"]]),
      [{ Date: "2026-09-26", Reference: "FT-CHARLIE", Amount: "360.00", Match: "Matched" }]]) {
      const result = reconcilePreview([ROWS[1]], records);
      expect(result).toMatchObject({ ready: false, matched: [], missing: [], extra: [] });
      expect(result.mismatched.map(item => [item.expected.rowId, item.fields])).toEqual([["r2", ["tenant"]]]);
    }
    // With the crosswalk's tenant id, the preview must show that id too.
    const withId = { ...ROWS[1], tenantId: "FTN-03" };
    const named = { Date: "2026-09-26", Reference: "FT-CHARLIE", Tenant: "Fictional Tenant Charlie", Amount: "360.00", Match: "Matched" };
    expect(reconcilePreview([withId], [named]).mismatched.map(item => item.fields)).toEqual([["tenant"]]);
    expect(reconcilePreview([withId], [{ ...named, "Tenant ID": "FTN-99" }]).ready).toBe(false);
    expect(reconcilePreview([withId], [{ ...named, "Tenant ID": "FTN-03" }]).ready).toBe(true);
  });
  it("equal totals with swapped tenants or amounts never make a batch ready", () => {
    const pair: W1ExpectedRow[] = [{ rowId: "x", date: "2026-09-25", reference: "FT-GOLF", amountCents: 7800, tenant: "Fictional Tenant Golf" }, { rowId: "y", date: "2026-09-25", reference: "FT-GOLF", amountCents: 7800, tenant: "Fictional Tenant Hotel" }];
    const swapped = reconcilePreview(pair, preview([["2026-09-25", "FT-GOLF", "Fictional Tenant Golf", "78.00", "Matched"], ["2026-09-25", "FT-GOLF", "Fictional Tenant Golf", "78.00", "Matched"]]));
    expect(swapped).toMatchObject({ ready: false, totals: { expectedCents: 15600, previewCents: 15600 } });
    expect(swapped.mismatched.map(item => [item.expected.rowId, item.fields])).toEqual([["y", ["tenant"]]]);
    const amounts = reconcilePreview(ROWS, preview([["2026-09-25", "FT-BRAVO", "Fictional Tenant Bravo", "360.00", "Matched"], ["2026-09-26", "FT-CHARLIE", "Fictional Tenant Charlie", "540.00", "Matched"]]));
    expect(amounts).toMatchObject({ ready: false, warnings: [], totals: { expectedCents: 90000, previewCents: 90000 } });
    expect(amounts.mismatched.map(item => item.fields)).toEqual([["amount"], ["amount"]]);
  });
  it("refuses a batch with bad rows", () => {
    expect(() => reconcilePreview([{ ...ROWS[0], tenant: " " }], [])).toThrow(/expected REI tenant/);
    expect(() => reconcilePreview([{ ...ROWS[0], tenant: undefined as unknown as string }], [])).toThrow(/expected REI tenant/);
    expect(() => reconcilePreview([], [])).toThrow(/no rows/);
    expect(() => reconcilePreview([{ ...ROWS[0], amountCents: -1 }], [])).toThrow(/positive/);
    expect(() => reconcilePreview([ROWS[0], { ...ROWS[1], rowId: "r1" }], [])).toThrow(/own id/);
  });
});

describe("Receipt Register readback", () => {
  it("classifies accepted, rejected and pending rows and only calls a fully accepted, scoped, baselined register complete", () => {
    const partial = classifyReadback(ROWS, register([["FR-1", "2026-09-27", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"], ["FR-2", "2026-09-27", "FT-CHARLIE", "Fictional Tenant Charlie", "360.00", "Reversed"]]), DEST, { baseline: BASELINE });
    expect(partial).toMatchObject({ scope: "verified", registerComplete: true, absent: false, accepted: 1, rejected: 1, pending: 0, complete: false });
    const none = classifyReadback(ROWS, register([["FR-3", "2026-09-27", "FT-OTHER", "Fictional Tenant Alpha", "10.00", "Receipted"]]), DEST, { baseline: BASELINE });
    expect(none).toMatchObject({ accepted: 0, rejected: 0, pending: 2, complete: false, absent: true });
    expect(none.unclaimed.map(row => row.reference)).toEqual(["FT-OTHER"]);
    const all = classifyReadback(ROWS, register([["FR-1", "2026-09-27", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"], ["FR-2", "2026-09-27", "FT-CHARLIE", "Fictional Tenant Charlie", "360.00", "Receipted"]]), DEST, { baseline: BASELINE });
    expect(all).toMatchObject({ accepted: 2, complete: true, warnings: [] });
  });
  it("a blank or missing status is unknown, never accepted", () => {
    const blank = classifyReadback([ROWS[0]], register([["FR-1", "2026-09-27", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", ""]]), DEST, { baseline: BASELINE });
    expect(blank).toMatchObject({ accepted: 0, pending: 1, complete: false });
    expect(blank.warnings.map(item => item.code)).toEqual(["register-status-unknown"]);
    const noColumn = classifyReadback([ROWS[0]], [["Scope", "Value"], ...SCOPE, ["Date", "Reference", "Tenant", "Amount"], ["2026-09-27", "FT-BRAVO", "Fictional Tenant Bravo", "540.00"]], DEST, { baseline: BASELINE });
    expect(noColumn).toMatchObject({ accepted: 0, pending: 1, complete: false });
  });
  it("an older receipt with the same reference and amount never completes the new batch", () => {
    const old = ["FR-0", "2026-09-26", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"];
    const baseline = registerBaseline(register([old]), DEST, WINDOW);
    // Only the old receipt is there: nothing new, so the row is pending and nothing of the batch is attributable.
    expect(classifyReadback([ROWS[0]], register([old]), DEST, { baseline })).toMatchObject({ accepted: 0, pending: 1, historical: 1, complete: false, absent: true });
    // Without a baseline it is never complete, and it is not proof of absence either.
    expect(classifyReadback([ROWS[0]], register([old]), DEST, { window: WINDOW })).toMatchObject({ complete: false, absent: false });
    // The new receipt next to it completes the batch.
    expect(classifyReadback([ROWS[0]], register([old, ["FR-9", "2026-09-29", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"]]), DEST, { baseline }))
      .toMatchObject({ accepted: 1, complete: true, outcomes: [{ rowId: "r1", outcome: "accepted", register: { receiptId: "FR-9" } }] });
    // Without receipt ids, identical rows are told apart by count.
    const plain = (rows: string[][]) => [["Scope", "Value"], ...SCOPE, ["Date", "Reference", "Tenant", "Amount", "Status"], ...rows];
    const twin = ["2026-09-26", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"];
    const plainBaseline = registerBaseline(plain([twin]), DEST, WINDOW);
    expect(classifyReadback([ROWS[0]], plain([twin]), DEST, { baseline: plainBaseline }).accepted).toBe(0);
    expect(classifyReadback([ROWS[0]], plain([twin, twin]), DEST, { baseline: plainBaseline }).accepted).toBe(1);
  });
  it("counts only receipts inside the window, for the expected tenant, in a register that covers the window", () => {
    const outside = classifyReadback([ROWS[0]], register([["FR-1", "2026-10-03", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"]]), DEST, { baseline: BASELINE });
    expect(outside).toMatchObject({ accepted: 0, historical: 1, complete: false });
    const otherTenant = classifyReadback([ROWS[0]], register([["FR-1", "2026-09-27", "FT-BRAVO", "Fictional Tenant Hotel", "540.00", "Receipted"]]), DEST, { baseline: BASELINE });
    expect(otherTenant).toMatchObject({ accepted: 0, complete: false, absent: false });
    expect(otherTenant.warnings.map(item => item.code)).toContain("register-tenant-differs");
    const narrow = classifyReadback([ROWS[0]], register([["FR-1", "2026-09-27", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"]], [["reicid", DEST.urlValue], ["business", DEST.marker], ["from", "2026-09-27"], ["to", WINDOW.to]]), DEST, { baseline: BASELINE });
    expect(narrow).toMatchObject({ registerComplete: false, complete: false, absent: false });
    expect(() => registerBaseline(register([], [["reicid", DEST.urlValue], ["business", DEST.marker]]), DEST, WINDOW)).toThrow(/whole date range/);
    expect(() => registerBaseline(register([], [["reicid", "fictional-reicid-2"], ["business", "FICT2"], ["from", WINDOW.from], ["to", WINDOW.to]]), DEST, WINDOW)).toThrow(/different account/);
    const lateBaseline = registerBaseline(register([]), DEST, { from: "2026-09-27", to: WINDOW.to });
    expect(classifyReadback([ROWS[0]], register([["FR-1", "2026-09-27", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"]]), DEST, { baseline: lateBaseline, window: WINDOW }).complete).toBe(false);
  });
  it("confirms nothing from another account's export or one that does not name its account", () => {
    const other = classifyReadback(ROWS, register([["FR-1", "2026-09-27", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"]], [["reicid", "fictional-reicid-2"], ["business", "FICT2"], ["from", WINDOW.from], ["to", WINDOW.to]]), DEST, { baseline: BASELINE });
    expect(other).toMatchObject({ scope: "mismatch", accepted: 0, pending: 2, complete: false, absent: false });
    const absent = classifyReadback(ROWS, [["Receipt ID", "Date", "Reference", "Tenant", "Amount", "Status"], ["FR-1", "2026-09-27", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"], ["FR-2", "2026-09-27", "FT-CHARLIE", "Fictional Tenant Charlie", "360.00", "Receipted"]], DEST, { baseline: BASELINE });
    expect(absent).toMatchObject({ scope: "absent", accepted: 2, complete: false, absent: false });
  });
  it("scopes by the business code without a reicid; a reicid shown only narrows a saved one", () => {
    const row = [["FR-1", "2026-09-27", "FT-BRAVO", "Fictional Tenant Bravo", "540.00", "Receipted"]];
    const business = [["business", "FICT1"], ["from", WINDOW.from], ["to", WINDOW.to]];
    const codeOnly = { marker: "FICT1" };
    const base = registerBaseline(register([], business), codeOnly, WINDOW);
    expect(base.destination).toEqual(codeOnly);
    expect(classifyReadback([ROWS[0]], register(row, business), codeOnly, { baseline: base })).toMatchObject({ scope: "verified", complete: true });
    // A saved reicid with an export that shows none: the business code decides.
    expect(classifyReadback([ROWS[0]], register(row, business), DEST, { baseline: BASELINE })).toMatchObject({ scope: "verified", complete: true });
    // Another business is always out of scope, with or without a reicid; a different reicid beside the same code is too.
    expect(classifyReadback([ROWS[0]], register(row, [["business", "FICT2"], ["from", WINDOW.from], ["to", WINDOW.to]]), codeOnly, { baseline: base })).toMatchObject({ scope: "mismatch", accepted: 0 });
    expect(classifyReadback([ROWS[0]], register(row, [["reicid", "fictional-reicid-2"], ...business]), DEST, { baseline: BASELINE })).toMatchObject({ scope: "mismatch", accepted: 0 });
    // A reicid alone names no business: unverified.
    expect(classifyReadback([ROWS[0]], register(row, [["reicid", DEST.urlValue], ["from", WINDOW.from], ["to", WINDOW.to]]), DEST, { baseline: BASELINE })).toMatchObject({ scope: "absent", complete: false });
  });
  it("reads an ANZ-style preview that shows the narrative beside the reference by its reference", () => {
    const rows = [{ Date: "25/09/2026", Narrative: "FICTIONAL PAYMENT", Reference: "FT-BRAVO", Tenant: "Fictional Tenant Bravo", Amount: "$540.00", Match: "Matched" }];
    expect(reconcilePreview([ROWS[0]], rows)).toMatchObject({ ready: true });
  });
  it("flags a second same-reference receipt as a possible duplicate import", () => {
    const result = classifyReadback([ROWS[1]], register([["FR-1", "2026-09-27", "FT-CHARLIE", "Fictional Tenant Charlie", "360.00", "Receipted"], ["FR-2", "2026-09-28", "FT-CHARLIE", "Fictional Tenant Charlie", "360.00", "Receipted"]]), DEST, { baseline: BASELINE });
    expect(result.accepted).toBe(1);
    expect(result.warnings.map(item => item.code)).toEqual(["register-possible-duplicate"]);
    expect(result.complete).toBe(false);
  });
});
