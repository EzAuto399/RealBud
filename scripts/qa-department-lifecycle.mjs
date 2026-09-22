// Real local PostgreSQL + HTTP + rendered UI, fictional data only. No worker or remote actions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { startCompanyPostgresFixture } from '../server/company/testing-postgres.ts';
import { createPrivateVault } from '../server/private-vault.ts';
import { createCompanyKernel } from '../server/company/index.ts';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to installed Playwright.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = process.cwd(), output = resolve(process.env.QA_OUTPUT || 'outputs/department-lifecycle-2026-09-21');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync('/tmp/rbd-life-'), data = join(temp, 'data'); mkdirSync(data);
let fixture, child, browser, page, logs = '', failure;
const checks = [], errors = [], writes = [];
const pass = label => { checks.push(label); console.log('PASS ' + label); };
const stopService = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await stopped; } finally { clearTimeout(timer); }
};
try {
  fixture = await startCompanyPostgresFixture({ outputDirectory: temp, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@16/bin' });
  const kernel = createCompanyKernel(fixture.pool);
  const owner = await kernel.createCompany({ name: 'Fictional Acacia office', ownerName: 'Practice owner', singleHost: true, credential: { loginName: 'practice.owner', password: 'Fictional-preview-password-2026' } });
  const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Practice colleague' });
  const colleague = await kernel.redeemInvitation(invitation.invitationToken);
  const department = await kernel.createDepartment(owner.sessionToken, { name: 'Operations', requestId: randomUUID() });
  await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: colleague.memberId, access: 'write', expectedRevision: '0' });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ profile: { name: 'Practice owner' }, instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const privateKey = randomBytes(32);
  const serverEnv = { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data,
    REALBUD_HERMES_HOME: join(data, 'hermes'), HERMES_HOME: join(data, 'hermes'), REALBUD_DESK_KEY: privateKey.toString('hex'),
    REALBUD_COMPANY_DATABASE_URL: fixture.applicationUrl, OMB_PORT: String(port), OMB_STATIC_DIR: process.env.REALBUD_UI_DIR || join(output, 'ui'),
    REALBUD_MANAGED_SERVICE: '1', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '1', VITEST: 'true' };
  const launch = async () => {
    child = spawn(process.execPath, ['--experimental-strip-types', 'server/bootstrap.ts'], { cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-30000); });
    let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 150)); }
    assert.ok(ready, logs.slice(-1000));
  };
  await launch();
  const vault = createPrivateVault(data, privateKey);
  const bootToken = (await (await fetch(origin + '/api/session')).json()).token;
  const response = await fetch(origin + '/api/company/sign-in', { method: 'POST', headers: { 'content-type': 'application/json', 'x-realbud-session': bootToken }, body: JSON.stringify({ loginName: 'practice.owner', password: 'Fictional-preview-password-2026' }) });
  assert.equal(response.status, 200); const memberToken = (await response.json()).memberToken;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1024 } });
  await context.addInitScript(token => { localStorage.setItem('realbud.first-run-done', '1'); sessionStorage.setItem('realbud.company-member-session', token); }, memberToken);
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/company/departments/cases/') && request.method() === 'POST') writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  const open = async () => {
    if (page.url() === origin + '/#/you') await page.reload();
    else await page.goto(origin + '/#/you');
    const office = page.locator('details').filter({ has: page.getByText('This office', { exact: true }) }).first();
    await office.waitFor(); await office.evaluate(node => { node.open = true; });
    await page.getByRole('heading', { name: 'Local office collaboration', exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: /^Departments and access$/ }).evaluate(node => { node.parentElement.open = true; });
    await page.getByRole('button', { name: 'View work in Operations', exact: true }).click();
    await page.getByRole('region', { name: 'Department work review' }).waitFor();
  };
  const panel = () => page.getByRole('region', { name: 'Department work review' });
  const cases = async () => (await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' })).cases;
  await open();
  await panel().getByRole('button', { name: 'Add a case', exact: true }).click();
  let form = panel().getByRole('form', { name: 'Add department case', exact: true });
  await form.getByLabel('Case title', { exact: true }).fill('Fictional invoice follow-up');
  await form.getByLabel('Case details (optional)', { exact: true }).fill('Confirm the fictional supplier reference. No payment or message is authorized.');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await form.getByLabel('Case title', { exact: true }).inputValue(), 'Fictional invoice follow-up');
  await form.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'case-create-desktop.png') });
  let dropped = false;
  await page.route('**/api/company/departments/cases/create', async route => {
    const result = await route.fetch();
    if (!dropped) { dropped = true; if (result.status() !== 201) errors.push(`Expected create201, received ${result.status()}`); await route.abort('failed'); }
    else await route.fulfill({ response: result });
  });
  await form.getByRole('button', { name: 'Save case', exact: true }).click();
  await page.getByRole('button', { name: 'Acknowledge saved department change', exact: true }).waitFor();
  assert.equal((await cases()).filter(item => item.title === 'Fictional invoice follow-up').length, 1);
  const savedConfirmed = await vault.read('department-outbox'); assert.equal(savedConfirmed.phase, 'confirmed');
  await open();
  await page.getByRole('button', { name: 'Acknowledge saved department change', exact: true }).click();
  await page.getByText('Saved department change confirmed.', { exact: true }).waitFor();
  assert.equal((await cases()).filter(item => item.title === 'Fictional invoice follow-up').length, 1);
  const createWrites = writes.filter(item => item.path.endsWith('/create')); assert.equal(createWrites.length, 1); assert.equal(createWrites[0].body.requestId, (await cases())[0].id);
  await page.unroute('**/api/company/departments/cases/create');
  pass('Lost create response survives full reload; durable confirmed request acknowledges without duplicate case or automatic worker action');
  // Explicit fixture of a lost upstream response: retain the already committed
  // case but restore its encrypted journal to the pre-confirmation shape. This
  // is not claimed to be caused by the earlier browser abort.
  await stopService();
  const { receipt: _proof, ...unknownOperation } = savedConfirmed;
  await vault.write('department-outbox', { ...unknownOperation, phase: 'pending' });
  await launch(); await open();
  const savedPanel = page.getByRole('region', { name: 'Saved department change', exact: true });
  await savedPanel.getByRole('button', { name: 'Retry saved department change', exact: true }).waitFor();
  assert.ok(await panel().getByRole('button', { name: 'Add a case', exact: true }).isDisabled());
  await savedPanel.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'pending-request-desktop.png') });
  await savedPanel.getByRole('button', { name: 'Retry saved department change', exact: true }).click();
  await page.getByText('Saved department change confirmed.', { exact: true }).waitFor();
  const retried = writes.filter(item => item.path.endsWith('/create')); assert.equal(retried.length, 2); assert.deepEqual(retried[0].body, retried[1].body);
  assert.equal((await cases()).length, 1); assert.equal(await vault.read('department-outbox'), undefined);
  pass('Explicit encrypted pending-journal fixture survives owned service restart; exact HTTP replay returns the one committed PostgreSQL case and clears the journal');
  await panel().getByRole('button', { name: 'Refresh department work', exact: true }).click();
  await panel().getByRole('button', { name: /^Change assignment\s*: Fictional invoice follow-up$/ }).click();
  form = panel().getByRole('form', { name: 'Change case assignment', exact: true });
  await form.getByLabel('Person responsible', { exact: true }).selectOption(colleague.memberId);
  await form.getByRole('button', { name: 'Save assignment', exact: true }).click();
  await panel().getByText('Case assignment saved. No work was started on another computer.', { exact: true }).waitFor();
  assert.equal((await cases())[0].assignee.id, colleague.memberId);
  await panel().getByRole('button', { name: /^Change assignment\s*: Fictional invoice follow-up$/ }).click();
  form = panel().getByRole('form', { name: 'Change case assignment', exact: true });
  await form.getByLabel('Person responsible', { exact: true }).selectOption('');
  await form.getByRole('button', { name: 'Save assignment', exact: true }).click();
  await panel().getByText('Case assignment saved. No work was started on another computer.', { exact: true }).waitFor();
  assert.equal((await cases())[0].assignee, null);
  pass('Human assignment and unassignment persist through the actual API to PostgreSQL');
  await page.getByRole('button', { name: /^Retire department\s*: Operations$/ }).click();
  const retirement = page.getByRole('form', { name: 'Retire department', exact: true });
  assert.ok(await retirement.getByRole('button', { name: 'Confirm department retirement', exact: true }).isDisabled());
  await retirement.getByText(/1 unfinished case needs resolution/).waitFor();
  await retirement.getByRole('button', { name: 'Keep department active', exact: true }).click();
  pass('Retirement is a separate explicit action and unfinished cases block confirmation');
  await panel().getByRole('button', { name: /^Close case\s*: Fictional invoice follow-up$/ }).click();
  form = panel().getByRole('form', { name: 'Close department case', exact: true });
  await form.getByLabel('Review note', { exact: true }).fill('Checked the fictional result before closure.');
  await form.getByRole('checkbox').check();
  const current = (await cases())[0];
  await kernel.assignDepartmentCase(owner.sessionToken, { departmentId: department.id, caseId: current.id, expectedFence: current.fence, requestId: randomUUID(), assigneeMemberId: colleague.memberId });
  await form.getByRole('button', { name: 'Record case closure', exact: true }).click();
  await panel().getByRole('alert').waitFor();
  assert.equal(await panel().getByRole('form', { name: 'Close department case', exact: true }).count(), 0);
  assert.equal((await cases())[0].status, 'open');
  pass('Stale fence refuses closure and clears privileged decision state without changing the current case');
  await panel().getByRole('button', { name: 'Refresh department work', exact: true }).click();
  await panel().getByRole('button', { name: /^Close case\s*: Fictional invoice follow-up$/ }).click();
  form = panel().getByRole('form', { name: 'Close department case', exact: true });
  assert.ok(await form.getByRole('button', { name: 'Record case closure', exact: true }).isDisabled());
  await form.getByLabel('Review note', { exact: true }).fill('Reviewed with the fictional colleague. The reference was confirmed.');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await form.getByLabel('Review note', { exact: true }).inputValue(), 'Reviewed with the fictional colleague. The reference was confirmed.');
  await form.getByRole('checkbox').check();
  await page.setViewportSize({ width: 390, height: 844 }); await form.scrollIntoViewIfNeeded();
  assert.ok(await form.getByRole('button', { name: 'Record case closure', exact: true }).evaluate(element => element.getBoundingClientRect().height >= 44));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: join(output, 'case-close-mobile.png') });
  await form.getByRole('button', { name: 'Record case closure', exact: true }).click();
  await panel().getByText('Case closure recorded with your note. No external action was performed.', { exact: true }).waitFor();
  assert.equal((await cases())[0].status, 'done'); assert.equal((await cases())[0].lastClosure.note, 'Reviewed with the fictional colleague. The reference was confirmed.');
  pass('Confirmed human closure requires note and checkbox, preserves focus draft, and works at390px without overflow');
  await page.setViewportSize({ width: 1365, height: 1024 });
  await page.getByRole('button', { name: /^Retire department\s*: Operations$/ }).click();
  await retirement.getByLabel('Retirement note', { exact: true }).fill('Fictional department has completed its work. Retain the record.');
  await retirement.getByRole('checkbox').check(); await retirement.getByRole('button', { name: 'Confirm department retirement', exact: true }).click();
  await page.getByText('Department retired. Its case history is still available through View work.', { exact: true }).waitFor();
  assert.ok((await kernel.listDepartments(owner.sessionToken)).departments.find(item => item.id === department.id).retiredAt);
  await open();
  await panel().getByText('Retired department · records are read only. Case history and review notes are retained.', { exact: true }).waitFor();
  assert.equal(await panel().getByRole('button', { name: 'Add a case', exact: true }).count(), 0);
  assert.equal(await panel().getByRole('button', { name: /^Change assignment/ }).count(), 0);
  assert.equal(await panel().getByRole('button', { name: /^Close case/ }).count(), 0);
  await panel().getByText('Reviewed with the fictional colleague. The reference was confirmed.', { exact: true }).waitFor();
  await panel().scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'retired-history-desktop.png') });
  pass('Retired department survives reload with closure evidence and no case editing controls');
  await page.getByRole('button', { name: 'Manage Operations', exact: true }).click();
  const access = page.getByRole('region', { name: 'Operations member access', exact: true });
  await access.getByLabel('Access for Practice colleague').selectOption('read');
  await access.getByRole('button', { name: 'Save access for Practice colleague', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm access change', exact: true }).click();
  await page.getByText('Department access saved and checked.', { exact: true }).waitFor();
  assert.equal(await access.getByLabel('Access for Practice colleague').locator('option[value="write"]').count(), 0);
  await access.getByLabel('Access for Practice colleague').selectOption('none');
  await access.getByRole('button', { name: 'Save access for Practice colleague', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm access change', exact: true }).click();
  await page.getByText('Department access saved and checked.', { exact: true }).waitFor();
  assert.equal(await access.getByLabel('Access for Practice colleague').locator('option').count(), 1);
  assert.equal((await kernel.departmentAccess(owner.sessionToken, { departmentId: department.id })).members.find(item => item.id === colleague.memberId).access, 'none');
  pass('Retired owner can reduce and revoke retained history access; removed access has no upgrade option');
  await page.getByRole('button', { name: /^Reopen department\s*: Operations$/ }).click();
  const reopening = page.getByRole('form', { name: 'Reopen department', exact: true });
  assert.ok(await reopening.getByRole('button', { name: 'Confirm department reopening', exact: true }).isDisabled());
  await reopening.getByLabel('Reopening note').fill('Reviewed access. Resume fictional department intake only.');
  await reopening.getByRole('checkbox').check();
  await reopening.getByRole('button', { name: 'Confirm department reopening', exact: true }).click();
  await page.getByText('Department reopened. Existing access applies again. No work was started.', { exact: true }).waitFor();
  assert.equal((await kernel.listDepartments(owner.sessionToken)).departments.find(item => item.id === department.id).retiredAt, null);
  assert.equal((await cases())[0].status, 'done');
  await open(); await panel().getByRole('button', { name: 'Add a case', exact: true }).waitFor();
  pass('Explicit note and confirmation reopen the department without reopening completed cases or restoring removed access');
  // Separate local recovery UI fixtures. The pending fixture represents an
  // unknown result; the confirmed fixture retains a real matching host proof.
  // Journal writes below are synthetic setup, not simulated network evidence.
  const lastClose = writes.filter(item => item.path.endsWith('/close')).at(-1);
  const { receipt: _confirmedProof, ...identity } = savedConfirmed;
  const unknownClose = { ...identity, ...lastClose, input: lastClose.body, phase: 'pending' };
  delete unknownClose.body;
  for (const saved of [unknownClose, savedConfirmed]) {
    await stopService(); await vault.write('department-outbox', saved); await launch(); await open();
    const recovery = page.locator('summary').filter({ hasText: /^Connection and work recovery$/ }).locator('..');
    await recovery.getByRole('button', { name: 'Review department update archive', exact: true }).click();
    const archive = recovery.getByRole('group', { name: 'Archive department update', exact: true });
    await archive.getByText(/It does not undo or cancel the office update/).waitFor();
    const before = writes.length;
    await archive.getByRole('button', { name: 'Archive department outcome locally', exact: true }).click();
    await recovery.getByText('Department recovery receipt archived here. The office result has not been changed.', { exact: true }).waitFor();
    const result = await vault.read(`department-change-${saved.input.requestId}`);
    assert.equal(result.outcome, saved.phase === 'confirmed' ? 'saved' : 'unknown');
    assert.deepEqual(result.input, saved.input); assert.equal(await vault.read('department-outbox'), undefined);
    assert.equal((await cases()).length, 1); assert.equal((await cases())[0].status, 'done'); assert.equal(writes.length, before);
    const history = recovery.locator('summary').filter({ hasText: /^Archived department update receipts$/ }).locator('..');
    await history.locator('summary').click();
    const row = history.locator('li').filter({ hasText: saved.phase === 'confirmed' ? 'saved by the host' : 'outcome unknown' });
    await row.waitFor(); const downloaded = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Download private department receipt', exact: true }).click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), `realbud-department-receipt-${saved.input.requestId}.json`);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.outcome, result.outcome); assert.deepEqual(exported.input, saved.input);
    await recovery.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, `archive-${result.outcome}-desktop.png`) });
    pass(`Explicit encrypted ${saved.phase} journal fixture: real browser local archive and private download retain ${result.outcome} outcome and exact input without changing PostgreSQL case`);
  }
  await open(); await panel().getByRole('button', { name: 'Add a case', exact: true }).click();
  form = panel().getByRole('form', { name: 'Add department case', exact: true });
  await form.getByLabel('Case title', { exact: true }).fill('This revoked session must not create work');
  await kernel.revokeSession(memberToken);
  await form.getByRole('button', { name: 'Save case', exact: true }).click();
  await page.waitForFunction(() => !sessionStorage.getItem('realbud.company-member-session'));
  assert.equal(await page.getByRole('form', { name: 'Add department case', exact: true }).count(), 0);
  assert.equal((await cases()).length, 1); assert.equal(await vault.read('department-outbox'), undefined);
  pass('A real revoked session clears the privileged case draft and token; no case or pending journal is created');
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error.stack || String(error); process.exitCode = 1; console.error(failure);
  if (page) { await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); writeFileSync(join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'No page')); }
} finally {
  await browser?.close();
  await stopService();
  await fixture?.stop(); writeFileSync(join(output, 'browser-service.log'), logs);
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, checks, rendererErrors: errors, postgres: fixture?.version, sourceUi: true, nativePackage: false, fictionalDataOnly: true, failure }, null, 2));
  rmSync(temp, { recursive: true, force: true });
}
