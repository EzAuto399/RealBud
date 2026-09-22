// Local browser audit only. Company responses are synthetic; no office is joined.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A dated run writes its own folder; the default keeps the original receipt location.
const output = process.env.REALBUD_QA_OUTPUT ? resolve(process.env.REALBUD_QA_OUTPUT) : join(root, 'outputs/production-lifecycle-2026-09-20');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'rb-solo-office-'));
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
  child = spawn(process.execPath, [process.env.REALBUD_SERVER_ENTRY || join(root, 'server/index.ts')], { cwd: root,
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, REALBUD_HERMES_CLI: worker, OMB_PORT: String(port), OMB_STATIC_DIR: join(root, 'dist'), VITEST: 'true' },
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
  await page.goto(origin + '/#you-office');
  await page.getByRole('button', { name: /^You\b/ }).first().click();
  const office = page.locator('details').filter({ has: page.getByText('This office', { exact: true }) }).first();
  if (await office.count()) await office.evaluate(node => { node.open = true; });
  const collaboration = page.getByRole('heading', { name: 'Local office collaboration', exact: true });
  await collaboration.waitFor();
  const ordered = await page.locator('.settings-section-body').filter({ has: collaboration }).evaluate(node => {
    const labels = ['This office', 'Local office collaboration', 'Website account'];
    const positions = labels.map(label => node.textContent.indexOf(label));
    return positions.every(position => position >= 0) && positions[0] < positions[1] && positions[1] < positions[2];
  });
  assert.ok(ordered, 'Office basics must appear before optional collaboration and website linking');
  assert.equal(await page.getByText(/Optional. Use RealBud on your own/).count(), 1);
  await page.getByRole('button', { name: 'Use on my own', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Join an office', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Connect to an existing host', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Use on my own', exact: true }).click();
  assert.equal(await page.getByLabel('Connect to an existing host', { exact: true }).count(), 0);
  await collaboration.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'solo-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await collaboration.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'solo-mobile.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(output, 'solo-mobile-dark-preference.png') });
  // Exercise the real fetch/error mapping through the renderer with a rejected
  // synthetic join. It must explain the binding conflict, not blame a username.
  await page.route('**/api/company/status', route => route.fulfill({ json: { storageAvailable: true, configured: true, setupAllowed: false, transport: 'encrypted-company', limitations: [] } }));
  await page.getByRole('button', { name: 'Check company status', exact: true }).click();
  await page.getByRole('button', { name: 'Join company', exact: true }).click();
  await page.getByLabel(/^Private invitation/).fill('fixture_only_invitation_12345678901234567890');
  await page.getByLabel(/^Username/).fill('fixture.person');
  await page.getByLabel(/^Password/).fill('Fixture-only-password-2026');
  let code = 'host_identity_mismatch'; let requests = 0;
  await page.route('**/api/company/join', route => { requests++; return route.fulfill({ status: 409, json: { code, error: 'private backend detail' } }); });
  await page.getByRole('button', { name: 'Join and sign in', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'different office' }).waitFor();
  assert.equal(await page.getByText('private backend detail', { exact: true }).count(), 0);
  assert.equal(requests, 1);
  code = 'seat_identity_conflict';
  await page.getByRole('button', { name: 'Join and sign in', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'another member' }).waitFor();
  assert.equal(requests, 2);
  await page.screenshot({ path: join(output, 'join-conflict-mobile.png') });
  // Administration and local recovery are rendered from synthetic contracts;
  // PostgreSQL/TLS mutation proof lives in the integration suites.
  let hostMode = 'active';
  const company = { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic neighbourhood office' };
  const member = { id: '22222222-2222-4222-8222-222222222222', displayName: 'Practice owner', role: 'owner' };
  const colleague = { id: '33333333-3333-4333-8333-333333333333', displayName: 'Practice colleague with a longer display name', role: 'member', active: true, joinedAt: new Date().toISOString() };
  const officeStatus = () => ({ storageAvailable: true, configured: true, setupAllowed: false, transport: 'local-only', limitations: [], company, member, hostMode, hostRecoveryAvailable: true });
  await page.unroute('**/api/company/status');
  await page.route('**/api/company/status', route => route.fulfill({ json: officeStatus() }));
  let removed = false;
  await page.route('**/api/company/membership/management', route => route.fulfill({ json: { members: [{ ...member, active: true, joinedAt: new Date().toISOString() }, { ...colleague, active: !removed }], invitations: [], transfer: null, offset: 0, hasMore: false, unresolvedWork: false } }));
  await page.route('**/api/company/members/revoke', async route => { assert.equal(route.request().postDataJSON().memberId, colleague.id); removed = true; await route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/company/host-recovery', route => route.fulfill({ json: { version: 1, mode: hostMode, busy: false } }));
  let backups = 0;
  await page.route('**/api/company/host-recovery/backup', route => {
    const value = route.request().postDataJSON(); assert.equal(value.retireSource, false); assert.equal(value.passphrase, 'Synthetic backup passphrase'); backups++;
    return route.fulfill({ json: { backup: { format: 'realbud-office', fixture: true }, receipt: { sha256: 'a'.repeat(64) } } });
  });
  await page.getByRole('button', { name: 'Check company status', exact: true }).click();
  await page.getByText('Members, invitations and ownership', { exact: true }).click();
  await page.getByRole('button', { name: 'Remove access', exact: true }).click();
  await page.getByRole('group', { name: `Remove ${colleague.displayName}`, exact: true }).waitFor();
  assert.equal(removed, false, 'Opening confirmation must not revoke');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByText(/Practice colleague with a longer display name · access removed/).waitFor();
  await page.getByText('Host backup and recovery', { exact: true }).click();
  const backupSection = page.locator('details').filter({ has: page.getByText('Host backup and recovery', { exact: true }) }).last();
  await backupSection.getByLabel('Backup passphrase', { exact: true }).fill('Synthetic backup passphrase');
  await backupSection.getByLabel('Repeat backup passphrase', { exact: true }).fill('Synthetic backup passphrase');
  const [download] = await Promise.all([page.waitForEvent('download'), backupSection.getByRole('button', { name: 'Generate backup', exact: true }).click()]);
  assert.match(download.suggestedFilename(), /^realbud-office-/);
  await backupSection.getByText(/Encrypted backup generated and download requested/).waitFor();
  assert.equal(backups, 1);
  await backupSection.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'host-backup-mobile-dark-preference.png') });
  await page.setViewportSize({ width: 1365, height: 1024 });
  await page.emulateMedia({ colorScheme: 'light' });
  await collaboration.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'owner-desktop.png') });
  hostMode = 'standby';
  await page.getByRole('button', { name: 'Check company status', exact: true }).click();
  await page.getByText('Office host on hold', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create invitation', exact: true }).count(), 0);
  await backupSection.getByRole('button', { name: 'Activate verified host', exact: true }).waitFor();
  assert.equal(await backupSection.getByRole('button', { name: 'Activate verified host', exact: true }).isDisabled(), true);
  // A local recovery journal remains accessible when the remote host is down.
  await page.unroute('**/api/company/status');
  await page.route('**/api/company/status', route => route.fulfill({ status: 503, json: { error: 'Synthetic host offline' } }));
  let archived = false;
  const requestId = '44444444-4444-4444-8444-444444444444';
  await page.route('**/api/company/local-state', route => route.fulfill({ json: { remoteHost: true, pendingShare: archived ? null : { requestId, title: 'Synthetic invoice review', phase: 'pending' }, departure: null, enrollmentPending: false } }));
  await page.route('**/api/company/outbox/archive', route => { const body = route.request().postDataJSON(); assert.equal(body.requestId, requestId); assert.equal(body.acknowledgeUnknown, true); archived = true; return route.fulfill({ json: { ok: true } }); });
  await page.getByRole('button', { name: 'Check company status', exact: true }).click();
  await page.getByText('Connection and work recovery', { exact: true }).click();
  await page.getByRole('button', { name: 'Refresh local recovery', exact: true }).click();
  await page.getByText(/Synthetic invoice review.*remote result not yet confirmed/).waitFor();
  await page.getByRole('button', { name: 'Review local archive', exact: true }).click();
  await page.getByText(/It does not cancel or delete anything on the office host/).waitFor();
  assert.equal(archived, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Archive share recovery', exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'outage-recovery-mobile.png') });
  await page.getByRole('button', { name: 'Archive with outcome recorded', exact: true }).click();
  await page.getByText('Recovery record archived locally. The remote outcome has not been changed.', { exact: true }).waitFor();
  assert.equal(archived, true);
  assert.deepEqual(errors, []);
  // One join code (23 September): a damaged paste is refused before any
  // request; a valid one connects with its host part and carries the
  // invitation into the join form. Synthetic host responses only.
  const { encodeCompanyJoinCode } = await import(pathToFileURL(join(root, 'src/lib/company-join-code.ts')).href);
  const hostPart = 'RB1.' + 'Fixture_only_host_identity_0123456789'.padEnd(64, 'x');
  const invitationPart = 'fixture_only_invitation_12345678901234567890';
  const joinCode = encodeCompanyJoinCode(hostPart, invitationPart);
  const joinPage = await context.newPage(); const joinErrors = []; const connectBodies = [];
  joinPage.on('pageerror', error => joinErrors.push(error.message));
  await joinPage.route('**/api/company/connect-host', route => { connectBodies.push(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ json: { ok: true } }); });
  await joinPage.goto(origin + '/#you-office');
  await joinPage.getByRole('button', { name: /^You\b/ }).first().click();
  const joinOffice = joinPage.locator('details').filter({ has: joinPage.getByText('This office', { exact: true }) }).first();
  if (await joinOffice.count()) await joinOffice.evaluate(node => { node.open = true; });
  await joinPage.getByRole('button', { name: 'Join an office', exact: true }).click();
  const joinField = joinPage.getByLabel('Connect to an existing host', { exact: true });
  await joinField.fill(joinCode.slice(0, -1) + (joinCode.endsWith('0') ? '1' : '0'));
  await joinPage.getByRole('button', { name: 'Connect to host', exact: true }).click();
  await joinPage.getByText(/incomplete or was changed/).first().waitFor();
  assert.equal(connectBodies.length, 0, 'A damaged join code must be refused before any request.');
  await joinPage.screenshot({ path: join(output, 'join-code-damaged-desktop.png') });
  await joinPage.route('**/api/company/status', route => route.fulfill({ json: { storageAvailable: true, configured: true, setupAllowed: false, transport: 'encrypted-company', limitations: [] } }));
  await joinField.fill(joinCode);
  await joinPage.getByRole('button', { name: 'Connect to host', exact: true }).click();
  await joinPage.getByText('Filled in from your join code.', { exact: true }).waitFor();
  assert.deepEqual(connectBodies, [{ hostCode: hostPart }]);
  assert.equal(await joinPage.getByLabel(/^Private invitation/).inputValue(), invitationPart);
  await joinPage.screenshot({ path: join(output, 'join-code-connected-desktop.png') });
  await joinPage.setViewportSize({ width: 390, height: 844 });
  assert.ok(await joinPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await joinPage.screenshot({ path: join(output, 'join-code-connected-mobile.png') });
  assert.deepEqual(joinErrors, []);
  console.log('PASS: one join code refuses a damaged paste without a request, connects with the host part and fills the invitation (1365/390)');
  console.log('PASS: guided solo/join choices, explicit member revocation confirmation, backup download receipt, offline share archival confirmation;  basics-first layout; optional solo/office/website wording; 1365/390 layouts; both binding errors through actual fetch + UI; no automatic replay; no browser errors. Synthetic company responses only.');
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
