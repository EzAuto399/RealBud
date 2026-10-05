// Supplier list check: Bud checks REI's Suppliers list on the clock and shows
// what changed for a person to approve; nothing is applied silently, because
// this list decides who counts as a trusted sender in W4's maintenance checks.
// Turn it on in Schedule → Run now → signed out, the run waits at the "Sign in
// to REI Cloud" handover and says so in Schedule while other loops keep running
// → the person signs in and allows the download in Maintenance checks → the
// first check against the seeded list is a big drop, held with a warning until
// "Approve anyway" → a repeat check with REI unchanged ends quietly (no card)
// → REI adds FS-PAINT, removes FS-ROOF and changes FS-ELEC's address → the run
// awaits approval, Bud posts a chat card and Maintenance checks lists the
// change → Approve → W4's sender check recognises the new sender and no longer
// lists the removed one.
// Real source service + built UI on the FICTIONAL Austin demo office
// (scripts/seed-austin-demo.mjs) with the fictional REI-style portal behind the
// real browser runtime, broker and recipe runner (server/testing/w1-lab.ts).
// The person is simulated by this script.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-supplier-watch.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeBrowserSession } from './local-session.mjs';
import { startAustinDemo } from './seed-austin-demo.mjs';
import { matchSender } from '../shared/supplier-directory.ts';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT || join(root, `outputs/supplier-watch-${new Date().toISOString().slice(0, 10)}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
const demoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-supplier-watch-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [], errors = [], denied = [], shots = [];
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const WHERE = 'Bills and calendar → Maintenance checks';
let demo, browser, page, failure;

const request = (...args) => demo.request(...args);
const lab = action => request('/api/w1/lab', 'POST', { action });
const status = () => request('/api/rei-directory/status');
const until = async (read, done, label, tries = 300) => { let value; for (let i = 0; i < tries; i++) { value = await read(); if (done(value)) return value; await wait(100); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const checkRun = id => until(async () => (await request('/api/loops')).runs.find(r => r.id === id), r => r && !['queued', 'running'].includes(r.status), 'supplier check run');
const latestRun = async () => (await request('/api/loops')).runs.find(r => r.loopId === 'rei-supplier-check');
const directory = async () => (await request('/api/supplier-directory')).directory;
const suppliersPanel = () => page.getByRole('region', { name: 'Refresh supplier list from REI', exact: true });
const supplierPreview = () => suppliersPanel().getByRole('group', { name: 'REI supplier list preview', exact: true });
/** Run now through the route Schedule uses. */
async function runCheck() {
  const loop = (await request('/api/loops')).loops.find(l => l.id === 'rei-supplier-check');
  return (await request('/api/loops/rei-supplier-check/run', 'POST', { requestId: randomUUID(), expectedRevision: loop.revision }, 201)).run;
}
/** The simulated person allows every ask through the refresh's answer route (the UI's Allow). */
async function allowAll() {
  for (let i = 0; i < 300; i++) {
    const now = await status();
    if (now.run?.ask) await request(`/api/rei-directory/runs/${now.run.id}/answer`, 'POST', { requestId: now.run.ask.requestId, allowed: true });
    else if (!now.run?.working) return now;
    await wait(100);
  }
  throw new Error('The refresh kept asking.');
}
async function openMaintenance() {
  await page.goto(`${demo.base}/#/desk`);
  await page.locator('.desk-other-work > summary').click();
  await page.getByRole('group', { name: 'Other work', exact: true }).getByRole('button', { name: 'Bills and calendar', exact: true }).click();
  await page.getByRole('region', { name: 'Maintenance checks' }).waitFor();
  await suppliersPanel().waitFor();
}
async function capture(name, locator) {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await locator.scrollIntoViewIfNeeded();
    if (width === 390) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll at 390px');
    const file = `${name}-${width}.png`; await page.screenshot({ path: join(output, file), animations: 'disabled' }); shots.push(file);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

try {
  demo = await startAustinDemo({ demoRoot });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, demo.base, demo.token);
  await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === demo.base) return route.continue(); denied.push(origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  await lab('handover'); // the real sign-in handover over the fictional portal's address
  const seeded = await directory();
  assert.ok(seeded.suppliers.length > 0 && seeded.suppliers.every(s => s.reference.startsWith('FIC-')), 'seeded supplier list');

  // ── 1. Off until enabled; turn on in Schedule; Run now waits at REI sign-in and says so; other loops keep running ──
  let loop = (await request('/api/loops')).loops.find(l => l.id === 'rei-supplier-check');
  assert.deepEqual([loop.enabled, loop.available, loop.schedule.time, loop.schedule.intervalDays, loop.schedule.anchorDate, loop.nextRunAt], [false, true, '08:15', 14, '2026-10-12', null]);
  await page.goto(`${demo.base}/#/desk`);
  await page.getByRole('button', { name: /^Schedule\b/ }).first().click();
  await page.getByRole('button', { name: 'Open job: Supplier list check', exact: true }).click();
  const drawer = page.getByRole('article', { name: 'Supplier list check details', exact: true });
  await drawer.getByText("Checks REI's supplier list for added or removed suppliers and shows changes for you to approve.", { exact: true }).waitFor({ state: 'attached' });
  await drawer.getByRole('button', { name: 'Resume', exact: true }).click();
  loop = await until(async () => (await request('/api/loops')).loops.find(l => l.id === 'rei-supplier-check'), l => l.enabled && l.nextRunAt, 'loop turned on');
  await drawer.getByRole('button', { name: 'Run now', exact: true }).click();
  const first = await until(latestRun, r => r?.status === 'running' && /^Sign in to REI Cloud so Bud can check the supplier list/.test(r.detail ?? ''), 'check waits for sign-in');
  assert.match(first.detail, /^Sign in to REI Cloud so Bud can check the supplier list\. REI's sign-in page is open in the work browser; Bud carries on by itself once you're signed in \(waiting until .+\)\.$/);
  await drawer.getByRole('status').filter({ hasText: first.detail }).waitFor();
  await capture('schedule-waiting-sign-in', drawer);
  const maintenance = await request('/api/loops/maintenance-review/run', 'POST', { requestId: randomUUID(), expectedRevision: (await request('/api/loops')).loops.find(l => l.id === 'maintenance-review').revision }, 201);
  const other = await checkRun(maintenance.run.id);
  assert.ok(['completed', 'awaiting-approval', 'partial'].includes(other.status), JSON.stringify(other));
  assert.equal((await latestRun()).status, 'running');
  pass(`Supplier list check is off until enabled (fortnightly, Monday 08:15); turned on in Schedule; Run now waits at the REI sign-in handover and Schedule says "${first.detail}"; Maintenance checks still ran (${other.status})`);

  // ── 2. Sign in → the download ask waits for the person in Maintenance checks ──
  await lab('sign-in');
  await openMaintenance();
  const card = suppliersPanel().getByRole('group', { name: 'Approval for REI', exact: true });
  await card.getByText("Allow Bud to choose Export Only on REI's report?", { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  await card.getByText("Allow Bud to download REI's supplier list?", { exact: true }).waitFor();
  const asking = await until(latestRun, r => /download of REI's supplier list/.test(r?.detail ?? ''), 'Schedule shows the download ask');
  assert.equal(asking.status, 'running');
  await capture('download-ask', suppliersPanel());
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  pass(`After sign-in each per-run ask waited for the person (Export Only, then the download); Schedule said "${asking.detail}"`);

  // ── 3. First check vs the seeded list: a big drop, held with a warning until "Approve anyway" ──
  const held = await checkRun(first.id);
  assert.equal(held.status, 'awaiting-approval');
  assert.equal(held.detail, `REI returned far fewer suppliers than before — check the export before approving. Review it in ${WHERE}.`);
  await supplierPreview().getByRole('alert').getByText('REI returned far fewer suppliers than before — check the export before approving.', { exact: true }).waitFor();
  await supplierPreview().getByText(`Removed in REI · ${seeded.suppliers.length}`, { exact: true }).waitFor();
  assert.equal((await directory()).revision, seeded.revision, 'nothing saved before approval');
  await capture('big-drop-held', suppliersPanel());
  // A big drop is not saved without the person confirming it.
  const plainSave = await request(`/api/rei-directory/runs/${(await status()).run.id}/save`, 'POST', { expectedRevision: seeded.revision }, 409);
  assert.match(plainSave.error, /far fewer suppliers/);
  await supplierPreview().getByRole('button', { name: 'Approve anyway', exact: true }).click();
  await suppliersPanel().getByText('Saved the supplier list from REI.', { exact: true }).waitFor();
  let saved = await directory();
  assert.deepEqual(saved.suppliers.map(s => s.reference), ['FS-PLUMB', 'FS-ELEC', 'FS-GARDEN', 'FS-LOCK', 'FS-ROOF']);
  pass(`The first check found all ${seeded.suppliers.length} seeded suppliers gone: held with "REI returned far fewer suppliers…", refused a plain save (409), and saved only after Approve anyway (revision ${saved.revision})`);

  // ── 4. REI unchanged: the run completes quietly (seen, no card) and adds no revision ──
  const quietRun = await runCheck();
  await allowAll();
  const quiet = await checkRun(quietRun.id);
  assert.deepEqual([quiet.status, quiet.detail, typeof quiet.seenAt], ['completed', "REI's supplier list has not changed.", 'number']);
  assert.equal((await directory()).revision, saved.revision);
  pass('A repeat check with REI unchanged completed quietly (already seen, no card) and kept the saved revision');

  // ── 5. REI changes → awaiting approval, chat card, the change listed in Maintenance checks ──
  await lab('change-suppliers');
  const changeRun = await runCheck();
  await allowAll();
  const changed = await checkRun(changeRun.id);
  const cardText = 'Supplier list changed in REI: 1 added, 1 removed, 1 email changed';
  assert.deepEqual([changed.status, changed.detail], ['awaiting-approval', `${cardText} — review in ${WHERE}.`]);
  assert.deepEqual(matchSender(await directory(), 'roof@fictional-roofing.test'), { kind: 'listed', supplierRef: 'FS-ROOF' }, 'removed supplier still listed before approval');
  await page.goto(`${demo.base}/#/desk`);
  await page.getByRole('button', { name: /^Work\b/ }).first().click();
  const chatCards = page.locator('div.rounded-2xl').filter({ hasText: /^Supplier list check/ });
  const changeCard = chatCards.filter({ hasText: cardText });
  await changeCard.first().waitFor();
  assert.equal(await chatCards.count(), 3, 'cards for the sign-in wait, the held big drop and the change; none for the quiet run');
  assert.equal(await chatCards.filter({ hasText: 'Sign in to REI Cloud so Bud can check the supplier list' }).count(), 1, 'one card while it waited at REI sign-in');
  assert.equal(await chatCards.filter({ hasText: 'has not changed' }).count(), 0);
  await capture('chat-card', changeCard.first());
  await changeCard.first().getByRole('button', { name: /Open$/ }).click();
  await openMaintenance();
  const preview = supplierPreview();
  await preview.getByText("Bud's weekly check found changes in REI's supplier list. Nothing changes here until you approve.", { exact: true }).waitFor();
  await preview.getByRole('list', { name: 'Suppliers added in REI' }).getByText('FS-PAINT · Fictional Painting · paint@fictional-painting.test', { exact: true }).waitFor();
  await preview.getByRole('list', { name: 'Suppliers removed in REI' }).getByText('FS-ROOF · Fictional Roofing · roof@fictional-roofing.test will no longer count as listed', { exact: true }).waitFor();
  await preview.getByRole('list', { name: 'Supplier emails changed in REI' }).getByText('FS-ELEC · Fictional Electrical: jobs@fictional-electrical.test, invoices@fictional-electrical.test → jobs@fictional-electrical.test, billing@fictional-electrical.test', { exact: true }).waitFor();
  await preview.getByRole('button', { name: 'Dismiss', exact: true }).waitFor();
  await capture('change-to-approve', suppliersPanel());
  pass(`REI's change awaited approval: Bud posted "${cardText}" in Work (3 cards in all: the sign-in wait, the big drop and the change; none for the quiet run), and Maintenance checks listed FS-PAINT added, FS-ROOF removed and FS-ELEC's address change with Approve and Dismiss`);

  // ── 6. Approve → W4 recognises the new sender and no longer lists the removed one ──
  await preview.getByRole('button', { name: 'Approve', exact: true }).click();
  await suppliersPanel().getByText('Saved the supplier list from REI.', { exact: true }).waitFor();
  saved = await directory();
  assert.deepEqual(matchSender(saved, 'paint@fictional-painting.test'), { kind: 'listed', supplierRef: 'FS-PAINT' });
  assert.deepEqual(matchSender(saved, 'roof@fictional-roofing.test'), { kind: 'unlisted' });
  assert.deepEqual(matchSender(saved, 'billing@fictional-electrical.test'), { kind: 'listed', supplierRef: 'FS-ELEC' });
  assert.deepEqual(matchSender(saved, 'invoices@fictional-electrical.test'), { kind: 'unlisted' });
  pass(`Approve saved revision ${saved.revision}: W4's sender check lists paint@fictional-painting.test as FS-PAINT and billing@ as FS-ELEC; roof@fictional-roofing.test and the old invoices@ address are no longer listed`);

  const effects = (await lab('status')).effects;
  assert.deepEqual(effects, [], `Bud pressed nothing in REI: ${effects}`);
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  pass('Nothing pressed in the fictional REI, no renderer errors and no off-origin browser requests');
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  const logs = demo?.logs?.() ?? '';
  await demo?.stop().catch(() => {});
  rmSync(demoRoot, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ ok: !failure, at: new Date().toISOString(), checks, shots, errors, denied,
    layer: 'Real local source service and built UI on the fictional Austin demo office; real browser runtime, broker, recipe runner and sign-in handover over the fictional REI-style portal',
    limits: [
      'Fictional REI-style portal: no REI Cloud evidence. The REI export location in the pack is a placeholder until the real one is mapped.',
      'The sign-in tab is a lab stand-in that reports the portal\'s address; the real work browser tab was not opened.',
      'The person (sign-in, approvals, Approve) is simulated by this script; the desktop notification is covered by unit tests only.',
      'Runs were started with Run now; the fortnightly Monday 08:15 clock firing is covered by unit tests only.',
      'Source service only: no packaged, installed or Windows evidence.'],
    ...(failure ? { failure, serviceLog: logs.slice(-8000) } : {}) }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
