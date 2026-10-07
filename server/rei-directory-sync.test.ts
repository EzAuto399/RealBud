// Refresh from REI end to end in one process: the FICTIONAL REI-style portal
import { privateTempRoot } from "./testing/private-fixture.ts";
// behind the real BrowserRuntime, broker and recipe runner (w1-lab.ts), the
// real tenant and supplier directory stores. No network, no REI account: a
// pass proves RealBud's wiring and guards only.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { createLearnedRecipeStore } from "./learned-recipes.ts";
import { loadPortalRecipePack, loadShippedPortalRecipePack } from "./portal-recipe-task.ts";
import { createReiDirectorySync, SUPPLIER_BIG_DROP, supplierChanges } from "./rei-directory-sync.ts";
import { createSupplierDirectory } from "./supplier-directory.ts";
import { createTenantDirectoryStore } from "./tenant-directory.ts";
import { createW1Lab } from "./testing/w1-lab.ts";
import { FICTIONAL_BUSINESS, fictionalReiPack } from "./testing/fictional-rei-portal.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import { matchSender } from "../shared/supplier-directory.ts";

// The real loaders, wrapped so a test can see which one the refresh used and what it got.
vi.mock("./portal-recipe-task.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./portal-recipe-task.ts")>();
  return { ...real, loadPortalRecipePack: vi.fn(real.loadPortalRecipePack), loadShippedPortalRecipePack: vi.fn(real.loadShippedPortalRecipePack) };
});

const dirs: string[] = [], dbs: WorkflowDatabase[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function fixture(options: { account?: boolean; load?: (() => ReturnType<typeof fictionalReiPack>) | null } = {}) {
  const dir = privateTempRoot(join(tmpdir(), "realbud-rei-dir-")); dirs.push(dir);
  const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 5) }); dbs.push(db);
  const lab = await createW1Lab(dir, { fetch: (async () => new Response("{}", { status: 404 })) as never });
  const tenants = createTenantDirectoryStore(db), suppliers = createSupplierDirectory({ file: join(dir, "suppliers.json") });
  const sync = createReiDirectorySync({ runtime: lab.runtime, browserId: lab.browserId, account: async () => options.account === false ? null : { marker: FICTIONAL_BUSINESS },
    tenants, suppliers, ...(options.load === null ? {} : { load: async () => (options.load ?? fictionalReiPack)() }), signIn: () => lab.openForSignIn, signInHolding: () => false, pollMs: 0 });
  const call = async (path: string, body?: unknown) => {
    const result = await sync.handle(path, path.endsWith("/status") ? "GET" : "POST", async () => body);
    if (result.status !== 200) throw Object.assign(new Error(JSON.stringify(result.body)), { status: result.status });
    return result.body as Awaited<ReturnType<typeof sync.status>>;
  };
  /** Waits until the run ends, asks the person, or waits for sign-in. */
  const settle = async () => {
    for (let i = 0; i < 400; i++) { const now = await sync.status(); if (!now.run?.working || now.run.ask || now.run.signIn) return now; await new Promise(r => setTimeout(r, 10)); }
    throw new Error("The refresh did not settle.");
  };
  const start = async (kind: "tenants" | "suppliers") => { await call("/api/rei-directory/runs", { kind }); return settle(); };
  /** Waits past sign-in until the run ends. A grid read raises no ask: any that does is refused and returned. */
  const finish = async () => {
    const tools: string[] = [];
    let now = await settle();
    for (let i = 0; i < 400 && now.run?.working; i++) {
      if (now.run.ask) { tools.push(now.run.ask.tool); await call(`/api/rei-directory/runs/${now.run.id}/answer`, { requestId: now.run.ask.requestId, allowed: false }); }
      else await new Promise(r => setTimeout(r, 10));
      now = await settle();
    }
    return Object.assign(now, { tools });
  };
  const save = async (expectedRevision: number) => call(`/api/rei-directory/runs/${(await sync.status()).run!.id}/save`, { expectedRevision });
  return { lab, sync, tenants, suppliers, call, settle, start, finish, save };
}

