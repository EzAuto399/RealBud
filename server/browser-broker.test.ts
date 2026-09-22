import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserRuntime, type BrowserJson } from "./browser-runtime.ts";
import { startBrowserBroker, jobBrowserUrl, observationRefs, browserLoginFields, onBrowserDecision, type BrowserBroker, type BrowserDecisionEvent } from "./browser-broker.ts";
import { BrowserApprovalStore } from "./browser-authority.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import type { BrowserCheckpoint } from "../shared/browser.ts";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(checkpoint?: BrowserCheckpoint, job: { capabilities?: Array<"portal-read" | "portal-prefill" | "portal-submit">; rules?: Array<{ key: string; decision: "allow" | "deny" }> } = {}) {
  const root = privateTempRoot(join(tmpdir(), "rb-browser-broker-")); cleanup.push(() => removeFixture(root));
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
    return { ok: true };
  };
  const runtime = new BrowserRuntime({ root, command, executable: async () => "/fixture/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  const operations = new ConnectedAppOperationStore({ file: join(root, "operations.json") });
  const approvals = new BrowserApprovalStore({ file: join(root, "approvals.json") });
  let clock = 1_000_000;
  const approve = vi.fn(async (..._args: unknown[]) => true);
  const start = async () => {
    const started = await startBrowserBroker({ runtime, operations, approvals, checkpoint, threadId: "thread-1", runId: "run-1", now: () => clock,
      context: { allowedOrigins: ["portal.example"], capabilities: job.capabilities ?? ["portal-read", "portal-prefill"], ...(job.rules ? { rules: job.rules } : {}) },
      isActive: () => true, approve, assertCapability: () => {} });
    cleanup.push(async () => { started.close(); await started.released(); });
    return started;
  };
  const broker = await start();
  let next = 0;
  const request = async (name: string, args: BrowserJson = {}, requestId: number = ++next, target: BrowserBroker = broker) => {
    const response = await fetch(target.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: target.descriptor.headers[0].value }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } }) });
    if (response.status !== 200) return { isError: true, content: [{ text: `HTTP ${response.status}` }] };
    return (await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  };
  const ready = async () => { await request("browser_borrow", { tab_id: 1 }); await request("browser_read", { tab_id: 1 }); };
  return { request, ready, broker, approve, calls, operations, approvals, runtime, start, page: (text: string) => { page = text; }, url: (value: string) => { url = value; },
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
