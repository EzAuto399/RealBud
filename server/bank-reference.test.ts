import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bankDigest, bankImportArtifact, createBankReferenceBatch, defaultDisposition, reviewBankReferences, parseBankCsv, type BankReferenceDecision, type BankReferenceInput, type BankReferenceUpload } from "./bank-reference.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import { BankReferenceStore } from "./bank-reference-store.ts";
import { redbarkBankUpload } from "./redbark-source.ts";

const input = (csv = "Date,Amount,Description,Reference,Extra\r\n11/09/2026,1250.00,Alex Taylor,,keep\r\n11/09/2026,-20.00,Fee,,unchanged\r\n"): BankReferenceInput => ({ csv, dateFormat: "DD/MM/YYYY", columns: { date: "Date", amount: "Amount", narrative: "Description", reference: "Reference" }, rules: [{ propertyId: "Unit 1", reference: "00127", aliases: ["Alex Taylor"] }] });
const review = (batch: ReturnType<typeof createBankReferenceBatch>) => batch.rows.map((row, i) => ({ rowId: row.id, action: i === 0 ? "assign" as const : "keep" as const, ...(i === 0 ? { propertyId: "Unit 1" } : {}), reason: "Checked source and property directory" }));
const dirs: string[] = [];
const upload = (bytes = Buffer.from(input().csv), filename = "Daily bank export.csv"): BankReferenceUpload => {
  const { csv: _, ...mapping } = input();
  return { ...mapping, source: { filename, bytesBase64: bytes.toString("base64") } };
};
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
describe("bank reference preparation", () => {
  it("captures original UTF-8 bytes and changes only reviewed reference cells across BOM, Unicode, mixed newlines and quotes", () => {
    const csv = '\uFEFFDate,Amount,Description,Reference,Extra\r\n11/09/2026,1250.00,"Alex Taylor café 🏡\nTenant","old",""\r\n11/09/2026,-20.00,Fee,"","unchanged"\n';
    const bytes = Buffer.from(csv), batch = createBankReferenceBatch(upload(bytes));
    expect(batch.version).toBe(2);
    expect(batch.source).toEqual({ filename: "Daily bank export.csv", bytesBase64: bytes.toString("base64"), byteLength: bytes.length, encoding: "utf-8-bom", digest: bankDigest(bytes) });
    const output = reviewBankReferences(batch, review(batch));
    const expected = Buffer.from(csv.replace('"old"', '"00127"'));
    expect(Buffer.from(output.bytesBase64, "base64")).toEqual(expected);
    expect(output.outputDigest).toBe(bankDigest(expected));
    expect(output.byteLength).toBe(expected.length);
    expect(Buffer.from(batch.source!.bytesBase64, "base64")).toEqual(bytes);
  });
  it("preserves every source byte when the reviewer keeps all rows", () => {
    const bytes = Buffer.from('\uFEFFDate,Amount,Description,Reference,Extra\r11/09/2026,1250.00,"Alex Taylor, ""quoted""","old",最後\r');
    const batch = createBankReferenceBatch(upload(bytes));
    const output = reviewBankReferences(batch, batch.rows.map(row => ({ rowId: row.id, action: "keep", reason: "Existing reference confirmed" })));
    expect(Buffer.from(output.bytesBase64, "base64")).toEqual(bytes);
    expect(output.outputDigest).toBe(batch.originalDigest);
  });
  it("splices multiple reference spans without shifting multibyte text between them", () => {
    const csv = '\uFEFFDate,Amount,Description,Reference,Extra\r\n11/09/2026,1250.00,Alex Taylor café,,一\n11/09/2026,20.00,Alex Taylor 🏡,"old",二\r';
    const batch = createBankReferenceBatch(upload(Buffer.from(csv)));
    const output = reviewBankReferences(batch, batch.rows.map(row => ({ rowId: row.id, action: "assign", propertyId: "Unit 1", reason: "Each fictional payment confirmed" })));
    expect(Buffer.from(output.bytesBase64, "base64")).toEqual(Buffer.from(csv.replace('café,,', 'café,00127,').replace('"old"', '"00127"')));
  });
  it.each([
    Buffer.from([0xff, 0xfe, 0x44, 0x00]), Buffer.from([0xfe, 0xff, 0x00, 0x44]),
    Buffer.from([0x44, 0x00, 0x61, 0x00]), Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]),
  ])("rejects unsupported or malformed encoding before accepting an upload", bytes => {
    expect(() => createBankReferenceBatch(upload(bytes))).toThrow(/UTF-8|encoding/);
  });
  it("rejects ambiguous source representations, invalid filenames and corrupt captured bytes", () => {
    expect(() => createBankReferenceBatch({ ...upload(), csv: input().csv } as unknown as BankReferenceUpload)).toThrow(/second text/);
    expect(() => createBankReferenceBatch(upload(Buffer.from(input().csv), "../bank.csv"))).toThrow(/filename/);
    expect(() => createBankReferenceBatch({ ...upload(), source: { filename: "bank.csv", bytesBase64: "Zh==" } })).toThrow();
    const batch = createBankReferenceBatch(upload());
    batch.source!.byteLength++;
    expect(() => reviewBankReferences(batch, review(batch))).toThrow(/integrity/);
    const changed = createBankReferenceBatch(upload());
    changed.source!.bytesBase64 = Buffer.from(input().csv.replace("1250.00", "9250.00")).toString("base64");
    expect(() => reviewBankReferences(changed, review(changed))).toThrow(/integrity/);
  });
  it("changes only the reviewed reference bytes, preserving signed amounts, dates, CRLF and leading zeroes", () => {
    const batch = createBankReferenceBatch(input());
    const output = reviewBankReferences(batch, review(batch));
    expect(output.csv).toBe(input().csv.replace("Alex Taylor,,keep", "Alex Taylor,00127,keep"));
    expect(output.changes).toHaveLength(1);
    expect(batch.input.csv).toBe(input().csv);
    expect(output.outputDigest).not.toBe(output.originalDigest);
  });
  it("handles BOM, quoted comma, escaped quote, newline and trailing empty fields", () => {
    const csv = '\uFEFFDate,Amount,Description,Reference,Extra\r\n11/09/2026,1250.00,"Alex Taylor, says ""hello""\nagain",,\r\n';
    const batch = createBankReferenceBatch(input(csv));
    expect(reviewBankReferences(batch, review(batch)).csv).toBe(csv.replace('again",,', 'again",00127,'));
  });
  it.each(['Date,Amount,Description,Reference\n11/09/2026,1.00,"oops,', 'Date,Amount,Description,Reference\n11/09/2026,1.00,"ok"bad,', 'Date,Amount,Description,Reference\n11/09/2026,1.00,Al"ex,', 'Date,Amount,Description,Reference\n11/09/2026,1.00,short', 'Date,Amount,date,Reference\n11/09/2026,1.00,Alex,'])("rejects malformed or ambiguous CSV", csv => expect(() => parseBankCsv(csv)).toThrow());
  it.each(["31/02/2026", "2026-09-11", "11/09/26"])("rejects invalid or unmapped date %s", date => expect(() => createBankReferenceBatch(input(input().csv.replaceAll("11/09/2026", date)))).toThrow(/date/));
  it.each(["1,250.00", "1e3", "1250", "+1250.00", "1250.001"])("rejects uncalibrated amount format %s", amount => expect(() => createBankReferenceBatch(input(input().csv.replace("1250.00", amount)))).toThrow());
  it("retains duplicate candidates and demands a separate decision for each", () => {
    const csv = "Date,Amount,Description,Reference\n11/09/2026,1250.00,Alex Taylor,\n11/09/2026,1250.00,Alex Taylor,\n";
    const batch = createBankReferenceBatch(input(csv));
    expect(batch.rows[0].id).not.toBe(batch.rows[1].id);
    expect(batch.rows.every(row => row.issues.some(i => i.includes("duplicate")))).toBe(true);
    expect(parseBankCsv(reviewBankReferences(batch, review(batch)).csv)).toHaveLength(3);
    expect(() => reviewBankReferences(batch, [review(batch)[0], review(batch)[0]])).toThrow(/exactly once/);
  });
  it("suggests ambiguous aliases without auto assigning or using substring matches", () => {
    const config = input(); config.rules.push({ propertyId: "Unit 2", reference: "00022", aliases: ["Alex Taylor"] });
    expect(createBankReferenceBatch(config).rows[0].candidates).toHaveLength(2);
    config.rules[0].aliases = ["Alex Tay"];
    expect(createBankReferenceBatch(config).rows[0].candidates).toEqual(["Unit 2"]);
  });
  it("requires every review reason, a valid directory entry, and no assignments to debits", () => {
    const batch = createBankReferenceBatch(input());
    expect(() => reviewBankReferences(batch, [])).toThrow();
    expect(() => reviewBankReferences(batch, review(batch).map(d => ({ ...d, reason: "" })))).toThrow();
    expect(() => reviewBankReferences(batch, review(batch).map(d => ({ ...d, action: "assign", propertyId: "missing" })))).toThrow();
    expect(() => reviewBankReferences(batch, review(batch).map(d => ({ ...d, action: "assign", propertyId: "Unit 1" })))).toThrow(/incoming/);
  });
  it("rejects formula references, formula narratives, mismatched source and overlarge inputs", () => {
    const config = input(); config.rules[0].reference = "=HYPERLINK(1)";
    expect(() => createBankReferenceBatch(config)).toThrow();
    expect(() => createBankReferenceBatch(input(input().csv.replace("Alex Taylor", "@SUM(1)")))).toThrow(/formula/);
    const batch = createBankReferenceBatch(input()); batch.input.csv += "\n";
    expect(() => reviewBankReferences(batch, [])).toThrow(/integrity/);
    expect(() => parseBankCsv("x".repeat(750001))).toThrow(/750/);
  });
  it("persists encrypted data, deduplicates downloads and rejects stale concurrent review after reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "bud-bank-")); dirs.push(dir);
    const key = Buffer.alloc(32, 7), db = new WorkflowDatabase({ dir, key }), store = new BankReferenceStore(db);
    const record = store.create(input());
    expect(store.create(input()).id).toBe(record.id);
    expect(() => store.export(record.id)).toThrow(/Review every/);
    expect(readFileSync(join(dir, "workflow-state.sqlite")).includes(Buffer.from("Alex Taylor"))).toBe(false);
    db.close();
    const reopened = new WorkflowDatabase({ dir, key }), second = new WorkflowDatabase({ dir, key });
    try {
      const saved = new BankReferenceStore(reopened).review(record.id, 1, review(record.value.batch));
      expect(saved.revision).toBe(2);
      expect(() => new BankReferenceStore(second).review(record.id, 1, review(record.value.batch))).toThrow(/changed/);
      expect(new BankReferenceStore(second).export(record.id).csv).toContain("00127");
      expect(new BankReferenceStore(second).export(record.id, true).csv).toBe(input().csv);
    } finally { reopened.close(); second.close(); }
  });
  it("retains original bytes and metadata through encrypted storage/reopen and leaves saved work intact after a bad upload", () => {
    const dir = mkdtempSync(join(tmpdir(), "bud-bank-bytes-")); dirs.push(dir);
    const key = Buffer.alloc(32, 5), db = new WorkflowDatabase({ dir, key }), store = new BankReferenceStore(db);
    const bytes = Buffer.from('\uFEFF' + input().csv), record = store.create(upload(bytes, "Original café.csv"));
    const prepared = store.review(record.id, record.revision, review(record.value.batch));
    expect(() => store.create(upload(Buffer.from('"malformed')))).toThrow();
    expect(store.list()).toHaveLength(1);
    expect(readFileSync(join(dir, "workflow-state.sqlite")).includes(Buffer.from("Original café.csv"))).toBe(false);
    db.close();
    const reopened = new WorkflowDatabase({ dir, key }), restored = new BankReferenceStore(reopened);
    try {
      const original = restored.export(record.id, true), result = restored.export(record.id);
      expect(original.filename).toBe("Original café.csv");
      expect(original.encoding).toBe("utf-8-bom");
      expect(original.originalBytesCaptured).toBe(true);
      expect(Buffer.from(original.bytesBase64, "base64")).toEqual(bytes);
      expect(result.originalBytesCaptured).toBe(true);
      expect(Buffer.from(result.bytesBase64, "base64")).toEqual(Buffer.from(prepared.value.result!.csv));
      expect(restored.create(upload(bytes, "renamed-copy.csv")).id).toBe(record.id);
      expect(restored.export(record.id, true).filename).toBe("Original café.csv");
    } finally { reopened.close(); }
  });
  it("exports a pre-existing v1 text-only result with an explicit compatibility limitation", () => {
    const dir = mkdtempSync(join(tmpdir(), "bud-bank-legacy-")); dirs.push(dir);
    const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 3) });
    try {
      const batch = createBankReferenceBatch(input()), checked = reviewBankReferences(batch, review(batch));
      const record = db.create("bank", `bank:${batch.originalDigest}`, { version: 1, createdAt: 1, batch,
        result: { csv: checked.csv, changes: checked.changes, originalDigest: checked.originalDigest, outputDigest: checked.outputDigest } });
      const store = new BankReferenceStore(db);
      expect(store.export(record.id, true).originalBytesCaptured).toBe(false);
      const result = store.export(record.id);
      expect(result.originalBytesCaptured).toBe(false);
      expect(Buffer.from(result.bytesBase64, "base64")).toEqual(Buffer.from(checked.csv));
      expect(store.get(record.id).revision).toBe(1);
    } finally { db.close(); }
  });
  it("rejects changed mappings after atomic deduplication without changing the original, review or revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "bud-bank-mapping-")); dirs.push(dir);
    const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 2) });
    try {
      const store = new BankReferenceStore(db), original = store.create(upload());
      const saved = store.review(original.id, original.revision, review(original.value.batch));
      const changed = upload(); changed.rules[0].reference = "00999";
      expect(() => store.create(changed)).toThrow(/different mapping/);
      expect(store.get(saved.id)).toEqual(saved);
      expect(store.export(saved.id, true).bytesBase64).toBe(upload().source.bytesBase64);
      expect(() => store.review(saved.id, saved.revision, review(saved.value.batch))).toThrow(/changed/);
      // Simulate a concurrent winner without permitting a preflight read to
      // decide correctness: create-or-read returns the differently mapped row.
      const race = new BankReferenceStore({ transaction: <T>(run: () => T) => run(), create: () => saved, get: () => undefined } as unknown as WorkflowDatabase);
      expect(() => race.create(changed)).toThrow(/different mapping/);
    } finally { db.close(); }
  });
  it("holds a corrupted saved source without rewriting it or returning reconstructed bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "bud-bank-recovery-")); dirs.push(dir);
    const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 1) });
    try {
      const store = new BankReferenceStore(db), saved = store.create(upload());
      const broken = db.update<typeof saved.value>("bank", saved.id, saved.revision, value => {
        value.batch.source!.bytesBase64 = Buffer.from("corrupt source").toString("base64"); return value;
      });
      expect(() => store.export(saved.id, true)).toThrow(/recover the saved data/);
      expect(() => store.get(saved.id)).toThrow(/recover the saved data/);
      expect(db.get('bank',saved.id)).toEqual(broken);
    } finally { db.close(); }
  });
});

