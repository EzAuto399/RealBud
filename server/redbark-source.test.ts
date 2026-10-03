import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedbarkClient, pullRedbarkReview, redbarkBankUpload, localDate, RedbarkError, REDBARK_API_VERSION } from "./redbark-source.ts";
import { BankReferenceStore, RedbarkCoverage } from "./bank-reference-store.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import { validateSavedBankBatch } from "./bank-reference-validation.ts";

// FICTIONAL fixtures modelled on the shapes in Redbark's published v2 OpenAPI
// document and sample responses. No real key, account, payer or bank data.
const KEY = "rbk_live_FICTIONAL0000000000000000abcd";
const ACCOUNT = "acct_FictionalTrust0001", CONNECTION = "conn_FictionalAnz0001";
const fictionalAccount = (over: Record<string, unknown> = {}) => ({
  id: ACCOUNT, object: "account_item", connection: CONNECTION, provider: "fiskil", category: "banking",
  name: "Fictional Trust Account", type: "transaction", institution: { id: "inst_fk_fictional", name: "Fictional Bank", logo: null },
  account_number: "xxxx4321", currency: "aud", status: "available", last_updated_at: "2026-09-30T09:30:00.000Z",
  livemode: true, created: "2026-08-21T09:30:00.000Z", updated: "2026-09-30T09:30:00.000Z", ...over });
const fictionalTxn = (id: string, over: Record<string, unknown> = {}) => ({
  id, object: "transaction", account: ACCOUNT, status: "posted", date: "2026-09-29", datetime: "2026-09-29T02:00:00.000Z",
  post_date: "2026-09-30", post_datetime: "2026-09-30T03:00:00.000Z", value_date: "2026-09-30", value_datetime: null,
  description: "FICTIONAL TENANT PAYMENT", reference: null, extended_description: null,
  amount: { amount: 125000, currency: "aud" }, direction: "credit", provider_category: "TRANSFER_IN", category: null,
  merchant_name: null, merchant_category_code: null, livemode: true, ...over });
const list = (data: unknown[], next: string | null = null) => ({ object: "list", data, next_page_url: next, previous_page_url: null });

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
function fakeFetch(routes: (url: URL) => Reply | Reply[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const queues = new Map<string, Reply[]>();
  const fetch = async (input: string, init: { headers: Record<string, string> }) => {
    calls.push({ url: input, headers: init.headers });
    const url = new URL(input);
    let reply = routes(url);
    if (Array.isArray(reply)) { const queue = queues.get(input) ?? queues.set(input, [...reply]).get(input)!; reply = queue.length > 1 ? queue.shift()! : queue[0]; }
    return new Response(reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
  };
  return { fetch, calls };
}
const noSleep = async () => {};
const dirs: string[] = [], dbs: WorkflowDatabase[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-redbark-")); dirs.push(dir);
  const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 7) }); dbs.push(db);
  return { dir, store: new BankReferenceStore(db), coverage: new RedbarkCoverage(dir) };
}

