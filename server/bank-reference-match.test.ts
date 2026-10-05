import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDatabase } from "./workflow-database.ts";
import { BankReferenceStore } from "./bank-reference-store.ts";
import { bankFirstPass, matchReference, maskPayer, narrativeTail, referenceVariants } from "./bank-reference-match.ts";
import { redbarkBankUpload, REDBARK_CSV_COLUMNS, type RedbarkAccount, type RedbarkTransaction } from "./redbark-source.ts";
import { bankImportArtifact, createBankReferenceBatch, parseBankCsv, reviewBankReferences, tenantDirectoryRules, type BankReferenceDecision, type BankReferenceRule, type BankReferenceUpload } from "./bank-reference.ts";

// FICTIONAL ANZ-shaped export and reference directory; see fixtures/anz-export-fictional.txt.
const bytes = readFileSync(new URL("./testing/fixtures/anz-export-fictional.csv", import.meta.url));
const rule = (propertyId: string, reference: string, extra: Partial<BankReferenceRule> = {}): BankReferenceRule => ({ propertyId, reference, aliases: [], ...extra });
const rules: BankReferenceRule[] = [
  rule("P-A2218", "A2218"), rule("P-A5U4", "A5U4", { aliases: ["Unit 5"] }), rule("P-A5U2", "A5U2", { aliases: ["Unit 5"] }),
  rule("P-B1605", "B1605"), rule("P-B1604", "B1604"), rule("P-D8", "D8"), rule("P-A114", "A114"),
  rule("P-A42", "A42", { expectedRent: 48000 }), rule("P-A8", "A8", { expectedRent: 55000 }), rule("P-B1", "B1"),
  rule("P-11901", "11901"), rule("P-1204", "1204"), rule("P-706", "706 JAS"), rule("P-A2004", "A2004"),
  rule("P-6EX", "C6", { aliases: ["6 Example St"] }), rule("Shop ACME", "ACME"), rule("Shop Zephyr", "C77", { invoiceCodes: ["ZEPHYR"] }),
];
const upload = (source = bytes, list = rules): BankReferenceUpload => ({ source: { filename: "fictional-anz.csv", bytesBase64: source.toString("base64") },
  columns: { date: "", amount: "", narrative: "", reference: "" }, dateFormat: "YYYY-MM-DD", rules: list });
const firstPassDecisions = (pass: NonNullable<ReturnType<typeof bankFirstPass>>): BankReferenceDecision[] =>
  pass.rows.map(row => row.disposition === "import" ? { rowId: row.rowId, action: "import", propertyId: row.propertyId, reason: row.reason } : { rowId: row.rowId, action: row.disposition, reason: row.reason });

describe("ANZ export profile", () => {
  it("detects the headerless 8-column layout and fixes its own mapping", () => {
    const table = parseBankCsv(bytes.toString("utf8"));
    expect(table.layout).toBe("anz-export");
    expect(table.length).toBe(28); // virtual header + 27 rows; the trailing blank line is not a row
    const batch = createBankReferenceBatch(upload());
    expect(batch.input.columns).toEqual({ date: "Date", amount: "Amount", narrative: "Narrative", reference: "Reference" });
    expect(batch.input.dateFormat).toBe("DD/MM/YYYY");
    expect(batch.rows[0]).toMatchObject({ date: "01/09/2026", amount: "550.00", reference: "A2218" });
  });
  it("keeps headered files on the header layout and needs the original ANZ bytes", () => {
    expect(parseBankCsv("Date,Amount\r\n01/09/2026,1.00\r\n").layout).toBe("header");
    const { source: _, ...mapping } = upload();
    expect(() => createBankReferenceBatch({ ...mapping, csv: bytes.toString("utf8") })).toThrow(/original ANZ/);
  });
  it("still rejects formula-shaped text", () => {
    const bad = Buffer.from('01/09/2026,"550.00",PAYMENT FROM ALEX FICTIONAL,ALEX FICTIONAL,FICTIONAL REALTY,,,=SUM(A1)\n');
    expect(() => createBankReferenceBatch(upload(bad))).toThrow(/formula/);
  });
  it("rejects malformed optional rent and invoice fields", () => {
    expect(() => createBankReferenceBatch(upload(bytes, [rule("P", "A1", { expectedRent: -5 })]))).toThrow(/Expected rent/);
    expect(() => createBankReferenceBatch(upload(bytes, [rule("P", "A1", { invoiceCodes: ["=X"] })]))).toThrow(/Invoice codes/);
  });
});

