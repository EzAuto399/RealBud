#!/usr/bin/env node
// Built UI + real local server, fictional data. Seeds one held browser payment
// (pressed, result unverified) and one worker-custody hold whose earlier
// process group is really alive, then works both cards keyboard-only in Ask.
// No browser site, worker, model or network is used.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { primeBrowserSession, readSessionToken } from "./local-session.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.env.QA_OUTPUT ?? join(root, `outputs/recovery-cards-${new Date().toISOString().slice(0, 10)}`));
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to the installed playwright module.");
if (process.platform === "win32") throw new Error("This receipt seeds a POSIX process group.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const scratch = mkdtempSync(join(tmpdir(), "realbud-recovery-cards-"));
mkdirSync(out, { recursive: true });
const data = join(scratch, "data"); mkdirSync(data, { mode: 0o700 });
const env = { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, REALBUD_DATA_DIR: data, VITEST: "true" };
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }));
// "Earlier work": a real detached process group the server cannot account for.
const earlier = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { join } from 'node:path';
  import { BrowserApprovalStore } from './server/browser-authority.ts';
  import { recordWorkerCustody } from './server/worker-custody.ts';
  const store = new BrowserApprovalStore({ file: join(${JSON.stringify(data)}, 'browser-approvals.json') });
  const row = await store.create({
    kind: 'pay', origin: 'https://portal.fictional-strata.example', url: 'https://portal.fictional-strata.example/levies/pay',
    control: { ref: 'e12', label: 'button "Pay now"' },
    facts: [
      { name: 'recipient', value: 'Fictional Strata Pty Ltd', confirmed: true },
      { name: 'amount', value: '1240.00', confirmed: true },
      { name: 'currency', value: 'AUD', confirmed: true },
      { name: 'reference', value: 'LEVY-FICTIONAL-12', confirmed: true },
    ],
    unconfirmed: [], observationHash: 'b'.repeat(64), fingerprint: 'a'.repeat(64), effect: 'a'.repeat(64), expiresAt: Date.now() + 120000,
    summary: 'Pay AUD 1240.00 to Fictional Strata Pty Ltd',
  }, { grantId: 'grant-fictional', runId: 'run-fictional', threadId: 'thread-fictional' }, 'pending');
  await store.update(row.id, { decision: 'approved', decidedAt: Date.now(), outcome: 'unverified' });
  if (!recordWorkerCustody(${earlier.pid})) throw new Error('custody seed failed');
  console.log(row.id);
`], { cwd: root, env, encoding: "utf8" });
const finishFirstRun = async (base, headers) => {
  let state = await (await fetch(`${base}/api/onboarding`, { headers })).json();
  for (const stage of ["office-rules", "complete"]) {
    const saved = await fetch(`${base}/api/onboarding`, { method: "PUT", headers, body: JSON.stringify({ expectedScope: state.scope, expectedRevision: state.revision, stage }) });
    state = await saved.json();
    assert.equal(saved.status, 200, `Onboarding ${stage} failed: ${JSON.stringify(state)}`);
  }
};
let child, browser, page, logs = "";
const checks = [];
try {
  assert.equal(seed.status, 0, seed.stderr);
  const reservation = createServer(); await new Promise(r => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root, env: { ...env, OMB_PORT: String(port), OMB_STATIC_DIR: process.env.REALBUD_UI_DIR ?? join(root, "dist") }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => { logs += d; }); child.stderr.on("data", d => { logs += d; });
  const until = async (check, label, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await check().catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`Timed out: ${label}`);
  };
  await until(async () => (await fetch(`${base}/api/health`)).ok, "server startup");
  const token = await readSessionToken(data);
  const headers = { "content-type": "application/json", "x-realbud-session": token };
  assert.equal((await fetch(`${base}/api/browser/held`)).status, 401); checks.push("held list refused without session");
  await finishFirstRun(base, headers);

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await primeBrowserSession(context, base, token);
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  /** Keyboard only: Tab until the named button has focus, then press Enter. */
  const press = async name => {
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(n => document.activeElement?.tagName === "BUTTON" && document.activeElement.textContent.trim() === n, name)) {
        await page.keyboard.press("Enter"); return;
      }
    }
    throw new Error(`Could not reach "${name}" by keyboard`);
  };
  await page.goto(base);
  await page.getByRole("button", { name: /^Work\b/ }).first().focus(); await page.keyboard.press("Enter");

  const step = page.getByRole("region", { name: "Check a step on portal.fictional-strata.example" });
  const custody = page.getByRole("region", { name: "Earlier work may still be running" });
  await step.waitFor(); await custody.waitFor();
  for (const text of ["Bud isn't sure this happened. Check portal.fictional-strata.example, then tell Bud.", "Pay A$1,240.00 to Fictional Strata Pty Ltd?", "LEVY-FICTIONAL-12"]) assert.ok((await step.innerText()).includes(text), text);
  assert.ok((await custody.innerText()).includes("restart this computer and then let Bud check."));
  checks.push("held payment card shows payee, amount and reference", "custody notice shows one sentence and one button");
  await page.screenshot({ path: join(out, "1-both-holds.png") });
  await step.screenshot({ path: join(out, "1b-held-payment-card.png") });

  // Custody: the earlier group is alive, so the check refuses and keeps the hold.
  await press("I've restarted, check again");
  await until(async () => (await custody.innerText()).includes("Bud can still see that earlier work running"), "custody refusal");
  assert.equal((await (await fetch(`${base}/api/worker-issues/custody`, { headers })).json()).state, "held");
  checks.push("custody check refused while the earlier group is alive");
  await page.screenshot({ path: join(out, "2-custody-still-running.png") });
  process.kill(-earlier.pid, "SIGKILL");
  await until(async () => { try { process.kill(-earlier.pid, 0); return false; } catch { return true; } }, "earlier group gone");
  await press("I've restarted, check again");
  await custody.waitFor({ state: "detached" });
  checks.push("custody clears once the group is confirmed gone");

  // Held payment: the person checked the site and it did not go through.
  await press("It didn't happen");
  await step.waitFor({ state: "detached" });
  await page.getByText("Recorded as not done.", { exact: false }).waitFor();
  assert.deepEqual((await (await fetch(`${base}/api/browser/held`, { headers })).json()).steps, []);
  checks.push("'It didn't happen' releases the hold (list now empty)");
  await page.screenshot({ path: join(out, "3-holds-released.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal scroll at 1280px");
  assert.deepEqual(errors, []); checks.push("no renderer page errors");
  const receipt = { passed: true, layer: "local tests: built UI against a source server with fictional seeded records", viewport: "1280x900", checks,
    limits: ["Desktop width only (390px not checked; desktop-only product direction).", "Seeded records, not a real browser payment or worker run.", "'It happened' path is covered by unit tests, not this receipt.", "Not a packaged build or installed device."] };
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} catch (error) {
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  writeFileSync(join(out, "failure.log"), `${error.stack}\n${logs}`); throw error;
} finally {
  try { process.kill(-earlier.pid, "SIGKILL"); } catch { /* gone */ }
  await browser?.close(); child?.kill("SIGTERM"); rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
