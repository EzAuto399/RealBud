import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBankReferenceBatch, reviewBankReferences, parseBankCsv, type BankReferenceInput } from "./bank-reference.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import { BankReferenceStore } from "./bank-reference-store.ts";

const input = (csv = "Date,Amount,Description,Reference,Extra\r\n11/09/2026,1250.00,Alex Taylor,,keep\r\n11/09/2026,-20.00,Fee,,unchanged\r\n"): BankReferenceInput => ({ csv, dateFormat: "DD/MM/YYYY", columns: { date: "Date", amount: "Amount", narrative: "Description", reference: "Reference" }, rules: [{ propertyId: "Unit 1", reference: "00127", aliases: ["Alex Taylor"] }] });
const review = (batch: ReturnType<typeof createBankReferenceBatch>) => batch.rows.map((row, i) => ({ rowId: row.id, action: i === 0 ? "assign" as const : "keep" as const, ...(i === 0 ? { propertyId: "Unit 1" } : {}), reason: "Checked source and property directory" }));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
describe("bank reference preparation", () => {
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
});
