#!/usr/bin/env node
// The office-link screen on the actual local HTTP service + built React UI,
// fictional office in a throwaway home/data folder (never ~/.realbud). No mail,
// model, website or network call: the office link, its redeem answer, the
// browser approval and Bud's status are fictional route replies over the real
// server's own answers.
//
// Every computer links before anything else opens (owner decision 10 Oct 2026).
// Renders the screen checking, can't be read, not linked, disconnected
// (revoked), waiting for browser approval and at the computer limit at 1280,
// 768 and 390 px, with no shell flash and no exit; a check that never answers
// hands over to Try again and recovery; walks it by keyboard to a link (the
// screen goes and Bud's setup cover takes over); shows that shortcuts and deep
// links don't get past it, that recovery does (for this app session only), and
// that a book in recovery is never held behind it.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-link-gate.mjs
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
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud link gate QA '));
const data = join(temp, 'data'), output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/link-gate-2026-10-10'));
mkdirSync(data, { mode: 0o700 }); mkdirSync(output, { recursive: true });
const checks = [], errors = [], screenshots = [], wait = ms => new Promise(r => setTimeout(r, ms));
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };

const NOT_LINKED = 'Connect this computer to your office';
const REVOKED = 'This computer was disconnected from your office';
const UNAVAILABLE = 'This computer’s office link couldn’t be checked';
const CHECKING = 'Checking this computer’s office link…';
const CODE = 'FICTIONAL-LINK-CODE-0001';
const CAP = 'This office already has 5 computers. Disconnect one to pair another. Your code is kept: once your account owner disconnects a computer under Account → Computers on realbud.app, try this same code again.';
const WIDTHS = [[1280, 900], [768, 1024], [390, 844]];
/** The exits the owner removed (10 Oct): none may appear on the screen. */
const OLD_EXITS = /sample desk|without Bud/i;
/** `mode` is this computer's fictional link: what GET /api/office-link answers and what a pasted code does.
 * 'hold' never answers until released; 'fail' is the local service failing the read. */
let mode = 'unlinked', redeemed = [], holdDesk = false;
const heldLinks = [], heldDesks = [];
let child, browser, logs = '', failure;
const pages = [];