describe("Redbark client", () => {
  it("sends the documented headers, follows same-path pages and keeps only the account's last four digits", async () => {
    const { fetch, calls } = fakeFetch(url => url.pathname === "/v2/accounts" && !url.searchParams.has("page")
      ? { body: list([fictionalAccount()], "https://api.redbark.com/v2/accounts?page=fictional-token") }
      : { body: list([fictionalAccount({ id: "acct_FictionalOther002", account_number: null, category: "brokerage" })]) });
    const accounts = await createRedbarkClient({ key: KEY, fetch, sleep: noSleep }).listAccounts();
    expect(accounts.map(a => [a.id, a.accountLast4, a.category])).toEqual([[ACCOUNT, "4321", "banking"], ["acct_FictionalOther002", null, "brokerage"]]);
    expect(calls[0].url).toBe("https://api.redbark.com/v2/accounts?limit=100");
    expect(calls[0].headers).toMatchObject({ authorization: `Bearer ${KEY}`, "redbark-version": REDBARK_API_VERSION });
  });

  it("requests one account and inclusive dates without pending rows, and surfaces truncation", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: list([fictionalTxn("txn_fk_fictional-1")]), headers: { "x-redbark-truncated": "true" } }));
    const pull = await createRedbarkClient({ key: KEY, fetch, sleep: noSleep }).listTransactions({ account: ACCOUNT, from: "2026-09-27", to: "2026-10-02" });
    const url = new URL(calls[0].url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ account: ACCOUNT, from: "2026-09-27", to: "2026-10-02", limit: "100", include_pending: "false" });
    expect(pull).toMatchObject({ truncated: true, livemode: true, pages: 1 });
    expect(pull.responseDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("takes only the page token from next_page_url and sends the key only to the configured base", async () => {
    const { fetch, calls } = fakeFetch(url => url.searchParams.has("page")
      ? { body: list([fictionalTxn("txn_fk_fictional-2")]) }
      : { body: list([fictionalTxn("txn_fk_fictional-1")], `https://api.fictional-proxy.internal/v2/transactions?limit=2&account=${ACCOUNT}&from=2026-09-01&to=2026-09-30&page=fictional%2Btoken`) });
    const pull = await createRedbarkClient({ key: KEY, fetch, sleep: noSleep }).listTransactions({ account: ACCOUNT, from: "2026-09-27", to: "2026-10-02" });
    expect(pull.transactions.map(row => row.id)).toEqual(["txn_fk_fictional-1", "txn_fk_fictional-2"]);
    expect(calls.map(call => new URL(call.url).origin)).toEqual(["https://api.redbark.com", "https://api.redbark.com"]);
    expect(calls[1].url).toBe("https://api.redbark.com/v2/transactions?page=fictional%2Btoken");
    for (const next of ["https://api.fictional-proxy.internal/v2/transactions?limit=2", "not a url ::", "https://api.redbark.com/v2/transactions?page="]) {
      const bad = fakeFetch(() => ({ body: list([fictionalTxn("txn_fk_fictional-1")], next) }));
      await expect(createRedbarkClient({ key: KEY, fetch: bad.fetch, sleep: noSleep }).listTransactions({ account: ACCOUNT, from: "2026-09-27", to: "2026-10-02" }))
        .rejects.toMatchObject({ code: "redbark_malformed" });
      expect(bad.calls.every(call => call.url.startsWith("https://api.redbark.com/v2/"))).toBe(true);
    }
    // A repeated token is a loop, not more pages.
    const loop = fakeFetch(() => ({ body: list([fictionalTxn("txn_fk_fictional-1")], "https://api.redbark.com/v2/transactions?page=same") }));
    await expect(createRedbarkClient({ key: KEY, fetch: loop.fetch, sleep: noSleep }).listTransactions({ account: ACCOUNT, from: "2026-09-27", to: "2026-10-02" }))
      .rejects.toMatchObject({ code: "redbark_malformed" });
    expect(loop.calls).toHaveLength(2);
  });

  it("honours Retry-After on 429 with a bounded retry", async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch(() => [{ status: 429, headers: { "retry-after": "2" }, body: { error: { type: "rate_limit_error", code: "rate_limited", message: "x", param: null, doc_url: "x", request_id: "req_Fictional1" } } }, { body: list([fictionalAccount()]) }]);
    const accounts = await createRedbarkClient({ key: KEY, fetch, sleep: async ms => { waits.push(ms); } }).listAccounts();
    expect(accounts).toHaveLength(1); expect(waits).toEqual([2000]); expect(calls).toHaveLength(2);

    const always = fakeFetch(() => ({ status: 429, headers: { "retry-after": "1" }, body: { error: { request_id: "req_Fictional2" } } }));
    await expect(createRedbarkClient({ key: KEY, fetch: always.fetch, sleep: noSleep }).listAccounts()).rejects.toMatchObject({ code: "redbark_unavailable", status: 503 });
    expect(always.calls).toHaveLength(4);

    const tooLong = fakeFetch(() => ({ status: 429, headers: { "retry-after": "3600" } }));
    await expect(createRedbarkClient({ key: KEY, fetch: tooLong.fetch, sleep: noSleep }).listAccounts()).rejects.toMatchObject({ code: "redbark_unavailable" });
    expect(tooLong.calls).toHaveLength(1);
  });

  it.each([
    ["missing list fields", { data: [] }],
    ["amount as a decimal string", list([fictionalTxn("txn_fk_x", { amount: "1250.00" })])],
    ["a debit with a positive amount", list([fictionalTxn("txn_fk_x", { direction: "debit" })])],
    ["an unknown status", list([fictionalTxn("txn_fk_x", { status: "settled" })])],
    ["another account's row", list([fictionalTxn("txn_fk_x", { account: "acct_FictionalOther002" })])],
    ["a timestamp posting date", list([fictionalTxn("txn_fk_x", { post_date: "2026-09-30T03:00:00.000Z" })])],
    ["conflicting copies of one id", list([fictionalTxn("txn_fk_x"), fictionalTxn("txn_fk_x", { description: "DIFFERENT" })])],
    ["a non-JSON body", "<html>fictional</html>"],
  ])("treats a 200 with %s as an error", async (_name, body) => {
    const { fetch } = fakeFetch(() => ({ body }));
    await expect(createRedbarkClient({ key: KEY, fetch, sleep: noSleep }).listTransactions({ account: ACCOUNT, from: "2026-09-27", to: "2026-10-02" }))
      .rejects.toMatchObject({ code: "redbark_malformed" });
  });

  it("keeps the key out of every error", async () => {
    const replies: (() => Promise<Response>)[] = [
      async () => new Response(JSON.stringify({ error: { message: `bad key ${KEY}`, request_id: "req_Fictional3" } }), { status: 401 }),
      async () => new Response("{}", { status: 500 }),
      async () => { throw new Error(`socket closed while sending Bearer ${KEY}`); },
    ];
    for (const reply of replies) {
      const error = await createRedbarkClient({ key: KEY, fetch: reply, sleep: noSleep }).listAccounts().then(() => new RedbarkError("resolved", "none"), (e: RedbarkError) => e);
      expect(error).toBeInstanceOf(RedbarkError); expect(error.code).not.toBe("none");
      expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain("FICTIONAL0000");
    }
    expect(() => createRedbarkClient({ key: "not-a-key", fetch: async () => new Response(), sleep: noSleep })).toThrow(RedbarkError);
  });
});

