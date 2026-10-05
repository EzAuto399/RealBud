// REI login wait (owner design, 6 Oct 2026): a scheduled W1 bank import sits
// on REI Cloud's sign-in page until the person signs in, then carries on by
// itself; a service restart reopens the page and keeps waiting; the upload
// still waits for its own approval (denied here: nothing is ever submitted).
// The Supplier list check does the same up to its preview, stops with the plain
// mismatch message when REI is signed in to another business, and is missed at
// 18:00 when nobody signs in.
// Real source service + built UI on the FICTIONAL Austin demo office
// (scripts/seed-austin-demo.mjs), the fictional REI-style portal behind the real
// browser runtime, broker and recipe runner, and the real sign-in handover over
// a lab tab that follows the portal's address. The lab clock stands in for the
// office day; the person is simulated by this script.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-rei-login-wait.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeBrowserSession } from './local-session.mjs';
import { seed, startAustinDemo } from './seed-austin-demo.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT || join(root, `outputs/rei-login-wait-${new Date().toISOString().slice(0, 10)}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
assert.equal(seed.office.timeZone, 'Australia/Brisbane', 'the lab clock below is written in Brisbane time (UTC+10, no daylight saving)');
const demoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-rei-login-wait-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [], errors = [], denied = [], shots = [];
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
let demo, browser, context, page, failure, ownOrigins;

