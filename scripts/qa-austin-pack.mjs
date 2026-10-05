// Austin pack on the actual local HTTP service + built React UI, fictional
// office in a throwaway home/data folder (never ~/.realbud). No mail, model,
// bank, REI or network call.
// Install the pack from Schedule → Workflow setup → Schedule lists all six
// workflows with Brisbane times and off → every checklist item opens where it
// is done → open Maintenance checks, read what it does, switch it on → it shows
// its next Brisbane run.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-austin-pack.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessionToken, primeBrowserSession } from './local-session.mjs';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud austin pack QA '));
const data = join(temp, 'data'), output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/austin-pack-2026-10-05'));
mkdirSync(data, { mode: 0o700 }); mkdirSync(output, { recursive: true });
const checks = [], errors = [], wait = ms => new Promise(r => setTimeout(r, ms));
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
// Name, Off text with its Brisbane time, in pack order.
const SIX = [
  ['Bank reference review', 'Every 2 days 8:00 am · from 2026-10-02, Brisbane time'],
  ['Weekly bills review', 'Mon 8:00 am, Brisbane time'],
  ['Morning priorities', 'Weekdays 7:30 am, Brisbane time'],
  ['Maintenance checks', 'Weekdays 8:30 am, Brisbane time'],
  ['Supplier list check', 'Every 14 days 8:15 am · from 2026-10-12, Brisbane time'],
  ['Inspection draft', 'First weekday of each month 9:00 am, Brisbane time'],
];
let child, browser, page, logs = '', failure;

