// Learning a portal path in one process: the FICTIONAL REI-style portal behind
// the real BrowserRuntime and broker (an Ask task in RealBud's own work
// browser), the real evidence and path stores, then the real Refresh from REI.
// No network, no REI account: a pass proves RealBud's wiring and guards only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askBrowserLabEnabled, askBrowserRuntime, askPortalPackLoader, useAskBrowserLab } from "./ask-browser-lab.ts";
import { authorizeBrowserAction, BrowserApprovalStore } from "./browser-authority.ts";
import { startBrowserBroker, type BrowserBroker } from "./browser-broker.ts";
import { BrowserRuntime, browserRuntime, type BrowserJson } from "./browser-runtime.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { checkPortalPathProposal, PortalEvidenceStore, PortalPathStore, PORTAL_PROPOSE_TOOL } from "./portal-path-overrides.ts";
import { portalRecipeControls } from "./portal-recipe-runner.ts";
import { loadPortalRecipePack, portalMapForSites } from "./portal-recipe-task.ts";
import type { PortalRecipePack } from "./portal-recipe.ts";
import { createReiDirectorySync } from "./rei-directory-sync.ts";
import { createSupplierDirectory } from "./supplier-directory.ts";
import { createTenantDirectoryStore } from "./tenant-directory.ts";
import { FICTIONAL_BUSINESS, FICTIONAL_REI_ORIGIN, fictionalReiPack, fictionalReiPortal, type FictionalReiOptions } from "./testing/fictional-rei-portal.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { writePrivateJson } from "./private-json.ts";
import { WorkflowDatabase } from "./workflow-database.ts";
import { parseBrowserTaskGrant, type BrowserActionClass } from "../shared/browser-task.ts";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const REPORT = "Tenant Contact Export (fictional)";
type Result = { isError?: boolean; content: Array<{ text: string }> };

async function lab(portal: FictionalReiOptions = {}) {
  const root = privateTempRoot(join(tmpdir(), "rb-portal-learn-")); cleanup.push(() => removeFixture(root));
  const mock = fictionalReiPortal(portal);
  const runtime = new BrowserRuntime({ root, command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
  // RealBud's own work browser (the native runtime's shape), where an Ask task's read allowance applies.
  Object.defineProperty(runtime, "ownsProfile", { value: true });
  await runtime.connect(); await runtime.select("work");
  return { root, mock, runtime, evidence: new PortalEvidenceStore({ file: join(root, "evidence.json") }), paths: new PortalPathStore({ file: join(root, "paths.json") }) };
}

async function askTask(f: Awaited<ReturnType<typeof lab>>, options: { map?: boolean; actions?: BrowserActionClass[]; id?: string; pack?: PortalRecipePack; expiresAt?: number; now?: () => number } = {}) {
  const pack = options.pack ?? fictionalReiPack();
  const text = "Find out how to export the tenant list from the fictional REI portal";
  const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: options.id ?? "fictional-learn-1", runId: "run-learn-1", route: "ask",
    request: { text, sha256: sha256(text) }, sites: [FICTIONAL_REI_ORIGIN], browser: { id: "work", accountMarker: null },
    actions: options.actions ?? ["read", "navigate", "click", "fill", "download"], consequential: "ask-each", uploads: [], expiresAt: options.expiresAt ?? Date.now() + 30 * 60_000, budget: 40 });
  const controls = portalRecipeControls(pack); delete controls.accountMarker; // as the host does for a task without a chosen account
  const asked: Array<{ tool: string; summary: string; params: BrowserJson }> = [];
  let answer = true;
  const approve = vi.fn(async (tool: string, params: BrowserJson, summary: string) => { asked.push({ tool, summary, params }); return answer; });
  const broker: BrowserBroker = await startBrowserBroker({ threadId: "thread-learn", runId: grant.runId, grant, runtime: f.runtime, isActive: () => true, approve,
    context: { allowedOrigins: grant.sites, capabilities: [] }, assertCapability: () => {}, attachRoot: null,
    operations: new ConnectedAppOperationStore({ file: join(f.root, "operations.json") }), approvals: new BrowserApprovalStore({ file: join(f.root, "approvals.json") }),
    evidence: f.evidence, paths: f.paths, ...(options.now ? { now: options.now } : {}), ...(options.map === false ? {} : { portal: controls, learn: { portal: pack.portal, pack } }) });
  cleanup.push(async () => { broker.close(); await broker.released(); });
  let id = 0; let page = "";
  const call = async (name: string, args: BrowserJson = {}): Promise<Result> => {
    const response = await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: broker.descriptor.headers[0].value },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
    return (await response.json() as { result: Result }).result;
  };
  const tools = async () => {
    const response = await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: broker.descriptor.headers[0].value },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} }) });
    return (await response.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map(tool => tool.name);
  };
  const ok = async (name: string, args: BrowserJson = {}) => { const result = await call(name, args); expect(result.isError, result.content[0]?.text).toBeFalsy(); return result.content[0].text; };
  /** Reads until the page has settled (the fictional grids show "Loading…" first). */
  const read = async () => { for (let i = 0; i < 5; i++) { page = (JSON.parse(await ok("browser_read", { tab_id: 1 })) as { text: string }).text; if (!page.includes("Loading")) break; } return page; };
  const ref = (role: string, name: string) => { const found = page.match(new RegExp(`(@e\\d+) ${role} "${name.replace(/[()]/g, "\\$&")}"`)); if (!found) throw new Error(`No ${role} ${name} on the page`); return found[1]; };
  const start = async () => { await ok("browser_borrow", { tab_id: 1 }); await read(); };
  return { grant, broker, call, ok, read, ref, start, approve, asked, tools, deny: () => { answer = false; }, allow: () => { answer = true; } };
}

