// The REI morning refresh loop (docs/decisions/2026-10-06-rei-source-of-truth-and-client-packs.md):
// read-only and unattended in the person's already signed-in REI session, a miss when signed out,
// one Desk apply after the read, one refresh at a time. Runs RealBud's real runtime, broker, runner,
// Desk and clock against the FICTIONAL REI portal only: proof of RealBud's wiring and guards, never
// of REI Cloud.
import { copyFileSync, cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseBrowserBrokers, startBrowserBroker } from "./browser-broker.ts";
import { BrowserRuntime } from "./browser-runtime.ts";
import { Desk } from "./desk.ts";
import { portalRecipeGrantNeeds, type PortalRunRequest } from "./portal-recipe-runner.ts";
import { loadPortalRecipePack, loadPortalSiteMap, loadShippedPortalRecipePack, loopReadRefusal, runPortalReadLoop } from "./portal-recipe-task.ts";
import { createReiMorningRefresh, REI_SIGN_IN_MISSED, reiMorningRuns } from "./rei-morning-refresh.ts";
import { LoopManager } from "./routines.ts";
import { FICTIONAL_BUSINESS, FICTIONAL_REI_ORIGIN, FICTIONAL_TENANT_LIST, fictionalBook, fictionalReiPack, fictionalReiPortal, type FictionalReiOptions } from "./testing/fictional-rei-portal.ts";
import { LEARNED_LEAK_LABEL, LEARNED_LEAK_RECIPE, publishLearnedInDataDir, saveApprovedPathInDataDir } from "./testing/learned-recipe-fixture.ts";
import { plantPrivateFile, privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { parseBrowserTaskGrant, type BrowserTaskGrant } from "../shared/browser-task.ts";
import { governApprovals } from "./approval-settings.ts";
import type { ApprovalChoice, ApprovalSettings } from "../shared/approval-settings.ts";
import { buildDeskQueue, recoveryPlanFor } from "../src/lib/desk-queue.ts";

// The real loaders, wrapped so a test can see which one an unattended loop used and what it got.
vi.mock("./portal-recipe-task.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./portal-recipe-task.ts")>();
  return { ...real, loadPortalRecipePack: vi.fn(real.loadPortalRecipePack), loadShippedPortalRecipePack: vi.fn(real.loadShippedPortalRecipePack) };
});

const dirs: string[] = [];
const managers: LoopManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) await removeFixture(dir);
});
const KEY = Buffer.alloc(32, 9);
const T0 = new Date(2026, 9, 6, 7, 0, 0).getTime();
const ACCOUNT = { marker: FICTIONAL_BUSINESS };