try {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const base = `http://127.0.0.1:${port}`;
  const networkGuard = join(temp, 'network-guard.mjs');
  writeFileSync(networkGuard, 'globalThis.fetch=()=>{throw new Error("QA denied outbound fetch");};', { mode: 0o600 });
  child = spawn(process.execPath, ['--import', networkGuard, join(root, 'server/index.ts')], { cwd: root, env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR || join(root, 'dist')) }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-24000); });
  let ready = false; for (let i = 0; i < 150; i++) { if (child.exitCode !== null) break; try { if ((await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === child.pid) { ready = true; break; } } catch {} await wait(100); } assert.ok(ready, logs);
  const token = await readSessionToken(data);
  const request = async (path, method = 'GET', body, expected = 200, headers = {}) => { const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', 'x-realbud-session': token, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await res.json(); assert.equal(res.status, expected, `${path}: ${JSON.stringify(value)}`); return value; };

  assert.equal((await fetch(base + '/api/austin-pack')).status, 401);
  await request('/api/austin-pack/install', 'POST', {}, 415, { 'content-type': 'text/plain' });
  await request('/api/austin-pack/install', 'GET', undefined, 405);
  const before = await request('/api/austin-pack');
  assert.equal(before.installed, null); assert.equal(before.timeZone, 'Australia/Brisbane'); assert.equal(before.timeZoneFromOffice, false);
  pass('Austin pack routes need the owner session and JSON; before install nothing is installed and the pack declares Brisbane time');
  await completeFictionalOnboarding(request);

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, base, token);
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#/schedule');
  await page.getByRole('list', { name: 'Jobs', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Austin pack', exact: true }).count(), 0, 'no Austin card on Schedule before install');

  // ── 1. Install from Workflow setup ──
  await page.evaluate(() => { location.hash = 'schedule-packs'; });
  const packCard = page.getByRole('dialog').getByRole('region', { name: 'Austin pack', exact: true });
  await packCard.getByText('Each stays off until you review it and switch it on.', { exact: false }).waitFor();
  await page.screenshot({ path: join(output, '01-install-offer.png') });
  await packCard.getByRole('button', { name: 'Install the Austin pack', exact: true }).click();
  await packCard.getByRole('status').filter({ hasText: 'Six workflows are set to Brisbane time and stay off until you review each one.' }).waitFor();
  const installed = await request('/api/austin-pack');
  assert.deepEqual(installed.installed?.revision, 1);
  const loops = (await request('/api/loops')).loops;
  for (const id of ['bank-references', 'weekly-bills', 'inbound-triage', 'maintenance-review', 'rei-supplier-check', 'inspection-draft']) {
    const loop = loops.find(l => l.id === id);
    assert.deepEqual([loop.enabled, loop.nextRunAt, loop.schedule.timezone], [false, null, 'Australia/Brisbane'], id);
  }
  await page.screenshot({ path: join(output, '02-installed.png') });
  await page.getByRole('button', { name: 'Close Workflow setup', exact: true }).click();
  pass('Install from Workflow setup sets all six workflows to Brisbane time and leaves every one off');

  // ── 2. Schedule lists all six with Brisbane times and Off ──
  for (const [name, timing] of SIX) {
    const row = page.getByRole('button', { name: `Open job: ${name}`, exact: true });
    await row.waitFor();
    const text = (await row.innerText()).replace(/\s+/g, ' ');
    assert.ok(text.includes(`Off · ${timing}. Review it, then switch it on.`), `${name}: ${text}`);
    assert.ok(text.includes('Paused'), `${name} shows Paused in its timing column: ${text}`);
  }
  const checklist = page.getByRole('list', { name: 'Austin setup checklist', exact: true });
  await checklist.waitFor();
  assert.equal(await checklist.getByRole('listitem').count(), 6);
  await page.getByText('0 of 6 done. Times are Brisbane time', { exact: false }).waitFor();
  await page.screenshot({ path: join(output, '03-schedule-six-off.png'), fullPage: true });
  pass('Schedule lists all six with their Brisbane times and Off, and shows the 6-item Austin setup checklist');

  // ── 3. Every checklist item opens where it is done ──
  const item = label => checklist.getByRole('button', { name: label, exact: true });
  for (const label of ['Open Connected apps: Gmail connected', 'Open Connected apps: Redbark bank link connected']) {
    await item(label).click();
    await page.locator('#you-connected-apps').waitFor({ state: 'visible' });
    await page.goto(base + '/#/schedule'); await checklist.waitFor();
  }
  pass('Gmail and Redbark items open Workspace, Connected apps');
  for (const label of ['Open Bank reference review: Signed in to REI Cloud once', 'Open Bank reference review: REI tenant list saved']) {
    await item(label).click();
    await page.getByRole('dialog', { name: 'Bank reference review' }).waitFor();
    await page.getByRole('article', { name: 'Bank reference review details', exact: true }).getByRole('region', { name: 'What this job does' }).getByText('Not yet: REI tenant list saved', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Close Bank reference review', exact: true }).click();
  }
  await item('Open Bank reference review: REI tenant list saved').click();
  await page.getByRole('dialog', { name: 'Bank reference review' }).waitFor();
  await page.screenshot({ path: join(output, '04-bank-needs.png') });
  await page.getByRole('button', { name: 'Close Bank reference review', exact: true }).click();
  pass('REI sign-in and tenant list items open Bank reference review, which says in plain words what it still needs');
  await item('Open Maintenance checks: REI supplier list saved').click();
  await page.getByRole('region', { name: 'Maintenance checks', exact: true }).waitFor();
  await page.screenshot({ path: join(output, '05-supplier-list-on-bills.png') });
  await page.goto(base + '/#/schedule'); await checklist.waitFor();
  pass('Supplier list item opens Bills with Maintenance checks');

  // ── 4. Review W4 and switch it on: it shows its next run ──
  await item('Review Bank reference review: Each workflow reviewed and switched on').waitFor();
  await page.getByRole('button', { name: 'Open job: Maintenance checks', exact: true }).click();
  const drawer = page.getByRole('article', { name: 'Maintenance checks details', exact: true });
  const about = drawer.getByRole('region', { name: 'What this job does' });
  await about.getByText('Property manager: senders Gmail could not verify', { exact: false }).waitFor();
  await about.getByText('Not yet: REI supplier list saved', { exact: false }).waitFor();
  await page.screenshot({ path: join(output, '06-w4-review.png') });
  await drawer.getByRole('button', { name: 'Resume', exact: true }).click();
  const on = await (async () => { for (let i = 0; i < 100; i++) { const loop = (await request('/api/loops')).loops.find(l => l.id === 'maintenance-review'); if (loop.enabled && loop.nextRunAt) return loop; await wait(100); } throw new Error('W4 did not turn on'); })();
  const expected = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hour12: false }).format(on.nextRunAt);
  assert.equal(expected, '08:30');
  const next = drawer.locator('p.tabular-nums').first();
  await page.waitForFunction(element => element && /8:30/.test(element.textContent || ''), await next.elementHandle());
  const nextText = await next.innerText();
  assert.ok(!/Paused|not confirmed/i.test(nextText), nextText);
  await page.screenshot({ path: join(output, '07-w4-on-next-run.png') });
  await page.getByRole('button', { name: 'Close Maintenance checks', exact: true }).click();
  await page.getByText('1 of 6 on.', { exact: false }).waitFor();
  await item('Review Bank reference review: Each workflow reviewed and switched on').waitFor();
  pass(`After review, switching Maintenance checks on shows its next Brisbane run (${nextText}) and the checklist counts 1 of 6 on`);

  // ── 5. Repeat install keeps the office's choice; narrow layout ──
  await request('/api/austin-pack/install', 'POST', {});
  assert.equal((await request('/api/loops')).loops.find(l => l.id === 'maintenance-review').enabled, true);
  pass('A repeat install keeps Maintenance checks on and changes nothing the office chose');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/#/schedule'); await checklist.waitFor();
  await page.screenshot({ path: join(output, '08-schedule-390.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal scroll at 390px');
  assert.deepEqual(errors, []);
  pass('Schedule with the checklist fits 390x844 without horizontal scroll, and the renderer recorded no page errors');
} catch (error) { failure = error instanceof Error ? error.stack : String(error); if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(4000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), wait(4000)]); } }
  const childExited = !child || child.exitCode !== null || child.signalCode !== null;
  if (childExited) rmSync(temp, { recursive: true, force: true }); else failure ??= 'Owned child did not exit; scratch preserved.';
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure,
    layer: 'Actual local HTTP app + built UI from source; fictional empty office; not live Gmail/Redbark/REI, packaged, Windows or customer proof', checks, errors,
    limits: ['No Gmail, Redbark or REI connection exists here, so every connection item stays open; their done states are unit-tested (server/austin-pack.test.ts).',
      'The REI "signed in once" record comes from a finished REI sign-in handover; this run performs none.',
      'Fictional data; Mac browser rendering only; no packaged build, Windows or customer acceptance.'],
    failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks }, null, 2));
}