describe("candidate extraction", () => {
  it("strips the payer from PAYMENT FROM and splits TRANSFER FROM on padding", () => {
    expect(narrativeTail("PAYMENT FROM FINLEY TESTER 1204 JORDAN", "FINLEY TESTER")).toEqual({ name: "FINLEY TESTER", tail: "1204 JORDAN" });
    expect(narrativeTail("TRANSFER FROM JANE CITIZEN    A8 TARA", "")).toEqual({ name: "JANE CITIZEN", tail: "A8 TARA" });
    expect(narrativeTail("TRANSFER FROM BANK OF QLD      A42 SMITH", "")).toEqual({ name: "BANK OF QLD", tail: "A42 SMITH" });
    expect(narrativeTail("TRANSFER FROM JOHN DOE    RENT", "").tail).toBe("RENT");
    expect(narrativeTail("INTERNET BANKING MULTI-PAY FICTIONAL", "").tail).toBe("");
  });
  it.each([
    ["A2004Smithson", "A2004"], ["B1605Lasmin", "B1605"], ["A114-talia", "A114"], ["1204 JORDAN", "1204"],
    ["11901 Rent", "11901"], ["A5U4", "A5U4"], ["a8 tara", "A8"],
  ])("normalises %s to %s", (text, code) => expect(referenceVariants(text)).toContain(code));
  it("keeps a multi-word code whole first and drops a bare 'rent'", () => {
    expect(referenceVariants("706 JAS")[0]).toBe("706 JAS");
    expect(referenceVariants("RENT")).toEqual([]);
  });
  it("masks payers to a first name and initial", () => {
    expect(maskPayer("JANE CITIZEN")).toBe("Jane C.");
    expect(maskPayer("ALEX")).toBe("Alex");
    expect(maskPayer("")).toBe("");
  });
});

describe("match rules", () => {
  it("matches one reference, an alias, a whole multi-word code and reports ambiguity", () => {
    expect(matchReference("A2004Smithson", rules)).toMatchObject({ kind: "match", rules: [{ propertyId: "P-A2004" }] });
    expect(matchReference("706 JAS", rules)).toMatchObject({ kind: "match", rules: [{ propertyId: "P-706" }] });
    expect(matchReference("UNIT 5", rules)?.rules.map(r => r.propertyId)).toEqual(["P-A5U4", "P-A5U2"]);
    expect(matchReference("Z999", rules)).toBeNull();
  });
  it("treats water or invoice after a code, and invoice codes, as invoices", () => {
    expect(matchReference("ACME water", rules)).toMatchObject({ kind: "invoice", rules: [{ propertyId: "Shop ACME" }] });
    expect(matchReference("ZEPHYR INV 3021", rules)).toMatchObject({ kind: "invoice", rules: [{ propertyId: "Shop Zephyr" }] });
    expect(matchReference("ACME", rules)).toMatchObject({ kind: "match" });
  });
});

