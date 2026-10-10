#!/usr/bin/env node
// Update restart card (docs/UPDATES-2026-10-10.md): the built UI in headless
// Chrome against a real isolated source service, with a fixture standing in
// for Electron main's updater bridge. Drives the card on first run and the
// office-link screen (docked clear of their buttons), then ready, Later,
// countdown, Not now, a restart blocked by an unsaved draft (and the window's
// real answer to main's unsaved-work question), required, didn't install and
// updated-to states, at 1280 and 390 px, by keyboard. Fictional data only; no electron-updater, no
// installer, no network beyond loopback.
//
//   PLAYWRIGHT_MODULE=… CHROME_EXECUTABLE=… REALBUD_UI_DIR=<vite build> QA_OUTPUT=<fresh dir> \
//     node scripts/qa-update-restart.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { readSessionToken, primeBrowserSession, enterSampleDeskForQa } from './local-session.mjs';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = resolve(process.env.REALBUD_UI_DIR ?? join(root, 'dist'));
assert.ok(existsSync(join(uiDir, 'index.html')), `Build the UI first: no ${uiDir}/index.html`);
const DATE = new Date().toISOString().slice(0, 10);
const output = resolve(process.env.QA_OUTPUT ?? join(root, `outputs/update-restart-${DATE}`));
assert.ok(!existsSync(join(output, 'receipt.json')), `Earlier evidence at ${output} is preserved; choose a fresh QA_OUTPUT.`);
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-update-restart-'));
const data = join(temp, 'data'); mkdirSync(data, { mode: 0o700 });
assert.notEqual(realpathSync(data), resolve(homedir(), '.realbud'), 'Never point a QA run at the real ~/.realbud');

const VERSION = '9.9.9-fictional', ADDRESS = '1 Fictional Lane, Sampleton QLD 4000';
const checks = [], errors = [], screenshots = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
let child, browser, page, failure, logs = '';

