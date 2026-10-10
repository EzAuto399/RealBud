// Scheduled REI sign-in waits: the deadline, the midday reminder, the saved
// wait a restart picks up, and the W1 bank import and Supplier list check
// carrying on by themselves once the person signs in. FICTIONAL Redbark (fake
// fetch) and the FICTIONAL REI-style portal through the real broker and recipe
// runner (w1-lab.ts). A pass proves RealBud's wiring and guards only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BankReferenceStore, RedbarkCoverage } from "./bank-reference-store.ts";
import { createReiDirectorySync, SUPPLIER_MISSED } from "./rei-directory-sync.ts";
import { createSupplierDirectory } from "./supplier-directory.ts";
import { createTenantDirectoryStore } from "./tenant-directory.ts";
import { createW1Lab } from "./testing/w1-lab.ts";
import { FICTIONAL_BUSINESS } from "./testing/fictional-rei-portal.ts";
import { createW1Host, W1_MISSED, type W1HostDeps } from "./w1-host.ts";
import { newReiWait, officeTimeToday, reiSignInWaits, resumableReiWaits, withReiSignInWait } from "./w1-sign-in-wait.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import type { BrowserTaskGrant } from "../shared/browser-task.ts";

/** Every grant the host issues, as the recipe runner receives it. */
const seen = vi.hoisted(() => ({ grants: [] as BrowserTaskGrant[] }));
vi.mock("./portal-recipe-runner.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./portal-recipe-runner.ts")>();
  return { ...actual, runPortalRecipes: ((input: Parameters<typeof actual.runPortalRecipes>[0]) => { seen.grants.push(input.grant); return actual.runPortalRecipes(input); }) as typeof actual.runPortalRecipes };
});

const ZONE = "Australia/Brisbane", DAY = "2026-10-06";
const at = (time: string) => `${DAY}T${time}:00+10:00`;
const ACCOUNT = "acct_FictionalTrust0001", CONNECTION = "conn_FictionalAnz0001";
const dirs: string[] = [], dbs: WorkflowDatabase[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); seen.grants.length = 0; });
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  let value!: T;
  for (let i = 0; i < 800; i++) { value = await read(); if (done(value)) return value; await tick(); }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

