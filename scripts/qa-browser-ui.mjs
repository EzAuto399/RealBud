// Real server authentication and rendered settings. Browser states are synthetic; no personal browser is accessed.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'outputs/browser-integration-2026-09-20');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'rb-browser-ui-'));
let child, browser;
let logs = '';
try {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const data = join(temp, 'data'); mkdirSync(data);
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { ghost: { driver: 'not-a-real-driver', displayName: 'Offline fixture' } } }));
  const worker = join(temp, 'worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.3 (2026.9.14)');\n`); chmodSync(worker, 0o755);
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.REALBUD_SERVER_EXECUTABLE || process.execPath, [process.env.REALBUD_SERVER_ENTRY || join(root, 'server/index.ts')], { cwd: root,
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, REALBUD_HERMES_CLI: worker, OMB_PORT: String(port), OMB_STATIC_DIR: process.env.REALBUD_UI_DIR || join(root, 'dist'), ELECTRON_RUN_AS_NODE: '1', VITEST: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, logs.slice(-1500));
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1024 } });
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  assert.equal((await fetch(origin + '/api/browser')).status, 401);
  assert.equal((await fetch(origin + '/api/browser/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const token = (await (await fetch(origin + '/api/session')).json()).token;
  const current = await fetch(origin + '/api/browser', { headers: { 'x-realbud-session': token } });
  assert.equal(current.status, 200);
  assert.equal((await current.json()).enabled, false);
  const base = { state: 'off', enabled: false, detail: 'Browser access is off on this computer.', browsers: [], selectedBrowserId: null, active: false, checkedAt: Date.now(), version: '0.3.0', port: 52800 };
  let status = { ...base }; const mutations = [];
  await page.route('**/api/browser', route => route.fulfill({ json: status }));
  await page.route('**/api/browser/*', async route => {
    const action = new URL(route.request().url()).pathname.split('/').pop(); mutations.push(action);
    if (action === 'connect') status = { ...status, enabled: true, state: 'extension_needed', detail: 'Add and enable the extension in your work browser, then check the connection.' };
    if (action === 'select') { assert.equal(route.request().postDataJSON().browserId, 'practice-chrome'); status = { ...status, state: 'ready', selectedBrowserId: 'practice-chrome', detail: 'Chrome is connected for this computer. Start a saved job when you are ready.' }; }
    if (action === 'stop') status = { ...status, active: false, state: 'ready', detail: 'Browser work has stopped. Review unfinished work before starting again.' };
    if (action === 'disconnect') status = { ...base };
    await route.fulfill({ json: status });
  });
  let holds = [];
  await page.route('**/api/human-handoffs', route => route.fulfill({ json: { handoffs: holds } }));
  await page.goto(origin + '/#you-browser');
  await page.getByRole('button', { name: /^You\b/ }).first().click();
  const card = page.locator('#you-browser');
  await card.locator('summary').first().click();
  // Jump navigation may already have opened the section.
  if (!await card.evaluate(node => node.open)) await card.locator('summary').first().click();
  const connect = card.getByRole('button', { name: 'Connect my browser', exact: true });
  await connect.focus(); await page.keyboard.press('Enter');
  await card.getByText('Add the browser extension', { exact: true }).last().waitFor();
  assert.equal(await card.getByRole('link', { name: /^Add to Chrome/ }).getAttribute('href'), 'https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'browser-setup-desktop.png') });
  status = { ...status, state: 'choose_browser', detail: 'Choose the browser profile to use for work.', browsers: [
    { id: 'practice-chrome', name: 'Chrome', label: 'Work profile', compatible: true },
    { id: 'practice-edge', name: 'Edge', label: 'Needs an update', compatible: false },
  ] };
  await card.getByRole('button', { name: 'Check connection', exact: true }).click();
  const edge = card.getByRole('button', { name: /Use this browser.*Edge/ });
  await edge.waitFor(); assert.equal(await edge.isDisabled(), true);
  await card.getByRole('button', { name: /Use this browser.*Chrome/ }).click();
  await card.getByText('Chrome connected', { exact: true }).waitFor();
  assert.equal(await card.getByText('Run beside me', { exact: true }).count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await card.getByText('How Bud works on websites', { exact: true }).click();
  await card.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Browser settings must fit mobile');
  await page.screenshot({ path: join(output, 'browser-connected-mobile.png') });
  status = { ...status, active: true, state: 'recovery_required', detail: 'The last browser session needs a confirmed release before work can continue.' };
  await card.getByRole('button', { name: 'Check connection', exact: true }).click();
  const stop = card.getByRole('button', { name: 'Stop browser work and take over', exact: true });
  await stop.waitFor(); await stop.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'browser-recovery-mobile.png') });
  await stop.click();
  await card.getByText('Browser work stopped. Check unfinished work before running it again.', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Turn browser access off', exact: true }).click();
  await card.getByText('Browser access is off. Your browser sign-ins have not been changed.', { exact: true }).waitFor();
  assert.deepEqual(mutations, ['connect', 'select', 'stop', 'disconnect']);

  // A person can bind a sign-in check using visible labels, without developer IDs.
  holds = [{ id: 'practice-login', revision: 1, value: { state: 'awaiting_login', reason: 'mfa', detail: 'Sign in directly in the browser. Browser work has stopped.', runId: 'practice-run', steps: ['Read transaction history', 'Prepare the review'] } }];
  const handoffActions = [];
  await page.route('**/api/human-handoffs/practice-login/*', async route => {
    const action = new URL(route.request().url()).pathname.split('/').pop(); handoffActions.push(action);
    const body = route.request().postDataJSON(); assert.equal(body.revision, holds[0].revision);
    if (action === 'tabs') return route.fulfill({ json: { tabs: [{ tabId: 17, browserId: 'practice-chrome', origin: 'https://practice-bank.example', title: 'Fictional bank statement' }] } });
    if (action === 'binding') {
      assert.deepEqual(body.binding, { version: 1, browser: { browserId: 'practice-chrome', tabId: 17 }, origin: 'https://practice-bank.example', accountMarker: 'Office operating account', readyMarker: 'Transaction history' });
      holds = [{ ...holds[0], revision: 2, value: { ...holds[0].value, binding: body.binding } }];
    }
    if (action === 'continue') holds = [{ ...holds[0], revision: 3, value: { ...holds[0].value, state: 'verified' } }];
    if (action === 'resume-step') { assert.equal(body.step, 1); holds = [{ ...holds[0], revision: 4, value: { ...holds[0].value, state: 'resuming' } }]; }
    await route.fulfill({ json: { ok: true } });
  });
  const handover = page.getByRole('complementary', { name: 'Sign-in handovers' });
  await handover.getByRole('button', { name: 'Find my signed-in page' }).click();
  assert.equal(await handover.getByRole('button', { name: /Continue/ }).count(), 0);
  await handover.getByLabel('Page to check', { exact: true }).selectOption('17');
  assert.equal(await handover.getByRole('button', { name: 'Save page check' }).isDisabled(), true);
  await handover.getByLabel('Account label visible on the page', { exact: true }).fill('Office operating account');
  await handover.getByLabel('Signed-in page heading', { exact: true }).fill('Transaction history');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'browser-signin-mobile.png') });
  await handover.getByRole('button', { name: 'Save page check' }).click();
  await handover.getByRole('button', { name: 'Change the page check' }).click();
  assert.equal(await handover.getByRole('button', { name: /Continue/ }).count(), 0);
  await handover.getByRole('button', { name: 'Keep saved page check' }).click();
  await handover.getByRole('button', { name: 'Continue — check sign-in', exact: true }).click();
  const resume = handover.getByRole('button', { name: 'Run this step only' });
  await resume.waitFor(); assert.equal(await resume.isDisabled(), true);
  await handover.getByLabel('Next reviewed step', { exact: true }).selectOption('1');
  await resume.click();
  await handover.getByText(/Starting your chosen step/).waitFor();
  assert.deepEqual(handoffActions, ['tabs', 'binding', 'continue', 'resume-step']);

  holds = [{ id: 'stop-check', revision: 1, value: { ...holds[0].value, state: 'awaiting_login' } }];
  let finishCheck; const checkPending = new Promise(resolve => { finishCheck = resolve; });
  const stoppedActions = [];
  await page.route('**/api/human-handoffs/stop-check/*', async route => {
    const action = new URL(route.request().url()).pathname.split('/').pop(); stoppedActions.push(action);
    assert.equal(route.request().postDataJSON().revision, holds[0].revision);
    if (action === 'continue') { holds = [{ ...holds[0], revision: 2, value: { ...holds[0].value, state: 'checking' } }]; await checkPending; }
    if (action === 'stop') holds = [{ ...holds[0], revision: 3, value: { ...holds[0].value, state: 'stopped' } }];
    await route.fulfill({ json: { ok: true } });
  });
  await handover.getByRole('button', { name: 'Continue — check sign-in', exact: true }).click();
  const stopCheck = handover.getByRole('button', { name: 'Stop this request', exact: true });
  assert.equal(await stopCheck.isDisabled(), false);
  await stopCheck.click();
  await handover.getByRole('button', { name: 'Close without continuing' }).waitFor();
  finishCheck();
  assert.deepEqual(stoppedActions, ['continue', 'stop']);
  assert.deepEqual(errors, []);
  const receipt = { checkedAt: new Date().toISOString(), serverEntry: process.env.REALBUD_SERVER_ENTRY || 'server/index.ts', realAuthentication: true, simulatedBrowserStates: true, keyboardConnect: true, desktop: 1365, mobile: 390, noHorizontalOverflow: true, recovery: true, exactSelectedLoginPage: true, explicitResumeStep: true, stopDuringCheck: true, mutations, handoffActions, pageErrors: errors };
  writeFileSync(join(output, 'ui-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log('PASS: real browser endpoint authentication; keyboard setup, explicit compatible profile, mobile settings, stop/disconnect and label-based sign-in recovery. Browser connection responses are synthetic.');
} catch (error) {
  const pages = browser?.contexts().flatMap(context => context.pages()) ?? [];
  if (pages[0]) { await pages[0].screenshot({ path: join(output, 'failure.png') }).catch(() => {}); console.error((await pages[0].getByRole('alert').allTextContents()).join(' | ')); }
  throw error;
} finally {
  await browser?.close();
  if (child) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(temp, { recursive: true, force: true });
}
