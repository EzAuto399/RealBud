#!/usr/bin/env node
// macOS clean-environment walkthrough: the path a new office (Sherry's
// MacBook) sees on first launch, through the core system, on ONE fresh temp
// REALBUD home. Built UI (dist/) in headless Chrome against the real source
// service (server/bootstrap.ts) behind a loopback-only network guard.
// Fictional data only: a loopback lab website stands in for realbud.app
// (link code redeem, status report), a fixture worker stands in for the
// runtime (Hermes version probe, OK readiness answer, scripted ACP turns), and
// a test bridge stands in for Electron main's local-session IPC and updater.
// No ~/.realbud, no /Applications, no live account, model, REI or Modelvia.
//
//   PLAYWRIGHT_MODULE=… CHROME_EXECUTABLE=… node scripts/qa-clean-walkthrough.mjs
//   (Node 24+, `pnpm exec vite build --outDir dist` first; QA_OUTPUT and
//    REALBUD_UI_DIR optional)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { readSessionToken } from './local-session.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
if (process.platform === 'win32') throw new Error('This walkthrough is the macOS clean-environment path.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = resolve(process.env.REALBUD_UI_DIR ?? join(root, 'dist'));
assert.ok(existsSync(join(uiDir, 'index.html')), `Build the UI first: no ${uiDir}/index.html`);
const DATE = new Date().toISOString().slice(0, 10);
const output = resolve(process.env.QA_OUTPUT ?? join(root, `outputs/mac-clean-walkthrough-${DATE}`));
mkdirSync(output, { recursive: true });
assert.ok(!existsSync(join(output, 'receipt.json')), `Earlier evidence at ${output} is preserved; choose a fresh QA_OUTPUT.`);

// One fresh temp home; the data dir sits where ~/.realbud would, inside it.
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-clean-walkthrough-'));
const home = join(temp, 'home'), data = join(home, '.realbud');
mkdirSync(data, { recursive: true, mode: 0o700 });
assert.notEqual(realpathSync(data), resolve(homedir(), '.realbud'), 'Never point a QA run at the real ~/.realbud');

const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const CODE = 'rb1_' + 'a1'.repeat(32), EXPIRED_CODE = 'rb1_' + 'e0'.repeat(32), FRESH_CODE = 'rb1_' + 'b2'.repeat(32);
const OFFICE = 'Fictional Harbour Agency', PERSON = 'Fictional Sherry', ADDRESS = '1 Fictional Lane, Sampleton QLD 4000';
const PAYEE = 'Fictional Strata Pty Ltd';

// ── lab website: realbud.app stand-in on loopback ─────────────────────────
// Records method + path only (bodies carry the fictional installation token).
const siteCalls = [];
let redeemFailures = 1; // the first valid redeem answers 503 so the retry path is exercised
const lab = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const path = new URL(req.url, 'http://lab').pathname;
  siteCalls.push(`${req.method} ${path}`);
  res.setHeader('content-type', 'application/json');
  if (req.method === 'POST' && path === '/api/installations/redeem') {
    const body = JSON.parse(raw);
    if (body.code === EXPIRED_CODE) { res.writeHead(409); res.end('{"error":"code_used"}'); return; }
    if (body.code === CODE && redeemFailures-- > 0) { res.writeHead(503); res.end('{"error":"fictional_outage"}'); return; }
    if (body.code !== CODE && body.code !== FRESH_CODE) { res.writeHead(404); res.end('{}'); return; }
    res.end(JSON.stringify({ installationId: body.id, companyId: 'fictional-harbour-office', agencyLabel: OFFICE, provisioning: { version: 1,
      service: { companyId: 'fictional-harbour-office', hostInstallationId: 'fictional-harbour-host' },
      connector: { endpoint: labOrigin, credential: `rbc_${'d'.repeat(64)}`, profile: 'property', apps: ['gmail'] },
      model: { provider: 'modelvia', baseUrl: 'https://model.fictional.invalid/v1', projectId: 'fictional-qa-project', keyId: 'fictional-qa-key', key: `rbk_${'f'.repeat(40)}`, spendCapLabel: 'Fictional deterministic worker only' } } }));
    return;
  }
  // Browser link: one approval page on the lab origin that stays pending until cancelled.
  if (req.method === 'POST' && path === '/api/installations/link-requests') {
    res.end(JSON.stringify({ version: 1, purpose: 'installation-link-issued', approvalUrl: `${labOrigin}/link/${'L'.repeat(43)}`, displayCode: 'ABCD-EFGH', expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    return;
  }
  if (req.method === 'POST' && (path === '/api/installations/link-requests/status' || path === '/api/installations/link-requests/cancel')) {
    res.end(JSON.stringify({ version: 1, purpose: 'installation-link-status', state: path.endsWith('cancel') ? 'declined' : 'pending', ...(path.endsWith('status') ? { expiresAt: new Date(Date.now() + 600_000).toISOString() } : {}) }));
    return;
  }
  if (path === '/api/installations/report') { res.end('{}'); return; }
  res.writeHead(404); res.end('{}');
});
lab.listen(0, '127.0.0.1'); await once(lab, 'listening');
const labOrigin = `http://127.0.0.1:${lab.address().port}`;
const redeems = () => siteCalls.filter(call => call === 'POST /api/installations/redeem').length;

// ── fixture worker: version probe, OK readiness answer, scripted ACP turns ──
const worker = join(temp, 'fictional-worker.mjs'), acpScript = join(temp, 'acp-script.json');
copyFileSync(join(root, 'server/testing/fake-acp-cli.ts'), join(temp, 'fake-acp-cli.ts'));
const script = turn => writeFileSync(acpScript, JSON.stringify(turn));
script({ reply: `Fictional prepared follow-up for ${ADDRESS}.` });
writeFileSync(worker, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('Hermes Agent v0.21.3 (2026.9.14)'); process.exit(0); }
if (process.argv.includes('acp')) { process.env.FAKE_ACP_SCRIPT = ${JSON.stringify(acpScript)}; await import(${JSON.stringify(join(temp, 'fake-acp-cli.ts'))}); }
else console.log('OK');
`, { mode: 0o700 });
// Loopback-only: every other origin throws inside the service.
writeFileSync(join(temp, 'network-guard.mjs'), `const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('QA denied non-loopback fetch to '+url.origin);return realFetch(input,init);};`, { mode: 0o600 });

// ── service ───────────────────────────────────────────────────────────────
const port = await freePort(), base = `http://127.0.0.1:${port}`;
let child, childClosed, token = '', logs = '';
const serviceEnv = (dataDir, homeDir, servicePort) => ({ ...serviceSmokeEnv({ executable: process.execPath, home: homeDir, data: dataDir, scratch: temp, port: servicePort }),
  REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', REALBUD_WEBSITE_ORIGIN: labOrigin, REALBUD_HERMES_CLI: worker, OMB_STATIC_DIR: uiDir });
async function bootService(dataDir, homeDir, servicePort) {
  const proc = spawn(process.execPath, ['--import', join(temp, 'network-guard.mjs'), join(root, 'server/bootstrap.ts')], { cwd: root, env: serviceEnv(dataDir, homeDir, servicePort), stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(r => proc.once('close', r));
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-40_000); });
  for (let i = 0; i < 200 && proc.exitCode === null; i++) {
    if ((await fetch(`http://127.0.0.1:${servicePort}/api/health`, { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null))?.pid === proc.pid) return { proc, closed, token: await readSessionToken(dataDir) };
    await wait(100);
  }
  throw new Error(`service did not start\n${logs.slice(-3000)}`);
}
async function startService() { ({ proc: child, closed: childClosed, token } = await bootService(data, home, port)); }
async function stopService(proc = child, closed = childClosed) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  proc.kill('SIGTERM'); const force = setTimeout(() => proc.kill('SIGKILL'), 8_000);
  try { await closed; } finally { clearTimeout(force); }
}
const api = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const until = async (check, label, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await wait(150); }
  throw new Error(`Timed out: ${label}`);
};

// ── browser: desktop-sized window with an Electron-like test bridge ────────
let browser, context, page;
const pageErrors = [];
let updaterInstalls = 0;
async function openWindow() {
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  // Electron main answers getLocalSession over IPC from the service's private
  // file; this bridge does the same from the harness, so a restart on the same
  // port reconnects the open window. The updater bridge is a controllable fixture.
  await context.exposeFunction('__qaLocalSession', () => token);
  await context.exposeFunction('__qaUpdaterInstall', () => { updaterInstalls++; });
  await context.addInitScript(() => {
    let state = { status: 'idle' }; const listeners = new Set();
    window.__qaSetUpdater = next => { state = next; for (const cb of listeners) cb(state); };
    window.ogb = { getLocalSession: () => window.__qaLocalSession(), updater: {
      check: async () => {}, download: async () => {}, install: async () => { await window.__qaUpdaterInstall(); },
      onState: cb => { listeners.add(cb); cb(state); return () => listeners.delete(cb); } } };
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => pageErrors.push(error.message));
}

// ── step bookkeeping ──────────────────────────────────────────────────────
const steps = [], observations = [], productFailures = [], selectorUpdates = [];
let shotIndex = 0;
const shot = async (label, target = page) => {
  const file = `${String(++shotIndex).padStart(2, '0')}-${label}.png`;
  await target.screenshot({ path: join(output, file) });
  current?.screenshots.push(file); return file;
};
let current = null;
async function step(n, name, fn) {
  current = { n, name, status: 'PASS', checks: [], screenshots: [] };
  try { await fn(current.checks); console.log(`PASS ${n}. ${name}`); }
  catch (error) {
    current.status = 'FAIL'; current.detail = error instanceof Error ? error.message.split('\n').slice(0, 4).join(' ') : String(error);
    await shot(`step${n}-failure`).catch(() => {});
    // A failed step must not leave later steps without the service.
    if (child && (child.exitCode !== null || child.signalCode)) await startService().catch(() => {});
    console.error(`FAIL ${n}. ${name}\n${error instanceof Error ? error.stack : error}`);
  }
  steps.push(current); current = null;
}
const check = (list, label) => { list.push(label); };

/** Desktop widths only: 1280 and 1024 (narrow desktop), no horizontal page scroll. */
async function widths(label) {
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 900 }); await wait(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `${label}: ${overflow}px horizontal scroll at ${width}px`);
    await shot(`${label}-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
/** Keyboard only: Tab until a control with this accessible name has focus, then Enter. */
async function pressByKeyboard(name, { key = 'Enter', max = 200 } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(wanted => {
      const el = document.activeElement; if (!el || el === document.body) return false;
      const label = (el.getAttribute('aria-label') ?? '').trim(), text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      return label === wanted || text === wanted;
    }, name);
    if (hit) { await page.keyboard.press(key); return; }
  }
  throw new Error(`Could not reach "${name}" by keyboard`);
}
/** Main path by keyboard: rail entries Desk, Work, Schedule, Workspace. */
async function railByKeyboard(name, hash) {
  await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
  await pressByKeyboard(name);
  await until(async () => new URL(page.url()).hash.startsWith(hash), `${name} opens by keyboard`, 5_000);
}
const rail = name => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true });

let failure = null;
try {
  await startService();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  await openWindow();

  await step(1, 'First run: welcome screen', async c => {
    await page.goto(base);
    await page.getByRole('heading', { name: 'Make the desk yours', exact: true }).waitFor();
    const cont = page.getByRole('button', { name: 'Continue', exact: true });
    assert.equal(await cont.isDisabled(), true, 'Continue waits for a name');
    check(c, 'Empty state: Continue is disabled until a name is entered');
    await widths('welcome');
    // Keyboard only: name field, type, Tab to Continue, Enter.
    await page.getByRole('textbox', { name: 'Your name', exact: true }).focus();
    await page.keyboard.type(PERSON);
    await pressByKeyboard('Continue');
    await page.getByRole('heading', { name: 'Connect this computer to your office', exact: true }).waitFor();
    check(c, 'Keyboard only: typed name and pressed Continue');
    await page.reload();
    await page.getByRole('heading', { name: 'Connect this computer to your office', exact: true }).waitFor();
    check(c, 'Refresh mid-flow: the connect step is kept after reload (server receipt, not a browser flag)');
    assert.deepEqual(pageErrors, []);
  });

  await step(2, 'Office link through the lab website (link code)', async c => {
    await page.getByRole('textbox', { name: 'Link code' }).fill(CODE);
    await shot('link-code');
    const connect = page.getByRole('button', { name: 'Connect with this code' });
    // Error state: the website is briefly unavailable; nothing is linked and the code can be retried.
    await connect.click();
    await page.getByText('The website could not finish linking this computer. Try again shortly.').waitFor();
    assert.equal((await api('/api/office-link')).body.state, 'pending');
    await widths('link-error');
    check(c, 'Error state: website outage shows retry copy; link stays pending, not linked');
    // Double submit: a double-click on the retry redeems exactly once.
    const before = redeems();
    await page.getByRole('textbox', { name: 'Link code' }).fill(CODE);
    await page.getByRole('button', { name: 'Connect with this code' }).dblclick();
    await page.getByRole('heading', { name: 'This computer is connected', exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(redeems() - before, 1, 'double-click redeems once');
    check(c, 'Double-submit protection: double-click on "Connect with this code" sent one redeem');
    const link = (await api('/api/office-link')).body;
    assert.equal(link.state, 'linked'); assert.equal(link.agencyLabel, OFFICE); assert.equal(link.provisioned, true);
    await page.getByText(`Connected to ${OFFICE}`, { exact: true }).first().waitFor();
    check(c, `Linked to ${OFFICE}; fictional model access provisioned`);
    await widths('linked');
  });

  await step(3, 'Bud setup status (fixture worker in place of the runtime install)', async c => {
    await pressByKeyboard('Continue to Bud setup');
    const dialog = page.getByRole('dialog', { name: 'Bud status', exact: true });
    await dialog.waitFor();
    // First run lands on Desk, where Get started lives; setup opens over it.
    assert.ok(['', '#/desk'].includes(new URL(page.url()).hash), `setup opens over Desk, not ${new URL(page.url()).hash}`);
    await wait(1500);
    await shot('bud-status-first');
    // A linked office sees the staff status view (Check again / Try setup again).
    const firstText = await dialog.innerText();
    if (/no AI access on this computer yet/.test(firstText)) {
      // Not a stale UI: the service's own status still carries the pre-link readiness receipt.
      const lastPing = (await api('/api/hermes')).body?.lastPing;
      observations.push({ step: 3, note: `Right after linking, Bud status showed the pre-link readiness result "Bud has no AI access on this computer yet…". GET /api/hermes returns ${lastPing?.ok === false && /no AI access/.test(lastPing?.detail ?? '') ? 'that same saved receipt' : 'a different receipt'} (lastPing ok=${lastPing?.ok}), so a UI refetch cannot clear it. On a real install the approved link starts automatic setup, which hides the old result while it works and replaces it with a new readiness check (server/worker-auto-setup.ts readinessPing); the fixture runtime is custom, which halts automatic setup, so the old receipt stays until the check runs.`, screenshot: current.screenshots.at(-1) });
    }
    const retry = dialog.getByRole('button', { name: 'Try setup again', exact: true });
    if (await retry.isVisible()) { await retry.click(); await wait(3000); }
    const rows = dialog.locator('dl[aria-label="Bud setup checks"] dd');
    const allReady = async () => (await rows.allInnerTexts()).every(text => text.trim() === 'Ready');
    if (!(await api('/api/hermes')).body.ready) {
      // Fixture limit: with a custom runtime, Try setup again does not run the readiness
      // check, and the staff view has no direct readiness button. Run the service's own
      // readiness check (the route the administrator button uses), then let the UI refresh.
      const ping = await api('/api/hermes/test', 'POST', {});
      observations.push({ step: 3, note: `Try setup again did not run the readiness check with the fixture runtime; the harness ran POST /api/hermes/test (status ${ping.status}, ok=${ping.body?.ok}) and then pressed Check again.` });
    }
    const checkAgain = dialog.getByRole('button', { name: /^(Check again|Checking…)$/ });
    await checkAgain.focus();
    await page.keyboard.press('Enter');
    await until(allReady, 'Bud status rows all Ready', 30_000);
    await dialog.getByRole('button', { name: 'Check again', exact: true }).waitFor();
    assert.equal(await checkAgain.evaluate(el => el === document.activeElement), true, `Focus after Check again: ${await page.evaluate(() => document.activeElement?.tagName)}`);
    check(c, 'Keyboard: focus stays on Check again while it checks and after it finishes');
    assert.equal((await api('/api/hermes')).body.ready, true);
    check(c, 'Bud status: Download Bud, Turn on approvals, Connect your office’s AI and Test Bud all Ready');
    await widths('bud-status-ready');
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'focus is inside Bud status before Escape');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    check(c, 'Keyboard: Escape closes Bud status back to Desk');
    await page.getByRole('region', { name: 'Get started', exact: true }).first().waitFor();
    check(c, 'Desk shows Get started with the next setup step');
  });

  await step(4, 'Desk: add a property, edit it, customize the desk', async c => {
    await railByKeyboard('Desk', '#/desk');
    await page.getByRole('heading', { name: 'Start your office book', exact: true }).waitFor();
    await page.getByText('No reminders. Add one below and it shows here when it\'s due.').waitFor();
    check(c, 'Empty states: linked office starts with an empty office book and no reminders');
    await widths('desk-empty');
    await page.getByRole('button', { name: 'Add properties', exact: true }).click();
    await page.getByText('No properties yet. Add a property to get started.').waitFor();
    await page.getByRole('button', { name: 'Add property', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Add a property' });
    assert.equal(await dialog.getByRole('button', { name: 'Add to book' }).isDisabled(), true, 'Add to book waits for details');
    // Refresh mid-flow: a half-filled form is not saved.
    await dialog.getByRole('textbox', { name: 'Address' }).fill(ADDRESS);
    await page.reload();
    await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
    assert.equal(((await api('/api/desk')).body.properties ?? []).length, 0, 'reload adds nothing');
    check(c, 'Refresh mid-flow: reload during Add property saves nothing and Desk recovers');
    const more = page.locator('.pm-desk-header details.desk-more').filter({ has: page.getByRole('group', { name: 'More Desk tools', exact: true, includeHidden: true }) });
    const openMore = async () => { if (!await more.evaluate(el => el.open)) await more.locator(':scope > summary').click(); };
    await openMore(); await more.getByRole('button', { name: 'Properties and imports', exact: true }).click();
    await page.getByRole('button', { name: 'Add property', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Add a property' });
    await dialog.getByRole('textbox', { name: 'Address' }).fill(ADDRESS);
    await dialog.getByRole('textbox', { name: 'Tenant' }).fill('Fictional Tenant');
    await dialog.getByRole('textbox', { name: 'Phone' }).fill('0400 000 000');
    await dialog.getByRole('spinbutton', { name: 'Weekly rent (AUD)' }).fill('550');
    await shot('add-property');
    await dialog.getByRole('button', { name: 'Add to book' }).dblclick();
    const card = page.getByRole('article', { name: ADDRESS });
    await card.waitFor();
    assert.equal((await api('/api/desk')).body.properties.length, 1, 'double-click adds one property');
    check(c, 'Add property: one property added (double-click on Add to book did not duplicate)');
    await card.getByRole('button', { name: 'Edit options' }).click();
    await card.getByRole('spinbutton', { name: 'Grace days' }).fill('5');
    await card.getByRole('button', { name: 'Save options' }).click();
    await until(async () => JSON.stringify((await api('/api/desk')).body.properties[0]).includes('"graceDays":5'), 'grace days saved');
    check(c, 'Edit: Grace days changed to 5 and saved');
    await widths('desk-property');
    // Customize desk = this build's Arrange Desk + Show/Hide + reset.
    await page.getByRole('navigation', { name: 'Desk workspace', exact: true }).getByRole('button', { name: /^Tasks\s*\d*$/ }).click();
    await openMore();
    const options = more.locator('details.desk-options');
    if (!await options.evaluate(el => el.open)) await options.locator(':scope > summary').click();
    await options.getByRole('button', { name: 'Customize desk', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Customize desk', exact: true });
    await panel.waitFor();
    assert.equal(await panel.getByRole('checkbox', { name: 'Needs you always shows', exact: true }).isDisabled(), true, 'the safety section cannot be hidden');
    check(c, 'Needs you (safety/approval section) cannot be hidden');
    const up = panel.getByRole('button', { name: 'Move Activity up', exact: true });
    await up.focus(); await page.keyboard.press('Enter');
    await panel.getByRole('checkbox', { name: 'Show Mail priorities', exact: true }).uncheck();
    await shot('customize-draft');
    await panel.getByRole('button', { name: 'Save layout', exact: true }).click();
    await panel.getByText('Desk layout saved.', { exact: true }).waitFor();
    let layout = (await api('/api/workspace-tabs')).body.state.desk.sections;
    assert.equal(layout.find(s => s.id === 'mail').visible, false, 'Mail priorities hidden');
    check(c, 'Arrange (keyboard Move up) and Hide Mail priorities saved');
    await panel.getByRole('button', { name: 'Reset to default', exact: true }).click();
    await panel.getByRole('button', { name: 'Save layout', exact: true }).click();
    await until(async () => (await api('/api/workspace-tabs')).body.state.desk.sections.every(s => s.visible), 'reset saved');
    layout = (await api('/api/workspace-tabs')).body.state.desk.sections;
    check(c, `Reset to default restores every section (${layout.map(s => s.id).join(', ')})`);
    await widths('customize-panel');
    await panel.getByRole('button', { name: 'Close Customize desk', exact: true }).click();
  });

  await step(5, 'Work: send a message and get Bud\'s answer', async c => {
    await railByKeyboard('Work', '#/ask');
    const box = page.getByRole('textbox', { name: 'Tell Bud what outcome you need' });
    await box.fill(`Prepare a repair follow-up for ${ADDRESS}.`);
    await page.reload();
    await box.waitFor();
    observations.push({ step: 5, note: `After a reload, the unsent Work draft was ${(await box.inputValue()) ? 'kept' : 'cleared'}.` });
    check(c, 'Refresh mid-flow: Work reloads on the same route with the composer ready');
    await box.fill(`Prepare a repair follow-up for ${ADDRESS}.`);
    await box.focus(); await page.keyboard.press('Enter');
    await page.getByText(`Fictional prepared follow-up for ${ADDRESS}.`, { exact: true }).waitFor({ timeout: 30_000 });
    check(c, 'Keyboard: Enter sends; the scripted fixture answer appears in the conversation');
    await widths('work-answer');
  });

  await step(6, 'Schedule: disable and enable a loop', async c => {
    await railByKeyboard('Schedule', '#/schedule');
    await page.getByRole('button', { name: /^Needs you 0/ }).click();
    await page.getByRole('button', { name: /^Needs you 0/ }).waitFor();
    await shot('schedule-needs-you-empty');
    check(c, 'Empty state: Needs you filter with no jobs');
    await page.getByRole('button', { name: /^All jobs/ }).click();
    // Error state: a workflow that needs agency setup refuses to resume and says why.
    await page.getByRole('button', { name: 'Resume: Morning priorities', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'needs current source checks and reviewed settings' }).waitFor();
    check(c, 'Error state: Morning priorities cannot resume before agency workflow setup; the reason is shown');
    await widths('schedule');
    await page.getByRole('button', { name: 'Open job: Morning money check', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Morning money check' });
    await dialog.getByRole('button', { name: 'Pause', exact: true }).focus();
    await page.keyboard.press('Enter');
    await dialog.getByText('Morning money check paused until you Resume').waitFor();
    assert.equal((await api('/api/loops')).body.loops.find(l => l.id === 'morning-arrears').enabled, false);
    const resume = dialog.getByRole('button', { name: 'Resume', exact: true });
    assert.equal(await resume.evaluate(el => el === document.activeElement), true, `Focus after Pause: ${await page.evaluate(() => document.activeElement?.tagName)}`);
    await shot('loop-paused');
    check(c, 'Disable (keyboard): Morning money check paused');
    await page.keyboard.press('Enter');
    await until(async () => (await api('/api/loops')).body.loops.find(l => l.id === 'morning-arrears').enabled === true, 'loop resumed');
    await dialog.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    check(c, 'Enable (keyboard): Morning money check resumed');
    assert.equal(await dialog.getByRole('button', { name: 'Pause', exact: true }).evaluate(el => el === document.activeElement), true, `Focus after Resume: ${await page.evaluate(() => document.activeElement?.tagName)}`);
    check(c, 'Keyboard: focus stays on the Pause/Resume button as it swaps, so Escape works without re-focusing');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    check(c, 'Keyboard: Escape closes the job');
  });

  await step(7, 'Approval card and Stop', async c => {
    script({ permission: true, reply: 'Checking with you before going further.' });
    await railByKeyboard('Work', '#/ask');
    const box = page.getByRole('textbox', { name: 'Tell Bud what outcome you need' });
    await box.fill(`Pay the fictional strata levy for ${ADDRESS}.`);
    await box.focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await box.isDisabled(), true, 'composer locks while an approval waits');
    await widths('approval-waiting');
    await pressByKeyboard('Stop this turn');
    await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ state: 'hidden' });
    await until(async () => !(await box.isDisabled()), 'composer unlocks after Stop');
    await shot('approval-stopped');
    check(c, 'Keyboard: Stop this turn closes the approval and unlocks the composer');
    script({ reply: `Fictional prepared follow-up for ${ADDRESS}.` });
    observations.push({ step: 7, note: 'The waiting card here is a generic worker tool approval (fake ACP "echo hi"). A browser payment approval card that names recipient and amount is built only by the browser broker from an owned work-browser page; no existing fixture produces one. Recipient and amount are checked on the held-payment recovery card in step 8.' });
  });

  await step(8, 'Service down, then a recovery card appears and resolves', async c => {
    await stopService();
    await page.getByRole('status').filter({ hasText: /^Reconnecting$/ }).waitFor({ timeout: 30_000 });
    check(c, 'Error state: service down shows Reconnecting');
    for (const [name, hash] of [['Desk', '#/desk'], ['Work', '#/ask'], ['Schedule', '#/schedule']]) {
      await rail(name).click(); await until(async () => new URL(page.url()).hash.startsWith(hash), `${name} while down`, 5_000);
      await wait(500); await shot(`service-down-${name.toLowerCase()}`);
    }
    check(c, 'Desk, Work and Schedule stay open while the service is down');
    // While stopped: a browser payment was pressed but its result is unverified.
    const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { join } from 'node:path';
      import { BrowserApprovalStore } from './server/browser-authority.ts';
      const store = new BrowserApprovalStore({ file: join(${JSON.stringify(data)}, 'browser-approvals.json') });
      const row = await store.create({
        kind: 'pay', origin: 'https://portal.fictional-strata.example', url: 'https://portal.fictional-strata.example/levies/pay',
        control: { ref: 'e12', label: 'button "Pay now"' },
        facts: [{ name: 'recipient', value: ${JSON.stringify(PAYEE)}, confirmed: true }, { name: 'amount', value: '1240.00', confirmed: true },
          { name: 'currency', value: 'AUD', confirmed: true }, { name: 'reference', value: 'LEVY-FICTIONAL-12', confirmed: true }],
        unconfirmed: [], observationHash: 'b'.repeat(64), fingerprint: 'a'.repeat(64), effect: 'a'.repeat(64), expiresAt: Date.now() + 120000,
        summary: 'Pay AUD 1240.00 to ${PAYEE}',
      }, { grantId: 'grant-fictional', runId: 'run-fictional', threadId: 'thread-fictional' }, 'pending');
      await store.update(row.id, { decision: 'approved', decidedAt: Date.now(), outcome: 'unverified' });
    `], { cwd: root, env: serviceEnv(data, home, port), encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    await startService();
    await page.getByRole('status').filter({ hasText: /^App connected$/ }).waitFor({ timeout: 30_000 });
    check(c, 'Service back on the same port: the open window reconnects without reload');
    await rail('Work').click();
    const held = page.getByRole('region', { name: 'Check a step on portal.fictional-strata.example' });
    await held.waitFor({ timeout: 30_000 });
    const text = await held.innerText();
    for (const want of [`Did the A$1,240.00 payment to ${PAYEE} go through?`, 'LEVY-FICTIONAL-12']) assert.ok(text.includes(want), `held card shows ${want}`);
    check(c, 'Recovery card names the payee, amount and reference');
    await widths('recovery-card');
    await held.getByRole('button', { name: 'It didn\'t happen' }).focus();
    await page.keyboard.press('Enter');
    await held.waitFor({ state: 'detached' });
    await page.getByText('Recorded as not done.', { exact: false }).waitFor();
    assert.deepEqual((await api('/api/browser/held')).body.steps, []);
    await shot('recovery-resolved');
    check(c, 'Keyboard: "It didn\'t happen" resolves the card and clears the hold');
  });

  await step(9, 'Workspace: Settings & help', async c => {
    await railByKeyboard('Workspace', '#/you');
    await page.getByRole('heading', { name: 'Workspace', exact: true, level: 1 }).waitFor();
    const settings = page.locator('details').filter({ hasText: 'Settings & help' }).last();
    await settings.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
    await until(async () => settings.evaluate(el => el.open), 'Settings & help opens');
    await wait(500);
    check(c, 'Keyboard: Settings & help opens from Workspace');
    await widths('workspace-settings');
  });

  await step(10, 'Restart: everything is kept', async c => {
    const before = { link: (await api('/api/office-link')).body, desk: (await api('/api/desk')).body, layout: (await api('/api/workspace-tabs')).body.state.desk.sections, loops: (await api('/api/loops')).body.loops };
    await stopService(); await startService();
    await page.reload();
    await page.getByRole('status').filter({ hasText: /^App connected$/ }).waitFor({ timeout: 30_000 });
    const link = (await api('/api/office-link')).body, desk = (await api('/api/desk')).body;
    assert.equal(link.state, 'linked'); assert.equal(link.agencyLabel, before.link.agencyLabel);
    assert.equal(desk.properties.length, 1); assert.ok(JSON.stringify(desk.properties[0]).includes('"graceDays":5'), 'edit kept');
    assert.deepEqual((await api('/api/workspace-tabs')).body.state.desk.sections, before.layout);
    assert.deepEqual((await api('/api/loops')).body.loops.map(l => [l.id, l.enabled]), before.loops.map(l => [l.id, l.enabled]));
    assert.equal((await api('/api/onboarding')).body.stage, 'complete');
    check(c, 'Office link, property and its edit, desk layout, loop states and finished welcome are kept');
    await rail('Work').click();
    await page.getByText(`Fictional prepared follow-up for ${ADDRESS}.`, { exact: true }).waitFor();
    check(c, 'Work conversation is kept');
    assert.equal((await api('/api/hermes')).body.ready, true, 'Bud still ready after restart');
    check(c, 'Bud readiness is kept');
    await rail('Desk').click();
    await widths('after-restart-desk');
  });

  await step(11, 'Update banner: deferred restart', async c => {
    await page.evaluate(() => window.__qaSetUpdater({ status: 'downloaded', version: '9.9.9-fictional', deferred: 'busy', message: 'Bud is still working. RealBud will restart to update when the work finishes.' }));
    const banner = page.getByRole('status').filter({ hasText: '9.9.9-fictional is ready' });
    await banner.waitFor();
    await banner.getByText('Bud is still working. RealBud will restart to update when the work finishes.').waitFor();
    await widths('update-deferred');
    await banner.getByRole('button', { name: 'Restart to update' }).click();
    assert.equal(updaterInstalls, 1);
    check(c, 'Deferred copy shown; Restart to update hands off to the updater once');
    await banner.getByRole('button', { name: 'Dismiss update notice' }).click();
    await banner.waitFor({ state: 'hidden' });
    check(c, 'Dismiss hides the notice');
  });

  await step(12, 'Second clean computer: expired link code, then a fresh code', async c => {
    // Separate fresh home: the main office is already linked.
    const home2 = join(temp, 'home-2'), data2 = join(home2, '.realbud'); mkdirSync(data2, { recursive: true, mode: 0o700 });
    const port2 = await freePort();
    const second = await bootService(data2, home2, port2);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(([key, value]) => sessionStorage.setItem(key, value), ['realbud.localSession', second.token]);
    await ctx.route('**/*', route => new URL(route.request().url()).origin === `http://127.0.0.1:${port2}` ? route.continue() : route.abort());
    const p2 = await ctx.newPage(); p2.setDefaultTimeout(15_000);
    try {
      await p2.goto(`http://127.0.0.1:${port2}`);
      await p2.getByRole('textbox', { name: 'Your name', exact: true }).fill('Fictional Second Person');
      await p2.getByRole('button', { name: 'Continue', exact: true }).click();
      await p2.getByRole('textbox', { name: 'Link code' }).fill(EXPIRED_CODE);
      await p2.getByRole('button', { name: 'Connect with this code' }).click();
      await p2.getByText('This code is expired or already used. Get a new code from your account owner, then paste it here.').waitFor();
      await shot('expired-code', p2);
      check(c, 'Error state: an expired code says to get a new code');
      // The browser link is not blocked by the refused code: start it, then cancel it.
      await p2.getByRole('button', { name: 'I’m the office owner: approve in my browser', exact: true }).click();
      await p2.getByText('Code on this computer').waitFor();
      await p2.getByRole('button', { name: 'Cancel', exact: true }).click();
      await p2.getByRole('button', { name: 'I’m the office owner: approve in my browser', exact: true }).waitFor();
      assert.equal((await fetch(`http://127.0.0.1:${port2}/api/office-link`, { headers: { 'x-realbud-session': second.token } }).then(r => r.json())).state, 'unlinked');
      check(c, 'Browser link after an expired code: starts, shows its code, and cancels back to unlinked');
      const field = p2.getByRole('textbox', { name: 'Link code' });
      await field.fill(FRESH_CODE);
      await p2.getByRole('button', { name: 'Connect with this code' }).click();
      const linked = p2.getByRole('heading', { name: 'This computer is connected', exact: true });
      const outcome = await Promise.race([linked.waitFor({ timeout: 20_000 }).then(() => 'linked'), p2.getByRole('alert').filter({ hasText: /still finishing|original code|cancel the pending link/i }).waitFor({ timeout: 20_000 }).then(() => 'refused')]).catch(() => 'unknown');
      const file = await shot('fresh-code-after-expired', p2);
      if (outcome !== 'linked') {
        const text = (await p2.locator('[data-connect-office]').innerText().catch(() => '')).replace(/\s+/g, ' ');
        productFailures.push({ step: 12, title: 'A fresh link code is refused after an expired one', expected: 'After "This code is expired or already used. Get a new code…", pasting the new code links the computer.', observed: text.slice(0, 400), screenshot: file });
        throw new Error(`Fresh code after an expired code: ${outcome}. ${text.slice(0, 200)}`);
      }
      check(c, 'A fresh code links after an expired one');
    } finally { await ctx.close().catch(() => {}); await stopService(second.proc, second.closed); }
  });

  await step(13, 'No renderer page errors', async () => { assert.deepEqual(pageErrors, []); });
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
} finally {
  await browser?.close().catch(() => {});
  await stopService().catch(() => {});
  await new Promise(r => lab.close(r));
  const passed = !failure && steps.length > 0 && steps.every(s => s.status === 'PASS');
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    at: new Date().toISOString(), passed,
    layer: 'local tests: built React UI (dist/) in headless Chrome against the real source service on one fresh temp home; loopback lab website, fixture worker and test desktop bridge',
    platform: `${process.platform} ${process.arch}, Node ${process.version}`,
    steps: steps.map(({ n, name, status, detail, checks, screenshots }) => ({ n, name, status, ...(detail ? { detail } : {}), checks, screenshots })),
    productFailures, observations, selectorUpdates,
    rendererPageErrors: pageErrors,
    labWebsiteCalls: siteCalls,
    ...(failure ? { failure } : {}),
    limits: [
      'Fictional office, person, property and payee only; not customer acceptance.',
      'Source service plus built renderer in headless Chrome, not the packaged or installed RealBud.app; no notarization, Gatekeeper or Electron window.',
      'realbud.app is a loopback lab website: link-code redeem, status report, and a browser link request that is started and cancelled (never approved). No real account, no real Modelvia key, no model call.',
      'The runtime is a fixture worker (version probe, OK readiness answer, scripted ACP turns). REALBUD_HERMES_CLI marks it custom, so automatic runtime install is halted, not exercised; qa-first-install covers the install UI with stubbed responses.',
      'Electron main is replaced by a test bridge for the local session token and the updater state; the update banner is driven by a fixture, not electron-updater.',
      'The approval card is a generic worker tool approval. A browser payment approval card with recipient and amount needs the owned work browser and broker; not produced here.',
      'Desktop widths 1280 and 1024 only (no phone layouts by product direction).',
      'Built on origin/main a4849b1 plus claude/fix-link-dead-end: Desk customization is "Customize desk" (Move up/down, Show checkboxes, Reset to default). Arrange Desk / Reset to recommended from the desktop-shell branch are not on this base.',
    ],
  }, null, 2));
  if (!passed) writeFileSync(join(output, 'service.log'), logs.slice(-20_000));
  try { rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (cause) { console.warn(`Temp home not removed: ${temp} (${cause.code ?? cause.message})`); }
  console.log(`${passed ? 'PASSED' : 'FAILED'}: ${steps.filter(s => s.status === 'PASS').length}/${steps.length} steps · receipt ${join(output, 'receipt.json')}`);
  if (!passed) process.exitCode = 1;
}
