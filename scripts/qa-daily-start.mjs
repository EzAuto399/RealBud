// Daily start (owner, 8 Oct 2026): REI Cloud signed the office out overnight. On the FICTIONAL
// Austin demo office (scripts/seed-austin-demo.mjs) the REI morning refresh misses for sign-in and
// a W1 bank import waits at REI's sign-in page. Desk then shows one primary action, "Sign in to
// REI", reached by keyboard, answering within 400 ms and bringing the waiting sign-in page forward
// (no second REI tab); the status bar says "REI: sign in needed". The simulated person signs in on
// the fictional portal's own page; the bank import carries on by itself, the missed refresh runs
// again, and the status bar says "REI: signed in". Get started shows progress, Skip and Back work,
// and the first-day guide's "Try it with Bud" fills Work's composer for Kevin's three workflows
// and (on a second demo PC) Sherry's two; the guide is dismissed and brought back from Workspace.
// Real local source service + built UI; fictional REI-style portal, Gmail, Redbark and model.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-daily-start.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeBrowserSession } from './local-session.mjs';
import { seed, startAustinDemo } from './seed-austin-demo.mjs';
import { FIRST_DAY_ITEMS } from '../src/lib/first-day.ts';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT || join(root, `outputs/ux-daily-start-${new Date().toISOString().slice(0, 10)}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [], errors = [], denied = [], shots = [], timings = {};
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const roots = [];
let demo, browser, context, page, failure;

const request = (...args) => demo.request(...args);
const lab = (action, extra = {}) => request('/api/w1/lab', 'POST', { action, ...extra });
const clock = time => lab('clock', { at: `${demo.today}T${time}:00+10:00` });
const until = async (read, done, label, tries = 600) => { let value; for (let i = 0; i < tries; i++) { value = await read(); if (done(value)) return value; await wait(100); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const loopRuns = async loopId => (await request('/api/loops')).runs.filter(r => r.loopId === loopId);
const settled = id => until(async () => (await request('/api/loops')).runs.find(r => r.id === id), r => r && !['queued', 'running'].includes(r.status), `run ${id}`);
async function runNow(loopId) {
  const loop = (await request('/api/loops')).loops.find(l => l.id === loopId);
  return (await request(`/api/loops/${loopId}/run`, 'POST', { requestId: randomUUID(), expectedRevision: loop.revision }, 201)).run;
}
const reiCard = () => page.getByRole('region', { name: 'REI sign-in', exact: true });
const signInButton = () => reiCard().getByRole('button', { name: 'Sign in to REI', exact: true });
const statusBar = () => page.locator('footer[aria-label="Status bar"]');
const getStarted = () => page.getByRole('region', { name: 'Get started', exact: true });
const guide = () => page.getByRole('group', { name: 'Your first day with Bud', exact: true });
const composer = () => page.getByRole('textbox', { name: 'Tell Bud what outcome you need', exact: true });
const door = name => page.getByRole('button', { name: new RegExp(`^${name}\\b`) }).first();
async function openDesk() { await door('Desk').click(); await getStarted().waitFor(); }
async function capture(name, locator) {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height });
    if (locator) await locator.scrollIntoViewIfNeeded();
    if (width === 390) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal page scroll at 390px (${name})`);
    const file = `${name}-${width}.png`; await page.screenshot({ path: join(output, file), animations: 'disabled' }); shots.push(file);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
