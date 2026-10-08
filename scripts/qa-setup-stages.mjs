#!/usr/bin/env node
// Setup stages on the actual local HTTP service + built React UI, fictional
// office in a throwaway home/data folder (never ~/.realbud). No mail, model,
// bank, REI or network call: the office link, Bud's status, the role pack,
// connected apps, REI sign-in, the loops and the config flags are fictional
// route replies over the real server's own answers.
//
// Walks stage 0 (not linked) → 1 (Bud installing) → 2 (pack to import) →
// 3 (REI sign-in) → 4 (workflows off) → ready, then revoked, AI limit and Gmail
// lost. At each: Desk, Work, Schedule, Connected apps and the status bar, by
// role and name — the disabled control, its reason and a working fix.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-setup-stages.mjs
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
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud setup stages QA '));
const data = join(temp, 'data'), output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/setup-stages-2026-10-09'));
mkdirSync(data, { mode: 0o700 }); mkdirSync(output, { recursive: true });
const checks = [], errors = [], screenshots = [], wait = ms => new Promise(r => setTimeout(r, ms));
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const until = async (check, label, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check().catch(() => false)) return; await wait(100); } throw new Error(`Timed out: ${label}`); };

const CONNECT_FIRST = 'Connect this computer to your office first.';
const PACK_LOOPS = ['maintenance-review', 'rei-supplier-check'];
/** What each stage should show. `gate` is Schedule's Switch on for Owner letter (not a pack job); `apps` is Connected apps. */
const STAGES = {
  0: { status: 'Setup 1 of 5 · Paste the link code your office sent you', gate: CONNECT_FIRST, fix: 'Enter link code', apps: CONNECT_FIRST, packJobs: false },
  1: { status: 'Setup 3 of 5 · Import your office’s pack', gate: 'Bud is setting itself up — step 2 of 4', fix: 'See progress', apps: 'Bud is setting itself up — step 2 of 4', packJobs: false },
  2: { status: 'Setup 3 of 5 · Import your office’s pack', gate: null, apps: null, packJobs: false },
  3: { status: 'Setup 4 of 5 · Connect what your workflows read', gate: null, apps: null, packJobs: true },
  4: { status: 'Setup 5 of 5 · Review and switch on your workflows', gate: null, apps: null, packJobs: true },
  ready: { status: null, gate: null, apps: null, packJobs: true },
  revoked: { status: 'Office access stopped', gate: CONNECT_FIRST, fix: 'Enter link code', apps: CONNECT_FIRST, packJobs: true },
  aiLimit: { status: 'AI allowance used', gate: 'Your office has used this month’s AI allowance.', fix: 'Copy request for your owner', apps: null, packJobs: true },
  gmailLost: { status: 'Gmail needs attention', gate: null, apps: null, packJobs: true },
};
let stage = '0', reiPosts = 0;
const after = s => ['ready', 'revoked', 'aiLimit', 'gmailLost'].includes(s);
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
  const request = async (path, method = 'GET', body, expected = 200) => { const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await res.json(); assert.equal(res.status, expected, `${path}: ${JSON.stringify(value)}`); return value; };
  await completeFictionalOnboarding(request);
  // Owner letter starts on; switch it off so its drawer offers Switch on / Resume.
  const owner = (await request('/api/loops/owner-letter', 'PATCH', { enabled: false })).loop;
  assert.equal(owner?.enabled, false, 'Owner letter is off');

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await primeBrowserSession(context, base, token);
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const patch = (fn) => async route => { const response = await route.fetch(); const body = await response.json(); await route.fulfill({ response, json: fn(body) }); };

  // ── Fictional route replies, by stage ──
  await context.route('**/api/office-link', route => {
    if (stage === '0') return json(route, { state: 'unlinked' });
    if (stage === 'revoked') return json(route, { state: 'revoked' });
    return json(route, { state: 'linked', label: 'Fictional Accounts computer', agencyLabel: 'Fictional Harbour Agency', lastReportedAt: '2026-10-08T00:00:00.000Z',
      ...(stage === 'aiLimit' ? { usage: { state: 'ready', usage: { period: '2026-10', usedNanoAud: '5000000000', limitNanoAud: '5000000000', remainingNanoAud: '0' } } } : {}) });
  });
  await context.route('**/api/hermes', patch(body => {
    const { autoSetup: _drop, ...rest } = body;
    if (stage === '0') return { ...rest, ready: false, restartRequired: false };
    if (stage === '1') return { ...rest, ready: false, restartRequired: false, autoSetup: { state: 'installing', code: 'installing', step: 2, total: 4, detail: 'Fictional: installing Bud' } };
    return { ...rest, ready: true, readyOnce: true, restartRequired: false };
  }));
  await context.route('**/api/austin-pack', patch(view => {
    if (['0', '1', '2'].includes(stage)) return view;
    const done = { gmail: true, rei: stage !== '3', tenants: stage !== '3', suppliers: stage !== '3', redbark: true, workflows: after(stage) };
    return { ...view, installed: { revision: 1, at: 1, loopIds: PACK_LOOPS }, loops: view.loops.filter(loop => PACK_LOOPS.includes(loop.loopId)), checklist: view.checklist.map(item => ({ ...item, done: done[item.id] ?? item.done })) };
  }));
  await context.route('**/api/loops', patch(body => after(stage)
    ? { ...body, loops: body.loops.map(loop => PACK_LOOPS.includes(loop.id) ? { ...loop, enabled: true, available: true, nextRunAt: Date.now() + 86_400_000 } : loop) }
    : body));
  await context.route('**/api/config', patch(body => ({ ...body, composio: { ...body.composio, configured: true, managed: true } })));
  // The app's office-source store reads POST /check; /status answers the same fictional reply.
  await context.route(/\/api\/connected-apps\/(?:status|check)$/, route => json(route, {
    configured: true, checkedAt: new Date().toISOString(), sourceKind: 'personal', policyRevision: 1,
    services: { gmail: stage === 'gmailLost'
      ? { connected: false, status: 'EXPIRED', accounts: [], accountSelectionRequired: false }
      : { connected: true, status: 'ACTIVE', accounts: [{ id: 'fictional-mail', status: 'ACTIVE', label: 'fictional@example.test' }], accountSelectionRequired: false } },
    tools: { available: stage !== 'gmailLost', names: stage === 'gmailLost' ? [] : ['GMAIL_GET_PROFILE'] },
  }));
  await context.route('**/api/rei/sign-in', route => {
    if (route.request().method() === 'POST') reiPosts++;
    const signedIn = !['0', '1', '2', '3'].includes(stage);
    return json(route, { state: signedIn ? 'signed_in' : 'needed', at: signedIn ? Date.now() - 60_000 : null, used: signedIn, signingIn: route.request().method() === 'POST', waiting: [] });
  });

  page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', error => errors.push(`${stage}: ${error.message}`));
  const shot = async (name) => { const path = join(output, `${name}.png`); await page.screenshot({ path }); screenshots.push(path); };
  const open = async (hash) => {
    await page.goto(`${base}/${hash}`); await page.reload();
    // Bud's first setup covers the shell while it installs; the cover offers the sample desk meanwhile.
    const explore = page.getByRole('button', { name: 'Explore the sample desk', exact: true });
    if (stage === '1') { await explore.click(); await explore.waitFor({ state: 'hidden' }); }
    await page.getByRole('contentinfo', { name: 'Status bar' }).waitFor();
  };
  const statusBar = () => page.getByRole('contentinfo', { name: 'Status bar' });

  for (const width of [1280, 960]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, want] of Object.entries(STAGES)) {
      stage = name;
      const tag = `${width}-stage-${name}`;
      // Desk: the status bar's one setup item, else the most serious degraded state, else nothing.
      await open('#/desk');
      const bar = statusBar();
      if (want.status) await bar.getByRole('button', { name: want.status, exact: true }).waitFor();
      await until(async () => (await bar.getByText(/^Setup \d of 5/).count()) === (want.status?.startsWith('Setup') ? 1 : 0), `${tag}: one setup item`);
      await page.getByRole('region', { name: 'Get started', exact: true }).first().waitFor();
      await shot(`${tag}-desk`);
      // Work opens (its own gating is packet B's; not asserted here).
      await page.evaluate(() => { location.hash = '#/ask'; });
      await page.locator('.ask-composer textarea').first().waitFor();
      await shot(`${tag}-work`);
      // Schedule: pack jobs stay out of the list until the pack is imported; Owner letter's switch reads setup's gate.
      await open('#/schedule');
      await page.getByRole('list', { name: 'Jobs', exact: true }).waitFor();
      const packRow = page.getByRole('button', { name: 'Open job: Supplier list check', exact: true });
      if (want.packJobs) await packRow.waitFor();
      else { await until(async () => (await page.getByText('Loading jobs…', { exact: true }).count()) === 0, 'pack read answered'); assert.equal(await packRow.count(), 0, `${tag}: pack jobs hidden until imported`); }
      await page.evaluate(() => { location.hash = 'job-owner-letter'; });
      const drawer = page.getByRole('article', { name: `${owner.name} details`, exact: true });
      await drawer.waitFor();
      const switchOn = drawer.getByRole('button', { name: /^(Resume|Switch on)$/ });
      await until(async () => (await switchOn.isDisabled()) === Boolean(want.gate), `${tag}: Switch on ${want.gate ? 'held' : 'open'}`);
      if (want.gate) {
        await drawer.getByText(want.gate, { exact: false }).first().waitFor();
        assert.ok(await drawer.getByRole('button', { name: want.fix, exact: true }).isEnabled(), `${tag}: fix ${want.fix}`);
      }
      await shot(`${tag}-schedule`);
      await page.getByRole('button', { name: `Close ${owner.name}`, exact: true }).click();
      if (name === '3') {
        // The pack's own need (the supplier list) holds Maintenance checks' switch, with its reason.
        await page.evaluate(() => { location.hash = 'job-maintenance-review'; });
        const held = page.getByRole('article', { name: 'Maintenance checks details', exact: true });
        assert.ok(await held.getByRole('button', { name: /^(Resume|Switch on)$/ }).isDisabled(), 'stage 3: Maintenance checks held');
        await held.getByText('Before Maintenance checks: In Bills, Maintenance checks, choose Refresh from REI to save the supplier list.', { exact: true }).waitFor();
        await shot(`${tag}-schedule-pack-need`);
        await page.getByRole('button', { name: 'Close Maintenance checks', exact: true }).click();
        // REI's first sign-in is step 4's: setup's gates never hold a switch for it (NOT_A_WORKFLOW_BLOCKER).
        await page.evaluate(() => { location.hash = 'job-rei-supplier-check'; });
        const rei = page.getByRole('article', { name: 'Supplier list check details', exact: true });
        assert.ok(await rei.getByRole('button', { name: /^(Resume|Switch on)$/ }).isEnabled(), 'stage 3: Supplier list check is not held for REI sign-in');
        await page.getByRole('button', { name: 'Close Supplier list check', exact: true }).click();
      }
      if (name === 'gmailLost') {
        // Only the run that reads Gmail waits, with Connected apps as the fix.
        await page.evaluate(() => { location.hash = 'job-maintenance-review'; });
        const mail = page.getByRole('article', { name: 'Maintenance checks details', exact: true });
        assert.ok(await mail.getByRole('button', { name: 'Run now', exact: true }).isDisabled(), 'Gmail lost: Maintenance checks Run now held');
        await mail.getByText('Gmail needs attention in Connected apps.', { exact: false }).first().waitFor();
        assert.ok(await mail.getByRole('button', { name: 'Open Connected apps', exact: true }).isEnabled());
        await shot(`${tag}-schedule-gmail-lost`);
        await page.getByRole('button', { name: 'Close Maintenance checks', exact: true }).click();
      }
      // Connected apps: Connect reads setup's connectApps gate.
      await open('#you-connected-apps');
      await page.getByRole('heading', { name: 'Work apps', exact: true }).waitFor();
      const custom = page.getByRole('textbox', { name: 'App to connect', exact: true });
      await custom.waitFor();
      // The app check settles first; then Connect reads the gate.
      await until(async () => (await custom.isDisabled()) === Boolean(want.apps), `${tag}: Connect ${want.apps ? 'held' : 'open'}`);
      if (want.apps) await page.getByText(want.apps, { exact: false }).first().waitFor();
      await shot(`${tag}-connected-apps`);
      pass(`${width}px stage ${name}: status bar ${want.status ? `"${want.status}"` : 'shows normal facts only'}; Schedule Switch on ${want.gate ? 'held with reason and fix' : 'open'}; pack jobs ${want.packJobs ? 'listed' : 'hidden'}; Connect ${want.apps ? 'held with reason' : 'open'}; Work opens`);

      if (width !== 1280) continue;
      // Each fix works where it is offered (desktop width once).
      if (name === '0' || name === 'revoked') {
        await open('#/schedule'); await page.evaluate(() => { location.hash = 'job-owner-letter'; });
        await page.getByRole('article', { name: `${owner.name} details`, exact: true }).getByRole('button', { name: 'Enter link code', exact: true }).click();
        await page.locator('#you-website-code').waitFor();
        await open('#/desk');
        await statusBar().getByRole('button', { name: want.status, exact: true }).click();
        await page.locator('#you-website-code').waitFor();
        await shot(`${tag}-fix-link-code`);
        pass(`stage ${name}: Schedule's "Enter link code" and the status bar item both open the link-code field`);
      }
      if (name === '1') {
        await open('#/schedule'); await page.evaluate(() => { location.hash = 'job-owner-letter'; });
        await page.getByRole('article', { name: `${owner.name} details`, exact: true }).getByRole('button', { name: 'See progress', exact: true }).click();
        await page.getByRole('dialog', { name: 'Bud status' }).waitFor();
        await shot(`${tag}-fix-bud-progress`);
        await open('#/desk');
        await statusBar().getByRole('button', { name: want.status, exact: true }).click();
        await page.getByRole('dialog').getByRole('region', { name: 'Packs from your office', exact: true }).waitFor();
        pass('stage 1: "See progress" opens Bud status; the status bar item opens packs from your office');
      }
      if (name === '3') {
        await open('#/desk');
        const before = reiPosts;
        await statusBar().getByRole('button', { name: want.status, exact: true }).click();
        await until(async () => reiPosts === before + 1, 'REI sign-in requested');
        pass('stage 3: the status bar item opens REI’s own sign-in page (one sign-in request)');
      }
      if (name === 'aiLimit') {
        await open('#/schedule'); await page.evaluate(() => { location.hash = 'job-owner-letter'; });
        const copy = page.getByRole('article', { name: `${owner.name} details`, exact: true }).getByRole('button', { name: 'Copy request for your owner', exact: true });
        await copy.click();
        await page.getByRole('article', { name: `${owner.name} details`, exact: true }).getByText('Copied', { exact: true }).waitFor();
        await shot(`${tag}-fix-owner-request`);
        pass('AI limit: Switch on held with the owner request, which copies');
      }
      if (name === 'gmailLost') {
        await open('#/desk');
        await statusBar().getByRole('button', { name: want.status, exact: true }).click();
        await page.getByRole('heading', { name: 'Work apps', exact: true }).waitFor();
        pass('Gmail lost: the status bar item opens Connected apps');
      }
    }
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll at 960px');
  assert.deepEqual(errors, []);
  pass('No horizontal scroll at 960px; the renderer recorded no page errors');
} catch (error) { failure = error instanceof Error ? error.stack : String(error); if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(4000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), wait(4000)]); } }
  const childExited = !child || child.exitCode !== null || child.signalCode !== null;
  if (childExited) rmSync(temp, { recursive: true, force: true }); else failure ??= 'Owned child did not exit; scratch preserved.';
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure,
    layer: 'Actual local HTTP app + built UI from source; fictional office; office link, Bud status, role pack, connected apps, REI sign-in, loops and config flags are fictional route replies; not live, packaged, Windows or customer proof',
    checks, errors, screenshots,
    limits: ['Every stage fact is a fictional route reply over the real server: no real office link, worker, Gmail, REI or AI allowance exists here.',
      'Work is only opened, not asserted: its setup gating belongs to packet B and is not on this branch.',
      'Gates are presentation only; the server stays the authority on each action and is not exercised for refusals here.',
      'Desktop widths 1280 and 960 only (desktop-only product); Mac Chrome rendering; no packaged build, Windows or customer acceptance.'],
    failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks: checks.length }, null, 2));
}
