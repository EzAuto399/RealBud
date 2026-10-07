// Pure W1 reconciliation: fictional rows only.
import { describe, expect, it } from "vitest";
import { amountCents, classifyReadback, isoDate, reconcilePreview, registerBaseline, registerRows, type W1ExpectedRow } from "./w1-rei-reconciliation.ts";

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

// REI's own Receipt Register CSV (Telerik export, seen live 7 Oct 2026): the exact header ids, FICTIONAL rows only.
// Date = Reference1, Rec No = Surname1, amount = InTrust1 = Authority1, Received From = textBox6; the rest repeat captions.
describe("REI Receipt Register export (Telerik CSV)", () => {
  const HEADER = "textBox5,textBox1,textBox13,textBox15,textBox16,textBox17,Reference1,Surname1,InTrust1,Authority1,textBox6,textBox10,textBox11,textBox12,textBox14,textBox4";
  const quote = (cell: string) => /[",]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  /** [date dd/mm/yyyy, rec no, amount, received from, reversal reason?] → CSV lines split on every comma, exactly as the runner hands them over.
   * By default a HYPOTHETICAL "Reversal Reason" header column is appended so a readback can complete; `today` is the export exactly as seen
   * live, which has no labelled reversal column. */
  const telerik = (rows: string[][], today = false) => [today ? HEADER : `${HEADER},Reversal Reason`, ...rows.map(([date, rec, amount, from, reason = ""]) =>
    ["Total:", "$99,999.00", "Cashbook Receipts", "", "", "", date, rec, amount, amount, from, "Reversal Reason:", "", "", "", "", ...(today ? [] : [reason])].map(quote).join(","))].map(line => line.split(","));
  const HISTORY = [
    ["01/09/2026", "5001", "$1,050.00", "Alpha, Fictional"], ["02/09/2026", "5002", "$450.00", "Bravo, Fictional"],
    ["03/09/2026", "5003", "$1,200.00", "Charlie & Delta, Sample & Fictional"], ["07/09/2026", "5004", "$620.00", "Delta & Echo, Fictional & Sample"],
    ["08/09/2026", "5005", "$380.50", "Foxtrot, Sample"], ["10/09/2026", "5006", "$2,100.00", "Golf, Fictional"],
    ["14/09/2026", "5007", "$1,050.00", "Hotel, Fictional"], ["15/09/2026", "5008", "$450.00", "India, Sample"],
    ["17/09/2026", "5009", "$990.00", "Juliet, Fictional"], ["21/09/2026", "5010", "$1,050.00", "Alpha, Fictional"],
    ["22/09/2026", "5011", "$720.00", "Kilo, Sample"], ["23/09/2026", "5012", "$310.00", "Lima, Fictional"],
  ];
  // The batch: Thursday 24 Sep for Alpha, Friday 25 Sep for the Delta & Echo household (REI dates it Monday 28 Sep).
  const BATCH: W1ExpectedRow[] = [
    { rowId: "b1", date: "2026-09-24", reference: "FT-ALPHA", amountCents: 105000, tenant: "Fictional Alpha" },
    { rowId: "b2", date: "2026-09-25", reference: "FT-ECHO", amountCents: 62000, tenant: "Sample Echo" },
  ];
  const NEW = [["24/09/2026", "5013", "$1,050.00", "Alpha, Fictional"], ["28/09/2026", "5014", "$620.00", "Delta & Echo, Fictional & Sample"]];
  const CODE = { marker: "FICT1" };
  const PAGE = { marker: "FICT1", checkedBefore: true, checkedAfter: true };
  const WIN = { from: "2026-09-21", to: "2026-09-30" };
  const PERIOD = { from: "2026-09-01", to: "2026-09-30" };
  const EVIDENCE = { pageScope: PAGE, exportPeriod: PERIOD };
  // Today's export is enough for the baseline: it lists receipt identities only.
  const BASE = registerBaseline(telerik(HISTORY, true), CODE, WIN, EVIDENCE);
  const read = (rows: string[][], extra: Record<string, unknown> = {}) => classifyReadback(BATCH, telerik(rows), CODE, { baseline: BASE, ...EVIDENCE, ...extra });
  const codes = (result: { warnings: Array<{ code: string }> }) => result.warnings.map(item => item.code);

  it("reads every row by the header fingerprint, putting quoted amounts and names back together", () => {
    const parsed = registerRows(telerik([...HISTORY, ...NEW]));
    expect(parsed).toMatchObject({ layout: "rei", unreadable: 0, period: null });
    expect(parsed.rows).toHaveLength(14);
    expect(parsed.rows[0]).toMatchObject({ receiptId: "5001", date: "2026-09-01", amountCents: 105000, tenant: "Alpha, Fictional", reference: "", status: "Receipted" });
    expect(parsed.rows[2].tenant).toBe("Charlie & Delta, Sample & Fictional");
    expect(BASE.receipts).toEqual(HISTORY.map(row => `id:${row[1]}`));
    // No date, no rec no, a non-numeric rec no or two amounts that disagree: unreadable. Credits shown negative read as negative.
    const odd = registerRows([...telerik([["", "5020", "$10.00", "Mike, Fictional"], ["25/09/2026", "", "$10.00", "Mike, Fictional"], ["25/09/2026", "X1", "$10.00", "Mike, Fictional"],
      ["25/09/2026", "5021", "($50.00)", "November, Fictional"], ["25/09/2026", "5022", "-$50.00", "Oscar, Fictional"]]),
      [..."Total:,,,,,,,,,,,,,,,".split(",")], "a,b,c,d,e,f,25/09/2026,5023,$10.00,$11.00,Papa,,,,,".split(",")]);
    expect(odd.unreadable).toBe(4);
    expect(odd.rows.map(row => row.amountCents)).toEqual([-5000, -5000]);
  });

  it("matches on date (or the next business day), exact amount and the payer's surname, and completes the batch", () => {
    const all = read([...HISTORY, ...NEW]);
    expect(all).toMatchObject({ scope: "verified", registerComplete: true, accepted: 2, pending: 0, historical: 12, complete: true, absent: false });
    expect(all.outcomes.map(item => [item.rowId, item.register?.receiptId])).toEqual([["b1", "5013"], ["b2", "5014"]]);
    expect(codes(all)).toEqual([]);
    // Two business days later is not the same receipt.
    expect(read([...HISTORY, NEW[0], ["29/09/2026", "5014", "$620.00", "Delta & Echo, Fictional & Sample"]])).toMatchObject({ accepted: 1, complete: false });
    // A cent out is not the same receipt either.
    expect(read([...HISTORY, NEW[0], ["28/09/2026", "5014", "$620.01", "Delta & Echo, Fictional & Sample"]])).toMatchObject({ accepted: 1, complete: false });
  });

  it("another payer's receipt with the same date and amount is never accepted", () => {
    const other = read([...HISTORY, ["24/09/2026", "5013", "$1,050.00", "Hotel, Fictional"], NEW[1]]);
    expect(other).toMatchObject({ accepted: 1, pending: 1, complete: false, absent: false });
    expect(other.outcomes[0]).toEqual({ rowId: "b1", outcome: "pending" });
    expect(codes(other)).toContain("register-tenant-differs");
    // Order, case and punctuation do not matter; a surname must still be shared.
    const flipped = classifyReadback([{ ...BATCH[0], tenant: "ALPHA, fictional" }], telerik([...HISTORY, ["24/09/2026", "5013", "$1,050.00", "Fictional Alpha"]]), CODE, { baseline: BASE, ...EVIDENCE });
    expect(flipped).toMatchObject({ accepted: 1, complete: true });
  });

  it("two candidates for one row, or one receipt two rows could claim, stays pending", () => {
    const twice = read([...HISTORY, NEW[0], ["24/09/2026", "5015", "$1,050.00", "Alpha, Fictional"], NEW[1]]);
    expect(twice).toMatchObject({ accepted: 1, complete: false });
    expect(twice.outcomes[0]).toEqual({ rowId: "b1", outcome: "pending" });
    expect(codes(twice)).toContain("register-match-ambiguous");
    const twins: W1ExpectedRow[] = [BATCH[0], { ...BATCH[0], rowId: "b1-twin", reference: "FT-ALPHA-2" }];
    const shared = classifyReadback(twins, telerik([...HISTORY, NEW[0]]), CODE, { baseline: BASE, ...EVIDENCE });
    expect(shared).toMatchObject({ accepted: 0, pending: 2, complete: false });
    expect(codes(shared).filter(code => code === "register-match-ambiguous")).toHaveLength(2);
  });

  it("is account-scoped only by the export's own business or by both page checks for this account", () => {
    const rows = [...HISTORY, ...NEW];
    expect(read(rows, { pageScope: undefined })).toMatchObject({ scope: "absent", registerComplete: false, complete: false });
    expect(read(rows, { pageScope: { ...PAGE, checkedAfter: false } })).toMatchObject({ scope: "absent", complete: false });
    expect(read(rows, { pageScope: { marker: "FICT1", checkedBefore: true } })).toMatchObject({ scope: "absent", complete: false });
    expect(read(rows, { pageScope: { ...PAGE, marker: "FICT2" } })).toMatchObject({ scope: "mismatch", accepted: 0, complete: false });
    // A file that names another business is a mismatch whatever the page showed.
    const named = [["Scope", "Value"], ["business", "FICT2"], ["from", PERIOD.from], ["to", PERIOD.to], ["Receipt ID", "Date", "Reference", "Tenant", "Amount", "Status"], ["FR-1", "2026-09-24", "FT-ALPHA", "Fictional Alpha", "1050.00", "Receipted"]];
    expect(classifyReadback([BATCH[0]], named, CODE, { window: WIN, pageScope: PAGE })).toMatchObject({ scope: "mismatch", accepted: 0 });
    expect(() => registerBaseline(telerik(HISTORY), CODE, WIN, { exportPeriod: PERIOD })).toThrow(/does not name its account/);
  });

  it("needs a period that covers the batch window and holds every row", () => {
    const rows = [...HISTORY, ...NEW];
    expect(read(rows, { exportPeriod: undefined })).toMatchObject({ registerComplete: false, complete: false });
    expect(read(rows, { exportPeriod: { from: "2026-09-22", to: "2026-09-30" } })).toMatchObject({ registerComplete: false, complete: false });
    const outside = read(rows, { exportPeriod: { from: "2026-09-02", to: "2026-09-30" } });
    expect(outside).toMatchObject({ registerComplete: false, complete: false });
    expect(outside.warnings.map(item => item.message)).toContain("The Receipt Register export has receipts outside the period it was asked for.");
    // REI's labelled export carries its own period caption.
    const labelled = [["Fictional Realty"], ["Cashbook Receipts"], ["For The Period - September 2026"], ["Date", "Rec No", "Received From", "Cash", "Cheque", "Card", "Direct Credit", "Total"],
      ...[...HISTORY, ...NEW].map(([date, rec, amount, from]) => [date, rec, from, "", "", "", amount, amount]), ["", "", "Total:", "", "", "", "$12,031.00", "$12,031.00"]];
    expect(registerRows(labelled)).toMatchObject({ layout: "rei", unreadable: 0, period: PERIOD });
    // Without a labelled Reversal Reason column it is never complete; with one (hypothetical until seen live) it can be.
    expect(classifyReadback(BATCH, labelled, CODE, { baseline: BASE, pageScope: PAGE })).toMatchObject({ registerComplete: false, accepted: 2, complete: false });
    const reasoned = labelled.map((line, index) => index < 3 ? line : [...line, index === 3 ? "Reversal Reason" : ""]);
    expect(classifyReadback(BATCH, reasoned, CODE, { baseline: BASE, pageScope: PAGE })).toMatchObject({ registerComplete: true, accepted: 2, complete: true });
  });

  it("today's export has no labelled Reversal Reason column: never complete, never proof of absence", () => {
    const today = classifyReadback(BATCH, telerik([...HISTORY, ...NEW], true), CODE, { baseline: BASE, ...EVIDENCE });
    expect(today).toMatchObject({ scope: "verified", registerComplete: false, accepted: 2, complete: false, absent: false });
    expect(codes(today)).toEqual(["register-reversals-unread"]);
    expect(classifyReadback(BATCH, telerik(HISTORY, true), CODE, { baseline: BASE, ...EVIDENCE })).toMatchObject({ registerComplete: false, absent: false });
    // The caption cell "Reversal Reason:" in a data row is never the column.
    expect(registerRows(telerik(NEW, true)).reversalsRead).toBe(false);
  });

  it("a value under a labelled Reversal Reason column (case and colon ignored) is a rejected row", () => {
    const reversed = classifyReadback(BATCH, telerik([...HISTORY, NEW[0], [...NEW[1], "Dishonoured"]]), CODE, { baseline: BASE, ...EVIDENCE });
    expect(reversed).toMatchObject({ registerComplete: true, accepted: 1, rejected: 1, complete: false });
    expect(reversed.outcomes[1]).toMatchObject({ rowId: "b2", outcome: "rejected", register: { receiptId: "5014", status: "Reversed" } });
    const colon = telerik([[...NEW[1], "Bank recall"]]).map((line, index) => index ? line : [...line.slice(0, -1), "REVERSAL REASON:"]);
    expect(registerRows(colon)).toMatchObject({ reversalsRead: true, rows: [{ status: "Reversed" }] });
  });

  it("a new receipt with a batch amount on any later date blocks absence, though it is never accepted", () => {
    // REI dates it five business days after the bank date (a holiday, later posting): not a match, but not absent either.
    const late = read([...HISTORY, ["01/10/2026", "5013", "$1,050.00", "Alpha, Fictional"]], { exportPeriod: { from: "2026-09-01", to: "2026-10-31" } });
    expect(late).toMatchObject({ registerComplete: true, accepted: 0, complete: false, absent: false });
    // Another payer, same amount, a week later: still not absent. Nothing new with a batch amount: absent.
    expect(read([...HISTORY, ["30/09/2026", "5013", "$620.00", "Zulu, Sample"]])).toMatchObject({ registerComplete: true, absent: false });
    expect(read([...HISTORY, ["24/09/2026", "5013", "$99.00", "Alpha, Fictional"]])).toMatchObject({ registerComplete: true, accepted: 0, absent: true });
  });

  it("an older receipt for the same payer, amount and date is history, never this batch", () => {
    const old = ["24/09/2026", "5012", "$1,050.00", "Alpha, Fictional"];
    const baseline = registerBaseline(telerik([...HISTORY.slice(0, 11), old]), CODE, WIN, EVIDENCE);
    expect(classifyReadback([BATCH[0]], telerik([...HISTORY.slice(0, 11), old]), CODE, { baseline, ...EVIDENCE })).toMatchObject({ accepted: 0, pending: 1, complete: false, absent: true });
    expect(classifyReadback([BATCH[0]], telerik([...HISTORY.slice(0, 11), old, NEW[0]]), CODE, { baseline, ...EVIDENCE }))
      .toMatchObject({ accepted: 1, complete: true, outcomes: [{ rowId: "b1", outcome: "accepted", register: { receiptId: "5013" } }] });
    // Without the baseline it is never complete and never proof of absence.
    expect(classifyReadback([BATCH[0]], telerik([...HISTORY.slice(0, 11), old]), CODE, { window: WIN, ...EVIDENCE })).toMatchObject({ complete: false, absent: false });
  });
});
