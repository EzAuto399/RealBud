// W1 host wiring end to end in one process: a FICTIONAL Redbark (fake fetch),
// the real review store and coverage cursor, the durable run, and the FICTIONAL
// REI-style portal through the real broker and recipe runner (w1-lab.ts).
// No network, no bank, no REI account: a pass proves wiring and guards only.
// Timeouts: windowsAdmissionTimeout counts were measured on macOS, where the
// polling helpers read the saved files more often, so they are a ceiling.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBankTransactions } from "./bank-provider.ts";
import { BankReferenceStore, RedbarkCoverage } from "./bank-reference-store.ts";
import { createW1Lab, labRedbarkFetch } from "./testing/w1-lab.ts";
import { FICTIONAL_BUSINESS, FICTIONAL_REICID } from "./testing/fictional-rei-portal.ts";
import { createTenantDirectoryStore, tenantDirectoryCsv, tenantListHash, type TenantEntry } from "./tenant-directory.ts";
import { tenantDirectoryRules } from "./bank-reference.ts";
import { loadPortalRecipePack, loadPortalRecipePackWithPaths, loadShippedPortalRecipePack } from "./portal-recipe-task.ts";
import { LEARNED_LEAK_LABEL, LEARNED_LEAK_RECIPE, publishLearnedInDataDir, saveApprovedPathInDataDir } from "./testing/learned-recipe-fixture.ts";
import { createW1Host } from "./w1-host.ts";
import { readReiAccount, REI_ACCOUNT_CONFLICT, saveReiAccount } from "./rei-account.ts";
import { REI_FRESH_MS } from "./source-gate.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import { windowsAdmissionTimeout } from "./testing/private-fixture.ts";

const ACCOUNT = "acct_FictionalTrust0001", CONNECTION = "conn_FictionalAnz0001";
const TODAY = "2026-10-02";
const dirs: string[] = [], dbs: WorkflowDatabase[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const txn = (id: string, date: string, cents: number, reference: string) => ({ id, object: "transaction", account: ACCOUNT, status: "posted", date, datetime: `${date}T02:00:00.000Z`,
  post_date: date, post_datetime: `${date}T03:00:00.000Z`, value_date: null, value_datetime: null, description: `FICTIONAL PAYMENT ${reference}`, reference,
  extended_description: null, amount: { amount: cents, currency: "aud" }, direction: cents < 0 ? "debit" : "credit", provider_category: null, category: null,
  merchant_name: null, merchant_category_code: null, livemode: true });

// The real loaders, wrapped so a test can see which one W1 used and what it got.
vi.mock("./portal-recipe-task.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./portal-recipe-task.ts")>();
  return { ...real, loadPortalRecipePack: vi.fn(real.loadPortalRecipePack), loadShippedPortalRecipePack: vi.fn(real.loadShippedPortalRecipePack),
    loadPortalRecipePackWithPaths: vi.fn(real.loadPortalRecipePackWithPaths) };
});

type HostExtras = Partial<Pick<Parameters<typeof createW1Host>[0], "openForSignIn" | "today" | "runtime" | "browserId" | "load" | "tenantDirectory">>;
async function fixture(extrasOrLab: HostExtras | ((lab: Awaited<ReturnType<typeof createW1Lab>>) => HostExtras) = {}) {
  const dir = mkdtempSync(join(tmpdir(), "realbud-w1-host-")); dirs.push(dir);
  const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 9) }); dbs.push(db);
  const bank = { rows: [txn("txn_fk_w1-1", "2026-10-01", 54000, "FT-BRAVO"), txn("txn_fk_w1-2", "2026-10-02", 36000, "FT-CHARLIE")] };
  const fetch = async (input: string) => {
    const url = new URL(input);
    const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, next_page_url: null, previous_page_url: null }), { status: 200 });
    if (url.pathname === "/v2/accounts") return list([{ id: ACCOUNT, object: "account_item", connection: CONNECTION, provider: "fiskil", category: "banking", name: "Fictional Trust",
      type: "transaction", institution: { id: "inst_fk", name: "Fictional Bank" }, account_number: "xxxx4321", currency: "aud", status: "available", last_updated_at: null, livemode: true }]);
    const from = url.searchParams.get("from")!, to = url.searchParams.get("to")!;
    return list(bank.rows.filter(row => row.date >= from && row.date <= to));
  };
  const lab = await createW1Lab(dir, { fetch: fetch as never });
  const store = new BankReferenceStore(db);
  // The office's property directory with each property's REI tenant (seeded by an earlier fictional review).
  const rules = [["FP-02", "FT-BRAVO", "Fictional Tenant Bravo"], ["FP-03", "FT-CHARLIE", "Fictional Tenant Charlie"], ["FP-06", "FT-GOLF", "Fictional Tenant Golf"]]
    .map(([propertyId, reference, tenant]) => ({ propertyId, reference, aliases: [reference], tenant }));
  store.create({ csv: "Date,Amount,Narrative,Reference\n2026-09-01,1.00,FICTIONAL SEED,\n", columns: { date: "Date", amount: "Amount", narrative: "Narrative", reference: "Reference" }, dateFormat: "YYYY-MM-DD", rules });
  const hold = { signIn: false };
  const extras = typeof extrasOrLab === "function" ? extrasOrLab(lab) : extrasOrLab;
  // The saved REI tenant directory's stamp: fresh unless a test moves it.
  const tenants = { directory: { savedAt: Date.now() } as { checkedAt?: number; savedAt?: number; hash?: string } | null };
  const host = createW1Host({ dataDir: dir, provider: () => lab.provider, coverage: new RedbarkCoverage(dir), store: () => store, today: async () => TODAY,
    tenantDirectory: () => tenants.directory, runtime: lab.runtime, browserId: lab.browserId, load: lab.load, lab, pollMs: 0, signInHolding: () => hold.signIn, ...extras });
  const call = async (path: string, method = "POST", body?: unknown) => {
    const result = await host.handle(path, method, new URL(`http://x${path}`).searchParams, async () => body);
    if (result.status !== 200) throw Object.assign(new Error(JSON.stringify(result.body)), { status: result.status });
    return result.body as Awaited<ReturnType<typeof host.status>>;
  };
  /** Waits for background work to stop, or for an ask to the person. */
  const settle = async () => {
    for (let i = 0; i < 400; i++) { const now = await host.status(); if (!now.working || now.ask) return now; await new Promise(r => setTimeout(r, 10)); }
    throw new Error("The run did not settle.");
  };
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    const now = await settle();
    await call(`/api/w1/runs/${now.run!.id}/${action}`, "POST", { expectedRevision: now.run!.revision, ...extra });
    return settle();
  };
  /** Answers every ask until the run stops asking; returns the tools asked about. */
  const answer = async (allowed = true) => {
    const tools: string[] = [];
    let now = await settle();
    expect(now.ask, JSON.stringify([now.note, now.run?.step, now.run?.attention, now.run?.log.slice(-3)])).not.toBeNull();
    while (now.ask) {
      tools.push(now.ask.tool);
      await call(`/api/w1/runs/${now.run!.id}/answer`, "POST", { requestId: now.ask.requestId, allowed });
      now = await settle();
    }
    return Object.assign(now, { tools });
  };
  /** Assigns each row to its one directory match; `decide` may hold or exclude a row instead (by its bank reference). */
  const review = async (batchId: string, decide: (reference: string) => "hold" | "exclude" | null = () => null) => {
    const saved = store.get(batchId);
    store.review(batchId, saved.revision, saved.value.batch.rows.map(row => {
      const other = decide(row.reference);
      return other ? { rowId: row.id, action: other, reason: "Fictional reviewer decision" } : { rowId: row.id, action: "assign" as const, propertyId: row.candidates[0], reason: "Fictional directory match" };
    }));
  };
  const configure = () => call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 0 });
  return { dir, db, host, lab, bank, call, settle, act, answer, review, store, fetch, hold, configure, tenants };
}