describe("first pass over the fictional ANZ export", () => {
  const batch = createBankReferenceBatch(upload());
  const pass = bankFirstPass(batch)!;
  it("classifies every row", () => {
    const table = pass.rows.map((row, index) => `${index + 1} ${row.class} ${row.disposition} ${row.propertyId ?? "-"}`);
    expect(table).toEqual([
      "1 matched import P-A2218", "2 matched import P-A5U4", "3 matched import P-A2004", "4 matched import P-B1605",
      "5 matched import P-A114", "6 matched import P-1204", "7 matched import P-11901", "8 matched import P-D8",
      "9 matched import P-A8", "10 exception hold P-A42", "11 exception hold -", "12 matched import P-6EX",
      "13 matched import Shop ACME", "14 invoice hold Shop ACME", "15 invoice hold Shop Zephyr", "16 exception hold P-B1604",
      "17 exception hold P-B1604", "18 exception hold -", "19 exception hold -", "20 not-rent exclude -",
      "21 not-rent exclude -", "22 not-rent exclude -", "23 exception hold -", "24 exception hold -",
      "25 matched import P-706", "26 matched import P-B1", "27 matched import P-A5U2",
    ]);
    expect(pass.summary).toEqual({ rows: 27, matched: 14, invoice: 2, exception: 8, notRent: 3, carried: 0 });
    expect(pass.exceptions.map(row => row.class)).toEqual([...Array(8).fill("exception"), "invoice", "invoice", "not-rent", "not-rent", "not-rent"]);
  });
  it("gives plain reasons, masked payers and suggestions", () => {
    const at = (n: number) => pass.rows[n - 1];
    expect(at(10)).toMatchObject({ payer: "Bank O.", reason: "Paid $300.00; weekly rent $480.00 — partial or shared?", suggestion: "P-A42 (A42)" });
    expect(at(11).reason).toBe("No reference found.");
    expect(at(12)).toMatchObject({ reason: "Reference matched C6." }); // "Rent 6 Example St": street number and name lead the alias
    expect(at(14).reason).toBe("Invoice payment: check the invoice number.");
    expect(at(16).reason).toBe("Several payers paid into B1604 in this batch (shared rent?).");
    expect(at(18)).toMatchObject({ reason: "Reference UNIT 5 matches more than one property.", suggestion: "P-A5U4 (A5U4) or P-A5U2 (A5U2)" });
    expect(at(19).reason).toBe("Unknown reference Z999.");
    expect(at(20).reason).toBe("Airbnb payout: not tenant rent.");
    expect(at(21).reason).toBe("Outgoing payment: not tenant rent.");
    expect(at(23).reason).toMatch(/^Not recognised as tenant rent/);
    expect(at(24).reason).toMatch(/^Not recognised as tenant rent/);
    expect(at(9).payer).toBe("Jane C.");
    expect(JSON.stringify(pass)).not.toMatch(/CITIZEN|SAMPLE|NOTREAL/);
  });
  it("accepts 1, 2 or 4 times the expected rent", () => {
    const double = Buffer.from(bytes.toString("utf8").replace('"550.00",TRANSFER FROM JANE', '"1100.00",TRANSFER FROM JANE'));
    expect(bankFirstPass(createBankReferenceBatch(upload(double)))!.rows[8].class).toBe("matched");
  });
  it("never auto-imports an exception, invoice or excluded row", () => {
    for (const row of pass.rows) if (row.class !== "matched") expect(row.disposition).not.toBe("import");
    const file = bankImportArtifact(batch, firstPassDecisions(pass));
    expect(file.summary).toEqual({ rows: 27, import: 14, hold: 10, exclude: 3 });
    expect(file.rows.filter(row => row.disposition === "import").map(row => row.rowId)).toEqual(pass.rows.filter(row => row.class === "matched").map(row => row.rowId));
  });
  it("changes only column 8 bytes, writing canonical codes where they differ", () => {
    const output = reviewBankReferences(batch, firstPassDecisions(pass));
    const before = parseBankCsv(batch.input.csv), after = parseBankCsv(output.csv);
    expect(after.length).toBe(before.length);
    after.forEach((row, r) => row.cells.forEach((cell, c) => { if (c !== 7) expect(cell).toBe(before[r].cells[c]); }));
    expect(output.changes.map(change => `${change.from}→${change.to}`)).toEqual(["A2004Smithson→A2004", "B1605Lasmin→B1605", "A114-talia→A114", "1204 JORDAN→1204", "11901 Rent→11901", "→D8", "→A8", "Rent 6 Example St Suburb→C6", "→A5U2"]);
    // Byte-for-byte: replay the expected col-8 edits on the original text.
    let expected = bytes.toString("utf8");
    for (const [from, to] of [[",A2004Smithson\n", ",A2004\n"], [",B1605Lasmin\n", ",B1605\n"], [",A114-talia\n", ",A114\n"], [",1204 JORDAN\n", ",1204\n"], [",11901 Rent\n", ",11901\n"], [",Rent 6 Example St Suburb\n", ",C6\n"],
      [",D8,\n", ",D8,D8\n"], ["A8 TARA,,,,,\n", "A8 TARA,,,,,A8\n"], [",A5U2,\n", ",A5U2,A5U2\n"]]) expected = expected.replace(from, to);
    expect(Buffer.from(output.bytesBase64, "base64").equals(Buffer.from(expected))).toBe(true);
  });
  it("is absent for headered exports", () => {
    const csv = "Date,Amount,Description,Reference\r\n01/09/2026,1.00,Fictional,\r\n";
    const headered = createBankReferenceBatch({ source: { filename: "h.csv", bytesBase64: Buffer.from(csv).toString("base64") }, columns: { date: "Date", amount: "Amount", narrative: "Description", reference: "Reference" }, dateFormat: "DD/MM/YYYY", rules: [] });
    expect(bankFirstPass(headered)).toBeNull();
  });
});