describe("REI sign-in wait: deadline and reminder", () => {
  it("lasts until 18:00 office time and reminds at 12:00; a late start waits 15 minutes and never reminds", () => {
    const morning = Date.parse(at("08:00"));
    expect(officeTimeToday(morning, ZONE, "18:00")).toBe(Date.parse(at("18:00")));
    expect(newReiWait("bank-references", "w1run_x", morning, ZONE)).toMatchObject({ until: Date.parse(at("18:00")), reminderAt: Date.parse(at("12:00")), reminded: false });
    const evening = Date.parse(at("19:30"));
    const late = newReiWait("rei-supplier-check", "rei-supplier-check", evening, ZONE);
    expect(late).toMatchObject({ until: evening + 15 * 60_000, reminded: false });
    expect(late.reminderAt).toBe(late.until);
  });

  it("says the first line once, reminds once at midday, keeps the wait across a restart and drops it when it ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-rei-wait-")); dirs.push(dir);
    const waits = reiSignInWaits(dir), clock = { now: Date.parse(at("08:00")) }, notes: string[] = [], waiting: Array<boolean | undefined> = [];
    const copy = (time: string) => ({ first: `First until ${time}`, reminder: `Reminder until ${time}` });
    let finish!: (value: string) => void;
    const first = withReiSignInWait({ waits, loop: "bank-references", runId: "w1run_fictional", now: () => clock.now, timeZone: ZONE, note: (d, w) => { notes.push(d); waiting.push(w); }, copy, pollMs: 2,
      work: () => new Promise<string>(resolve => { finish = resolve; }) });
    await until(() => notes, n => n.length === 1, "first line");
    expect(notes[0]).toMatch(/^First until 6:00 pm on Tue, 6 Oct$/);
    clock.now = Date.parse(at("12:01"));
    await until(() => notes, n => n.length === 2, "reminder");
    await tick(20);
    expect(notes).toEqual([notes[0], "Reminder until 6:00 pm on Tue, 6 Oct"]);
    // Both lines wait on the person: an update restart need not wait for this run (server/routines.ts noteRun).
    expect(waiting).toEqual([true, true]);
    expect(await waits.list()).toEqual([expect.objectContaining({ loop: "bank-references", runId: "w1run_fictional", reminded: true, until: Date.parse(at("18:00")) })]);
    // A restart: the same loop and run pick up the saved wait (same deadline, reminder already said).
    expect(await resumableReiWaits(dir, clock.now)).toEqual([]); // no W1 run at sign-in in this folder: dropped
    await waits.put(newReiWait("rei-supplier-check", "rei-supplier-check", Date.parse(at("08:15")), ZONE));
    expect(await resumableReiWaits(dir, clock.now)).toEqual(["rei-supplier-check"]);
    expect(await resumableReiWaits(dir, Date.parse(at("18:30")))).toEqual([]);
    expect(await waits.list()).toEqual([]);
    finish("done");
    expect(await first).toBe("done");
  });

  it("once the person signs in, says the run works again (once) and never reminds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-rei-wait-")); dirs.push(dir);
    const clock = { now: Date.parse(at("08:00")) }, lines: Array<[string, boolean | undefined]> = [];
    let signedIn!: (detail: string) => void, finish!: (value: string) => void;
    const wait = withReiSignInWait({ waits: reiSignInWaits(dir), loop: "rei-supplier-check", runId: "rei-supplier-check", now: () => clock.now, timeZone: ZONE,
      note: (detail, waiting) => lines.push([detail, waiting]), copy: time => ({ first: `First until ${time}`, reminder: `Reminder until ${time}` }), pollMs: 2,
      work: (_until, resumed) => new Promise<string>(resolve => { signedIn = resumed; finish = resolve; }) });
    await until(() => lines, l => l.length === 1, "first line");
    signedIn("Reading.");
    signedIn("Reading.");
    clock.now = Date.parse(at("12:01"));
    await tick(30);
    expect(lines).toEqual([["First until 6:00 pm on Tue, 6 Oct", true], ["Reading.", undefined]]);
    finish("done");
    expect(await wait).toBe("done");
  });
});

// ── W1 over the fictional portal ──
const txn = (id: string, date: string, cents: number, reference: string) => ({ id, object: "transaction", account: ACCOUNT, status: "posted", date, datetime: `${date}T02:00:00.000Z`,
  post_date: date, post_datetime: `${date}T03:00:00.000Z`, value_date: null, value_datetime: null, description: `FICTIONAL PAYMENT ${reference}`, reference,
  extended_description: null, amount: { amount: cents, currency: "aud" }, direction: cents < 0 ? "debit" : "credit", provider_category: null, category: null,
  merchant_name: null, merchant_category_code: null, livemode: true });