try {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const base = `http://127.0.0.1:${port}`;
  const networkGuard = join(temp, 'network-guard.mjs');
  writeFileSync(networkGuard, 'globalThis.fetch=()=>{throw new Error("QA denied outbound fetch");};', { mode: 0o600 });
  child = spawn(process.execPath, ['--import', networkGuard, join(root, 'server/index.ts')], { cwd: root, env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR || join(root, 'dist')) }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-24000); });
  let ready = false; for (let i = 0; i < 150; i++) { if (child.exitCode !== null) break; try { if ((await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === child.pid) { ready = true; break; } } catch {} await wait(100); } assert.ok(ready, logs);
  const token = await readSessionToken(data);
  const request = async (path, method = 'GET', body, expected = 200) => { const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await res.json(); assert.equal(res.status, expected, `${path}: ${JSON.stringify(value)}`); return value; };
  await completeFictionalOnboarding(request);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });

  const approval = { approvalUrl: `https://realbud.app/link/${'F'.repeat(43)}`, displayCode: 'FQAK-GATE', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  const linked = { state: 'linked', label: 'Fictional Kevin’s computer', agencyLabel: 'Fictional Harbour Agency', lastReportedAt: new Date().toISOString(), provisioned: true };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const linkReply = route => {
    if (mode === 'linked') return json(route, linked);
    if (mode === 'revoked') return json(route, { state: 'revoked', revokedAt: '2026-10-09T00:00:00.000Z' });
    if (mode === 'pending') return json(route, { state: 'pending', browser: approval });
    if (mode === 'fail') return json(route, { error: 'Fictional: the office link record could not be read.' }, 500);
    return json(route, { state: 'unlinked' });
  };
  /** Answer every held read with the current mode. */
  const release = async () => { for (const route of heldLinks.splice(0)) await linkReply(route).catch(() => {}); for (const route of heldDesks.splice(0)) await route.continue().catch(() => {}); };
  /** A fresh app session: its own browser context, the office-link screen kept (not passed). */
  const session = async ({ deskPatch } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await primeBrowserSession(context, base, token, { linkGate: true });
    // Records the moments the shell, the checking frame and its words first appear in each document.
    await context.addInitScript(() => {
      const seen = window.__gateSeen = {};
      new MutationObserver(() => {
        const now = performance.now();
        if (!seen.shell && document.querySelector('[aria-label="Status bar"]')) seen.shell = now;
        if (!seen.gate && /Connect this computer to your office|disconnected from your office|couldn’t be checked/.test(document.querySelector('h1')?.textContent ?? '')) seen.gate = now;
        const status = document.querySelector('main > p[role="status"]');
        if (status && seen.frame === undefined) seen.frame = now;
        if (status && !seen.words && status.textContent.trim()) seen.words = now;
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.route('**/api/office-link', route => {
      if (route.request().method() === 'POST') {
        redeemed.push(JSON.parse(route.request().postData() || '{}').code);
        if (mode === 'cap') return json(route, { error: CAP, code: 'installation_limit' }, 409);
        mode = 'linked';
        return json(route, linked);
      }
      if (mode === 'hold') { heldLinks.push(route); return; }
      return linkReply(route);
    });
    await context.route('**/api/office-link/browser-link', route => json(route, { state: 'pending', ...approval }));
    await context.route('**/api/desk', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      if (holdDesk) { heldDesks.push(route); return; }
      if (!deskPatch) return route.continue();
      const response = await route.fetch(); await route.fulfill({ response, json: deskPatch(await response.json()) });
    });
    // Bud is not set up before the link; once linked its automatic setup runs.
    await context.route('**/api/hermes', async route => {
      const response = await route.fetch(); const { autoSetup: _drop, ...rest } = await response.json();
      await route.fulfill({ response, json: mode === 'linked'
        ? { ...rest, ready: false, readyOnce: false, restartRequired: false, autoSetup: { state: 'installing', code: 'installing', step: 1, total: 4, detail: 'Fictional: installing Bud' } }
        : { ...rest, ready: false, restartRequired: false } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    page.on('pageerror', error => errors.push(`${mode}: ${error.message}`));
    pages.push(page);
    return { context, page };
  };
  const shot = async (page, name) => { const path = join(output, `${name}.png`); await page.screenshot({ path }); screenshots.push(path); };
  const heading = (page, name) => page.getByRole('heading', { name, exact: true });
  const statusBar = page => page.getByRole('contentinfo', { name: 'Status bar' });
  const seen = page => page.evaluate(() => window.__gateSeen);
  const fits = async (page, locator, label) => {
    const box = await locator.boundingBox(), height = page.viewportSize().height;
    assert.ok(box && box.y >= 0 && box.y + box.height <= height, `${label} is not on the first screen: ${JSON.stringify(box)} of ${height}px`);
  };
  const noSideScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: horizontal scroll`);
  /** Nothing gets past the screen: no shell now or at any moment of this document, and none of the removed exits. */
  const held = async (page, label) => {
    assert.equal(await statusBar(page).count(), 0, `${label}: the shell waits behind the office-link screen`);
    assert.equal((await seen(page)).shell, undefined, `${label}: the shell flashed before the office-link screen`);
    assert.equal(await page.getByRole('button', { name: OLD_EXITS }).count(), 0, `${label}: an old exit is offered`);
  };
  const open = async (page, hash = '#/desk') => { await page.goto(`${base}/${hash}`); await page.reload(); };

  // ── Each state at each width ──
  const { page } = await session();
  const states = [
    ['checking', 'hold', null],
    ['unavailable', 'fail', UNAVAILABLE],
    ['not-linked', 'unlinked', NOT_LINKED],
    ['revoked', 'revoked', REVOKED],
    ['pending-approval', 'pending', NOT_LINKED],
    ['computer-limit', 'cap', NOT_LINKED],
  ];
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    for (const [name, linkMode, title] of states) {
      mode = linkMode;
      await open(page);
      let action, detail;
      if (name === 'checking') {
        // The frame shows at once; its words only after a second; no heading, form or action meanwhile.
        await page.getByText(CHECKING, { exact: true }).waitFor();
        const times = await seen(page);
        assert.ok(times.frame !== undefined && times.words - times.frame >= 900, `${name}: the words waited a second (${JSON.stringify(times)})`);
        assert.equal(await page.getByRole('status').filter({ hasText: CHECKING }).count(), 1, `${name}: the words are a status`);
        assert.equal(await page.getByRole('heading').count(), 0, `${name}: no heading while checking`);
        assert.equal(await page.getByRole('button').count(), 0, `${name}: nothing to press while checking`);
        await held(page, name);
        await noSideScroll(page, `${name} at ${width}`);
        await shot(page, `${width}-${name}`);
        mode = 'unlinked'; await release();
        await heading(page, NOT_LINKED).waitFor();
        pass(`${width}px checking: the frame replaces the shell at once, "${CHECKING}" appears after ${Math.round(times.words - times.frame)} ms as a status, with no heading or action; the answer then shows the link screen`);
        continue;
      }
      await heading(page, title).waitFor();
      await held(page, name);
      await page.waitForFunction(() => document.activeElement?.tagName === 'H1', undefined, { timeout: 2_000 });
      if (name === 'unavailable') {
        await page.getByText('RealBud’s local service didn’t answer. Everything saved here is kept.', { exact: true }).waitFor();
        action = page.getByRole('button', { name: 'Try again', exact: true });
        assert.ok(await page.getByRole('button', { name: 'Open recovery', exact: true }).isVisible(), `${name}: Open recovery`);
        assert.equal(await page.getByRole('textbox', { name: 'Link code' }).count(), 0, `${name}: no code entry while the link can't be read`);
        detail = 'Try again and Open recovery, no code entry';
      } else if (name === 'pending-approval') {
        await page.getByText('Waiting for your approval…', { exact: false }).waitFor();
        await page.getByText(/Expires in \d+:\d\d/).waitFor();
        await page.getByText(approval.displayCode, { exact: true }).first().waitFor();
        action = page.getByRole('button', { name: 'Cancel', exact: true });
        assert.ok(await page.getByRole('button', { name: 'Open the page again', exact: true }).isVisible());
        detail = 'the approval code, time left, Open the page again and Cancel';
      } else {
        action = page.getByRole('button', { name: 'Connect with this code', exact: true });
        assert.equal(await page.getByRole('button', { name: 'Open recovery', exact: true }).count(), 0, `${name}: recovery is only for a link that can't be read`);
        detail = 'the link-code entry';
        // The heading says it once; the card doesn't repeat it.
        if (name === 'revoked') assert.equal(await page.getByText('This computer was removed from your office.', { exact: false }).count(), 0);
        if (name === 'computer-limit') {
          await page.getByRole('textbox', { name: 'Link code' }).fill(CODE);
          await action.click();
          await page.getByRole('alert').filter({ hasText: 'already has 5 computers' }).waitFor();
          assert.equal(await page.getByRole('textbox', { name: 'Link code' }).inputValue(), CODE, 'the refused code is kept');
          assert.ok(await page.getByRole('button', { name: 'Copy request for your owner', exact: true }).isVisible(), 'the owner hand-off is on screen');
          await held(page, `${name} after the refusal`);
          await heading(page, title).scrollIntoViewIfNeeded();
          detail = 'the website’s limit sentence, the code kept and Copy request for your owner';
        }
      }
      if (width === 390) { await fits(page, heading(page, title), `${name} heading at 390`); await fits(page, action, `${name} primary action at 390`); }
      await noSideScroll(page, `${name} at ${width}`);
      await shot(page, `${width}-${name}`);
      pass(`${width}px ${name}: "${title}" replaces the shell with no flash before it, heading focused, ${detail}, and no way around it; no horizontal scroll${width === 390 ? '; heading and action on the first screen' : ''}`);
    }
  }

  // ── A check that never answers: Try again and recovery, never an endless "Checking…" ──
  await page.setViewportSize({ width: 1280, height: 900 });
  mode = 'unlinked'; holdDesk = true;
  await open(page);
  await page.getByText(CHECKING, { exact: true }).waitFor();
  const started = Date.now();
  await heading(page, UNAVAILABLE).waitFor({ timeout: 30_000 });
  const stuckAfter = Date.now() - started;
  assert.ok(stuckAfter >= 17_000, `the check handed over after ${stuckAfter} ms`);
  await held(page, 'stuck check');
  await shot(page, '1280-checking-stuck');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText(CHECKING, { exact: true }).waitFor();
  holdDesk = false; await release();
  await heading(page, NOT_LINKED).waitFor();
  await held(page, 'after Try again');
  pass(`A book read that never answers: after ~20 s (${Math.round((stuckAfter + 1000) / 1000)} s from load) the frame becomes "${UNAVAILABLE}" with Try again and Open recovery; Try again checks again and, once answered, shows the link screen`);

  // ── Keyboard only on "can't be read": the heading, then Try again, then Open recovery; Try again with the read still failing stays put ──
  mode = 'fail';
  await open(page);
  await heading(page, UNAVAILABLE).waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === 'H1');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Try again', 'Tab reaches Try again');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Open recovery', 'Tab reaches Open recovery');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Checking again…', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Checking again…', 'focus stays on the button while it works');
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Try again', 'focus is still on Try again');
  await heading(page, UNAVAILABLE).waitFor();
  mode = 'unlinked';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await heading(page, NOT_LINKED).waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === 'H1');
  pass('Keyboard only, link can’t be read: focus on the heading, Tab to Try again then Open recovery; Enter shows "Checking again…" and, still failing, the same screen; once the read answers, the link screen with its heading focused');

  // ── Keyboard only: focus lands on the heading, Tab to the code, type, Enter; linked → the screen goes and Bud's setup takes over ──
  mode = 'unlinked'; redeemed = [];
  await open(page);
  await heading(page, NOT_LINKED).waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === 'H1');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('label')?.textContent?.trim()), 'Link code', 'Tab reaches the link-code field');
  await page.keyboard.type(CODE);
  await page.keyboard.press('Enter');
  await heading(page, NOT_LINKED).waitFor({ state: 'detached', timeout: 30_000 });
  assert.deepEqual(redeemed, [CODE], 'one redeem with the typed code');
  pass('Keyboard only: the heading takes focus, Tab reaches "Link code", typing and Enter redeem the code once');
  await heading(page, 'Setting up Bud').waitFor({ timeout: 40_000 });
  await page.getByText('RealBud opens as soon as Bud is ready.', { exact: true }).waitFor();
  await shot(page, '1280-linked-bud-setup');
  pass('Linked: the office-link screen goes and Bud’s own setup cover takes over');

  // ── No way around it: shortcuts, deep links and Escape keep the screen ──
  mode = 'unlinked';
  const second = await session();
  await open(second.page);
  await heading(second.page, NOT_LINKED).waitFor();
  const modifier = await second.page.evaluate(() => /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform) ? 'Meta' : 'Control');
  for (const key of ['1', '2', '3', '4', 'k']) await second.page.keyboard.press(`${modifier}+${key}`);
  await second.page.keyboard.press('Escape');
  for (const hash of ['#/schedule', '#you-settings', '#/ask']) await second.page.evaluate(next => { location.hash = next; }, hash);
  await wait(500);
  await heading(second.page, NOT_LINKED).waitFor();
  await held(second.page, 'shortcuts and deep links');
  await second.page.reload();
  await heading(second.page, NOT_LINKED).waitFor();
  await held(second.page, 'a deep link reloaded');
  pass('No way around it: ⌘/Ctrl 1–4 and K, Escape, #/schedule, #you-settings and #/ask (and reloading one) keep the office-link screen, with no shell');

  // ── Recovery: the one way past, for this app session only ──
  mode = 'fail';
  await open(second.page);
  await heading(second.page, UNAVAILABLE).waitFor();
  await second.page.getByRole('button', { name: 'Open recovery', exact: true }).click();
  await statusBar(second.page).waitFor();
  await second.page.locator('#you-recovery').waitFor();
  assert.equal(new URL(second.page.url()).hash, '#you-recovery');
  await shot(second.page, '1280-open-recovery');
  await second.page.reload();
  await statusBar(second.page).waitFor();
  assert.equal(await heading(second.page, UNAVAILABLE).count(), 0, 'a reload keeps recovery open for this session');
  const third = await session();
  await open(third.page);
  await heading(third.page, UNAVAILABLE).waitFor();
  await held(third.page, 'a new app session');
  pass('Open recovery opens Workspace at #you-recovery; a reload keeps it; a new app session (fresh browser context) shows the office-link screen again');

  // ── A book in recovery is never held behind the screen ──
  mode = 'unlinked';
  const fourth = await session({ deskPatch: snapshot => ({ ...snapshot, recovery: { active: true, reason: 'Fictional: the saved key is not on this computer.', quarantined: [] } }) });
  await open(fourth.page);
  await statusBar(fourth.page).waitFor();
  await wait(1500);
  assert.equal(await heading(fourth.page, NOT_LINKED).count(), 0, 'a book in recovery opens without the office-link screen');
  const recoverySeen = await seen(fourth.page);
  assert.equal(recoverySeen.gate, undefined, `the office-link screen never showed before recovery: ${JSON.stringify(recoverySeen)}`);
  assert.equal(recoverySeen.words, undefined, 'no checking words before recovery');
  // The same detector that found no shell behind the screen does see it here.
  assert.ok(recoverySeen.shell !== undefined, `the shell detector saw the shell: ${JSON.stringify(recoverySeen)}`);
  await shot(fourth.page, '1280-book-recovery');
  pass('An unlinked computer whose book is in recovery opens the app (recovery first), never the office-link screen');

  for (const route of [...heldLinks, ...heldDesks]) await route.abort().catch(() => {});
  assert.deepEqual(errors, []);
  pass('The renderer recorded no page errors');
} catch (error) { failure = error instanceof Error ? error.stack : String(error); const page = pages.at(-1); if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(4000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), wait(4000)]); } }
  const childExited = !child || child.exitCode !== null || child.signalCode !== null;
  if (childExited) rmSync(temp, { recursive: true, force: true }); else failure ??= 'Owned child did not exit; scratch preserved.';
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure,
    layer: 'Actual local HTTP app + built UI from source; fictional office; office link, code redeem, browser approval and Bud status are fictional route replies; not live, packaged, Windows or customer proof',
    checks, errors, screenshots,
    limits: ['Every link fact is a fictional route reply over the real server: no website, office account, code or approval page exists here, and nothing reached realbud.app.',
      'Checking, a read that fails and a book read that never answers are route holds and fictional 500s over the real server; a book in recovery is a patched Desk reply, not a quarantined book.',
      'The screen is presentation only; the server stays the authority on linking and on every action, and is not exercised for refusals here.',
      'Bud’s setup after the link is a fictional status reply; no worker is installed.',
      'Mac Chrome at 1280, 768 and 390 px; no packaged build, Electron window, Windows or customer acceptance.'],
    failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks: checks.length }, null, 2));
}