async function fixture(options: FictionalReiOptions = {}) {
  const root = privateTempRoot(join(tmpdir(), "rb-rei-refresh-")); dirs.push(root);
  // The clock and Desk share one durable workspace, so retain its synthetic
  // key as a source-run workspace would; an inline Desk key alone is not escrow.
  plantPrivateFile(join(root, "desk.key"), KEY);
  const mock = fictionalReiPortal(options);
  const runtime = new BrowserRuntime({ root, command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  let now = T0;
  const deskFile = join(root, "desk.json");
  const desk = new Desk({ file: deskFile, now: () => now, key: KEY });
  desk.startLiveBook();
  desk.addProperty({ address: "2 Fictional St", propertyCode: "FP-02", tenantName: "Fictional Tenant Bravo", tenantPhone: "0400 000 002", weeklyRentCents: 54_000 });
  const deps = { desk, runtime, browserId: async () => "work", account: async () => ACCOUNT, today: async () => "2026-09-25", load: async () => fictionalReiPack(),
    now: () => now, pollMs: 0, workroom: join(root, "work") };
  return { root, mock, runtime, desk, deskFile, deps, refresh: createReiMorningRefresh(deps), tick: (ms: number) => { now += ms; return now; } };
}
const reiStamps = (desk: Desk) => desk.snapshot().sources.filter(source => source.id.startsWith("src-rei-")).map(source => [source.id, source.lastCheckedAt]);
const bravo = (desk: Desk) => desk.snapshot().properties.find(property => property.propertyCode === "FP-02")!;
const typed = (mock: ReturnType<typeof fictionalReiPortal>) => mock.calls.filter(call => call[0] === "fill").map(call => call[call.indexOf("--value") + 1]);

describe("the loop's read-only grant refuses anything but reading", () => {
  it("refuses every upload, export, money, send or notice recipe before the browser is touched", async () => {
    const pack = fictionalReiPack(), map = await loadPortalSiteMap("rei-cloud");
    expect(loopReadRefusal(pack, map, reiMorningRuns("2026-09-25"))).toBeNull();
    for (const recipe of ["receipt-register", "supplier-list", "bulk-receipting-preview", "post-import-readback", "bill-entry-study"]) {
      expect(loopReadRefusal(pack, map, [{ recipe, inputs: { date_from: "2026-09-25", date_to: "2026-09-25" } }]), recipe).toMatch(/not a read recipe/);
    }
    // A recipe that calls itself read but opens a money page, presses Notice or Send, exports or uploads is refused all the same.
    const sneaky = (steps: Array<Record<string, unknown>>) => ({ ...pack, recipes: { ...pack.recipes, sneaky: { kind: "read" as const, tier: [], inputs: [], grantNeeds: [], steps, stopBefore: [] } } });
    const cases: Array<[Array<Record<string, unknown>>, RegExp]> = [
      [[{ nav: ["Receipts", "Tenant"] }, { read: "table" }], /does not call a read page/],
      [[{ nav: ["Receipts", "Bulk Receipting"] }, { upload: { field: "Load File", file: "x.csv" } }], /does not call a read page/],
      [[{ nav: ["Reports"] }, { download: { label: "Export" } }], /does not call a read page/],
      [[{ nav: ["Process", "Arrears"] }, { click: "Notice" }], /not call read-safe/],
      [[{ nav: ["Owners"] }, { click: "Send" }], /not call read-safe/],
      [[{ nav: ["Tenants"] }, { download: { label: "Export" } }], /download step/],
      [[{ nav: ["Settings", "Integrations"] }, { read: "table" }], /does not call a read page/],
      [[{ select: { field: "Status", option: "All" } }], /before it opens a read page/],
      [[{ nav: ["Tenants"] }, { click: { label: "Search", ask: "each-run" } }], /not call read-safe/],
    ];
    for (const [steps, refusal] of cases) expect(loopReadRefusal(sneaky(steps), map, [{ recipe: "sneaky" }]), JSON.stringify(steps)).toMatch(refusal);
  });

  it("runs nothing under any other grant or with a refused recipe: zero portal commands", async () => {
    const f = await fixture();
    const pack = fictionalReiPack(), map = await loadPortalSiteMap("rei-cloud");
    const runs: PortalRunRequest[] = [{ recipe: "open-session" }, { recipe: "receipt-register", inputs: { date_from: "2026-09-25", date_to: "2026-09-25" } }];
    const needs = portalRecipeGrantNeeds(pack, reiMorningRuns("2026-09-25"));
    const base = { version: 1, purpose: "browser-task-grant", id: "loop-grant-1", runId: "rei-refresh-1", request: { text: "Read REI.", sha256: "a".repeat(64) },
      sites: needs.sites, browser: { id: "work", accountMarker: FICTIONAL_BUSINESS }, actions: needs.actions, consequential: "ask-each", uploads: [], expiresAt: T0 + 60_000, budget: null };
    const before = f.mock.calls.length;
    const read = (grant: BrowserTaskGrant, which = runs) => runPortalReadLoop({ pack, map, runs: which, account: ACCOUNT, grant, runtime: f.runtime, threadId: "t", signal: new AbortController().signal, pollMs: 0 });
    await expect(read(parseBrowserTaskGrant({ ...base, route: "loop-read" }))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/receipt-register is not a read recipe.*only reads/) });
    await expect(read(parseBrowserTaskGrant({ ...base, route: "ask" }), reiMorningRuns("2026-09-25"))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not read-only/) });
    // A loop grant widened by hand (never parsed) is refused before anything opens.
    await expect(read({ ...parseBrowserTaskGrant({ ...base, route: "loop-read" }), actions: [...needs.actions, "download"] }, reiMorningRuns("2026-09-25"))).rejects.toMatchObject({ status: 409 });
    expect(f.mock.calls.length).toBe(before);
    expect(f.mock.effects).toEqual([]);
  });

  it("the broker itself refuses Notice, Send, Process and Export under a loop grant, even when asked directly", async () => {
    const f = await fixture();
    const pack = fictionalReiPack();
    const needs = portalRecipeGrantNeeds(pack, reiMorningRuns("2026-09-25"));
    const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: "loop-grant-2", runId: "rei-refresh-2", route: "loop-read", request: { text: "Read REI.", sha256: "a".repeat(64) },
      sites: needs.sites, browser: { id: "work", accountMarker: FICTIONAL_BUSINESS }, actions: needs.actions, consequential: "ask-each", uploads: [], expiresAt: T0 + 3_600_000, budget: null });
    let asked = 0;
    const { portalRecipeControls } = await import("./portal-recipe-runner.ts");
    const broker = await startBrowserBroker({ threadId: "t", runId: grant.runId, grant, runtime: f.runtime, context: { allowedOrigins: grant.sites, capabilities: [] },
      isActive: () => true, approve: async () => { asked += 1; return true; }, portal: portalRecipeControls(pack), now: () => T0, workroom: join(f.root, "work") });
    try {
      let id = 0;
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", [broker.descriptor.headers[0].name]: broker.descriptor.headers[0].value },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
        return (await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
      };
      expect((await call("browser_borrow", { tab_id: 1 })).isError).toBeFalsy();
      expect((await call("browser_navigate", { tab_id: 1, url: `${FICTIONAL_REI_ORIGIN}/customers/arrears/` })).isError).toBeFalsy();
      const page = (await call("browser_read", { tab_id: 1 })).content[0].text;
      const ref = (label: string) => page.match(new RegExp(`(@e\\d+) button \\\\?"${label}`))?.[1];
      expect(ref("Notice")).toBeTruthy();
      const notice = await call("browser_click_semantic", { tab_id: 1, ref: ref("Notice") });
      expect(notice.isError).toBe(true);
      expect(notice.content[0].text).toMatch(/only reads/);
      // Money and export pages: the navigation itself is refused (Bulk receipting is an upload page; a payment path is money).
      for (const path of ["/customers/transaction/payment", "/customers/importbanklink/process"]) {
        expect((await call("browser_navigate", { tab_id: 1, url: `${FICTIONAL_REI_ORIGIN}${path}` })).isError, path).toBe(true);
      }
      // Download and upload tools are not even offered to a loop grant.
      expect((await call("browser_download", { tab_id: 1, ref: ref("Notice") })).isError).toBe(true);
      expect((await call("browser_upload", { tab_id: 1, ref: ref("Notice"), file: "x.csv" })).isError).toBe(true);
      expect(asked).toBe(0);
      expect(f.mock.effects).toEqual([]);
    } finally { broker.close(); await broker.released().catch(() => {}); }
  });
});