describe("W1 host", () => {
  it("runs pull → review → sign-in → upload preview → person posts → readback → confirm, and the next pull adds nothing", windowsAdmissionTimeout(413), async () => {
    const f = await fixture();
    await expect(f.call("/api/w1/runs/start")).rejects.toThrow(/Choose the bank account/);
    await f.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 0 });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    expect(now.run).toMatchObject({ step: "review", fetch: { from: "2026-09-30", to: TODAY, transactionIds: ["txn_fk_w1-1", "txn_fk_w1-2"] } });
    await f.review(now.run!.fetch!.batchId);
    now = await f.act("advance");
    expect(now.run, String(now.note)).toMatchObject({ step: "sign_in", attention: { reason: "sign_in" } });
    await f.lab.handle({ action: "sign-in" });
    now = await f.act("advance");
    let asked = await f.answer(); now = asked;
    expect(asked.tools).toContain("browser_upload");
    expect(now.run).toMatchObject({ step: "handoff", attention: null, handoff: { at: expect.any(String) } });
    expect(now.handoff).toContain("Posting is yours");
    expect((await f.lab.handle({ action: "status" }))).toMatchObject({ uploads: 1, effects: ["upload"] });
    await f.lab.handle({ action: "process" });
    now = await f.act("posting", { outcome: "posted" });
    asked = await f.answer(); now = asked;
    expect(asked.tools).toContain("browser_download");
    expect(asked.tools).not.toContain("browser_upload");
    expect(now.run).toMatchObject({ step: "done", outcome: "imported", confirm: { coveredThrough: TODAY } });
    expect(now.readback).toMatchObject({ accepted: 2, rejected: 0, pending: 0 });
    // Bud pressed nothing that posts.
    expect((await f.lab.handle({ action: "status" })).effects).toEqual(["upload"]);
    // The proof names the REI account by its business code alone; it is handed over only while that account is the saved one.
    const batchId = now.run!.fetch!.batchId;
    expect((await f.host.importProof(batchId))!.destination).toEqual({ portal: "rei-cloud", marker: FICTIONAL_BUSINESS });
    await f.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: "FICTOTHER", expectedRevision: 1, reiRevision: 1 });
    expect(await f.host.importProof(batchId)).toBeNull();
    await f.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 2, reiRevision: 2 });
    // The clock pulls the overlap again: nothing new, nothing duplicated.
    expect(await f.host.runLoop()).toMatchObject({ ok: true, status: "completed", detail: expect.stringMatching(/No new bank transactions/) });
    // A late posting inside the overlap arrives in the next pull, alone.
    f.bank.rows.push({ ...f.bank.rows[0], id: "txn_fk_w1-late", reference: "FT-GOLF", amount: { amount: 78000, currency: "aud" } });
    expect(await f.host.runLoop()).toMatchObject({ status: "awaiting-approval", detail: expect.stringMatching(/Pulled 1 bank/) });
    expect((await f.host.status()).run).toMatchObject({ step: "review", fetch: { transactionIds: ["txn_fk_w1-late"] } });
  });

  it("after a lost upload reply checks REI before any second upload, and holds a mismatched preview", windowsAdmissionTimeout(848), async () => {
    const f = await fixture();
    await f.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 0 });
    await f.lab.handle({ action: "sign-in" });
    await f.lab.handle({ action: "lost-reply" });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    now = await f.act("advance");
    let asked = await f.answer(); now = asked;
    // Readback first: after the upload, only the register download is asked, never a second upload.
    expect(asked.tools.filter(tool => tool === "browser_upload")).toHaveLength(1);
    expect(asked.tools.slice(asked.tools.indexOf("browser_upload") + 1)).toContain("browser_download");
    expect(now.run).toMatchObject({ step: "check_outcome", attention: { reason: "nothing_found" }, uncertain: { inspection: "nothing" } });
    expect((await f.lab.handle({ action: "status" })).uploads).toBe(1);
    now = await f.act("retry-upload");
    now = await f.answer();
    expect(now.run).toMatchObject({ step: "handoff", attention: null });
    expect((await f.lab.handle({ action: "status" })).uploads).toBe(2);
    await f.lab.handle({ action: "process" });
    await f.act("posting", { outcome: "posted" });
    now = await f.answer();
    expect(now.run).toMatchObject({ outcome: "imported" });
    // A late posting whose REI preview differs: held, never handed over.
    f.bank.rows.push({ ...f.bank.rows[0], id: "txn_fk_w1-late", reference: "FT-GOLF", description: "FICTIONAL PAYMENT FT-GOLF", amount: { amount: 78000, currency: "aud" } });
    await f.lab.handle({ action: "mismatch" });
    await f.call("/api/w1/runs/start");
    now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    await f.act("advance");
    now = await f.answer();
    expect(now.run).toMatchObject({ step: "handoff", attention: { reason: "preview_mismatch" } });
    expect(now.run!.upload!.preview!.warnings.join(" ")).toMatch(/FT-GOLF 780.00: REI shows a different amount/);
    await expect(f.act("posting", { outcome: "posted" })).rejects.toThrow(/not waiting for posting/);
    now = await f.act("abandon");
    expect(now.run).toMatchObject({ outcome: "abandoned" });
  });

  it("imports a batch with a held debit and an excluded credit: only the import rows go to REI and are confirmed", windowsAdmissionTimeout(346), async () => {
    const f = await fixture();
    f.bank.rows.push(txn("txn_fk_w1-3", "2026-10-02", 78000, "FT-GOLF"), txn("txn_fk_w1-debit", "2026-10-02", -1500, "FICTIONAL FEE"), txn("txn_fk_w1-unclear", "2026-10-01", 12000, "FICTIONAL UNKNOWN"));
    await f.configure();
    await f.lab.handle({ action: "sign-in" });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    expect(now.run!.fetch!.transactionIds).toHaveLength(5);
    await f.review(now.run!.fetch!.batchId, reference => reference === "FICTIONAL FEE" ? "hold" : reference === "FICTIONAL UNKNOWN" ? "exclude" : null);
    await f.act("advance");
    now = await f.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "handoff", attention: null,
      review: { importIds: expect.arrayContaining(["txn_fk_w1-1", "txn_fk_w1-2", "txn_fk_w1-3"]), heldIds: ["txn_fk_w1-debit"], excludedIds: ["txn_fk_w1-unclear"] } });
    expect(now.run!.review!.importIds).toHaveLength(3);
    expect(now.run!.upload!.preview!.rows).toHaveLength(3);
    await f.lab.handle({ action: "process" });
    await f.act("posting", { outcome: "posted" });
    now = await f.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "done", outcome: "imported" });
    expect(now.readback).toMatchObject({ accepted: 3, rejected: 0, pending: 0 });
    expect(now.run!.readback!.rows.map(row => row.transactionId).sort()).toEqual(["txn_fk_w1-1", "txn_fk_w1-2", "txn_fk_w1-3"]);
    // The held debit is not confirmed: the next pull offers it again for review.
    expect(await f.host.runLoop()).toMatchObject({ status: "awaiting-approval", detail: expect.stringMatching(/Pulled 1 bank/) });
    expect((await f.host.status()).run).toMatchObject({ step: "review", fetch: { transactionIds: ["txn_fk_w1-debit"] } });
  });

  it("after a lost reply whose file reached REI, finds it pending and hands it to the person instead of uploading again", windowsAdmissionTimeout(432), async () => {
    const f = await fixture();
    await f.configure();
    await f.lab.handle({ action: "sign-in" });
    await f.lab.handle({ action: "lost-reply-after" });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    await f.act("advance");
    now = await f.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "handoff", attention: null, uncertain: null, handoff: { at: expect.any(String) } });
    expect(now.handoff).toBe("Your earlier upload is waiting in REI. Process or delete it there.");
    expect(await f.lab.handle({ action: "status" })).toMatchObject({ uploads: 1, pending: true });
    await f.lab.handle({ action: "process" });
    await f.act("posting", { outcome: "posted" });
    now = await f.answer();
    expect(now.run).toMatchObject({ outcome: "imported" });
    expect((await f.lab.handle({ action: "status" })).uploads).toBe(1);
  });

  it("Stop ends the REI stage in flight and starts nothing more; a sign-in handover holds every REI stage", windowsAdmissionTimeout(328), async () => {
    const f = await fixture();
    await f.configure();
    await f.lab.handle({ action: "sign-in" });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    f.hold.signIn = true;
    now = await f.act("advance");
    expect(now.run).toMatchObject({ step: "sign_in" });
    expect(now.note).toBe("Finish the saved sign-in handover before starting more browser work.");
    expect(now.ask).toBeNull();
    f.hold.signIn = false;
    // Stop while the upload waits for the person's approval.
    await f.call(`/api/w1/runs/${now.run!.id}/advance`, "POST", { expectedRevision: now.run!.revision });
    now = await f.settle();
    while (now.ask && now.ask.tool !== "browser_upload") { await f.call(`/api/w1/runs/${now.run!.id}/answer`, "POST", { requestId: now.ask.requestId, allowed: true }); now = await f.settle(); }
    expect(now.ask?.tool).toBe("browser_upload");
    now = await f.call(`/api/w1/runs/${now.run!.id}/stop`, "POST", {});
    expect(now).toMatchObject({ working: false, ask: null, note: "Stopped. Bud did nothing more in REI. Check the import before continuing." });
    expect(now.run!.step).not.toBe("handoff");
    expect(await f.lab.handle({ action: "status" })).toMatchObject({ uploads: 0, effects: [] });
    // The upload ask was open, so the runner cannot prove nothing left: REI is checked before anything else.
    expect(now.run).toMatchObject({ step: "check_outcome", attention: { reason: "outcome_unknown" } });
    await f.act("advance");
    now = await f.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "check_outcome", attention: { reason: "nothing_found" }, uncertain: { inspection: "nothing" } });
    expect((await f.lab.handle({ action: "status" })).uploads).toBe(0);
  });

  it("Stop during an advance's setup cancels it: no REI stage runs and nothing is uploaded", async () => {
    let gate: Promise<void> | null = null, release = () => {};
    const f = await fixture({ today: async () => { await gate; return TODAY; } });
    await f.configure();
    await f.lab.handle({ action: "sign-in" });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    const before = now.run!;
    gate = new Promise(resolve => { release = resolve; });
    await f.call(`/api/w1/runs/${before.id}/advance`, "POST", { expectedRevision: before.revision });
    // Stop arrives while the advance still waits on its setup.
    const stopped = f.call(`/api/w1/runs/${before.id}/stop`, "POST", {});
    release();
    now = await stopped;
    expect(now).toMatchObject({ working: false, ask: null, note: "Stopped. Bud did nothing more in REI. Check the import before continuing." });
    expect(now.run).toMatchObject({ step: before.step, revision: before.revision });
    expect(await f.lab.handle({ action: "status" })).toMatchObject({ uploads: 0, effects: [] });
  });

  // What an update restart reads (server/index.ts /api/health): `working` holds every restart, `asks` only the automatic one.
  it("a person-started advance doing work counts as working, at an ask as one approval, and at REI's sign-in as neither", windowsAdmissionTimeout(255), async () => {
    let gate: Promise<void> | null = null, release = () => {}, signedIn = () => {};
    const f = await fixture(made => ({
      today: async () => { await gate; return TODAY; },
      openForSignIn: async () => { await new Promise<void>(resolve => { signedIn = resolve; }); await made.handle({ action: "sign-in" }); return { outcome: "signed_in" as const, origin: "https://rei-mock.fictional.test" }; } }));
    await f.configure();
    expect(f.host.activity()).toEqual({ working: 0, asks: 0 });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    gate = new Promise(resolve => { release = resolve; });
    await f.call(`/api/w1/runs/${now.run!.id}/advance`, "POST", { expectedRevision: now.run!.revision });
    expect(f.host.activity()).toEqual({ working: 1, asks: 0 });
    release();
    // Waiting for the person to sign in to REI: neither.
    await vi.waitFor(async () => expect((await f.host.status()).signIn).toBeTruthy(), { timeout: 5_000 });
    expect(f.host.activity()).toEqual({ working: 0, asks: 0 });
    signedIn();
    now = await f.settle();
    expect(now.ask, String(now.note)).not.toBeNull();
    expect(f.host.activity()).toEqual({ working: 0, asks: 1 });
    now = await f.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "handoff" });
    expect(f.host.activity()).toEqual({ working: 0, asks: 0 });
  });

  it("a scheduled run waiting at REI's sign-in is neither working nor an approval; its upload ask is one", windowsAdmissionTimeout(255), async () => {
    let signedIn = () => {};
    const f = await fixture(made => ({
      openForSignIn: async () => { await new Promise<void>(resolve => { signedIn = resolve; }); await made.handle({ action: "sign-in" }); return { outcome: "signed_in" as const, origin: "https://rei-mock.fictional.test" }; } }));
    await f.configure();
    await f.call("/api/w1/runs/start");
    const reviewed = await f.settle();
    await f.review(reviewed.run!.fetch!.batchId);
    const notes: Array<[string, boolean | undefined]> = [];
    const loop = f.host.runLoop((detail, waiting) => { notes.push([detail, waiting]); });
    await vi.waitFor(async () => expect((await f.host.status()).signIn).toBeTruthy(), { timeout: 5_000 });
    expect(f.host.activity()).toEqual({ working: 0, asks: 0 });
    // Schedule hears that the run waits on the person (server/routines.ts noteRun), so its clock is not `working` either.
    expect(notes.at(-1)).toEqual([expect.stringMatching(/^Sign in to REI Cloud so Bud can finish the bank import/), true]);
    signedIn();
    await vi.waitFor(async () => expect((await f.host.status()).ask).toBeTruthy(), { timeout: 5_000 });
    expect(f.host.activity()).toEqual({ working: 0, asks: 1 });
    expect(notes.at(-1)).toEqual([expect.stringMatching(/^Waiting for/), true]);
    const answered = await f.answer();
    expect(answered.tools).toContain("browser_upload");
    expect(await loop).toMatchObject({ status: "awaiting-approval" });
    expect(f.host.activity()).toEqual({ working: 0, asks: 0 });
    // Each answered ask said the run works again.
    expect(notes).toContainEqual(["Allowed. Uploading the reviewed bank file to REI.", undefined]);
  });

  it("self-serve REI sign-in: opens REI for the person and continues once signed in; wrong account or a timeout stays put", windowsAdmissionTimeout(312), async () => {
    const outcomes: Array<"signed_in" | "stopped" | "timed_out" | "wrong_account"> = ["timed_out", "wrong_account", "signed_in"];
    const calls: Array<{ site: string; reason: string; signal: boolean }> = [];
    let lab: Awaited<ReturnType<typeof fixture>>["lab"] | null = null;
    const f = await fixture({ openForSignIn: async input => {
      calls.push({ site: input.site, reason: input.reason, signal: input.signal instanceof AbortSignal });
      const outcome = outcomes.shift()!;
      if (outcome === "signed_in") await lab!.handle({ action: "sign-in" });
      return { outcome, origin: "https://rei-mock.fictional.test" };
    } });
    lab = f.lab;
    await f.configure();
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    now = await f.act("advance");
    expect(now.run).toMatchObject({ step: "sign_in", attention: { reason: "sign_in" } });
    now = await f.act("advance");
    expect(now.run).toMatchObject({ step: "sign_in", attention: { reason: "account_mismatch" } });
    await f.act("advance");
    now = await f.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "handoff", attention: null });
    expect(calls).toEqual(Array(3).fill({ site: "rei-cloud", reason: "Import bank receipts", signal: true }));
  });

  it("cold start: opens the work browser, hands REI's sign-in page to the person, then continues", windowsAdmissionTimeout(234), async () => {
    const browser = { open: false, connects: 0, signIns: 0 };
    let lab: Awaited<ReturnType<typeof createW1Lab>> | null = null;
    const f = await fixture(made => { lab = made; return {
      runtime: Object.assign(made.runtime, { connect: async () => { browser.connects++; browser.open = true; return {}; } }),
      browserId: async () => browser.open ? made.browserId() : null,
      openForSignIn: async () => { browser.signIns++; await lab!.handle({ action: "sign-in" }); return { outcome: "signed_in" as const, origin: "https://rei-mock.fictional.test" }; } }; });
    await f.configure();
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    await f.act("advance");
    now = await f.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "handoff", attention: null });
    expect(browser).toEqual({ open: true, connects: 1, signIns: 1 });
  });

  it("cold start: refuses with plain copy only when the work browser cannot be opened", async () => {
    let signIns = 0;
    const f = await fixture(made => ({
      runtime: Object.assign(made.runtime, { connect: async () => { throw new Error("no Chrome"); } }),
      browserId: async () => null,
      openForSignIn: async () => { signIns++; return { outcome: "signed_in" as const, origin: "https://rei-mock.fictional.test" }; } }));
    await f.configure();
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    now = await f.act("advance");
    expect(now.run).toMatchObject({ step: "sign_in" });
    expect(now.note).toBe("The work browser could not be opened. Check that Chrome or Edge is installed, then try again.");
    expect(signIns).toBe(0);
    expect(await f.lab.handle({ action: "status" })).toMatchObject({ uploads: 0, effects: [] });
  });

  it("saves the REI account by its top-bar business code with ANZ(csv file) by default; a saved reicid still works", windowsAdmissionTimeout(225), async () => {
    const f = await fixture();
    const saved = await f.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 0 }) as unknown as { settings: Record<string, unknown> };
    expect(saved.settings).toMatchObject({ rei: { marker: FICTIONAL_BUSINESS }, bankFormat: "ANZ(csv file)" });
    expect(saved.settings.rei).not.toHaveProperty("urlValue");
    // A business code REI could not show is refused as input; nothing is saved.
    await expect(f.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: "FICT 1", expectedRevision: 1 })).rejects.toMatchObject({ status: 400 });
    expect((await f.call("/api/w1/status", "GET") as unknown as { settings: { revision: number; rei: unknown } }).settings).toMatchObject({ revision: 1, rei: { marker: FICTIONAL_BUSINESS } });
    // A bank setup form opened before another business code was saved through /api/rei/account never overwrites it.
    const stale = await fixture();
    await saveReiAccount(stale.dir, { marker: "FICTOTHER" }, 0);
    await expect(stale.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 0 })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(REI_ACCOUNT_CONFLICT) });
    await expect(stale.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 0, reiRevision: 0 })).rejects.toMatchObject({ status: 409 });
    expect(await readReiAccount(stale.dir)).toMatchObject({ marker: "FICTOTHER", revision: 1 });
    expect((await stale.call("/api/w1/status", "GET")).settings).toBeNull();
    // The same business code needs no change; the revision the person saw saves a new one.
    expect((await stale.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: "FICTOTHER", expectedRevision: 0 })).settings).toMatchObject({ rei: { marker: "FICTOTHER" } });
    await stale.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 1, reiRevision: 1 });
    expect(await readReiAccount(stale.dir)).toMatchObject({ marker: FICTIONAL_BUSINESS, revision: 2 });
    // An office that saved a reicid keeps it: the run's destination stays that reicid, and it signs in and uploads with no reicid in REI's addresses.
    const legacy = await fixture();
    await legacy.call("/api/w1/settings", "PUT", { account: ACCOUNT, reiAccount: FICTIONAL_REICID, reiBusiness: FICTIONAL_BUSINESS, bankFormat: "ANZ(csv file)", expectedRevision: 0 });
    await legacy.lab.handle({ action: "sign-in" });
    await legacy.call("/api/w1/runs/start");
    let now = await legacy.settle();
    expect(now.run!.destination).toBe(FICTIONAL_REICID);
    await legacy.review(now.run!.fetch!.batchId);
    await legacy.act("advance");
    now = await legacy.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "handoff", attention: null });
  });

  it("reads a pending import only on Bulk Receipting: a pending-import recipe that opens Pending Transactions is never run", windowsAdmissionTimeout(297), async () => {
    const f = await fixture(made => ({ load: async () => {
      const pack = await made.load();
      const recipe = pack.recipes["bulk-receipting-pending"];
      return { ...pack, recipes: { ...pack.recipes, "bulk-receipting-pending": { ...recipe, steps: [{ nav: ["Process", "Pending Transactions"] }, ...recipe.steps.slice(1)] } } };
    } }));
    await f.configure();
    await f.lab.handle({ action: "sign-in" });
    await f.lab.handle({ action: "lost-reply" });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    await f.act("advance");
    now = await f.answer();
    // The register shows nothing, but without a Bulk Receipting read nothing proves the file is not pending: no re-upload is offered.
    expect(now.run, String(now.note)).toMatchObject({ step: "check_outcome", uncertain: { inspection: "unknown" } });
    expect(now.note).toMatch(/does not open REI's Bulk Receipting page/);
    expect((await f.lab.handle({ action: "status" })).uploads).toBe(1);
  });

  describe("REI tenant freshness gates only batches whose tenants came from the saved REI tenant list", () => {
    const tenant = (reference: string, property: string): TenantEntry => ({ reference, property, surname: "Fictional", firstname: "Tenant", rent: "", bpay: "" });
    /** A pulled and reviewed batch; `list` is the REI tenant list saved before the pull (null: none, so only the office's rules). */
    async function reviewed(list: TenantEntry[] | null, savedAt: () => number = Date.now) {
      const f = await fixture();
      if (list) createTenantDirectoryStore(f.db, savedAt).save({ tenants: list, source: { name: "fictional-tenants.csv", sha256: "a".repeat(64), rows: list.length }, expectedRevision: 0 });
      f.tenants.directory = createTenantDirectoryStore(f.db).freshness();
      await f.configure();
      await f.lab.handle({ action: "sign-in" });
      await f.call("/api/w1/runs/start");
      const now = await f.settle();
      await f.review(now.run!.fetch!.batchId);
      return f;
    }
    const STALE = { savedAt: Date.now() - REI_FRESH_MS - 60_000 };
    const refused = async (f: Awaited<ReturnType<typeof reviewed>>, sentence = "Refresh REI tenants first.") => {
      // A refusal is an unknown outcome with its own sentence, never "REI shows nothing", never a re-upload.
      const now = await f.act("advance");
      expect(now.note).toBe(sentence);
      expect(now.run).toMatchObject({ step: "check_outcome", attention: { reason: "outcome_unknown" }, uncertain: { inspection: "unknown" } });
      expect(now.ask).toBeNull();
      await expect(f.act("retry-upload")).rejects.toMatchObject({ status: 409 });
      expect(await f.lab.handle({ action: "status" })).toMatchObject({ uploads: 0, effects: [] });
    };

    it("a batch from the office's rules alone goes to REI with no saved tenant list", windowsAdmissionTimeout(255), async () => {
      const f = await reviewed(null);
      expect(f.store.tenantSource((await f.host.status()).run!.fetch!.batchId)).toEqual({ source: "bank-rules" });
      await f.act("advance");
      const now = await f.answer();
      expect(now.run, String(now.note)).toMatchObject({ step: "handoff", attention: null });
    });

    it("a directory batch is refused while the list is stale or unstamped, and goes to REI once it is fresh", windowsAdmissionTimeout(255), async () => {
      const f = await reviewed([tenant("FT-BRAVO", "FP-02"), tenant("FT-CHARLIE", "FP-03")]);
      expect(f.store.tenantSource((await f.host.status()).run!.fetch!.batchId)).toMatchObject({ source: "rei-directory", propertyIds: ["FP-02", "FP-03"] });
      for (const stale of [null, {}, STALE]) { f.tenants.directory = stale; await refused(f); }
      // Refreshed: the check reads REI's complete register, which shows nothing, and only then is a second upload offered.
      f.tenants.directory = { ...createTenantDirectoryStore(f.db).freshness()!, checkedAt: Date.now() - REI_FRESH_MS + 60_000 };
      await f.act("advance");
      let now = await f.answer();
      expect(now.run, String(now.note)).toMatchObject({ step: "check_outcome", attention: { reason: "nothing_found" } });
      await f.act("retry-upload");
      now = await f.answer();
      expect(now.tools).toContain("browser_upload");
      expect(now.note).not.toBe("Refresh REI tenants first.");
      expect((await f.lab.handle({ action: "status" }) as { uploads: number }).uploads).toBe(1);
    });

    it("an unchanged REI refresh 25 hours after the save renews the list: the batch goes to REI", windowsAdmissionTimeout(255), async () => {
      const list = [tenant("FT-BRAVO", "FP-02"), tenant("FT-CHARLIE", "FP-03")];
      const f = await reviewed(list, () => Date.now() - 25 * 60 * 60_000);
      await refused(f);
      // Refresh from REI reads the same list (nothing to save) and records the check.
      expect(createTenantDirectoryStore(f.db).markChecked(list)).toBe(true);
      f.tenants.directory = createTenantDirectoryStore(f.db).freshness();
      await f.act("advance");
      let now = await f.answer();
      expect(now.run, String(now.note)).toMatchObject({ step: "check_outcome", attention: { reason: "nothing_found" } });
      await f.act("retry-upload");
      now = await f.answer();
      expect(now.tools).toContain("browser_upload");
    });

    it("a batch built from an older tenant list is refused before sending: prepare it again, never a re-upload", windowsAdmissionTimeout(255), async () => {
      const f = await reviewed([tenant("FT-BRAVO", "FP-02"), tenant("FT-CHARLIE", "FP-03")]);
      createTenantDirectoryStore(f.db).save({ tenants: [tenant("FT-BRAVO", "FP-02")], source: { name: "fictional-tenants.csv", sha256: "b".repeat(64), rows: 1 }, expectedRevision: 1 });
      f.tenants.directory = createTenantDirectoryStore(f.db).freshness();
      await refused(f, "The REI tenant list changed since this batch was prepared. Prepare it again.");
      // Checking again changes nothing: still unknown with the same sentence, and nothing was sent.
      let now = await f.act("advance");
      expect(now.note).toBe("The REI tenant list changed since this batch was prepared. Prepare it again.");
      expect(now.run).toMatchObject({ attention: { reason: "outcome_unknown" } });
      expect(await f.lab.handle({ action: "status" })).toMatchObject({ uploads: 0, effects: [] });
      // RealBud refused before the upload stage started, and its saved evidence says so: "Close and prepare again" directly.
      expect(now.closable).toBe(true);
      now = await f.act("abandon");
      expect(now.run).toMatchObject({ step: "done", outcome: "abandoned" });
    });

    const OLDER = "This review was made with an older REI tenant list. Correct the mapping before preparing it again.";
    const saveList = (f: { db: WorkflowDatabase; tenants: { directory: unknown } }, list: TenantEntry[], expectedRevision: number) => {
      createTenantDirectoryStore(f.db).save({ tenants: list, source: { name: "fictional-tenants.csv", sha256: String(expectedRevision).repeat(64), rows: list.length }, expectedRevision });
      f.tenants.directory = createTenantDirectoryStore(f.db).freshness();
    };

    it("a batch no one reviewed is rebuilt from the changed list once its import is closed, and goes to REI", windowsAdmissionTimeout(255), async () => {
      const f = await fixture();
      saveList(f, [tenant("FT-BRAVO", "FP-02"), tenant("FT-CHARLIE", "FP-03")], 0);
      await f.configure();
      await f.lab.handle({ action: "sign-in" });
      await f.call("/api/w1/runs/start");
      const batchId = (await f.settle()).run!.fetch!.batchId;
      saveList(f, [tenant("FT-BRAVO", "FP-02")], 1);
      const hints = vi.spyOn(f.store, "addJevHints");
      // A pull while the open import still holds the batch: never rebuilt under it.
      await expect(f.call("/api/w1/pull", "POST", { account: ACCOUNT })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(OLDER) });
      expect(f.store.get(batchId).revision).toBe(1);
      await f.act("abandon");
      // Prepared again: the same record, rebuilt from the current list as a new revision; Jev is not asked again.
      await f.call("/api/w1/runs/start");
      let now = await f.settle();
      expect(now.run).toMatchObject({ step: "review", fetch: { batchId } });
      expect(f.store.get(batchId).revision).toBe(2);
      expect(f.store.tenantSource(batchId)).toMatchObject({ source: "rei-directory", hash: tenantListHash([tenant("FT-BRAVO", "FP-02")]) });
      expect(hints).not.toHaveBeenCalled();
      await f.review(batchId);
      await f.act("advance");
      const sent = await f.answer();
      expect(sent.tools).toContain("browser_upload");
      // Past the gate and sent (the fictional REI names directory tenants differently, so its preview is not compared here).
      expect(sent.run).toMatchObject({ step: "handoff", upload: { batchId } });
      expect((await f.lab.handle({ action: "status" }) as { uploads: number }).uploads).toBe(1);
    });

    it("a reviewed batch from an older list is never rebuilt: closed, prepared again, it asks for a corrected mapping, which then goes to REI", windowsAdmissionTimeout(255), async () => {
      const f = await reviewed([tenant("FT-BRAVO", "FP-02"), tenant("FT-CHARLIE", "FP-03")]);
      const batchId = (await f.host.status()).run!.fetch!.batchId, source = f.store.tenantSource(batchId);
      saveList(f, [tenant("FT-BRAVO", "FP-02")], 1);
      await refused(f, "The REI tenant list changed since this batch was prepared. Prepare it again.");
      await f.act("abandon");
      await f.call("/api/w1/runs/start");
      let now = await f.settle();
      expect(now.note).toBe(OLDER);
      expect(now.run).toMatchObject({ step: "fetch", attention: { reason: "fetch_failed" } });
      // Left as the person reviewed it, with the list it was built from.
      const saved = f.store.get(batchId);
      expect(saved).toMatchObject({ revision: 2, value: { result: expect.any(Object), decisions: expect.any(Array) } });
      expect(f.store.tenantSource(batchId)).toEqual(source);
      // Correct mapping or decisions: a new review built on the current list, reviewed, then the run is prepared again.
      const { columns, dateFormat, rules } = saved.value.batch.input;
      const next = f.store.amend(batchId, { mapping: { columns, dateFormat, rules: tenantDirectoryRules(tenantDirectoryCsv([tenant("FT-BRAVO", "FP-02")]), rules) }, reason: "Fictional: current REI tenant list", revision: saved.revision });
      // FT-CHARLIE is no longer on REI's list: the person holds that payment.
      await f.review(next.id, reference => reference === "FT-CHARLIE" ? "hold" : null);
      await f.act("advance");
      const sent = await f.answer();
      expect(sent.tools).toContain("browser_upload");
      expect(sent.run).toMatchObject({ step: "handoff", upload: { batchId: next.id } });
      expect((await f.lab.handle({ action: "status" }) as { uploads: number }).uploads).toBe(1);
    });

    it("an upload whose reply was lost can't be closed until REI's register shows nothing", windowsAdmissionTimeout(255), async () => {
      const f = await reviewed(null);
      await f.lab.handle({ action: "lost-reply" });
      await f.act("advance");
      // Allow the baseline read and the upload, decline the register download after it: the outcome stays unknown.
      let now = await f.settle(), uploaded = false;
      while (now.ask) {
        const allowed = !uploaded;
        uploaded ||= now.ask.tool === "browser_upload";
        await f.call(`/api/w1/runs/${now.run!.id}/answer`, "POST", { requestId: now.ask.requestId, allowed });
        now = await f.settle();
      }
      expect(uploaded).toBe(true);
      expect(now.run).toMatchObject({ step: "check_outcome", uncertain: { kind: "upload", inspection: "unknown" } });
      expect(now.closable).toBe(false);
      await expect(f.act("abandon")).rejects.toMatchObject({ status: 409 });
      // Once REI's complete register shows nothing, it may be closed.
      await f.act("advance");
      now = await f.answer();
      expect(now.run).toMatchObject({ attention: { reason: "nothing_found" } });
      expect((await f.act("abandon")).run).toMatchObject({ step: "done", outcome: "abandoned" });
    });

    it("a batch mixing the saved list and the office's rules is refused while the list is stale", windowsAdmissionTimeout(255), async () => {
      const f = await reviewed([tenant("FT-BRAVO", "FP-02")]);
      expect(f.store.tenantSource((await f.host.status()).run!.fetch!.batchId)).toMatchObject({ source: "rei-directory", propertyIds: ["FP-02"] });
      f.tenants.directory = STALE;
      await refused(f);
    });
  });

  it("an incomplete Receipt Register is never proof that nothing reached REI: no upload is offered", windowsAdmissionTimeout(255), async () => {
    // The register is exported for a period that ends before the batch: REI's file does not cover the window.
    const f = await fixture(lab => ({ load: async () => {
      const pack = await lab.load(), recipe = pack.recipes["receipt-register"];
      return { ...pack, recipes: { ...pack.recipes, "receipt-register": { ...recipe, steps: recipe.steps.map(step => "type" in step && (step.type as { field?: string }).field === "To Date" ? { type: { field: "To Date", value: "2026-09-01" } } : step) } } };
    } }));
    await f.configure();
    await f.lab.handle({ action: "sign-in" });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    await f.review(now.run!.fetch!.batchId);
    await f.act("advance");
    now = await f.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "check_outcome", attention: { reason: "outcome_unknown" }, uncertain: { inspection: "unknown" } });
    expect(String(now.note)).toMatch(/does not show that it covers the whole date range/);
    await expect(f.act("retry-upload")).rejects.toMatchObject({ status: 409 });
    expect(await f.lab.handle({ action: "status" })).toMatchObject({ uploads: 0, effects: [] });
  });

  it("a different business in REI's top bar stops the run before anything is uploaded", windowsAdmissionTimeout(255), async () => {
    const f = await fixture();
    await f.configure();
    await f.lab.handle({ action: "sign-in" });
    await f.call("/api/w1/runs/start");
    let now = await f.settle();
    expect(now.run!.destination).toBe(FICTIONAL_BUSINESS);
    await f.review(now.run!.fetch!.batchId);
    await f.lab.handle({ action: "switch-business" });
    now = await f.act("advance");
    expect(now.run, String(now.note)).toMatchObject({ step: "sign_in", attention: { reason: "account_mismatch" } });
    expect(await f.lab.handle({ action: "status" })).toMatchObject({ uploads: 0, effects: [] });
    await f.lab.handle({ action: "restore-business" });
    await f.act("advance");
    now = await f.answer();
    expect(now.run, String(now.note)).toMatchObject({ step: "handoff", attention: null });
  });

  it("reads transactions read-only through the provider: shape, 93-day limit and not connected", async () => {
    const f = await fixture();
    const query = (from: string, to: string) => new URLSearchParams({ account: ACCOUNT, from, to });
    expect(await readBankTransactions(f.lab.provider, query("2026-09-30", TODAY))).toEqual({ status: 200, body: {
      account: { id: ACCOUNT, name: "Fictional Trust", institution: "Fictional Bank", numberMasked: "····4321" }, from: "2026-09-30", to: TODAY, truncated: false,
      transactions: [
        { id: "txn_fk_w1-2", postDate: TODAY, description: "FICTIONAL PAYMENT FT-CHARLIE", reference: "FT-CHARLIE", direction: "credit", amountCents: 36000, currency: "AUD" },
        { id: "txn_fk_w1-1", postDate: "2026-10-01", description: "FICTIONAL PAYMENT FT-BRAVO", reference: "FT-BRAVO", direction: "credit", amountCents: 54000, currency: "AUD" }] } });
    expect(await readBankTransactions(f.lab.provider, query("2026-06-30", TODAY))).toMatchObject({ status: 400, body: { error: expect.stringMatching(/93 days/) } });
    expect(await readBankTransactions(f.lab.provider, query(TODAY, "2026-09-30"))).toMatchObject({ status: 400 });
    expect(await readBankTransactions(null, query("2026-09-30", TODAY))).toEqual({ status: 409, body: { error: "Connect Redbark in Workspace → Connected apps.", code: "bank_not_connected" } });
    // No review batch and no coverage from a read.
    expect((await f.host.handle("/api/w1/coverage", "GET", new URLSearchParams({ account: ACCOUNT }), async () => undefined)).body).toMatchObject({ coveredThrough: null });
    expect(f.store.page().total).toBe(1);
  });

  it("answers bank_not_connected until a provider is connected, and the lab Redbark must be loopback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-w1-host-")); dirs.push(dir);
    const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 9) }); dbs.push(db);
    const lab = await createW1Lab(dir);
    const host = createW1Host({ dataDir: dir, provider: () => null, coverage: new RedbarkCoverage(dir), store: () => new BankReferenceStore(db), today: async () => TODAY, tenantDirectory: () => null,
      runtime: lab.runtime, browserId: lab.browserId, load: lab.load, pollMs: 0 });
    await expect(host.handle("/api/w1/accounts", "GET", new URLSearchParams(), async () => undefined)).rejects.toMatchObject({ status: 409, code: "bank_not_connected" });
    expect(() => labRedbarkFetch("http://evil.example:4555")).toThrow(/loopback/);
    const real = async (input: string) => new Response(input);
    expect(await (await labRedbarkFetch("http://127.0.0.1:4555", real as never)("https://api.redbark.com/v2/accounts?limit=1", {} as never)).text()).toBe("http://127.0.0.1:4555/v2/accounts?limit=1");
  });
});

