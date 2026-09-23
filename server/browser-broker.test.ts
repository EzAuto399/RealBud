import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addBrowserTaskUpload, browserTaskWorkroom, BrowserRuntime, type BrowserJson } from "./browser-runtime.ts";
import { startBrowserBroker, jobBrowserUrl, observationRefs, browserLoginFields, onBrowserDecision, browserToolsFor, type BrowserBroker, type BrowserDecisionEvent } from "./browser-broker.ts";
import { grantedBrowserTools } from "./attended-run.ts";
import { BrowserApprovalStore, legacyBrowserGrant } from "./browser-authority.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import type { BrowserCheckpoint } from "../shared/browser.ts";
import { legacyBrowserActions, parseBrowserTaskGrant, type BrowserActionClass, type BrowserTaskGrant } from "../shared/browser-task.ts";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type Task = { actions: BrowserActionClass[]; files?: Array<{ name: string; bytes: Buffer }>; extraUploads?: Array<{ name: string; sha256: string }>; browserId?: string };
async function fixture(checkpoint?: BrowserCheckpoint, job: { capabilities?: Array<"portal-read" | "portal-prefill" | "portal-submit">; rules?: Array<{ key: string; decision: "allow" | "deny" }>; task?: Task } = {}) {
  const root = privateTempRoot(join(tmpdir(), "rb-browser-broker-")); cleanup.push(() => removeFixture(root));
  const workroom = browserTaskWorkroom(root, "grant-fictional-1");
  const uploads = [...await Promise.all((job.task?.files ?? []).map(file => addBrowserTaskUpload(workroom, file.name, file.bytes))), ...(job.task?.extraUploads ?? [])];
  const capabilities = job.capabilities ?? ["portal-read", "portal-prefill"];
  // A saved job passes its own grant explicitly, built from its capabilities exactly as the host does.
  const grant = job.task ? parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: "grant-fictional-1", runId: "run-1", route: "ask",
    request: { text: "Fictional task", sha256: sha256("Fictional task") }, sites: ["portal.example"], browser: { id: job.task.browserId ?? null, accountMarker: null },
    actions: job.task.actions, consequential: "ask-each", uploads, expiresAt: null, budget: null })
    : legacyBrowserGrant({ runId: "run-1", allowedOrigins: ["portal.example"], capabilities, ...(checkpoint ? { checkpoint } : {}) });
  let downloadBytes: Buffer = Buffer.from("%PDF-1.7\nFictional statement\n"); const uploaded: Buffer[] = [];
  let session = false; let page = '@e1 button "Show details"\n@e2 textbox "Reference"\n@e3 button "Transfer money"';
  let url = "https://portal.example/work"; let unknown = false; let scope = "user";
  const calls: string[][] = [];
  const command = async (args: string[]): Promise<BrowserJson> => {
    calls.push(args);
    if (args[0] === "status") return { daemon_version: "0.3.0", protocol_version: "1.3", browsers: [{ instance_id: "work", browser_name: "Chrome", extension_version: "0.3.0", extension_protocol_version: "1.3" }], sessions: session ? [{ session_id: "owned", browser_instance_id: "work", interaction: { borrow_confirmation: "always", request_help: "enabled" } }] : [] };
    if (args[0] === "session" && args[1] === "start") { session = true; return { session_id: "owned", browser_instance_id: "work", interaction: { borrow_confirmation: "always", request_help: "enabled" } }; }
    if (args[0] === "session" && args[1] === "stop") { session = false; return { stopped: ["owned"], failed: [], return_failures: [] }; }
    if (args[0] === "tab" && args[1] === "list") return { tabs: [{ tab_id: 1, url, title: "Private work", scope }, { tab_id: 2, url: "https://unrelated.example", title: "Private unrelated tab", scope: "user" }, ...(checkpoint ? [{ tab_id: 3, url, title: "Other account", scope: "user" }] : [])] };
    if (args[0] === "observe") return { text: page, tab_id: 1, ref_count: 3, truncated: false };
    if (unknown) throw new Error("Lost reply");
    if (args[0] === "tab" && args[1] === "borrow") scope = "agent";
    // The helper writes the capture itself, to the path RealBud chose.
    if (args[0] === "download") { await writeFile(args[args.indexOf("--out") + 1], downloadBytes); return { ok: true, suggested_filename: "Fictional statement.pdf" }; }
    if (args[0] === "upload") uploaded.push(await readFile(args[args.indexOf("--file") + 1]));
    return { ok: true };
  };
  const runtime = new BrowserRuntime({ root, command, executable: async () => "/fixture/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  const operations = new ConnectedAppOperationStore({ file: join(root, "operations.json") });
  const approvals = new BrowserApprovalStore({ file: join(root, "approvals.json") });
  let clock = 1_000_000;
  const approve = vi.fn(async (..._args: unknown[]) => true);
  const start = async () => {
    const started = await startBrowserBroker({ runtime, operations, approvals, checkpoint, threadId: "thread-1", runId: "run-1", now: () => clock, grant,
      context: { allowedOrigins: ["portal.example"], capabilities, ...(job.rules ? { rules: job.rules } : {}) },
      isActive: () => true, approve, assertCapability: () => {} });
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
  return { request, listTools, ready, broker, approve, calls, operations, approvals, runtime, start, workroom, uploaded, uploads, download: (bytes: Buffer) => { downloadBytes = bytes; },
    page: (text: string) => { page = text; }, url: (value: string) => { url = value; },
    unknown: () => { unknown = true; }, known: () => { unknown = false; }, returnTab: () => { scope = "user"; }, advance: (ms: number) => { clock += ms; } };
}
describe("saved-job browser broker", () => {
  it("uses exact HTTPS sites, rejects credentials, other origins and local addresses", () => {
    for (const url of ["http://portal.example", "https://user:pass@portal.example", "https://other.portal.example", "https://portal.example.evil.test", "https://127.0.0.1"]) expect(jobBrowserUrl(url, ["portal.example"])).toBeNull();
    expect(jobBrowserUrl("https://portal.example/work", ["portal.example"])?.origin).toBe("https://portal.example");
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
    expect(await f.approvals.list()).toMatchObject([{ decision: "approved", outcome: "succeeded", kind: "pay", control: { label: "Pay now" } }]);
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
    expect(logged(seen)).toEqual([{ grantId: "grant-fictional-1", tool: "browser_press", origin: "https://portal.example", path: "/work", label: 'textbox "Property code"', class: "routine", decision: "approved", outcome: "succeeded", key: "Shift+Tab" }]);
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
    expect(await f.approvals.list()).toMatchObject([{ decision: "approved", outcome: "succeeded", kind: "pay", control: { label: "Amount" } }]);
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
  }, 60_000);

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
