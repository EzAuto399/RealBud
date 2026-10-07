#!/usr/bin/env node
// Watch-and-learn recorder against a REAL Chrome (docs/decisions/2026-10-07-watch-and-learn.md).
// Serves a SYNTHETIC REI-like page set on the fictional REI origin (self-signed
// cert, host-resolver mapped to loopback), records a person's trusted CDP input
// with server/learn-recorder.ts, compiles it, then drafts, confirms, publishes
// and merges the recipe in a temp store. No network, no REI, no ~/.realbud.
//
//   PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH node --experimental-strip-types scripts/qa-learn-record.mjs
//   CHROME_EXECUTABLE=... overrides the Chrome path.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LearnRecorder } from "../server/learn-recorder.ts";
import { compileLearnedSteps } from "../server/learn-compile.ts";
import { createLearnedRecipeStore, mergeLearnedRecipes } from "../server/learned-recipes.ts";
import { FICTIONAL_REI_ORIGIN, fictionalReiPack } from "../server/testing/fictional-rei-portal.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "outputs", "learn-record-2026-10-07");
const CHROME = process.env.CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HOST = new URL(FICTIONAL_REI_ORIGIN).host;
// Synthetic values typed into the page; neither may appear in any recorded or compiled output.
const TYPED_QUERY = "FictionalTypedQuery-7731";
const TYPED_PASSWORD = "FictionalPw-Secret-42!";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── synthetic portal: one HTML shell, rendered client-side by pathname ───
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>FICTIONAL REI-like portal</title>
<style>body{font:14px sans-serif;margin:0}nav{position:fixed;left:0;top:0;width:180px;padding:8px}nav a{display:block;padding:6px}main{margin-left:200px;padding:8px}
#sub{display:none;padding-left:12px}#sub.open{display:block}button,input,select{margin:6px;padding:4px}</style></head><body>
<nav aria-label="Main menu">
  <a id="nav-dashboard" href="/">Dashboard</a>
  <a id="nav-tenants" href="/customers/tenant">Tenants</a>
  <a id="nav-receipts" href="#">Receipts</a>
  <div id="sub"><a id="nav-bulk" href="/customers/importbanklink/index">Bulk receipting</a></div>