describe("Redbark CSV batch", () => {
  const account = { id: ACCOUNT, connection: CONNECTION, provider: "fiskil", category: "banking" as const, name: "Fictional", type: "transaction",
    institution: { id: "inst_fk_fictional", name: "Fictional Bank" }, accountLast4: "4321", currency: "aud", status: "active", lastUpdatedAt: null, livemode: true };
  it("keeps bank posting dates, signs amounts, leaves pending items out and binds Redbark ids", async () => {
    const { fetch } = fakeFetch(() => ({ body: list([
      fictionalTxn("txn_fk_fictional-b", { description: "FICTIONAL RENT", reference: "00127", extended_description: "FROM FICTIONAL PAYER" }),
      fictionalTxn("txn_fk_fictional-a", { post_date: null, date: "2026-09-28", amount: { amount: -2005, currency: "aud" }, direction: "debit", description: "FICTIONAL \"FEE\"" }),
      fictionalTxn("txn_fk_fictional-p", { status: "pending" }),
    ]) }));
    const pull = await createRedbarkClient({ key: KEY, fetch, sleep: noSleep }).listTransactions({ account: ACCOUNT, from: "2026-09-27", to: "2026-10-02" });
    const built = redbarkBankUpload({ account, pull, runDate: "2026-10-02", retrievedAt: "2026-10-02T00:00:00.000Z" });
    expect(built).toMatchObject({ included: 2, pending: 1, alreadyConfirmed: 0 });
    expect(Buffer.from(built.source!.bytesBase64, "base64").toString("utf8")).toBe(
      'Date,Amount,Narrative,Reference\r\n"2026-09-28","-20.05","FICTIONAL ""FEE""",""\r\n"2026-09-30","1250.00","FICTIONAL RENT FROM FICTIONAL PAYER","00127"\r\n');
    expect(built.source!.filename).toBe(`redbark-${ACCOUNT}-2026-10-02.csv`);
    expect(built.source!.provenance).toMatchObject({ kind: "redbark-api", originalBankExport: false, requestedFrom: "2026-09-27", requestedTo: "2026-10-02",
      runDate: "2026-10-02", transactionIds: ["txn_fk_fictional-a", "txn_fk_fictional-b"], responseDigest: pull.responseDigest });
  });
  it("uses the local post_date, never a UTC datetime slice", async () => {
    // Live-observed shape (fictional values): a UTC instant on the previous day
    // with the Australian local date in date/post_date; nulls elsewhere.
    const { fetch } = fakeFetch(() => ({ body: list([fictionalTxn("txn_fk_fictional-utc", { datetime: "2026-08-31T17:18:00.000Z", post_datetime: "2026-08-31T17:18:00.000Z",
      date: "2026-09-01", post_date: "2026-09-01", value_date: null, value_datetime: null, reference: "FICTIONALREF1", provider_category: "INCOME",
      amount: { amount: -1500, currency: "aud" }, direction: "debit" })]) }));
    const pull = await createRedbarkClient({ key: KEY, fetch, sleep: noSleep }).listTransactions({ account: ACCOUNT, from: "2026-09-01", to: "2026-09-30" });
    const built = redbarkBankUpload({ account, pull, runDate: "2026-10-02", retrievedAt: "2026-10-02T00:00:00.000Z" });
    expect(Buffer.from(built.source!.bytesBase64, "base64").toString("utf8")).toBe('Date,Amount,Narrative,Reference\r\n"2026-09-01","-15.00","FICTIONAL TENANT PAYMENT","FICTIONALREF1"\r\n');
  });
  it("formats the office-local date", () => {
    expect(localDate(new Date("2026-10-01T15:30:00Z"), "Australia/Brisbane")).toBe("2026-10-02");
    expect(localDate(new Date("2026-10-01T15:30:00Z"), "UTC")).toBe("2026-10-01");
  });
});

