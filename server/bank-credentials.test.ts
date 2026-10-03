import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBankCredentials, REDBARK_KEY_ENTRY } from "./bank-credentials.ts";
import { createPrivateVault } from "./private-vault.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import { BankReferenceStore, RedbarkCoverage } from "./bank-reference-store.ts";
import { handleBankSourceRoute, type BankSourceDeps } from "./bank-source-http.ts";

// FICTIONAL key: obviously synthetic, never a real Redbark credential.
const KEY = "rbk_live_FICTIONAL0000000000000000abcd";
const dirs: string[] = [], dbs: WorkflowDatabase[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "realbud-bank-key-")); dirs.push(dir); return dir; };

describe("office Redbark key custody", () => {
  it("stores the key encrypted at 0600 and only ever reports the masked form", async () => {
    const dir = temp(), credentials = createBankCredentials(createPrivateVault(dir, Buffer.alloc(32, 3)), () => new Date("2026-10-02T00:00:00.000Z"));
    expect(await credentials.status()).toEqual({ configured: false, revision: 0 });
    const saved = await credentials.store(`  ${KEY}\n`, 0);
    expect(saved).toEqual({ configured: true, masked: "rbk_live_…abcd", savedAt: "2026-10-02T00:00:00.000Z", revision: 1 });
    expect(JSON.stringify(saved)).not.toContain("FICTIONAL0000");
    const file = join(dir, "company-installation", "private", `${REDBARK_KEY_ENTRY}.json`);
    expect(readFileSync(file, "utf8")).not.toContain("FICTIONAL0000");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    expect(await credentials.withKey(async key => key === KEY)).toBe(true);
  });

  it("checks revisions, rejects malformed keys without echoing them and removes the key", async () => {
    const credentials = createBankCredentials(createPrivateVault(temp(), Buffer.alloc(32, 3)));
    const rejected = await credentials.store("sk-fictional-not-redbark-0000", 0).then(() => new Error("stored"), (error: Error) => error);
    expect(rejected.message).toMatch(/starts with rbk_live_/); expect(rejected.message).not.toContain("sk-fictional");
    await credentials.store(KEY, 0);
    await expect(credentials.store(KEY, 0)).rejects.toMatchObject({ status: 409 });
    await expect(credentials.remove(0)).rejects.toMatchObject({ status: 409 });
    expect(await credentials.remove(1)).toEqual({ configured: false, revision: 0 });
    await expect(credentials.withKey(async () => true)).rejects.toMatchObject({ status: 409 });
  });
});