/** The exploration Bud does: Reports (menu) → the tenant export report → Output: Export Only → Export (download). */
async function explore(t: Awaited<ReturnType<typeof askTask>>) {
  await t.start();
  await t.ok("browser_click_semantic", { tab_id: 1, ref: t.ref("link", "Reports") }); await t.read();
  await t.ok("browser_click_semantic", { tab_id: 1, ref: t.ref("link", REPORT) }); await t.read();
  await t.ok("browser_select", { tab_id: 1, ref: t.ref("combobox", "Output"), values: ["Export Only"] }); await t.read();
  await t.ok("browser_download", { tab_id: 1, ref: t.ref("button", "Export") });
}
const PATH = [{ verb: "nav", label: "Reports" }, { verb: "click", label: REPORT }, { verb: "select", label: "Output", option: "Export Only" }, { verb: "download", label: "Export" }];
/** What the broker records for that exploration. */
const SEEN = [
  { tool: "click" as const, role: "link", label: "Reports", path: "/customers/dashboard", outcome: "succeeded" as const, at: 1 },
  { tool: "click" as const, role: "link", label: REPORT, path: "/report/reportlist", outcome: "succeeded" as const, at: 2 },
  { tool: "select" as const, role: "combobox", label: "Output", path: "/report/reportlist", valuesHash: sha256(JSON.stringify(["Export Only"])), outcome: "succeeded" as const, at: 3 },
  { tool: "download" as const, role: "button", label: "Export", path: "/report/reportlist", outcome: "succeeded" as const, at: 4 }];

