import { readSessionToken, primeBrowserSession } from './local-session.mjs';
// Workspace → Approvals: built React UI from REALBUD_UI_DIR against a real,
// disposable local service. Fictional records only; never reads ~/.realbud or dist/.
// Node 24, PLAYWRIGHT_MODULE, REALBUD_UI_DIR (scratch `vite build --outDir`), optional CHROME_EXECUTABLE.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module.');
assert.ok(process.env.REALBUD_UI_DIR, 'Set REALBUD_UI_DIR to a scratch `vite build --outDir` folder; dist/ is shared.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/approvals-qa-2026-10-08'));
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-approvals-'));
const data = join(temp, 'data'); mkdirSync(data, { mode: 0o700 });
const SITE = 'portal.fictional.test', GROUP = `site:${SITE}`;
const checks = [], errors = [], screenshots = [];
let child, browser, page, logs = '';
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const until = async (check, message) => { for (let i = 0; i < 100; i++) { if (await check()) return; await wait(50); } assert.fail(message); };
const shot = async name => { await page.screenshot({ path: join(output, name), animations: 'disabled', fullPage: false }); screenshots.push(name); };
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow');

try {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolveClose => listener.close(resolveClose));
  const origin = `http://127.0.0.1:${port}`;
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver', displayName: 'Offline fixture' } } }), { mode: 0o600 });
  const worker = join(temp, 'worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.3 (2026.9.14)');\n`); chmodSync(worker, 0o755);
  child = spawn(process.execPath, [join(root, 'server/index.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, REALBUD_HERMES_CLI: worker, OMB_PORT: String(port), OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR), ELECTRON_RUN_AS_NODE: '1', VITEST: 'true' } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) { try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {} await wait(200); }
  assert.ok(ready, logs.slice(-1500));
  const token = await readSessionToken(data);
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, { method, headers: { 'x-realbud-session': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const approvals = async () => (await call('/api/approvals')).body.local;

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, origin, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Approvals Reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  await page.locator('.desk-empty-canvas').first().waitFor();

  const workspace = page.locator('aside.rb-sidebar').getByRole('button', { name: 'Workspace', exact: true });
  const section = page.locator('#you-approvals');
  const settings = page.getByRole('region', { name: 'Approval settings', exact: true });
  const row = () => settings.getByRole('radiogroup', { name: SITE, exact: true });
  const option = name => row().locator('label').filter({ hasText: new RegExp(`^${name}$`) });
  const radio = name => row().getByRole('radio', { name, exact: true });
  const save = settings.getByRole('button', { name: 'Save changes', exact: true });
  const statusLine = settings.getByRole('status').filter({ hasText: /\S/ });
  // A hash-only goto stays in the same document; reload so every deep link is a fresh page load.
  const deepLink = async hash => { await page.goto(`${origin}/${hash}`); await page.reload(); await section.waitFor(); await until(() => section.evaluate(element => element.open), `${hash} opens Approvals`); };
  const openApprovals = async () => {
    await workspace.click();
    await section.waitFor();
    if (!(await section.evaluate(element => element.open))) await section.locator('summary').first().click();
    await settings.getByText('Bud always asks before it sends, pays, signs, files a notice, changes an account or deletes. Choose how often it asks about everything else.', { exact: true }).waitFor();
    await settings.getByRole('button', { name: 'Save changes', exact: true }).or(settings.getByRole('alert')).first().waitFor();
  };

  // 1. An empty book with no apps: a calm empty state, the locked block and no saved rules.
  await openApprovals();
  await settings.getByText('No apps, websites or office connectors are connected yet. Each one appears here once you connect it.', { exact: true }).waitFor();
  await settings.getByText('No saved rules.', { exact: true }).waitFor();
  await settings.getByText('No changes yet.', { exact: true }).waitFor();
  assert.equal(await settings.getByRole('radiogroup').filter({ visible: true }).count(), 0, 'No rows on an empty office');
  assert.ok(await save.isDisabled(), 'Nothing to save yet');
  await settings.locator('summary').filter({ hasText: 'Always asks, every time' }).click();
  for (const name of ['Sending messages', 'Payments', 'Signing', 'Notices', 'Account changes', 'Deleting']) {
    const group = settings.getByRole('radiogroup', { name, exact: true });
    assert.deepEqual(await group.getByRole('radio').evaluateAll(items => items.map(item => item.closest('label').textContent)), ['Ask', "Don't use"], `${name} offers only Ask or Don't use`);
  }
  await settings.locator('summary').filter({ hasText: 'Always asks, every time' }).click();
  await noOverflow(); await shot('01-empty-office-1440.png');
  pass('Empty book, no apps: Workspace → Approvals shows the intro, a calm empty state, the locked Always asks block (Ask or Don\'t use only), no saved rules and no changes');

  // 2. A saved site rule gives a website row; change it and save; reload keeps it.
  const rule = await call('/api/rules', 'POST', { surface: 'portal-read', origin: SITE, decision: 'allow' });
  assert.equal(rule.status, 201, JSON.stringify(rule.body));
  await deepLink('#you-approvals');
  await row().waitFor();
  assert.ok(await radio('Ask every time').isChecked(), 'A website asks by default');
  await settings.getByText('Recommended', { exact: true }).first().waitFor();
  await settings.getByRole('button', { name: `Revoke Reading on ${SITE}`, exact: true }).waitFor();
  await option("Don't use").click();
  await settings.getByText('Not saved yet', { exact: true }).waitFor();
  await save.click();
  await statusLine.filter({ hasText: 'Saved.' }).waitFor();
  assert.deepEqual((await approvals()).settings.groups, { [GROUP]: 'deny' });
  await deepLink('#you-rules');
  await row().waitFor();
  assert.ok(await radio("Don't use").isChecked(), 'The saved choice survives a reload');
  await settings.getByText('Saved on this computer', { exact: true }).first().waitFor();
  await settings.getByText(new RegExp(`^This computer · ${SITE.replace(/\./g, '\\.')}: Recommended → Don't use · `)).waitFor();
  await noOverflow(); await shot('02-saved-and-reloaded-1440.png');
  pass('Change a website row to Don\'t use, save, reload (via #you-rules): persisted on the server, row says "Saved on this computer", Changes lists who and when');

  // 3. Keyboard only: Tab into the row, arrow to a new choice, Tab to Save, Enter.
  await section.locator('summary').first().focus();
  let reached = false;
  for (let i = 0; i < 20 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(group => document.activeElement?.getAttribute('name') === `approval-${group}`, GROUP); }
  assert.ok(reached, 'Tab reaches the website row');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('label')?.textContent), "Don't use");
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement.closest('label')).outlineStyle), 'solid', 'The focused choice shows a focus ring');
  await page.keyboard.press('ArrowLeft');
  assert.ok(await radio('Read without asking').isChecked(), 'Arrow keys change the choice');
  let onSave = false;
  for (let i = 0; i < 10 && !onSave; i++) { await page.keyboard.press('Tab'); onSave = await page.evaluate(() => document.activeElement?.textContent === 'Save changes'); }
  assert.ok(onSave, 'Tab reaches Save changes');
  await page.keyboard.press('Enter');
  await statusLine.filter({ hasText: 'Saved.' }).waitFor();
  assert.deepEqual((await approvals()).settings.groups, { [GROUP]: 'read-without-asking' });
  pass('Keyboard only: Tab into the row, ArrowLeft to Read without asking, Tab to Save changes, Enter saves');

  // 4. A stale save keeps the person's edit and asks them to review the latest.
  const before = await approvals();
  const behind = await call('/api/approvals', 'PUT', { expectedRevision: before.revision, settings: { ...before.settings, groups: { ...before.settings.groups, 'class:pay': 'deny' } } });
  assert.equal(behind.status, 200, JSON.stringify(behind.body));
  await option('Ask every time').click();
  await save.click();
  await statusLine.filter({ hasText: 'Someone changed these settings. Review the latest and save again.' }).waitFor();
  assert.ok(await radio('Ask every time').isChecked(), 'The person\'s own edit is kept');
  await settings.getByText('Not saved yet', { exact: true }).waitFor();
  await save.click();
  await statusLine.filter({ hasText: 'Saved.' }).waitFor();
  assert.deepEqual((await approvals()).settings.groups, { 'class:pay': 'deny' }, 'Saving again keeps the other change and applies this one');
  await shot('03-stale-save-resolved-1440.png');
  pass('Stale save: "Someone changed these settings. Review the latest and save again." keeps the edit; saving again merges with the other person\'s change');

  // 5. 390px: reachable from the rail and usable.
  await page.setViewportSize({ width: 390, height: 844 });
  await openApprovals();
  await row().waitFor();
  await option("Don't use").scrollIntoViewIfNeeded();
  await option("Don't use").click();
  await save.scrollIntoViewIfNeeded();
  const box = await save.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 391, 'Save changes fits at 390px');
  await save.click();
  await statusLine.filter({ hasText: 'Saved.' }).waitFor();
  assert.equal((await approvals()).settings.groups[GROUP], 'deny');
  await noOverflow(); await shot('04-phone-390.png');
  pass('At 390px: Workspace → Approvals is reachable from the rail, a row changes and saves, Save fits, no horizontal scroll');
  await page.setViewportSize({ width: 1440, height: 940 });

  // 6. Revoke the saved rule.
  await settings.getByRole('button', { name: `Revoke Reading on ${SITE}`, exact: true }).click();
  await settings.getByText('No saved rules.', { exact: true }).waitFor();
  assert.equal((await call('/api/rules')).body.rules.length, 0);
  pass('Revoke removes the saved site rule (server confirms no rules)');

  // 7. Reset to recommended, behind a confirmation.
  await settings.getByRole('button', { name: 'Reset to recommended', exact: true }).click();
  const confirm = settings.getByRole('group', { name: 'Reset to recommended', exact: true });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.notDeepEqual((await approvals()).settings.groups, {}, 'Cancel changes nothing');
  await settings.getByRole('button', { name: 'Reset to recommended', exact: true }).click();
  await confirm.getByRole('button', { name: 'Reset', exact: true }).click();
  await statusLine.filter({ hasText: 'Reset to recommended.' }).waitFor();
  assert.deepEqual((await approvals()).settings.groups, {});
  await settings.getByText('No apps, websites or office connectors are connected yet. Each one appears here once you connect it.', { exact: true }).waitFor();
  await shot('05-reset-1440.png');
  pass('Reset to recommended asks first (Cancel keeps settings), then clears every saved row');

  // 8. A read-only member (office reply stubbed in the browser; the store's own editor checks are covered by unit tests).
  const department = { id: 'fictional-dept-accounts', name: 'Accounts', canEdit: false, governs: true, revision: '3',
    settings: { version: 1, purpose: 'approval-settings', groups: { [GROUP]: 'ask' }, reviewedReads: [] } };
  await page.route(url => url.pathname === '/api/approvals', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ scope: 'office', local: { revision: 0, canEdit: false, settings: { version: 1, purpose: 'approval-settings', groups: {}, reviewedReads: [] } }, departments: [department] }) }));
  await page.route(url => url.pathname === '/api/approvals/history', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ department: { id: department.id, name: 'Accounts' }, entries: [{ revision: '3', at: '2026-10-08T04:14:00.000Z', by: { id: 'fictional-member', displayName: 'Fictional Kim' },
      before: { version: 1, purpose: 'approval-settings', groups: {}, reviewedReads: [] }, after: department.settings }] }) }));
  await deepLink('#you-approvals');
  await settings.getByText('Only people who can edit Accounts can change these.', { exact: true }).waitFor();
  assert.equal(await settings.getByLabel('Settings for').inputValue(), department.id);
  await row().waitFor();
  assert.ok((await settings.getByRole('radio').evaluateAll(items => items.every(item => item.disabled))), 'Every choice is read-only');
  assert.ok(await save.isDisabled(), 'Save changes is disabled');
  assert.equal(await settings.getByRole('button', { name: 'Reset to recommended', exact: true }).count(), 0, 'No reset for a read-only member');
  await settings.getByText('Set by Accounts', { exact: true }).waitFor();
  await settings.getByText(/^Fictional Kim · portal\.fictional\.test: Recommended → Ask every time · /).waitFor();
  await shot('06-read-only-member-1440.png');
  pass('Read-only member: "Settings for: Accounts", the editors line, every choice disabled, no Save or Reset, rows say "Set by Accounts"');
  await page.unroute(url => url.pathname === '/api/approvals');
  await page.unroute(url => url.pathname === '/api/approvals/history');

  assert.deepEqual(errors, [], 'No renderer page errors');
  pass('Zero renderer page errors');
  rmSync(join(output, 'failure.png'), { force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ checkedAt: new Date().toISOString(), layer: 'local-built-ui-with-real-api', realServer: true, checks, screenshots, pageErrors: errors,
    limits: [
      'Built React UI and an isolated local service (single desktop) with fictional records and an offline worker; no packaged build, installed device, live integration or customer proof.',
      'The read-only member case stubs GET /api/approvals and its history in the browser with an office reply; the store\'s department editor checks are proven by unit tests, not by a real office host.',
      'No connected app or office connector exists here, so the managed, direct and connector rows and the owner\'s "This only reads" links are covered by component tests, not this run.',
      'Card buttons (read offer, answered-by line) and the side panel\'s "Bud is waiting on you" rows need a live approval card and are covered by component tests only.',
    ] }, null, 2) + '\n');
  console.log(`PASS approvals QA: ${checks.length} checks, ${screenshots.length} screenshots, 0 page errors. Evidence: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
  console.error(logs.slice(-3000));
  throw error;
} finally {
  await browser?.close();
  if (child) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(temp, { recursive: true, force: true });
}