describe("row dispositions: import | hold | exclude", () => {
  // FICTIONAL rows: a matched credit, a debit, an unrelated credit, an ambiguous credit and an excluded credit.
  const csv = '\uFEFFDate,Amount,Description,Reference,Extra\r\n11/09/2026,1250.00,"Alex Taylor, rent",,a\r\n11/09/2026,-20.00,Fee,,b\r\n11/09/2026,75.00,Unknown payer,,c\r\n12/09/2026,300.00,Sam Lee Alex Taylor,,d\r\n12/09/2026,40.00,Interest,,e\r\n';
  const rules = [{ propertyId: "Unit 1", reference: "00127", aliases: ["Alex Taylor"], tenant: "Fictional Tenant Alex" }, { propertyId: "Unit 2", reference: "00200", aliases: ["Sam Lee"] }];
  const batchOf = () => createBankReferenceBatch({ ...upload(Buffer.from(csv)), rules });
  it("defaults debits, unrelated credits and unresolved rows to hold", () => {
    expect(createBankReferenceBatch({ ...upload(Buffer.from(csv)), rules }).rows.map(defaultDisposition)).toEqual(["import", "hold", "hold", "hold", "hold"]);
  });
  it("puts only import rows in the REI artifact and accounts for every source row", () => {
    const batch = batchOf(), [a, b, c, d, e] = batch.rows;
    const decisions: BankReferenceDecision[] = [
      { rowId: a.id, action: "import", propertyId: "Unit 1", reason: "Fictional tenant confirmed" },
      { rowId: b.id, action: "hold", reason: "Bank fee" }, { rowId: c.id, action: "hold", reason: "Unknown payer" },
      { rowId: d.id, action: "import", propertyId: "Unit 2", reason: "Checked with the fictional office" },
      { rowId: e.id, action: "exclude", reason: "Bank interest, not rent" }];
    const result = bankImportArtifact(batch, decisions);
    expect(result.summary).toEqual({ rows: 5, import: 2, hold: 2, exclude: 1 });
    expect(result.rows.map(row => [row.rowId, row.disposition, row.propertyId ?? null, row.tenant ?? null, row.reference]))
      .toEqual([[a.id, "import", "Unit 1", "Fictional Tenant Alex", "00127"], [b.id, "hold", null, null, ""], [c.id, "hold", null, null, ""], [d.id, "import", "Unit 2", null, "00200"], [e.id, "exclude", null, null, ""]]);
    // Header and import rows only, each byte-for-byte from the reviewed copy.
    expect(result.artifact!.csv).toBe('\uFEFFDate,Amount,Description,Reference,Extra\r\n11/09/2026,1250.00,"Alex Taylor, rent",00127,a\r\n12/09/2026,300.00,Sam Lee Alex Taylor,00200,d\r\n');
    expect(result.artifact!.digest).toBe(bankDigest(Buffer.from(result.artifact!.csv)));
    expect(Buffer.from(result.artifact!.bytesBase64, "base64").toString("utf8")).toBe(result.artifact!.csv);
  });
  it("an ANZ export goes to REI as its own bytes: no header, only column 8 corrected, rows not imported removed as whole lines", () => {
    const bytes = readFileSync(join(import.meta.dirname, "testing/fixtures/anz-export-fictional.csv"));
    const rules = [{ propertyId: "FP-A", reference: "FT-ALEX", aliases: ["ALEX FICTIONAL"] }, { propertyId: "FP-B", reference: "FT-BRIAR", aliases: ["BRIAR SAMPLE"] }];
    const batch = createBankReferenceBatch({ source: { filename: "anz-export-fictional.csv", bytesBase64: bytes.toString("base64") }, columns: { date: "", amount: "", narrative: "", reference: "" }, dateFormat: "YYYY-MM-DD", rules });
    const decisions = batch.rows.map((row, i): BankReferenceDecision => i === 0 ? { rowId: row.id, action: "import", propertyId: "FP-A", reason: "Fictional check" }
      : i === 1 ? { rowId: row.id, action: "import", propertyId: "FP-B", reason: "Fictional check" } : { rowId: row.id, action: "hold", reason: "Fictional hold" });
    const result = bankImportArtifact(batch, decisions);
    const lines = bytes.toString("utf8").split("\n");
    expect(result.artifact!.csv).toBe(`${lines[0].replace(/,A2218$/, ",FT-ALEX")}\n${lines[1].replace(/,A5U4$/, ",FT-BRIAR")}\n`);
    expect(parseBankCsv(result.artifact!.csv).layout).toBe("anz-export");
  });
  it("a Redbark batch goes to REI in ANZ's layout (PROVISIONAL): DD/MM/YYYY, quoted amount, narrative, empty 4-7, reviewed reference, no header, LF", () => {
    const account = { id: "acct_FictionalAnz0001", connection: "conn_FictionalAnz0001", provider: "fiskil", category: "banking" as const, name: "Fictional", type: "transaction",
      institution: { id: "inst_fk", name: "Fictional Bank" }, accountLast4: "4321", currency: "aud", status: "active", lastUpdatedAt: null, livemode: true };
    const txn = (id: string, date: string, amountMinor: number, description: string) => ({ id, account: account.id, status: "posted" as const, date, postDate: date, valueDate: null,
      description, reference: null, extendedDescription: null, amountMinor, currency: "aud", direction: amountMinor < 0 ? "debit" as const : "credit" as const, livemode: true });
    const pull = { account: account.id, from: "2026-09-28", to: "2026-10-02", truncated: false, livemode: true, responseDigest: "a".repeat(64), pages: 1,
      transactions: [txn("txn_fk_anz-1", "2026-09-30", 125000, "FICTIONAL RENT, ALEX TAYLOR"), txn("txn_fk_anz-2", "2026-10-01", -2000, "FICTIONAL FEE"), txn("txn_fk_anz-3", "2026-10-02", 30000, "SAM LEE \"RENT\"")] };
    const { source } = redbarkBankUpload({ account, pull, runDate: "2026-10-02", retrievedAt: "2026-10-02T00:00:00.000Z" });
    const batch = createBankReferenceBatch({ source: source!, columns: { date: "Date", amount: "Amount", narrative: "Narrative", reference: "Reference" }, dateFormat: "YYYY-MM-DD", rules });
    const decisions = batch.rows.map((row, i): BankReferenceDecision => i === 1 ? { rowId: row.id, action: "hold", reason: "Bank fee" }
      : { rowId: row.id, action: "import", propertyId: i === 0 ? "Unit 1" : "Unit 2", reason: "Fictional check" });
    const result = bankImportArtifact(batch, decisions);
    expect(result.artifact!.csv).toBe('30/09/2026,"1250.00","FICTIONAL RENT, ALEX TAYLOR",,,,,00127\n02/10/2026,"300.00","SAM LEE ""RENT""",,,,,00200\n');
    expect(parseBankCsv(result.artifact!.csv).layout).toBe("anz-export");
    expect(result.artifact!.digest).toBe(bankDigest(Buffer.from(result.artifact!.csv)));
    expect(result.rows.map(row => [row.disposition, row.reference])).toEqual([["import", "00127"], ["hold", ""], ["import", "00200"]]);
  });
  it("refuses an import without a property, a debit import and a property on hold or exclude", () => {
    const batch = batchOf(), ids = batch.rows.map(row => row.id);
    const base = (over: Partial<BankReferenceDecision>[]): BankReferenceDecision[] => ids.map((rowId, i) => ({ rowId, action: "hold", reason: "Fictional review", ...over[i] }) as BankReferenceDecision);
    expect(() => bankImportArtifact(batch, base([{ action: "import" }]))).toThrow(/saved reference directory/);
    expect(() => bankImportArtifact(batch, base([{}, { action: "import", propertyId: "Unit 1" }]))).toThrow(/incoming payments/);
    expect(() => bankImportArtifact(batch, base([{ action: "exclude", propertyId: "Unit 1" }]))).toThrow(/cannot assign/);
    expect(() => bankImportArtifact(batch, base([{ action: "post" as never }]))).toThrow(/decision/);
  });
  it("maps existing assign/keep reviews to import/hold, and an all-hold review has no REI file", () => {
    const batch = batchOf();
    const legacy = batch.rows.map((row, i) => ({ rowId: row.id, action: i === 0 ? "assign" as const : "keep" as const, ...(i === 0 ? { propertyId: "Unit 1" } : {}), reason: "Earlier review" }));
    const result = bankImportArtifact(batch, legacy);
    expect(result.summary).toEqual({ rows: 5, import: 1, hold: 4, exclude: 0 });
    // The existing prepared copy is unchanged by the new dispositions.
    expect(reviewBankReferences(batch, legacy)).toEqual(reviewBankReferences(batch, legacy.map(d => d.action === "keep" ? { ...d, action: "hold" as const } : d)));
    expect(bankImportArtifact(batch, legacy.map(d => ({ rowId: d.rowId, action: "hold" as const, reason: d.reason }))).artifact).toBeNull();
  });
  it("the store saves import as a valid review and serves the import file; earlier reviews keep loading", () => {
    const dir = mkdtempSync(join(tmpdir(), "bud-bank-disposition-")); dirs.push(dir);
    const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 5) });
    try {
      const store = new BankReferenceStore(db), saved = store.create({ ...upload(Buffer.from(csv)), rules });
      const decisions = saved.value.batch.rows.map((row, i): BankReferenceDecision => i === 0 ? { rowId: row.id, action: "import", propertyId: "Unit 1", reason: "Fictional tenant confirmed" }
        : i === 4 ? { rowId: row.id, action: "exclude", reason: "Bank interest" } : { rowId: row.id, action: "hold", reason: "Needs review" });
      const reviewed = store.review(saved.id, saved.revision, decisions);
      expect(store.get(reviewed.id).value.decisions!.map(d => d.action)).toEqual(["assign", "hold", "hold", "hold", "exclude"]);
      const file = store.importArtifact(reviewed.id);
      expect(file.summary).toEqual({ rows: 5, import: 1, hold: 3, exclude: 1 });
      expect(file.artifact!.csv.split("\r\n").filter(Boolean)).toHaveLength(2);
      const earlier = store.create(upload());
      store.review(earlier.id, earlier.revision, review(earlier.value.batch));
      expect(store.importArtifact(earlier.id).summary).toEqual({ rows: 2, import: 1, hold: 1, exclude: 0 });
    } finally { db.close(); }
  });
});