const freePort = async () => { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const setUpdater = state => page.evaluate(next => window.__qaSetUpdater(next), state);
const calls = () => page.evaluate(() => [...window.__qaUpdaterCalls]);
const askUnsaved = () => page.evaluate(() => window.__qaAskUnsaved());
const card = () => page.locator('[data-update-card]');
// The status bar shows a waiting update only once setup is finished, which a
// fictional unlinked computer never is; the rail button carries the same words.
const railTitle = () => page.getByRole('button', { name: `Restart now to install ${VERSION}`, exact: true }).getAttribute('title');

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** 1280 then 390 px: the card fits with no horizontal page scroll. On a screen with no
 * shell, `clear` is its primary action: the card stays in view and never covers it. */
async function widths(label, clear) {
  for (const [width, height] of [[1280, 900], [390, 844]]) {
    await page.setViewportSize({ width, height }); await wait(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `${label}: ${overflow}px horizontal scroll at ${width}px`);
    if (clear) await clear.scrollIntoViewIfNeeded();
    const box = await card().boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${label}: the card fits at ${width}px`);
    if (clear) {
      assert.ok(box.y >= 0 && box.y + box.height <= height + 1, `${label}: the card is in view at ${width}px`);
      const action = await clear.boundingBox();
      assert.ok(action && action.y >= 0 && action.y + action.height <= height + 1, `${label}: the primary action is in view at ${width}px`);
      assert.ok(!overlaps(box, action), `${label}: the card covers the primary action at ${width}px`);
    }
    const file = `${String(screenshots.length + 1).padStart(2, '0')}-${label}-${width}.png`;
    await page.screenshot({ path: join(output, file) }); screenshots.push(file);
  }
  await page.setViewportSize({ width: 1280, height: 900 }); await wait(150);
}
/** Keyboard only: Tab until a control with this accessible name has focus, then Enter. */
async function pressByKeyboard(name, { max = 120 } = {}) {
  await page.locator('body').click({ position: { x: 640, y: 5 } }).catch(() => {});
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(wanted => {
      const el = document.activeElement; if (!el || el === document.body) return false;
      const label = (el.getAttribute('aria-label') ?? '').trim(), text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      return label === wanted || text === wanted;
    }, name);
    if (hit) { await page.keyboard.press('Enter'); return i + 1; }
  }
  throw new Error(`Could not reach "${name}" by keyboard`);
}
const ready = (restart, extra = {}) => ({ status: 'downloaded', version: VERSION, restart, ...extra });

try {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root, env: {
    ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }),
    REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: uiDir,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let up = false;
  for (let i = 0; i < 150 && child.exitCode === null; i++) {
    if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null))?.pid === child.pid) { up = true; break; }
    await wait(100);
  }
  assert.ok(up, `Disposable source service starts\n${logs.slice(-2000)}`);
  const token = await readSessionToken(data);

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await primeBrowserSession(context, origin, token);
  // Electron main's updater bridge as a fixture: it records each call and keeps
  // the window's unsaved-work answer so the harness can ask what main would ask.
  const updaterFixture = () => {
    let state = { status: 'idle' }; const listeners = new Set(); let unsaved = null;
    window.__qaUpdaterCalls = [];
    window.__qaSetUpdater = next => { state = next; for (const cb of listeners) cb(state); };
    window.__qaAskUnsaved = async () => (unsaved ? await unsaved() : 'no answer registered');
    const record = name => async () => { window.__qaUpdaterCalls.push(name); };
    // Main's later() resolves false when it refuses (required, or nothing downloaded).
    window.__qaLaterAnswer = true;
    window.ogb = { updater: {
      check: record('check'), download: record('download'), install: record('install'),
      later: async () => { window.__qaUpdaterCalls.push('later'); return window.__qaLaterAnswer; },
      cancelCountdown: record('cancelCountdown'), dismissNote: record('dismissNote'),
      onState: cb => { listeners.add(cb); cb(state); return () => listeners.delete(cb); },
      onQueryUnsaved: handler => { unsaved = handler; return () => { if (unsaved === handler) unsaved = null; }; },
    } };
  };
  await context.addInitScript(updaterFixture);
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  // 0. Before the shell opens: first run and the office-link screen.
  const yourName = page.getByRole('textbox', { name: 'Your name', exact: true });
  await yourName.waitFor();
  assert.equal(await askUnsaved(), false);
  pass('First run, before the shell opens, already answers main’s unsaved-work question (false)');
  const soloCard = () => page.getByRole('status').filter({ hasText: `${VERSION} is ready` });
  await setUpdater(ready({ mode: 'when-away', required: false }));
  await soloCard().getByRole('button', { name: 'Restart now', exact: true }).waitFor();
  await widths('first-run-ready', page.getByRole('button', { name: 'Continue', exact: true }));
  pass('First run (welcome step) shows the ready card with Restart now, docked below the screen and clear of Continue at 1280 and 390 px');
  await setUpdater({ status: 'idle' });
  await soloCard().waitFor({ state: 'hidden' });
  await yourName.fill('Fictional Update Reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Connect this computer to your office', exact: true }).waitFor();
  await setUpdater(ready({ mode: 'when-away', required: false }));
  await soloCard().getByRole('button', { name: 'Restart now', exact: true }).waitFor();
  await widths('first-run-link-ready', page.getByRole('button', { name: 'Connect with this code', exact: true }));
  assert.equal(await askUnsaved(), false);
  pass('First run (connect step): the ready card with Restart now docks below the link card, clear of "Connect with this code" at 1280 and 390 px, and the window answers main');
  await setUpdater({ status: 'idle' });
  await soloCard().waitFor({ state: 'hidden' });
  assert.deepEqual(await calls(), []);
  await enterSampleDeskForQa(page);
  // The office-link screen a finished first run opens on while this computer is unlinked (a tab that keeps the gate).
  const deskPage = page;
  const gateContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await gateContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await primeBrowserSession(gateContext, origin, token, { linkGate: true });
  await gateContext.addInitScript(updaterFixture);
  page = await gateContext.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading', { level: 1, name: 'Connect this computer to your office', exact: true }).waitFor();
  assert.equal(await page.getByText('Step 1 of 5', { exact: true }).count(), 0, 'the office-link screen, not first run');
  await setUpdater(ready({ mode: 'when-away', required: false }));
  await soloCard().getByRole('button', { name: 'Restart now', exact: true }).waitFor();
  await widths('office-link-gate-ready', page.getByRole('button', { name: 'Connect with this code', exact: true }));
  assert.equal(await askUnsaved(), false);
  pass('Unlinked office-link screen: the ready card with Restart now docks below the link card, clear of "Connect with this code" at 1280 and 390 px, and the window answers main');
  await gateContext.close();
  page = deskPage;
  assert.equal(await askUnsaved(), false);
  pass('The window registers its unsaved-work answer at start; a clean Desk answers false');

  // 1. Ready: waits for a safe moment, Restart now + Later.
  await setUpdater(ready({ mode: 'when-away', required: false }));
  const readyCard = page.getByRole('status').filter({ hasText: `${VERSION} is ready` });
  await readyCard.getByText('RealBud restarts by itself when you’re away. Your work is kept.', { exact: true }).waitFor();
  await readyCard.getByRole('button', { name: 'Restart now', exact: true }).waitFor();
  assert.equal(await railTitle(), `Update ready · restarts when you’re away. Restart now to install ${VERSION}.`);
  await widths('ready');
  pass('Ready: card says it restarts when you’re away, offers Restart now and Later; the rail says "Update ready · restarts when you’re away"');
  await readyCard.getByRole('button', { name: 'Restart now', exact: true }).click();
  assert.deepEqual(await calls(), ['install']);
  pass('Restart now hands off to main once');
  await page.evaluate(() => { window.__qaLaterAnswer = false; });
  await readyCard.getByRole('button', { name: 'Later', exact: true }).click();
  await wait(300);
  assert.equal(await readyCard.isVisible(), true, 'a refused Later keeps the card');
  assert.equal(await readyCard.getByText(/^Restarts after/).count(), 0, 'no hold time without a hold');
  await page.evaluate(() => { window.__qaLaterAnswer = true; });
  pass('A Later that main refuses keeps the card and names no hold time');
  const tabs = await pressByKeyboard('Later');
  await readyCard.waitFor({ state: 'hidden' });
  assert.deepEqual(await calls(), ['install', 'later', 'later']);
  assert.match(await railTitle(), /^Update ready/);
  pass(`Keyboard: Later reached in ${tabs} Tab presses; it holds the restart and hides the card while the rail keeps the entry`);
  const laterUntil = (() => { const at = new Date(); at.setDate(at.getDate() + 1); at.setHours(15, 40, 0, 0); return at.getTime(); })();
  await setUpdater(ready({ mode: 'when-away', required: false, laterUntil }));
  await wait(300);
  assert.equal(await readyCard.count(), 0, 'held card stays dismissed for the same update');
  await page.reload(); await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  await setUpdater(ready({ mode: 'when-away', required: false, laterUntil }));
  await readyCard.getByText('Restarts after 3:40 pm when you’re away.', { exact: true }).waitFor();
  await widths('later-held');
  pass('After a relaunch the held card names the time: "Restarts after 3:40 pm when you’re away."');

  // 2. Countdown: ticks outside the live region; Not now by keyboard.
  await setUpdater(ready({ mode: 'countdown', at: Date.now() + 60_000, required: false }));
  const countdown = page.getByRole('group', { name: 'Restarting to update', exact: true });
  await countdown.waitFor();
  const first = Number((await countdown.getByText(/^Restarting to update in \d+ s$/).innerText()).match(/\d+/)[0]);
  assert.ok(first >= 58 && first <= 60, `countdown starts near 60 s, read ${first}`);
  const live = await countdown.getByRole('status').innerText();
  assert.equal(live, 'RealBud is about to restart to update. Choose Not now to keep working.');
  assert.match(await railTitle(), /^Restarting in \d+ s\. /);
  await widths('countdown');
  await wait(1_200);
  const later = Number((await countdown.getByText(/^Restarting to update in \d+ s$/).innerText()).match(/\d+/)[0]);
  assert.ok(later < first, `countdown ticks: ${first} then ${later}`);
  assert.equal(await countdown.getByRole('status').innerText(), live, 'the live region does not change each second');
  pass(`Countdown: "Restarting to update in ${first} s" ticks to ${later} s outside the live region, which announces the start once; the rail reads "Restarting in N s"`);
  await pressByKeyboard('Not now');
  assert.deepEqual((await calls()).slice(-1), ['cancelCountdown']);
  await setUpdater(ready({ mode: 'when-away', required: false }));
  await countdown.waitFor({ state: 'hidden' });
  await readyCard.waitFor();
  pass('Keyboard: Not now cancels the countdown through main; the ready card returns');

  // 3. Blocked by an unsaved draft: the real Desk draft makes the window answer true.
  const more = page.locator('.pm-desk-header details.desk-more');
  if (!await more.evaluate(el => el.open)) await more.locator(':scope > summary').click();
  await more.getByRole('button', { name: 'Properties and imports', exact: true }).click();
  await page.getByRole('button', { name: 'Add property', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a property' });
  await dialog.getByRole('textbox', { name: 'Address' }).fill(ADDRESS);
  await dialog.getByRole('textbox', { name: 'Tenant' }).fill('Fictional Tenant');
  await dialog.getByRole('textbox', { name: 'Phone' }).fill('0400 000 000');
  await dialog.getByRole('spinbutton', { name: 'Weekly rent (AUD)' }).fill('550');
  await dialog.getByRole('button', { name: 'Add to book' }).click();
  const property = page.getByRole('article', { name: ADDRESS });
  await property.waitFor();
  await property.getByRole('button', { name: 'Edit options' }).click();
  await property.getByRole('spinbutton', { name: 'Grace days' }).fill('6');
  assert.equal(await askUnsaved(), true);
  const unload = await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  assert.equal(unload, true, 'beforeunload holds the window for the same draft');
  pass('An unsaved Desk option edit makes the window answer true to main, the same as beforeunload');
  await setUpdater(ready({ mode: 'waiting', blockedBy: ['unsaved'], required: false }));
  await readyCard.getByText('Save or discard your open draft first.', { exact: true }).waitFor();
  assert.match(await railTitle(), /^Update needs you\. /);
  await widths('blocked-unsaved');
  pass('Blocked: the card says "Save or discard your open draft first." and the rail says "Update needs you"');
  await setUpdater(ready({ mode: 'when-away', required: false }, { deferred: 'unsaved', message: 'Save or discard your open draft first, then restart to update.' }));
  await readyCard.getByText('Save or discard your open draft first, then restart to update.', { exact: true }).waitFor();
  assert.match(await railTitle(), /^Update needs you\. /);
  pass('Restart now met the draft: the card shows main’s sentence and the rail says "Update needs you"');
  await property.getByRole('button', { name: 'Discard option edits' }).click();
  assert.equal(await askUnsaved(), false);
  pass('Discarding the draft makes the window answer false again');
  await setUpdater(ready({ mode: 'waiting', blockedBy: ['approval'], required: false }));
  await readyCard.getByText('Bud is waiting for you to answer or finish a step. RealBud restarts after that.', { exact: true }).waitFor();
  await setUpdater(ready({ mode: 'waiting', blockedBy: ['busy'], required: false }, { deferred: 'busy', message: 'Bud is still working. RealBud will restart to update when the work finishes.' }));
  await readyCard.getByText('Bud is still working. RealBud will restart to update when the work finishes.', { exact: true }).waitFor();
  pass('Blocked by an answer Bud waits for, or by busy work, the card names it');

  // 4. Required: no Later.
  await setUpdater(ready({ mode: 'when-away', required: true, requiredReason: 'unsupported' }));
  await readyCard.getByText('This version is no longer supported. RealBud restarts to update as soon as you’re away.', { exact: true }).waitFor();
  assert.equal(await readyCard.getByRole('button', { name: 'Later', exact: true }).count(), 0);
  await widths('required-unsupported');
  await setUpdater(ready({ mode: 'when-away', required: true, requiredReason: 'waited' }));
  await readyCard.getByText('This update has waited a day. RealBud restarts as soon as you’re away.', { exact: true }).waitFor();
  assert.equal(await readyCard.getByRole('button', { name: 'Later', exact: true }).count(), 0);
  pass('Required (unsupported, waited a day): the reason is named and Later is gone');

  // 5. Didn't install: Try again, the download page, dismiss.
  await setUpdater({ status: 'idle', installFailed: { version: VERSION } });
  const failed = page.getByRole('status').filter({ hasText: `${VERSION} didn’t install` });
  await failed.waitFor();
  const download = failed.getByRole('link', { name: 'Download from realbud.app', exact: true });
  assert.equal(await download.getAttribute('href'), 'https://realbud.app/download');
  assert.equal(await download.getAttribute('target'), '_blank');
  await widths('install-failed');
  const before = (await calls()).length;
  await failed.getByRole('button', { name: 'Try again', exact: true }).click();
  assert.deepEqual((await calls()).slice(before), ['install'], 'Try again asks main to install, which checks and downloads first');
  await setUpdater({ status: 'downloading', version: VERSION, percent: 40, installFailed: { version: VERSION } });
  await failed.getByText(`Getting ${VERSION}…`).waitFor();
  await failed.getByText('40%', { exact: true }).waitFor();
  assert.equal(await failed.getByRole('button', { name: 'Try again', exact: true }).count(), 0, 'no dead button while it fetches');
  await widths('install-fetching');
  pass('While main fetches it again the card reads "Getting 9.9.9-fictional… 40%" instead of a dead button');
  await setUpdater({ status: 'idle', installFailed: { version: VERSION } });
  await failed.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  await failed.getByRole('button', { name: 'Dismiss update notice', exact: true }).click();
  await failed.waitFor({ state: 'hidden' });
  assert.deepEqual((await calls()).slice(-1), ['dismissNote']);
  pass('Didn’t install: Try again, an https link to realbud.app/download, and Dismiss clears the note through main');

  // 6. Updated to: What's new, dismiss.
  await setUpdater({ status: 'idle', updatedFrom: { from: '9.9.8', to: '9.9.9' } });
  const updated = page.getByRole('status').filter({ hasText: 'Updated to 9.9.9' });
  await updated.waitFor();
  assert.equal(await updated.getByRole('link', { name: 'What’s new', exact: true }).getAttribute('href'), 'https://github.com/EzAuto399/RealBud/releases/tag/v9.9.9');
  await widths('updated-to');
  await pressByKeyboard('Dismiss update notice');
  await updated.waitFor({ state: 'hidden' });
  assert.deepEqual((await calls()).slice(-1), ['dismissNote']);
  pass('Updated to: a small note with What’s new on the release page; Dismiss by keyboard clears it through main');

  // 7. Drafts held in a component's own state answer main too: a job request, then a bank file.
  const unloadHeld = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  await page.evaluate(() => { location.hash = '#/schedule'; });
  await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add a job', exact: true }).click();
  const builder = page.getByRole('dialog', { name: 'Add a job', exact: true });
  const request = builder.getByRole('textbox', { name: 'What would you like Bud to do?' });
  await request.fill('Compare the fictional invoices and list questions.');
  assert.deepEqual([await askUnsaved(), await unloadHeld()], [true, true]);
  await request.fill('');
  assert.deepEqual([await askUnsaved(), await unloadHeld()], [false, false]);
  await page.getByRole('button', { name: 'Close Add a job', exact: true }).click();
  await builder.waitFor({ state: 'hidden' });
  pass('An unfinished job request makes the window answer true to main and hold beforeunload; clearing it answers false');
  await page.evaluate(() => { location.hash = 'schedule-agency'; });
  const agency = page.getByRole('region', { name: 'Agency workflow setup', exact: true });
  const agencyName = agency.getByLabel('Agency name', { exact: true });
  await agencyName.waitFor();
  assert.deepEqual([await askUnsaved(), await unloadHeld()], [false, false]);
  await agencyName.fill('Fictional Unsaved Agency');
  assert.deepEqual([await askUnsaved(), await unloadHeld()], [true, true]);
  await agency.getByRole('button', { name: 'Reload saved settings', exact: true }).click();
  for (let i = 0; i < 50 && await askUnsaved() !== false; i++) await wait(100); // the saved settings are read again
  assert.deepEqual([await askUnsaved(), await unloadHeld()], [false, false]);
  pass('An unsaved Agency workflow setup edit makes the window answer true to main and hold beforeunload; Reload saved settings answers false');
  await page.getByRole('list', { name: 'Jobs', exact: true }).waitFor();
  await page.evaluate(() => { location.hash = 'job-bank-references'; });
  const bankDrawer = page.getByRole('dialog', { name: 'Bank reference review', exact: true });
  await bankDrawer.waitFor();
  assert.deepEqual([await askUnsaved(), await unloadHeld()], [false, false]);
  await bankDrawer.getByText('Prepare a new export', { exact: true }).click();
  await bankDrawer.getByLabel('Bank CSV', { exact: true }).setInputFiles({ name: 'fictional-bank.csv', mimeType: 'text/csv', buffer: Buffer.from('Date,Amount,Narrative,Reference\n2026-09-10,500.00,FICTIONAL RENT,P101\n') });
  for (let i = 0; i < 50 && await askUnsaved() !== true; i++) await wait(100); // the file is read in the background
  assert.deepEqual([await askUnsaved(), await unloadHeld()], [true, true]);
  pass('A bank file chosen in Bank review makes the window answer true to main and hold beforeunload');

  assert.deepEqual(errors, [], 'no renderer page errors');
  pass('No renderer page errors');
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close();
  if (child?.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5_000)]); if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    at: new Date().toISOString(), passed: !failure,
    layer: 'Built React UI in headless Chrome; real isolated source service; fixture updater bridge',
    limits: [
      'Electron main is replaced by a fixture bridge: no electron-updater, idle detection, safe-moment checks, installer or relaunch ran.',
      'The states are set by the harness, not produced by main; this proves the renderer’s words, controls and unsaved-work answer only.',
      'Fictional sample workspace; screenshots are not customer acceptance.',
    ],
    checks, screenshots, errors, failure, ...(failure ? { diagnostic: logs.slice(-4_000) } : {}),
  }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; }
}
