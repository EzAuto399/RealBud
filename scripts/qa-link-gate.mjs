#!/usr/bin/env node
// The office-link screen on the actual local HTTP service + built React UI,
// fictional office in a throwaway home/data folder (never ~/.realbud). No mail,
// model, website or network call: the office link, its redeem answer, the
// browser approval and Bud's status are fictional route replies over the real
// server's own answers.
//
// Renders the screen not linked, disconnected (revoked), waiting for browser
// approval and at the computer limit at 1280, 768 and 390 px; walks it by
// keyboard to a link (the screen goes and Bud's setup cover takes over); and
// checks the exit: the sample desk shows, a reload keeps it, a new browser
// context (a new app session) asks again.
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
const CODE = 'FICTIONAL-LINK-CODE-0001';
const CAP = 'This office already has 5 computers. Disconnect one to pair another. Your code is kept: once your account owner disconnects a computer under Account → Computers on realbud.app, try this same code again.';
const WIDTHS = [[1280, 900], [768, 1024], [390, 844]];
/** `mode` is this computer's fictional link: what GET /api/office-link answers and what a pasted code does. */
let mode = 'unlinked', redeemed = [];
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
  /** A fresh app session: its own browser context, the office-link screen kept (not pre-left). */
  const session = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await primeBrowserSession(context, base, token, { linkGate: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await context.route('**/api/office-link', route => {
      if (route.request().method() === 'POST') {
        redeemed.push(JSON.parse(route.request().postData() || '{}').code);
        if (mode === 'cap') return json(route, { error: CAP, code: 'installation_limit' }, 409);
        mode = 'linked';
        return json(route, linked);
      }
      if (mode === 'linked') return json(route, linked);
      if (mode === 'revoked') return json(route, { state: 'revoked', revokedAt: '2026-10-09T00:00:00.000Z' });
      if (mode === 'pending') return json(route, { state: 'pending', browser: approval });
      return json(route, { state: 'unlinked' });
    });
    await context.route('**/api/office-link/browser-link', route => json(route, { state: 'pending', ...approval }));
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
  const fits = async (page, locator, label) => {
    const box = await locator.boundingBox(), height = page.viewportSize().height;
    assert.ok(box && box.y >= 0 && box.y + box.height <= height, `${label} is not on the first screen: ${JSON.stringify(box)} of ${height}px`);
  };
  const noSideScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: horizontal scroll`);

  // ── Each state at each width ──
  const { page } = await session();
  const states = [
    ['not-linked', 'unlinked', NOT_LINKED, 'Explore the sample desk'],
    ['revoked', 'revoked', REVOKED, 'Open saved work without Bud'],
    ['pending-approval', 'pending', NOT_LINKED, 'Explore the sample desk'],
    ['computer-limit', 'cap', NOT_LINKED, 'Explore the sample desk'],
  ];
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    for (const [name, linkMode, title, exit] of states) {
      mode = linkMode;
      await page.goto(`${base}/#/desk`); await page.reload();
      await heading(page, title).waitFor();
      assert.equal(await page.getByRole('contentinfo', { name: 'Status bar' }).count(), 0, `${name}: the shell waits behind the office-link screen`);
      const leave = page.getByRole('button', { name: exit, exact: true });
      assert.ok(await leave.isVisible(), `${name}: exit "${exit}"`);
      let action;
      if (name === 'pending-approval') {
        await page.getByText('Waiting for your approval…', { exact: false }).waitFor();
        await page.getByText(/Expires in \d+:\d\d/).waitFor();
        await page.getByText(approval.displayCode, { exact: true }).first().waitFor();
        action = page.getByRole('button', { name: 'Cancel', exact: true });
        assert.ok(await page.getByRole('button', { name: 'Open the page again', exact: true }).isVisible());
      } else {
        action = page.getByRole('button', { name: 'Connect with this code', exact: true });
        // The heading says it once; the card doesn't repeat it.
        if (name === 'revoked') assert.equal(await page.getByText('This computer was removed from your office.', { exact: false }).count(), 0);
        if (name === 'computer-limit') {
          await page.getByRole('textbox', { name: 'Link code' }).fill(CODE);
          await action.click();
          await page.getByRole('alert').filter({ hasText: 'already has 5 computers' }).waitFor();
          assert.equal(await page.getByRole('textbox', { name: 'Link code' }).inputValue(), CODE, 'the refused code is kept');
          assert.ok(await page.getByRole('button', { name: 'Copy request for your owner', exact: true }).isVisible(), 'the owner hand-off is on screen');
          await heading(page, title).scrollIntoViewIfNeeded();
        }
      }
      if (width === 390) { await fits(page, heading(page, title), `${name} heading at 390`); await fits(page, action, `${name} primary action at 390`); }
      await noSideScroll(page, `${name} at ${width}`);
      await shot(page, `${width}-${name}`);
      pass(`${width}px ${name}: "${title}" replaces the shell, with ${name === 'pending-approval' ? 'the approval code, time left, Open the page again and Cancel' : name === 'computer-limit' ? 'the website’s limit sentence, the code kept and Copy request for your owner' : 'the link-code entry'} and "${exit}"; no horizontal scroll${width === 390 ? '; heading and action on the first screen' : ''}`);
    }
  }

  // ── Keyboard only: focus lands on the heading, Tab to the code, type, Enter; linked → the screen goes and Bud's setup takes over ──
  await page.setViewportSize({ width: 1280, height: 900 });
  mode = 'unlinked'; redeemed = [];
  await page.goto(`${base}/#/desk`); await page.reload();
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

  // ── The exit: sample desk now, kept on reload, asked again in a new app session ──
  mode = 'unlinked';
  const second = await session();
  await second.page.goto(`${base}/#/desk`);
  await heading(second.page, NOT_LINKED).waitFor();
  await second.page.getByRole('button', { name: 'Explore the sample desk', exact: true }).click();
  const bar = second.page.getByRole('contentinfo', { name: 'Status bar' });
  // The status bar's setup item proves the link read answered not linked while the shell shows.
  await bar.getByRole('button', { name: 'Setup 1 of 5 · Paste the link code your office sent you', exact: true }).waitFor();
  await second.page.getByRole('region', { name: 'Get started', exact: true }).first().waitFor();
  await shot(second.page, '1280-exit-sample-desk');
  await second.page.reload();
  await bar.getByRole('button', { name: 'Setup 1 of 5 · Paste the link code your office sent you', exact: true }).waitFor();
  assert.equal(await heading(second.page, NOT_LINKED).count(), 0, 'a reload keeps the choice for this session');
  pass('Exit: "Explore the sample desk" opens Desk with Get started; a reload keeps the choice');
  const third = await session();
  await third.page.goto(`${base}/#/desk`);
  await heading(third.page, NOT_LINKED).waitFor();
  await shot(third.page, '1280-next-session');
  pass('A new app session (fresh browser context) shows the office-link screen again');

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
      'The screen is presentation only; the server stays the authority on linking and on every action, and is not exercised for refusals here.',
      'Bud’s setup after the link is a fictional status reply; no worker is installed.',
      'Mac Chrome at 1280, 768 and 390 px; no packaged build, Electron window, Windows or customer acceptance.'],
    failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks: checks.length }, null, 2));
}