const request = (...args) => demo.request(...args);
const lab = (action, extra = {}) => request('/api/w1/lab', 'POST', { action, ...extra });
const clock = time => lab('clock', { at: `${demo.today}T${time}:00+10:00` });
const w1 = () => request('/api/w1/status');
const until = async (read, done, label, tries = 600) => { let value; for (let i = 0; i < tries; i++) { value = await read(); if (done(value)) return value; await wait(100); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const runs = async loopId => (await request('/api/loops')).runs.filter(r => r.loopId === loopId);
const latest = async loopId => (await runs(loopId))[0];
const settled = id => until(async () => (await request('/api/loops')).runs.find(r => r.id === id), r => r && !['queued', 'running'].includes(r.status), `run ${id}`);
/** Run now, through the route Schedule's button uses. */
async function runNow(loopId) {
  const loop = (await request('/api/loops')).loops.find(l => l.id === loopId);
  return (await request(`/api/loops/${loopId}/run`, 'POST', { requestId: randomUUID(), expectedRevision: loop.revision }, 201)).run;
}
async function restart() {
  await demo.stop();
  demo = await startAustinDemo({ demoRoot });
  ownOrigins.add(demo.base);
  await primeBrowserSession(context, demo.base, demo.token);
}
const strip = () => page.getByRole('region', { name: 'Bank import', exact: true });
const handover = () => page.getByRole('region', { name: 'Sign in to REI Cloud', exact: true });
async function openJob(name) {
  await page.goto(`${demo.base}/#/desk`);
  await page.getByRole('button', { name: /^Schedule\b/ }).first().click();
  await page.getByRole('button', { name: `Open job: ${name}`, exact: true }).click();
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
const W1_LINE = /^Sign in to REI Cloud so Bud can finish the bank import\. REI's sign-in page is open in the work browser; Bud carries on by itself once you're signed in \(waiting until 6:00 pm on [A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}\)\.$/;
const W1_REMINDER = /^Reminder: sign in to REI Cloud so Bud can finish the bank import\. Bud waits until 6:00 pm on /;
const SUPPLIER_LINE = /^Sign in to REI Cloud so Bud can check the supplier list\. /;

try {
  demo = await startAustinDemo({ demoRoot });
  await lab('handover');
  await clock('07:55');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, demo.base, demo.token);
  // A restart moves the test service to a new port; the earlier origin is still this office.
  ownOrigins = new Set([demo.base]);
  await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (ownOrigins.has(origin)) return route.continue(); denied.push(origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));

  // ── 1. The loop pulls; the person reviews; the next run waits at REI's sign-in page ──
  const pulled = await settled((await runNow('bank-references')).id);
  assert.equal(pulled.status, 'awaiting-approval', JSON.stringify(pulled));
  let now = await w1();
  assert.equal(now.run.step, 'review', JSON.stringify([now.note, now.run.attention]));
  const runId = now.run.id, batchId = now.run.fetch.batchId;
  const saved = await request(`/api/bank-reference/${batchId}`);
  const decisions = saved.value.batch.rows.map(row => {
    const ref = /FT-[A-Z0-9]+/.exec(`${row.narrative ?? ''} ${row.reference ?? ''}`)?.[0];
    const property = seed.properties.find(p => p.tenant.reiTenantRef === ref);
    assert.ok(property, `fictional tenant reference in ${row.narrative}`);
    return { rowId: row.id, action: 'assign', propertyId: property.code, reason: 'Fictional reference matches the tenant directory' };
  });
  await request(`/api/bank-reference/${batchId}/review`, 'POST', { revision: saved.revision, decisions });
  await clock('08:00');
  const waiting = await runNow('bank-references');
  const line = await until(() => latest('bank-references'), r => r.id === waiting.id && W1_LINE.test(r.detail ?? ''), 'loop run says what it waits for');
  assert.equal(line.status, 'running');
  now = await until(w1, s => s.working && s.signIn && !s.ask, 'W1 waits at REI sign-in');
  assert.deepEqual([now.run.id, now.run.step, now.run.upload], [runId, 'sign_in', null]);
  const [view] = (await request(`/api/browser/sign-in?threadId=${encodeURIComponent(now.signIn)}`)).handovers;
  assert.deepEqual([view.site, view.state], ['REI Cloud', 'waiting']);
  let portal = await lab('status');
  assert.ok(portal.signInTabs >= 1, 'REI sign-in tab opened'); assert.equal(portal.uploads, 0);
  await openJob('Bank reference review');
  await strip().getByText('Waiting for you to sign in to REI Cloud', { exact: true }).waitFor();
  await handover().getByRole('button', { name: 'Done signing in to REI Cloud', exact: true }).waitFor();
  await handover().getByRole('button', { name: 'Stop signing in to REI Cloud', exact: true }).waitFor();
  await capture('w1-waiting-at-rei-sign-in', strip());
  pass(`08:00 loop run ${waiting.id} waits on REI's sign-in page for run ${runId}; Schedule says "${line.detail}"; Done and Stop shown; nothing uploaded`);

  // ── 2. The morning passes: one midday reminder ──
  await clock('12:01');
  const reminded = await until(() => latest('bank-references'), r => W1_REMINDER.test(r.detail ?? ''), 'midday reminder');
  assert.equal(reminded.id, waiting.id);
  pass(`At 12:01 (lab clock) the same run reminds once: "${reminded.detail}"`);

  // ── 3. Service restart mid-wait: the page reopens and the run keeps waiting with the same deadline ──
  await restart();
  const interrupted = (await request('/api/loops')).runs.find(r => r.id === waiting.id);
  assert.equal(interrupted.status, 'interrupted');
  const resumed = await until(() => latest('bank-references'), r => r.id !== waiting.id && r.status === 'running' && r.detail === reminded.detail, 'resumed loop run');
  now = await until(w1, s => s.working && s.signIn && !s.ask, 'W1 still waits after restart');
  assert.deepEqual([now.run.id, now.run.step, now.run.fetch.batchId, now.run.upload], [runId, 'sign_in', batchId, null]);
  assert.equal(now.run.review.importIds.length, decisions.length);
  portal = await lab('status');
  assert.ok(portal.signInTabs >= 1, 'REI sign-in tab reopened after restart'); assert.equal(portal.uploads, 0);
  await openJob('Bank reference review');
  await strip().getByText('Waiting for you to sign in to REI Cloud', { exact: true }).waitFor();
  await capture('w1-after-restart-still-waiting', strip());
  pass(`Restart: run ${waiting.id} shows interrupted; ${resumed.id} reopened REI's sign-in page (${portal.signInTabs} tab) and waits with the same line; the pull and review were not redone`);

  // ── 4. The person signs in (matching business): no press; the run reaches the upload approval, which they deny ──
  await lab('sign-in');
  const tools = [];
  for (let i = 0; i < 600; i++) {
    now = await w1();
    if (now.ask?.tool === 'browser_upload') break;
    if (now.ask) { tools.push(now.ask.tool); await request(`/api/w1/runs/${runId}/answer`, 'POST', { requestId: now.ask.requestId, allowed: true }); }
    await wait(100);
  }
  assert.equal(now.ask?.tool, 'browser_upload', JSON.stringify([now.note, now.run?.attention]));
  const asking = await until(() => latest('bank-references'), r => r.id === resumed.id && /^Waiting for your approval to upload/.test(r.detail ?? ''), 'Schedule shows the upload ask');
  assert.equal(asking.detail, 'Waiting for your approval to upload the reviewed bank file to REI. Answer in Schedule → Bank reference review.');
  await openJob('Bank reference review');
  await strip().getByText('Allow Bud to upload the reviewed file to REI?', { exact: true }).waitFor();
  await capture('w1-upload-approval-after-sign-in', strip());
  await strip().getByRole('button', { name: "Don't allow", exact: true }).click();
  const after = await settled(resumed.id);
  assert.equal(after.status, 'awaiting-approval');
  assert.match(after.detail, /^REI shows nothing from the earlier upload/);
  portal = await lab('status');
  assert.deepEqual([portal.uploads, portal.effects], [0, []]);
  pass(`Signed in to the saved business: the run carried on with no Continue or Done (${tools.join(', ') || 'no other asks'} allowed), stopped at "${asking.detail}"; denied in the strip, so nothing reached REI (${after.detail})`);

  // ── 5. Supplier list check: signed in to another business after waiting → the plain mismatch message ──
  await restart(); // the fictional portal starts signed out again
  const mismatch = await runNow('rei-supplier-check');
  await until(() => latest('rei-supplier-check'), r => r.id === mismatch.id && SUPPLIER_LINE.test(r.detail ?? ''), 'supplier check waits');
  await lab('switch-business');
  await lab('sign-in');
  const stopped = await settled(mismatch.id);
  assert.deepEqual([stopped.status, stopped.detail], ['failed', 'REI is open in a different business than FICT1. Switch business in REI, then refresh again. Nothing was saved.']);
  pass(`Supplier check signed in to another business after its wait: stopped with "${stopped.detail}"`);

  // ── 6. Supplier list check: restart mid-wait, then sign-in carries it on to its preview ──
  await lab('restore-business');
  await lab('sign-out');
  const before = (await request('/api/supplier-directory')).directory.revision;
  const first = await runNow('rei-supplier-check');
  const supplierLine = await until(() => latest('rei-supplier-check'), r => r.id === first.id && SUPPLIER_LINE.test(r.detail ?? ''), 'supplier check waits again');
  await openJob('Supplier list check');
  const drawer = page.getByRole('article', { name: 'Supplier list check details', exact: true });
  await drawer.getByRole('status').filter({ hasText: supplierLine.detail }).waitFor();
  await capture('supplier-check-waiting-at-rei-sign-in', drawer);
  await restart();
  const back = await until(() => latest('rei-supplier-check'), r => r.id !== first.id && r.status === 'running' && r.detail === supplierLine.detail, 'supplier check resumed');
  await lab('sign-in');
  for (let i = 0; i < 600; i++) {
    const refresh = await request('/api/rei-directory/status');
    if (refresh.run?.ask) await request(`/api/rei-directory/runs/${refresh.run.id}/answer`, 'POST', { requestId: refresh.run.ask.requestId, allowed: true });
    else if (refresh.run && !refresh.run.working && refresh.run.phase !== 'working') break;
    await wait(100);
  }
  const previewed = await settled(back.id);
  assert.equal(previewed.status, 'awaiting-approval', JSON.stringify(previewed));
  assert.equal((await request('/api/supplier-directory')).directory.revision, before, 'nothing saved without the person');
  pass(`Supplier check restarted mid-wait (${back.id} resumed with the same line), then after sign-in reached its preview: "${previewed.detail}"; nothing saved`);

  // ── 7. Nobody signs in: missed at 18:00, and the next scheduled check tries again ──
  const open = await request('/api/rei-directory/status');
  await request(`/api/rei-directory/runs/${open.run.id}/stop`, 'POST', {});
  await lab('sign-out');
  const late = await runNow('rei-supplier-check');
  await until(() => latest('rei-supplier-check'), r => r.id === late.id && SUPPLIER_LINE.test(r.detail ?? ''), 'supplier check waits once more');
  await clock('18:01');
  const missed = await settled(late.id);
  assert.deepEqual([missed.status, missed.detail], ['missed', "Missed: REI Cloud wasn't signed in today, so the supplier list wasn't checked. The next scheduled check tries again."]);
  await openJob('Supplier list check');
  const result = page.getByRole('region', { name: 'Result to review', exact: true });
  await result.getByText(/Review this result · Missed/).click();
  await result.getByText(missed.detail).first().waitFor();
  await capture('supplier-check-missed', result);
  pass(`At 18:01 (lab clock) the check settled as missed: "${missed.detail}"`);

  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  pass('No renderer errors and no off-origin browser requests');
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
      'Fictional REI-style portal, Gmail connector, Redbark and model: no REI Cloud, Gmail, bank or model evidence.',
      'The sign-in tab is a lab stand-in that reports the portal\'s address; the real work browser tab was not opened, and REI\'s real post-login address was not observed.',
      'Office time is the lab clock (Brisbane); the 12:00 reminder and 18:00 deadline were reached by moving it, not by waiting.',
      'Runs were started with Run now and by the startup resume; the 08:00 clock firing is covered by unit tests only.',
      'The person (review, sign-in, approvals) is simulated by this script; the upload was denied, so nothing was submitted.',
      'Chat cards and desktop notifications are covered by unit tests only.',
      'Source service only: no packaged, installed or Windows evidence.'],
    ...(failure ? { failure, serviceLog: logs.slice(-8000) } : {}) }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
