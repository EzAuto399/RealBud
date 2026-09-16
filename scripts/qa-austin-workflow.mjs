#!/usr/bin/env node
// Real built UI + real server/persistence; scripted ACP and Cua availability.
// No actual bank, REI, credentials, model, computer-control driver or Windows VM.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { startCuaControl } = await import("../electron/cua-control.mjs");
const fixtureControl = await startCuaControl({ release: async () => {}, verify: async () => true, restore: async () => {} });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.env.QA_OUTPUT ?? join(root, "outputs/austin-validation-2026-09-10/austin-browser"));
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const fixtureRoot = mkdtempSync(join(tmpdir(), "realbud-austin-"));
const data = join(fixtureRoot, "data");
mkdirSync(data); mkdirSync(out, { recursive: true });
const fakeCli = join(root, "server/testing/fake-acp-cli.ts");
const scriptPath = join(fixtureRoot, "worker-script.json");
const dumpPath = join(fixtureRoot, "worker-dump.json");
const cuaPath = join(fixtureRoot, "cua.json");
chmodSync(fakeCli, 0o755);
writeFileSync(cuaPath, JSON.stringify({ mode: "embedded", mcpCommand: "/tmp/fictional-cua", mcpArgs: ["mcp"], mcpEnv: { CUA_DRIVER_EMBEDDED: "1" } }));
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { hermes: {
  driver: "hermesAgent", config: { cli: fakeCli }, environment: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_DUMP: dumpPath },
} } }));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${reservation.address().port}`;
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
let child, browser, page, mobile, session = "", logs = "";
const checks = [], gaps = [], runReceipts = [];
const record = (label, details = {}) => { checks.push({ label, ...details }); console.log(`PASS ${label}`); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
};
const api = async (method, path, body, token = session) => {
  const response = await fetch(base + path, { method, headers: {
    "content-type": "application/json", ...(token ? { "x-realbud-session": token } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
const stopServer = async () => {
  const previous = child; child = null;
  if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => previous.kill("SIGKILL"), 5000);
    previous.once("close", () => { clearTimeout(timer); resolve(); });
    previous.kill("SIGTERM");
  });
};
const boot = async () => {
  child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root,
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: fixtureRoot, USERPROFILE: fixtureRoot,
      REALBUD_DATA_DIR: data, REALBUD_CUA_DESCRIPTOR_PATH: cuaPath, REALBUD_CUA_TEST_READY: "1",
      ...fixtureControl.env, VITEST: "true", OMB_PORT: String(port), OMB_STATIC_DIR: join(root, "dist") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Fixture server exited ${child.exitCode}`);
    return fetch(`${base}/api/health`).then(res => res.ok, () => false);
  }, "server startup");
  session = (await api("GET", "/api/session")).body.token;
};
const bud = async () => (await api("GET", "/api/bots")).body.bots.find(bot => bot.id === "bud");
const pending = async () => {
  const bot = await bud();
  const message = bot?.messages?.find(m => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
  return message ? { threadId: bot.threadId, requestId: message.card.requestId } : null;
};
const runs = async id => (await api("GET", `/api/job-runs?jobId=${id}`)).body.runs;
const settled = async id => {
  await until(async () => (await runs(id)).some(run => !["queued", "running"].includes(run.status)), `${id} settles`);
  const run = (await runs(id))[0];
  runReceipts.push({ jobId: id, status: run.status, evidence: run.evidence });
  return run;
};
const prepare = async (id, worker = {}) => {
  writeFileSync(scriptPath, JSON.stringify({ permission: true, tool: "navigate", title: "Open REI review (simulation)",
    rawInput: { url: "https://app.reimasterapps.com.au/receipts" }, reply: "Fictional review stopped before any import.", ...worker }));
  assert.equal((await api("POST", "/api/recipes", { draft: {
    id, title: `Austin rehearsal: ${id}`, steps: ["Open the approved receipting site", "Read only; leave import and processing to Kevin"],
    allowedOrigins: ["app.reimasterapps.com.au"], capabilities: ["portal-read", "portal-prefill"], evidence: "Fictional review receipt", status: "active",
  } })).status, 201);
  assert.equal((await api("PATCH", `/api/recipes/${id}`, { planApproved: true })).status, 200);
  assert.equal((await api("PATCH", `/api/recipes/${id}`, { attach: true })).status, 200);
};
const start = async id => assert.equal((await api("POST", `/api/recipes/${id}/attend`, {})).status, 202);
const screenshot = async name => page.screenshot({ path: join(out, `${name}.png`) });
try {
  await boot();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(() => localStorage.setItem("realbud.first-run-done", "1"));
  const errors = [];
  page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  await page.goto(base); await page.getByRole("button", { name: /^Ask\b/ }).first().click();
  assert.equal((await api("POST", "/api/recipes/missing/attend", {}, "")).status, 401);
  record("Mutations without a local session are refused");

  await prepare("approval-wait"); await start("approval-wait");
  await until(async () => Boolean(await pending()), "approval request");
  const first = await pending();
  await page.getByRole("button", { name: "Allow once", exact: true }).waitFor();
  await delay(2000);
  assert.deepEqual(await pending(), first, "waiting does not create a replacement request");
  assert.equal((await runs("approval-wait"))[0].status, "running");
  assert.equal(JSON.parse(readFileSync(dumpPath, "utf8")).selectedPermissionOption, null);
  assert.equal(JSON.parse(readFileSync(dumpPath, "utf8")).env.REALBUD_CUA_CONTROL_TOKEN, undefined);
  assert.equal(JSON.parse(readFileSync(dumpPath, "utf8")).env.REALBUD_DESK_KEY, undefined);
  await screenshot("01-waiting-for-approval");
  record("Actual UI waits two seconds without granting or advancing");

  mobile = await context.newPage(); await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(base); await mobile.getByRole("button", { name: /^Ask\b/ }).first().click();
  await mobile.getByRole("button", { name: "Allow once", exact: true }).waitFor();
  await mobile.screenshot({ path: join(out, "02-second-client-approval.png") });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await settled("approval-wait");
  assert.equal(JSON.parse(readFileSync(dumpPath, "utf8")).selectedPermissionOption, "allow-once");
  await mobile.getByRole("button", { name: "Allow once", exact: true }).waitFor({ state: "hidden" });
  const replay = await api("POST", `/api/threads/${first.threadId}/respond`, { requestId: first.requestId, behavior: "allow" });
  assert.equal(replay.status, 409, "stale replay is a conflict, not a server failure");
  assert.equal((await api("POST", "/api/bots/bud/respond", { requestId: first.requestId, behavior: "allow" })).status, 409);
  const rulesBeforeReplay = (await api("GET", "/api/rules")).body;
  assert.equal((await api("POST", `/api/threads/${first.threadId}/respond`, {
    requestId: first.requestId, behavior: "allow", rule: { surface: "portal-read", origin: "app.reimasterapps.com.au" },
  })).status, 409);
  assert.deepEqual((await api("GET", "/api/rules")).body, rulesBeforeReplay, "stale request cannot save a standing rule");
  assert.equal((await runs("approval-wait")).length, 1);
  record("Clicking Allow once resolves both open browser clients; replay is refused", { replayStatus: replay.status, mobilePushTested: false });

  await prepare("approval-deny"); await start("approval-deny");
  await page.getByRole("button", { name: "Deny", exact: true }).waitFor();
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await settled("approval-deny");
  assert.equal(JSON.parse(readFileSync(dumpPath, "utf8")).selectedPermissionOption, "reject");
  record("Actual Deny button sends a rejection to the worker");

  await prepare("approval-race"); await start("approval-race");
  await until(async () => Boolean(await pending()), "racing request");
  const racing = await pending();
  const decisions = await Promise.all(["allow", "deny"].map(behavior =>
    api("POST", `/api/threads/${racing.threadId}/respond`, { requestId: racing.requestId, behavior })));
  assert.deepEqual(decisions.map(row => row.status).sort(), [200, 409]);
  await settled("approval-race");
  assert.equal((await runs("approval-race")).length, 1);
  record("Two simultaneous conflicting decisions produce one winner and one conflict");

  await prepare("approval-stop"); await start("approval-stop");
  await page.getByRole("button", { name: "Stop this turn", exact: true }).first().waitFor();
  const stoppedRequest = await pending();
  await page.getByRole("button", { name: "Stop this turn", exact: true }).first().click();
  const stopped = await settled("approval-stop");
  assert.equal(stopped.status, "cancelled");
  const stoppedReplay = await api("POST", `/api/threads/${stoppedRequest.threadId}/respond`, { requestId: stoppedRequest.requestId, behavior: "allow" });
  assert.equal(stoppedReplay.status, 409);
  await screenshot("03-stopped"); record("Stop cancels the turn and prevents stale approval");

  await prepare("password-handover", { tool: "fill", title: "Password", rawInput: { label: "Password", url: "https://app.reimasterapps.com.au/login" }, reply: "Waiting at sign-in (scripted observation)." });
  await start("password-handover"); const authRun = await settled("password-handover");
  assert.ok(authRun.evidence.some(e => e.kind === "denied" && /never types a password/i.test(e.note)));
  record("Password-fill request is rejected at the server boundary");
  await screenshot("04-signin-gap");
  await until(async () => (await api("GET", "/api/human-handoffs")).body.handoffs[0]?.value.state === "awaiting_login", "saved sign-in handover");
  let hold = (await api("GET", "/api/human-handoffs")).body.handoffs[0];
  assert.equal((await api("POST", `/api/human-handoffs/${hold.id}/continue`, {revision:hold.revision})).status,409);
  record("Continue cannot assert authentication without a calibrated check");
  await stopServer(); await boot(); await page.reload(); await mobile.reload();
  hold = (await api("GET", "/api/human-handoffs")).body.handoffs[0];
  assert.equal(hold.value.state,"awaiting_login");
  await page.getByRole("button", {name:"Continue — check sign-in",exact:true}).waitFor();
  await screenshot("04-durable-signin");
  assert.equal((await api("POST", `/api/human-handoffs/${hold.id}/binding`, {revision:hold.revision,binding:{version:1,pid:123,windowId:456,origin:"https://other.example",accountMarker:"Fictional office",readyMarker:"Transaction history"}})).status,403);
  const bound = await api("POST", `/api/human-handoffs/${hold.id}/binding`, {revision:hold.revision,binding:{version:1,pid:123,windowId:456,origin:"https://app.reimasterapps.com.au",accountMarker:"Fictional office",readyMarker:"Transaction history"}});
  assert.equal(bound.status,200); hold=bound.body;
  await page.locator(`[data-handoff-revision="${hold.revision}"]`).waitFor();
  await page.getByRole("button", {name:"Continue — check sign-in",exact:true}).click();
  await until(async () => (await api("GET", "/api/human-handoffs")).body.handoffs[0]?.value.state === "verified", "fixture verification finishes");
  await mobile.getByRole("button", {name:"Close handover · keep job interrupted",exact:true}).waitFor();
  assert.equal((await api("POST", `/api/human-handoffs/${hold.id}/continue`, {revision:hold.revision})).status,409);
  assert.equal((await runs("password-handover"))[0].status,"interrupted");
  writeFileSync(scriptPath, JSON.stringify({permission:false, reply:"app.reimasterapps.com.au shows the fictional review ready for Kevin. No import performed."}));
  await mobile.getByLabel("Next reviewed step",{exact:true}).selectOption("1");
  await mobile.getByRole("button",{name:"Run this step only",exact:true}).click();
  await until(async () => (await api("GET", "/api/human-handoffs")).body.handoffs[0]?.value.state === "closed", "selected recovery step dispatched");
  await until(async () => (await runs("password-handover")).length===2 && !(await runs("password-handover")).some(run=>run.status==="running"), "recovery step receipt");
  const resumed = (await runs("password-handover"))[0];
  assert.deepEqual(resumed.spec.steps,["Read only; leave import and processing to Kevin"]);
  const finalHold=(await api("GET", "/api/human-handoffs")).body.handoffs[0];
  assert.equal(finalHold.value.resumedRunId,resumed.id);
  assert.equal((await api("POST",`/api/human-handoffs/${hold.id}/resume-step`,{revision:hold.revision,step:1})).status,409);
  record("Saved sign-in survives restart, synchronizes clients, and resumes only the explicitly selected step with no replay");
  gaps.push({id:"U03",expected:"Customer login and step recovery",observed:"Durable handover, Continue and selected-step recovery passed with a scripted host and worker. Customer account calibration and real Hermes/Cua workflow execution remain open."});

  await prepare("polite-signin", {permission:false, reply:"Please sign in to continue reading the bank export."});
  await start("polite-signin");
  await until(async () => (await api("GET", "/api/human-handoffs")).body.handoffs[0]?.value.state === "awaiting_login", "sign-in request without a password attempt");
  const politeHold=(await api("GET", "/api/human-handoffs")).body.handoffs[0];
  const politeStopped=await api("POST",`/api/human-handoffs/${politeHold.id}/stop`,{revision:politeHold.revision});
  assert.equal(politeStopped.status,200);
  assert.equal((await api("POST",`/api/human-handoffs/${politeHold.id}/close`,{revision:politeStopped.body.revision})).status,200);
  record("A worker asking the person to sign in opens a saved handover without attempting a password tool");

  await prepare("pay-fence", { tool: "click_semantic", title: "Pay now", rawInput: { label: "Pay now", url: "https://app.reimasterapps.com.au/pay" }, reply: "Stopped before payment." });
  await start("pay-fence"); const pay = await settled("pay-fence");
  assert.ok(pay.evidence.some(e => e.kind === "denied" && /Submit, Pay and Send stay with you/.test(e.note)));
  record("Payment click is refused without a permitted financial action");

  await prepare("restart-pending"); await start("restart-pending");
  await page.getByRole("button", { name: /^Ask\b/ }).first().click();
  await page.getByRole("button", { name: "Allow once", exact: true }).waitFor();
  const old = await pending();
  await stopServer(); await boot(); await page.reload();
  const recovered = (await runs("restart-pending"))[0];
  assert.equal(recovered.status, "interrupted");
  assert.equal((await api("POST", `/api/threads/${old.threadId}/respond`, { requestId: old.requestId, behavior: "allow" })).status, 409);
  assert.equal((await runs("restart-pending")).length, 1);
  await screenshot("05-restart-recovery");
  record("Restart marks the unfinished run interrupted and rejects its stale approval");
  gaps.push({ id: "U02", expected: "Recover a verified step checkpoint without replaying completed side effects", observed: "Generic crashes keep a run interrupted. Sign-in recovery can launch one explicitly reviewed step; unknown side effects are never replayed automatically." });

  const bankCsv = "Date,Amount,Narrative,Reference\n2026-09-10,500.00,FICTIONAL RENT,P101\n2026-09-10,500.00,FICTIONAL TRANSFER,\n";
  assert.equal((await api("GET", "/api/bank-reference", undefined, "")).status, 401);
  await page.getByRole("button", { name: /^Schedule\b/ }).first().click();
  await page.getByText("Prepare a new export", { exact: true }).click();
  await page.getByLabel("Bank CSV", { exact: true }).setInputFiles({ name: "fictional-bank.csv", mimeType: "text/csv", buffer: Buffer.from(bankCsv) });
  for (const [key, value] of Object.entries({ date: "Date", amount: "Amount", narrative: "Narrative", reference: "Reference" })) await page.getByLabel(`${key} column`, { exact: true }).fill(value);
  await page.getByLabel("Date format", { exact: true }).selectOption("YYYY-MM-DD");
  await page.getByLabel("Property reference directory", { exact: true }).fill("Fictional Unit 1 | 00127 | FICTIONAL RENT");
  await page.getByRole("button", { name: "Prepare review", exact: true }).click();
  const choices = page.getByLabel("Your decision", { exact: true });
  await choices.nth(0).selectOption("Fictional Unit 1");
  await choices.nth(1).selectOption("keep");
  await page.getByLabel("Review reason", { exact: true }).nth(0).fill("Fictional directory confirms property reference");
  await page.getByLabel("Review reason", { exact: true }).nth(1).fill("Unmatched transfer retained for review");
  await screenshot("06-bank-reference-review");
  await page.getByRole("button", { name: "Save reviewed copy", exact: true }).click();
  await page.getByRole("button", { name: "Download reviewed REI copy", exact: true }).waitFor();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download reviewed REI copy", exact: true }).click();
  const download = await downloadEvent;
  const preparedCsv = readFileSync(await download.path(), "utf8");
  assert.equal(preparedCsv, bankCsv.replace("FICTIONAL RENT,P101", "FICTIONAL RENT,00127"));
  await screenshot("07-bank-reviewed-copy");
  record("Actual Schedule UI prepares, reviews and downloads a reference-only bank copy with the source preserved");
  writeFileSync(join(out, "synthetic-bank-example.csv"), bankCsv);
  const before = (await api("GET", "/api/desk")).body;
  const preview = await api("POST", "/api/desk/import/preview", { csv: bankCsv });
  assert.ok(preview.status >= 400, "generic ledger importer must not silently accept a bank transaction format");
  const after = (await api("GET", "/api/desk")).body;
  assert.deepEqual(after.properties, before.properties);
  record("Synthetic bank-shaped CSV is refused without changing the property book", { status: preview.status, error: preview.body.error });
  gaps.push({ id: "BANK-PREP", expected: "Daily acquisition and a customer-validated REI import copy", observed: "Dedicated bank review passed with fictional data; automatic download, Austin's column mapping and actual REI acceptance remain unverified." });
  assert.deepEqual(errors, []);
  record("No browser JavaScript exceptions during the rehearsal");
  const result = { passed: true, generatedAt: new Date().toISOString(), checks, gaps, runReceipts,
    scope: { actual: ["built React UI", "local HTTP API", "server permissions", "persistent run history", "two browser clients"], simulated: ["ACP worker", "Cua availability", "bank-shaped CSV"], notTested: ["Hermes live tool use", "Cua screen control", "real bank or REI login/MFA", "Windows installer", "native Windows apps", "mobile push delivery"] } };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, openGaps: gaps.length }));
} catch (error) {
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  writeFileSync(join(out, "failure.log"), `${error.stack}\n${logs}`);
  writeFileSync(join(out, "result.json"), JSON.stringify({ passed: false, checks, gaps, error: error.message }, null, 2));
  throw error;
} finally {
  await browser?.close(); await stopServer(); await fixtureControl.close(); rmSync(fixtureRoot, { recursive: true, force: true });
}