// FICTIONAL rows for the matcher fixes, the column check, bond and the REI tenant directory.
const anzRow = (amount: string, narrative: string, payer: string, ref2: string, ref: string) => `01/09/2026,"${amount}",${narrative},${payer},FICTIONAL REALTY,,${ref2},${ref}\n`;
const passOf = (lines: string[], list: BankReferenceRule[]) => bankFirstPass(createBankReferenceBatch(upload(Buffer.from(lines.join("")), list)))!;

describe("matcher fixes", () => {
  it("reads ANZ's fixed-width 16-character payer field in TRANSFER FROM", () => {
    expect(narrativeTail("TRANSFER FROM FICTIONAL PERSON A12 RENT", "")).toEqual({ name: "FICTIONAL PERSON", tail: "A12 RENT" });
    expect(narrativeTail("TRANSFER FROM FICTIONAL PERSON A12  RENT", "")).toEqual({ name: "FICTIONAL PERSON", tail: "A12  RENT" });
    expect(narrativeTail("TRANSFER FROM JO EXAMPLE  A12 RENT NOW", "").tail).toBe("A12 RENT NOW"); // short name padded by two spaces: not cut at 16
  });
  it("reads unit notation A5U4 as A5-4 and keeps the leading code with its unit", () => {
    expect(referenceVariants("A9U3")).toContain("A9-3");
    expect(referenceVariants("A9-3 FICTIONAL")).toContain("A9-3");
    const list = [rule("A9", "A9"), rule("A9-3", "A9-3")];
    expect(matchReference("A9U3", list)).toMatchObject({ kind: "match", rules: [{ propertyId: "A9-3" }] });
    expect(matchReference("A9-3 FICTIONAL", list)).toMatchObject({ kind: "match", rules: [{ propertyId: "A9-3" }] });
  });
  it("matches a code without its leading letter only when exactly one plain code fits", () => {
    expect(matchReference("7301", [rule("A7301", "A7301"), rule("Z1", "Z1")])).toMatchObject({ rules: [{ propertyId: "A7301" }] });
    expect(matchReference("7301", [rule("A7301", "A7301"), rule("B7301", "B7301")])).toBeNull();
  });
  it("matches a street number and name at the start of an alias after a leading Rent", () => {
    const list = [rule("C40", "C40", { aliases: ["40 Fictional Avenue Testville"] }), rule("C41", "C41", { aliases: ["41 Fictional Avenue"] })];
    expect(matchReference("Rent 40 Fictional Ave", list)).toMatchObject({ kind: "match", rules: [{ propertyId: "C40" }] });
    expect(matchReference("40 Elsewhere Rd", list)).toBeNull(); // a street address never reads as code 40
    expect(matchReference("40 RENT", [rule("C40", "C40")])).toMatchObject({ rules: [{ propertyId: "C40" }] });
  });
  it("still holds a row that gives only an address nobody has", () => {
    const pass = passOf([anzRow("600.00", "PAYMENT FROM IVY NOTREAL", "IVY NOTREAL", "", "Rent 99 Nowhere St")], [rule("C40", "C40", { aliases: ["40 Fictional Avenue"] })]);
    expect(pass.rows[0]).toMatchObject({ class: "exception", disposition: "hold", reason: "Only an address was given: confirm the property." });
  });
});

