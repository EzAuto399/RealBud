// Disposable real PostgreSQL + source UI. No live office, worker, or account.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { startCompanyPostgresFixture } from '../server/company/testing-postgres.ts';
import { createCompanyKernel } from '../server/company/index.ts';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = process.cwd(), output = resolve('outputs/department-recovery-2026-09-21');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync('/tmp/rbdq-'), data = join(temp, 'data');
mkdirSync(data);
let fixture, child, browser, page, logs = '';
const checks = [], errors = [];
try {
  fixture = await startCompanyPostgresFixture({ outputDirectory: temp, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@16/bin' });
  const kernel = createCompanyKernel(fixture.pool);
  const owner = await kernel.createCompany({ name: 'Fictional Acacia office', ownerName: 'Practice owner', singleHost: true, credential: { loginName: 'practice.owner', password: 'Fictional-preview-password-2026' } });
  const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Practice reviewer' });
  const member = await kernel.redeemInvitation(invitation.invitationToken);
  const department = await kernel.createDepartment(owner.sessionToken, { name: 'Operations', requestId: randomUUID() });
  await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'write', expectedRevision: '0' });
  const work = await kernel.createCase(member.sessionToken, { scopeId: department.id, title: 'Check the synthetic invoice result' });
  const held = await kernel.createCase(member.sessionToken, { scopeId: department.id, title: 'Review the synthetic reconciliation' });
  for (const item of [work, held]) await kernel.claimCase(member.sessionToken, { caseId: item.caseId, ttlMs: 60_000 });
  await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'read', expectedRevision: '1' });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ profile: { name: 'Practice owner' }, instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], { cwd: root, env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data,
    REALBUD_HERMES_HOME: join(data, 'hermes'), HERMES_HOME: join(data, 'hermes'), REALBUD_DESK_KEY: randomBytes(32).toString('hex'),
    REALBUD_COMPANY_DATABASE_URL: fixture.applicationUrl, OMB_PORT: String(port), OMB_STATIC_DIR: process.env.REALBUD_UI_DIR || join(output, 'ui'),
    REALBUD_MANAGED_SERVICE: '1', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '1', VITEST: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 150)); }
  assert.ok(ready, logs.slice(-1000));
  const bootToken = (await (await fetch(origin + '/api/session')).json()).token;
  const signIn = await fetch(origin + '/api/company/sign-in', { method: 'POST', headers: { 'content-type': 'application/json', 'x-realbud-session': bootToken }, body: JSON.stringify({ loginName: 'practice.owner', password: 'Fictional-preview-password-2026' }) });
  assert.equal(signIn.status, 200);
  const memberToken = (await signIn.json()).memberToken;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1024 } });
  await context.addInitScript(token => { localStorage.setItem('realbud.first-run-done', '1'); sessionStorage.setItem('realbud.company-member-session', token); }, memberToken);
  page = await context.newPage(); page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message));
  const open = async () => {
    await page.goto(origin + '/#/you');
    await page.getByRole('button', { name: /^You\b/ }).first().click();
    const section = page.locator('details').filter({ has: page.getByText('This office', { exact: true }) }).first();
    if (await section.count()) await section.evaluate(node => { node.open = true; });
    await page.getByRole('heading', { name: 'Local office collaboration', exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: /^Departments and access$/ }).evaluate(node => { node.parentElement.open = true; });
    await page.getByRole('button', { name: 'View work in Operations', exact: true }).click();
    await page.getByRole('region', { name: 'Department work review' }).waitFor();
  };
  await open();
  const panel = page.getByRole('region', { name: 'Department work review' });
  await panel.getByRole('button', { name: /^Review held work\s*:\s*Check the synthetic invoice result$/ }).click();
  let form = panel.getByRole('form', { name: 'Review interrupted department work' });
  assert.ok(await form.getByRole('button', { name: 'Record recovery decision' }).isDisabled());
  await form.getByLabel('Review note', { exact: true }).fill('Confirmed the synthetic invoice is complete.');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await form.getByLabel('Review note', { exact: true }).inputValue(), 'Confirmed the synthetic invoice is complete.');
  await form.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'review-desktop.png') });
  await form.getByRole('button', { name: 'Keep on hold' }).click();
  assert.equal((await kernel.departmentCases(owner.sessionToken, { departmentId: department.id })).cases.length, 2);
  checks.push('Mandatory review note/confirmation, draft survives refocusing, cancellation preserves hold');
  await panel.getByRole('button', { name: /^Review held work\s*:\s*Check the synthetic invoice result$/ }).click();
  form = panel.getByRole('form', { name: 'Review interrupted department work' });
  await form.getByLabel('Review note', { exact: true }).fill('Confirmed the synthetic invoice is complete.');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Record recovery decision' }).click();
  await panel.getByRole('status').filter({ hasText: 'Recovery decision recorded.' }).waitFor();
  assert.equal((await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' })).cases.find(item => item.id === work.caseId).status, 'done');
  await page.reload();
  await open();
  await panel.getByRole('button', { name: 'All work', exact: true }).click();
  await panel.getByText('Confirmed the synthetic invoice is complete.', { exact: true }).waitFor();
  checks.push('Actual API recovery persists in PostgreSQL and retains review note after full page reload');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: 'Needs review', exact: true }).click();
  await panel.getByRole('button', { name: /^Review held work\s*:\s*Review the synthetic reconciliation$/ }).click();
  form = panel.getByRole('form', { name: 'Review interrupted department work' });
  await form.getByLabel('What did you confirm?', { exact: true }).selectOption('released');
  await form.getByLabel('Review note', { exact: true }).fill('Checked the original system. Nothing was posted.');
  await form.getByRole('checkbox').check();
  await form.scrollIntoViewIfNeeded();
  assert.ok(await form.getByRole('button', { name: 'Record recovery decision' }).evaluate(element => element.getBoundingClientRect().height >= 44));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal page overflow');
  await page.screenshot({ path: join(output, 'review-mobile.png') });
  await form.getByRole('button', { name: 'Record recovery decision' }).click();
  await panel.getByRole('status').filter({ hasText: 'Recovery decision recorded.' }).waitFor();
  assert.equal((await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' })).cases.find(item => item.id === held.caseId).status, 'open');
  assert.equal((await kernel.membershipManagement(member.sessionToken)).unresolvedWork, false);
  checks.push('390px mobile recovery, 44px action, no horizontal overflow, release clears departed-holder blocker');
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'browser-qa.json'), JSON.stringify({ date: new Date().toISOString(), checks, rendererErrors: errors, postgres: fixture.version, sourceUi: true, nativePackage: false, fictionalDataOnly: true }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png') });
    writeFileSync(join(output, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await stopped; clearTimeout(timer);
  }
  await fixture?.stop();
  writeFileSync(join(output, 'browser-service.log'), logs);
  rmSync(temp, { recursive: true, force: true });
}