</nav>
<main id="main"></main>
<dialog id="view-dialog"><h2>Fictional Tenant Alpha</h2><p>FICTIONAL details.</p><button id="dialog-close" type="button">Close</button></dialog>
<script>
var views = {
  "/": '<h1>Dashboard</h1><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password">',
  "/customers/tenant": '<h1>Tenants</h1><label for="q">Search</label><input id="q" type="search">' +
    '<label for="status">Status</label><select id="status"><option>Any status</option><option>Active</option><option>Vacated</option></select>' +
    '<table><thead><tr><th>Tenant</th><th>Status</th><th></th></tr></thead><tbody><tr><td>Fictional Tenant Alpha</td><td>Active</td><td><button id="view" type="button">View</button></td></tr></tbody></table>',
  "/customers/importbanklink/index": '<h1>Bulk receipting</h1><table><thead><tr><th>Date</th><th>Reference</th><th>Amount</th></tr></thead>' +
    '<tbody><tr><td>2026-09-20</td><td>FT-FICTIONAL</td><td>1.00</td></tr></tbody></table><button id="process" type="button">Process Receipts</button>'
};
function render() {
  document.getElementById("main").innerHTML = views[location.pathname] || "<h1>Not here</h1>";
  var view = document.getElementById("view"); if (view) view.onclick = function () { document.getElementById("view-dialog").showModal(); };
  var process = document.getElementById("process"); if (process) process.onclick = function () { window.__processed = true; };
}
document.getElementById("dialog-close").onclick = function () { document.getElementById("view-dialog").close(); };
document.getElementById("nav-receipts").onclick = function (e) { e.preventDefault(); document.getElementById("sub").classList.toggle("open"); };
document.getElementById("nav-bulk").onclick = function (e) { e.preventDefault(); history.pushState({}, "", this.getAttribute("href")); render(); };
render();
</script></body></html>`;

// ── a minimal CDP client over Node's WebSocket ───────────────────────────
function cdp(url) {
  const socket = new WebSocket(url); let next = 0; const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(`${waiter.method}: ${message.error.message}`)) : waiter.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  return {
    async send(method, params = {}, sessionId) {
      await ready; const id = ++next;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, method }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    },
    close() { try { socket.close(); } catch { /* closed */ } },
  };
}

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); if (!ok) console.error(`FAIL ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`); };

const temp = mkdtempSync(join(tmpdir(), "rb-learn-record-"));
let chrome = null; let server = null; let driver = null;
let exitCode = 1;
try {
  // 1. Throwaway self-signed cert and the synthetic portal.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`,
    "-keyout", join(temp, "key.pem"), "-out", join(temp, "cert.pem")], { stdio: "ignore" });
  server = createServer({ key: readFileSync(join(temp, "key.pem")), cert: readFileSync(join(temp, "cert.pem")) }, (req, res) => {
    if (req.url === "/favicon.ico") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // 2. Real Chrome, private temp profile, loopback CDP, the fictional host mapped to the server.
  chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${join(temp, "profile")}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--ignore-certificate-errors", `--host-resolver-rules=MAP ${HOST}:443 127.0.0.1:${port}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = ""; const timer = setTimeout(() => reject(new Error("Chrome did not print its DevTools endpoint")), 20_000);
    chrome.stderr.on("data", chunk => { buffer += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.once("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited (${code})`)); });
  });

  // 3. Recorder opens its tab through a one-shot CDP call, like NativeBrowserRuntime.learnTarget.
  const pack = fictionalReiPack();
  const recorder = new LearnRecorder({
    async open(url) { const once = cdp(endpoint); try { const { targetId } = await once.send("Target.createTarget", { url }); return { endpoint, targetId }; } finally { once.close(); } },
  });
  let targetId = null;
  const view = await recorder.start(pack.portal, pack.origin);
  check("recorder started", view.state === "recording", view);

  // 4. A separate CDP session drives the tab with trusted input, as a person would.
  driver = cdp(endpoint);
  const { targetInfos } = await driver.send("Target.getTargets");
  targetId = targetInfos.find(info => info.type === "page" && info.url.startsWith(FICTIONAL_REI_ORIGIN))?.targetId
    ?? targetInfos.find(info => info.type === "page" && info.url !== "about:blank")?.targetId;
  const { sessionId } = await driver.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => driver.send(method, params, sessionId);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const evaluate = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  const waitFor = async (expression, what) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression).catch(() => false)) return; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const click = async selector => {
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    if (!box) throw new Error(`no visible ${selector}`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await sleep(250);
  };
  const key = async (k, code, vk) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, ...(k.length === 1 ? { text: k } : {}), windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
    await sleep(250);
  };

  await waitFor(`location.pathname === "/" && document.readyState === "complete" && !!document.getElementById("pw")`, "dashboard");
  await sleep(300);
  await click("#pw");                                            // sign-in field: typed, never kept
  await send("Input.insertText", { text: TYPED_PASSWORD }); await sleep(200);
  await click("#nav-tenants");                                   // full navigation
  await waitFor(`location.pathname === "/customers/tenant" && document.readyState === "complete" && !!document.getElementById("q")`, "tenants page");
  await sleep(300);
  await click("#q");
  await send("Input.insertText", { text: TYPED_QUERY }); await sleep(200);
  await click("#status");                                        // blurs Search (its change fires) and focuses the select
  await key("Escape", "Escape", 27);                             // close the popup if the click opened one
  await key("v", "KeyV", 86);                                    // typeahead: "Vacated"
  const selected = await evaluate(`document.getElementById("status").value`);
  check("select changed by trusted keyboard input", selected === "Vacated", selected);
  await click("#view");                                          // opens the <dialog>
  await waitFor(`document.getElementById("view-dialog").open`, "dialog");
  await click("#dialog-close");
  await waitFor(`!document.getElementById("view-dialog").open`, "dialog closed");
  await click("#nav-receipts");                                  // expands the submenu, no page change
  await click("#nav-bulk");                                      // history.pushState
  await waitFor(`location.pathname === "/customers/importbanklink/index" && !!document.getElementById("process")`, "bulk receipting");
  await click("#process");                                       // consequential: recording stops there
  await sleep(300);

  // 5. Stop, compile and assert.
  const events = await recorder.stop();
  const compiled = compileLearnedSteps(events, pack);
  const rawJson = JSON.stringify(events); const compiledJson = JSON.stringify(compiled);
  for (const [label, value] of [["typed query", TYPED_QUERY], ["password", TYPED_PASSWORD]]) {
    check(`${label} absent from raw events`, !rawJson.includes(value));
    check(`${label} absent from compiled output`, !compiledJson.includes(value));
  }
  const pages = events.filter(event => event.kind === "page").map(event => event.url);
  check("full navigation observed", pages.includes(`${FICTIONAL_REI_ORIGIN}/customers/tenant`), pages);
  check("pushState navigation observed", pages.includes(`${FICTIONAL_REI_ORIGIN}/customers/importbanklink/index`), pages);
  check("password recorded only as secret", events.some(event => event.kind === "secret") && !events.some(event => event.kind === "type" && /pass/i.test(event.field)), events.filter(e => e.kind === "secret" || e.kind === "type"));
  const steps = compiled.steps; const at = predicate => steps.findIndex(predicate);
  check("nav path Tenants", at(step => JSON.stringify(step.nav) === JSON.stringify(["Tenants"])) >= 0, steps);
  check("nav path Receipts › Bulk receipting", at(step => JSON.stringify(step.nav) === JSON.stringify(["Receipts", "Bulk receipting"])) >= 0, steps);
  const typed = steps.find(step => step.type);
  check("type step uses a {placeholder}", typed?.type.field === "Search" && /^\{[a-z][a-z0-9_]*\}$/.test(typed.type.value), typed);
  check("inputs list the placeholder", compiled.inputs.includes("search"), compiled.inputs);
  check("select recorded", steps.some(step => step.select?.field === "Status" && step.select.option === "Vacated"), steps);
  const modal = at(step => step.wait === "modal"); const dialogClick = at(step => step.click === "Close");
  check("wait:modal before the dialog click", modal >= 0 && dialogClick === modal + 1, { modal, dialogClick });
  check("stopBefore has the consequential label", compiled.stopBefore.includes("Process Receipts"), compiled.stopBefore);
  check("consequential label is not a step", !steps.some(step => step.click === "Process Receipts"));
  check("ends with read", "read" in steps.at(-1), steps.at(-1));
  check("no flags other than needs-confirm", compiled.flags.every(flag => flag.code === "needs-confirm"), compiled.flags);

  // Draft → confirm → publish → merge in a temp store (never DATA_DIR).
  const store = createLearnedRecipeStore(join(temp, "store", "learned-recipes.json"));
  let recipe = await store.create({ portal: pack.portal, title: "FICTIONAL tenant lookup", ...compiled });
  const confirm = recipe.flags.filter(flag => flag.code === "needs-confirm").map(flag => flag.label);
  if (confirm.length) recipe = await store.update(recipe.id, recipe.revision, { confirmedLabels: confirm }, pack.labels);
  check("confirmed draft has no flags", recipe.flags.length === 0, recipe.flags);
  recipe = await store.publish(recipe.id, recipe.revision, pack);
  check("published", recipe.state === "published", recipe.state);
  const merged = mergeLearnedRecipes(pack, [recipe]);
  check("merged pack carries the learned read recipe", merged.recipes[recipe.name]?.kind === "read", recipe.name);

  // 6. Receipt (synthetic data only).
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "events.json"), `${JSON.stringify(events, null, 2)}\n`);
  writeFileSync(join(OUT, "receipt.json"), `${JSON.stringify({
    topic: "learn-record", at: new Date().toISOString(), proof: "local real Chrome (headless=new) + synthetic HTTPS pages",
    chrome: execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(), portal: pack.portal, origin: pack.origin,
    passed: checks.every(item => item.ok), checks, compiled, recipe: { name: recipe.name, state: recipe.state, inputs: recipe.inputs, confirmedLabels: recipe.confirmedLabels },
    limits: ["Synthetic REI-like pages served locally on the fictional origin, never REI Cloud.", "Headless Chrome with a temp profile, not RealBud's work-browser host or a packaged app.",
      "No replay: the published recipe was merged and parsed, not run through the portal recipe runner.", "Not customer evidence."],
  }, null, 2)}\n`);
  exitCode = checks.every(item => item.ok) ? 0 : 1;
  console.log(`${exitCode ? "FAIL" : "PASS"} ${checks.filter(item => item.ok).length}/${checks.length} checks; receipt ${join(OUT, "receipt.json")}`);
  console.log(JSON.stringify(compiled.steps));
} catch (error) {
  console.error(`FAIL ${error?.stack ?? error}`);
} finally {
  driver?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill("SIGTERM"); await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), sleep(3000)]); if (chrome.exitCode === null) chrome.kill("SIGKILL"); }
  if (server) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
  rmSync(temp, { recursive: true, force: true });
  process.exit(exitCode);
}
