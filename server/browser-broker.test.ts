import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserRuntime, type BrowserJson } from "./browser-runtime.ts";
import { startBrowserBroker, jobBrowserUrl, observationRefs, browserLoginFields, type BrowserBroker } from "./browser-broker.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import type { BrowserCheckpoint } from "../shared/browser.ts";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(checkpoint?: BrowserCheckpoint) {
  const root = await mkdtemp(join(tmpdir(), "rb-browser-broker-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
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
  const approve = vi.fn(async () => true);
  const broker = await startBrowserBroker({ runtime, operations, checkpoint, threadId: "thread-1", runId: "run-1", context: { allowedOrigins: ["portal.example"], capabilities: ["portal-read", "portal-prefill"] }, isActive: () => true, approve, assertCapability: () => {} });
  cleanup.push(async () => { broker.close(); await broker.released(); });
  let next = 0;
  const request = async (name: string, args: BrowserJson = {}, requestId: number = ++next, target: BrowserBroker = broker) => {
    const response = await fetch(target.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: target.descriptor.headers[0].value }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } }) });
    if (response.status !== 200) return { isError: true, content: [{ text: `HTTP ${response.status}` }] };
    return (await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  };
  const ready = async () => { await request("browser_borrow", { tab_id: 1 }); await request("browser_read", { tab_id: 1 }); };
  return { request, ready, broker, approve, calls, operations, runtime, page: (text: string) => { page = text; }, url: (value: string) => { url = value; }, unknown: () => { unknown = true; }, returnTab: () => { scope = "user"; } };
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
