// Real BrowserSkill CLI + extension against fictional pages in a disposable profile.
// No personal browser profile, real account, model call or external write is used.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { addBrowserTaskUpload, BrowserRuntime, browserExecutable, browserTaskWorkroom } from "../server/browser-runtime.ts";
import { startBrowserBroker } from "../server/browser-broker.ts";
import { BrowserApprovalStore, legacyBrowserGrant } from "../server/browser-authority.ts";
import { ConnectedAppOperationStore } from "../server/connected-app-operations.ts";
import { parseBrowserTaskGrant } from "../shared/browser-task.ts";

const modulePath = process.env.PLAYWRIGHT_MODULE;
const extension = process.env.BROWSER_SKILL_EXTENSION;
if (!modulePath || !extension) throw new Error("Set PLAYWRIGHT_MODULE and BROWSER_SKILL_EXTENSION to the verified test runtimes.");
const { chromium } = await import(modulePath);
const temp = await mkdtemp(join(tmpdir(), "rb-real-browser-"));
// A later run can keep earlier receipts: REALBUD_QA_OUTPUT names a new dated folder.
const output = resolve(process.env.REALBUD_QA_OUTPUT ?? "outputs/browser-integration-2026-09-20"); await mkdir(output, { recursive: true });
let daemon: ChildProcess | undefined; let context: any; let broker: Awaited<ReturnType<typeof startBrowserBroker>> | undefined;
const root = join(temp, "private"); await mkdir(join(root, "bridge"), { recursive: true, mode: 0o700 });
const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
const address = listener.address(); assert(address && typeof address !== "string"); const port = address.port; await new Promise<void>(r => listener.close(() => r()));
const binary = await browserExecutable(); assert(binary);
let runtime: BrowserRuntime;
runtime = new BrowserRuntime({ root, startDaemon: async () => {
  daemon = spawn(binary, ["daemon", "start", "--foreground", "--port", String(port)], { env: { PATH: process.env.PATH, HOME: temp, BSK_HOME: join(root, "bridge"), BSK_AUTO_START: "0" }, stdio: "ignore" });
  for (let i = 0; i < 20; i++) { try { await runtime.command(["status"]); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error("Test daemon did not start");
} });
try {
  await runtime.connect();
  context = await chromium.launchPersistentContext(join(temp, "chrome"), { headless: true, channel: "chromium", locale: "en-AU", viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  let worker = context.serviceWorkers()[0]; if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(async (port: number) => {
    await (globalThis as any).chrome.storage.local.set({ bh_connection_enabled: true, bsk_daemon_port: port, bsk_connection_mode: "local", bsk_interaction_preferences: { confirmTabBorrow: true, requestHelpEnabled: true } });
  }, port);
  for (let i = 0; i < 40; i++) { if ((await runtime.status()).browsers.length) break; await new Promise(r => setTimeout(r, 250)); }
  const connected = await runtime.status(); assert.equal(connected.browsers.length, 1); await runtime.select(connected.browsers[0].id);
  const page = await context.newPage();
  await context.route("https://practice-bank.example/**", (route: any) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Fictional bank — RealBud test</title><style>body{font:18px system-ui;margin:50px;background:#fffbf2;color:#25231f}button,input{font:inherit;margin:10px;padding:10px}table{border-collapse:collapse}td,th{padding:12px;border:1px solid #ddd}</style><h1>Fictional office account</h1><h2>Transaction history</h2><p>This is a local test page. No real accounts or money.</p><table><tr><th>Date</th><th>Reference</th><th>Amount</th></tr><tr><td>20 September</td><td>Sample rent</td><td>$120.00</td></tr></table><button onclick="document.querySelector('#detail').textContent='Statement for September: fictional sample only'">Show statements</button><p id="detail"></p><label>Reference<input aria-label="Reference"></label><button onclick="document.body.dataset.transfer='clicked'">Transfer money</button></html>` }));
  await page.goto("https://practice-bank.example/history");
  const loginTabs = await runtime.chooseLoginTabs(["practice-bank.example"]); assert.equal(loginTabs.length, 1);
  const checkpoint = { browserId: loginTabs[0].browserId, tabId: loginTabs[0].tabId, origin: loginTabs[0].origin, accountMarker: "Fictional office account" };
  const verify = runtime.verifyLogin({ ...checkpoint, readyMarker: "Transaction history" });
  await page.getByRole("button", { name: /allow|允许/i }).first().click({ timeout: 15_000 });
  assert.equal(await verify, true); assert.equal((await runtime.status()).active, false);
  // The person selects the returned website tab before the explicit next step.
  await page.bringToFront();
  const operations = new ConnectedAppOperationStore({ file: join(temp, "receipts.json") });
  broker = await startBrowserBroker({ runtime, operations, checkpoint, runId: "fictional-run", threadId: "fictional-thread", context: { allowedOrigins: ["practice-bank.example"], capabilities: ["portal-read", "portal-prefill"] }, grant: legacyBrowserGrant({ runId: "fictional-run", allowedOrigins: ["practice-bank.example"], capabilities: ["portal-read", "portal-prefill"] }), isActive: () => true, approve: async () => true, assertCapability: () => {} });
  let seq = 0;
  const call = async (name: string, args = {}) => {
    const res = await fetch(broker!.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: broker!.descriptor.headers[0].value }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }) });
    assert.equal(res.status, 200); return (await res.json() as any).result;
  };
  const list = await call("browser_tabs"); assert(!list.isError, JSON.stringify(list));
  const tabs = JSON.parse(list.content[0].text).tabs; assert.equal(tabs.length, 1); const tabId = tabs[0].tab_id;
  const borrow = call("browser_borrow", { tab_id: tabId });
  const confirmation = page.getByRole("button", { name: /allow|允许/i }).first();
  const firstBorrowEvent = await Promise.race([borrow.then(result => ({ result })), confirmation.waitFor({ timeout: 15_000 }).then(() => ({ confirmation: true }))]);
  if ("result" in firstBorrowEvent) assert.fail(`Borrow ended before confirmation: ${JSON.stringify(firstBorrowEvent.result)}`);
  await confirmation.click();
  const borrowed = await borrow; assert(!borrowed.isError, JSON.stringify(borrowed));
  const read = await call("browser_read", { tab_id: tabId }); assert(!read.isError, JSON.stringify(read));
  const observation = JSON.parse(read.content[0].text); assert.match(observation.text, /Sample rent/);
  await writeFile(join(output, "fictional-observation.txt"), observation.text);
  const transfer = observation.text.split("\n").find((line: string) => line.includes("Transfer money")); const transferRef = transfer?.match(/@e\d+/)?.[0]; assert(transferRef, observation.text);
  assert.equal((await call("browser_click_semantic", { tab_id: tabId, ref: transferRef })).isError, true);
  assert.equal(await page.evaluate(() => document.body.getAttribute("data-transfer")), null);
  const statement = observation.text.split("\n").find((line: string) => line.includes("Show statements")); const statementRef = statement?.match(/@e\d+/)?.[0]; assert(statementRef);
  const clicked = await call("browser_click_semantic", { tab_id: tabId, ref: statementRef }); assert(!clicked.isError, JSON.stringify(clicked));
  const readback = await call("browser_read", { tab_id: tabId }); assert(!readback.isError, JSON.stringify(readback)); assert.match(readback.content[0].text, /Statement for September/);
  await page.screenshot({ path: join(output, "fictional-bank-readback.png") });
  await page.locator("h1").evaluate((node: HTMLElement) => { node.textContent = "Different private account"; });
  const changedAccount = await call("browser_read", { tab_id: tabId });
  assert.equal(changedAccount.isError, true); assert(!JSON.stringify(changedAccount).includes("Different private account"));
  broker.close(); await broker.released();
  assert.equal((await runtime.status()).active, false);
  assert.equal((await runtime.command(["status"])).sessions instanceof Array, true);
  const sessions = (await runtime.command(["status"])).sessions as unknown[]; assert.equal(sessions.length, 0);
  await writeFile(join(output, "real-browser-receipt.json"), JSON.stringify({ at: new Date().toISOString(), cli: "0.3.0", extension: "0.3.0", scope: "Disposable browser; fictional locally served bank page", connected: true, explicitBorrow: true, read: true, paymentControlBlocked: true, readback: true, verifiedLogin: true, humanSelectedReturnedTab: true, changedAccountWithheld: true, sessionsReleased: true }, null, 2));
  console.log("Real BrowserSkill + extension: fictional bank read, transfer block, statement click/read-back and release passed.");

  // ── Keys, dropdown, download capture and a granted upload (fictional pages, explicit task grant) ──
  const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const report = "Date,Reference,Amount\n20 September,Sample rent,120.00\n";
  await context.route("https://practice-forms.example/**", (route: any) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fictional-report.csv") return route.fulfill({ contentType: "text/csv", headers: { "content-disposition": "attachment; filename=fictional-report.csv" }, body: report });
    const bill = path === "/bills";
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Fictional forms — RealBud test</title><style>body{font:18px system-ui;margin:50px}input,select{font:inherit;margin:10px}</style>
<h1>${bill ? "Pay a bill" : "Fictional property forms"}</h1><p>Local test page. No real accounts or money.</p>${bill ? "<p>Payee: Fictional Plumbing Pty Ltd</p><p>Amount: AUD 480.00</p>" : ""}
<form onsubmit="event.preventDefault();document.body.dataset.submits=String(Number(document.body.dataset.submits||0)+1)">
<label>${bill ? "Amount" : "Property code"} <input aria-label="${bill ? "Amount" : "Property code"}"></label>
${bill ? "" : `<label>Sort by <select aria-label="Sort by" onchange="document.body.dataset.sort=this.value"><option value="date">Date</option><option value="name">Name</option></select></label>
<label>Lease file <input type="file" aria-label="Lease file" onchange="document.body.dataset.upload=this.files[0].name+':'+this.files[0].size"></label>`}</form>
${bill ? "" : `<a href="/fictional-report.csv" download>Download report</a>`}</html>` });
  });
  await page.goto("https://practice-forms.example/forms"); await page.bringToFront();
  const lease = Buffer.from("Fictional lease for a local RealBud test.\n");
  const grantId = "grant-fictional-slice6";
  const upload = await addBrowserTaskUpload(browserTaskWorkroom(root, grantId), "fictional-lease.txt", lease);
  const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: grantId, runId: "fictional-run-6", route: "ask",
    request: { text: "Fictional slice 6 check", sha256: sha("Fictional slice 6 check") }, sites: ["practice-forms.example"], browser: { id: null, accountMarker: null },
    actions: ["read", "navigate", "fill", "click", "download", "upload", "keys", "submit"], consequential: "ask-each", uploads: [upload], expiresAt: null, budget: 40 });
  const asks: Array<{ tool: string; summary: string }> = [];
  broker = await startBrowserBroker({ runtime, operations, approvals: new BrowserApprovalStore({ file: join(temp, "approvals.json") }), grant, runId: "fictional-run-6", threadId: "fictional-thread", context: { allowedOrigins: ["practice-forms.example"], capabilities: [] }, isActive: () => true,
    // Routine steps are approved; the fictional payment is declined, so nothing may be submitted.
    approve: async (tool: string, _params: unknown, summary: string) => { asks.push({ tool, summary }); return !summary.startsWith("Pay "); }, assertCapability: () => {} });
  const formsTab = JSON.parse((await call("browser_tabs")).content[0].text).tabs[0].tab_id;
  const borrowForms = call("browser_borrow", { tab_id: formsTab });
  await page.getByRole("button", { name: /allow|允许/i }).first().click({ timeout: 15_000 });
  assert(!(await borrowForms).isError, "forms tab borrowed");
  let observed = "";
  const refOf = async (text: string) => {
    const read = await call("browser_read", { tab_id: formsTab }); assert(!read.isError, JSON.stringify(read));
    observed = JSON.parse(read.content[0].text).text as string;
    const ref = observed.split("\n").find(line => line.includes(text) && /@e\d+/.test(line))?.match(/@e\d+/)?.[0]; assert(ref, `${text} in ${observed}`); return ref;
  };
  const pressed = await call("browser_press", { tab_id: formsTab, ref: await refOf("Property code"), key: "Enter" }); assert(!pressed.isError, JSON.stringify(pressed));
  assert.equal(await page.evaluate(() => document.body.dataset.submits), "1");
  const chosen = await call("browser_select", { tab_id: formsTab, ref: await refOf("Sort by"), values: ["name"] }); assert(!chosen.isError, JSON.stringify(chosen));
  assert.equal(await page.evaluate(() => document.body.dataset.sort), "name");
  const uploaded = await call("browser_upload", { tab_id: formsTab, ref: await refOf("Lease file"), file: "fictional-lease.txt" }); assert(!uploaded.isError, JSON.stringify(uploaded));
  assert.equal(await page.evaluate(() => document.body.dataset.upload), `fictional-lease.txt:${lease.length}`);
  const refused = await call("browser_upload", { tab_id: formsTab, ref: await refOf("Lease file"), file: "not-granted.txt" }); assert.equal(refused.isError, true);
  const downloaded = await call("browser_download", { tab_id: formsTab, ref: await refOf("Download report") }); assert(!downloaded.isError, JSON.stringify(downloaded));
  const receipt = JSON.parse(downloaded.content[0].text).downloaded;
  assert.equal(receipt.sha256, sha(report)); assert.equal(receipt.size, Buffer.byteLength(report));
  const navigated = await call("browser_navigate", { tab_id: formsTab, url: "https://practice-forms.example/bills" }); assert(!navigated.isError, JSON.stringify(navigated));
  const payEnter = await call("browser_press", { tab_id: formsTab, ref: await refOf("Amount"), key: "Enter" });
  await writeFile(join(output, "fictional-bill-observation.txt"), observed);
  assert.equal(payEnter.isError, true); assert.equal(await page.evaluate(() => document.body.dataset.submits), undefined);
  const payAsk = asks.find(ask => ask.tool === "browser_press" && ask.summary.startsWith("Pay "));
  broker.close(); await broker.released(); assert.equal((await runtime.status()).active, false);
  await writeFile(join(output, "keys-files-receipt.json"), JSON.stringify({ at: new Date().toISOString(), cli: "0.3.0", extension: "0.3.0",
    layer: "Bundled bsk 0.3.0 and BrowserSkill extension 0.3.0 in a disposable headless Chromium profile; fictional locally intercepted pages; explicit fictional task grant",
    enterSubmittedOrdinaryForm: true, selectChangedValue: true, grantedUploadAttached: true, ungrantedUploadRefused: true,
    download: { name: receipt.name, size: receipt.size, sha256MatchesServedBytes: true, contentType: receipt.contentType },
    paymentEnter: { dispatched: false, outcome: payAsk ? "one-time approval asked and declined" : payEnter.content[0].text }, sessionsReleased: true,
    limits: ["No real site, account, or personal browser profile", "Headless Chromium, not an installed person's browser", "Fact extraction from real observations is slice 4 scope; the payment step is only shown not to dispatch"] }, null, 2));
  console.log("Real BrowserSkill + extension: Enter, dropdown, granted upload, download capture with hash, and payment Enter held passed.");
} finally {
  broker?.close(); await broker?.released().catch(() => {}); await runtime.shutdown().catch(() => {});
  await context?.close(); if (daemon && daemon.exitCode === null) { daemon.kill(); await Promise.race([once(daemon, "exit"), new Promise(r => setTimeout(r, 3000))]); }
  await rm(temp, { recursive: true, force: true });
}
