// Exercises Stop during a real native-engine navigation and verifies takeover
// and cleanup. No model, real website or personal browser profile is used.
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, readdir, rm, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { admitHermesEngine, HermesBrowserTransport } from "../server/hermes-browser-transport.ts";
import { normalizedHermesSnapshot, observedFixtureRef } from "./testing/hermes-browser-observation.mjs";

if (!process.env.PLAYWRIGHT_MODULE || !process.env.CHROME_EXECUTABLE) throw new Error("Provide the reviewed Playwright module and browser executable for this test.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const bundle = await admitHermesEngine(resolve("dist-browser/hermes-native"));
const out = resolve(process.env.REALBUD_QA_OUTPUT ?? "outputs/rei-browser-first-2026-09-24/hermes-transport-native");
await mkdir(out, { recursive: false });
const root = await realpath(await mkdtemp(join(tmpdir(), "rb-engine-")));
const profile = join(root, "profile"), controllerRoot = join(root, "control");
const checks: string[] = [];
let browser: any; let transport: HermesBrowserTransport | undefined;
let otherBrowser: any; let otherTransport: HermesBrowserTransport | undefined;
let failure: unknown;
const cleanupErrors: string[] = [];
try {
  browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_EXECUTABLE, headless: true, args: ["--remote-debugging-port=0"] });
  const page = browser.pages()[0];
  await browser.route("https://fictional-stop.example/start", (route: any) => route.fulfill({ contentType: "text/html", body: '<title>Fictional work browser</title><h1>Fictional office</h1><label>Fictional search<input aria-label="Fictional search"></label><label>Fictional status<select aria-label="Fictional status"><option value="open">Open</option><option value="closed">Closed</option></select></label><button onclick="document.querySelector(\'output\').textContent=++window.count">Count fictional click</button><output>0</output><script>window.count=0</script>' }));
  await page.goto("https://fictional-stop.example/start");
  const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
  transport = new HermesBrowserTransport({ root: controllerRoot, bundle, endpoint: `http://127.0.0.1:${port}` });
  await transport.start();
  const listed = await transport.step({ kind: "tabs" });
  assert(Array.isArray(listed.tabs));
  const current = listed.tabs.find((tab: any) => tab.url === page.url()) as { tabId?: string };
  assert(current, "The owned fixture tab must be listed by the native engine");
  const id = String(current.tabId); assert.match(id, /^t[1-9]\d*$/);
  const tab = Number(id.slice(1));
  const observed = await transport.step({ kind: "read", tab }); assert.match(String(observed.snapshot), /Fictional office/);
  checks.push("Byte-admitted native engine attached to the host-owned browser and read a stable tab");
  const ref = async (label: string) => observedFixtureRef(normalizedHermesSnapshot(String((await transport!.step({ kind: "read", tab })).snapshot)), label);
  await transport.step({ kind: "fill", tab, ref: await ref("Fictional search"), value: "fictional search" });
  assert.equal(await page.getByLabel("Fictional search").inputValue(), "fictional search");
  await transport.step({ kind: "select", tab, ref: await ref("Fictional status"), values: ["closed"] });
  assert.equal(await page.getByLabel("Fictional status").inputValue(), "closed");
  await transport.step({ kind: "click", tab, ref: await ref("Count fictional click") });
  await transport.step({ kind: "press", tab, ref: await ref("Count fictional click"), key: "Enter" });
  assert.equal(await page.locator("output").textContent(), "2");
  checks.push("Observed controls remained usable for native fill, select, click and focused key input with exact readback");

  const otherProfile = join(root, "other-profile");
  otherBrowser = await chromium.launchPersistentContext(otherProfile, { executablePath: process.env.CHROME_EXECUTABLE, headless: true, args: ["--remote-debugging-port=0"] });
  const otherPage = otherBrowser.pages()[0];
  await otherBrowser.route("https://fictional-other.example/", (route: any) => route.fulfill({ contentType: "text/html", body: "<title>Fictional second work browser</title><h1>Fictional second office</h1>" }));
  await otherPage.goto("https://fictional-other.example/");
  const otherPort = (await readFile(join(otherProfile, "DevToolsActivePort"), "utf8")).split("\n")[0];
  otherTransport = new HermesBrowserTransport({ root: join(root, "other-control"), bundle, endpoint: `http://127.0.0.1:${otherPort}` });
  await otherTransport.start(); assert.notEqual(transport.session, otherTransport.session);
  const otherTabs = await otherTransport.step({ kind: "tabs" });
  assert(Array.isArray(otherTabs.tabs));
  const otherTab = otherTabs.tabs.find((entry: any) => entry.url === otherPage.url()) as { tabId: string };
  assert.match(otherTab.tabId, /^t[1-9]\d*$/);
  const otherTabNumber = Number(otherTab.tabId.slice(1));
  const otherRead = await otherTransport.step({ kind: "read", tab: otherTabNumber });
  assert.match(String(otherRead.snapshot), /Fictional second office/); assert.doesNotMatch(String(otherRead.snapshot), /Fictional search/);
  checks.push("Two native controllers used separate private browser profiles and returned the correct fictional office");

  let waitingRoute: any;
  let entered!: () => void;
  const requestEntered = new Promise<void>(resolve => { entered = resolve; });
  await browser.route("https://fictional-stop.example/slow", (route: any) => { waitingRoute = route; entered(); });
  const moving = transport.step({ kind: "navigate", tab, url: "https://fictional-stop.example/slow" });
  const lateResult = assert.rejects(moving, /ended after Stop/);
  await Promise.race([requestEntered, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Native navigation never reached the fixture")), 15_000); timer.unref(); })]);
  // Receiving this browser request proves the native navigation is dispatched
  // and unfinished, rather than merely queued in the TypeScript wrapper.
  let released = false;
  const stopping = transport.stop().then(() => { released = true; });
  assert.equal(transport.state, "stopping");
  await assert.rejects(transport.step({ kind: "read", tab }), /stopped/);
  assert.equal(released, false);
  await waitingRoute.fulfill({ contentType: "text/html", body: "<title>Fictional read completed</title><h1>Fictional result after Stop</h1>" });
  await lateResult; await stopping;
  checks.push("Stop revoked new commands during a real pending navigation; the late result was withheld");
  assert.equal(transport.state, "released");
  assert.equal(await page.title(), "Fictional read completed");
  assert.equal(page.isClosed(), false);
  checks.push("Confirmed native detach kept the work browser open for human takeover");
  assert.match(String((await otherTransport.step({ kind: "read", tab: otherTabNumber })).snapshot), /Fictional second office/);
  checks.push("Stopping the first controller left the second controller connected to its own browser");
  await assert.rejects(transport.step({ kind: "click", tab, ref: "@e1" }), /stopped/);
  await assert.rejects(transport.start(), /cannot be started/);
  checks.push("Released controller could not be reused or restarted");
  for (let attempt = 0; attempt < 30; attempt++) {
    const files = await readdir(controllerRoot);
    if (!files.some(file => file.endsWith(".sock") || file.endsWith(".pid") || file.endsWith(".port"))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const remaining = await readdir(controllerRoot);
  assert(!remaining.some(file => file.endsWith(".sock") || file.endsWith(".pid") || file.endsWith(".port")), "Native daemon control files still present after release");
  checks.push("Native daemon removed its control endpoint and PID after release");
} catch (error) { failure = error; }
finally {
  try { await transport?.stop(); } catch (error) { cleanupErrors.push(String(error)); failure ??= error; }
  try { await otherTransport?.stop(); } catch (error) { cleanupErrors.push(String(error)); failure ??= error; }
  try { await browser?.close(); } catch (error) { cleanupErrors.push(String(error)); failure ??= error; }
  try { await otherBrowser?.close(); } catch (error) { cleanupErrors.push(String(error)); failure ??= error; }
  try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(String(error)); failure ??= error; }
}
// Emit success only after all owned processes/profiles have finished cleanup.
const receipt = { at: new Date().toISOString(), layer: "Native engine transport and disposable browser on this Mac", result: failure ? "failed" : "passed", engine: { version: "0.26.0", sha256: bundle.sha256 }, checks, cleanupCompleted: cleanupErrors.length === 0, cleanupErrors,
  limits: ["Transport proof, not normal app connection UI or broker task integration", "Two isolated browser fixtures, not two-device team acceptance", "No live account, model turn or external write", "No installed Windows execution", "An action dispatched before Stop can still complete; it is not undone"], ...(failure ? { error: String(failure) } : {}) };
await writeFile(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
if (failure) throw failure;