describe("map-aware Ask browser tasks", () => {
  it("opens the portal's own menu and lists without a card, and still asks for Email, Generate and anything unmapped", async () => {
    const f = await lab({ reports: { tenants: "Email", suppliers: "Generate" } });
    const t = await askTask(f);
    await t.start();
    await t.ok("browser_click_semantic", { tab_id: 1, ref: t.ref("link", "Reports") }); await t.read();
    expect(t.approve).not.toHaveBeenCalled();
    await t.ok("browser_click_semantic", { tab_id: 1, ref: t.ref("link", "Generate") });
    expect(t.asked.at(-1)!.summary).toMatch(/Generate/);
    await t.read();
    await t.ok("browser_click_semantic", { tab_id: 1, ref: t.ref("link", "Email") });
    expect(t.asked.at(-1)!.summary).toMatch(/Email/);
    expect(t.approve).toHaveBeenCalledTimes(2);
  });

  it("a read-safe dropdown reads for a reading choice, and asks for an option the pack calls consequential", () => {
    const text = "Find the fictional tenants";
    const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: "fictional-select", runId: "run-select", route: "ask", request: { text, sha256: sha256(text) },
      sites: [FICTIONAL_REI_ORIGIN], browser: { id: "work", accountMarker: null }, actions: ["read", "navigate", "click", "fill"], consequential: "ask-each", uploads: [], expiresAt: 60_000, budget: 20 });
    const portal = { ...portalRecipeControls(fictionalReiPack()), accountMarker: undefined };
    const page = { url: `${FICTIONAL_REI_ORIGIN}/customers/tenant`, text: '@vom 1\nL1 page\n  main\n    @e1 combobox "Status" value="Active"\n      option "All"\n      option "Email"' };
    const taskScope = { grantId: grant.id, runId: grant.runId, requestHash: grant.request.sha256, browserId: "work", tabId: 1, origin: FICTIONAL_REI_ORIGIN, accountMarker: null, readOnly: true as const };
    const choose = (value: string) => authorizeBrowserAction(grant, page, "browser_select", { tab_id: 1, ref: "@e1", values: [value] }, { now: 1_000, taskScope, portal }).decision;
    expect(choose("All")).toBe("allow");
    expect(choose("Email")).toBe("ask");
  });

  it("without the map the same menu click asks; the propose tool exists only on a mapped Ask task", async () => {
    const f = await lab();
    const plain = await askTask(f, { map: false });
    expect(await plain.tools()).not.toContain(PORTAL_PROPOSE_TOOL);
    await plain.start();
    await plain.ok("browser_click_semantic", { tab_id: 1, ref: plain.ref("link", "Reports") });
    expect(plain.approve).toHaveBeenCalledTimes(1);
    plain.broker.close(); await plain.broker.released();
    const mapped = await askTask(f, { id: "fictional-learn-2" });
    expect(await mapped.tools()).toContain(PORTAL_PROPOSE_TOOL);
  });

  it("records each dispatched step's role, name, path and outcome, never a typed value", async () => {
    const f = await lab();
    const t = await askTask(f);
    await t.start();
    await t.ok("browser_click_semantic", { tab_id: 1, ref: t.ref("link", "Reports") }); await t.read();
    await t.ok("browser_fill", { tab_id: 1, ref: t.ref("textbox", "Search"), value: "FICTIONAL-TYPED-VALUE-42" });
    expect(t.approve).not.toHaveBeenCalled(); // Search is one of the map's read-safe controls
    const steps = await f.evidence.steps(t.grant.id);
    expect(steps.map(({ at: _at, ...step }) => step)).toEqual([
      { tool: "click", role: "link", label: "Reports", path: "/customers/dashboard", outcome: "succeeded" },
      { tool: "fill", role: "textbox", label: "Search", path: "/report/reportlist", outcome: "succeeded" },
    ]);
    expect(readFileSync(join(f.root, "evidence.json"), "utf8")).not.toMatch(/FICTIONAL-TYPED-VALUE-42|Results|value=/);
  });
});

