// The recipe runner, run as Bud runs it: through the real BrowserBroker
// (grant, fence, approvals, sign-in pause, Stop) over a FICTIONAL REI-style
// portal played by the browser helper's command interface. No network, no
// REI account, no credentials. Passing proves the recipes execute through
// RealBud's authority path, never that REI Cloud behaves this way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addBrowserTaskUpload, browserTaskWorkroom, BrowserRuntime, type BrowserJson } from "./browser-runtime.ts";
import { onBrowserSignIn } from "./browser-broker.ts";
import { BrowserApprovalStore } from "./browser-authority.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { filterPortalRunRows, parsePortalRecipePack, type PortalPackRecipe, type PortalRecipePack } from "./portal-recipe.ts";
import { portalRecipeControls, portalRecipeGrantNeeds, runPortalRecipes, type PersonApprove, type PortalChooser, type PortalRunOptions, type PortalRunRequest } from "./portal-recipe-runner.ts";
import { FICTIONAL_BUSINESS, FICTIONAL_REICID, FICTIONAL_TENANT_COLUMNS, FICTIONAL_TENANT_LIST, fictionalReiPack, fictionalReiPortal, type FictionalReiOptions } from "./testing/fictional-rei-portal.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { parseBrowserTaskGrant, type BrowserActionClass } from "../shared/browser-task.ts";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** Commands that change the page. Reads (observe, tab list, status) are not among them. */
const DISPATCH = new Set(["navigate", "click", "fill", "press", "select", "upload", "download"]);
const MORNING = (pack: PortalRecipePack): PortalRunRequest[] => pack.batches.morning.map(recipe => ({ recipe, inputs: { min_days: "1", date_from: "2026-09-25", date_to: "2026-09-30" } }));

async function fixture(portal: FictionalReiOptions = {}, task: { actions?: BrowserActionClass[]; upload?: Buffer; threadId?: string; operations?: ConnectedAppOperationStore } = {}) {
  const root = privateTempRoot(join(tmpdir(), "rb-recipe-runner-")); cleanup.push(() => removeFixture(root));
  const mock = fictionalReiPortal(portal);
  const runtime = new BrowserRuntime({ root, command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  const pack = fictionalReiPack();
  const operations = task.operations ?? new ConnectedAppOperationStore({ file: join(root, "operations.json") });
  const person = vi.fn<PersonApprove>(async () => false);
  let lastWorkroom = "";
  const start = async (runs: PortalRunRequest[], extra: Partial<PortalRunOptions> = {}) => {
    const grantId = `grant-${randomUUID()}`; const runId = `run-${randomUUID()}`;
    const workroom = browserTaskWorkroom(root, grantId); lastWorkroom = workroom;
    const uploads = task.upload ? [await addBrowserTaskUpload(workroom, "fictional-bank.csv", task.upload)] : [];
    const needs = portalRecipeGrantNeeds(pack, runs);
    const text = `Fictional task: ${runs.map(run => run.recipe).join(", ")}`;
    const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: grantId, runId, route: "ask", request: { text, sha256: sha256(text) },
      sites: needs.sites, browser: { id: null, accountMarker: FICTIONAL_BUSINESS }, actions: task.actions ?? needs.actions, consequential: "ask-each", uploads, expiresAt: null, budget: null });
    return runPortalRecipes({ pack, runs, grant, runtime, workroom, operations, threadId: task.threadId ?? "thread-fictional", approve: person,
      account: { urlValue: FICTIONAL_REICID, marker: FICTIONAL_BUSINESS }, approvals: new BrowserApprovalStore({ file: join(root, `approvals-${grantId}.json`) }),
      rules: () => [], assertCapability: () => {}, pollMs: 0, ...extra });
  };
  const dispatched = () => mock.calls.filter(args => DISPATCH.has(args[0]));
  return { mock, runtime, pack, person, operations, start, dispatched, workroomOf: () => lastWorkroom };
}
const withOpen = (recipe: string, inputs: Record<string, string> = {}): PortalRunRequest[] => [{ recipe: "open-session" }, { recipe, inputs }];

describe("recipes.json stays generated from the website map", () => {
  it("matches the generator and validates", async () => {
    const { reiRecipesDrift } = await import(new URL("../scripts/rei-recipes.mjs", import.meta.url).href) as { reiRecipesDrift(): Promise<{ drifted: boolean }> };
    expect((await reiRecipesDrift()).drifted).toBe(false);
    const raw = JSON.parse(readFileSync(new URL("../pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json", import.meta.url), "utf8"));
    const pack = parsePortalRecipePack(raw);
    expect(pack.origin).toBe("https://app.reimasterapps.com.au");
    expect(Object.keys(pack.recipes)).toEqual(expect.arrayContaining(["open-session", "arrears-review", "tasks-due", "bank-reconciliation-read"]));
    // Core never learns a portal's names; a label cannot be both safe and consequential.
    expect(() => parsePortalRecipePack({ ...raw, labels: { ...raw.labels, readSafe: [...raw.labels.readSafe, "Notice"] } })).toThrow(/damaged/);
    expect(() => parsePortalRecipePack({ ...raw, origin: "http://app.reimasterapps.com.au" })).toThrow(/damaged/);
    // The lazy grid's container is declared once, and only a plain selector is accepted.
    expect(pack.grid).toEqual({ scrollContainer: ".e-gridcontent .e-content" });
    expect(portalRecipeControls(pack).gridScroll).toBe(".e-gridcontent .e-content");
    for (const grid of [{ scrollContainer: "--cdp=ws://other" }, { scrollContainer: ".a", extra: true }, { scrollContainer: "div[onclick]" }, { scrollContainer: "" }, ".e-content"]) {
      expect(() => parsePortalRecipePack({ ...raw, grid }), JSON.stringify(grid)).toThrow(/damaged/);
    }
  });
});