describe("Redbark pull, review and coverage", () => {
  const rules = [{ propertyId: "fictional-property", reference: "00127", aliases: ["Fictional Payer"] }];
  const source = (rows: unknown[]) => fakeFetch(url => url.pathname === "/v2/accounts" ? { body: list([fictionalAccount()]) } : { body: list(rows) });
  const reviewAll = (store: BankReferenceStore, id: string) => {
    const saved = store.get(id);
    return store.review(id, saved.revision, saved.value.batch.rows.map(row => ({ rowId: row.id, action: "import" as const, propertyId: "fictional-property", reason: "Fictional review." })));
  };
  /** What the W1 workflow issues after a complete readback (fictional REI account). */
  const proofFor = (store: BankReferenceStore, id: string, over: Record<string, unknown> = {}) => {
    const file = store.importArtifact(id);
    return { kind: "w1-rei-import-proof" as const, batchId: id, version: 1, artifactSha256: file.artifact!.digest,
      destination: { portal: "rei-cloud" as const, urlValue: "fictional-reicid-1", marker: "FICT1" }, rowIds: file.rows.filter(row => row.disposition === "import").map(row => row.rowId), ...over };
  };

  it("creates a review batch that validates, never claims original bank bytes, and rejects uploaded provenance", async () => {
    const f = fixture(), { fetch, calls } = source([fictionalTxn("txn_fk_fictional-1"), fictionalTxn("txn_fk_fictional-2")]);
    const summary = await pullRedbarkReview({ client: createRedbarkClient({ key: KEY, fetch, sleep: noSleep }), store: f.store, coverage: f.coverage, account: ACCOUNT, today: "2026-10-02", rules });
    expect(summary).toMatchObject({ window: { from: "2026-09-30", to: "2026-10-02", firstRun: true }, returned: 2, coverage: { coveredThrough: null, revision: 0 }, batch: { rows: 2, originalBytesCaptured: false } });
    expect(new URL(calls[1].url).searchParams.get("from")).toBe("2026-09-30");
    const saved = f.store.get(summary.batch!.id);
    expect(saved.value.batch.rows.map(row => [row.id, row.date])).toEqual([["redbark:txn_fk_fictional-1", "2026-09-30"], ["redbark:txn_fk_fictional-2", "2026-09-30"]]);
    // Two identical-looking credits stay distinct rows, flagged for review.
    expect(saved.value.batch.rows[0].issues).toContain("Possible duplicate; both source rows are preserved. Confirm before import.");
    expect(validateSavedBankBatch(saved.id, saved.value)).toBeTruthy();
    expect(f.store.export(saved.id, true)).toMatchObject({ originalBytesCaptured: false, provenance: { kind: "redbark-api" } });
    const { source: forged } = saved.value.batch;
    expect(() => f.store.create({ source: { filename: "forged.csv", bytesBase64: forged!.bytesBase64, provenance: forged!.provenance }, columns: saved.value.batch.input.columns, dateFormat: "YYYY-MM-DD", rules }))
      .toThrow(/cannot be uploaded/);
  });

  it("advances coverage only on confirm-import, widens after a missed run and de-duplicates the overlap", async () => {
    const f = fixture();
    const first = source([fictionalTxn("txn_fk_fictional-1")]);
    const pulled = await pullRedbarkReview({ client: createRedbarkClient({ key: KEY, fetch: first.fetch, sleep: noSleep }), store: f.store, coverage: f.coverage, account: ACCOUNT, today: "2026-10-02", rules });
    // Unreviewed batches cannot be confirmed; a pull alone moves nothing.
    await expect(f.store.confirmRedbarkImport(f.coverage, pulled.batch!.id, 0)).rejects.toMatchObject({ status: 409 });
    expect(await f.coverage.state(ACCOUNT)).toBeNull();
    reviewAll(f.store, pulled.batch!.id);
    const proof = proofFor(f.store, pulled.batch!.id);
    await expect(f.store.confirmRedbarkImport(f.coverage, pulled.batch!.id, 5, proof)).rejects.toMatchObject({ status: 409 });
    const confirmed = await f.store.confirmRedbarkImport(f.coverage, pulled.batch!.id, 0, proof);
    expect(confirmed).toMatchObject({ reused: false, coveredThrough: "2026-10-02", revision: 1 });
    expect(await f.store.confirmRedbarkImport(f.coverage, pulled.batch!.id, 0, proof)).toMatchObject({ reused: true, revision: 1 });
    if (process.platform !== "win32") expect(statSync(join(f.dir, "bank-source", "redbark-coverage.json")).mode & 0o077).toBe(0);

    // Two runs missed: the window starts at coverage − 3 days and reaches today.
    const late = source([fictionalTxn("txn_fk_fictional-1"), fictionalTxn("txn_fk_fictional-3", { post_date: "2026-10-05", date: "2026-10-05" })]);
    const second = await pullRedbarkReview({ client: createRedbarkClient({ key: KEY, fetch: late.fetch, sleep: noSleep }), store: f.store, coverage: f.coverage, account: ACCOUNT, today: "2026-10-08", rules });
    expect(second).toMatchObject({ window: { from: "2026-09-29", to: "2026-10-08", firstRun: false }, alreadyConfirmed: 1, batch: { rows: 1 }, coverage: { coveredThrough: "2026-10-02", revision: 1 } });
    expect(f.store.get(second.batch!.id).value.batch.rows.map(row => row.id)).toEqual(["redbark:txn_fk_fictional-3"]);

    // Nothing new: no batch, coverage unchanged.
    const quiet = source([fictionalTxn("txn_fk_fictional-1")]);
    expect(await pullRedbarkReview({ client: createRedbarkClient({ key: KEY, fetch: quiet.fetch, sleep: noSleep }), store: f.store, coverage: f.coverage, account: ACCOUNT, today: "2026-10-08", rules }))
      .toMatchObject({ batch: null, alreadyConfirmed: 1 });
  });

  it("confirm-import requires a verified W1 outcome for this batch, its import file and REI account; held rows stay unconfirmed", async () => {
    const f = fixture();
    const pulled = await pullRedbarkReview({ client: createRedbarkClient({ key: KEY, fetch: source([fictionalTxn("txn_fk_fictional-1"), fictionalTxn("txn_fk_fictional-2", { amount: { amount: -2000, currency: "aud" }, direction: "debit" })]).fetch, sleep: noSleep }),
      store: f.store, coverage: f.coverage, account: ACCOUNT, today: "2026-10-02", rules });
    const id = pulled.batch!.id, saved = f.store.get(id), [credit, debit] = saved.value.batch.rows;
    f.store.review(id, saved.revision, [{ rowId: credit.id, action: "import", propertyId: "fictional-property", reason: "Fictional review." }, { rowId: debit.id, action: "hold", reason: "Bank fee." }]);
    // batchId + revision alone, or a proof for anything else, never advance coverage.
    for (const proof of [undefined, null, proofFor(f.store, id, { batchId: "bank:" + "0".repeat(64) }), proofFor(f.store, id, { artifactSha256: "0".repeat(64) }),
      proofFor(f.store, id, { destination: { portal: "other", urlValue: "fictional-reicid-1", marker: "FICT1" } }), proofFor(f.store, id, { destination: { portal: "rei-cloud", urlValue: "", marker: "FICT1" } }),
      proofFor(f.store, id, { destination: { portal: "rei-cloud", marker: "" } }), proofFor(f.store, id, { destination: { portal: "rei-cloud" } }),
      proofFor(f.store, id, { rowIds: [credit.id, debit.id] }), proofFor(f.store, id, { rowIds: [] }), proofFor(f.store, id, { kind: "w1-rei-preview" }), proofFor(f.store, id, { version: 2 })])
      await expect(f.store.confirmRedbarkImport(f.coverage, id, 0, proof as never)).rejects.toMatchObject({ status: 409 });
    expect(await f.coverage.state(ACCOUNT)).toBeNull();
    expect(await f.store.confirmRedbarkImport(f.coverage, id, 0, proofFor(f.store, id))).toMatchObject({ reused: false, revision: 1 });
    expect(Object.keys((await f.coverage.state(ACCOUNT))!.confirmed)).toEqual(["txn_fk_fictional-1"]);
  });

  it("confirm-import accepts a proof naming the REI account by its business code alone (no reicid saved)", async () => {
    const f = fixture();
    const pulled = await pullRedbarkReview({ client: createRedbarkClient({ key: KEY, fetch: source([fictionalTxn("txn_fk_fictional-1")]).fetch, sleep: noSleep }),
      store: f.store, coverage: f.coverage, account: ACCOUNT, today: "2026-10-02", rules });
    const id = pulled.batch!.id;
    reviewAll(f.store, id);
    expect(await f.store.confirmRedbarkImport(f.coverage, id, 0, proofFor(f.store, id, { destination: { portal: "rei-cloud", marker: "FICT1" } }))).toMatchObject({ reused: false, revision: 1 });
  });

  it("carries every held row into later pulls, whatever its age, until a person imports or excludes it", async () => {
    const f = fixture();
    const ledger = [
      ...Array.from({ length: 18 }, (_, n) => fictionalTxn(`txn_fk_held-${n + 1}`, { date: "2026-09-30", post_date: "2026-09-30", description: `FICTIONAL UNKNOWN PAYER ${n + 1}`, reference: "Z999" })),
      fictionalTxn("txn_fk_import-1", { date: "2026-10-02", post_date: "2026-10-02", reference: "00127" })];
    const byWindow = fakeFetch(url => url.pathname === "/v2/accounts" ? { body: list([fictionalAccount()]) }
      : { body: list(ledger.filter(row => row.date >= url.searchParams.get("from")! && row.date <= url.searchParams.get("to")!)) });
    const pull = (today: string) => pullRedbarkReview({ client: createRedbarkClient({ key: KEY, fetch: byWindow.fetch, sleep: noSleep }), store: f.store, coverage: f.coverage, account: ACCOUNT, today, rules });
    const decide = (id: string, choose: (rowId: string) => "import" | "hold" | "exclude") => {
      const saved = f.store.get(id);
      f.store.review(id, saved.revision, saved.value.batch.rows.map(row => { const action = choose(row.id); return action === "import" ? { rowId: row.id, action, propertyId: "fictional-property", reason: "Fictional review." } : { rowId: row.id, action, reason: "Fictional review." }; }));
    };
    // Run 1 (09-30..10-02): 18 held, 1 imported, confirmed.
    const first = await pull("2026-10-02");
    expect(first).toMatchObject({ batch: { rows: 19 }, carried: 0 });
    decide(first.batch!.id, rowId => rowId === "redbark:txn_fk_import-1" ? "import" : "hold");
    await f.store.confirmRedbarkImport(f.coverage, first.batch!.id, 0, proofFor(f.store, first.batch!.id));
    expect(Object.keys((await f.coverage.state(ACCOUNT))!.held!)).toHaveLength(18);

    // Run 2 (09-29..10-12) still pulls the holds itself: nothing is carried twice.
    ledger.push(fictionalTxn("txn_fk_new-1", { date: "2026-10-11", post_date: "2026-10-11", reference: "00127" }));
    const second = await pull("2026-10-12");
    expect(second).toMatchObject({ window: { from: "2026-09-29" }, carried: 0 });
    // Run 3 (10-09..10-20) no longer reaches the holds: all 18 are carried in.
    decide(second.batch!.id, rowId => rowId.startsWith("redbark:txn_fk_held-") ? "hold" : "import");
    await f.store.confirmRedbarkImport(f.coverage, second.batch!.id, 1, proofFor(f.store, second.batch!.id));
    ledger.push(fictionalTxn("txn_fk_new-2", { date: "2026-10-20", post_date: "2026-10-20", reference: "00127" }));
    const third = await pull("2026-10-20");
    expect(third).toMatchObject({ window: { from: "2026-10-09" }, carried: 18, batch: { rows: 19 } });
    const saved = f.store.get(third.batch!.id), held = saved.value.batch.rows.filter(row => row.id.startsWith("redbark:txn_fk_held-"));
    expect(held).toHaveLength(18);
    // Original id and bank data, no duplicates, labelled and counted.
    expect(held.find(row => row.id === "redbark:txn_fk_held-1")).toMatchObject({ date: "2026-09-30", amount: "1250.00", narrative: "FICTIONAL UNKNOWN PAYER 1", reference: "Z999" });
    expect(new Set(saved.value.batch.rows.map(row => row.id)).size).toBe(19);
    expect(saved.firstPass).toMatchObject({ layout: "bank-feed", summary: { carried: 18 } });
    expect(saved.firstPass!.rows.filter(row => row.reason.startsWith("Held from an earlier pull · "))).toHaveLength(18);
    expect(saved.firstPass!.rows.filter(row => row.rowId.startsWith("redbark:txn_fk_held-")).every(row => row.disposition === "hold" && row.class === "exception")).toBe(true);

    // Imported and excluded holds stop carrying; the rest stay.
    decide(third.batch!.id, rowId => rowId === "redbark:txn_fk_held-1" || rowId === "redbark:txn_fk_new-2" ? "import" : rowId === "redbark:txn_fk_held-2" ? "exclude" : "hold");
    await f.store.confirmRedbarkImport(f.coverage, third.batch!.id, 2, proofFor(f.store, third.batch!.id));
    expect(Object.keys((await f.coverage.state(ACCOUNT))!.held!)).toHaveLength(16);
    // A carried hold that reappears inside the window is pulled once, not carried as well.
    ledger.find(row => row.id === "txn_fk_held-3")!.date = "2026-10-19";
    ledger.push(fictionalTxn("txn_fk_new-3", { date: "2026-10-21", post_date: "2026-10-21", reference: "00127" }));
    const fourth = await pull("2026-10-21");
    expect(fourth).toMatchObject({ carried: 15, batch: { rows: 17 } });
    const ids = f.store.get(fourth.batch!.id).value.batch.rows.map(row => row.id);
    expect(ids.filter(id => id === "redbark:txn_fk_held-3")).toHaveLength(1);
    expect(ids).not.toContain("redbark:txn_fk_held-1");
    expect(ids).not.toContain("redbark:txn_fk_held-2");
  });

  it("refuses truncated and test-mode pulls without creating a batch", async () => {
    const f = fixture();
    const capped = fakeFetch(url => url.pathname === "/v2/accounts" ? { body: list([fictionalAccount()]) } : { body: list([fictionalTxn("txn_fk_fictional-1")]), headers: { "x-redbark-truncated": "true" } });
    await expect(pullRedbarkReview({ client: createRedbarkClient({ key: KEY, fetch: capped.fetch, sleep: noSleep }), store: f.store, coverage: f.coverage, account: ACCOUNT, today: "2026-10-02", rules }))
      .rejects.toMatchObject({ code: "redbark_truncated" });
    const test = source([fictionalTxn("txn_fk_fictional-1", { livemode: false })]);
    await expect(pullRedbarkReview({ client: createRedbarkClient({ key: KEY, fetch: test.fetch, sleep: noSleep }), store: f.store, coverage: f.coverage, account: ACCOUNT, today: "2026-10-02", rules }))
      .rejects.toMatchObject({ code: "redbark_test_mode" });
    expect(f.store.list()).toHaveLength(0);
  });
});