async function w1Fixture() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-w1-wait-")); dirs.push(dir);
  const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 7) }); dbs.push(db);
  const rows = [txn("txn_fk_wait-1", "2026-10-01", 54000, "FT-BRAVO"), txn("txn_fk_wait-2", "2026-10-02", 36000, "FT-CHARLIE")];
  const pulls = { count: 0 };
  const fetch = async (input: string) => {
    const url = new URL(input);
    const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, next_page_url: null, previous_page_url: null }), { status: 200 });
    if (url.pathname === "/v2/accounts") return list([{ id: ACCOUNT, object: "account_item", connection: CONNECTION, provider: "fiskil", category: "banking", name: "Fictional Trust",
      type: "transaction", institution: { id: "inst_fk", name: "Fictional Bank" }, account_number: "xxxx4321", currency: "aud", status: "available", last_updated_at: null, livemode: true }]);
    pulls.count += 1;
    const from = url.searchParams.get("from")!, to = url.searchParams.get("to")!;
    return list(rows.filter(row => row.date >= from && row.date <= to));
  };
  const lab = await createW1Lab(dir, { fetch: fetch as never });
  await lab.handle({ action: "clock", at: at("08:00") });
  await lab.handle({ action: "handover" });
  const store = new BankReferenceStore(db);
  const rules = [["FP-02", "FT-BRAVO", "Fictional Tenant Bravo"], ["FP-03", "FT-CHARLIE", "Fictional Tenant Charlie"]].map(([propertyId, reference, tenant]) => ({ propertyId, reference, aliases: [reference], tenant }));
  store.create({ csv: "Date,Amount,Narrative,Reference\n2026-09-01,1.00,FICTIONAL SEED,\n", columns: { date: "Date", amount: "Amount", narrative: "Narrative", reference: "Reference" }, dateFormat: "YYYY-MM-DD", rules });
  const coverage = new RedbarkCoverage(dir);
  /** One service process: a fresh host over the same folder, as after a restart. */
  const host = (extra: Partial<W1HostDeps> = {}) => createW1Host({ dataDir: dir, provider: () => lab.provider, coverage, store: () => store, today: async () => "2026-10-02",
    tenantDirectory: () => ({ savedAt: lab.now() }), runtime: lab.runtime, browserId: lab.browserId, load: lab.load, lab, pollMs: 0, signInHolding: () => false, timeZone: async () => ZONE, now: lab.now, waitPollMs: 5, ...extra });
  const first = host();
  const call = (h: ReturnType<typeof host>, path: string, body?: unknown) => h.handle(path, "POST", new URLSearchParams(), async () => body);
  await first.handle("/api/w1/settings", "PUT", new URLSearchParams(), async () => ({ account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 0 }));
  // The clock pulls; the person reviews each row to its one directory match.
  expect(await first.runLoop()).toMatchObject({ status: "awaiting-approval", detail: expect.stringMatching(/^Pulled 2 bank transactions/) });
  const batchId = (await first.status()).run!.fetch!.batchId, saved = store.get(batchId);
  store.review(batchId, saved.revision, saved.value.batch.rows.map(row => ({ rowId: row.id, action: "assign" as const, propertyId: row.candidates[0], reason: "Fictional directory match" })));
  /** Answers asks until `stopAt` is asked (left open), or until none is open; returns the tools asked. */
  const answer = async (h: ReturnType<typeof host>, stopAt?: string) => {
    const tools: string[] = [];
    for (let i = 0; i < 800; i++) {
      const now = await h.status();
      if (now.ask) { tools.push(now.ask.tool); if (now.ask.tool === stopAt) return tools; await call(h, `/api/w1/runs/${now.run!.id}/answer`, { requestId: now.ask.requestId, allowed: true }); }
      else if (!now.working) return tools;
      await tick();
    }
    throw new Error(`asks: ${tools}`);
  };
  const portal = async () => await lab.handle({ action: "status" }) as { uploads: number; effects: string[]; signInTabs: number };
  return { dir, lab, host, first, call, answer, portal, pulls };
}
const scope = (grant: BrowserTaskGrant) => ({ runId: grant.runId, route: grant.route, sites: grant.sites, browser: grant.browser, actions: grant.actions, consequential: grant.consequential, uploads: grant.uploads, budget: grant.budget });
const sessionGrants = () => seen.grants.filter(grant => grant.request.text.startsWith("Bank import: check REI is signed in"));

