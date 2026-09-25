// Actual packaged Electron + PostgreSQL, with fictional people and no model calls.
// --keep-open leaves the native window available; closing it tears down the fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCompanyPostgresFixture } from '../server/company/testing-postgres.ts';
import { createCompanyKernel } from '../server/company/index.ts';
import { createPrivateVault } from '../server/private-vault.ts';
import { serviceIdentity, SERVICE_PORTS } from '../electron/service-instance.mjs';
import { requestServiceStop } from '../electron/service-lifecycle.mjs';

if (!process.env.PLAYWRIGHT_MODULE || !process.env.REALBUD_DESKTOP_EXECUTABLE) throw new Error('Set PLAYWRIGHT_MODULE and REALBUD_DESKTOP_EXECUTABLE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.REALBUD_QA_OUTPUT || join(root, 'outputs/business-desktop-2026-09-21'));
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-business-preview-'));
const data = join(temp, 'data'), userData = join(temp, 'electron');
mkdirSync(data, { mode: 0o700 }); mkdirSync(userData, { mode: 0o700 });
const executable = process.env.REALBUD_DESKTOP_EXECUTABLE;
const resources = resolve(dirname(executable), '../Resources');
const key = randomBytes(32), controlToken = randomBytes(32).toString('hex');
const identity = serviceIdentity(data);
let fixture, child, app, nativeChild, mobileBrowser, handle, origin, page;
let logs = '';
const checks = [];
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = () => child && child.exitCode === null && child.signalCode === null;
async function stopService() {
  if (!alive()) return;
  await requestServiceStop(handle, identity);
  for (let i = 0; i < 50 && alive(); i++) await delay(100);
  if (alive()) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]); }
  if (alive()) { child.kill('SIGKILL'); await once(child, 'exit'); }
}
async function openOffice(page) {
  await page.getByRole('button', { name: /^You\b/ }).first().click();
  // The You page mounts after the click; wait for the section rather than skipping it.
  const summary = page.locator('summary').filter({ has: page.getByText('This office', { exact: true }) }).first();
  await summary.waitFor();
  await summary.evaluate(node => { node.parentElement.open = true; });
  await page.getByRole('heading', { name: 'Local office collaboration', exact: true }).waitFor();
}
async function expand(page, text) {
  const summary = page.locator('summary').filter({ hasText: text }).first();
  await summary.evaluate(node => { node.parentElement.open = true; });
}
try {
  fixture = await startCompanyPostgresFixture({ outputDirectory: temp, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@16/bin' });
  const kernel = createCompanyKernel(fixture.pool);
  const owner = await kernel.createCompany({ name: 'Fictional Acacia office', ownerName: 'Practice owner', singleHost: true, credential: { loginName: 'practice.owner', password: 'Fictional-preview-password-2026' } });
  const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Practice accountant' });
  const accountant = await kernel.redeemInvitation(invitation.invitationToken, { loginName: 'practice.accounts', password: 'Fictional-accounts-password-2026' });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ profile: { name: 'Practice owner' }, instances: { fixture: { driver: 'not-a-real-driver', displayName: 'Assistance disabled in preview' } } }), { mode: 0o600 });
  // This isolated preview starts with desktop control paused; no permissions or accounts are used.
  writeFileSync(join(userData, 'cua-human-pause.json'), JSON.stringify({ version: 1, paused: true }), { mode: 0o600 });
  const receiptId = randomBytes(16).toString('hex');
  await createPrivateVault(data, key).write(`offline-detachment-${receiptId}`, { version: 1, id: receiptId, companyId: randomUUID(), memberId: randomUUID(), detachedAt: new Date().toISOString(), remoteRevocationConfirmed: false });
  const port = await (async () => {
    for (const candidate of SERVICE_PORTS) {
      try { await fetch(`http://127.0.0.1:${candidate}/api/health`, { signal: AbortSignal.timeout(700) }); } catch { return candidate; }
    }
    throw new Error('No desktop service port is free.');
  })();
  origin = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, OMB_USER_DATA: userData,
    REALBUD_HERMES_HOME: join(data, 'hermes'), HERMES_HOME: join(data, 'hermes'), VITEST: 'true',
    REALBUD_COMPANY_DATABASE_URL: fixture.applicationUrl, REALBUD_DESK_KEY: key.toString('hex'),
    REALBUD_MANAGED_SERVICE: '1', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '1', REALBUD_SERVICE_CONTROL_TOKEN: controlToken,
    OMB_PORT: String(port), OMB_STATIC_DIR: join(resources, 'ui') };
  child = spawn(executable, [join(resources, 'server/bootstrap.js')], { cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  handle = { version: 1, pid: child.pid, port, instanceId: identity.instanceId, startedAt: Date.now(), controlToken };
  writeFileSync(join(data, 'service.json'), JSON.stringify(handle), { mode: 0o600 });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (!alive()) throw new Error(`Preview service exited: ${logs.slice(-1500)}`);
    try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {}
    await delay(150);
  }
  assert.ok(ready, 'Packaged service must start');
  const session = (await (await fetch(origin + '/api/session')).json()).token;
  const signedIn = await fetch(origin + '/api/company/sign-in', { method: 'POST', headers: { 'content-type': 'application/json', 'x-realbud-session': session }, body: JSON.stringify({ loginName: 'practice.owner', password: 'Fictional-preview-password-2026' }) });
  assert.equal(signedIn.status, 200);
  const memberToken = (await signedIn.json()).memberToken;
  // First run is a server receipt (/api/onboarding), not a browser flag: walk the
  // same profile -> office-rules -> complete stages the welcome screens record.
  const onboardingHeaders = { 'content-type': 'application/json', 'x-realbud-session': session, 'x-realbud-member-session': memberToken };
  let onboarding = await (await fetch(origin + '/api/onboarding', { headers: onboardingHeaders })).json();
  for (const stage of ['office-rules', 'complete']) {
    if (onboarding.stage === 'complete') break;
    const saved = await fetch(origin + '/api/onboarding', { method: 'PUT', headers: onboardingHeaders, body: JSON.stringify({ expectedScope: onboarding.scope, expectedRevision: onboarding.revision, stage }) });
    onboarding = await saved.json();
    assert.equal(saved.status, 200, `Onboarding ${stage} failed: ${JSON.stringify(onboarding)}`);
  }
  assert.equal(onboarding.stage, 'complete', 'Server must record first run as complete');
  delete env.REALBUD_SERVICE_CONTROL_TOKEN;
  delete env.REALBUD_DESK_KEY;
  nativeChild = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let nativeLogs = '';
  nativeChild.stdout.on('data', bytes => { nativeLogs += bytes; }); nativeChild.stderr.on('data', bytes => { nativeLogs += bytes; });
  let endpoint;
  for (let i = 0; i < 100; i++) {
    endpoint = nativeLogs.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
    if (endpoint) break;
    if (nativeChild.exitCode !== null) throw new Error(`Native app exited: ${nativeLogs.slice(-1000)}`);
    await delay(200);
  }
  assert.ok(endpoint, `Native debugging endpoint unavailable: ${nativeLogs.slice(-1000)}`);
  app = await chromium.connectOverCDP(endpoint);
  const context = app.contexts()[0];
  page = context.pages()[0];
  if (!page) page = await context.waitForEvent('page', { timeout: 30_000 });
  page.setDefaultTimeout(15_000);
  await page.waitForURL(origin + '/**');
  const init = token => { sessionStorage.setItem('realbud.company-member-session', token); };
  await page.context().addInitScript(init, memberToken);
  await page.reload();
  page.on('pageerror', error => errors.push(error.message));
  await page.bringToFront();
  await page.evaluate(() => { document.title = 'RealBud — fictional business preview'; });
  assert.equal((await page.evaluate(() => window.ogb.serviceStatus())).manageable, true);
  checks.push('Actual packaged native preload and authenticated service adoption');
  await page.screenshot({ path: join(output, 'desk-native.png') });
  await openOffice(page); await expand(page, 'Departments and access');
  const departments = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Departments and access$/ }) }).last();
  await departments.getByLabel('New department name').fill('Accounts');
  await departments.getByRole('button', { name: 'Create department', exact: true }).click();
  await departments.getByRole('button', { name: 'Manage Accounts', exact: true }).click();
  const select = departments.getByLabel('Access for Practice accountant', { exact: true });
  await select.selectOption('read');
  await departments.getByRole('button', { name: 'Save access for Practice accountant', exact: true }).click();
  await departments.getByText('Department access saved and checked.', { exact: true }).waitFor();
  let record = (await kernel.listDepartments(owner.sessionToken)).departments[0];
  assert.equal((await kernel.departmentAccess(owner.sessionToken, { departmentId: record.id })).members.find(m => m.id === accountant.memberId).access, 'read');
  await select.selectOption('write');
  await departments.getByRole('button', { name: 'Save access for Practice accountant', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  assert.equal((await kernel.departmentAccess(owner.sessionToken, { departmentId: record.id })).members.find(m => m.id === accountant.memberId).access, 'write');
  await select.selectOption('none');
  await departments.getByRole('button', { name: 'Save access for Practice accountant', exact: true }).click();
  await departments.getByRole('group', { name: 'Confirm department access change', exact: true }).waitFor();
  assert.equal((await kernel.departmentAccess(owner.sessionToken, { departmentId: record.id })).members.find(m => m.id === accountant.memberId).access, 'write');
  await departments.getByRole('button', { name: 'Keep current access', exact: true }).click();
  await select.selectOption('read');
  await departments.getByRole('button', { name: 'Save access for Practice accountant', exact: true }).click();
  await departments.getByRole('button', { name: 'Confirm access change', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  assert.equal((await kernel.departmentAccess(owner.sessionToken, { departmentId: record.id })).members.find(m => m.id === accountant.memberId).access, 'read');
  checks.push('Native department creation, persisted read/edit grants, reduction confirmation and cancellation');
  // Stale concurrent permissions must fail visibly and require refreshed authority.
  record = (await kernel.listDepartments(owner.sessionToken)).departments[0];
  await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: record.id, memberId: accountant.memberId, access: 'none', expectedRevision: record.revision });
  await select.selectOption('write');
  await departments.getByRole('button', { name: 'Save access for Practice accountant', exact: true }).click();
  await departments.getByRole('alert').waitFor();
  assert.equal(await select.count(), 0);
  await departments.getByRole('button', { name: 'Refresh departments', exact: true }).click();
  await select.waitFor(); assert.equal(await select.inputValue(), 'none');
  await select.selectOption('read');
  await departments.getByRole('button', { name: 'Save access for Practice accountant', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  checks.push('Stale native permission edit rejected; refreshed database state replaces old controls');
  await departments.getByRole('heading', { name: 'Who can use Accounts' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'departments-native.png') });
  await expand(page, 'Connection and work recovery');
  await page.getByText('Past office access still needs checking', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'recovery-native.png') });
  await page.reload(); await openOffice(page); await expand(page, 'Connection and work recovery');
  await page.getByText('Past office access still needs checking', { exact: true }).waitFor();
  checks.push('Encrypted offline-detachment receipt visible after native renderer reload');
  await page.getByRole('button', { name: 'Stop the office service', exact: true }).click();
  await page.getByRole('group', { name: 'Confirm stopping the office service', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0, 'Native focus must not scroll the app shell out of view');
  assert.ok((await fetch(origin + '/api/health')).ok, 'Opening stop confirmation must leave office running');
  await page.screenshot({ path: join(output, 'service-confirmation-native.png') });
  await page.getByRole('button', { name: 'Keep service running', exact: true }).click();
  assert.equal((await page.evaluate(() => window.ogb.serviceStatus())).running, true);
  checks.push('Native stop-impact confirmation and cancellation leave the office service running');
  await expand(page, /^Advanced/);
  await page.getByRole('heading', { name: 'Keeping your records', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0, 'Deep settings retain the app shell');
  await page.getByText('Automatic deletion after a set number of days is not enabled.', { exact: false }).waitFor();
  await page.screenshot({ path: join(output, 'records-native.png') });
  await page.getByRole('region', { name: 'Private workspace backup', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open saved-job import and export', exact: true }).click();
  assert.ok(await page.locator('#you-packs').isVisible());
  checks.push('Records guidance distinguishes shared office backups from encrypted private business backup; recovery controls render in the native app');
  await page.goto(origin + '/#/views');
  await page.getByRole('heading', { name: 'Manage saved views', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add saved view', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('Accounts work');
  await page.getByLabel('Work to show', { exact: true }).selectOption('tasks');
  await page.getByLabel('Filter', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByText('Saved view added.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Open Accounts work', exact: true }).waitFor();
  await page.screenshot({ animations: 'disabled', path: join(output, 'custom-tabs-native.png') });
  await page.getByRole('button', { name: 'Open Accounts work', exact: true }).click();
  await page.getByRole('heading', { name: 'Accounts work', exact: true }).waitFor();
  const savedViews = await (await fetch(origin + '/api/workspace-tabs', { headers: { 'x-realbud-session': session } })).json();
  assert.equal(savedViews.state.tabs[0].label, 'Accounts work');
  checks.push('Native saved-view creation, persistent reload and real task view navigation');
  await page.goto(origin + '/#/schedule');
  const packCard = page.getByRole('region', { name: 'Customer workflow pack setup', exact: true });
  await packCard.getByRole('button', { name: 'Preview Austin office pack', exact: true }).click();
  await packCard.getByRole('group', { name: 'Review customer pack import', exact: true }).waitFor();
  await packCard.getByRole('button', { name: 'Import reviewed pack', exact: true }).click();
  await packCard.getByText('Plans and instructions installed', { exact: true }).waitFor();
  const packResult = await (await fetch(origin + '/api/customer-packs', { headers: { 'x-realbud-session': session } })).json();
  assert.equal(packResult.installations[0].localReady, true);
  assert.equal(packResult.installations[0].checks.find(check => check.id === 'workflow-acceptance').state, 'unknown');
  await packCard.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: join(output, 'customer-pack-native.png') });
  checks.push('Native customer-pack resource loading, preview, import and truthful incomplete live acceptance');
  await openOffice(page);

  // Narrow browser layout uses the same packaged server, real database and built assets.
  mobileBrowser = await chromium.launch({ headless: true });
  const mobile = await mobileBrowser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.addInitScript(init, memberToken); await mobile.goto(origin);
  await openOffice(mobile); await expand(mobile, 'Departments and access');
  await mobile.getByRole('button', { name: 'Manage Accounts', exact: true }).click();
  await mobile.getByLabel('Access for Practice accountant').waitFor();
  await mobile.getByRole('heading', { name: 'Who can use Accounts' }).scrollIntoViewIfNeeded();
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.screenshot({ path: join(output, 'departments-mobile.png') });
  await expand(mobile, 'Connection and work recovery');
  await mobile.getByText('Past office access still needs checking', { exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.screenshot({ path: join(output, 'recovery-mobile.png') });
  await mobileBrowser.close(); mobileBrowser = null;
  checks.push('390px department and recovery UI with no horizontal overflow');
  await expand(page, 'Departments and access');
  await page.getByRole('button', { name: 'Manage Accounts', exact: true }).click();
  await page.getByLabel('Access for Practice accountant').waitFor();
  await page.getByRole('heading', { name: 'Who can use Accounts' }).scrollIntoViewIfNeeded();
  assert.deepEqual(errors, []);
  rmSync(join(output, 'native-failure.png'), { force: true });
  writeFileSync(join(output, 'native-qa.json'), JSON.stringify({ date: new Date().toISOString(), executable, native: true, database: fixture.version, fictionalDataOnly: true, checks, rendererErrors: errors, limitations: ['Unsigned local Mac build', 'No model calls, bank accounts or customer office', 'Same-Mac PostgreSQL fixture; no physical peer/device proof', 'Department access administration only; no departmental work queue or retirement'] }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, output, nativeWindowOpen: process.argv.includes('--keep-open') }));
  if (process.argv.includes('--keep-open')) {
    writeFileSync(join(output, 'preview-processes.json'), JSON.stringify({ controllerPid: process.pid, appPid: nativeChild.pid, servicePid: child.pid, temporaryDirectory: temp, cleanup: 'Quit this fictional preview window to stop its service and remove its temporary database.' }, null, 2));
    await Promise.race([once(nativeChild, 'exit'), page.waitForEvent('close', { timeout: 0 })]);
  }
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, 'native-failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-12_000));
  }
  throw error;
} finally {
  await mobileBrowser?.close().catch(() => {});
  await app?.close().catch(() => {});
  if (nativeChild && nativeChild.exitCode === null && nativeChild.signalCode === null) {
    nativeChild.kill('SIGTERM');
    await Promise.race([once(nativeChild, 'exit'), delay(5000)]);
    if (nativeChild.exitCode === null && nativeChild.signalCode === null) nativeChild.kill('SIGKILL');
  }
  await stopService();
  await fixture?.stop();
  rmSync(temp, { recursive: true, force: true });
}