describe("refresh from REI (fictional portal)", () => {
  it("signed out: hands sign-in to the person, then reads every row of the Tenants grid (it scrolls) and previews before anything is saved", async () => {
    const f = await fixture();
    // Without the handover, a signed-out REI is a plain stop.
    let now = await f.start("tenants");
    expect(now.run).toMatchObject({ phase: "failed", working: false });
    expect(now.run!.message).toMatch(/Sign in to REI Cloud/);
    await f.lab.handle({ action: "handover" });
    now = await f.start("tenants");
    expect(now.run!.signIn).toMatch(/^rei-dir-/);
    await f.lab.handle({ action: "sign-in" });
    const read = await f.finish();
    // Read from the grid: nothing to allow, no report, no download.
    expect(read.tools).toEqual([]);
    now = read;
    expect(now.run!.phase, now.run!.message ?? "").toBe("preview");
    // The fictional grid renders 4 of its 10 Active rows until its own content scrolls: all 10 were read.
    expect(now.run!.preview).toMatchObject({ rows: 10, footer: 10, countMatches: true, accepted: 9, added: 9, removed: 0, unchanged: false, baseRevision: 0 });
    expect(now.run!.preview!.rejected).toEqual([{ row: 11, reason: "Row 11 (FT-KILO) has no Property, so a payment cannot be matched to it." }]);
    expect(now.run!.preview!.file).toMatchObject({ name: "REI Tenants list (read from the page)", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(now.run!.message).toBeNull();
    // Nothing saved yet; nothing in REI pressed.
    expect(f.tenants.read().revision).toBe(0);
    expect((await f.lab.handle({ action: "status" }) as { effects: string[] }).effects).toEqual([]);
    await expect(f.save(1)).rejects.toMatchObject({ status: 409 });
    now = await f.save(0);
    expect(now.run).toMatchObject({ phase: "saved", saved: { revision: 1, changed: true } });
    // A grid cell with a comma ("$2,400.00 per month") survives the CSV the parsers read.
    expect(f.tenants.read().directory!.tenants.find(t => t.reference === "FT-JULIET")).toMatchObject({ property: "FP-10", rent: "$2,400.00 per month" });
    expect(f.tenants.read().directory!.tenants.find(t => t.reference === "FT-BRAVO")).toMatchObject({ property: "FP-02", bpay: "4470002" });
    expect(f.tenants.read().directory!.source).toMatchObject({ name: "REI Tenants list (read from the page)", rows: 10 });
    // A repeat refresh with no change in REI: a preview that says so, and no new revision.
    await f.start("tenants");
    now = await f.finish();
    expect(now.run!.preview).toMatchObject({ unchanged: true, baseRevision: 1 });
    now = await f.save(1);
    expect(now.run!.saved).toEqual({ revision: 1, changed: false });
    expect(f.tenants.read().revision).toBe(1);
  });

  it("a Tenants read shorter than REI's own record count is shown and cannot be saved", async () => {
    const f = await fixture();
    await f.lab.handle({ action: "sign-in" });
    // The grid shows 9 of the 10 rows its footer counts.
    await f.lab.handle({ action: "short-export" });
    await f.start("tenants");
    const now = await f.finish();
    expect(now.run!.preview).toMatchObject({ rows: 9, footer: 10, countMatches: false });
    expect(now.run!.message).toBe("Bud read 9 rows but REI's list shows 10 records. Nothing can be saved from it; refresh again.");
    await expect(f.save(0)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Bud read 9 rows/) });
    expect(f.tenants.read().revision).toBe(0);
  });

  it("Stop during the sign-in wait, or Discard on a preview, leaves both directories unchanged", async () => {
    const f = await fixture();
    await f.lab.handle({ action: "handover" });
    let now = await f.start("suppliers");
    expect(now.run!.signIn, JSON.stringify(now.run)).toMatch(/^rei-dir-/);
    now = await f.call(`/api/rei-directory/runs/${now.run!.id}/stop`, {});
    expect(now.run).toMatchObject({ phase: "stopped", working: false, ask: null, signIn: null, preview: null, message: "Stopped. Nothing was saved." });
    await f.lab.handle({ action: "sign-in" });
    await f.start("tenants");
    now = await f.finish();
    expect(now.run!.phase).toBe("preview");
    now = await f.call(`/api/rei-directory/runs/${now.run!.id}/stop`, {});
    expect(now.run).toMatchObject({ phase: "stopped", preview: null });
    await expect(f.save(0)).rejects.toMatchObject({ status: 409 });
    expect(now.suppliers.revision).toBe(0); expect(f.tenants.read().revision).toBe(0);
  });

  it("supplier list: preview, save, then W4's sender check recognises a listed supplier; a short read cannot be saved", async () => {
    const f = await fixture();
    await f.lab.handle({ action: "sign-in" });
    await f.start("suppliers");
    const read = await f.finish();
    expect(read.tools).toEqual([]);
    let now: Awaited<ReturnType<typeof f.save>> = read;
    expect(now.run!.preview).toMatchObject({ rows: 5, footer: 5, countMatches: true, accepted: 5, withoutEmail: 2, baseRevision: 0, file: { name: "REI Suppliers list (read from the page)" } });
    expect(now.run!.preview!.rejected.map(r => r.reason)).toEqual(['Row 5 (FS-LOCK): "not-an-email" is not a valid email address.']);
    now = await f.save(0);
    expect(now.suppliers).toMatchObject({ revision: 1, count: 5 });
    const directory = await f.suppliers.read();
    expect(matchSender(directory, "Accounts@Fictional-Plumbing.test")).toEqual({ kind: "listed", supplierRef: "FS-PLUMB" });
    // A cell holding two addresses ("a; b") is read whole from the grid.
    expect(matchSender(directory, "invoices@fictional-electrical.test")).toEqual({ kind: "listed", supplierRef: "FS-ELEC" });
    // The grid shows fewer rows than its own "N records": shown, never saved.
    await f.lab.handle({ action: "short-export" });
    await f.start("suppliers");
    now = await f.finish();
    expect(now.run!.preview).toMatchObject({ rows: 4, footer: 5, countMatches: false });
    expect(now.run!.message).toMatch(/Bud read 4 rows but REI's list shows 5 records/);
    await expect(f.save(1)).rejects.toMatchObject({ status: 409 });
    expect((await f.suppliers.read()).revision).toBe(1);
  });

  it("refuses before the browser: no saved REI account, or a recipe that needs more than reading", async () => {
    const none = await fixture({ account: false });
    expect((await none.start("tenants")).run!.message).toMatch(/Save the REI business code/);
    const typing = await fixture({ load: () => {
      const pack = fictionalReiPack();
      return { ...pack, recipes: { ...pack.recipes, "tenant-list": { ...pack.recipes["tenant-list"], steps: [{ type: { field: "Search", value: "x" } }, ...pack.recipes["tenant-list"].steps, { download: { label: "Export" } }] } } };
    } });
    const now = await typing.start("tenants");
    expect(now.run!.message).toMatch(/asks for more than reading \(fill, keys, download\)/);
    expect((await typing.lab.handle({ action: "status" }) as { effects: string[] }).effects).toEqual([]);
    await expect(typing.call("/api/rei-directory/runs", { kind: "owners" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("supplier list changes", () => {
  const s = (reference: string, ...emails: string[]) => ({ reference, description: `Fictional ${reference}`, emails });
  const saved = [s("FS-A", "a@fictional.test"), s("FS-B", "b@fictional.test", "b2@fictional.test"), s("FS-C"), s("FS-D", "d@fictional.test")];
  it("lists added and removed suppliers and email changes; email order alone is not a change", () => {
    expect(supplierChanges(saved, [s("FS-A", "a@fictional.test"), s("FS-B", "b2@fictional.test", "b@fictional.test"), s("FS-C", "c@fictional.test"), s("FS-D", "d@fictional.test"), s("FS-E", "e@fictional.test")])).toEqual({
      added: [s("FS-E", "e@fictional.test")], removed: [],
      emails: [{ reference: "FS-C", description: "Fictional FS-C", before: [], after: ["c@fictional.test"] }], bigDrop: false });
    expect(supplierChanges(saved, saved.slice(0, 3))).toMatchObject({ added: [], removed: [s("FS-D", "d@fictional.test")], emails: [], bigDrop: false });
    expect(supplierChanges(saved, saved)).toEqual({ added: [], removed: [], emails: [], bigDrop: false });
  });
  it("holds a big drop: more than 30% of saved suppliers removed; a first import is never one", () => {
    expect(supplierChanges(saved, saved.slice(0, 2)).bigDrop).toBe(true);
    expect(supplierChanges([], saved).bigDrop).toBe(false);
  });
});

describe("scheduled Supplier list check (fictional portal)", () => {
  it("waits for sign-in, reads the grid, ends quietly when unchanged, and holds a change for approval", async () => {
    const f = await fixture(), notes: string[] = [];
    await f.lab.handle({ action: "handover" });
    const first = f.sync.checkSuppliers(detail => notes.push(detail));
    let now = await f.settle();
    expect(now.run).toMatchObject({ origin: "schedule", signIn: expect.stringMatching(/^rei-dir-/) });
    await f.lab.handle({ action: "sign-in" });
    expect((await f.finish()).tools).toEqual([]);
    // First check against an empty directory: every supplier is new, nothing saved until Approve.
    expect(await first).toEqual({ ok: true, status: "awaiting-approval", detail: "Supplier list changed in REI: 5 added — review in Bills and calendar → Maintenance checks." });
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/^Sign in to REI Cloud so Bud can check the supplier list/), "Reading REI's supplier list. Nothing in REI changes."]));
    expect(notes.some(note => /allow/i.test(note))).toBe(false);
    expect((await f.suppliers.read()).revision).toBe(0);
    await f.save(0);
    // Unchanged in REI: quiet, and no new revision.
    expect(await f.sync.checkSuppliers(() => {})).toEqual({ ok: true, status: "completed", quiet: true, detail: "REI's supplier list has not changed." });
    expect((await f.sync.status()).run).toMatchObject({ phase: "saved", saved: { revision: 1, changed: false } });
    // REI adds FS-PAINT, removes FS-ROOF and changes FS-ELEC's address: shown, applied only on Approve.
    await f.lab.handle({ action: "change-suppliers" });
    expect((await f.sync.checkSuppliers(() => {})).detail).toBe("Supplier list changed in REI: 1 added, 1 removed, 1 email changed — review in Bills and calendar → Maintenance checks.");
    now = await f.sync.status();
    expect(now.run!.preview!.changes).toMatchObject({ added: [{ reference: "FS-PAINT" }], removed: [{ reference: "FS-ROOF" }], bigDrop: false,
      emails: [{ reference: "FS-ELEC", before: ["jobs@fictional-electrical.test", "invoices@fictional-electrical.test"], after: ["jobs@fictional-electrical.test", "billing@fictional-electrical.test"] }] });
    expect(matchSender(await f.suppliers.read(), "roof@fictional-roofing.test")).toEqual({ kind: "listed", supplierRef: "FS-ROOF" });
    await f.save(1);
    const directory = await f.suppliers.read();
    expect(matchSender(directory, "roof@fictional-roofing.test")).toEqual({ kind: "unlisted" });
    expect(matchSender(directory, "paint@fictional-painting.test")).toEqual({ kind: "listed", supplierRef: "FS-PAINT" });
  });

  it("holds a big drop with a warning until the person confirms it", async () => {
    const f = await fixture();
    await f.lab.handle({ action: "sign-in" });
    await f.start("suppliers"); await f.finish(); await f.save(0);
    await f.lab.handle({ action: "drop-suppliers" });
    expect(await f.sync.checkSuppliers(() => {})).toMatchObject({ status: "awaiting-approval", detail: `${SUPPLIER_BIG_DROP} Review it in Bills and calendar → Maintenance checks.` });
    await expect(f.save(1)).rejects.toThrow(/far fewer suppliers/);
    const id = (await f.sync.status()).run!.id;
    await f.call(`/api/rei-directory/runs/${id}/save`, { expectedRevision: 1, acknowledgeDrop: true });
    expect((await f.suppliers.read()).suppliers.map(s => s.reference)).toEqual(["FS-PLUMB", "FS-ELEC"]);
  });

  it("a short read is held for Dismiss, and a refresh already running ends the check; neither saves", async () => {
    const f = await fixture();
    await f.lab.handle({ action: "sign-in" });
    await f.lab.handle({ action: "short-export" });
    expect(await f.sync.checkSuppliers(() => {})).toEqual({ ok: true, status: "awaiting-approval",
      detail: "Bud read 4 rows but REI's list shows 5 records. Nothing can be saved from it; refresh again. Dismiss it in Bills and calendar → Maintenance checks." });
    await expect(f.save(0)).rejects.toMatchObject({ status: 409 });
    await f.lab.handle({ action: "handover" }); await f.lab.handle({ action: "sign-out" });
    await f.call("/api/rei-directory/runs", { kind: "tenants" });
    expect(await f.sync.checkSuppliers(() => {})).toMatchObject({ ok: false, status: "failed", detail: expect.stringMatching(/already running/) });
    expect((await f.suppliers.read()).revision).toBe(0);
    await f.call(`/api/rei-directory/runs/${(await f.sync.status()).run!.id}/stop`, {});
  });
});

describe("refresh from REI and watch-and-learn recipes", () => {
  it("runs on the shipped pack only: no learned recipe and no read-safe label a reviewer confirmed", async () => {
    // A published learned recipe in this test's own data folder (never ~/.realbud), with a confirmed label.
    const file = join(DATA_DIR, "learned-recipes.json");
    expect(file.startsWith(process.env.HOME!)).toBe(true);
    const store = createLearnedRecipeStore(file);
    const shipped = await loadShippedPortalRecipePack("rei-cloud");
    const draft = await store.create({ portal: "rei-cloud", title: "Loop leak check", steps: [{ click: "Show fictional detail" }, { read: "controls" }], stopBefore: [], flags: [] });
    const confirmed = await store.update(draft.id, draft.revision, { confirmedLabels: ["Show fictional detail"] }, shipped.labels);
    await store.publish(confirmed.id, confirmed.revision, shipped);
    try {
      const merged = await loadPortalRecipePack("rei-cloud");
      expect(merged.recipes["learned-loop-leak-check"]).toBeDefined();
      expect(merged.labels.readSafe).toContain("Show fictional detail");
      vi.mocked(loadPortalRecipePack).mockClear(); vi.mocked(loadShippedPortalRecipePack).mockClear();

      // No injected `load`: the refresh picks its own loader.
      const f = await fixture({ load: null });
      await f.start("tenants");
      expect(loadPortalRecipePack).not.toHaveBeenCalled();
      expect(loadShippedPortalRecipePack).toHaveBeenCalledWith("rei-cloud");
      const used = await vi.mocked(loadShippedPortalRecipePack).mock.results[0].value;
      expect(Object.keys(used.recipes).filter(name => name.startsWith("learned-"))).toEqual([]);
      expect(used.labels.readSafe).toEqual(shipped.labels.readSafe);
      expect(used.labels.readSafe).not.toContain("Show fictional detail");
    } finally { rmSync(file, { force: true }); }
  });
});
