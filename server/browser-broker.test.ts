import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addBrowserTaskUpload, browserTaskWorkroom, BrowserRuntime, type BrowserJson } from "./browser-runtime.ts";
import { startBrowserBroker, jobBrowserUrl, observationRefs, browserLoginFields, onBrowserDecision, onBrowserSignIn, browserToolsFor, type BrowserBroker, type BrowserDecisionEvent } from "./browser-broker.ts";
import { grantedBrowserTools } from "./attended-run.ts";
import { openForSignIn, signInHandovers, signInStop } from "./browser-sign-in.ts";
import { approvalPath, approvalUrl, BrowserApprovalStore, legacyBrowserGrant, type BrowserPortalControls } from "./browser-authority.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { PortalEvidenceStore } from "./portal-path-overrides.ts";
import type { BrowserCheckpoint } from "../shared/browser.ts";
import { browserApprovalCardFrom } from "./browser-approval-card.ts";
import { buildHandoffPayload } from "./channel-handoff.ts";
import { EVENTS_DIR, ensureDirs } from "./config.ts";
import { EventBus } from "./harness/bus.ts";
import type { Store } from "./store.ts";
import { websiteRunReceipt } from "./website-work-adapters.ts";
import { legacyBrowserActions, parseBrowserTaskGrant, type BrowserActionClass, type BrowserTaskGrant } from "../shared/browser-task.ts";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type Task = { actions: BrowserActionClass[]; files?: Array<{ name: string; bytes: Buffer }>; extraUploads?: Array<{ name: string; sha256: string }>; browserId?: string; accountMarker?: string; expiresAt?: number; budget?: number; sites?: string[] };
async function fixture(checkpoint?: BrowserCheckpoint, job: { capabilities?: Array<"portal-read" | "portal-prefill" | "portal-submit">; rules?: Array<{ key: string; decision: "allow" | "deny" }>; task?: Task; portal?: BrowserPortalControls; nativeReadOnly?: boolean; ownsProfile?: boolean; evidence?: PortalEvidenceStore } = {}) {
  const root = privateTempRoot(join(tmpdir(), "rb-browser-broker-")); cleanup.push(() => removeFixture(root));
  const workroom = browserTaskWorkroom(root, "grant-fictional-1");
  const uploads = [...await Promise.all((job.task?.files ?? []).map(file => addBrowserTaskUpload(workroom, file.name, file.bytes))), ...(job.task?.extraUploads ?? [])];
  const capabilities = job.capabilities ?? ["portal-read", "portal-prefill"];
  // A saved job passes its own grant explicitly, built from its capabilities exactly as the host does.
  const grant = job.task ? parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: "grant-fictional-1", runId: "run-1", route: "ask",
    request: { text: "Fictional task", sha256: sha256("Fictional task") }, sites: job.task.sites ?? ["portal.example"], browser: { id: job.task.browserId ?? null, accountMarker: job.task.accountMarker ?? null },
    actions: job.task.actions, consequential: "ask-each", uploads, expiresAt: job.task.expiresAt ?? null, budget: job.task.budget ?? null })
    : legacyBrowserGrant({ runId: "run-1", allowedOrigins: ["portal.example"], capabilities, ...(checkpoint ? { checkpoint } : {}) });
  let downloadBytes: Buffer = Buffer.from("%PDF-1.7\nFictional statement\n"); const uploaded: Buffer[] = [];
  let downloadName = "Fictional statement.pdf"; let downloadHold: Promise<void> | null = null;
  let session = false; let page = '@e1 button "Show details"\n@e2 textbox "Reference"\n@e3 button "Transfer money"';
  let url = "https://portal.example/work"; let unknown = false; let scope = "user";
  const calls: string[][] = [];
  const command = async (args: string[]): Promise<BrowserJson> => {
    calls.push(args);
    if (args[0] === "status") return { daemon_version: "0.3.1", protocol_version: "1.3", browsers: [{ instance_id: "work", browser_name: "Chrome", extension_version: "0.3.1", extension_protocol_version: "1.3" }], sessions: session ? [{ session_id: "owned", browser_instance_id: "work", interaction: { borrow_confirmation: "always", request_help: "enabled" } }] : [] };
    if (args[0] === "session" && args[1] === "start") { session = true; return { session_id: "owned", browser_instance_id: "work", interaction: { borrow_confirmation: "always", request_help: "enabled" } }; }
    if (args[0] === "session" && args[1] === "stop") { session = false; return { stopped: ["owned"], failed: [], return_failures: [] }; }
    if (args[0] === "tab" && args[1] === "list") return { tabs: [{ tab_id: 1, url, title: "Private work", scope }, { tab_id: 2, url: "https://unrelated.example", title: "Private unrelated tab", scope: "user" }, ...(checkpoint ? [{ tab_id: 3, url, title: "Other account", scope: "user" }] : [])] };
    if (args[0] === "observe") return { text: page, tab_id: 1, ref_count: 3, truncated: false };
    if (unknown) throw new Error("Lost reply");
    if (args[0] === "tab" && args[1] === "borrow") scope = "agent";
    // The helper writes the capture itself, to the path RealBud chose.
    if (args[0] === "download") { await writeFile(args[args.indexOf("--out") + 1], downloadBytes); if (downloadHold) await downloadHold; return { ok: true, suggested_filename: downloadName }; }
    if (args[0] === "upload") uploaded.push(await readFile(args[args.indexOf("--file") + 1]));
    return { ok: true };
  };
  const runtime = new BrowserRuntime({ root, command, executable: async () => "/fixture/bsk", startDaemon: async () => {} });
  if (job.nativeReadOnly) Object.defineProperty(runtime, "readOnly", { value: true });
  // RealBud's own work-browser profile with full actions (NativeBrowserRuntime's shape).
  if (job.ownsProfile) Object.defineProperty(runtime, "ownsProfile", { value: true });
  await runtime.connect(); await runtime.select("work");
  const operations = new ConnectedAppOperationStore({ file: join(root, "operations.json") });
  const approvals = new BrowserApprovalStore({ file: join(root, "approvals.json") });
  let clock = 1_000_000;
  let active = true;
  const approve = vi.fn(async (..._args: unknown[]) => true);
  const start = async () => {
    const started = await startBrowserBroker({ runtime, operations, approvals, checkpoint, threadId: "thread-1", runId: "run-1", now: () => clock, grant,
      context: { allowedOrigins: ["portal.example"], capabilities, ...(job.rules ? { rules: job.rules } : {}) },
      ...(job.rules ? { rules: () => job.rules! } : {}),
      isActive: () => active, approve, assertCapability: () => {}, portal: job.portal, attachRoot: root, ...(job.evidence ? { evidence: job.evidence } : {}) });
    cleanup.push(async () => { started.close(); await started.released(); });
    return started;
  };
  const broker = await start();
  let next = 0;
  const rpc = async (method: string, params: BrowserJson, requestId: number, target: BrowserBroker) => {
    const response = await fetch(target.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: target.descriptor.headers[0].value }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) });
    return response.status === 200 ? (await response.json() as { result: unknown }).result : { isError: true, content: [{ text: `HTTP ${response.status}` }] };
  };
  const request = async (name: string, args: BrowserJson = {}, requestId: number = ++next, target: BrowserBroker = broker) =>
    await rpc("tools/call", { name, arguments: args }, requestId, target) as { isError?: boolean; content: Array<{ text: string }> };
  const listTools = async () => (await rpc("tools/list", {}, ++next, broker) as { tools: Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }> }).tools;
  const ready = async () => { await request("browser_borrow", { tab_id: 1 }); await request("browser_read", { tab_id: 1 }); };
  return { request, listTools, ready, broker, approve, calls, operations, approvals, runtime, start, workroom, uploaded, uploads, root,
    download: (bytes: Buffer, name?: string) => { downloadBytes = bytes; if (name) downloadName = name; },
    holdDownload: (hold: Promise<void> | null) => { downloadHold = hold; },
    page: (text: string) => { page = text; }, url: (value: string) => { url = value; },
    unknown: () => { unknown = true; }, known: () => { unknown = false; }, returnTab: () => { scope = "user"; }, advance: (ms: number) => { clock += ms; }, revoke: () => { active = false; } };
}