describe("portal recipe runner through the real broker (fictional REI mock)", () => {
  // Recipes read the default grid through named controls only; the row filter (server/portal-recipe.ts) applies after.
  const S_READS: Array<[string, Record<string, string>, (rows: Array<Record<string, string>>) => void]> = [
    ["find-record", { list: "Tenants", query: "Charlie" }, rows => { expect(rows).toHaveLength(1); expect(rows[0].Surname).toBe("Charlie"); }],
    // The default grid shows 7 arrears rows (vacated tenants are not hidden): 5 have Days Arrears of 10 or more.
    ["arrears-review", { min_days: "10" }, rows => expect(rows.map(row => row.Name)).toEqual(["Fictional Tenant Echo", "Fictional Tenant Golf", "Fictional Tenant Hotel", "Fictional Tenant India", "Fictional Juliet"])],
    // Every status shows; only the Date Due range filters.
    ["tasks-due", { date_from: "2026-09-26", date_to: "2026-09-30" }, rows => expect(rows.map(row => row.Task)).toEqual(["Fictional lease renewal"])],
    ["compliance-expiry", {}, rows => expect(rows).toHaveLength(7)],
    ["bank-reconciliation-read", {}, rows => expect(rows.map(row => row.Description)).toEqual(["Fictional deposit", "Fictional fee"])],
  ];
  for (const [recipe, inputs, check] of S_READS) {
    it(`${recipe}: rows through grant, fence and account checks, no person asked, nothing consequential pressed`, async () => {
      const f = await fixture();
      const run = await f.start(withOpen(recipe, inputs));
      expect(run.outcome, run.detail).toBe("completed");
      check(filterPortalRunRows(f.pack, withOpen(recipe, inputs), run.results)[1].rows);
      expect(run.receipt.approvals.person).toBe(0);
      expect(f.person).not.toHaveBeenCalled();
      expect(f.mock.effects).toEqual([]);
      // Text reads only: every page read is the helper's observe (a list grid's own scroll is read-only); nothing else is captured.
      expect(f.mock.calls.every(args => ["status", "session", "tab", "observe", "scroll", ...DISPATCH].includes(args[0]))).toBe(true);
      // Direct routes carry the account parameter, and the account was re-checked after every load.
      expect(f.mock.calls.filter(args => args[0] === "navigate").every(args => new URL(args[1]).searchParams.get("reicid") === FICTIONAL_REICID)).toBe(true);
      expect(run.receipt.accountChecks).toBeGreaterThanOrEqual(f.dispatched().length);
      expect((await f.runtime.status()).active).toBe(false);
    });
  }
  it("scopes by the top-bar business code alone when no reicid was saved: addresses carry none, a different code stops", async () => {
    const f = await fixture();
    const run = await f.start(withOpen("find-record", { list: "Tenants", query: "Charlie" }), { account: { marker: FICTIONAL_BUSINESS } });
    expect(run.outcome, run.detail).toBe("completed");
    expect(run.results[1].rows.map(row => row.Reference)).toEqual(["FT-CHARLIE"]);
    expect(f.mock.calls.filter(args => args[0] === "navigate").every(args => !new URL(args[1]).searchParams.has("reicid"))).toBe(true);
    expect(run.receipt.accountChecks).toBeGreaterThanOrEqual(f.dispatched().length);
    const other = await fixture({ business: "FICT2" });
    expect(await other.start(withOpen("find-record", { list: "Tenants", query: "Charlie" }), { account: { marker: FICTIONAL_BUSINESS } })).toMatchObject({ outcome: "handover", reason: "account-marker-changed" });
    expect(other.dispatched()).toEqual([]);
  });
  it("finds a field whose accessible name ends in a colon (live REI's DataTables box reads \"Search:\") and still checks the search applied", async () => {
    const f = await fixture({ searchLabel: "Search:" });
    const run = await f.start(withOpen("find-record", { list: "Owners", query: "Two" }));
    expect(run.outcome, run.detail).toBe("completed");
    expect(run.results[1].rows.map(row => row.Name)).toEqual(["Fictional Owner Two"]);
    // The recipe's own "Search" step covers the "Search:" box: nobody was asked.
    expect(run.receipt.approvals.person).toBe(0);
    expect(f.mock.calls.some(args => args[0] === "fill" && args.includes("Two"))).toBe(true);
    expect(f.mock.effects).toEqual([]);
    expect(((await f.mock.command(["observe"])) as { text: string }).text).toContain('textbox "Search:" value="Two"');
    // Tenants carries a money word (its BPay column): the pack's "Search" still covers "Search:" there.
    const tenants = await f.start(withOpen("find-record", { list: "Tenants", query: "Charlie" }));
    expect(tenants.outcome, `${tenants.reason} ${tenants.detail}`).toBe("completed");
    expect(tenants.results[1].rows.map(row => row.Reference)).toEqual(["FT-CHARLIE"]);
    expect(tenants.receipt.approvals.person).toBe(0);
  });
  it("reads live REI's Syncfusion grid: rows inside rowgroups, a hidden empty-named first column, template cell names", async () => {
    const f = await fixture({ syncfusionGrid: true });
    const row = (ref: string) => Object.fromEntries(FICTIONAL_TENANT_COLUMNS.map((col, i) => [col, FICTIONAL_TENANT_LIST.find(item => item.cells[0] === ref)!.cells[i]]));
    const one = await f.start(withOpen("find-record", { list: "Tenants", query: "Charlie" }));
    expect(one.outcome, `${one.reason} ${one.detail}`).toBe("completed");
    // Each cell keyed by its column with the template suffix gone; the hidden column is not a field.
    expect(one.results[1].rows).toEqual([row("FT-CHARLIE")]);
    const whole = await f.start(withOpen("find-record", { list: "Tenants", query: "" }));
    expect(whole.outcome, whole.detail).toBe("completed");
    // The grid's default Status filter (Active) stands: the recipe changes no unnamed or filter control.
    const active = FICTIONAL_TENANT_LIST.filter(item => item.status === "Active");
    expect(whole.results[1].rows).toEqual(active.map(item => row(item.cells[0])));
    expect(whole.results[1].footer).toBe(active.length);
    expect(f.mock.effects).toEqual([]);
  });
  it("reads Bank Reconciliation's editable form page, also when the page moves its own address while loading, and touches no field", async () => {
    const settles = "/customers/reconciliation/bankreconciliation?BusinessId=fictional-1";
    for (const portal of [{ bankReconciliationForm: true }, { bankReconciliationForm: true, addressSettles: { "/customers/reconciliation/bankreconciliation": [settles] } }]) {
      const f = await fixture(portal);
      const run = await f.start(withOpen("bank-reconciliation-read"));
      expect(run.outcome, `${run.reason} ${run.detail}`).toBe("completed");
      expect(run.results[1].rows.map(row => row.Description)).toEqual(["Fictional deposit", "Fictional fee"]);
      expect(run.results[1].filters).toMatchObject({ "Statement Balance": "1185.00", Reconciled: "30/09/2026" });
      // A read never types, chooses or presses anything on the form: only the routes were opened.
      expect(f.dispatched().map(args => args[0])).toEqual(["navigate", "navigate"]);
      expect(f.mock.effects).toEqual([]);
      if (portal.addressSettles) expect(f.mock.url()).toBe(`https://rei-mock.fictional.test${settles}`);
    }
    // An address that moves again on the second read is still refused, and nothing was done on the page.
    const moving = await fixture({ bankReconciliationForm: true, addressSettles: { "/customers/reconciliation/bankreconciliation": [settles, `${settles}&again=1`] } });
    expect(await moving.start(withOpen("bank-reconciliation-read"))).toMatchObject({ outcome: "blocked", reason: "broker-refused", detail: "The page changed during the read. Read it again before acting." });
    expect(moving.dispatched().map(args => args[0])).toEqual(["navigate", "navigate"]);
    expect(moving.mock.effects).toEqual([]);
  });
  it("counts a DataTables \"Showing 1 to N of N entries\" line as the record count; a filtered table counts its unfiltered total", async () => {
    const f = await fixture({}, { actions: ["read", "click", "navigate", "fill", "keys"] });
    const arrears = (steps: PortalPackRecipe["steps"]) => ({ pack: { ...f.pack, recipes: { ...f.pack.recipes, "arrears-live": { ...f.pack.recipes["arrears-review"], inputs: [], steps } } } });
    const open = [{ nav: ["Process", "Arrears"] }, { check: "account" }, { wait: "table" }];
    const whole = await f.start(withOpen("arrears-live"), arrears([...open, { read: "table" }, { paginate: true }]));
    expect(whole.outcome, `${whole.reason} ${whole.detail}`).toBe("completed");
    // Seven tenants are a day or more behind, over two pages of five: "Showing 1 to 5 of 7 entries".
    expect(whole.results[1]).toMatchObject({ footer: 7, pages: 2 });
    expect(whole.results[1].rows.map(row => row["Days Arrears"])).toEqual(["9", "6", "11", "13", "16", "22", "10"]);
    const searched = (query: string) => f.start(withOpen("arrears-live"), arrears([...open, { type: { field: "Search", value: query } }, { wait: "table" }, { read: "table" }]));
    // "Showing 1 to 1 of 1 entries (filtered from 7 total entries)": one row, counted against the whole list, so never read whole.
    const one = await searched("Tenant Bravo");
    expect(one.outcome, `${one.reason} ${one.detail}`).toBe("completed");
    expect(one.results[1].rows.map(row => row.Name)).toEqual(["Fictional Tenant Bravo"]);
    expect(one.results[1].footer).toBe(7);
    // "Showing 0 to 0 of 0 entries (filtered from 7 total entries)": settles as empty instead of waiting out.
    const none = await searched("Nobody");
    expect(none.outcome, `${none.reason} ${none.detail}`).toBe("completed");
    expect(none.results[1]).toMatchObject({ rows: [], table: "empty", footer: 7 });
    expect(f.mock.effects).toEqual([]);
  });
  it("waits for the tenants grid to fill: \"No records to display\" before its record count is not an empty result", async () => {
    const f = await fixture();
    const run = await f.start(withOpen("find-record", { list: "Tenants", query: "Fictional" }));
    expect(run.outcome, run.detail).toBe("completed");
    expect(run.results[1].rows.length).toBeGreaterThan(5);
    expect(run.results[1].pages).toBe(1);
    // Each load showed the empty grid first and was read again.
    const texts = f.mock.calls.filter(args => args[0] === "observe").length;
    expect(texts).toBeGreaterThan(f.dispatched().length + 2);
    // A filter with no match settles as empty once the footer says 0 records.
    const none = await f.start(withOpen("find-record", { list: "Tenants", query: "Nobody" }));
    expect(none.outcome, none.detail).toBe("completed");
    expect(none.results[1]).toMatchObject({ table: "empty", rows: [] });
  });
  it("tenant-list and supplier-list read every grid row by scrolling only the pack's declared container: no export, nobody asked", async () => {
    const f = await fixture({ gridBlock: 3 });
    const runs = [{ recipe: "open-session" }, { recipe: "tenant-list" }, { recipe: "supplier-list" }];
    expect(portalRecipeGrantNeeds(f.pack, runs).actions.sort()).toEqual(["click", "navigate", "read"]);
    const run = await f.start(runs);
    expect(run.outcome, run.detail).toBe("completed");
    // Tenants renders 3 of its 10 Active rows until its content scrolls; the read keeps scrolling until no more load.
    expect(run.results[1]).toMatchObject({ table: "rows", footer: 10, pages: 1 });
    expect(run.results[1].rows.map(row => row.Reference)).toEqual(["FT-ALPHA", "FT-BRAVO", "FT-CHARLIE", "FT-ECHO", "FT-FOXTROT", "FT-GOLF", "FT-HOTEL", "FT-JULIET", "FT-BRAVO2", "FT-KILO"]);
    expect(run.results[1].rows[0]).toMatchObject({ Surname: "Alpha", Property: "FP-01", "BPay/Ref No.": "4470001", Email: "alpha@fictional-tenant.test", Fax: "" });
    expect(run.results[2]).toMatchObject({ table: "rows", footer: 5 });
    expect(run.results[2].rows).toHaveLength(5);
    const scrolls = f.mock.calls.filter(args => args[0] === "scroll");
    expect(scrolls.every(args => args.slice(0, 5).join(" ") === "scroll down 100000 --selector .e-gridcontent .e-content")).toBe(true);
    // Tenants 3 → 6 → 9 → 10 → 10 (four scrolls, then stable); Suppliers is whole at once (two).
    expect(scrolls).toHaveLength(6);
    expect(f.mock.calls.some(args => ["download", "select", "fill"].includes(args[0]))).toBe(false);
    expect(run.receipt.approvals.person).toBe(0); expect(f.person).not.toHaveBeenCalled();
    expect(f.mock.effects).toEqual([]);
    // Without the pack's declaration nothing scrolls, and the read is short of the footer.
    const { grid: _grid, ...plain } = f.pack;
    const short = await f.start(withOpen("tenant-list"), { pack: plain });
    expect(short.outcome, short.detail).toBe("completed");
    expect(short.results[1]).toMatchObject({ footer: 10, rows: expect.any(Array) });
    expect(short.results[1].rows).toHaveLength(3);
    expect(f.mock.calls.filter(args => args[0] === "scroll")).toHaveLength(6);
  });
  it("open-session and unknown-screen-study (menu labels, no route) complete", async () => {
    const f = await fixture();
    const run = await f.start(withOpen("unknown-screen-study", { top_label: "Communities" }));
    expect(run.outcome, run.detail).toBe("completed");
    expect(run.results[1].controls).toContain("Search");
    expect(f.mock.calls.some(args => args[0] === "click")).toBe(true);
    expect(run.receipt.flags).toEqual([]);
  });
  it("arrears-review reaches Notice and stops before it: never pressed, reported", async () => {
    const f = await fixture();
    const run = await f.start(withOpen("arrears-review", { min_days: "1" }));
    expect(run.results[1].stopBefore).toEqual(["Notice"]);
    expect(run.results[1].pages).toBe(2);
    expect(run.results[1].filters).toMatchObject({ "Show entries": "All" });
    expect(f.mock.effects).toEqual([]);
  });
  it("a recipe that tries to press a consequential label ends before it; a label outside read-safe is refused", async () => {
    const f = await fixture();
    const base = f.pack.recipes["arrears-review"];
    const pack = { ...f.pack, recipes: { ...f.pack.recipes,
      "arrears-notice": { ...base, steps: [...base.steps.slice(0, 3), { click: "Notice" }] },
      "arrears-other": { ...base, steps: [...base.steps.slice(0, 3), { click: "Load" }] } } };
    const notice = await f.start(withOpen("arrears-notice", { min_days: "1" }), { pack });
    expect(notice).toMatchObject({ outcome: "stopped-before", reason: "consequential-label", detail: "Notice" });
    const other = await f.start(withOpen("arrears-other", { min_days: "1" }), { pack });
    expect(other).toMatchObject({ outcome: "blocked", reason: "not-read-safe" });
    expect(f.mock.calls.filter(args => args[0] === "click")).toEqual([]);
    expect(f.mock.effects).toEqual([]); expect(f.person).not.toHaveBeenCalled();
  });
  it("a learned label reaches the page only when harmless, and never in a loop's read", async () => {
    const f = await fixture();
    const base = f.pack.recipes["arrears-review"];
    const clicking = (label: string) => ({ ...base, steps: [...base.steps.slice(0, 3), { click: label }] });
    const labels = ["Load", "Continue", "Ｓａｖｅ", "Pay now"];
    const pack = { ...f.pack, recipes: { ...f.pack.recipes, ...Object.fromEntries(labels.map(label => [`arrears-${label}`, clicking(label)])) } };
    expect(portalRecipeControls(pack)).not.toHaveProperty("learnedReadSafe");
    expect(portalRecipeControls(pack, undefined, labels).learnedReadSafe).toEqual(labels);
    // "Load" passes the runner's read-safe check (and then is not on the page); a confirming or paying name never does.
    expect(await f.start(withOpen("arrears-Load", { min_days: "1" }), { pack, learnedReadSafe: labels })).toMatchObject({ outcome: "blocked", reason: "control-missing" });
    for (const label of ["Continue", "Ｓａｖｅ", "Pay now"]) {
      expect(await f.start(withOpen(`arrears-${label}`, { min_days: "1" }), { pack, learnedReadSafe: labels }), label).toMatchObject({ outcome: "blocked", reason: "not-read-safe", detail: label });
    }
    // A loop's read never sees learned labels, harmless or not.
    const runs = withOpen("arrears-Load", { min_days: "1" }); const needs = portalRecipeGrantNeeds(pack, runs);
    const loop = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: `grant-${randomUUID()}`, runId: `run-${randomUUID()}`, route: "loop-read",
      request: { text: "Fictional loop read", sha256: sha256("Fictional loop read") }, sites: needs.sites, browser: { id: null, accountMarker: FICTIONAL_BUSINESS },
      actions: needs.actions, consequential: "ask-each", uploads: [], expiresAt: null, budget: null });
    expect(await f.start(runs, { pack, grant: loop, learnedReadSafe: labels })).toMatchObject({ outcome: "blocked", reason: "not-read-safe", detail: "Load" });
    expect(f.mock.calls.filter(args => args[0] === "click")).toEqual([]);
    expect(f.mock.effects).toEqual([]); expect(f.person).not.toHaveBeenCalled();
  });
  it("runs the morning batch under one grant, one borrow and one browser session", async () => {
    const f = await fixture();
    const run = await f.start(MORNING(f.pack));
    expect(run.outcome, run.detail).toBe("completed");
    expect(run.results.map(result => [result.recipe, result.outcome])).toEqual([["open-session", "completed"], ["arrears-review", "completed"], ["tasks-due", "completed"], ["bank-reconciliation-read", "completed"]]);
    expect(run.results.map(result => result.rows.length)).toEqual([0, 7, 3, 2]);
    expect(filterPortalRunRows(f.pack, MORNING(f.pack), run.results).map(result => result.rows.length)).toEqual([0, 7, 3, 2]);
    expect(f.mock.calls.filter(args => args[0] === "tab" && args[1] === "borrow")).toHaveLength(1);
    expect(f.mock.calls.filter(args => args[0] === "session" && args[1] === "start")).toHaveLength(1);
    expect(run.receipt.steps.every(step => step.ok)).toBe(true);
    // The receipt holds identifiers and hashes, never typed values or rows.
    expect(JSON.stringify(run.receipt)).not.toMatch(/Fictional Tenant|2026-09-30/);
  });
  it("pages through the bank reconciliation grid with Next as reading: no submit in the grant, nobody asked, nothing pressed", async () => {
    const f = await fixture({ pageSize: 1 });
    const needs = portalRecipeGrantNeeds(f.pack, MORNING(f.pack));
    expect(needs.actions).not.toContain("submit");
    expect(needs.sites).toContain("https://signin.rei-mock.fictional.test");
    const run = await f.start(MORNING(f.pack));
    expect(run.outcome, run.detail).toBe("completed");
    const bank = run.results[3];
    expect(bank.recipe).toBe("bank-reconciliation-read");
    expect(bank.pages).toBe(2);
    expect(bank.rows.map(row => row.Description)).toEqual(["Fictional deposit", "Fictional fee"]);
    expect(bank.stopBefore).toEqual(["Reconcile"]);
    expect(run.results.map(result => result.rows.length)).toEqual([0, 7, 3, 2]);
    expect(filterPortalRunRows(f.pack, MORNING(f.pack), run.results).map(result => result.rows.length)).toEqual([0, 7, 3, 2]);
    expect(run.receipt.approvals.person).toBe(0);
    expect(f.person).not.toHaveBeenCalled();
    expect(f.mock.effects).toEqual([]);
    // Next was pressed on the bank page itself (the page names a bank), and only Next and menu-free clicks happened.
    const bankNav = f.mock.calls.findIndex(args => args[0] === "navigate" && args[1].includes("/customers/reconciliation/bankreconciliation"));
    expect(bankNav).toBeGreaterThan(-1);
    expect(f.mock.calls.slice(bankNav).filter(args => args[0] === "click")).toHaveLength(1);
  });
  it("pauses at the sign-in page for the person, resumes the same task and re-checks the account", async () => {
    const f = await fixture({ signedOut: true });
    const waiting = vi.fn(() => true); const finished = vi.fn();
    cleanup.push(onBrowserSignIn({ waiting, finished }));
    const run = await f.start(withOpen("tasks-due", { date_from: "2026-09-25", date_to: "2026-09-30" }));
    expect(run.outcome, run.detail).toBe("completed");
    expect(f.mock.calls.filter(args => args[0] === "request-help")).toHaveLength(1);
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ signedIn: true }));
    // Nothing was typed into the sign-in page: the first dispatch happens after the resume.
    const help = f.mock.calls.findIndex(args => args[0] === "request-help");
    expect(f.mock.calls.slice(0, help).some(args => DISPATCH.has(args[0]))).toBe(false);
    expect(run.results[1].rows).toHaveLength(3);
  });
  it("hands over when the person does not finish sign-in", async () => {
    const cancelled = await fixture({ signedOut: true, helpOutcome: "cancelled" });
    cleanup.push(onBrowserSignIn({ waiting: () => true, finished: () => {} }));
    expect(await cancelled.start(withOpen("tasks-due", { date_from: "2026-09-25", date_to: "2026-09-30" }))).toMatchObject({ outcome: "handover", reason: "sign-in" });
    expect(cancelled.dispatched()).toEqual([]);
  });
  it("hands over at the sign-in page when no one can be asked in the page", async () => {
    const f = await fixture({ signedOut: true });
    expect(await f.start(withOpen("tasks-due", { date_from: "2026-09-25", date_to: "2026-09-30" }))).toMatchObject({ outcome: "handover", reason: "sign-in" });
    expect(f.mock.calls.some(args => args[0] === "request-help")).toBe(false);
    expect(f.dispatched()).toEqual([]);
  });
  it("stops when the business changes mid-task, before any further step", async () => {
    // The header changes once four page-changing commands have run (navigate, navigate, Show entries, Next):
    // the read after the fourth stops the run before that page's rows are counted.
    const f = await fixture({ switchBusinessAfterSteps: 3 });
    const run = await f.start(MORNING(f.pack));
    expect(run).toMatchObject({ outcome: "handover", reason: "account-marker-changed" });
    expect(f.dispatched().map(args => args[0])).toEqual(["navigate", "navigate", "select", "click"]);
    expect(run.results.map(result => result.outcome)).toEqual(["completed", "handover", "not-run", "not-run"]);
    expect(f.mock.effects).toEqual([]);
  });
  it("stops when a reicid-only direct route opens a different business", async () => {
    const f = await fixture({ directBusiness: "FICT2" });
    const run = await f.start(withOpen("arrears-review", { min_days: "1" }));
    expect(run).toMatchObject({ outcome: "handover", reason: "account-marker-changed" });
    expect(f.dispatched().map(args => args[0])).toEqual(["navigate"]);
  });
  it("Stop mid-run ends the task at once and releases the browser", async () => {
    const controller = new AbortController();
    const f = await fixture();
    const inner = f.mock.command; let navs = 0;
    const runtime = new BrowserRuntime({ root: privateTempRoot(join(tmpdir(), "rb-recipe-stop-")), command: async (args: string[]): Promise<BrowserJson> => {
      const result = await inner(args); if (args[0] === "navigate" && ++navs === 2) controller.abort(); return result;
    }, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
    cleanup.push(() => removeFixture(runtime.root));
    await runtime.connect(); await runtime.select("work");
    const run = await f.start(MORNING(f.pack), { runtime, signal: controller.signal });
    expect(run.outcome).toBe("stopped");
    const second = f.mock.calls.findIndex(args => args[0] === "navigate" && f.mock.calls.filter(a => a[0] === "navigate").indexOf(args) === 1);
    expect(f.mock.calls.slice(second + 1).some(args => DISPATCH.has(args[0]))).toBe(false);
    expect((await runtime.status()).active).toBe(false);
  });
  it("stops pagination when Next shows the same page again, instead of counting it twice", async () => {
    const f = await fixture({ stuckPagination: true });
    const run = await f.start(withOpen("arrears-review", { min_days: "1" }));
    expect(run).toMatchObject({ outcome: "blocked", reason: "pagination-stalled" });
    expect(f.mock.calls.filter(args => args[0] === "click")).toHaveLength(1);
  });
  it("holds an upload with an unknown result and never uploads again", async () => {
    const operations = new ConnectedAppOperationStore({ file: join(privateTempRoot(join(tmpdir(), "rb-recipe-ops-")), "operations.json") });
    const f = await fixture({ unknownUpload: true }, { upload: Buffer.from('25/09/2026,"540.00",FICTIONAL PAYMENT,,,,,FT-BRAVO\n'), operations });
    // The person approves each step the recipe cannot answer for (the file format on a banking page, the upload).
    f.person.mockImplementation(async () => true);
    const inputs = { bank_format: "ANZ(csv file)", approved_file: "fictional-bank.csv", approved_sha256: sha256('25/09/2026,"540.00",FICTIONAL PAYMENT,,,,,FT-BRAVO\n'), expected_rows: "1", expected_total: "540.00" };
    const first = await f.start(withOpen("bulk-receipting-preview", inputs));
    expect(first).toMatchObject({ outcome: "hold", reason: "unknown-result" });
    expect(f.person.mock.calls.map(call => call[0])).toContain("browser_upload");
    expect(operations.list("thread-fictional").some(op => op.toolName === "browser_upload" && op.status === "unknown")).toBe(true);
    // A later run on the same task thread refuses before touching the file control.
    const again = await f.start(withOpen("bulk-receipting-preview", inputs));
    expect(again).toMatchObject({ outcome: "hold", reason: "earlier-upload-unknown" });
    expect(f.mock.calls.filter(args => args[0] === "upload")).toHaveLength(1);
    expect(f.mock.effects).toEqual(["upload"]);
  });
  it("refuses an upload the person does not approve, and never on its own authority", async () => {
    const f = await fixture({}, { upload: Buffer.from('25/09/2026,"0.00",FICTIONAL EMPTY,,,,,\n') });
    const run = await f.start(withOpen("bulk-receipting-preview", { bank_format: "ANZ(csv file)", approved_file: "fictional-bank.csv", approved_sha256: sha256('25/09/2026,"0.00",FICTIONAL EMPTY,,,,,\n'), expected_rows: "1", expected_total: "0" }));
    expect(run).toMatchObject({ outcome: "handover", reason: "not-approved" });
    expect(f.mock.calls.filter(args => args[0] === "upload")).toEqual([]);
  });
  it("uploads only the file whose hash the run names, and only while the private copy still has it", async () => {
    const bytes = Buffer.from('25/09/2026,"540.00",FICTIONAL PAYMENT,,,,,FT-BRAVO\n');
    const inputs = { bank_format: "ANZ(csv file)", approved_file: "fictional-bank.csv", expected_rows: "1", expected_total: "540.00" };
    // No hash, or another file's hash: refused before the person is asked about the upload.
    for (const approved of [{}, { approved_sha256: sha256("other reviewed bytes") }] as Array<Record<string, string>>) {
      const f = await fixture({}, { upload: bytes });
      f.person.mockImplementation(async () => true);
      expect(await f.start(withOpen("bulk-receipting-preview", { ...inputs, ...approved }))).toMatchObject({ outcome: "handover", reason: "upload-not-bound" });
      expect(f.person.mock.calls.map(call => call[0])).not.toContain("browser_upload");
      expect(f.mock.effects).toEqual([]);
    }
    // The bound file changed in the task's private folder after the grant: refused, nothing sent.
    const f = await fixture({}, { upload: bytes });
    f.person.mockImplementation(async () => true);
    const run = await f.start(withOpen("bulk-receipting-preview", { ...inputs, approved_sha256: sha256(bytes) }), {
      approve: async (tool, params, summary, signal, projection) => {
        if (tool === "browser_select") { const path = join(f.workroomOf(), "uploads", "fictional-bank.csv"); chmodSync(path, 0o600); writeFileSync(path, "changed"); }
        return f.person(tool, params, summary, signal, projection);
      },
    });
    expect(run).toMatchObject({ outcome: "handover", reason: "upload-changed" });
    expect(f.mock.calls.filter(args => args[0] === "upload")).toEqual([]);
    // The bound, unchanged file previews.
    const ok = await fixture({}, { upload: bytes });
    ok.person.mockImplementation(async () => true);
    const done = await ok.start(withOpen("bulk-receipting-preview", { ...inputs, approved_sha256: sha256(bytes) }));
    expect(done.outcome, done.detail).toBe("completed");
    expect(done.results[1].stopBefore).toEqual(expect.arrayContaining(["Process Receipts", "Receipt All"]));
    expect(ok.mock.effects).toEqual(["upload"]);
  });
  it("refuses before opening the browser when the grant is narrower than the recipes", async () => {
    const f = await fixture({}, { actions: ["read", "navigate", "click"] });
    const run = await f.start(withOpen("arrears-review", { min_days: "1" }));
    expect(run).toMatchObject({ outcome: "blocked", reason: "grant-too-narrow" });
    expect(f.mock.calls.some(args => args[0] === "session")).toBe(false);
  });
});