describe("proposing and approving a learned path", () => {
  it("refuses steps Bud did not take, consequential controls and forbidden areas; the person's Allow saves a version with provenance", async () => {
    const f = await lab({ reports: { tenants: REPORT, suppliers: "Generate" } });
    const t = await askTask(f);
    await explore(t);
    await t.read(); await t.ok("browser_click_semantic", { tab_id: 1, ref: t.ref("link", "Reports") }); await t.read();
    await t.ok("browser_click_semantic", { tab_id: 1, ref: t.ref("link", "Generate") }); // the person allowed it once
    const asks = t.asked.length;
    const refused = async (steps: unknown[], pattern: RegExp) => {
      const result = await t.call(PORTAL_PROPOSE_TOOL, { slot: "tenant-list", steps: steps as BrowserJson[] });
      expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(pattern);
    };
    await refused([{ verb: "nav", label: "Reports" }, { verb: "click", label: "Owner Statement" }, { verb: "download", label: "Export" }], /did not use 'Owner Statement'/);
    await refused([{ verb: "nav", label: "Reports" }, { verb: "click", label: "Generate" }, { verb: "download", label: "Export" }], /'Generate' can change records/);
    await refused([{ verb: "nav", label: "Reports" }, { verb: "click", label: REPORT }, { verb: "select", label: "Output", option: "Email Only" }, { verb: "download", label: "Export" }], /'Email Only' can change records/);
    await refused([{ verb: "nav", label: "Settings" }, { verb: "download", label: "Export" }], /stays out of/);
    await refused([{ verb: "nav", label: "Reports" }, { verb: "click", label: REPORT }], /ends with its one download/);
    await refused([{ verb: "click", label: REPORT, readSafe: true }, { verb: "download", label: "Export" }], /Each step/);
    expect(t.asked.length).toBe(asks); // nothing refused reached the person
    expect((await f.paths.list("rei-cloud", "tenant-list")).versions).toEqual([]);

    t.deny();
    expect((await t.call(PORTAL_PROPOSE_TOOL, { slot: "tenant-list", steps: PATH })).content[0].text).toMatch(/not saved/);
    expect(t.asked.at(-1)).toMatchObject({ tool: PORTAL_PROPOSE_TOOL,
      summary: `Bud found how to export the Tenants list: Reports → ${REPORT} → Export Only → Export. Use this for Refresh from REI? Bud still asks before each download and before '${REPORT}' every time.` });
    expect((await f.paths.list("rei-cloud", "tenant-list")).versions).toEqual([]);
    t.allow();
    expect(await t.ok(PORTAL_PROPOSE_TOOL, { slot: "tenant-list", steps: PATH })).toMatch(/version 1/);
    expect(await t.ok(PORTAL_PROPOSE_TOOL, { slot: "tenant-list", steps: PATH })).toMatch(/version 2/);
    const saved = await f.paths.list("rei-cloud", "tenant-list");
    expect(saved.current).toBe(2);
    expect(saved.versions[0]).toMatchObject({ revision: 1, steps: PATH, readSafe: [],
      provenance: { grantId: t.grant.id, runId: t.grant.runId, threadId: "thread-learn", origin: FICTIONAL_REI_ORIGIN, urls: expect.arrayContaining(["/customers/dashboard", "/report/reportlist"]) } });
    await f.paths.restore("rei-cloud", "tenant-list", 1);
    expect((await f.paths.list("rei-cloud", "tenant-list")).current).toBe(1);
    await f.paths.restore("rei-cloud", "tenant-list", null);
    expect((await f.paths.apply(fictionalReiPack())).recipes["tenant-list"]).toEqual(fictionalReiPack().recipes["tenant-list"]);
    await expect(f.paths.restore("rei-cloud", "tenant-list", 9)).rejects.toMatchObject({ status: 404 });
  });

  it("a merged path keeps the repo's list read, account checks and the download; consequential labels never become read-safe", () => {
    const pack = fictionalReiPack();
    const seen = [{ tool: "click" as const, role: "link", label: "Reports", path: "/customers/dashboard", outcome: "succeeded" as const, at: 1 },
      { tool: "click" as const, role: "link", label: "Email", path: "/report/reportlist", outcome: "succeeded" as const, at: 2 },
      { tool: "download" as const, role: "button", label: "Export", path: "/report/reportlist", outcome: "succeeded" as const, at: 3 }];
    expect(() => checkPortalPathProposal(pack, { slot: "tenant-list", steps: [{ verb: "nav", label: "Reports" }, { verb: "click", label: "Email" }, { verb: "download", label: "Export" }] }, seen)).toThrow(/'Email' can change records/);
    expect(() => checkPortalPathProposal(pack, { slot: "arrears-review", steps: [{ verb: "download", label: "Export" }] }, seen)).toThrow(/only propose a path for: tenant-list, supplier-list/);
    // An unknown-outcome step is not a step Bud took.
    expect(() => checkPortalPathProposal(pack, { slot: "tenant-list", steps: [{ verb: "nav", label: "Reports" }, { verb: "download", label: "Export" }] }, seen.map(s => s.tool === "download" ? { ...s, outcome: "unknown" as const } : s))).toThrow(/did not download from 'Export'/);
  });
});