describe("live native task routine scope", () => {
  const task = (): Task => ({ actions: ["read", "navigate", "click", "fill", "keys"], browserId: "work", expiresAt: 1_100_000, budget: 100 });
  const searchPage = '@vom 1\nL1 page\n  main\n    form "Invoice search"\n      @e1 searchbox "Search"\n      @e2 button "Search"';

  it("reads and uses verified search controls without repeated approvals or standing rules", async () => {
    const f = await fixture(undefined, { task: task(), nativeReadOnly: true }); f.page(searchPage);
    await f.ready();
    expect((await f.request("browser_read", { tab_id: 1 })).isError).not.toBe(true);
    expect((await f.request("browser_navigate", { tab_id: 1, url: "https://portal.example/invoices" })).isError).not.toBe(true);
    await f.request("browser_read", { tab_id: 1 });
    expect((await f.request("browser_fill", { tab_id: 1, ref: "@e1", value: "FICT-7" })).isError).not.toBe(true);
    // Each control still consumes its observation; there is no stale-ref shortcut.
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e2" })).isError).toBe(true);
    await f.request("browser_read", { tab_id: 1 });
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e2" })).isError).not.toBe(true);
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.calls.some(call => call[0] === "fill")).toBe(true);
    expect(f.calls.some(call => call[0] === "click")).toBe(true);
  });

  it("withholds a changed bound account before returning the read", async () => {
    const f = await fixture(undefined, { task: { ...task(), accountMarker: "Fictional office" }, nativeReadOnly: true });
    f.page(searchPage + '\n    paragraph "Fictional office"'); await f.ready();
    f.page(searchPage + '\n    paragraph "Other private office"');
    const result = await f.request("browser_read", { tab_id: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Other private office");
    await f.broker.released(); expect((await f.runtime.status()).active).toBe(false);
  });

  it("honours a standing denial and does not silently approve it as a task step", async () => {
    const f = await fixture(undefined, { task: task(), nativeReadOnly: true, rules: [{ key: "portal:read:portal.example", decision: "deny" }] });
    f.approve.mockResolvedValue(false);
    expect((await f.request("browser_borrow", { tab_id: 1 })).isError).toBe(true);
    expect(f.approve).toHaveBeenCalledOnce();
    expect(f.calls.some(call => call[0] === "tab" && call[1] === "borrow")).toBe(false);
  });

  it.each(["browser_read", "browser_fill"] as const)("rechecks a new standing denial during the fresh %s observation", async tool => {
    const rules: Array<{ key: string; decision: "allow" | "deny" }> = [];
    const f = await fixture(undefined, { task: task(), nativeReadOnly: true, rules }); f.page(searchPage); await f.ready();
    const observe = f.runtime.observeTab.bind(f.runtime);
    vi.spyOn(f.runtime, "observeTab").mockImplementationOnce(async (...args) => {
      const result = await observe(...args);
      rules.push({ key: `portal:${tool === "browser_fill" ? "prefill" : "read"}:portal.example`, decision: "deny" });
      return result;
    });
    const result = await f.request(tool, { tab_id: 1, ...(tool === "browser_fill" ? { ref: "@e1", value: "FICT-7" } : {}) });
    expect(result.isError).toBe(true);
    expect(f.calls.some(call => call[0] === "fill")).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Invoice search');
    expect(f.approve).not.toHaveBeenCalled();
  });

  it("rechecks live grant ownership after the runtime status await", async () => {
    const f = await fixture(undefined, { task: task(), nativeReadOnly: true }); f.page(searchPage); await f.ready();
    const reads = f.calls.filter(call => call[0] === "observe").length;
    const status = f.runtime.status.bind(f.runtime);
    vi.spyOn(f.runtime, "status").mockImplementationOnce(async () => { const result = await status(); f.revoke(); return result; });
    expect((await f.request("browser_read", { tab_id: 1 })).isError).toBe(true);
    expect(f.calls.filter(call => call[0] === "observe")).toHaveLength(reads);
  });

  it.each(["https://other.example/work", "https://portal.example/changed"])("withholds data if the page changes to %s during status verification", async url => {
    const f = await fixture(undefined, { task: { ...task(), sites: ["portal.example", "other.example"] }, nativeReadOnly: true });
    f.page(searchPage); await f.ready();
    const status = f.runtime.status.bind(f.runtime);
    vi.spyOn(f.runtime, "status").mockImplementationOnce(async () => {
      const result = await status(); f.url(url); f.page('Private fictional data on the changed page'); return result;
    });
    const result = await f.request("browser_read", { tab_id: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Private fictional data");
  });

  it.each(["revoked", "expired", "returned", "other-origin", "stopped"] as const)("stops a %s task before another read", async reason => {
    const f = await fixture(undefined, { task: task(), nativeReadOnly: true }); f.page(searchPage); await f.ready();
    const reads = f.calls.filter(call => call[0] === "observe").length;
    if (reason === "revoked") f.revoke();
    if (reason === "expired") f.advance(100_000);
    if (reason === "returned") f.returnTab();
    if (reason === "other-origin") f.url("https://other.example/work");
    if (reason === "stopped") { f.broker.close(); await f.broker.released(); }
    if (reason === "stopped") await expect(f.request("browser_read", { tab_id: 1 })).rejects.toThrow();
    else expect((await f.request("browser_read", { tab_id: 1 })).isError).toBe(true);
    expect(f.calls.filter(call => call[0] === "observe")).toHaveLength(reads);
  });
});
describe("full browser actions in RealBud's own work browser", () => {
  const task = (actions: BrowserActionClass[] = ["read", "navigate", "click", "fill", "keys", "submit"], extra: Partial<Task> = {}): Task =>
    ({ actions, browserId: "work", expiresAt: 1_100_000, budget: 100, ...extra });
  const vomPage = (lines: string[]) => ["@vom 1", "L1 page", "  main", ...lines].join("\n");
  const DRAFT = vomPage(['    form "Maintenance request"', '      @e1 textbox "Description"', '      @e2 button "Save draft"', '      @e3 button "Lodge request"']);
  const PAY = (amount: string) => vomPage(['    heading "Pay invoice"', '    form "Pay invoice"', '      @e1 textbox "Payee" value="Fictional Plumbing Pty Ltd"', `      @e2 textbox "Amount" value="${amount}"`, '      @e3 button "Submit"']);
  const BOND = vomPage(['    form "Bond"', '      heading "Bond lodgement"', '      @e1 textbox "Tenant name" value="Fictional Tenant"', '      @e2 button "Lodge"']);
  const dispatched = (f: Awaited<ReturnType<typeof fixture>>, verb: string) => f.calls.filter(a => a[0] === verb);

  it("asks before an ordinary submit the task names, then dispatches it after approval", async () => {
    const f = await fixture(undefined, { task: task(), ownsProfile: true }); f.page(DRAFT); await f.ready();
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e2" })).isError).not.toBe(true);
    expect(f.approve.mock.calls.at(-1)![0]).toBe("browser_click_semantic");
    expect(f.approve.mock.calls.at(-1)![4]).toMatchObject({ fence: { surface: "portal-submit" } });
    expect(dispatched(f, "click")).toHaveLength(1);
  });

  it("does not submit without the submit class, and a borrowed personal browser still asks", async () => {
    const without = await fixture(undefined, { task: task(["read", "navigate", "click", "fill"]), ownsProfile: true }); without.page(DRAFT); await without.ready();
    expect((await without.request("browser_click_semantic", { tab_id: 1, ref: "@e2" })).content[0].text).toBe("This job cannot press Submit. Add 'Bud may press Submit' on the job if it should.");
    expect(dispatched(without, "click")).toHaveLength(0);
    const borrowed = await fixture(undefined, { task: task() }); borrowed.page(DRAFT); await borrowed.ready();
    expect((await borrowed.request("browser_click_semantic", { tab_id: 1, ref: "@e2" })).isError).not.toBe(true);
    expect(borrowed.approve.mock.calls.at(-1)![0]).toBe("browser_click_semantic");
    expect(borrowed.approve.mock.calls.at(-1)![4]).toEqual({ fence: { surface: "portal-submit", origin: "portal.example", ruleOffer: null } });
  });

  it("asks once for a submit on a payment form, with the payee and amount read from the page", async () => {
    const f = await fixture(undefined, { task: task(), ownsProfile: true }); f.page(PAY("A$480.00")); await f.ready();
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e3" })).isError).not.toBe(true);
    expect(f.approve).toHaveBeenCalledOnce();
    const [tool, params, summary, , projection] = f.approve.mock.calls[0];
    expect(tool).toBe("browser_click_semantic");
    expect(summary).toBe("Pay AUD 480.00 to Fictional Plumbing Pty Ltd by pressing 'Submit' on portal.example. This approval is for this one payment and expires in 2 minutes.");
    expect(params).toMatchObject({ url: "https://portal.example/work", label: 'button "Submit"', approval: { kind: "pay",
      facts: expect.arrayContaining([{ name: "recipient", value: "Fictional Plumbing Pty Ltd", confirmed: true }, { name: "amount", value: "480.00", confirmed: true }]) } });
    expect(projection).toEqual({ fence: { surface: "portal-submit", origin: "portal.example", ruleOffer: null }, approvalPolicy: "once" });
    expect(dispatched(f, "click")).toHaveLength(1);
    expect(await f.approvals.list()).toMatchObject([{ decision: "approved", outcome: "unverified", kind: "pay" }]);
  });

  it("keeps a payment whose amount the page does not confirm with the person, and refused submits dispatch nothing", async () => {
    const f = await fixture(undefined, { task: task(), ownsProfile: true }); f.page(PAY("480.00")); await f.ready();
    const result = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e3" });
    expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(/could not confirm the currency .* stays with the person/);
    expect(f.approve).not.toHaveBeenCalled(); expect(dispatched(f, "click")).toHaveLength(0);
    f.approve.mockResolvedValue(false); f.page(PAY("A$480.00")); await f.request("browser_read", { tab_id: 1 });
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e3" })).content[0].text).toBe("This browser step was not approved. Do not retry it without a new user request.");
    expect(dispatched(f, "click")).toHaveLength(0);
  });

  it("asks once to lodge a bond, naming the document", async () => {
    const f = await fixture(undefined, { task: task(), ownsProfile: true }); f.page(BOND); await f.ready();
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e2" })).isError).not.toBe(true);
    expect(f.approve.mock.calls[0][2]).toBe("Lodge 'Bond lodgement' by pressing 'Lodge' on portal.example. This approval is for this one notice and expires in 2 minutes.");
    expect(f.approve.mock.calls[0][4]).toEqual({ fence: { surface: "portal-submit", origin: "portal.example", ruleOffer: null }, approvalPolicy: "once" });
  });

  it("asks once per upload, showing the file and the destination origin", async () => {
    const f = await fixture(undefined, { task: { ...task(["read", "click", "upload"]), files: [{ name: "fictional-lease.pdf", bytes: Buffer.from("%PDF-1.7 fictional lease") }] }, ownsProfile: true });
    f.page(FORM_PAGE); await f.ready();
    expect((await f.request("browser_upload", { tab_id: 1, ref: "@e4", file: "fictional-lease.pdf" })).isError).not.toBe(true);
    const [tool, params, summary, , projection] = f.approve.mock.calls[0];
    expect([tool, params, summary, projection]).toEqual(["browser_upload", { url: "https://portal.example/work", label: 'button "Choose file"', file: "fictional-lease.pdf" },
      "Upload the file 'fictional-lease.pdf' to https://portal.example through Choose file. This sends the file to that site; this approval applies once.",
      { fence: { surface: "portal-prefill", origin: "portal.example", ruleOffer: null }, approvalPolicy: "once" }]);
    await f.request("browser_read", { tab_id: 1 });
    await f.request("browser_upload", { tab_id: 1, ref: "@e4", file: "fictional-lease.pdf" });
    expect(f.approve).toHaveBeenCalledTimes(2);
    // Never a path: an unlisted name, a traversal or an absolute path is refused before any card.
    for (const file of ["fictional-other.pdf", "../uploads/fictional-lease.pdf", "/synthetic/fictional-lease.pdf"]) {
      await f.request("browser_read", { tab_id: 1 });
      expect((await f.request("browser_upload", { tab_id: 1, ref: "@e4", file })).content[0].text).toBe("Only files given to this task can be uploaded. Ask the person to add the file to the task.");
    }
    expect(f.approve).toHaveBeenCalledTimes(2); expect(dispatched(f, "upload")).toHaveLength(2);
  });

  it("attaches a readable download to the workroom like a person's attachment, and never keeps an archive there", async () => {
    const f = await fixture(undefined, { task: task(["read", "download"]), ownsProfile: true }); f.page(FORM_PAGE); await f.ready();
    const bytes = Buffer.from("%PDF-1.7\nFictional statement\n"); f.download(bytes);
    const body = JSON.parse((await f.request("browser_download", { tab_id: 1, ref: "@e3" })).content[0].text);
    expect(body.attachment.name).toBe("Fictional statement.pdf");
    expect(body.attachment.path.startsWith(join(realpathSync(f.root), "vault", "ask-uploads"))).toBe(true);
    expect(await readFile(body.attachment.path)).toEqual(bytes);
    if (process.platform !== "win32") expect((await stat(body.attachment.path)).mode & 0o777).toBe(0o600);
    await f.request("browser_read", { tab_id: 1 });
    f.download(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "Fictional bundle.zip");
    const archive = JSON.parse((await f.request("browser_download", { tab_id: 1, ref: "@e3" })).content[0].text);
    expect(archive.downloaded.contentType).toBe("application/zip"); expect(archive.attachment).toBeUndefined();
    expect(archive.note).toMatch(/not readable in the workroom, and it was not opened/);
  });

  it.each([
    ["a program by its bytes", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(80)]), "Fictional statement.pdf"],
    ["a program by its name", Buffer.from("%PDF-1.7 fictional"), "Fictional statement.pdf.exe"],
    ["a script", Buffer.from("#!/bin/sh\necho fictional\n"), "statement.txt"],
    ["a macOS program", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]), "statement"],
    ["a file over 50 MB", Buffer.alloc(50 * 1024 * 1024 + 1, 0x20), "statement.txt"],
  ])("keeps nothing when the download is %s", async (_case, bytes, name) => {
    const f = await fixture(undefined, { task: task(["read", "download"]), ownsProfile: true }); f.page(FORM_PAGE); await f.ready();
    f.download(bytes, name);
    const result = await f.request("browser_download", { tab_id: 1, ref: "@e3" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Nothing was kept/);
    expect(await readdir(join(f.workroom, "incoming"))).toEqual([]);
    expect(await readdir(join(f.workroom, "downloads")).catch(() => [])).toEqual([]);
    expect(await readdir(join(f.root, "vault", "ask-uploads")).catch(() => [])).toEqual([]);
  });

  it("Stop during a download keeps nothing and ends the task", async () => {
    const f = await fixture(undefined, { task: task(["read", "download"]), ownsProfile: true }); f.page(FORM_PAGE); await f.ready();
    let release!: () => void; f.holdDownload(new Promise<void>(done => { release = done; }));
    const pending = f.request("browser_download", { tab_id: 1, ref: "@e3" }).catch(error => ({ isError: true, content: [{ text: String(error) }] }));
    for (let i = 0; i < 100 && !f.calls.some(call => call[0] === "download"); i++) await new Promise(done => setTimeout(done, 5));
    f.broker.close(); release();
    const result = await pending;
    expect(result.isError).toBe(true);
    await f.broker.released();
    expect(await readdir(join(f.workroom, "incoming"))).toEqual([]);
    expect(await readdir(join(f.workroom, "downloads")).catch(() => [])).toEqual([]);
    expect((await f.runtime.status()).active).toBe(false);
  });

  it("stays on the task's sites: no navigation, tab or submit outside them", async () => {
    const f = await fixture(undefined, { task: task(), ownsProfile: true }); f.page(DRAFT); await f.ready();
    const out = await f.request("browser_navigate", { tab_id: 1, url: "https://unrelated.example/form" });
    expect(out.isError).toBe(true); expect(out.content[0].text).toMatch(/^Open this page yourself\./);
    expect((await f.request("browser_borrow", { tab_id: 2 })).isError).toBe(true);
    // The borrowed tab moved off the task's site: a fresh read is refused and nothing is pressed.
    f.url("https://unrelated.example/form");
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e2" })).isError).toBe(true);
    expect(dispatched(f, "navigate")).toHaveLength(0); expect(dispatched(f, "click")).toHaveLength(0);
    expect(f.calls.some(call => call[0] === "tab" && call[1] === "borrow" && call[2] === "2")).toBe(false);
  });
});
describe("saved-job browser broker", () => {
  it.each(["browser_read", "browser_navigate"])("holds %s before reading an already-signed-in account portal without its intended account binding", async tool => {
    const waiting = vi.fn(() => true); const finished = vi.fn();
    const off = onBrowserSignIn({ waiting, finished }); cleanup.push(async () => off());
    const f = await fixture(undefined, { portal: { origin: "https://portal.example", readSafe: ["Search"], menu: [], pagination: [], consequential: [], signInHosts: [], accountMarker: { landmark: "banner", role: "button" } } });
    f.page('@native-ax 1\nrootwebarea\n  banner\n    @e1 button "AN-UNSELECTED-OFFICE"\n  main\n    @e2 heading "Invoices"');
    await f.request("browser_borrow", { tab_id: 1 });
    const result = await f.request(tool, { tab_id: 1, ...(tool === "browser_navigate" ? { url: "https://portal.example/invoices" } : {}) });
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain("Choose and verify the intended account");
    expect(f.calls.some(args => args[0] === "observe" || args[0] === "navigate")).toBe(false);
    expect(waiting).toHaveBeenCalledWith(expect.objectContaining({ reason: "login", origin: "https://portal.example" }));
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ signedIn: false }));
  });
  it("uses exact HTTPS sites, rejects credentials, other origins and local addresses", () => {
    for (const url of ["http://portal.example", "https://user:pass@portal.example", "https://other.portal.example", "https://portal.example.evil.test", "https://127.0.0.1"]) expect(jobBrowserUrl(url, ["portal.example"])).toBeNull();
    expect(jobBrowserUrl("https://portal.example/work", ["portal.example"])?.origin).toBe("https://portal.example");
  });
  it("takes no action in a site's tab while the person signs in there, and resumes after", async () => {
    const f = await fixture(); await f.ready();
    const handover = openForSignIn({ site: "https://portal.example", reason: "Fictional sign-in", threadId: "thread-handover" },
      { pollMs: 1, sites: [{ key: "portal", name: "Portal", origin: "https://portal.example", loginUrl: "https://portal.example/", signInHosts: [], postLogin: [], accountParam: null }],
        runtime: { openSignInTab: async () => "FICTIONALTARGET", signInTabUrl: async () => null } });
    for (let i = 0; i < 100 && !signInHandovers("thread-handover").length; i++) await new Promise(resolve => setTimeout(resolve, 2));
    const observed = f.calls.filter(a => a[0] === "observe").length;
    const read = await f.request("browser_read", { tab_id: 1 });
    expect(read.isError).toBe(true); expect(read.content[0].text).toMatch(/signing in on this site/);
    expect((await f.request("browser_fill", { tab_id: 1, ref: "@e2", value: "x" })).isError).toBe(true);
    expect(f.calls.filter(a => a[0] === "observe").length).toBe(observed);
    expect(f.calls.some(a => a[0] === "fill")).toBe(false);
    signInStop(signInHandovers("thread-handover")[0].id);
    expect((await handover).outcome).toBe("stopped");
    expect((await f.request("browser_read", { tab_id: 1 })).isError).not.toBe(true);
  });
  it("does not disclose unrelated tabs or read an unborrowed page", async () => {
    const f = await fixture(); const listed = await f.request("browser_tabs");
    expect(JSON.stringify(listed)).not.toContain("unrelated");
    expect((await f.request("browser_read", { tab_id: 1 })).isError).toBe(true);
    expect(f.calls.some(a => a[0] === "observe")).toBe(false);
  });
  it("returns read-only page evidence and blocks transfers before approval", async () => {
    const f = await fixture(); await f.ready(); const before = f.approve.mock.calls.length;
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e3" })).isError).toBe(true);
    expect(f.approve.mock.calls.length).toBe(before); expect(f.calls.some(a => a[0] === "click")).toBe(false);
  });
  it("reviews a normal field, consumes refs and does not execute transport retries twice", async () => {
    const f = await fixture(); await f.ready();
    const args = { tab_id: 1, ref: "@e2", value: "Fictional reference" };
    const result = await f.request("browser_fill", args, 30); expect(result.isError).not.toBe(true);
    expect(await f.request("browser_fill", args, 30)).toEqual(result);
    expect((await f.request("browser_fill", { ...args, value: "Changed" }, 30)).isError).toBe(true);
    expect((await f.request("browser_fill", args, 31)).isError).toBe(true);
    expect(f.calls.filter(a => a[0] === "fill")).toHaveLength(1);
  });
  it("rechecks the control after waiting for approval", async () => {
    const f = await fixture(); await f.ready();
    f.approve.mockImplementationOnce(async () => { f.page('@e1 button "Transfer money"'); return true; });
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" })).isError).toBe(true);
    expect(f.calls.some(a => a[0] === "click")).toBe(false);
  });
  it("holds unknown effects and never automatically replays", async () => {
    const f = await fixture(); await f.ready(); f.unknown();
    expect((await f.request("browser_fill", { tab_id: 1, ref: "@e2", value: "Sample" })).isError).toBe(true);
    expect(f.operations.list().some(row => row.status === "unknown")).toBe(true);
    await f.broker.released(); expect((await f.runtime.status()).active).toBe(false);
    await f.request("browser_fill", { tab_id: 1, ref: "@e2", value: "Sample" });
    expect(f.calls.filter(a => a[0] === "fill")).toHaveLength(1);
  });
  it("keeps bank reading available while blocking bank field preparation", async () => {
    const f = await fixture(); f.page('Account number: fictional 1234\nTransaction history\n@e1 button "Show statements"\n@e2 textbox "Reference"'); await f.ready();
    expect((await f.request("browser_fill", { tab_id: 1, ref: "@e2", value: "100" })).isError).toBe(true);
    expect(f.calls.some(a => a[0] === "fill")).toBe(false);
  });
  it("withholds login fields and raw script/recording tools", async () => {
    const f = await fixture(); await f.request("browser_borrow", { tab_id: 1 }); f.page('@e1 textbox "Password" value="do-not-return"');
    const read = await f.request("browser_read", { tab_id: 1 }); expect(read.isError).toBe(true); expect(JSON.stringify(read)).not.toContain("do-not-return");
    expect((await f.request("evaluate", { script: "anything" })).isError).toBe(true);
    expect(browserLoginFields('Account number: 1234\nTransaction history')).toBe(false);
    expect(observationRefs('@e1 button "Open"').get("@e1")).toContain("Open");
  });
  it("stops a pending approval before any dispatch", async () => {
    const f = await fixture(); await f.ready();
    let finish: (value: boolean) => void = () => {};
    f.approve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.request("browser_fill", { tab_id: 1, ref: "@e2", value: "Sample" });
    await vi.waitFor(() => expect(f.approve.mock.calls.length).toBe(3));
    f.broker.close(); finish(true); await pending; await f.broker.released();
    expect(f.calls.some(a => a[0] === "fill")).toBe(false);
  });
  it("stops when the person takes back a tab, without another page read", async () => {
    const f = await fixture(); await f.ready();
    const reads = f.calls.filter(a => a[0] === "observe").length;
    f.returnTab();
    expect((await f.request("browser_read", { tab_id: 1 })).isError).toBe(true);
    expect(f.calls.filter(a => a[0] === "observe")).toHaveLength(reads);
    await f.broker.released(); expect((await f.runtime.status()).active).toBe(false);
  });
  it("keeps a recovery step on its verified tab and withholds a changed account", async () => {
    const f = await fixture({ browserId: "work", tabId: 1, origin: "https://portal.example", accountMarker: "Office account" });
    const listed = await f.request("browser_tabs");
    expect(JSON.parse(listed.content[0].text).tabs.map((tab: { tab_id: number }) => tab.tab_id)).toEqual([1]);
    expect((await f.request("browser_borrow", { tab_id: 3 })).isError).toBe(true);
    f.page('Office account\n@e1 button "Show statements"'); await f.ready();
    f.page('Other private account\n@e1 button "Show statements"');
    const read = await f.request("browser_read", { tab_id: 1 });
    expect(read.isError).toBe(true); expect(JSON.stringify(read)).not.toContain("Other private account");
    await f.broker.released(); expect((await f.runtime.status()).active).toBe(false);
  });
});