describe("first-pass exceptions", () => {
  const list = [rule("A31", "A31", { expectedRent: 85000 }), rule("A32", "A32")];
  it("holds a row whose last two columns name different properties", () => {
    const pass = passOf([anzRow("850.00", "PAYMENT FROM ALEX FICTIONAL", "ALEX FICTIONAL", "A32", "A31"), anzRow("850.00", "PAYMENT FROM ALEX FICTIONAL", "ALEX FICTIONAL", "A31", "A31")], list);
    expect(pass.rows[0]).toMatchObject({ class: "exception", disposition: "hold", reason: "The last column names A31 but the column before it names A32: confirm the property.", suggestion: "A31 (A31) or A32 (A32)" });
    expect(pass.rows[1]).toMatchObject({ class: "matched", disposition: "import", propertyId: "A31" });
  });
  it("excludes a bond payment from the RTA with its own reason", () => {
    const pass = passOf([anzRow("1700.00", "TRANSFER FROM RESIDENTIAL TENA A31", "", "", "A31")], list);
    expect(pass.rows[0]).toMatchObject({ class: "not-rent", disposition: "exclude", reason: "Bond payment from the RTA: not tenant rent." });
  });
  it("keeps the match but holds a partial or larger payment for review", () => {
    const pass = passOf([anzRow("800.00", "PAYMENT FROM ALEX FICTIONAL", "ALEX FICTIONAL", "", "A31"), anzRow("900.00", "PAYMENT FROM ALEX FICTIONAL", "ALEX FICTIONAL", "", "A31")], list);
    expect(pass.rows[0]).toMatchObject({ class: "exception", disposition: "hold", propertyId: "A31", reason: "Paid $800.00; weekly rent $850.00 — partial or shared?" });
    expect(pass.rows[1].reason).toBe("Paid $900.00; weekly rent $850.00. Paid more than rent — in advance?");
  });
});