describe("W1 and watch-and-learn recipes", () => {
  it("keeps a person-approved path but never a learned recipe or a label a reviewer confirmed", async () => {
    const forget = await publishLearnedInDataDir();
    const restore = await saveApprovedPathInDataDir();
    const shipped = await loadShippedPortalRecipePack("rei-cloud");
    try {
      const merged = await loadPortalRecipePack("rei-cloud");
      expect(merged.recipes[LEARNED_LEAK_RECIPE]).toBeDefined();
      // The confirmation stays with its recipe; the Ask pack's read-safe list is the shipped one.
      expect(merged.recipes[LEARNED_LEAK_RECIPE]).toMatchObject({ confirmed: [LEARNED_LEAK_LABEL] });
      expect(merged.labels.readSafe).toEqual(shipped.labels.readSafe);
      vi.mocked(loadPortalRecipePack).mockClear(); vi.mocked(loadPortalRecipePackWithPaths).mockClear();

      // No injected `load`: the host picks its own loader on the way to REI.
      const f = await fixture({ load: undefined });
      await f.configure();
      await f.call("/api/w1/runs/start");
      const now = await f.settle();
      await f.review(now.run!.fetch!.batchId);
      await f.act("advance");
      expect(loadPortalRecipePack).not.toHaveBeenCalled();
      expect(loadPortalRecipePackWithPaths).toHaveBeenCalledWith("rei-cloud");
      for (const { value } of vi.mocked(loadPortalRecipePackWithPaths).mock.results) {
        const used = await value;
        expect(used.recipes["tenant-list"].steps).toContainEqual({ download: { label: "Export" } }); // the approved path
        expect(Object.keys(used.recipes).filter(name => name.startsWith("learned-"))).toEqual([]);
        expect(used.labels.readSafe).toEqual(shipped.labels.readSafe);
        expect(JSON.stringify(used)).not.toContain(LEARNED_LEAK_LABEL); // not read-safe, not a learned set, not a recipe's `confirmed`
      }
    } finally { forget(); await restore(); }
  });
});