const PAY_PAGE = 'Pay a bill\nPayee: Fictional Plumbing Pty Ltd\nAmount: AUD 480.00\nReference: INV-FICTIONAL-7\n@e1 button "Pay now"\n@e2 button "Show details"';
describe("consequential browser steps need a once-only approval of the verified facts", () => {
  const clicks = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(a => a[0] === "click").length;
  it("persists the record before the card, then presses once after the same facts are re-read", async () => {
    const f = await fixture(); f.page(PAY_PAGE); await f.ready();
    let pendingBeforeCard: unknown;
    f.approve.mockImplementationOnce(async () => { pendingBeforeCard = (await f.approvals.list()).map(row => row.decision); return true; });
    const result = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" });
    expect(result.isError).not.toBe(true);
    expect(pendingBeforeCard).toEqual(["pending"]);
    const [tool, params, summary, , projection] = f.approve.mock.calls.at(-1)!;
    expect(tool).toBe("browser_click_semantic");
    expect(summary).toBe("Pay AUD 480.00 to Fictional Plumbing Pty Ltd (reference INV-FICTIONAL-7) by pressing 'Pay now' on portal.example. This approval is for this one payment and expires in 2 minutes.");
    expect(projection).toEqual({ fence: { surface: "portal-submit", origin: "portal.example", ruleOffer: null }, approvalPolicy: "once" });
    expect((params as { approval: { kind: string } }).approval.kind).toBe("pay");
    expect(clicks(f)).toBe(1);
    expect(await f.approvals.list()).toMatchObject([{ decision: "approved", outcome: "unverified", kind: "pay", control: { label: "Pay now" } }]);
    // Once only: the approval is spent and the old reference is gone.
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" })).isError).toBe(true);
    expect(clicks(f)).toBe(1);
  });
  it("records a Stop while the card is open as stopped, not as the person's refusal", async () => {
    const f = await fixture(); f.page(PAY_PAGE); await f.ready();
    let answer: (value: boolean) => void = () => {};
    f.approve.mockImplementationOnce(() => new Promise<boolean>(resolve => { answer = resolve; }));
    const pending = f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" }).catch(() => undefined);
    await vi.waitFor(async () => expect((await f.approvals.list()).map(row => row.decision)).toEqual(["pending"]));
    f.broker.close(); answer(false); await pending; await f.broker.released();
    await vi.waitFor(async () => expect(await f.approvals.list()).toMatchObject([{ decision: "stopped", outcome: "not-dispatched" }]));
    expect(clicks(f)).toBe(0);
  });
  it("records a refusal and presses nothing", async () => {
    const f = await fixture(); f.page(PAY_PAGE); await f.ready();
    f.approve.mockImplementationOnce(async () => false);
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" })).isError).toBe(true);
    expect(clicks(f)).toBe(0);
    expect(await f.approvals.list()).toMatchObject([{ decision: "denied", outcome: "not-dispatched" }]);
  });
  it("does not use an approval that arrives after it expired", async () => {
    const f = await fixture(); f.page(PAY_PAGE); await f.ready();
    f.approve.mockImplementationOnce(async () => { f.advance(121_000); return true; });
    const result = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" });
    expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(/expired before it was used/);
    expect(clicks(f)).toBe(0);
    expect(await f.approvals.list()).toMatchObject([{ decision: "expired", outcome: "not-dispatched" }]);
  });
  it("refuses when the facts change while waiting for the person", async () => {
    const f = await fixture(); f.page(PAY_PAGE); await f.ready();
    f.approve.mockImplementationOnce(async () => { f.page(PAY_PAGE.replace("AUD 480.00", "AUD 4800.00")); return true; });
    const result = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" });
    expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(/changed after approval\. Nothing was pressed/);
    expect(clicks(f)).toBe(0);
    expect(await f.approvals.list()).toMatchObject([{ decision: "changed", outcome: "not-dispatched" }]);
  });
  it("shows no card for facts the page does not confirm", async () => {
    const f = await fixture(); f.page('Amount: AUD 480.00\n@e1 button "Pay now"'); await f.ready();
    const asked = f.approve.mock.calls.length;
    const result = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" });
    expect(result.content[0].text).toMatch(/could not confirm the payee/);
    expect(f.approve.mock.calls.length).toBe(asked); expect(clicks(f)).toBe(0);
    expect(await f.approvals.list()).toMatchObject([{ decision: "unconfirmed", unconfirmed: ["recipient"] }]);
  });
  it("never replays an approved step whose outcome is unknown, even from a new broker", async () => {
    const f = await fixture(); f.page(PAY_PAGE); await f.ready(); f.unknown();
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" })).isError).toBe(true);
    expect(clicks(f)).toBe(1);
    expect(await f.approvals.list()).toMatchObject([{ decision: "approved", outcome: "unknown" }]);
    await f.broker.released(); expect((await f.runtime.status()).active).toBe(false);
    f.known();
    const next = await f.start();
    await f.request("browser_borrow", { tab_id: 1 }, 101, next); await f.request("browser_read", { tab_id: 1 }, 102, next);
    const asked = f.approve.mock.calls.length;
    const retry = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" }, 103, next);
    expect(retry.isError).toBe(true); expect(retry.content[0].text).toMatch(/unknown result\. Check the site yourself/);
    expect(f.approve.mock.calls.length).toBe(asked); expect(clicks(f)).toBe(1);
  });
  it("keeps an acknowledged payment unverified across a crash and reopen until a person records its result", async () => {
    const f = await fixture(); f.page(PAY_PAGE); await f.ready();
    // The browser ACKs the press; that proves dispatch, not the payment.
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" })).isError).not.toBe(true);
    expect(clicks(f)).toBe(1);
    // Crash: the broker is gone and the store is reopened from disk.
    f.broker.close(); await f.broker.released();
    const reopened = new BrowserApprovalStore({ file: join(f.root, "approvals.json") });
    const [saved] = await reopened.list();
    expect(saved).toMatchObject({ decision: "approved", outcome: "unverified", kind: "pay" });
    let id = 200;
    for (const jump of [48 * 3_600_000, -96 * 3_600_000]) {
      f.advance(jump);
      const next = await f.start();
      await f.request("browser_borrow", { tab_id: 1 }, ++id, next); await f.request("browser_read", { tab_id: 1 }, ++id, next);
      const asked = f.approve.mock.calls.length;
      const retry = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" }, ++id, next);
      expect(retry.isError).toBe(true); expect(retry.content[0].text).toMatch(/unknown result\. Check the site yourself/);
      expect(f.approve.mock.calls.length).toBe(asked); expect(clicks(f)).toBe(1);
      next.close(); await next.released();
    }
    // Only a person's recorded check releases it.
    await f.approvals.reconcile(saved.id, "not-done", 5);
    const after = await f.start();
    await f.request("browser_borrow", { tab_id: 1 }, ++id, after); await f.request("browser_read", { tab_id: 1 }, ++id, after);
    const released = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" }, ++id, after);
    expect(released.content[0].text).toMatch(/acknowledged/);
    expect(clicks(f)).toBe(2);
  });
  it("keeps a saved job's routine steps as before and records the broker's own decisions", async () => {
    const seen: BrowserDecisionEvent[] = []; const stop = onBrowserDecision(event => seen.push(event)); cleanup.push(async () => stop());
    const f = await fixture(undefined, { rules: [{ key: "portal:read:portal.example", decision: "allow" }] });
    f.page('@e1 button "Show details"\n@e2 textbox "Reference"\n@e3 button "Save"'); await f.ready();
    expect(f.approve).not.toHaveBeenCalled(); // borrow and read allowed by the site rule
    expect(seen.map(event => event.entry.note)).toContain("allowed by rule · Reading on portal.example");
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e3" })).content[0].text).toBe("This job cannot press Submit. Add 'Bud may press Submit' on the job if it should.");
    expect(await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" })).not.toHaveProperty("isError");
    expect(f.approve.mock.calls.at(-1)!.slice(2)).toEqual(["Use button \"Show details\" on portal.example.", expect.anything(), { fence: { surface: "portal-read", origin: "portal.example", ruleOffer: null } }]);
    await f.request("browser_read", { tab_id: 1 });
    expect(await f.request("browser_fill", { tab_id: 1, ref: "@e2", value: "Fictional reference" })).not.toHaveProperty("isError");
    expect(f.approve.mock.calls.at(-1)![4]).toEqual({ fence: { surface: "portal-prefill", origin: "portal.example", ruleOffer: { surface: "portal-prefill", origin: "portal.example", label: "Prefill on portal.example" } } });
    expect(seen.every(event => event.threadId === "thread-1" && event.runId === "run-1")).toBe(true);
    expect(await f.approvals.list()).toEqual([]);
  });
  it("keeps a read-only job from filling", async () => {
    const f = await fixture(undefined, { capabilities: ["portal-read"] }); await f.ready();
    expect((await f.request("browser_fill", { tab_id: 1, ref: "@e2", value: "Fictional" })).isError).toBe(true);
    expect(f.calls.some(a => a[0] === "fill")).toBe(false);
  });
});

const ALL: BrowserActionClass[] = ["read", "navigate", "fill", "click", "download", "upload", "keys", "submit"];
const FORM_PAGE = '@e1 textbox "Property code"\n@e2 combobox "Sort by"\n@e3 link "Download report"\n@e4 button "Choose file"\n@e5 button "Show details"';
const PAY_FORM = `${PAY_PAGE}\n@e3 textbox "Amount"`;
describe("keys, dropdowns, downloads and uploads", () => {
  const dispatched = (f: Awaited<ReturnType<typeof fixture>>, verb: string) => f.calls.filter(a => a[0] === verb);
  const logged = (seen: BrowserDecisionEvent[]) => seen.filter(event => event.action).map(event => event.action!);
  const watch = () => { const seen: BrowserDecisionEvent[] = []; const stop = onBrowserDecision(event => seen.push(event)); cleanup.push(async () => stop()); return seen; };

  it("offers the newer tools only to an explicit grant with their action class, and lists only granted files", async () => {
    const saved = await fixture(undefined, { capabilities: ["portal-read", "portal-prefill", "portal-submit"] });
    expect((await saved.listTools()).map(tool => tool.name)).toEqual(["browser_tabs", "browser_borrow", "browser_read", "browser_navigate", "browser_fill", "browser_click_semantic", "browser_release"]);
    await saved.ready(); saved.page(FORM_PAGE); await saved.request("browser_read", { tab_id: 1 });
    expect((await saved.request("browser_select", { tab_id: 1, ref: "@e2", values: ["date"] })).content[0].text).toBe("This browser tool or its arguments are not available.");
    const task = await fixture(undefined, { task: { actions: ["read", "keys", "upload"], files: [{ name: "fictional-lease.pdf", bytes: Buffer.from("fictional lease") }] } });
    const tools = await task.listTools();
    // Exactly the grant's classes: reading, keys and the granted upload; no opening, typing or clicking.
    expect(tools.map(tool => tool.name)).toEqual(["browser_tabs", "browser_borrow", "browser_read", "browser_press", "browser_upload", "browser_release"]);
    expect(tools.find(tool => tool.name === "browser_upload")!.inputSchema.properties.file.enum).toEqual(["fictional-lease.pdf"]);
  });

  it("presses a key in an observed control after review and logs it", async () => {
    const seen = watch();
    const f = await fixture(undefined, { task: { actions: ["read", "keys"] } }); f.page(FORM_PAGE); await f.ready();
    const result = await f.request("browser_press", { tab_id: 1, ref: "@e1", key: "shift+tab" });
    expect(result.isError).not.toBe(true);
    expect(dispatched(f, "press")).toEqual([["press", "Shift+Tab", "--ref", "@e1", "--session", "owned", "--tab-id", "1"]]);
    expect(f.approve.mock.calls.at(-1)!.slice(0, 3)).toEqual(["browser_press", { url: "https://portal.example/work", label: 'textbox "Property code"', key: "Shift+Tab" }, 'Press Shift+Tab in textbox "Property code" on portal.example.']);
    expect(logged(seen)).toEqual([{ grantId: "grant-fictional-1", tool: "browser_press", origin: "https://portal.example", label: 'textbox "Property code"', class: "routine", decision: "approved", outcome: "succeeded", key: "Shift+Tab" }]);
    // Enter on a button presses it: without the click class, no key is a way round.
    expect((await f.request("browser_read", { tab_id: 1 })).isError).not.toBe(true);
    expect((await f.request("browser_press", { tab_id: 1, ref: "@e5", key: "Enter" })).content[0].text).toBe("This task does not include that browser step. Ask again with the step you need.");
    expect(dispatched(f, "press")).toHaveLength(1);
  });

  it("chooses dropdown values and logs only their hash", async () => {
    const seen = watch();
    const f = await fixture(undefined, { task: { actions: ["read", "fill"] } }); f.page(FORM_PAGE); await f.ready();
    expect((await f.request("browser_select", { tab_id: 1, ref: "@e2", values: ["-date", "name"] })).isError).not.toBe(true);
    expect(dispatched(f, "select")).toEqual([["select", "--ref", "@e2", "--value=-date", "--value=name", "--session", "owned", "--tab-id", "1"]]);
    expect(logged(seen)).toMatchObject([{ tool: "browser_select", outcome: "succeeded", valuesHash: sha256(JSON.stringify(["-date", "name"])) }]);
    expect(JSON.stringify(seen)).not.toContain("name\"]");
  });

  it("downloads into the task's private folder at a path RealBud chose, with a receipt whose hash matches the bytes", async () => {
    const seen = watch();
    const f = await fixture(undefined, { task: { actions: ["read", "download"] } }); f.page(FORM_PAGE); await f.ready();
    const bytes = Buffer.from("%PDF-1.7\nFictional statement for September\n"); f.download(bytes);
    const result = await f.request("browser_download", { tab_id: 1, ref: "@e3" });
    expect(result.isError).not.toBe(true);
    const receipt = JSON.parse(result.content[0].text).downloaded;
    expect(receipt).toEqual({ name: "Fictional statement.pdf", size: bytes.length, sha256: sha256(bytes), contentType: "application/pdf" });
    const [command] = dispatched(f, "download"); const out = command[command.indexOf("--out") + 1];
    expect(out.startsWith(join(f.workroom, "incoming"))).toBe(true);
    const saved = join(f.workroom, "downloads", receipt.name);
    expect(sha256(await readFile(saved))).toBe(receipt.sha256);
    if (process.platform !== "win32") expect((await stat(saved)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(f.workroom, "incoming"))).toEqual([]);
    expect(logged(seen)).toMatchObject([{ tool: "browser_download", outcome: "succeeded", download: receipt }]);
    // A second download of the same name never replaces the first.
    await f.request("browser_read", { tab_id: 1 });
    expect(JSON.parse((await f.request("browser_download", { tab_id: 1, ref: "@e3" })).content[0].text).downloaded.name).toBe("Fictional statement (2).pdf");
  });

  it("uploads only a granted file, resolved and re-verified by RealBud", async () => {
    const seen = watch(); const bytes = Buffer.from("fictional lease, version 1");
    const f = await fixture(undefined, { task: { actions: ["read", "upload"], files: [{ name: "fictional-lease.pdf", bytes }], extraUploads: [{ name: "fictional-missing.pdf", sha256: sha256("gone") }] } });
    f.page(FORM_PAGE); await f.ready();
    const refused = await f.request("browser_upload", { tab_id: 1, ref: "@e4", file: "../../fictional-other.pdf" });
    expect(refused.content[0].text).toBe("Only files given to this task can be uploaded. Ask the person to add the file to the task.");
    const asked = f.approve.mock.calls.length;
    expect((await f.request("browser_upload", { tab_id: 1, ref: "@e4", file: "fictional-missing.pdf" })).content[0].text).toMatch(/missing or has changed\. Nothing was uploaded/);
    expect(f.approve.mock.calls.length).toBe(asked);
    expect(dispatched(f, "upload")).toHaveLength(0);
    expect((await f.request("browser_upload", { tab_id: 1, ref: "@e4", file: "fictional-lease.pdf" })).isError).not.toBe(true);
    const [command] = dispatched(f, "upload");
    expect(command[command.indexOf("--file") + 1]).toBe(join(f.workroom, "uploads", "fictional-lease.pdf"));
    expect(f.uploaded).toEqual([bytes]);
    expect(logged(seen)).toMatchObject([{ tool: "browser_upload", outcome: "succeeded", upload: { fileIdHash: sha256("fictional-lease.pdf"), sha256: sha256(bytes) } }]);
    // A granted file changed on disk is not the file the person gave.
    await writeFile(join(f.workroom, "uploads", "fictional-lease.pdf"), "fictional lease, version 2");
    await f.request("browser_read", { tab_id: 1 });
    expect((await f.request("browser_upload", { tab_id: 1, ref: "@e4", file: "fictional-lease.pdf" })).content[0].text).toMatch(/missing or has changed/);
    expect(dispatched(f, "upload")).toHaveLength(1);
  });

  it("asks once, with the payment's facts, before Enter submits a payment form", async () => {
    const f = await fixture(undefined, { rules: [{ key: "portal:read:portal.example", decision: "allow" }, { key: "portal:prefill:portal.example", decision: "allow" }], task: { actions: ALL } });
    f.page(PAY_FORM); await f.ready();
    expect(f.approve).not.toHaveBeenCalled();
    const result = await f.request("browser_press", { tab_id: 1, ref: "@e3", key: "Enter" });
    expect(result.isError).not.toBe(true);
    const [tool, , summary, , projection] = f.approve.mock.calls.at(-1)!;
    expect(tool).toBe("browser_press");
    expect(summary).toBe("Pay AUD 480.00 to Fictional Plumbing Pty Ltd (reference INV-FICTIONAL-7) by pressing Enter in 'Amount' on portal.example. This approval is for this one payment and expires in 2 minutes.");
    expect(projection).toEqual({ fence: { surface: "portal-submit", origin: "portal.example", ruleOffer: null }, approvalPolicy: "once" });
    expect(dispatched(f, "press")).toHaveLength(1);
    expect(await f.approvals.list()).toMatchObject([{ decision: "approved", outcome: "unverified", kind: "pay", control: { label: "Amount" } }]);
  });

  it("refuses when a routine key would now submit a payment after the page changed", async () => {
    const f = await fixture(undefined, { task: { actions: ALL } }); f.page('@e1 textbox "Amount"'); await f.ready();
    f.approve.mockImplementationOnce(async () => { f.page(PAY_FORM.replace("@e3", "@e1").replace('@e1 button "Pay now"', '@e9 button "Pay now"')); return true; });
    const result = await f.request("browser_press", { tab_id: 1, ref: "@e1", key: "Enter" });
    expect(result.isError).toBe(true); expect(result.content[0].text).toBe("The control changed while waiting for review. Read the page and prepare a new step.");
    expect(dispatched(f, "press")).toHaveLength(0);
  });

  it("never replays a payment whose Enter had an unknown result, even through its Pay button", async () => {
    const f = await fixture(undefined, { task: { actions: ALL } }); f.page(PAY_FORM); await f.ready(); f.unknown();
    expect((await f.request("browser_press", { tab_id: 1, ref: "@e3", key: "Enter" })).isError).toBe(true);
    expect(dispatched(f, "press")).toHaveLength(1);
    expect(await f.approvals.list()).toMatchObject([{ decision: "approved", outcome: "unknown" }]);
    await f.broker.released(); f.known();
    const next = await f.start();
    await f.request("browser_borrow", { tab_id: 1 }, 101, next); await f.request("browser_read", { tab_id: 1 }, 102, next);
    const asked = f.approve.mock.calls.length;
    const retry = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" }, 103, next);
    expect(retry.content[0].text).toMatch(/unknown result\. Check the site yourself/);
    expect(f.approve.mock.calls.length).toBe(asked); expect(dispatched(f, "click")).toHaveLength(0);
  });
});

// The grant is the only path: a saved job's own (`legacy-job`) or a task's,
// and tools/list is exactly the grant's action classes.
const NEEDS: ReadonlyArray<[string, BrowserActionClass]> = [
  ["browser_tabs", "read"], ["browser_borrow", "read"], ["browser_read", "read"], ["browser_navigate", "navigate"], ["browser_fill", "fill"],
  ["browser_click_semantic", "click"], ["browser_press", "keys"], ["browser_select", "fill"], ["browser_download", "download"], ["browser_upload", "upload"], ["browser_release", "read"],
];
const TASK_ONLY = ["browser_press", "browser_select", "browser_download", "browser_upload"];
describe("explicit grants and exact tool lists", () => {
  const combos = (items: readonly string[]): string[][] => items.reduce<string[][]>((all, item) => [...all, ...all.map(set => [...set, item])], [[]]);
  const taskGrant = (actions: BrowserActionClass[], files: number): BrowserTaskGrant => parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: "grant-fictional-table", runId: "run-1", route: "ask",
    request: { text: "Fictional task", sha256: sha256("Fictional task") }, sites: ["portal.example"], browser: { id: null, accountMarker: null },
    actions, consequential: "ask-each", uploads: files ? [{ name: "fictional-lease.pdf", sha256: "b".repeat(64) }] : [], expiresAt: null, budget: null });
  async function listed(grant: BrowserTaskGrant, capabilities: string[] = ["portal-read"]) {
    const root = privateTempRoot(join(tmpdir(), "rb-browser-tools-")); cleanup.push(() => removeFixture(root));
    const runtime = new BrowserRuntime({ root, command: async () => ({}), executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
    const broker = await startBrowserBroker({ runtime, grant, threadId: "thread-1", runId: "run-1", context: { allowedOrigins: ["portal.example"], capabilities: capabilities as never },
      approvals: new BrowserApprovalStore({ file: join(root, "approvals.json") }), isActive: () => true, approve: async () => false, assertCapability: () => {} });
    let id = 0;
    const rpc = async (method: string, params: BrowserJson) => (await (await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: broker.descriptor.headers[0].value },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json() as { result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } }).result;
    try {
      const names = (await rpc("tools/list", {})).tools!.map(tool => tool.name);
      // A tool it does not list is also unavailable to call.
      const hidden = NEEDS.map(([tool]) => tool).find(tool => !names.includes(tool));
      const refused = hidden ? await rpc("tools/call", { name: hidden, arguments: {} }) : null;
      return { names, refused };
    } finally { broker.close(); await broker.released(); }
  }

  it("refuses to open a browser without an explicit grant", async () => {
    const root = privateTempRoot(join(tmpdir(), "rb-browser-nogrant-")); cleanup.push(() => removeFixture(root));
    const runtime = new BrowserRuntime({ root, command: async () => ({}), executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
    await expect(startBrowserBroker({ runtime, threadId: "thread-1", runId: "run-1", context: { allowedOrigins: ["portal.example"], capabilities: ["portal-read"] },
      isActive: () => true, approve: async () => false, assertCapability: () => {} } as unknown as Parameters<typeof startBrowserBroker>[0])).rejects.toThrow("This browser work has no saved permission, so nothing was opened. Start it again.");
  });

  it("lists exactly the grant's action classes for every combination, and the worker is told the same list", async () => {
    let checked = 0;
    for (const set of combos(ALL)) {
      for (const files of set.includes("upload") ? [0, 1] : [0]) {
        const grant = taskGrant(set as BrowserActionClass[], files);
        const expected = NEEDS.filter(([tool, needs]) => set.includes(needs) && (tool !== "browser_upload" || files > 0)).map(([tool]) => tool);
        const { names, refused } = await listed(grant);
        expect(names, set.join("+") || "no classes").toEqual(expected);
        expect(names).toEqual(browserToolsFor(grant));
        expect(names).toEqual(grantedBrowserTools(grant, true));
        if (refused) expect(refused.content![0].text).toBe("This browser tool or its arguments are not available.");
        checked += 1;
      }
    }
    expect(checked).toBe(256 + 128);
    // The example that matters: a download-only task can download and nothing else.
    expect((await listed(taskGrant(["download"], 0))).names).toEqual(["browser_download"]);
    expect((await listed(taskGrant(["read", "download"], 0))).names).not.toContain("browser_fill");
  }, process.platform === "win32" ? 600_000 : 60_000);

  it("gives a saved job its own grant: today's tools for its capabilities, never the newer ones", async () => {
    for (const capabilities of combos(["portal-read", "portal-prefill", "portal-submit"])) {
      const grant = legacyBrowserGrant({ runId: "run-1", allowedOrigins: ["portal.example"], capabilities });
      expect(grant.origin).toBe("legacy-job");
      const { names } = await listed(grant, capabilities.length ? capabilities : ["portal-read"]);
      expect(names).toEqual(grantedBrowserTools({ actions: legacyBrowserActions(capabilities), uploads: [] }, false));
      expect(names.filter(tool => TASK_ONLY.includes(tool))).toEqual([]);
    }
    // Even with every class, a saved job's own grant never lists the newer tools.
    const every = parseBrowserTaskGrant({ ...legacyBrowserGrant({ runId: "run-1", allowedOrigins: ["portal.example"], capabilities: ["portal-read"] }), actions: ALL });
    expect((await listed(every)).names).toEqual(["browser_tabs", "browser_borrow", "browser_read", "browser_navigate", "browser_fill", "browser_click_semantic", "browser_release"]);
  });

  it("borrows only from the browser the task was started with", async () => {
    const other = await fixture(undefined, { task: { actions: ["read"], browserId: "fictional-other-browser" } });
    const refused = await other.request("browser_borrow", { tab_id: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe("This tab is in a different browser from the one this task was started with, so Bud did not borrow it. Start the task again with the browser you want Bud to use.");
    expect(other.approve).not.toHaveBeenCalled();
    expect(other.calls.some(args => args[0] === "tab" && args[1] === "borrow")).toBe(false);
    // The browser selected when it started ("work" in this fixture) borrows as usual.
    const same = await fixture(undefined, { task: { actions: ["read"], browserId: "work" } });
    expect((await same.request("browser_borrow", { tab_id: 1 })).isError).not.toBe(true);
    expect(same.calls.filter(args => args[0] === "tab" && args[1] === "borrow")).toHaveLength(1);
  });
});

// Security review of 8ce3e6c9: a link's address and the tab's query carry tokens. Neither reaches what the model reads,
// an approval card's params (also written to the thread's event log), the run's evidence, or the learned-path record.
// Security review of 21be00b9: a card shows the record ids in its page path (approvalPath); evidence keeps the origin only.
describe("addresses stay out of what is read, shown and kept", () => {
  it("never shows a link's address or the tab's query, and keeps every path out of evidence", async () => {
    const seen: BrowserDecisionEvent[] = []; const stop = onBrowserDecision(event => seen.push(event)); cleanup.push(async () => stop());
    const root = privateTempRoot(join(tmpdir(), "rb-broker-evidence-")); cleanup.push(() => removeFixture(root));
    const evidence = new PortalEvidenceStore({ file: join(root, "evidence.json") });
    const f = await fixture(undefined, { task: { actions: ["read", "navigate", "click", "keys"] }, evidence });
    f.url("https://portal.example/tenants/0f8fad5b-d9cb-469f-a165-70867728950e?token=SYNTHETIC-TAB-TOKEN&session=SYNTHETIC-TAB-SESSION");
    f.page('@native-ax 1\nrootwebarea\n  @e1 link "foo url=" url="/tenants?token=SYNTHETIC-LINK-TOKEN&session=SYNTHETIC-LINK-SESSION"\n  @e2 textbox "Reference" value=""');
    await f.request("browser_borrow", { tab_id: 1 });
    const read = await f.request("browser_read", { tab_id: 1 });
    expect(read.content[0].text).toContain('@e1 link \\"foo url=\\"');
    for (const [name, args] of [["browser_click_semantic", { ref: "@e1" }], ["browser_press", { ref: "@e2", key: "Tab" }], ["browser_navigate", { url: "https://portal.example/tenants?token=SYNTHETIC-NAV-TOKEN" }]] as const) {
      await f.request("browser_read", { tab_id: 1 });
      expect((await f.request(name, { tab_id: 1, ...args })).isError, name).not.toBe(true);
    }
    const steps = await evidence.steps("grant-fictional-1");
    // No mapped pack declares these routes, so learned-path evidence keeps the origin only.
    expect(steps.map(step => [step.tool, step.label, step.path])).toEqual([["click", "foo url=", "https://portal.example"], ["press", "Reference", "https://portal.example"], ["navigate", "", "https://portal.example"]]);
    const cardUrls = f.approve.mock.calls.map(call => (call[1] as { url?: string }).url);
    expect(new Set(cardUrls)).toEqual(new Set(["https://portal.example/tenants/0f8fad5b-d9cb-469f-a165-70867728950e", "https://portal.example/tenants"])); expect(cardUrls.at(-1)).toBe("https://portal.example/tenants");
    expect(f.approve.mock.calls.at(-1)![2]).toBe("Open portal.example/tenants in this job's borrowed tab.");
    expect(JSON.stringify(f.approve.mock.calls)).not.toMatch(/SYNTHETIC/);
    const kept = JSON.stringify({ read, seen, steps, kept: await readFile(join(root, "evidence.json"), "utf8") });
    expect(kept).not.toMatch(/SYNTHETIC|0f8fad5b|\/tenants/);
    expect(seen.filter(event => event.action).map(event => event.action!.origin)).toEqual(["https://portal.example"]);
    expect(seen.map(event => event.entry.note)).toContain("Opened a page on portal.example.");
  });
});

// Security review of 21be00b9 (approval-ui-integrity, authorization-classification-bypass).
describe("an approval is for the record and control its card showed", () => {
  const clicks = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(a => a[0] === "click").length;
  const RECORD = "https://portal.example/tenants/0f8fad5b-d9cb-469f-a165-70867728950e/remove";
  const DELETE_PAGE = 'Are you sure you want to delete Fictional Tenant?\n@e1 button "Delete"';

  it("shows the record on the card and presses nothing when the tab moves to another record while it waits", async () => {
    const f = await fixture(); f.url(RECORD); f.page(DELETE_PAGE); await f.ready();
    f.approve.mockImplementationOnce(async () => { f.url(RECORD.replace("0f8fad5b-d9cb-469f-a165-70867728950e", "7c9e6679-7425-40de-944b-e07fc1f90ae7")); return true; });
    const result = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" });
    expect((f.approve.mock.calls.at(-1)![1] as { url: string }).url).toBe(RECORD);
    expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(/changed after approval\. Nothing was pressed/);
    expect(clicks(f)).toBe(0);
    expect(await f.approvals.list()).toMatchObject([{ decision: "changed", outcome: "not-dispatched", url: RECORD }]);
  });

  it("presses nothing when the tab moves to another record while an ordinary step waits", async () => {
    const f = await fixture(); f.url("https://portal.example/tenants/1042"); f.page('@e1 button "Show details"'); await f.ready();
    f.approve.mockImplementationOnce(async () => { f.url("https://portal.example/tenants/1043"); return true; });
    const result = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" });
    expect((f.approve.mock.calls.at(-1)![1] as { url: string }).url).toBe("https://portal.example/tenants/1042");
    expect(result.isError).toBe(true); expect(clicks(f)).toBe(0);
  });

  it("classifies the whole name: a control named past url= is not the harmless label it shows", async () => {
    const f = await fixture(); f.page('@e1 button "Show details url= Delete all tenants"'); await f.ready();
    const asked = f.approve.mock.calls.length;
    const result = await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" });
    expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(/could not confirm the item it changes/);
    expect(f.approve.mock.calls.length).toBe(asked); expect(clicks(f)).toBe(0);
    f.page('@e1 button "Show details url= extra"'); await f.request("browser_read", { tab_id: 1 });
    expect((await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" })).isError).not.toBe(true);
    const [, params, summary, , projection] = f.approve.mock.calls.at(-1)!;
    expect(summary).toContain("unusual text"); expect(projection).toMatchObject({ approvalPolicy: "once" });
    expect(JSON.stringify(params)).not.toContain("extra");
  });
});

// Security review of b7fceb50 (sensitive-data-exposure), and the reviews of its masked log path after it: the record path
// a card shows (approvalPath) may hold a name, an email or a record id, in any spelling. It stays on this computer's card
// and the private approval record; the thread's event log, decision events and evidence keep the page's origin only, and
// the model, the phone relay and website receipts never see it.
describe("a card's record path stays on the local card and approval record", () => {
  const PRIVATE = /jane|smith|000048213|t\/42|%6A|SYNTHETIC|\/owners|\/tenants/i;
  const ROWS: ReadonlyArray<[string, string]> = [
    ["https://portal.example/tenants/jane.doe@example.com/TEN-2026-000048213/remove", "https://portal.example/owners/jane.doe@example.com/OWN-2026-000048213/statement"],
    ["https://portal.example/owners/jane-smith/remove", "https://portal.example/owners/jane-smith/statement"],
    ["https://portal.example/t/42/remove", "https://portal.example/t/42/statement"],
    ["https://portal.example/tenants/%6A%61ne%20smith/remove", "https://portal.example/owners/%6A%61ne%20smith/statement"],
    ["https://portal.example\\owners\\jane-smith\\remove", "https://portal.example\\owners\\jane-smith\\statement"],
    ["HTTPS://PORTAL.EXAMPLE:443/Owners/Jane-Smith/remove?name=jane#smith", "HTTPS://PORTAL.EXAMPLE/Owners/Jane-Smith/statement?name=jane"],
  ];

  it.each(ROWS)("shows %s on the card and keeps it in the record, and nowhere else", async (record, statement) => {
    const seen: BrowserDecisionEvent[] = []; const stop = onBrowserDecision(event => seen.push(event)); cleanup.push(async () => stop());
    const root = privateTempRoot(join(tmpdir(), "rb-broker-record-path-")); cleanup.push(() => removeFixture(root));
    const evidence = new PortalEvidenceStore({ file: join(root, "evidence.json") });
    const f = await fixture(undefined, { task: { actions: ["read", "navigate", "click"] }, evidence });
    f.url(record.includes("?") ? record : `${record}?session=SYNTHETIC-SESSION`); f.page('Are you sure you want to delete Fictional Tenant?\n@e1 button "Delete"'); await f.ready();
    // Denied, then approved and pressed, then a page opened: what each returns to the model is checked below.
    f.approve.mockResolvedValueOnce(false);
    const results = [await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" })];
    await f.request("browser_read", { tab_id: 1 });
    results.push(await f.request("browser_click_semantic", { tab_id: 1, ref: "@e1" }));
    await f.request("browser_read", { tab_id: 1 });
    results.push(await f.request("browser_navigate", { tab_id: 1, url: statement.includes("?") ? statement : `${statement}?session=SYNTHETIC-NAV` }));
    expect(results.map(result => result.isError === true)).toEqual([true, false, false]);

    // This computer's card and the private approval record show the record, normalised once (approvalUrl).
    const recordUrl = approvalUrl(record), target = new URL(statement);
    const calls = f.approve.mock.calls as unknown as Array<[string, BrowserJson, string, AbortSignal, { fence: unknown; approvalPolicy?: string }]>;
    const cards = calls.map(([tool, params, summary, , projection]) => ({ tool, params, summary, projection, card: browserApprovalCardFrom(params) }));
    const deleted = cards.find(card => card.card)!; const opened = cards.find(card => card.tool === "browser_navigate")!;
    expect(deleted.params.url).toBe(recordUrl); expect(deleted.card!.page).toBe(recordUrl.replace("https://", ""));
    expect(opened.params.url).toBe(approvalUrl(target));
    expect(opened.summary).toBe(`Open ${target.hostname}${approvalPath(target)} in this job's borrowed tab.`);
    expect((await f.approvals.list()).map(row => row.url)).toEqual([recordUrl, recordUrl]);
    expect(JSON.stringify(cards)).not.toMatch(/SYNTHETIC/);

    // The thread's event log (each card as the host emits it) keeps the page's origin only.
    ensureDirs();
    const bus = new EventBus(); const thread = `thread-record-path-${ROWS.findIndex(row => row[0] === record)}`;
    for (const { tool, params, summary, projection, card } of cards) {
      bus.publish({ eventId: `ev-${tool}`, provider: "hermesAgent", threadId: thread, createdAt: new Date(0).toISOString(), type: "request.opened",
        requestType: "permission", tool, params, summary, fence: projection.fence as never, ...(card ? { browserApproval: card, approvalPolicy: "once" as const } : {}) });
    }
    const log = (await readFile(join(EVENTS_DIR, `${thread}.ndjson`), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { params: { url?: string }; summary: string; browserApproval?: { page?: string } });
    expect(JSON.stringify(log)).not.toMatch(PRIVATE);
    expect(log.map(event => event.params.url).filter(Boolean).every(url => url === "https://portal.example")).toBe(true);
    expect(log.some(event => event.browserApproval && event.browserApproval.page === undefined)).toBe(true);
    expect(log.map(event => event.summary)).toContain("Open portal.example in this job's borrowed tab.");

    // What the model reads, decision events, the run's evidence, the phone relay and a website receipt never hold it.
    const messages = [{ id: "card", role: "bot", kind: "options", at: 1, card: { title: "Approval needed", subtitle: opened.summary, options: ["Allow", "Deny"], browserApproval: deleted.card } },
      { id: "reply", role: "bot", kind: "text", text: "The tenant was removed.", at: 2 }];
    const phone = { productBud: () => ({ threadId: "bud", busy: false }), activePath: () => messages } as unknown as Store;
    const relayed = [buildHandoffPayload(phone, { mode: "summary" }), buildHandoffPayload(phone, { mode: "result" })];
    expect(relayed.every(item => item.ok)).toBe(true);
    const steps = await evidence.steps("grant-fictional-1");
    expect(steps.map(step => step.path)).toEqual(["https://portal.example", "https://portal.example"]);
    const kept = JSON.stringify({ results, seen, steps, evidence: await readFile(join(root, "evidence.json"), "utf8"), relayed,
      receipt: websiteRunReceipt({ id: "run-1", status: "awaiting-approval", detail: opened.summary } as never) });
    expect(kept).not.toMatch(PRIVATE);
  });
});
