// Built UI and real isolated service. Asset failures are injected; records and
// all account configuration are fictional. Never reads the operator workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud screen QA '));
const output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/screen-loading-2026-09-21'));
mkdirSync(output, { recursive: true });
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const checks = [], errors = [], expectedErrors = [];
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, page, logs = '', failure;
try {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`, data = join(temp, 'data'); mkdirSync(data);
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root, env: {
    ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }),
    REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: join(root, 'dist'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try { const health = await (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) })).json(); if (health.pid === child.pid) { ready = true; break; } } catch {}
    await wait(100);
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const createContext = async (welcome = false) => {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1024 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    if (!welcome) await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
    return context;
  };
  const context = await createContext(); page = await context.newPage();
  const loaded = [];
  page.on('request', request => { if (request.resourceType() === 'script') loaded.push(new URL(request.url()).pathname); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/desk'); await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  assert.ok(loaded.some(url => /\/DeskPage-/.test(url)));
  for (const name of ['YouPage', 'RoutinesPage', 'WorkspaceTabsManager', 'WorkspaceSetup', 'Onboarding']) assert.equal(loaded.some(url => url.includes(`/${name}-`)), false, `${name} should load only when used`);
  pass('Desk opens without downloading settings, schedule, saved-view manager, setup or onboarding chunks');
  for (const [hash, heading] of [['#/schedule', 'Schedule'], ['#/you', 'You'], ['#/views', 'Manage saved views'], ['#/desk', 'Desk']]) {
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, hash);
  }
  pass('Lazy screens navigate and preserve their deep-link routes with the real API');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('realbud:workspace-setup', { detail: 'office' })));
  await page.getByRole('dialog', { name: 'Office details', exact: true }).waitFor();
  await page.getByRole('navigation', { name: 'Setup sections' }).getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('dialog', { name: 'Office connections', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  pass('Setup opens, switches sections and closes with keyboard while retaining the underlying screen');
  const failedContext = await createContext();
  let failSettings = true;
  await failedContext.route('**/assets/YouPage-*.js', route => failSettings ? route.abort('failed') : route.continue());
  const failed = await failedContext.newPage(); failed.on('pageerror', error => expectedErrors.push(error.message));
  await failed.goto(origin + '/#/you'); await failed.getByRole('heading', { name: 'Could not open You', exact: true }).waitFor();
  await failed.locator('nav').getByRole('button', { name: /^Desk\b/ }).first().click();
  await failed.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  await failed.locator('nav').getByRole('button', { name: /^You\b/ }).first().click();
  await failed.getByRole('heading', { name: 'Could not open You', exact: true }).waitFor();
  failSettings = false;
  await failed.getByRole('button', { name: 'Reload RealBud', exact: true }).click();
  await failed.getByRole('heading', { name: 'You', exact: true }).waitFor();
  pass('A failed settings asset shows recovery, leaves Desk navigation usable, and reload succeeds after the asset recovers');
  const setupContext = await createContext();
  await setupContext.route('**/assets/WorkspaceSetup-*.js', route => route.abort('failed'));
  const setupPage = await setupContext.newPage(); setupPage.on('pageerror', error => expectedErrors.push(error.message));
  await setupPage.goto(origin + '/#/desk'); await setupPage.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  await setupPage.evaluate(() => window.dispatchEvent(new CustomEvent('realbud:workspace-setup', { detail: 'office' })));
  await setupPage.getByRole('dialog', { name: 'Could not open setup', exact: true }).waitFor();
  await setupPage.setViewportSize({ width: 390, height: 844 });
  assert.ok(await setupPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await setupPage.screenshot({ path: join(output, 'setup-asset-recovery-mobile.png') });
  await setupPage.keyboard.press('Escape'); await setupPage.getByRole('dialog').waitFor({ state: 'hidden' });
  await setupPage.locator('nav').getByRole('button', { name: /^Schedule\b/ }).first().click();
  await setupPage.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  pass('A failed setup asset remains keyboard-dismissable in an accessible dialog and fits390px');
  const firstContext = await createContext(true), first = await firstContext.newPage(); first.on('pageerror', error => errors.push(error.message));
  await first.goto(origin); await first.getByRole('heading', { name: 'Make the desk yours', exact: true }).waitFor();
  pass('A new private browser session loads the actual welcome screen');
  assert.deepEqual(errors, []);
  assert.ok(expectedErrors.every(message => /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message)), JSON.stringify(expectedErrors));
} catch (error) { failure = error.stack || String(error); await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await browser?.close();
  if (child?.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5000)]); if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await once(child, 'exit'); } }
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Built React UI in Chrome; real isolated source bootstrap; asset faults injected; no customer accounts', checks, errors, expectedErrors, failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; }
}