describe("REI tenant directory", () => {
  // FICTIONAL REI Tenants grid export: quoted cells, shuffled headers, odd spelling.
  const tenants = [
    '"Surname","First Name","Reference","Property","Rent","BPay/Ref No.","Paid To"',
    '"FICTIONALSON","Robin","A31 FICTIONALSON","A31","$850.00","900123","01/10/2026"',
    '"EXAMPLE","Sam, Jr","A7 EXAMPLE","A7","$1,200.00 Fortnightly","","01/10/2026"',
    '"TWOSOME","Kai","A40 TWOSOME","A40","500","",""',
    '"PAIRING","Lee","A40 PAIRING","A40","500","",""',
  ].join("\r\n") + "\r\n";
  const fallback = [rule("A31", "A31", { aliases: ["31 Fictional Avenue"] }), rule("A40", "A40"), rule("Z5", "Z5", { aliases: ["5 Example Street"] })];
  const directory = tenantDirectoryRules(tenants, fallback);
  it("turns each tenant into a rule whose reference is the REI Reference", () => {
    expect(directory.find(r => r.reference === "A31 FICTIONALSON")).toEqual({ propertyId: "A31", reference: "A31 FICTIONALSON", tenant: "A31 FICTIONALSON",
      aliases: ["A31", "FICTIONALSON", "Robin FICTIONALSON", "900123", "31 Fictional Avenue"], expectedRent: 85000, rentPeriod: "week" });
    expect(directory.find(r => r.reference === "A7 EXAMPLE")).toMatchObject({ propertyId: "A7", aliases: ["EXAMPLE", "Sam, Jr EXAMPLE"], expectedRent: 120000, rentPeriod: "fortnight" });
    // Two tenants on A40: keyed by Reference, and the bare-code fallback is dropped so A40 stays ambiguous.
    expect(directory.filter(r => r.reference.startsWith("A40")).map(r => r.propertyId)).toEqual(["A40 TWOSOME", "A40 PAIRING"]);
    expect(directory.map(r => r.propertyId)).toEqual(["A31", "A7", "A40 TWOSOME", "A40 PAIRING", "Z5"]);
  });
  it("refuses a list without Reference and Property columns or with a repeated Reference", () => {
    expect(() => tenantDirectoryRules("Name,Rent\r\nX,1\r\n")).toThrow(/Reference and Property/);
    expect(() => tenantDirectoryRules("Reference,Property\r\nA1 X,A1\r\nA1 X,A2\r\n")).toThrow(/appears twice/);
  });
  it("writes the REI Reference into the last column and flags amounts and payer names", () => {
    const pass = passOf([anzRow("850.00", "PAYMENT FROM ROBIN FICTIONALSON", "ROBIN FICTIONALSON", "", "A31"), anzRow("850.00", "PAYMENT FROM KAI TWOSOME", "KAI TWOSOME", "", "A40"),
      anzRow("1200.00", "PAYMENT FROM FICTIONALSON ROBIN", "FICTIONALSON ROBIN", "", "Q123")], directory);
    expect(pass.rows[0]).toMatchObject({ class: "matched", propertyId: "A31", reason: "Reference matched A31 FICTIONALSON." });
    expect(pass.rows[1]).toMatchObject({ class: "exception", disposition: "hold", reason: "Reference A40 matches more than one property." });
    expect(pass.rows[2]).toMatchObject({ class: "exception", disposition: "hold", propertyId: "A31", reason: "Unknown reference Q123.", suggestion: "Matched by payer name: A31 (A31 FICTIONALSON)" });
    const batch = createBankReferenceBatch(upload(Buffer.from(anzRow("850.00", "PAYMENT FROM ROBIN FICTIONALSON", "ROBIN FICTIONALSON", "", "A31")), directory));
    const output = reviewBankReferences(batch, [{ rowId: batch.rows[0].id, action: "import", propertyId: "A31", reason: "Fictional check" }]);
    expect(output.csv).toBe(anzRow("850.00", "PAYMENT FROM ROBIN FICTIONALSON", "ROBIN FICTIONALSON", "", "A31 FICTIONALSON"));
  });
  it("is used as the directory when a prepare request carries a tenant list", () => {
    const dir = mkdtempSync(join(tmpdir(), "bud-tenants-"));
    try {
      const store = new BankReferenceStore(new WorkflowDatabase({ dir, key: Buffer.alloc(32, 7) }));
      const source = Buffer.from(anzRow("850.00", "PAYMENT FROM ROBIN FICTIONALSON", "ROBIN FICTIONALSON", "", "A31"));
      const created = store.create({ ...upload(source, fallback), tenantList: tenants });
      expect(created.value.batch.input.rules.map(r => r.reference)).toEqual(["A31 FICTIONALSON", "A7 EXAMPLE", "A40 TWOSOME", "A40 PAIRING", "Z5"]);
      expect(created.firstPass?.rows[0]).toMatchObject({ class: "matched", propertyId: "A31" });
      expect(store.settings()?.rules).toEqual(created.value.batch.input.rules);
      // The same bank file with a different list meets the existing review instead of replacing it.
      expect(() => store.create({ ...upload(source, fallback), tenantList: tenants.replace("$850.00", "$900.00") })).toThrow(/different mapping/);
      expect(() => store.create({ ...upload(source, fallback), tenantList: 7 })).toThrow(/tenant list/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("first pass over a fictional bank-feed (Redbark) batch", () => {
  const account: RedbarkAccount = { id: "acct_FictionalTrust0001", connection: "conn_FictionalAnz0001", provider: "fiskil", category: "banking", name: "Fictional Trust",
    type: "transaction", institution: { id: "inst_fk", name: "Fictional Bank" }, accountLast4: "4321", currency: "aud", status: "available", lastUpdatedAt: null, livemode: true };
  const txn = (id: string, cents: number, description: string, reference: string | null): RedbarkTransaction => ({ id: `txn_fk_feed-${id}`, account: account.id, status: "posted",
    date: "2026-09-02", postDate: "2026-09-02", valueDate: null, description, reference, extendedDescription: null, amountMinor: cents, currency: "aud", direction: cents < 0 ? "debit" : "credit", livemode: true });
  const feedBatch = (held = {}) => {
    const transactions = [txn("1", 55000, "PAYMENT FROM ALEX FICTIONAL", "A2218"), txn("2", 48000, "TRANSFER FROM SAM FICTIONAL  B1605", null),
      txn("3", 30000, "PAYMENT FROM ROBIN FICTIONAL", "Z999"), txn("4", 12000, "FICTIONAL PAYMENT", "ZEPHYR"), txn("5", -2000, "FICTIONAL BANK FEE", null), txn("6", 50000, "PAYONEER FICTIONAL", "A114")];
    const built = redbarkBankUpload({ account, pull: { account: account.id, from: "2026-09-01", to: "2026-09-03", transactions, truncated: false, livemode: true, responseDigest: "0".repeat(64), pages: 1 },
      runDate: "2026-09-03", retrievedAt: "2026-09-03T00:00:00.000Z", held });
    return createBankReferenceBatch({ source: built.source!, columns: { ...REDBARK_CSV_COLUMNS }, dateFormat: "YYYY-MM-DD", rules });
  };
  it("maps reference to the first candidate and description to the narrative", () => {
    const pass = bankFirstPass(feedBatch())!;
    expect(pass.layout).toBe("bank-feed");
    const by = (id: string) => pass.rows.find(row => row.rowId === `redbark:txn_fk_feed-${id}`)!;
    expect(by("1")).toMatchObject({ class: "matched", disposition: "import", propertyId: "P-A2218" });
    expect(by("2")).toMatchObject({ class: "matched", disposition: "import", propertyId: "P-B1605" }); // reference after padding in the description
    expect(by("3")).toMatchObject({ class: "exception", disposition: "hold", reason: "Unknown reference Z999." });
    expect(by("4")).toMatchObject({ class: "invoice", disposition: "hold" });
    expect(by("5")).toMatchObject({ class: "not-rent", disposition: "exclude" });
    expect(by("6")).toMatchObject({ class: "exception", disposition: "hold" });
    expect(pass.summary).toEqual({ rows: 6, matched: 2, invoice: 1, exception: 2, notRent: 1, carried: 0 });
    // Exceptions first, and none of them is ever imported.
    expect(pass.exceptions.map(row => row.class)).toEqual(["exception", "exception", "invoice", "not-rent"]);
    expect(pass.exceptions.every(row => row.disposition !== "import")).toBe(true);
  });
  it("keeps a carried hold an exception even when its reference matches, labelled with its date", () => {
    const pass = bankFirstPass(feedBatch({ "txn_fk_feed-old": { date: "2026-08-28", amount: "550.00", narrative: "PAYMENT FROM ALEX FICTIONAL", reference: "A2218", heldSince: "2026-08-30" } }))!;
    const carried = pass.rows.find(row => row.rowId === "redbark:txn_fk_feed-old")!;
    expect(carried).toMatchObject({ class: "exception", disposition: "hold", propertyId: "P-A2218", reason: "Held from an earlier pull · 2026-08-28", suggestion: "Reference matched A2218." });
    expect(pass.summary).toMatchObject({ carried: 1, matched: 2 });
  });
});

describe("saved ANZ review", () => {
  it("returns the first pass with each read, saves the reviewed copy and passes saved-review validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "bud-anz-"));
    try {
      const store = new BankReferenceStore(new WorkflowDatabase({ dir, key: Buffer.alloc(32, 7) }));
      const created = store.create(upload());
      expect(created.firstPass?.summary).toEqual({ rows: 27, matched: 14, invoice: 2, exception: 8, notRent: 3, carried: 0 });
      expect(created.value.batch).not.toHaveProperty("firstPass");
      const reviewed = store.review(created.id, created.revision, firstPassDecisions(created.firstPass!));
      expect(reviewed.value.result?.changes).toHaveLength(9);
      expect(store.get(created.id).firstPass?.summary.matched).toBe(14);
      expect(store.importArtifact(created.id).summary).toEqual({ rows: 27, import: 14, hold: 10, exclude: 3 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