describe("a drifted control's fallback chooser (Ask only, guarded; fictional REI mock, stubbed Jev)", () => {
  const ALL: BrowserActionClass[] = ["read", "click", "navigate", "fill", "keys", "upload", "download"];
  const OWNER_TWO = withOpen("find-record", { list: "Owners", query: "Two" });
  /** A stub Jev: answers the option whose criterion is `target` (role "name"), else "none"; `probabilities` overrides the clear lead. */
  const jevPicks = (target: string, confidence = 0.99, probabilities?: (keys: string[], choice: string) => Record<string, number>) => vi.fn<PortalChooser>(async request => {
    const criteria = (request.questions.control as { criteria: Record<string, string> }).criteria;
    const keys = Object.keys(criteria); const choice = keys.find(key => criteria[key] === target) ?? "none";
    return { ok: true, model: "fictional-jev-1", ms: 3, answers: { control: { type: "choice", choice, confidence,
      probabilities: probabilities ? probabilities(keys, choice) : Object.fromEntries(keys.map(key => [key, key === choice ? 0.97 : 0.03 / (keys.length - 1)])) } } };
  });
  const step = (run: Awaited<ReturnType<typeof runPortalRecipes>>, verb: string) => run.receipt.steps.filter(item => item.verb === verb).at(-1)!;
  const loopGrant = (pack: PortalRecipePack, runs: PortalRunRequest[]) => parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: `grant-${randomUUID()}`, runId: `run-${randomUUID()}`,
    route: "loop-read", request: { text: "Fictional loop read", sha256: sha256("Fictional loop read") }, sites: portalRecipeGrantNeeds(pack, runs).sites,
    browser: { id: null, accountMarker: FICTIONAL_BUSINESS }, actions: portalRecipeGrantNeeds(pack, runs).actions, consequential: "ask-each", uploads: [], expiresAt: null, budget: null });

  it("picks a renamed Search box (\"Find\"), types through the broker with every ask sent to the person, and records the chooser and the drift", async () => {
    // Today: the recipe's Search step finds no "Find" box and blocks.
    const today = await fixture({ searchLabel: "Find" });
    expect(await today.start(OWNER_TWO)).toMatchObject({ outcome: "blocked", reason: "field-missing" });
    const f = await fixture({ searchLabel: "Find" });
    f.person.mockImplementation(async () => true);
    const chooser = jevPicks('textbox "Find"');
    const run = await f.start(OWNER_TWO, { chooser });
    expect(run.outcome, `${run.reason} ${run.detail}`).toBe("completed");
    expect(run.results[1].rows.map(row => row.Name)).toEqual(["Fictional Owner Two"]);
    expect(((await f.mock.command(["observe"])) as { text: string }).text).toContain('textbox "Find" value="Two"');
    // Jev saw the step, the wanted label, the page's title and path, and role + name of the same-role controls only.
    expect(chooser).toHaveBeenCalledTimes(1);
    const [request] = chooser.mock.calls[0];
    expect(request.state).toEqual({ step: "type", wanted: "Search", page: { title: "Owners - REI Cloud", path: "/customers/owner" }, candidates: [{ role: "textbox", name: "Find" }] });
    expect(Object.keys((request.questions.control as { criteria: Record<string, string> }).criteria)).toEqual(["c0", "none"]);
    expect(step(run, "type").chooser).toEqual({ model: "fictional-jev-1", questionSha256: sha256(JSON.stringify(request)), candidates: [{ role: "textbox", name: "Find" }],
      pick: "c0", confidence: 0.99, top3: [0.97, 0.03], outcome: "picked", ms: expect.any(Number) });
    expect(run.receipt.flags).toContain('map-drift: "Search" → "Find"');
    // A pick is never recipe-covered: the fill and its Tab were each the person's to allow.
    expect(f.person.mock.calls.map(call => call[0])).toEqual(["browser_fill", "browser_press"]);
    expect(run.receipt.approvals.person).toBe(2);
    expect(f.mock.effects).toEqual([]);
    expect(JSON.stringify(run.receipt)).not.toContain("Fictional Owner");
  });

  it("an ambiguous field (two \"Search\" boxes) is chosen by place, and typed and committed in that same box", async () => {
    const f = await fixture();
    f.person.mockImplementation(async () => true);
    // A second, unbound Search box after the real one: Jev answers the first.
    const runtime = new BrowserRuntime({ root: privateTempRoot(join(tmpdir(), "rb-recipe-twice-")), command: async (args: string[], signal?: AbortSignal): Promise<BrowserJson> => {
      const out = await f.mock.command(args, signal);
      return args[0] === "observe" && typeof out.text === "string" ? { ...out, text: out.text.replace(/^( {8}@e\d+ textbox "Search" value="[^"]*")$/m, '$1\n        @e900 textbox "Search" value=""') } : out;
    }, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
    cleanup.push(() => removeFixture(runtime.root));
    await runtime.connect(); await runtime.select("work");
    expect(await f.start(OWNER_TWO, { runtime })).toMatchObject({ outcome: "blocked", reason: "ambiguous-control" });
    const chooser = vi.fn<PortalChooser>(async () => ({ ok: true, model: "fictional-jev-1", ms: 1, answers: { control: { type: "choice", choice: "c0", confidence: 0.99, probabilities: { c0: 0.98, c1: 0.01, none: 0.01 } } } }));
    const run = await f.start(OWNER_TWO, { runtime, chooser });
    expect(run.outcome, `${run.reason} ${run.detail}`).toBe("completed");
    expect(run.results[1].rows.map(row => row.Name)).toEqual(["Fictional Owner Two"]);
    expect(step(run, "type").chooser).toMatchObject({ outcome: "picked", candidates: [{ role: "textbox", name: "Search" }, { role: "textbox", name: "Search" }] });
    expect(f.mock.calls.filter(args => args[0] === "fill" || args[0] === "press").every(args => !args.includes("@e900"))).toBe(true);
  });

  it("below the threshold, or answered none, blocks as today and touches nothing", async () => {
    const cases: Array<[string, PortalChooser]> = [
      ["low confidence", jevPicks('textbox "Find"', 0.9)],
      ["narrow lead", jevPicks('textbox "Find"', 0.99, (keys, choice) => Object.fromEntries(keys.map(key => [key, key === choice ? 0.6 : 0.4])))],
      ["no probabilities", jevPicks('textbox "Find"', 0.99, () => ({}))],
      ["none", jevPicks('textbox "Nothing"')],
    ];
    for (const [name, chooser] of cases) {
      const f = await fixture({ searchLabel: "Find" });
      const run = await f.start(OWNER_TWO, { chooser });
      expect(run, name).toMatchObject({ outcome: "blocked", reason: "field-missing" });
      expect(step(run, "type").chooser?.outcome, name).toBe("below-threshold");
      expect(run.receipt.flags.some(flag => flag.startsWith("map-drift:")), name).toBe(false);
      expect(f.mock.calls.some(args => args[0] === "fill"), name).toBe(false);
      expect(f.person, name).not.toHaveBeenCalled();
    }
  });

  it("never picks a consequential decoy, even when Jev names it with confidence", async () => {
    // A click step whose read-safe control is gone: Jev names the page's Notice button.
    const f = await fixture();
    const base = f.pack.recipes["arrears-review"];
    const pack = { ...f.pack, recipes: { ...f.pack.recipes, "arrears-period": { ...base, steps: [...base.steps.slice(0, 3), { click: "Current Period" }] } } };
    const chooser = jevPicks('button "Notice"');
    const click = await f.start(withOpen("arrears-period", { min_days: "1" }), { pack, chooser });
    expect(click).toMatchObject({ outcome: "blocked", reason: "control-missing" });
    expect(step(click, "click").chooser).toMatchObject({ outcome: "refused-by-guard", confidence: 0.99 });
    expect(step(click, "click").chooser!.candidates).toContainEqual({ role: "button", name: "Notice" });
    // The pager renamed: Jev names Notice for "Next page"; paging ends as it does today, on the first page.
    const pager = { ...f.pack, pagination: { ...f.pack.pagination, next: "Next page" } };
    const paged = await f.start(withOpen("arrears-review", { min_days: "1" }), { pack: pager, chooser });
    expect(paged.outcome, `${paged.reason} ${paged.detail}`).toBe("completed");
    expect(paged.results[1].pages).toBe(1);
    expect(step(paged, "paginate").chooser?.outcome).toBe("refused-by-guard");
    expect(f.mock.calls.filter(args => args[0] === "click")).toEqual([]);
    expect(f.mock.effects).toEqual([]); expect(f.person).not.toHaveBeenCalled();
    // A label the recipe stops before is never sent to Jev at all.
    const g = await fixture({}, { actions: ALL });
    const stopping = { ...g.pack, recipes: { ...g.pack.recipes, "arrears-email": { ...base, steps: [...base.steps.slice(0, 3), { type: { field: "Email", value: "x" } }] } } };
    expect(await g.start(withOpen("arrears-email", { min_days: "1" }), { pack: stopping, chooser })).toMatchObject({ outcome: "blocked", reason: "field-missing" });
    expect(chooser).toHaveBeenCalledTimes(2);
  });

  it("a loop's unattended read never asks the chooser: a missing control stays a block", async () => {
    const f = await fixture({ searchLabel: "Find" });
    const chooser = jevPicks('textbox "Find"');
    const run = await f.start(OWNER_TWO, { chooser, grant: loopGrant(f.pack, OWNER_TWO) });
    expect(run).toMatchObject({ outcome: "blocked", reason: "field-missing" });
    expect(chooser).not.toHaveBeenCalled();
    expect(run.receipt.steps.some(item => item.chooser)).toBe(false);
  });

  it("upload, download and menu steps never ask the chooser, and a pick earlier in the run hands the upload back", async () => {
    const bytes = Buffer.from('25/09/2026,"540.00",FICTIONAL PAYMENT,,,,,FT-BRAVO\n');
    const f = await fixture({}, { upload: bytes, actions: ALL });
    f.person.mockImplementation(async () => true);
    const recipe = (steps: PortalPackRecipe["steps"]): PortalPackRecipe => ({ kind: "read", tier: [], inputs: [], grantNeeds: [], steps, stopBefore: [] });
    const pack = { ...f.pack, recipes: { ...f.pack.recipes,
      "drift-nav": recipe([{ nav: ["Ownerz"] }]),
      "drift-download": recipe([{ nav: ["Process", "Arrears"] }, { check: "account" }, { wait: "table" }, { download: { label: "Export Arrears" } }]),
      "drift-upload": recipe([{ nav: ["Receipts", "Bulk Receipting"] }, { check: "account" }, { upload: { field: "Load Bank File", file: "{approved_file}" } }]),
      "drift-then-upload": recipe([{ nav: ["Receipts", "Bulk Receipting"] }, { check: "account" }, { select: { field: "Bank Format", option: "ANZ(csv file)" } }, { upload: { field: "Load File", file: "{approved_file}" } }]) } };
    const inputs = { approved_file: "fictional-bank.csv", approved_sha256: sha256(bytes) };
    const chooser = jevPicks('button "Notice"');
    expect(await f.start([{ recipe: "drift-nav" }], { pack, chooser })).toMatchObject({ outcome: "blocked", reason: "menu-label-missing" });
    expect(await f.start([{ recipe: "drift-download" }], { pack, chooser })).toMatchObject({ outcome: "blocked", reason: "control-missing" });
    expect(await f.start([{ recipe: "drift-upload", inputs }], { pack, chooser })).toMatchObject({ outcome: "blocked", reason: "field-missing" });
    expect(chooser).not.toHaveBeenCalled();
    // A select step picked by the chooser (File Format for "Bank Format") marks the page drifted: the upload after it goes back to the person.
    const picks = jevPicks('combobox "File Format"');
    const drifted = await f.start([{ recipe: "drift-then-upload", inputs }], { pack, chooser: picks });
    expect(drifted).toMatchObject({ outcome: "handover", reason: "map-drift-blocks-upload" });
    expect(step(drifted, "select").chooser?.outcome).toBe("picked");
    expect(f.mock.calls.filter(args => args[0] === "upload")).toEqual([]);
    expect(f.mock.calls.filter(args => args[0] === "download")).toEqual([]);
    expect(f.mock.effects).toEqual([]);
  });

  it("a chooser that fails, times out or throws blocks as today", async () => {
    const results: Array<[string, PortalChooser]> = [
      ["timeout", async () => ({ ok: false, reason: "timeout" })],
      ["budget", async () => ({ ok: false, reason: "budget" })],
      ["throws", async () => { throw new Error("fictional outage"); }],
      ["other question", async () => ({ ok: true, model: "fictional-jev-1", ms: 1, answers: {} })],
    ];
    for (const [name, chooser] of results) {
      const f = await fixture({ searchLabel: "Find" });
      const run = await f.start(OWNER_TWO, { chooser });
      expect(run, name).toMatchObject({ outcome: "blocked", reason: "field-missing" });
      expect(step(run, "type").chooser, name).toMatchObject({ outcome: "no-answer", model: name === "other question" ? "fictional-jev-1" : null, pick: null });
      expect(f.mock.calls.some(args => args[0] === "fill"), name).toBe(false);
    }
  });
});
