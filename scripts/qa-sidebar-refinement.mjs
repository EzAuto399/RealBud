// Actual source UI and loopback service; fictional disposable workspace only.
// Node 24+, PLAYWRIGHT_MODULE, optional CHROME_EXECUTABLE; no build or worker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { serviceSmokeEnv } from './service-smoke-env.mjs';

assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or later.');
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module.');
assert.ok(!process.env.REALBUD_QA_RESOURCES && !process.env.REALBUD_QA_EXECUTABLE, 'This check runs source only.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/sidebar-refinement-2026-10-01'));
assert.ok(!existsSync(output), 'Choose a fresh QA_OUTPUT; earlier evidence is preserved.');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-sidebar-refinement-'));
const data = join(scratch, 'data'); mkdirSync(data, { mode: 0o700 });
const sourcePaths = ['src/components/Sidebar.tsx', 'src/components/WorkdayPulse.tsx', 'src/components/YouPage.tsx', 'src/components/you/WorkspaceNextStep.tsx', 'src/components/WorkspaceTabsManager.tsx', 'src/lib/use-dialog-keyboard.ts', 'src/sidebar-utilities.css', 'src/workspace-tabs.css', 'src/styles.css', 'scripts/qa-sidebar-refinement.mjs'];
const sourceHashes = () => Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
const sourcesAtStart = sourceHashes();
const checks = [], errors = [], deniedOrigins = [], apiCalls = [], measurements = {}, screenshots = [], cleanupErrors = [];
let child, childClosed, vite, browser, page, failure, base, uiBase, token, logs = '';
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const record = message => { checks.push(message); console.log(`PASS ${message}`); };
const port = async () => {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port; await new Promise(resolveClose => listener.close(resolveClose)); return value;
};
const request = async (path, method = 'GET', body) => {
  assert.ok(path.startsWith('/api/'), 'Only this disposable service API may be addressed.');
  const response = await fetch(base + path, { method, headers: { 'x-realbud-session': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`); return result;
};
const until = async (check, message) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await wait(50); }
  assert.fail(message);
};
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow');
const fits = async locator => {
  const box = await locator.boundingBox(); assert.ok(box, 'The control is rendered');
  const viewport = page.viewportSize();
  assert.ok(box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `Control fits viewport: ${JSON.stringify({ box, viewport })}`);
  return box;
};
const focused = locator => locator.evaluate(element => element === document.activeElement);
const screenshot = async name => { await page.screenshot({ path: join(output, name), animations: 'disabled' }); screenshots.push(name); };
const nav = () => page.getByRole('navigation', { name: 'Main navigation', exact: true });
const workspace = () => page.locator('aside.rb-sidebar').getByRole('button', { name: 'Workspace', exact: true });
const overview = () => page.getByRole('region', { name: 'Workspace overview', exact: true });
const openOverview = async () => {
  await workspace().click();
  await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor(); await overview().waitFor();
  await until(async () => await workspace().getAttribute('aria-current') === 'page', 'Workspace reflects the current screen');
  await overview().scrollIntoViewIfNeeded();
  return fits(overview());
};
// Saved views are read-only for people; Bud changes them through the same
// revisioned API, so this QA seeds and changes them through that API.
const views = async () => (await request('/api/workspace-tabs')).state;
const putViews = async mutate => {
  const current = await views();
  return (await request('/api/workspace-tabs', 'PUT', { version: 1, expectedRevision: current.revision, tabs: mutate(current.tabs) })).state;
};
const managerHeading = () => page.getByRole('heading', { level: 1, name: 'Saved views', exact: true });
const openSavedViews = async () => {
  await openOverview();
  const settings = page.locator('#you-settings');
  if (!(await settings.evaluate(element => element.open))) await settings.locator('summary').first().click();
  await settings.getByRole('button', { name: 'See saved views', exact: true }).click();
  await managerHeading().waitFor();
};
const refreshViews = async () => {
  const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace-tabs' && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Refresh views', exact: true }).click(); await read;
};
const view = (id, label, kind, filter, visible = true) => ({ id, label, visible, view: { kind, filter } });

try {
  const servicePort = await port(), uiPort = await port();
  base = `http://127.0.0.1:${servicePort}`; uiBase = `http://127.0.0.1:${uiPort}`;
  process.env.OMB_UI_PORT = String(uiPort);
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port: servicePort }),
      REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_UI_PORT: String(uiPort), OMB_STATIC_DIR: join(scratch, 'unused-static') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childClosed = new Promise(resolveClose => { child.once('close', resolveClose); child.once('error', cause => { logs += String(cause); resolveClose(); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode) break;
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(response => response.json()).catch(() => null);
    if (health?.pid === child.pid) { ready = true; break; }
    await wait(100);
  }
  assert.ok(ready, 'The exact disposable service PID becomes healthy');
  token = (await (await fetch(base + '/api/session')).json()).token;
  vite = await createViteServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn',
    server: { host: '127.0.0.1', port: uiPort, strictPort: true, proxy: { '/api': { target: base, changeOrigin: true, ws: true } } },
  });
  await vite.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === uiBase) return route.continue();
    deniedOrigins.push(url.origin); return route.abort();
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.origin.replace(/^ws/, 'http') === uiBase) socket.connectToServer();
    else { deniedOrigins.push(url.origin); socket.close(); }
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', event => {
    const url = new URL(event.url());
    if (url.origin === uiBase && url.pathname.startsWith('/api/')) apiCalls.push({ method: event.method(), path: url.pathname });
  });
  await page.goto(uiBase);
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Sidebar Reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await nav().waitFor(); assert.equal((await request('/api/onboarding')).stage, 'complete');
  await until(async () => !(await workspace().innerText()).includes('Loading your desk'), 'The status guide reads the actual disposable book');
  assert.equal(await overview().isVisible(), false);
  measurements.desktopFooter = await fits(page.locator('.rb-sidebar-utilities'));
  assert.ok(measurements.desktopFooter.height <= 140, 'The sidebar utility area stays at most 140px high');
  assert.equal(await page.locator('.rb-sidebar-utilities').getByRole('button').count(), 1, 'Workspace is the single footer entry');
  assert.equal(await page.getByRole('region', { name: 'Today in RealBud', exact: true }).count(), 0);
  await noOverflow(); await screenshot('desktop-desk-closed.png');
  record('Desktop 1440×940 keeps one Workspace button in a compact footer; the overview is absent from Desk');

  await workspace().focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/you');
  assert.equal(await workspace().getAttribute('aria-current'), 'page');
  measurements.desktopOverview = await fits(overview());
  await overview().getByText('Sample book', { exact: true }).waitFor();
  const detail = await overview().innerText(); assert.ok(detail.length > 20);
  assert.equal(await page.getByRole('dialog', { name: 'Workspace overview', exact: true }).count(), 0);
  await screenshot('desktop-desk-open.png');
  await nav().getByRole('button', { name: 'Desk', exact: true }).click();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  assert.equal(await workspace().getAttribute('aria-current'), null);
  record('Keyboard activation opens Workspace at #/you, shows truthful book details, and updates the current-screen marker when returning to Desk');

  await putViews(() => [view('view-fictional-waiting', 'Fictional waiting work', 'tasks', 'waiting'), view('view-fictional-bills', 'Fictional bills review', 'bills', 'needs-you')]);
  await openSavedViews(); await refreshViews();
  const initialViews = await views();
  assert.equal(initialViews.tabs.length, 2);
  await page.getByRole('heading', { name: 'Fictional bills review', exact: true }).waitFor();
  await nav().getByRole('button', { name: 'Fictional waiting work', exact: true }).waitFor();
  const managerHash = new URL(page.url()).hash;
  assert.equal(managerHash, '#/views');
  await openOverview();
  const connectedApps = page.locator('#you-connected-apps');
  if (!(await connectedApps.evaluate(element => element.open))) await connectedApps.locator('summary').first().click();
  await connectedApps.getByRole('heading', { name: 'Work apps', exact: true }).waitFor();
  await openSavedViews();
  assert.equal(new URL(page.url()).hash, managerHash);
  assert.deepEqual(await views(), initialViews);
  record('API-seeded views appear in the sidebar; Workspace opens Connected apps and its See saved views button returns to the same saved views without changing them');

  await nav().getByRole('button', { name: 'Ask', exact: true }).click();
  const composer = page.locator('.ask-composer textarea').first();
  await composer.fill('Fictional unfinished sidebar check — do not send.');
  const askHash = new URL(page.url()).hash;
  const setupTrigger = page.getByRole('button', { name: 'Bud status', exact: true }).first();
  await setupTrigger.click();
  await page.getByRole('dialog', { name: 'Bud status', exact: true }).getByRole('button', { name: 'Apps', exact: true }).click();
  const connectionSheet = page.getByRole('dialog', { name: 'Office connections', exact: true });
  await connectionSheet.waitFor(); await fits(connectionSheet);
  const closeConnections = connectionSheet.getByRole('button', { name: 'Close Office connections', exact: true });
  // The last control is whatever the dialog's own focus trap can reach, from the same source module.
  const lastSetupControl = await connectionSheet.evaluateHandle(async dialog => (await import('/src/lib/use-dialog-keyboard.ts')).dialogFocusables(dialog).at(-1) ?? null);
  measurements.setupLastControl = await lastSetupControl.evaluate(element => element && `${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 60)}`);
  assert.ok(measurements.setupLastControl && !(await lastSetupControl.evaluate((element, close) => element === close, await closeConnections.elementHandle())), 'The setup sheet has a reachable last control after its close control');
  await closeConnections.focus(); await page.keyboard.press('Shift+Tab');
  await until(() => lastSetupControl.evaluate(element => element === document.activeElement), `Shift+Tab wraps to the last setup control (${measurements.setupLastControl})`);
  await page.keyboard.press('Tab'); await until(() => focused(closeConnections), 'Tab wraps to the setup close control');
  await page.keyboard.press('Escape'); await connectionSheet.waitFor({ state: 'hidden' });
  assert.equal(await composer.inputValue(), 'Fictional unfinished sidebar check — do not send.');
  assert.equal(new URL(page.url()).hash, askHash);
  await until(() => focused(setupTrigger), 'Setup restores focus after returning to Ask');
  record('Ask opens Office connections through Bud status; setup traps and restores focus while preserving the actual unsent Ask draft and its route');
  await composer.fill('');
  const modifier = await page.evaluate(() => /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform) ? 'Meta' : 'Control');
  for (const [key, hash] of [['1', '#/desk'], ['2', '#/ask'], ['3', '#/schedule'], ['4', '#/you']]) {
    await page.keyboard.press(`${modifier}+${key}`); await page.waitForURL(url => url.hash === hash);
  }
  record('The four primary navigation keyboard shortcuts retain their routes');

  await openSavedViews();
  const main = page.getByRole('main');
  for (const name of ['Add saved view', 'Edit Fictional waiting work', 'More actions for Fictional waiting work', 'Customize desk', 'View options', 'Reset saved views']) {
    assert.equal(await main.getByRole('button', { name, exact: true }).count(), 0, `No manual "${name}" control`);
  }
  assert.equal(await main.getByRole('form', { name: 'Saved view editor' }).count(), 0);
  await main.getByText('Bud sets these up. Ask Bud to add, rename, hide, reorder or remove a view.', { exact: true }).waitFor();
  await putViews(tabs => tabs.map(tab => tab.id === 'view-fictional-waiting' ? { ...tab, label: 'Fictional waiting reply', visible: false } : tab));
  await refreshViews();
  const hiddenRow = main.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Fictional waiting reply', exact: true }) });
  await hiddenRow.getByText('Hidden', { exact: true }).waitFor();
  assert.ok(await hiddenRow.getByRole('button', { name: 'Open Fictional waiting reply', exact: true }).isDisabled());
  assert.equal(await nav().getByRole('button', { name: 'Fictional waiting reply', exact: true }).count(), 0);
  await putViews(tabs => [...tabs].reverse().map(tab => ({ ...tab, visible: true })));
  await refreshViews();
  await nav().getByRole('button', { name: 'Fictional waiting reply', exact: true }).waitFor();
  assert.deepEqual(await main.getByRole('listitem').getByRole('heading').allInnerTexts(), ['Fictional bills review', 'Fictional waiting reply']);
  assert.ok(!(await main.getByRole('button', { name: 'Open Fictional waiting reply', exact: true }).isDisabled()));
  record('Saved views is read-only (no Add, Edit, More actions, Customize desk or View options); API rename, hide, show and reorder reach the list, the Hidden marker and the sidebar after Refresh');

  const latest = await views();
  await putViews(tabs => tabs.map(tab => tab.id === 'view-fictional-waiting' ? { ...tab, label: 'Fictional current wording' } : tab));
  const stale = await fetch(base + '/api/workspace-tabs', { method: 'PUT', headers: { 'x-realbud-session': token, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ version: 1, expectedRevision: latest.revision, tabs: latest.tabs.map(tab => tab.id === 'view-fictional-waiting' ? { ...tab, label: 'Fictional stale wording' } : tab) }) });
  assert.equal(stale.status, 409);
  const afterConflict = await views();
  assert.ok(afterConflict.tabs.some(tab => tab.label === 'Fictional current wording'));
  assert.equal(afterConflict.tabs.some(tab => tab.label === 'Fictional stale wording'), false);
  await refreshViews();
  await page.getByRole('heading', { name: 'Fictional current wording', exact: true }).waitFor();
  await main.getByRole('button', { name: 'Ask Bud', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/ask');
  await openSavedViews();
  record('A stale-revision API write is rejected with 409 and the accepted revision is kept and shown; Ask Bud opens Ask');

  await noOverflow(); await screenshot('desktop-closed.png');
  await openOverview(); await screenshot('desktop-open.png');
  await page.setViewportSize({ width: 680, height: 940 });
  measurements.railFooter = await fits(page.locator('.rb-sidebar-utilities'));
  await fits(workspace());
  measurements.railOverview = await openOverview();
  await noOverflow(); await screenshot('rail-680-open.png');
  record('The 680px compact rail retains the reachable Workspace button; its overview stays within the viewport');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const label of ['Desk', 'Ask', 'Schedule']) {
    await fits(nav().getByRole('button', { name: label, exact: true }));
  }
  await fits(workspace());
  await openSavedViews();
  await noOverflow(); await screenshot('mobile-390.png');
  measurements.mobileOpen = await fits(page.getByRole('button', { name: 'Open Fictional bills review', exact: true }));
  await fits(page.getByRole('button', { name: 'Ask Bud', exact: true }));
  assert.equal((await views()).tabs.length, 2);
  record('At 390px the three primary doors and Workspace remain visible, See saved views opens the list with Open and Ask Bud in view, and nothing overflows horizontally');

  // Fill the disposable workspace to the 12-view limit with maximum-length names.
  const extraViews = Array.from({ length: 10 }, (_, index) => view(`view-fictional-sidebar-${index + 3}`, `Fictional long waiting review row ${String(index + 3).padStart(6, '0')}`, 'tasks', 'waiting'));
  assert.ok(extraViews.every(tab => tab.label.length === 40), 'Boundary fixture uses the allowed 40-character view label');
  await putViews(tabs => [...tabs, ...extraViews]);
  await page.setViewportSize({ width: 680, height: 600 });
  await refreshViews();
  const lowLabel = extraViews.at(-1).label;
  await page.getByRole('heading', { name: lowLabel, exact: true }).waitFor();
  assert.equal((await views()).tabs.length, 12);
  const lowOpen = page.getByRole('button', { name: `Open ${lowLabel}`, exact: true });
  await lowOpen.scrollIntoViewIfNeeded();
  measurements.shortLowOpen = await fits(lowOpen);
  measurements.shortScroll = await page.getByRole('main').evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  assert.ok(measurements.shortScroll.scrollTop > 0, 'The final view is reached below the top of the long list');
  await noOverflow(); await screenshot('short-680-twelve-views.png');
  await lowOpen.click();
  await page.waitForURL(url => url.hash === `#/views/${extraViews.at(-1).id}`);
  record('With 12 views including maximum-length fictional names in a 680×600 window, the lowest row scrolls into view and its Open reaches that saved view');

  // Recovery: damage the disposable settings file; the alert and confirmed reset remain.
  const tabsFile = join(data, 'workspace-views', 'tabs.json');
  assert.ok(existsSync(tabsFile), 'The disposable saved-view file exists');
  writeFileSync(tabsFile, '{ fictional damaged settings');
  await page.goto(uiBase + '/#/views'); await page.reload(); await managerHeading().waitFor();
  const recoveryAlert = page.getByRole('alert').filter({ hasText: 'Saved views could not be loaded.' });
  await recoveryAlert.waitFor();
  await nav().getByRole('button', { name: 'Manage saved views', exact: true }).waitFor();
  await recoveryAlert.getByRole('button', { name: 'Reset saved views', exact: true }).click();
  const confirmation = page.getByRole('group', { name: 'Confirm saved view change', exact: true });
  await confirmation.waitFor(); await fits(confirmation.getByRole('button', { name: 'Confirm reset', exact: true }));
  await noOverflow(); await screenshot('short-680-recovery-confirmation.png');
  await confirmation.getByRole('button', { name: 'Keep current views', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  assert.equal((await request('/api/workspace-tabs')).state, null);
  await recoveryAlert.getByRole('button', { name: 'Reset saved views', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await page.getByText('Saved views reset. Standard navigation remains.', { exact: true }).waitFor();
  assert.deepEqual((await views()).tabs, []);
  assert.equal(await nav().getByRole('button', { name: 'Manage saved views', exact: true }).count(), 0);
  record('Damaged saved-view settings show the recovery alert and sidebar entry; Keep current views changes nothing and a confirmed reset restores standard navigation');

  const dangerousMutations = apiCalls.filter(({ method, path }) => method !== 'GET' && path !== '/api/connected-apps/check' && /\/(?:send|chat|connect|authorize|oauth|run|execute|practice|check)(?:\/|$)/i.test(path));
  assert.deepEqual(dangerousMutations, [], 'No model, practice, authorization or external-work action was submitted');
  assert.deepEqual(errors, []); assert.deepEqual(deniedOrigins, []);
  assert.deepEqual(sourceHashes(), sourcesAtStart, 'Exercised source stays unchanged throughout the run');
  record('No renderer errors, external browser requests, model or connection authorization actions; source hashes stayed stable');
} catch (cause) {
  failure = cause instanceof Error ? cause.stack : String(cause);
  await page?.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
  writeFileSync(join(output, 'failure.log'), `${failure}\n\n${logs}`); console.error(failure);
} finally {
  for (const [name, clean] of [['browser', () => browser?.close()], ['vite', () => vite?.close()]]) {
    try { await clean(); } catch (cause) { cleanupErrors.push(`${name}: ${String(cause)}`); }
  }
  if (child?.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 4_000);
    try { await childClosed; } finally { clearTimeout(force); }
  }
  try { rmSync(scratch, { recursive: true, force: true }); } catch (cause) { cleanupErrors.push(`scratch: ${String(cause)}`); }
  const passed = !failure && cleanupErrors.length === 0;
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), layer: 'source-rendered-local', passed,
    node: process.version, checks, checkCount: checks.length, measurements, screenshots, errors, deniedOrigins, failure: failure ?? null,
    apiCalls: [...new Set(apiCalls.map(({ method, path }) => `${method} ${path}`))],
    cleanup: { serviceExited: !child || child.exitCode !== null || child.signalCode !== null, scratchRemoved: !existsSync(scratch), errors: cleanupErrors },
    sources: sourcesAtStart,
    limits: ['Fictional disposable workspace and unsent draft only; no customer records, production ports, browser profiles or cookies are used.',
      'Actual source React UI, Vite and isolated Node service in headless Chromium; not a packaged app or installed-app verification.',
      'No model execution, account login, connection authorization, email send, REI or Zapier action is exercised.',
      'Covers sidebar and read-only saved-view presentation at 1440, 680 and 390px, 12 views at 680×600 and damaged-settings recovery; views are seeded through the revisioned API, not through Bud or a model; does not repeat complete workflow, backup, or account acceptance suites.',
      'Workspace navigation and setup dialog keyboard behavior are checked on this Chromium runtime; other browser engines and operating systems remain unverified.'],
  }, null, 2) + '\n');
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${checks.length} checks. Receipt: ${join(output, 'receipt.json')}`);
  if (!passed) process.exitCode = 1;
}