describe("Refresh from REI follows the learned path", () => {
  it("reads REI's renamed report through the approved path; without it the repo placeholder is not found", async () => {
    const f = await lab({ reports: { tenants: REPORT } });
    const t = await askTask(f);
    await explore(t);
    await t.ok(PORTAL_PROPOSE_TOOL, { slot: "tenant-list", steps: PATH });
    t.broker.close(); await t.broker.released();

    const db = new WorkflowDatabase({ dir: f.root, key: Buffer.alloc(32, 7) }); cleanup.push(() => db.close());
    const refresh = (paths: PortalPathStore) => createReiDirectorySync({ runtime: f.runtime, browserId: async () => "work", account: async () => ({ marker: FICTIONAL_BUSINESS }),
      tenants: createTenantDirectoryStore(db), suppliers: createSupplierDirectory({ file: join(f.root, "suppliers.json") }), load: async () => fictionalReiPack(), paths, signInHolding: () => false, pollMs: 0 });
    const run = async (sync: ReturnType<typeof refresh>) => {
      const tools: string[] = [];
      await sync.handle("/api/rei-directory/runs", "POST", async () => ({ kind: "tenants" }));
      for (let i = 0; i < 2000; i++) {
        const now = await sync.status();
        if (now.run?.ask) { tools.push(now.run.ask.tool); await sync.handle(`/api/rei-directory/runs/${now.run.id}/answer`, "POST", async () => ({ requestId: now.run!.ask!.requestId, allowed: true })); continue; }
        if (!now.run?.working) return { run: now.run!, tools };
        await new Promise(r => setTimeout(r, 5));
      }
      throw new Error("The refresh did not settle.");
    };
    const without = await run(refresh(new PortalPathStore({ file: join(f.root, "no-paths.json") })));
    expect(without.run.phase).toBe("failed");
    expect(without.run.message).toMatch(/could not find REI's tenant list export/);
    const learned = await run(refresh(f.paths));
    expect(learned.run.phase, learned.run.message ?? "").toBe("preview");
    // The unmapped report asks on this run too (an Allow on the path was not standing permission); the choice and download still ask.
    expect(learned.tools).toEqual(["browser_click_semantic", "browser_select", "browser_download"]);
    expect(learned.run.preview).toMatchObject({ rows: 10, footer: 10, countMatches: true, accepted: 9 });
    expect(f.mock.effects).toEqual([]);
  });

  it("a saved path applies only on the origin it was learned on; the repo labels are never widened", async () => {
    const f = await lab();
    const pack = fictionalReiPack();
    await f.paths.save("rei-cloud", checkPortalPathProposal(pack, { slot: "tenant-list", steps: PATH }, SEEN), { grantId: "g", runId: "r", threadId: "t", origin: FICTIONAL_REI_ORIGIN });
    // Learned on the fictional portal: the real REI pack (another origin) keeps its own recipe.
    const repo = await loadPortalRecipePack("rei-cloud", new PortalPathStore({ file: join(f.root, "none.json") }));
    expect(await loadPortalRecipePack("rei-cloud", f.paths)).toEqual(repo);
    const merged = await f.paths.apply(pack);
    expect(merged.recipes["tenant-list"].steps).toContainEqual({ click: { label: REPORT, ask: "each-run" } });
    expect(merged.recipes["tenant-list"].steps.slice(0, 4)).toEqual([{ nav: ["Tenants"] }, { check: "account" }, { wait: "table" }, { read: "table" }]);
    expect(merged.labels).toEqual(pack.labels);
    expect(await portalMapForSites([FICTIONAL_REI_ORIGIN], async () => pack, f.paths)).toMatchObject({ portal: "rei-cloud", pack: { origin: FICTIONAL_REI_ORIGIN, labels: pack.labels } });
    expect(await portalMapForSites(["https://other.fictional.test"], async () => pack, f.paths)).toBeNull();
    expect(await portalMapForSites(["https://rei-mock.fictional.test.evil.example", "http://rei-mock.fictional.test"], async () => pack, f.paths)).toBeNull();
  });

  it("a saved file that was tampered with, or holds a path for another slot or origin, is skipped on load", async () => {
    const f = await lab();
    const pack = fictionalReiPack();
    const file = join(f.root, "tampered.json");
    const version = (over: Record<string, unknown>) => ({ revision: 1, portal: "rei-cloud", slot: "tenant-list", steps: PATH, readSafe: [],
      provenance: { grantId: "g", runId: "r", threadId: "t", origin: FICTIONAL_REI_ORIGIN, savedAt: "2026-10-05T00:00:00.000Z", urls: [] }, ...over });
    const loaded = async (over: Record<string, unknown>) => {
      await writePrivateJson(file, { version: 1, purpose: "portal-path-overrides", slots: { "rei-cloud/tenant-list": { current: 1, versions: [version(over)] } } });
      return (await new PortalPathStore({ file }).apply(pack));
    };
    expect((await loaded({})).recipes["tenant-list"]).not.toEqual(pack.recipes["tenant-list"]); // the untouched version applies
    for (const over of [
      { provenance: { grantId: "g", runId: "r", threadId: "t", origin: "https://other.fictional.test", savedAt: "x", urls: [] } },
      { provenance: { grantId: "g", runId: "r", threadId: "t", savedAt: "x", urls: [] } }, // saved before origins were recorded
      { slot: "supplier-list" }, { portal: "other-portal" },
      { steps: [{ verb: "nav", label: "Process › Payments" }, { verb: "download", label: "Export" }] },
      { steps: [{ verb: "click", label: "Finalise" }, { verb: "download", label: "Export" }] },
      { steps: [{ verb: "click", label: REPORT }] },
      { steps: [{ verb: "download", label: "Export", url: "https://evil.example/x" }] },
      { steps: "not steps" },
    ]) expect((await loaded(over)).recipes["tenant-list"], JSON.stringify(over)).toEqual(pack.recipes["tenant-list"]);
    // A readSafe list in the file grants nothing: the merged labels stay the repo's.
    expect((await loaded({ readSafe: [REPORT, "Process"] })).labels).toEqual(pack.labels);
  });
});

describe("one Allow on a path is not standing permission", () => {
  it("a later Ask task still asks before the unmapped report the path uses, while the repo's read-safe names stay card-free", async () => {
    const f = await lab({ reports: { tenants: REPORT } });
    const first = await askTask(f);
    await explore(first);
    await first.ok(PORTAL_PROPOSE_TOOL, { slot: "tenant-list", steps: PATH });
    first.broker.close(); await first.broker.released();
    const map = await portalMapForSites([FICTIONAL_REI_ORIGIN], async () => fictionalReiPack(), f.paths);
    const later = await askTask(f, { id: "fictional-learn-later", pack: map!.pack });
    await later.start();
    await later.ok("browser_navigate", { tab_id: 1, url: `${FICTIONAL_REI_ORIGIN}/customers/dashboard` }); await later.read(); // closes the earlier task's popup
    await later.ok("browser_click_semantic", { tab_id: 1, ref: later.ref("link", "Reports") }); await later.read();
    expect(later.approve).not.toHaveBeenCalled();
    await later.ok("browser_click_semantic", { tab_id: 1, ref: later.ref("link", REPORT) });
    expect(later.approve).toHaveBeenCalledTimes(1);
    expect(later.asked[0].summary).toMatch(new RegExp(REPORT.replace(/[()]/g, "\\$&")));
  });

  it("a proposal after the task's permission ended is refused before any card", async () => {
    const f = await lab({ reports: { tenants: REPORT } });
    let clock = Date.now();
    const t = await askTask(f, { expiresAt: clock + 60_000, now: () => clock });
    await explore(t);
    const asks = t.asked.length;
    clock += 61_000;
    const result = await t.call(PORTAL_PROPOSE_TOOL, { slot: "tenant-list", steps: PATH });
    expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(/permission has ended/);
    expect(t.asked.length).toBe(asks);
    expect((await f.paths.list("rei-cloud", "tenant-list")).versions).toEqual([]);
  });
});

describe("Ask browser lab hook", () => {
  it("is impossible without both lab variables, and production keeps the work browser and repo packs", () => {
    expect(askBrowserRuntime()).toBe(browserRuntime);
    expect(askPortalPackLoader()).toBe(loadPortalRecipePack);
    for (const env of [{}, { REALBUD_TEST_LAB: "1" }, { REALBUD_TEST_W1_FICTIONAL_REI: "1" }, { REALBUD_TEST_LAB: "true", REALBUD_TEST_W1_FICTIONAL_REI: "1" }]) {
      expect(askBrowserLabEnabled(env)).toBe(false);
      expect(() => useAskBrowserLab({ runtime: {} as never, load: async () => fictionalReiPack() }, env)).toThrow(/only available in a test lab/);
    }
    expect(askBrowserRuntime()).toBe(browserRuntime);
    expect(askBrowserLabEnabled({ REALBUD_TEST_LAB: "1", REALBUD_TEST_W1_FICTIONAL_REI: "1" })).toBe(true);
  });
});
