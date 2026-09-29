// The recipe runner, run as Bud runs it: through the real BrowserBroker
// (grant, fence, approvals, sign-in pause, Stop) over a FICTIONAL REI-style
// portal played by the browser helper's command interface. No network, no
// REI account, no credentials. Passing proves the recipes execute through
// RealBud's authority path, never that REI Cloud behaves this way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addBrowserTaskUpload, browserTaskWorkroom, BrowserRuntime, type BrowserJson } from "./browser-runtime.ts";
import { onBrowserSignIn } from "./browser-broker.ts";
import { BrowserApprovalStore } from "./browser-authority.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { parsePortalRecipePack, type PortalRecipePack } from "./portal-recipe.ts";
import { portalRecipeGrantNeeds, runPortalRecipes, type PersonApprove, type PortalRunOptions, type PortalRunRequest } from "./portal-recipe-runner.ts";
import { FICTIONAL_BUSINESS, FICTIONAL_REICID, fictionalReiPack, fictionalReiPortal, type FictionalReiOptions } from "./testing/fictional-rei-portal.ts";
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
  const start = async (runs: PortalRunRequest[], extra: Partial<PortalRunOptions> = {}) => {
    const grantId = `grant-${randomUUID()}`; const runId = `run-${randomUUID()}`;
    const workroom = browserTaskWorkroom(root, grantId);
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
  return { mock, runtime, pack, person, operations, start, dispatched };
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
  });
});

describe("portal recipe runner through the real broker (fictional REI mock)", () => {
  const S_READS: Array<[string, Record<string, string>, (rows: Array<Record<string, string>>) => void]> = [
    ["find-record", { list: "Tenants", query: "Delta" }, rows => { expect(rows).toHaveLength(1); expect(rows[0].Name).toBe("Fictional Tenant Delta"); }],
    ["arrears-review", { min_days: "1" }, rows => { expect(rows).toHaveLength(6); expect(rows.some(row => row.Status === "Vacated")).toBe(false); }],
    ["tasks-due", { date_from: "2026-09-25", date_to: "2026-09-30" }, rows => { expect(rows).toHaveLength(2); expect(rows.every(row => row.Status === "Open")).toBe(true); }],
    ["compliance-expiry", { view: "lease expiry" }, rows => expect(rows).toHaveLength(7)],
    ["bank-reconciliation-read", {}, rows => expect(rows.map(row => row.Description)).toEqual(["Fictional deposit", "Fictional fee"])],
  ];
  for (const [recipe, inputs, check] of S_READS) {
    it(`${recipe}: rows through grant, fence and account checks, no person asked, nothing consequential pressed`, async () => {
      const f = await fixture();
      const run = await f.start(withOpen(recipe, inputs));
      expect(run.outcome, run.detail).toBe("completed");
      check(run.results[1].rows);
      expect(run.receipt.approvals.person).toBe(0);
      expect(f.person).not.toHaveBeenCalled();
      expect(f.mock.effects).toEqual([]);
      // Text reads only: every page read is the helper's observe; nothing else is captured.
      expect(f.mock.calls.every(args => ["status", "session", "tab", "observe", ...DISPATCH].includes(args[0]))).toBe(true);
      // Direct routes carry the account parameter, and the account was re-checked after every load.
      expect(f.mock.calls.filter(args => args[0] === "navigate").every(args => new URL(args[1]).searchParams.get("reicid") === FICTIONAL_REICID)).toBe(true);
      expect(run.receipt.accountChecks).toBeGreaterThanOrEqual(f.dispatched().length);
      expect((await f.runtime.status()).active).toBe(false);
    });
  }
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
    expect(run.results[1].filters).toMatchObject({ "From day": "1", "Hide vacated tenants": "Yes" });
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
  it("runs the morning batch under one grant, one borrow and one browser session", async () => {
    const f = await fixture();
    const run = await f.start(MORNING(f.pack));
    expect(run.outcome, run.detail).toBe("completed");
    expect(run.results.map(result => [result.recipe, result.outcome])).toEqual([["open-session", "completed"], ["arrears-review", "completed"], ["tasks-due", "completed"], ["bank-reconciliation-read", "completed"]]);
    expect(run.results.map(result => result.rows.length)).toEqual([0, 6, 2, 2]);
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
    expect(run.results.map(result => result.rows.length)).toEqual([0, 6, 2, 2]);
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
    expect(run.results[1].rows).toHaveLength(2);
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
    // The header changes once four page-changing commands have run (navigate, navigate, fill, press):
    // the read after the fourth stops the run before the dropdown choice.
    const f = await fixture({ switchBusinessAfterSteps: 3 });
    const run = await f.start(MORNING(f.pack));
    expect(run).toMatchObject({ outcome: "handover", reason: "account-marker-changed" });
    expect(f.dispatched().map(args => args[0])).toEqual(["navigate", "navigate", "fill", "press"]);
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
    const f = await fixture({ unknownUpload: true }, { upload: Buffer.from("date,reference,amount\n2026-09-25,FT-BRAVO,540.00\n"), operations });
    // The person approves each step the recipe cannot answer for (the file format on a banking page, the upload).
    f.person.mockImplementation(async () => true);
    const inputs = { bank_format: "Fictional Bank CSV", approved_file: "fictional-bank.csv", expected_rows: "1", expected_total: "540.00" };
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
    const f = await fixture({}, { upload: Buffer.from("date,reference,amount\n") });
    const run = await f.start(withOpen("bulk-receipting-preview", { bank_format: "Fictional Bank CSV", approved_file: "fictional-bank.csv", expected_rows: "1", expected_total: "0" }));
    expect(run).toMatchObject({ outcome: "handover", reason: "not-approved" });
    expect(f.mock.calls.filter(args => args[0] === "upload")).toEqual([]);
  });
  it("refuses before opening the browser when the grant is narrower than the recipes", async () => {
    const f = await fixture({}, { actions: ["read", "navigate", "click"] });
    const run = await f.start(withOpen("arrears-review", { min_days: "1" }));
    expect(run).toMatchObject({ outcome: "blocked", reason: "grant-too-narrow" });
    expect(f.mock.calls.some(args => args[0] === "session")).toBe(false);
  });
});
