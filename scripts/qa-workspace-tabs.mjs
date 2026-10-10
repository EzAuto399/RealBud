// Disposable real API + browser verification. All records and the worker are synthetic.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readSessionToken, primeBrowserSession, enterSampleDeskForQa } from './local-session.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/workspace-tabs-2026-09-21'));
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'rb-workspace-tabs-'));
let child, browser, logs = '';
try {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const data = join(temp, 'data'); mkdirSync(data);
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { ghost: { driver: 'not-a-real-driver', displayName: 'Offline fixture' } } }));
  const worker = join(temp, 'worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.3 (2026.9.14)');\n`); chmodSync(worker, 0o755);
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.REALBUD_SERVER_EXECUTABLE || process.execPath, [process.env.REALBUD_SERVER_ENTRY || join(root, 'server/index.ts')], { cwd: root,
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, REALBUD_HERMES_CLI: worker, OMB_PORT: String(port), OMB_STATIC_DIR: process.env.REALBUD_UI_DIR || join(root, 'dist'), ELECTRON_RUN_AS_NODE: '1', VITEST: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.ok(ready, logs.slice(-1500));
  for (const [path, method] of [['/api/workspace-tabs', 'GET'], ['/api/workspace-tabs', 'PUT'], ['/api/workspace-tabs/reset', 'POST']]) assert.equal((await fetch(origin + path, { method, ...(method !== 'GET' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) })).status, 401);
  const token = await readSessionToken(data);
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, { method, headers: { 'x-realbud-session': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`); return result;
  };
  await request('/api/expected-bills', 'POST', { propertyId: 'practice-property', kind: 'Practice water bill', status: 'hold', note: 'Fictional record for review only' });
  await request('/api/recipes', 'POST', { draft: { title: 'Practice review job', description: 'Review a fictional supplied record', steps: ['Read the supplied practice record'], allowedOrigins: [], evidence: 'Practice receipt', capabilities: ['read-files', 'analyse', 'draft'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, schedule: null, status: 'shadow', expectedRevision: 0 } });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1024 } });
  await primeBrowserSession(context, origin, token);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const nav = () => page.getByRole('navigation', { name: 'Main navigation', exact: true });
  const savedNav = () => page.getByRole('navigation', { name: 'Saved views', exact: true });
  const workspace = () => page.locator('aside.rb-sidebar').getByRole('button', { name: 'Workspace', exact: true });
  const managerHeading = () => page.getByRole('heading', { level: 1, name: 'Saved views', exact: true });
  const openSavedViews = async () => {
    await workspace().click();
    const settings = page.locator('#you-settings');
    await settings.waitFor();
    if (!(await settings.evaluate(element => element.open))) await settings.locator('summary').first().click();
    await settings.getByRole('button', { name: 'See saved views', exact: true }).click();
    await managerHeading().waitFor();
  };
  const refreshViews = async () => {
    const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace-tabs' && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Refresh views', exact: true }).click(); await read;
    await page.waitForFunction(() => { const button = document.querySelector('button[aria-label="Refresh views"]'); return button && !button.disabled; });
  };
  // People see a read-only list; seed Bud's supported changes through the revisioned API.
  const views = async () => (await request('/api/workspace-tabs')).state;
  const putViews = async mutate => {
    const current = await views();
    return (await request('/api/workspace-tabs', 'PUT', { version: 1, expectedRevision: current.revision, tabs: mutate(current.tabs) })).state;
  };
  const view = (id, label, kind, filter) => ({ id, label, visible: true, view: { kind, filter } });
  await page.goto(origin);
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Saved Views Reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // First run has no sample-desk exit: the QA helper completes it as that button did and passes the office-link screen.
  await page.getByRole('heading', { name: 'Connect this computer to your office', exact: true }).waitFor();
  await enterSampleDeskForQa(page);
  await nav().waitFor();
  await openSavedViews();
  await page.getByText('No saved views yet. Ask Bud for one, such as “Waiting for a reply” or “Bills to review”.', { exact: true }).waitFor();
  await putViews(() => [view('view-fictional-waiting', 'Waiting work', 'tasks', 'waiting'), view('view-fictional-bills', 'Bills to review', 'bills', 'needs-you'), view('view-fictional-jobs', 'Practice jobs', 'jobs', 'all')]);
  assert.equal((await views()).tabs.length, 3);
  await page.reload();
  await page.getByRole('heading', { name: 'Bills to review', exact: true }).waitFor();
  await putViews(tabs => tabs.map(tab => tab.id === 'view-fictional-waiting' ? { ...tab, label: 'Waiting for reply' } : tab));
  await refreshViews(); await page.getByRole('heading', { name: 'Waiting for reply', exact: true }).waitFor();
  await putViews(tabs => [tabs[1], tabs[0], tabs[2]]);
  await refreshViews();
  await page.waitForFunction(() => document.querySelector('section[aria-label="Saved views"] h2')?.textContent === 'Bills to review');
  assert.equal((await views()).tabs[0].label, 'Bills to review');
  await putViews(tabs => tabs.map(tab => tab.id === 'view-fictional-waiting' ? { ...tab, visible: false } : tab));
  await refreshViews();
  const waitingRow = page.getByRole('region', { name: 'Saved views', exact: true }).getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Waiting for reply', exact: true }) });
  await waitingRow.getByText('Hidden', { exact: true }).waitFor();
  assert.equal(await waitingRow.getByRole('button', { name: 'Open Waiting for reply', exact: true }).isDisabled(), true);
  assert.equal(await savedNav().getByRole('button', { name: 'Waiting for reply', exact: true }).count(), 0);
  await putViews(tabs => tabs.map(tab => tab.id === 'view-fictional-waiting' ? { ...tab, visible: true } : tab));
  await refreshViews(); await savedNav().getByRole('button', { name: 'Waiting for reply', exact: true }).waitFor();
  assert.equal(await waitingRow.getByRole('button', { name: 'Open Waiting for reply', exact: true }).isEnabled(), true);
  assert.deepEqual(await page.getByRole('main').filter({ has: managerHeading() }).getByRole('button').allTextContents(), ['Ask Bud', '', 'Open Bills to review', 'Open Waiting for reply', 'Open Practice jobs'], 'Healthy saved views only offer Ask Bud, Refresh and Open');
  await page.getByRole('button', { name: 'Ask Bud', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/ask');
  await openSavedViews();
  await page.screenshot({ animations: 'disabled', path: join(output, 'views-manager-desktop.png') });
  await page.getByRole('button', { name: 'Open Bills to review', exact: true }).click();
  await page.getByRole('heading', { name: 'Practice water bill', exact: true }).waitFor();
  const billHash = new URL(page.url()).hash;
  await page.reload();
  await page.getByRole('heading', { name: 'Practice water bill', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, billHash);
  await page.screenshot({ animations: 'disabled', path: join(output, 'bills-saved-view-desktop.png') });
  await page.getByLabel('Find in this view').fill('does-not-match');
  await page.getByText('No bills on this loaded page.', { exact: true }).waitFor();
  await page.getByLabel('Find in this view').fill('');
  await page.getByRole('button', { name: 'Manage views', exact: true }).click();
  await page.getByRole('button', { name: 'Open Practice jobs', exact: true }).click();
  await page.getByRole('heading', { name: 'Practice review job', exact: true }).waitFor();
  await page.getByRole('button', { name: /Open job.*Practice review job/ }).click();
  const jobDrawer = page.getByRole('dialog', { name: 'Practice review job', exact: true });
  await jobDrawer.locator('summary').filter({ hasText: /^Edit job details$/ }).click();
  await page.getByLabel('Job name', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Job name', { exact: true }).inputValue(), 'Practice review job');
  await page.getByLabel('Job name', { exact: true }).fill('Unsaved wording is kept');
  await jobDrawer.getByRole('button', { name: 'Close Practice review job', exact: true }).click();
  await jobDrawer.waitFor({ state: 'hidden' });
  await openSavedViews();
  await page.getByRole('button', { name: 'Open Practice jobs', exact: true }).click();
  await page.getByRole('button', { name: /Open job.*Practice review job/ }).click();
  const jobDetails = jobDrawer.locator('summary').filter({ hasText: /^Edit job details$/ });
  await jobDetails.waitFor();
  if (!(await jobDetails.evaluate(element => element.parentElement.open))) await jobDetails.click();
  assert.equal(await page.getByLabel('Job name', { exact: true }).inputValue(), 'Unsaved wording is kept');
  await page.getByRole('alert').filter({ hasText: 'Your unfinished job plan is kept' }).waitFor();
  await page.getByLabel('Job name', { exact: true }).fill('Practice review job');
  await jobDrawer.getByRole('button', { name: 'Close Practice review job', exact: true }).click();
  await jobDrawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
  await openSavedViews();
  await page.getByRole('button', { name: 'Open Waiting for reply', exact: true }).click();
  await page.getByRole('heading', { name: 'Waiting for reply', exact: true }).waitFor();
  await page.getByText(/\d+ matching records?/).waitFor();
  await page.getByRole('button', { name: 'Manage views', exact: true }).click();

  // Another API writer wins. A stale revision must not overwrite its change.
  const current = await views();
  const updated = await putViews(tabs => tabs.map(tab => tab.id === 'view-fictional-waiting' ? { ...tab, label: 'Current wording' } : tab));
  const stale = await fetch(origin + '/api/workspace-tabs', { method: 'PUT', headers: { 'x-realbud-session': token, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, expectedRevision: current.revision, tabs: current.tabs.map(tab => tab.id === 'view-fictional-waiting' ? { ...tab, label: 'Old window wording' } : tab) }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'tabs_changed');
  assert.deepEqual(await views(), updated);
  await refreshViews(); await page.getByRole('heading', { name: 'Current wording', exact: true }).waitFor();
  await putViews(tabs => tabs.filter(tab => tab.id !== 'view-fictional-waiting'));
  await refreshViews(); await page.getByRole('heading', { name: 'Current wording', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await views()).tabs.length, 2);
  const shortcutMod = await page.evaluate(() => /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform) ? 'Meta' : 'Control');
  for (const [key, hash] of [['1', '#/desk'], ['2', '#/ask'], ['3', '#/schedule'], ['4', '#/you']]) {
    await page.keyboard.press(`${shortcutMod}+${key}`); await page.waitForURL(url => url.hash === hash);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await openSavedViews();
  for (const title of ['Desk', 'Work', 'Schedule']) assert.equal(await nav().getByRole('button', { name: title, exact: true }).isVisible(), true);
  assert.equal(await workspace().isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Manager fits phone width');
  await page.screenshot({ animations: 'disabled', path: join(output, 'views-manager-mobile.png') });
  await page.getByRole('button', { name: 'Open Bills to review', exact: true }).click();
  await page.getByRole('heading', { name: 'Practice water bill', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Saved view fits phone width');
  await page.screenshot({ animations: 'disabled', path: join(output, 'bills-saved-view-mobile.png') });
  await page.getByRole('button', { name: 'Manage views', exact: true }).click();
  await putViews(tabs => [...tabs, view('view-fictional-handovers', 'Office handovers', 'shared-work', 'with-me')]);
  await refreshViews();
  await page.getByRole('button', { name: 'Open Office handovers', exact: true }).click();
  await page.getByText('Sign in through Workspace → Office & colleagues if needed, then refresh shared work.', { exact: true }).waitFor();
  await page.screenshot({ animations: 'disabled', path: join(output, 'shared-work-saved-view-mobile.png') });
  await nav().getByRole('button', { name: 'Desk', exact: true }).click();
  const beforeDeskMail = await views();
  assert.equal(beforeDeskMail.desk.sections.find(section => section.id === 'mail')?.visible, true, 'The unlinked sample fixture keeps the default Mail priorities section');
  const openDeskMail = async () => {
    await page.getByRole('navigation', { name: 'Desk workspace', exact: true }).getByRole('button', { name: 'Mail priorities', exact: true }).click();
  };
  await openDeskMail();
  const mailPanel = page.getByRole('region', { name: 'Mail priorities and follow-ups', exact: true });
  // The source note sits in the area's collapsed Setup.
  const mailSetupNote = async () => {
    const setup = mailPanel.locator('details.area-setup');
    if (!await setup.evaluate(element => element.open)) await setup.locator(':scope > summary').click();
    await mailPanel.getByText('No source collection is recorded. Finish agency setup and explicitly collect the reviewed Gmail scope.', { exact: true }).waitFor();
  };
  await mailSetupNote();
  assert.equal(await page.locator('.desk-work-tasks').isVisible(), false);
  await page.getByRole('navigation', { name: 'Desk workspace', exact: true }).getByRole('button', { name: /^Tasks\s*\d*$/ }).click();
  await page.locator('.desk-work-tasks').waitFor();
  await openDeskMail(); await mailPanel.waitFor();
  assert.deepEqual(await views(), beforeDeskMail, 'Opening Desk mail replaces the work area without creating saved views');
  await putViews(tabs => [...tabs, view('view-fictional-mail', 'Mail priorities', 'mail', 'open')]);
  await openSavedViews(); await refreshViews();
  await page.getByRole('button', { name: 'Open Mail priorities', exact: true }).click();
  await mailSetupNote();
  const mailHash = new URL(page.url()).hash; await page.reload(); await mailPanel.waitFor(); assert.equal(new URL(page.url()).hash, mailHash);
  await page.setViewportSize({ width: 1365, height: 1024 });
  await page.screenshot({ animations: 'disabled', path: join(output, 'mail-saved-view-desktop.png') });
  await page.getByRole('button', { name: 'Manage views', exact: true }).click();
  await putViews(tabs => tabs.map(tab => tab.id === 'view-fictional-mail' ? { ...tab, view: { ...tab.view, filter: 'waiting' } } : tab));
  await refreshViews();
  await page.getByRole('button', { name: 'Open Mail priorities', exact: true }).click();
  assert.equal(await mailPanel.getByRole('button', { name: 'Waiting (0)', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ animations: 'disabled', path: join(output, 'mail-saved-view-mobile.png') });
  await page.getByRole('button', { name: 'Manage views', exact: true }).click();
  const viewsPath = join(data, 'workspace-views', 'tabs.json');
  writeFileSync(viewsPath, '{synthetic-damaged-views', { mode: 0o600 });
  await page.getByRole('button', { name: 'Refresh views', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Saved views could not be loaded' }).waitFor();
  await page.screenshot({ animations: 'disabled', path: join(output, 'views-recovery-mobile.png') });
  await page.getByRole('button', { name: 'Reset saved views', exact: true }).click();
  await page.getByRole('button', { name: 'Keep current views', exact: true }).click();
  assert.equal(readFileSync(viewsPath, 'utf8'), '{synthetic-damaged-views');
  await page.getByRole('button', { name: 'Reset saved views', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await page.getByText('Saved views reset. Standard navigation remains.', { exact: true }).waitFor();
  assert.equal((await request('/api/workspace-tabs')).state.tabs.length, 0);
  const archive = readdirSync(join(data, 'workspace-views')).find(file => file.startsWith('tabs-recovery-'));
  assert.equal(readFileSync(join(data, 'workspace-views', archive), 'utf8'), '{synthetic-damaged-views');
  assert.equal((await request('/api/expected-bills')).bills.length, 1);
  assert.equal((await request('/api/recipes')).recipes.length, 1);
  assert.deepEqual(errors, []);
  rmSync(join(output, 'failure.png'), { force: true });
  writeFileSync(join(output, 'ui-receipt.json'), JSON.stringify({ checkedAt: new Date().toISOString(), layer: 'local-built-ui-with-real-api', realServer: true, realSavedViewPersistence: true, syntheticBusinessRecords: true, fakeOfflineWorker: true, authenticatedRoutes: ['GET', 'PUT', 'reset'], apiAddRenameReorderHideShowRemove: true, readOnlySavedViews: true, askBudNavigation: true, reloadAndDeepLink: true, realTasksBillsJobsViews: true, deskMailReplacesTasksWithoutCreatingViews: true, mailSavedFilter: true, mailEmptyCoverageNotClaimed: true, jobOpensExactPlan: true, unsavedJobWordingPreserved: true, sharedWorkRequiresSignIn: true, staleApiRevisionRejected: true, coreShortcuts: true, desktop: 1365, mobile: 390, noHorizontalOverflow: true, explicitRecoveryResetAndCancellation: true, damagedBytesArchived: true, businessRecordsPreserved: true, pageErrors: errors,
    limits: ['Built React UI and isolated local service with synthetic business records and an offline worker; no installed-device, live integration or customer proof.', 'Saved views are seeded and changed through the revisioned API. Bud approval/execution, removed manual editing and stale-editor draft retention are not exercised.', 'Desk mail now replaces the work area without creating a shortcut; saved mail presentation is checked using an API-seeded view. No Gmail collection, model calls or external sends.'],
  }, null, 2) + '\n');
  console.log('PASS: saved-view API mutations and stale revisions; desktop/phone read-only presentation, persistence, filtered source views, Desk mail navigation, core shortcuts and corruption recovery. All business records are synthetic; no paid provider or office calls.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ animations: 'disabled', path: join(output, 'failure.png') }).catch(() => {}); console.error((await page.getByRole('alert').allTextContents()).join(' | ')); }
  throw error;
} finally {
  await browser?.close();
  if (child) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(temp, { recursive: true, force: true });
}