describe("W1 loop run waits at REI sign-in", () => {
  it("waits on REI's sign-in page, reminds at midday, survives a restart and carries on by itself to the upload ask", async () => {
    const f = await w1Fixture(), notes: string[] = [];
    // The first service process freezes mid-wait (a crash): its handover never ends.
    const frozen = f.host({ openForSignIn: () => new Promise(() => {}) });
    void frozen.runLoop(detail => notes.push(detail));
    await until(() => notes, n => n.length > 0, "first line");
    expect(notes[0]).toBe("Sign in to REI Cloud so Bud can finish the bank import. REI's sign-in page is open in the work browser; Bud carries on by itself once you're signed in (waiting until 6:00 pm on Tue, 6 Oct).");
    const waiting = await frozen.status();
    expect(waiting).toMatchObject({ working: true, signIn: expect.stringMatching(/^w1-w1run_/), run: { step: "sign_in", upload: null } });
    await f.lab.handle({ action: "clock", at: at("12:01") });
    await until(() => notes, n => n.length === 2, "midday reminder");
    expect(notes[1]).toMatch(/^Reminder: sign in to REI Cloud so Bud can finish the bank import\. Bud waits until 6:00 pm on Tue, 6 Oct/);
    const pullsBefore = f.pulls.count, tabsBefore = (await f.portal()).signInTabs;

    // Restart: the saved wait is still inside its deadline and its run still waits at sign-in.
    expect(await resumableReiWaits(f.dir, f.lab.now())).toEqual(["bank-references"]);
    const resumed = f.host(), after: string[] = [];
    const loop = resumed.runLoop(detail => after.push(detail));
    await until(() => resumed.status(), s => s.working && s.signIn !== null, "resumed wait");
    // Same deadline, the reminder already said: no new line to notify about.
    expect(after).toEqual([notes[1]]);
    expect((await f.portal()).signInTabs).toBe(tabsBefore + 1);
    const run = (await resumed.status()).run!;
    expect(run).toMatchObject({ id: waiting.run!.id, step: "sign_in", fetch: waiting.run!.fetch, review: waiting.run!.review, upload: null });
    expect(f.pulls.count).toBe(pullsBefore);

    // The person signs in: no Continue or Done; the run goes on to the upload, which waits for their approval.
    await f.lab.handle({ action: "sign-in" });
    const tools = await f.answer(resumed, "browser_upload");
    expect(tools.at(-1)).toBe("browser_upload");
    expect(after.at(-1)).toBe("Waiting for your approval to upload the reviewed bank file to REI. Answer in Schedule → Bank reference review.");
    // The grant after the restart and the sign-in has exactly the scope of the one before the wait.
    const grants = sessionGrants();
    expect(grants.length).toBeGreaterThanOrEqual(3);
    for (const grant of grants) expect(scope(grant)).toEqual(scope(grants[0]));
    expect(new Set(grants.map(grant => grant.id)).size).toBe(grants.length);

    // The person does not allow the upload: nothing reaches REI.
    const ask = (await resumed.status()).ask!;
    await f.call(resumed, `/api/w1/runs/${run.id}/answer`, { requestId: ask.requestId, allowed: false });
    // Only REI's complete register (its download is the person's to allow) can show nothing arrived.
    expect(await f.answer(resumed)).toContain("browser_download");
    expect(await loop).toMatchObject({ ok: true, status: "awaiting-approval", detail: expect.stringMatching(/^REI shows nothing from the earlier upload/) });
    expect(await f.portal()).toMatchObject({ uploads: 0, effects: [] });
    expect(f.pulls.count).toBe(pullsBefore);
    expect(await reiSignInWaits(f.dir).list()).toEqual([]);
  });

  it("parks on the sign-in wait and each ask, works again on each resume, and an allowed upload is work before it starts", async () => {
    const f = await w1Fixture();
    // Each line with the portal's upload count at that moment (the lab reads it synchronously).
    const lines: Array<{ detail: string; waiting: boolean; uploads: Promise<{ uploads: number }> }> = [];
    const loop = f.first.runLoop((detail, waiting) => lines.push({ detail, waiting: waiting === true, uploads: f.portal() }));
    await until(() => f.first.status(), s => s.working && s.signIn !== null, "wait");
    await f.lab.handle({ action: "sign-in" });
    const tools = await f.answer(f.first);
    expect(tools).toContain("browser_upload");
    expect(await loop).toMatchObject({ ok: true, status: "awaiting-approval" });
    expect(lines[0]).toMatchObject({ detail: expect.stringMatching(/^Sign in to REI Cloud so Bud can finish the bank import\./), waiting: true });
    expect(lines[1]).toMatchObject({ detail: "Signed in to REI. Checking the account, then carrying on with the bank import.", waiting: false });
    // Every wait on the person is followed by a line that says the run works again.
    lines.forEach((line, index) => { if (line.waiting) expect(lines[index + 1]?.waiting, line.detail).toBe(false); });
    const asked = lines.findIndex(line => line.detail.startsWith("Waiting for your approval to upload the reviewed bank file to REI"));
    expect(lines[asked]?.waiting).toBe(true);
    expect(lines[asked + 1]?.detail).toBe("Allowed. Uploading the reviewed bank file to REI.");
    expect((await lines[asked + 1]!.uploads).uploads).toBe(0);
    expect((await f.portal()).uploads).toBe(1);
  });

  it("stops with the plain mismatch message when the sign-in is to another business", async () => {
    const f = await w1Fixture(), notes: string[] = [];
    const loop = f.first.runLoop(detail => notes.push(detail));
    await until(() => f.first.status(), s => s.working && s.signIn !== null, "wait");
    await f.lab.handle({ action: "switch-business" });
    await f.lab.handle({ action: "sign-in" });
    expect(await loop).toEqual({ ok: true, status: "awaiting-approval",
      detail: "REI is signed in to a different agency or trust account. Switch to the selected account, then continue. Continue in Schedule → Bank reference review." });
    expect((await f.first.status()).run).toMatchObject({ step: "sign_in", attention: { reason: "account_mismatch" } });
    expect(await f.portal()).toMatchObject({ uploads: 0, effects: [] });
  });

  it("at 18:00 the run is missed (never silent) and nothing is saved to resume; Stop ends the wait at once", async () => {
    const f = await w1Fixture();
    const loop = f.first.runLoop();
    await until(() => f.first.status(), s => s.working && s.signIn !== null, "wait");
    await f.lab.handle({ action: "clock", at: at("18:01") });
    expect(await loop).toEqual({ ok: false, status: "missed", detail: W1_MISSED });
    expect(await f.first.status()).toMatchObject({ note: W1_MISSED, run: { step: "sign_in", attention: { reason: "sign_in" } } });
    expect(await reiSignInWaits(f.dir).list()).toEqual([]);

    // The next scheduled run waits again; Stop ends it and leaves nothing to resume.
    await f.lab.handle({ action: "clock", at: "2026-10-08T08:00:00+10:00" });
    const next = f.first.runLoop();
    const now = await until(() => f.first.status(), s => s.working && s.signIn !== null, "next wait");
    await f.call(f.first, `/api/w1/runs/${now.run!.id}/stop`, {});
    expect(await next).toMatchObject({ ok: false, status: "failed", detail: expect.stringMatching(/^Stopped\./) });
    expect(await reiSignInWaits(f.dir).list()).toEqual([]);
    expect(await f.portal()).toMatchObject({ uploads: 0, effects: [] });
  });
});

