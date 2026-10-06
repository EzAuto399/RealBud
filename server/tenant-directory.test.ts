import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDatabase } from "./workflow-database.ts";
import { BankReferenceStore } from "./bank-reference-store.ts";
import { redbarkBankUpload, REDBARK_CSV_COLUMNS, type RedbarkAccount } from "./redbark-source.ts";
import { createTenantDirectoryStore, MAX_TENANT_HISTORY, parseTenantList, savedTenantDirectoryCsv } from "./tenant-directory.ts";

// FICTIONAL REI Tenants export (live REI's columns); FT-KILO has no Property, FT-BRAVO repeats.
const EXPORT = [
  "Reference,Surname,Firstname,Property,Rent,Paid To,Rent Credit,Days +/-,Amount Owing,Lease Expiry,Vacating,Owner,BPay/Ref No.",
  "FT-BRAVO,Bravo,Fictional,FP-02,$540.00 per week,2026-09-12,0.00,-9,540.00,2027-03-31,,Fictional Owner One,4470002",
  'FT-JULIET,Juliet,Fictional,FP-10,"$2,400.00 per month",2026-09-11,0.00,-10,600.00,2027-03-31,,Fictional Owner One,4470012',
  "FT-KILO,Kilo,Fictional,,$400.00 per week,,0.00,0,0.00,,,,",
  "FT-BRAVO,Bravo,Again,FP-02,$540.00 per week,,,,,,,,",
  ",,,FP-11,,,,,,,,,",
  "=CMD,Formula,Fictional,FP-12,,,,,,,,,",
].join("\r\n");
const SOURCE = { name: "fictional-tenant-list.csv", sha256: "a".repeat(64), rows: 6 };
const withDb = (run: (db: WorkflowDatabase) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "bud-tenant-dir-"));
  const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 9) });
  try { run(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
};

describe("REI tenant list import", () => {
  it("keeps only the matching columns and rejects unusable rows with reasons", () => {
    const parsed = parseTenantList(EXPORT);
    expect(parsed.rows).toBe(6);
    expect(parsed.tenants).toEqual([
      { reference: "FT-BRAVO", surname: "Bravo", firstname: "Fictional", property: "FP-02", rent: "$540.00 per week", bpay: "4470002" },
      { reference: "FT-JULIET", surname: "Juliet", firstname: "Fictional", property: "FP-10", rent: "$2,400.00 per month", bpay: "4470012" },
    ]);
    expect(parsed.rejected.map(r => r.reason)).toEqual([
      "Row 4 (FT-KILO) has no Property, so a payment cannot be matched to it.",
      "Row 5 repeats REI Reference FT-BRAVO; only its first row was kept.",
      "Row 6 has no REI Reference.",
      "Row 7: the REI Reference is not plain text of at most 100 characters.",
    ]);
    expect(() => parseTenantList("Name,Email\nx,y\n")).toThrow(/Reference and Property/);
    expect(() => parseTenantList("Reference,Property\n,FP-1\n")).toThrow(/No tenant rows/);
  });

  it("saves with the caller's revision, writes nothing for an unchanged list and keeps replaced versions", () => withDb(db => {
    let now = 1_000;
    const store = createTenantDirectoryStore(db, () => now);
    const { tenants } = parseTenantList(EXPORT);
    expect(store.read()).toEqual({ revision: 0, directory: null });
    expect(() => store.save({ tenants, source: SOURCE, expectedRevision: 1 })).toThrow(/changed since this preview/);
    const first = store.save({ tenants, source: SOURCE, expectedRevision: 0 });
    expect(first).toMatchObject({ revision: 1, saved: true });
    // Same tenants from a newer export (arrears columns moved): no new revision.
    expect(store.save({ tenants, source: { ...SOURCE, sha256: "b".repeat(64) }, expectedRevision: 1 })).toMatchObject({ revision: 1, saved: false });
    expect(() => store.save({ tenants, source: SOURCE, expectedRevision: 0 })).toThrow(/changed since this preview/);
    for (let i = 0; i < MAX_TENANT_HISTORY + 2; i++) {
      now += 1;
      store.save({ tenants: [{ ...tenants[0], rent: `$${500 + i}.00 per week` }], source: SOURCE, expectedRevision: store.read().revision });
    }
    const latest = store.read();
    expect(latest.revision).toBe(MAX_TENANT_HISTORY + 3);
    expect(latest.directory!.history).toHaveLength(MAX_TENANT_HISTORY);
    expect(() => store.save({ tenants: [{ ...tenants[0], reference: "\u0007" }], source: SOURCE, expectedRevision: latest.revision })).toThrow(/not valid/);
  }));

  it("is the default directory for new bank batches: the REI Reference goes in the ANZ file's last column", () => withDb(db => {
    const bank = new BankReferenceStore(db);
    const store = createTenantDirectoryStore(db);
    store.save({ ...parseTenantList(EXPORT), source: SOURCE, expectedRevision: 0 });
    expect(savedTenantDirectoryCsv(db)).toContain("FT-BRAVO,Bravo,Fictional,FP-02");
    const fallback = [{ propertyId: "FP-99", reference: "PROP-99", aliases: ["Fictional Ninety Nine"] }];
    const anz = Buffer.from('02/10/2026,"540.00",FICTIONAL PAYMENT 4470002,,,,,\n');
    const created = bank.create({ source: { filename: "fictional-anz.csv", bytesBase64: anz.toString("base64") }, columns: { date: "", amount: "", narrative: "", reference: "" }, dateFormat: "DD/MM/YYYY", rules: fallback });
    expect(created.value.batch.input.rules.map(r => r.reference)).toEqual(["FT-BRAVO", "FT-JULIET", "PROP-99"]);
    expect(created.value.batch.rows[0].candidates).toEqual(["FP-02"]);
    bank.review(created.id, created.revision, [{ rowId: created.value.batch.rows[0].id, action: "import", propertyId: "FP-02", reason: "Fictional BPay reference matched" }]);
    expect(bank.importArtifact(created.id).artifact!.csv).toBe('02/10/2026,"540.00",FICTIONAL PAYMENT 4470002,,,,,FT-BRAVO\n');

    // A bank-feed (Redbark) batch gets the same directory.
    const account: RedbarkAccount = { id: "acct_FictionalTrust0001", connection: "conn_FictionalAnz0001", provider: "fiskil", category: "banking", name: "Fictional Trust",
      type: "transaction", institution: { id: "inst_fk", name: "Fictional Bank" }, accountLast4: "4321", currency: "aud", status: "available", lastUpdatedAt: null, livemode: true };
    const built = redbarkBankUpload({ account, runDate: "2026-10-03", retrievedAt: "2026-10-03T00:00:00.000Z", held: {},
      pull: { account: account.id, from: "2026-10-01", to: "2026-10-03", truncated: false, livemode: true, responseDigest: "0".repeat(64), pages: 1,
        transactions: [{ id: "txn_fk_dir-1", account: account.id, status: "posted", date: "2026-10-02", postDate: "2026-10-02", valueDate: null, description: "FICTIONAL PAYMENT", reference: "4470012",
          extendedDescription: null, amountMinor: 60000, currency: "aud", direction: "credit", livemode: true }] } });
    const feed = bank.createFromRedbark({ source: built.source!, columns: { ...REDBARK_CSV_COLUMNS }, dateFormat: "YYYY-MM-DD", rules: fallback });
    expect(feed.value.batch.input.rules.map(r => r.reference)).toEqual(["FT-BRAVO", "FT-JULIET", "PROP-99"]);
    // An uploaded tenant list still wins over the saved one.
    const other = Buffer.from('03/10/2026,"540.00",FICTIONAL PAYMENT 4470002,,,,,\n');
    const uploaded = bank.create({ source: { filename: "fictional-anz-2.csv", bytesBase64: other.toString("base64") }, columns: { date: "", amount: "", narrative: "", reference: "" }, dateFormat: "DD/MM/YYYY", rules: [],
      tenantList: "Reference,Property,BPay/Ref No.\nFT-OTHER,FP-02,4470002\n" });
    expect(uploaded.value.batch.input.rules.map(r => r.reference)).toEqual(["FT-OTHER"]);
  }));
});