/** Keyboard only: Tab (or Shift+Tab) from wherever focus is until the control has focus. */
async function tabTo(locator, { key = 'Tab', max = 120 } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    if (await locator.evaluate(el => el === document.activeElement)) return i + 1;
  }
  throw new Error(`control not reachable by ${key}`);
}
/** "Try it with Bud" for one workflow: Work opens with the request in the composer, for the person to send. */
async function tryWithBud(item, { keyboard = false } = {}) {
  await openDesk();
  if (await guide().getByRole('button', { name: /Your first day with Bud/ }).getAttribute('aria-expanded') === 'false') await guide().getByRole('button', { name: /Your first day with Bud/ }).click();
  const button = guide().getByRole('button', { name: `Try it with Bud: ${item.name}`, exact: true });
  const started = Date.now();
  if (keyboard) { await button.focus(); await page.keyboard.press('Enter'); } else await button.click();
  await until(() => composer().inputValue().catch(() => ''), value => value === item.prompt, `Work composer holds the ${item.name} request`, 100);
  timings[`try-${item.loopId}-ms`] = Date.now() - started;
  return composer().evaluate(el => el === document.activeElement);
}
async function startDemo(role) {
  const demoRoot = mkdtempSync(join(realpathSync(tmpdir()), `realbud-daily-start-${role}-`)); roots.push(demoRoot);
  demo = await startAustinDemo({ demoRoot, role });
  await lab('handover');
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, demo.base, demo.token);
  await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === demo.base) return route.continue(); denied.push(origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  await startDemo('kevin');

  // ── 1. The morning: REI signed out overnight. The refresh misses; the bank import waits at REI's sign-in page ──
  await clock('07:55');
  const refreshLoop = (await request('/api/loops')).loops.find(l => l.id === 'rei-morning-refresh');
  await request('/api/loops/rei-morning-refresh', 'PATCH', { enabled: true, expectedRevision: refreshLoop.revision });
  const missed = await settled((await runNow('rei-morning-refresh')).id);
  assert.equal(missed.status, 'missed', JSON.stringify(missed)); assert.match(missed.detail, /^Missed: sign in to REI\./);
  const pulled = await settled((await runNow('bank-references')).id);
  assert.equal(pulled.status, 'awaiting-approval', JSON.stringify(pulled));
  let w1 = await request('/api/w1/status');
  const runId = w1.run.id, batchId = w1.run.fetch.batchId;
  const saved = await request(`/api/bank-reference/${batchId}`);
  const decisions = saved.value.batch.rows.map(row => {
    const ref = /FT-[A-Z0-9]+/.exec(`${row.narrative ?? ''} ${row.reference ?? ''}`)?.[0];
    const property = seed.properties.find(p => p.tenant.reiTenantRef === ref);
    assert.ok(property, `fictional tenant reference in ${row.narrative}`);
    return { rowId: row.id, action: 'assign', propertyId: property.code, reason: 'Fictional reference matches the tenant directory' };
  });
  await request(`/api/bank-reference/${batchId}/review`, 'POST', { revision: saved.revision, decisions });
  await clock('08:00');
  const waitingRun = await runNow('bank-references');
  w1 = await until(() => request('/api/w1/status'), s => s.working && s.signIn && !s.ask, 'W1 waits at REI sign-in');
  assert.deepEqual([w1.run.id, w1.run.step], [runId, 'sign_in']);
  let portal = await until(() => lab('status'), s => s.signInTabs === 1, 'REI sign-in page opened once');
  let view = await until(() => request('/api/rei/sign-in'), v => v.state === 'needed' && v.waiting.length === 2, 'REI sign-in needed');
  assert.deepEqual(view.waiting.map(w => w.name).sort(), ['Bank reference review', 'REI morning refresh']);
  assert.equal(view.signingIn, true);
  pass(`Morning, signed out: REI morning refresh ${missed.status} ("${missed.detail.slice(0, 60)}…"), bank import run ${runId} waits at REI sign-in; /api/rei/sign-in says needed, waiting for ${view.waiting.map(w => w.name).join(' + ')}`);

  // ── 2. Desk: one primary action, the status bar in plain words ──
  const loadStart = Date.now();
  await page.goto(`${demo.base}/#/desk`);
  await signInButton().waitFor();
  timings['desk-to-sign-in-action-ms'] = Date.now() - loadStart;
  await reiCard().getByText('Bud is waiting to finish Bank reference review and REI morning refresh.', { exact: true }).waitFor();
  await reiCard().getByText('You type your password on REI’s own page. Bud never sees it.', { exact: true }).waitFor();
  await reiCard().getByText('REI’s sign-in page is open in your work browser. Bud carries on by itself once you’re signed in.', { exact: true }).waitFor();
  await statusBar().getByRole('button', { name: 'REI: sign in needed', exact: true }).waitFor();
  const filled = await page.evaluate(() => [...document.querySelectorAll('main button')]
    .filter(b => b.offsetParent && !b.closest('#desk-case-column') && /\bbg-agency\b/.test(b.className) && /\btext-white\b/.test(b.className)).map(b => b.textContent.trim()));
  assert.deepEqual(filled, ['Sign in to REI'], `Desk's only filled action outside the case decision: ${JSON.stringify(filled)}`);
  const bodyText = await page.locator('body').innerText();
  assert.ok(!/cookie|token|Hermes/i.test(bodyText), 'no engine words on Desk');
  await capture('01-desk-rei-sign-in-needed', reiCard());
  pass(`Desk shows one filled action, "Sign in to REI" (${timings['desk-to-sign-in-action-ms']} ms from load), naming the waiting work; status bar: "REI: sign in needed"; no engine words`);

  // ── 3. Keyboard only: Tab to Sign in to REI, Enter; feedback under 400 ms; the same sign-in page comes forward ──
  // From where a fresh Desk puts keyboard focus (the first Tab lands in the selected case), Shift+Tab goes up to the card.
  await page.reload(); await signInButton().waitFor();
  await page.keyboard.press('Tab');
  const landing = await page.evaluate(() => (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').trim().slice(0, 40));
  const tabs = 1 + await tabTo(signInButton(), { key: 'Shift+Tab', max: 60 });
  await page.evaluate(() => {
    window.__qa = { key: null, feedback: null };
    document.addEventListener('keydown', event => { if (event.key === 'Enter') window.__qa.key = performance.now(); }, { capture: true, once: true });
    new MutationObserver((_, observer) => {
      const card = document.querySelector('section[aria-label="REI sign-in"]');
      if (card?.querySelector('[role="status"]')?.textContent?.startsWith('Opening REI') || card?.querySelector('button[aria-busy="true"]')) { window.__qa.feedback = performance.now(); observer.disconnect(); }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await page.keyboard.press('Enter');
  await until(() => page.evaluate(() => window.__qa.feedback), value => value !== null, 'visible feedback after Enter', 50);
  const feedback = await page.evaluate(() => window.__qa.feedback - window.__qa.key);
  timings['sign-in-feedback-ms'] = Math.round(feedback);
  assert.ok(feedback < 400, `feedback within 400 ms: ${feedback}`);
  portal = await until(() => lab('status'), s => s.signInShows >= 1, 'the waiting sign-in page brought forward');
  assert.equal(portal.signInTabs, 1, 'no second REI sign-in tab');
  assert.equal((await request('/api/w1/status')).run.step, 'sign_in');
  pass(`Keyboard only: the first Tab lands on "${landing}" and ${tabs - 1} Shift+Tab presses reach "Sign in to REI"; Enter shows "Opening REI’s sign-in page…" in ${timings['sign-in-feedback-ms']} ms; the waiting REI sign-in page was brought forward (${portal.signInShows}×), still ${portal.signInTabs} REI tab`);

  // ── 4. The person signs in on REI's own page: the waiting work carries on by itself ──
  await lab('sign-in');
  w1 = await until(() => request('/api/w1/status'), s => s.run?.id === runId && s.run.step !== 'sign_in', 'bank import carries on after sign-in');
  view = await until(() => request('/api/rei/sign-in'), v => v.state === 'signed_in' && v.waiting.length === 0, 'REI signed in');
  await reiCard().getByText('Signed in to REI. Bud is carrying on with today’s REI work.', { exact: true }).waitFor();
  await statusBar().getByText('REI: signed in', { exact: true }).waitFor();
  await capture('02-desk-rei-signed-in', reiCard());
  // The bank import holds the work browser first; the missed refresh waits for it. The person declines the upload
  // here (nothing reaches REI) and allows the read-only receipt check, which frees the browser.
  const asked = []; let idle = 0;
  for (let i = 0; i < 600; i++) {
    const now = await request('/api/w1/status');
    if (now.ask) { asked.push(now.ask.tool); await request('/api/w1/runs/' + runId + '/answer', 'POST', { requestId: now.ask.requestId, allowed: now.ask.tool !== 'browser_upload' }); }
    else if (now.working === false) { if (++idle > 5) break; await wait(200); continue; }
    idle = 0;
    await wait(100);
  }
  assert.ok(asked.includes('browser_upload'), 'the upload asked first: ' + asked);
  const w1Settled = await settled(waitingRun.id);
  const rerun = await until(async () => (await loopRuns('rei-morning-refresh')).find(r => r.id !== missed.id && r.scheduledFor > missed.scheduledFor), Boolean, 'the missed refresh runs again once the browser is free');
  const refreshed = await settled(rerun.id);
  assert.equal(refreshed.status, 'completed', JSON.stringify(refreshed));
  assert.equal((await lab('status')).uploads, 0, 'nothing uploaded');
  assert.equal((await request('/api/rei/sign-in')).state, 'signed_in');
  await reiCard().getByRole('button', { name: 'Dismiss', exact: true }).click();
  await reiCard().waitFor({ state: 'detached' });
  pass('After sign-in, with no Continue: bank import run ' + runId + ' carried on to its upload ask (declined here; ' + w1Settled.status + ': "' + (w1Settled.detail ?? '').slice(0, 70)
    + '…"); once the browser was free the missed REI morning refresh ran again (' + refreshed.status + ': "' + (refreshed.detail ?? '').slice(0, 90)
    + '…"); Desk said "Signed in to REI…", status bar "REI: signed in"; nothing uploaded');

  // ── 5. Get started: visible progress; Skip for now and Back to this step ──
  const progress = getStarted().getByRole('progressbar', { name: 'Get started progress', exact: true });
  assert.equal(await progress.getAttribute('aria-valuenow'), '4');
  await getStarted().getByText('4 of 5 done', { exact: true }).waitFor();
  const skip = getStarted().getByRole('button', { name: 'Skip for now: Review and switch on your workflows', exact: true });
  await skip.focus(); await page.keyboard.press('Enter');
  await getStarted().getByText('4 of 5 done · 1 skipped', { exact: true }).waitFor();
  const back = getStarted().getByRole('button', { name: 'Back to this step: Review and switch on your workflows', exact: true });
  await capture('03-get-started-skipped', getStarted());
  await back.focus(); await page.keyboard.press('Enter');
  await skip.waitFor();
  await getStarted().getByText('4 of 5 done', { exact: true }).waitFor();
  assert.equal(await progress.getAttribute('aria-valuenow'), '4', 'a skipped step never counts as done');
  pass('Get started shows "4 of 5 done" with a progress bar; Skip for now (keyboard) sets the step aside ("1 skipped", never done) and Back to this step brings it back');

  // ── 6. Kevin's first day: Try it with Bud fills Work for each of his three workflows ──
  const kevin = FIRST_DAY_ITEMS.filter(item => ['bank-references', 'weekly-bills', 'inbound-triage'].includes(item.loopId));
  await openDesk();
  await guide().getByText('· 0 of 3 tried', { exact: true }).waitFor();
  for (const item of FIRST_DAY_ITEMS) assert.equal(await guide().getByRole('button', { name: `Try it with Bud: ${item.name}`, exact: true }).count(), 0, 'folded while setup is unfinished');
  await guide().getByRole('button', { name: /Your first day with Bud/ }).click();
  assert.equal(await guide().getByRole('button', { name: 'Try it with Bud: Maintenance checks', exact: true }).count(), 0, 'only this PC\'s role workflows');
  await capture('04-first-day-guide-kevin', guide());
  for (const [index, item] of kevin.entries()) {
    const focused = await tryWithBud(item, { keyboard: index === 0 });
    if (index === 0) { assert.ok(focused, 'the composer has focus, ready to send'); await capture('05-work-try-bank-references', composer()); }
    // Bud does the work only when the person sends: nothing was sent here.
    await composer().fill('');
  }
  await openDesk();
  await guide().getByText('· 3 of 3 tried', { exact: true }).waitFor();
  pass(`Kevin's first-day guide (folded until opened) lists only his ${kevin.length} workflows with what Bud does, reads and needs approval for; "Try it with Bud" put each request in Work's composer (first by keyboard, composer focused) in ${kevin.map(i => timings[`try-${i.loopId}-ms`]).join('/')} ms; "3 of 3 tried"`);

  // ── 7. Dismiss the guide; bring it back from Workspace ──
  await guide().getByRole('button', { name: 'Dismiss the first-day guide', exact: true }).click();
  await guide().waitFor({ state: 'detached' });
  await door('Workspace').click();
  const settings = page.locator('#you-settings > summary');
  await settings.click();
  await page.getByRole('button', { name: 'Show Get started on Desk again', exact: true }).click();
  await getStarted().waitFor();
  await guide().getByText('· 0 of 3 tried', { exact: true }).waitFor();
  pass('Dismiss hides the first-day guide; Workspace → Settings & help → "Show Get started on Desk again" brings it back on Desk, reset');

  // ── 8. Sherry's computer: her two workflows ──
  await context.close(); await demo.stop();
  await startDemo('sherry');
  await page.goto(`${demo.base}/#/desk`);
  await getStarted().waitFor();
  await guide().getByRole('button', { name: /Your first day with Bud/ }).click();
  await guide().getByText('· 0 of 2 tried', { exact: true }).waitFor();
  for (const name of ['Bank reference review', 'Weekly bills review', 'Morning priorities']) assert.equal(await guide().getByRole('button', { name: `Try it with Bud: ${name}`, exact: true }).count(), 0, `Sherry's guide leaves out ${name}`);
  await capture('06-first-day-guide-sherry', guide());
  const sherry = FIRST_DAY_ITEMS.filter(item => ['maintenance-review', 'inspection-draft'].includes(item.loopId));
  for (const item of sherry) { await tryWithBud(item); await composer().fill(''); }
  pass(`Sherry's first-day guide lists only ${sherry.map(i => i.name).join(' and ')}; "Try it with Bud" put each request in Work's composer`);

  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  pass('No renderer errors and no off-origin browser requests');
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
  // What the REI work looked like when it failed: its latest runs, newest first.
  const runs = await demo?.request('/api/loops').then(body => body.runs.filter(r => ['bank-references', 'rei-morning-refresh'].includes(r.loopId)).slice(0, 6)).catch(() => null);
  if (runs) failure += '\n' + JSON.stringify(runs.map(r => ({ loopId: r.loopId, status: r.status, scheduledFor: r.scheduledFor, finishedAt: r.finishedAt, detail: (r.detail ?? '').slice(0, 200) })), null, 1);
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  const logs = demo?.logs?.() ?? '';
  await demo?.stop().catch(() => {});
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ ok: !failure, at: new Date().toISOString(), checks, shots, timings, errors, denied,
    layer: 'Real local source service and built UI on the fictional Austin demo office (Kevin, then Sherry); real sign-in handover over the fictional REI-style portal',
    limits: [
      'Fictional REI-style portal, Gmail connector, Redbark and model: no REI Cloud, Gmail, bank or model evidence.',
      'The sign-in tab is a lab stand-in that reports the portal\'s address and counts "brought forward"; the real work browser was not opened or focused.',
      'The person (review, sign-in on REI\'s page) is simulated by this script; Try it with Bud fills the composer and nothing is sent.',
      'The lab clock moves the bank import\'s office day; the service runs on this Mac, from source: no packaged, installed or Windows evidence.'],
    ...(failure ? { failure, serviceLog: logs.slice(-8000) } : {}) }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