describe("the REI morning refresh", () => {
  it("reads REI and updates Desk; a rent change in REI lands on the next run", async () => {
    const f = await fixture();
    const first = await f.refresh.run();
    expect(first, first.detail).toMatchObject({ ok: true, status: "completed" });
    // Tasks are filtered by Date Due only (live REI's status select has no name): the closed task due today counts too.
    expect(first.detail, first.detail).toMatch(/Every part is fresh from REI\. REI shows 2 tasks due today\./);
    expect(bravo(f.desk)).toMatchObject({ amountOwingCents: 54_000, owner: { name: "Fictional Owner One" }, rei: { tenancy: "FT-BRAVO" } });
    // Names now agree across REI's grids: Bravo's arrears row lands, Juliet's deliberately different spelling is held.
    const issues = f.desk.snapshot().book!.importIssues.map(issue => `${issue.kind} ${issue.rawIdentity}`);
    expect(issues).toContain("unmatched REI arrears Fictional Juliet");
    expect(issues.some(issue => issue.includes("Fictional Tenant Bravo"))).toBe(false);
    expect(typed(f.mock).every(value => !/password/i.test(value))).toBe(true);
    expect(f.mock.calls.some(call => call[0] === "request-help")).toBe(false);
    expect(f.mock.effects).toEqual([]);
    // REI changes Bravo's rent: REI owns the field (it matched Desk), so Desk follows.
    f.tick(24 * 3_600_000);
    const options = { tenants: FICTIONAL_TENANT_LIST.map(row => row.cells[0] === "FT-BRAVO" ? { ...row, cells: row.cells.map((cell, i) => i === 4 ? "$575.00 per week" : cell) } : row) };
    const changed = await createReiMorningRefresh({ ...f.deps, runtime: await runtimeFor(f.root, options) }).run();
    expect(changed.status).toBe("completed");
    expect(bravo(f.desk).weeklyRentCents).toBe(57_500);
  });

  it("signed out: records 'Missed: sign in to REI', never signs in or types, and leaves Desk's stamps as they were", async () => {
    const f = await fixture({ signedOut: true });
    const result = await f.refresh.run();
    expect(result).toMatchObject({ ok: false, status: "missed" });
    expect(result.detail.startsWith(REI_SIGN_IN_MISSED)).toBe(true);
    expect(result.detail).toMatch(/Not fresh from REI: tenants, arrears, owners\./);
    expect(reiStamps(f.desk)).toEqual([]);
    expect(bravo(f.desk).rei).toBeUndefined();
    expect(f.mock.calls.some(call => ["fill", "press", "click", "request-help"].includes(call[0]))).toBe(false);
    // No work browser open: a miss, and nothing is launched.
    const closed = await createReiMorningRefresh({ ...f.deps, browserId: async () => null }).run();
    expect(closed).toMatchObject({ status: "missed", detail: expect.stringContaining(REI_SIGN_IN_MISSED) });
  });

  it("a session that expires part-way applies the parts read completely and leaves the rest stale", async () => {
    const f = await fixture({ signOutAfterSteps: 4 });
    const result = await f.refresh.run();
    expect(result, result.detail).toMatchObject({ ok: false, status: "partial" });
    expect(result.detail).toMatch(/REI signed out part-way\..*Not fresh from REI: arrears, owners\..*Missed: sign in to REI/);
    expect(reiStamps(f.desk).map(([id]) => id)).toEqual(["src-rei-tenants"]);
    expect(f.mock.calls.some(call => call[0] === "request-help")).toBe(false);
  });

  it("a live-shaped tenants grid (90 rows, more on scroll) is read whole at 106 and 300 rows; the scroll clicks, types and opens nothing", async () => {
    for (const count of [106, 300]) {
      const f = await fixture({ ...fictionalBook(count), pageSize: 50, gridBlock: 90 });
      const result = await f.refresh.run();
      expect(result.status, `${count}: ${result.detail}`).toBe("completed");
      expect(reiStamps(f.desk).map(([id]) => id).sort()).toEqual(["src-rei-arrears", "src-rei-owners", "src-rei-tenants"]);
      expect(f.desk.snapshot().book!.bookProposals.filter(card => card.origin === "rei")).toHaveLength(count);
      const scrolls = f.mock.calls.filter(call => call[0] === "scroll");
      expect(scrolls.length).toBeGreaterThanOrEqual(Math.ceil(count / 90) - 1);
      expect(scrolls.every(call => call.includes("--selector") && call.includes(".e-gridcontent .e-content"))).toBe(true);
      // While the tenants grid is read and scrolled, nothing is clicked or opened.
      const start = f.mock.calls.findIndex(call => call[0] === "navigate" && call[1].endsWith("/customers/tenant"));
      const end = f.mock.calls.findIndex((call, i) => i > start && call[0] === "navigate");
      expect(f.mock.calls.slice(start + 1, end).filter(call => ["click", "navigate", "upload", "download"].includes(call[0]))).toEqual([]);
      expect(f.mock.effects).toEqual([]);
    }
  });

  it("a grid that stops loading is partial, never fresh", async () => {
    const f = await fixture({ ...fictionalBook(106), pageSize: 50, gridBlock: 90, gridStallsAt: 95 });
    const result = await f.refresh.run();
    expect(result.status).toBe("partial");
    expect(result.detail).toMatch(/Not read whole this run[^.]*tenants/);
    expect(reiStamps(f.desk).map(([id]) => id)).not.toContain("src-rei-tenants");
    expect(f.desk.snapshot().book?.bookProposals ?? []).toEqual([]);
  });

  it("two REI tabs open: says so and names the site, never 'not signed in'", async () => {
    const f = await fixture({ secondReiTab: true });
    const result = await f.refresh.run();
    expect(result.status).toBe("missed");
    expect(result.detail).toMatch(/more than one REI tab is open \(rei-mock\.fictional\.test\)/);
    expect(result.detail).not.toMatch(/isn't signed in/);
    expect(reiStamps(f.desk)).toEqual([]);
  });

  it("Stop (every browser broker closed) after the tenants read applies nothing and the run says Stopped", async () => {
    const f = await fixture({ delayMs: 3 });
    const before = JSON.stringify(f.desk.snapshot().properties);
    const run = f.refresh.run();
    while (!f.mock.calls.some(call => call[0] === "navigate" && call[1].includes("/customers/arrears/"))) await new Promise(resolve => setTimeout(resolve, 2));
    await releaseBrowserBrokers();
    const result = await run;
    expect(result.detail).toMatch(/^Stopped\./);
    expect(result.ok).toBe(false);
    expect(reiStamps(f.desk)).toEqual([]);
    expect(JSON.stringify(f.desk.snapshot().properties)).toBe(before);
    expect(f.desk.snapshot().book?.bookProposals ?? []).toEqual([]);
  });

  it("stops when an address lands somewhere other than its mapped page, or a dialog is open there", async () => {
    for (const options of [{ redirects: { "/customers/owner": "/customers/owner/details" } }, { dialogOn: "/customers/owner" }] as FictionalReiOptions[]) {
      const f = await fixture(options);
      const result = await f.refresh.run();
      expect(result.status, JSON.stringify(options)).toBe("partial");
      expect(result.detail).toMatch(/unexpected-page/);
      expect(reiStamps(f.desk).map(([id]) => id)).not.toContain("src-rei-owners");
      expect(f.mock.calls.filter(call => ["fill", "select", "press"].includes(call[0]) && f.mock.calls.indexOf(call) > f.mock.calls.findIndex(c => c[0] === "navigate" && c[1].includes("/customers/owner")))).toEqual([]);
    }
  });

  it("REI's page changed under one part: one Needs-you item for that part, updated in place, cleared when it next reads whole", async () => {
    const f = await fixture({ redirects: { "/customers/owner": "/customers/owner/details" } });
    const needsYou = () => buildDeskQueue(f.desk.snapshot()).filter(row => row.bucket === "now" && row.address.startsWith("REI Cloud"));
    const first = await f.refresh.run();
    expect(first.detail).toMatch(/unexpected-page/);
    expect(needsYou()).toEqual([expect.objectContaining({ address: "REI Cloud owners", kind: "import-issue",
      meta: "REI's page changed, so Bud couldn't read owners. Desk stays marked not fresh. RealBud needs a recipe update; nothing in REI was changed." })]);
    expect(recoveryPlanFor(needsYou()[0]!)).toMatchObject({ headline: "REI's page changed", action: "none" });
    expect(reiStamps(f.desk).map(([id]) => id)).not.toContain("src-rei-owners");
    // The next morning fails the same way: still one item, updated in place.
    const seen = needsYou()[0]!.updatedAt;
    f.tick(24 * 3_600_000);
    await f.refresh.run();
    expect(needsYou()).toHaveLength(1);
    expect(needsYou()[0]!.updatedAt).toBeGreaterThan(seen);
    expect(f.desk.snapshot().workItems.filter(item => item.occurrenceKey.startsWith("rei-page-changed:"))).toHaveLength(1);
    // Signed out stays its own "Missed: sign in to REI" path and adds no page-changed item.
    f.tick(1000);
    const signedOut = await createReiMorningRefresh({ ...f.deps, runtime: await runtimeFor(f.root, { signedOut: true }) }).run();
    expect(signedOut.detail.startsWith(REI_SIGN_IN_MISSED)).toBe(true);
    expect(needsYou()).toHaveLength(1);
    // Owners read whole again: the item clears.
    f.tick(1000);
    const fixed = await createReiMorningRefresh({ ...f.deps, runtime: await runtimeFor(f.root, {}) }).run();
    expect(fixed.status, fixed.detail).toBe("completed");
    expect(needsYou()).toEqual([]);
  });

  it("a page the browser helper cut short is never fresh, even when the cut hides the grid's record count", async () => {
    const f = await fixture({ ...fictionalBook(120), observeChars: 12_000 });
    const result = await f.refresh.run();
    expect(result.status).toBe("partial");
    expect(result.detail).toMatch(/Not fresh from REI: tenants/);
    expect(reiStamps(f.desk).map(([id]) => id)).not.toContain("src-rei-tenants");
  });

  it("two refreshes racing: one reads, the other does not start, and Desk changes once", async () => {
    const f = await fixture({ delayMs: 2 });
    const [a, b] = await Promise.all([f.refresh.run(), createReiMorningRefresh(f.deps).run()]);
    expect([a.status, b.status].sort()).toEqual(["completed", "missed"]);
    expect([a, b].find(run => run.status === "missed")!.detail).toMatch(/already running/);
    expect([a, b].find(run => run.status === "missed")!.detail).not.toMatch(/Desk changed/);
    expect(f.mock.calls.filter(call => call[0] === "tab" && call[1] === "borrow")).toHaveLength(1);
    expect(f.desk.snapshot().book!.bookProposals.filter(card => card.address === "FP-01")).toHaveLength(1);
    // The clock never starts the same loop twice either.
    const loops = loopManager(join(f.root, "loops.json"), () => T0, async () => f.refresh.run());
    loops.patchClock("rei-morning-refresh", { enabled: true });
    loops.runNow("rei-morning-refresh");
    expect(() => loops.runNow("rei-morning-refresh")).toThrow(/already running/);
    while (loops.activeRun("rei-morning-refresh")) await new Promise(resolve => setTimeout(resolve, 10));
  });

  it("a restart mid-refresh leaves nothing half-applied: the run is interrupted, Desk unchanged, and the next run reads cleanly", async () => {
    const f = await fixture({ delayMs: 5 });
    const loopsDir = privateTempRoot(join(tmpdir(), "rb-rei-loops-")); dirs.push(loopsDir);
    const loopsFile = join(loopsDir, "loops.json");
    const loops = loopManager(loopsFile, () => T0, async () => f.refresh.run());
    loops.patchClock("rei-morning-refresh", { enabled: true });
    const run = loops.runNow("rei-morning-refresh")!;
    // Wait until the read is well under way, then take the disk as a killed process would leave it.
    for (let i = 0; i < 400 && f.mock.calls.filter(call => call[0] === "observe").length < 6; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const crash = privateTempRoot(join(tmpdir(), "rb-rei-crash-")); dirs.push(crash);
    // The disk as a killed process leaves it: the Desk file, and the schedule with its history database.
    copyFileSync(f.deskFile, join(crash, "desk.json")); cpSync(loopsDir, join(crash, "loops"), { recursive: true });
    expect(loops.activeRun("rei-morning-refresh")?.status, JSON.stringify(loops.listRuns()) + f.mock.calls.length).toBe("running");
    // The process that was killed: let its in-flight read end so it does not outlive the test.
    while (loops.activeRun("rei-morning-refresh")) await new Promise(resolve => setTimeout(resolve, 10));

    const desk = new Desk({ file: join(crash, "desk.json"), now: () => T0, key: KEY });
    expect(reiStamps(desk)).toEqual([]);
    expect(desk.snapshot().book?.bookProposals ?? []).toEqual([]);
    expect(desk.snapshot().properties.find(property => property.propertyCode === "FP-02")!.rei).toBeUndefined();
    const restarted = loopManager(join(crash, "loops", "loops.json"), () => T0 + 1000, async () => createReiMorningRefresh({ ...f.deps, desk, runtime: await runtimeFor(crash, {}) }).run());
    expect(restarted.listRuns().find(item => item.id === run.id)).toMatchObject({ status: "interrupted" });
    const next = restarted.runNow("rei-morning-refresh")!;
    let settled;
    for (let i = 0; i < 400 && !(settled = restarted.listRuns().find(item => item.id === next.id && !["queued", "running"].includes(item.status))); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled, JSON.stringify(restarted.listRuns())).toMatchObject({ status: "completed" });
    expect(reiStamps(desk).map(([id]) => id).sort()).toEqual(["src-rei-arrears", "src-rei-owners", "src-rei-tenants"]);
  });

  it("a clock jump never runs the morning refresh twice for one slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "rb-rei-clock-")); dirs.push(root);
    let now = Date.UTC(2026, 9, 5, 20, 0); // Monday 6 Oct, 06:00 Brisbane
    const executed: number[] = [];
    const loops = loopManager(join(root, "loops.json"), () => now, async (_loop, run) => { executed.push(run.scheduledFor); return { ok: true, detail: "fictional" }; }, "Australia/Brisbane");
    loops.patchClock("rei-morning-refresh", { enabled: true });
    now += 61 * 60_000; await loops.tick();               // 07:01: the 07:00 slot runs once
    now -= 24 * 3_600_000; await loops.tick();            // back a day: nothing reruns
    now += 24 * 3_600_000 + 5 * 60_000; await loops.tick(); // forward again: the same slot is not run twice
    await loops.tick();
    const mine = loops.listRuns().filter(run => run.loopId === "rei-morning-refresh");
    expect(executed).toHaveLength(1);
    expect(mine).toHaveLength(1);
    now += 24 * 3_600_000; await loops.tick();            // next morning: one more
    expect(executed).toHaveLength(2);
    expect(new Set(executed).size).toBe(2);
  });

  it("is off until an office turns it on, and is never part of onboarding's first-run loops", () => {
    const root = mkdtempSync(join(tmpdir(), "rb-rei-off-")); dirs.push(root);
    const loops = loopManager(join(root, "loops.json"), () => T0, async () => ({ ok: true, detail: "" }));
    expect(loops.listLoops().find(loop => loop.id === "rei-morning-refresh")).toMatchObject({ enabled: false, available: true, nextRunAt: null });
    expect(existsSync(join(root, "loops.json"))).toBe(false);
  });
});

function loopManager(file: string, now: () => number, execute: ConstructorParameters<typeof LoopManager>[0]["execute"], timezone = "UTC") {
  const manager = new LoopManager({ file, now, timezone, hostTimezone: timezone, execute });
  managers.push(manager);
  return manager;
}
async function runtimeFor(root: string, options: FictionalReiOptions) {
  const mock = fictionalReiPortal(options);
  const runtime = new BrowserRuntime({ root, command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  return runtime;
}

describe("an unattended refresh and watch-and-learn recipes", () => {
  it("runs on the shipped pack only: no learned recipe and no read-safe label a reviewer confirmed", async () => {
    const cleanup = await publishLearnedInDataDir();
    const restore = await saveApprovedPathInDataDir();
    const shipped = await loadShippedPortalRecipePack("rei-cloud");
    try {
      // The Ask loader merges it.
      const merged = await loadPortalRecipePack("rei-cloud");
      expect(merged.recipes[LEARNED_LEAK_RECIPE]).toBeDefined();
      // The confirmation stays with its recipe; the Ask pack's read-safe list is the shipped one.
      expect(merged.recipes[LEARNED_LEAK_RECIPE]).toMatchObject({ confirmed: [LEARNED_LEAK_LABEL] });
      expect(merged.labels.readSafe).toEqual(shipped.labels.readSafe);
      vi.mocked(loadPortalRecipePack).mockClear(); vi.mocked(loadShippedPortalRecipePack).mockClear();

      // No injected `load`: the loop picks its own loader.
      const f = await fixture();
      const { load: _load, ...deps } = f.deps;
      await createReiMorningRefresh(deps).run();
      expect(loadPortalRecipePack).not.toHaveBeenCalled();
      expect(loadShippedPortalRecipePack).toHaveBeenCalledWith("rei-cloud");
      const used = await vi.mocked(loadShippedPortalRecipePack).mock.results[0].value;
      expect(Object.keys(used.recipes).filter(name => name.startsWith("learned-"))).toEqual([]);
      expect(used.labels.readSafe).toEqual(shipped.labels.readSafe);
      expect(used.labels.readSafe).not.toContain(LEARNED_LEAK_LABEL);
      expect(JSON.stringify(used)).not.toContain(LEARNED_LEAK_LABEL); // not read-safe, not a learned set, not a recipe's `confirmed`
      // Nor a path approved in Ask: an unattended read never downloads.
      expect(used.recipes["tenant-list"].steps).toEqual(shipped.recipes["tenant-list"].steps);
      expect(merged.recipes["tenant-list"].steps).toContainEqual({ download: { label: "Export" } });
    } finally { cleanup(); await restore(); }
  });
});

describe("approval settings on the office-approved morning refresh", () => {
  // The host registers its store once at boot; here the refresh reads these settings through the real broker.
  const govern = (choice?: ApprovalChoice) => governApprovals({ singleDesktop: async () => true,
    effective: async (): Promise<ApprovalSettings[]> => [{ version: 1, purpose: "approval-settings", groups: choice ? { "site:rei-mock.fictional.test": choice } : {}, reviewedReads: [] }] });
  afterEach(() => govern());

  it("still reads REI with the site set to Ask every time, and reads nothing with Don't use", async () => {
    govern("ask");
    const f = await fixture();
    const asked = await f.refresh.run();
    expect(asked, asked.detail).toMatchObject({ ok: true, status: "completed" });
    expect(bravo(f.desk).rei).toMatchObject({ tenancy: "FT-BRAVO" });

    govern("deny");
    const g = await fixture();
    const refused = await g.refresh.run();
    expect(refused).toMatchObject({ ok: false, status: "failed" });
    expect(refused.detail).toContain("rei-mock.fictional.test is set to Don't use in Workspace → Approvals, so Bud did nothing there.");
    expect(reiStamps(g.desk)).toEqual([]);
    expect(bravo(g.desk).rei).toBeUndefined();
    expect(g.mock.calls.some(call => ["snapshot", "fill", "press", "click"].includes(call[0]))).toBe(false);
  });
});