describe("bank source routes", () => {
  it("never return the key and require exact bodies", async () => {
    const dir = temp(), db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 4) }); dbs.push(db);
    const sent: string[] = [];
    const deps = { credentials: createBankCredentials(createPrivateVault(dir, Buffer.alloc(32, 3))), store: () => new BankReferenceStore(db), coverage: new RedbarkCoverage(dir),
      fetch: async (url: string) => { sent.push(url); return new Response(JSON.stringify({ object: "list", data: [], next_page_url: null, previous_page_url: null })); },
      today: async () => "2026-10-02" };
    const call = (path: string, method: string, body?: unknown) => handleBankSourceRoute(path, method, async () => body, deps);
    expect(await call("/api/bank-source/redbark/key", "PUT", { key: KEY })).toMatchObject({ status: 400 });
    const put = await call("/api/bank-source/redbark/key", "PUT", { key: KEY, expectedRevision: 0 });
    expect(put).toMatchObject({ status: 200, body: { key: { configured: true, masked: "rbk_live_…abcd" } } });
    expect(await call("/api/bank-source/redbark/accounts", "GET")).toEqual({ status: 200, body: { accounts: [] } });
    expect(sent).toEqual(["https://api.redbark.com/v2/accounts?limit=100"]);
    await expect(call("/api/bank-source/redbark/pull", "POST", { account: "acct_FictionalMissing1" })).rejects.toMatchObject({ status: 404 });
    expect(await call("/api/bank-source/redbark/confirm-import", "POST", { batchId: "bank:x" })).toMatchObject({ status: 400 });
    for (const result of [put, await call("/api/bank-source/redbark/key", "GET")]) expect(JSON.stringify(result)).not.toContain("FICTIONAL0000");
    expect(readdirSync(dir)).not.toContain("bank-source-redbark-key.json");
  });

  it("confirm-import advances coverage only with the host's verified W1 outcome, never batchId + revision alone", async () => {
    // FICTIONAL Redbark account and transaction, shaped like the published v2 samples.
    const account = { id: "acct_FictionalTrust0001", object: "account_item", connection: "conn_FictionalAnz0001", provider: "fiskil", category: "banking", name: "Fictional Trust Account", type: "transaction",
      institution: { id: "inst_fk_fictional", name: "Fictional Bank", logo: null }, account_number: "xxxx4321", currency: "aud", status: "available", last_updated_at: "2026-09-30T09:30:00.000Z",
      livemode: true, created: "2026-08-21T09:30:00.000Z", updated: "2026-09-30T09:30:00.000Z" };
    const txn = { id: "txn_fk_fictional-1", object: "transaction", account: account.id, status: "posted", date: "2026-09-29", datetime: "2026-09-29T02:00:00.000Z", post_date: "2026-09-30",
      post_datetime: "2026-09-30T03:00:00.000Z", value_date: "2026-09-30", value_datetime: null, description: "FICTIONAL TENANT PAYMENT", reference: null, extended_description: null,
      amount: { amount: 125000, currency: "aud" }, direction: "credit", provider_category: "TRANSFER_IN", category: null, merchant_name: null, merchant_category_code: null, livemode: true };
    const dir = temp(), db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 4) }); dbs.push(db);
    const store = new BankReferenceStore(db), coverage = new RedbarkCoverage(dir);
    let proof: Awaited<ReturnType<NonNullable<BankSourceDeps["importProof"]>>> = null;
    const deps: BankSourceDeps = { credentials: createBankCredentials(createPrivateVault(dir, Buffer.alloc(32, 3))), store: () => store, coverage, today: async () => "2026-10-02",
      fetch: async (url: string) => new Response(JSON.stringify({ object: "list", data: new URL(url).pathname === "/v2/accounts" ? [account] : [txn], next_page_url: null, previous_page_url: null })),
      importProof: async () => proof };
    const call = (path: string, method: string, body?: unknown) => handleBankSourceRoute(path, method, async () => body, deps);
    await call("/api/bank-source/redbark/key", "PUT", { key: KEY, expectedRevision: 0 });
    // The office's saved reference directory comes from an earlier review.
    store.create({ csv: "Date,Amount,Description,Reference\n2026-09-01,1.00,Fictional,\n", dateFormat: "YYYY-MM-DD", columns: { date: "Date", amount: "Amount", narrative: "Description", reference: "Reference" },
      rules: [{ propertyId: "fictional-property", reference: "00127", aliases: ["Fictional Payer"] }] });
    const pulled = await call("/api/bank-source/redbark/pull", "POST", { account: account.id }) as { body: { batch: { id: string } } };
    const id = pulled.body.batch.id, saved = store.get(id);
    store.review(id, saved.revision, saved.value.batch.rows.map(row => ({ rowId: row.id, action: "import" as const, propertyId: "fictional-property", reason: "Fictional review." })));
    await expect(call("/api/bank-source/redbark/confirm-import", "POST", { batchId: id, expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    expect(await coverage.state(account.id)).toBeNull();
    const file = store.importArtifact(id);
    proof = { kind: "w1-rei-import-proof", batchId: id, version: 1, artifactSha256: file.artifact!.digest, destination: { portal: "rei-cloud", urlValue: "fictional-reicid-1", marker: "FICT1" }, rowIds: [saved.value.batch.rows[0].id] };
    expect(await call("/api/bank-source/redbark/confirm-import", "POST", { batchId: id, expectedRevision: 0 })).toMatchObject({ status: 200, body: { reused: false, coverage: { revision: 1 } } });
  });
});