describe("Supplier list check waits at REI sign-in", () => {
  async function supplierFixture() {
    const dir = mkdtempSync(join(tmpdir(), "realbud-supplier-wait-")); dirs.push(dir);
    const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 3) }); dbs.push(db);
    const lab = await createW1Lab(dir, { fetch: (async () => new Response("{}", { status: 404 })) as never });
    await lab.handle({ action: "clock", at: at("08:15") });
    await lab.handle({ action: "handover" });
    const tenants = createTenantDirectoryStore(db), suppliers = createSupplierDirectory({ file: join(dir, "suppliers.json") });
    const sync = (signIn: () => W1HostDeps["openForSignIn"] = () => lab.openForSignIn) => createReiDirectorySync({ dataDir: dir, runtime: lab.runtime, browserId: lab.browserId,
      account: async () => ({ marker: FICTIONAL_BUSINESS }), tenants, suppliers, load: lab.load, signIn, signInHolding: () => false, pollMs: 0, timeZone: async () => ZONE, now: lab.now, waitPollMs: 5 });
    return { dir, lab, sync };
  }

  it("survives a restart, carries on by itself after sign-in to its preview, and is missed at 18:00", async () => {
    const f = await supplierFixture(), notes: string[] = [];
    void f.sync(() => () => new Promise(() => {})).checkSuppliers(detail => notes.push(detail));
    await until(() => notes, n => n.some(line => line.startsWith("Sign in to REI Cloud")), "first line");
    expect(notes.find(line => line.startsWith("Sign in"))).toMatch(/^Sign in to REI Cloud so Bud can check the supplier list\. .*waiting until 6:00 pm on Tue, 6 Oct\)\.$/);
    expect(await resumableReiWaits(f.dir, f.lab.now())).toEqual(["rei-supplier-check"]);
    const resumed = f.sync(), after: string[] = [];
    const check = resumed.checkSuppliers(detail => after.push(detail));
    await until(() => resumed.status(), s => Boolean(s.run?.signIn), "resumed wait");
    await f.lab.handle({ action: "sign-in" });
    for (let i = 0; i < 800; i++) {
      const now = await resumed.status();
      if (now.run?.ask) await resumed.handle(`/api/rei-directory/runs/${now.run.id}/answer`, "POST", async () => ({ requestId: now.run!.ask!.requestId, allowed: true }));
      else if (!now.run?.working) break;
      await tick();
    }
    expect(await check).toEqual({ ok: true, status: "awaiting-approval", detail: "Supplier list changed in REI: 5 added — review in Bills and calendar → Maintenance checks." });
    expect(after.filter(line => line.startsWith("Sign in to REI Cloud"))).toHaveLength(1);

    // Signed out again later: the next check waits, and at 18:00 it is missed.
    await resumed.handle(`/api/rei-directory/runs/${(await resumed.status()).run!.id}/stop`, "POST", async () => ({}));
    await f.lab.handle({ action: "sign-out" });
    const missed = resumed.checkSuppliers(() => {});
    await until(() => resumed.status(), s => Boolean(s.run?.signIn), "second wait");
    await f.lab.handle({ action: "clock", at: at("18:01") });
    expect(await missed).toEqual({ ok: false, status: "missed", detail: SUPPLIER_MISSED });
    expect(await reiSignInWaits(f.dir).list()).toEqual([]);
  });

  it("parks on the sign-in wait and each ask, and reads again after each", async () => {
    const f = await supplierFixture(), sync = f.sync(), lines: Array<[string, boolean]> = [];
    const check = sync.checkSuppliers((detail, waiting) => lines.push([detail, waiting === true]));
    await until(() => sync.status(), s => Boolean(s.run?.signIn), "wait");
    await f.lab.handle({ action: "sign-in" });
    for (let i = 0; i < 800; i++) {
      const now = await sync.status();
      if (now.run?.ask) await sync.handle(`/api/rei-directory/runs/${now.run.id}/answer`, "POST", async () => ({ requestId: now.run!.ask!.requestId, allowed: true }));
      else if (!now.run?.working) break;
      await tick();
    }
    expect(await check).toMatchObject({ ok: true, status: "awaiting-approval" });
    const reading: [string, boolean] = ["Reading REI's supplier list. Nothing in REI changes.", false];
    const signIn = lines.findIndex(([detail]) => detail.startsWith("Sign in to REI Cloud so Bud can check the supplier list"));
    expect(lines[signIn]?.[1]).toBe(true);
    expect(lines[signIn + 1]).toEqual(reading);
    lines.forEach(([detail, waiting], index) => {
      if (/allow a step in REI/.test(detail)) expect(waiting).toBe(true);
      if (waiting) expect(lines[index + 1], detail).toEqual(reading);
    });
    expect(lines.at(-1)).toEqual(reading);
  });
});
