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
const SITE_HINT = 'Recommended: approved workflows read this site; Bud asks before reading anywhere else here.';
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
  // Keep a handle on the renderer's live event stream so step 9 can deliver the server's own card frames.
  await context.addInitScript(() => {
    const Native = window.EventSource;
    window.__qaStreams = [];
    window.EventSource = class extends Native { constructor(...args) { super(...args); window.__qaStreams.push(this); } };
  });
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
  const choices = () => row().getByRole('radio').evaluateAll(items => items.map(item => item.closest('label').textContent));
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
  assert.ok(await radio('Recommended').isChecked(), 'A website starts on Recommended (nothing saved)');
  assert.deepEqual(await choices(), ['Recommended', 'Read without asking', "Don't use"], 'A website offers Recommended, Read without asking or Don\'t use');
  await settings.getByText(SITE_HINT, { exact: true }).waitFor();
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
  pass('A website row starts on Recommended with the hint and three choices; change it to Don\'t use, save, reload (via #you-rules): persisted on the server, row says "Saved on this computer", Changes lists who and when');

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
  await option('Recommended').click();
  await save.click();
  await statusLine.filter({ hasText: 'Someone changed these settings. Review the latest and save again.' }).waitFor();
  assert.ok(await radio('Recommended').isChecked(), 'The person\'s own edit is kept');
  await settings.getByText('Not saved yet', { exact: true }).waitFor();
  await save.click();
  await statusLine.filter({ hasText: 'Saved.' }).waitFor();
  assert.deepEqual((await approvals()).settings.groups, { 'class:pay': 'deny' }, 'Saving again keeps the other change and applies this one');
  await shot('03-stale-save-resolved-1440.png');
  pass('Stale save: "Someone changed these settings. Review the latest and save again." keeps the edit; saving again merges with the other person\'s change');

  // 4b. A saved Ask every time (Bud can propose it as stricter) shows as a fourth, selected choice only while saved.
  const current = await approvals();
  assert.equal((await call('/api/approvals', 'PUT', { expectedRevision: current.revision, settings: { ...current.settings, groups: { ...current.settings.groups, [GROUP]: 'ask' } } })).status, 200);
  await deepLink('#you-approvals');
  await row().waitFor();
  assert.deepEqual(await choices(), ['Recommended', 'Read without asking', "Don't use", 'Ask every time']);
  assert.ok(await radio('Ask every time').isChecked(), 'The saved Ask every time is selected');
  await noOverflow(); await shot('03b-saved-ask-every-time-1440.png');
  await option('Recommended').click();
  assert.equal(await radio('Ask every time').count(), 1, 'Still offered while it is the saved value');
  await save.click();
  await statusLine.filter({ hasText: 'Saved.' }).waitFor();
  assert.deepEqual((await approvals()).settings.groups, { 'class:pay': 'deny' });
  await until(async () => (await choices()).length === 3, 'Ask every time leaves the row once Recommended is saved');
  pass('A saved Ask every time shows as a fourth, selected choice; back to Recommended and saved, the choice is gone');

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
  assert.ok(await radio('Ask every time').isChecked(), 'The department\'s saved Ask every time shows as the selected fourth choice');
  assert.ok(await save.isDisabled(), 'Save changes is disabled');
  assert.equal(await settings.getByRole('button', { name: 'Reset to recommended', exact: true }).count(), 0, 'No reset for a read-only member');
  await settings.getByText('Set by Accounts', { exact: true }).waitFor();
  await settings.getByText(/^Fictional Kim · portal\.fictional\.test: Recommended → Ask every time · /).waitFor();
  await shot('06-read-only-member-1440.png');
  pass('Read-only member: "Settings for: Accounts", the editors line, every choice disabled, no Save or Reset, rows say "Set by Accounts"');
  await page.unroute(url => url.pathname === '/api/approvals');
  await page.unroute(url => url.pathname === '/api/approvals/history');

  // 9. One live approval card with a read offer and its exact request, as the server sends it (request.opened → message).
  const { bots } = (await call('/api/bots')).body;
  const bud = bots.find(bot => bot.id === 'bud' || bot.name === 'Bud');
  assert.ok(bud?.threadId, 'Bud has a conversation');
  const exact = JSON.stringify({ name: 'GMAIL_FETCH_EMAILS', arguments: { query: 'from:fictional-tenant@example.test', max_results: 5 } }, null, 2);
  const card = { id: 'fictional-card-1', role: 'bot', kind: 'options', at: Date.now(), card: { title: 'Approval needed', options: ['Allow', 'Deny'],
    subtitle: 'Bud wants to use Gmail.\nAccount: the account connected in Connected apps\nAction: Fetch emails (GMAIL_FETCH_EMAILS)\n  Query: from:fictional-tenant@example.test\n  Max results: 5\nThis approval applies once to this request only. The exact request is under Exact request.',
    requestId: 'fictional-request-1', tool: 'bud_connected_app_action', deadline: new Date(Date.now() + 285_000).toISOString(), remote: 'read', detail: exact,
    readOffer: { appLabel: 'Gmail', always: true, group: 'app:gmail' } } };
  const deliver = frame => page.evaluate(value => {
    const stream = [...window.__qaStreams].reverse().find(item => item.readyState === 1);
    if (!stream) throw new Error('No open event stream');
    stream.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }, frame);
  const answers = [];
  await page.route(url => /^\/api\/threads\/[\w-]+\/respond$/.test(url.pathname), async route => {
    answers.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`${origin}/#/desk`); await page.reload();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  const panel = page.getByRole('complementary', { name: 'Side panel' }).getByRole('region', { name: 'Approvals waiting' });
  await panel.waitFor();
  await until(() => page.evaluate(() => (window.__qaStreams ?? []).some(item => item.readyState === 1)), 'The live event stream opens');
  await deliver({ kind: 'message', threadId: bud.threadId, message: card });
  await panel.getByText('Bud is waiting on you: 1', { exact: true }).waitFor();
  const waitingRow = panel.getByRole('button', { name: /^Open the conversation: Gmail · Fetch emails · \d+ min left$/ });
  await waitingRow.waitFor();
  await noOverflow(); await shot('07-bud-waiting-panel-1440.png');
  pass('Right panel shows "Bud is waiting on you: 1" with "Gmail · Fetch emails · N min left" while the card is open');
  await waitingRow.click();
  const composerCard = page.getByText('Pending approval', { exact: true }).locator('xpath=ancestor::div[contains(@class, "rounded-2xl")][1]');
  await composerCard.waitFor();
  await composerCard.getByText('Action: Fetch emails (GMAIL_FETCH_EMAILS)', { exact: false }).waitFor();
  const offered = await composerCard.getByRole('button').evaluateAll(items => items.map(item => item.textContent));
  assert.deepEqual(offered, ['Allow once', 'Allow for this task', 'Always allow reading Gmail', 'Deny', 'Stop this turn'], 'The read offer buttons, named from appLabel');
  const disclosure = composerCard.locator('details').filter({ has: page.locator('summary', { hasText: /^Exact request$/ }) });
  assert.equal(await disclosure.evaluate(element => element.open), false, 'The exact request starts collapsed');
  await disclosure.locator('summary').click();
  const exactRegion = composerCard.getByRole('region', { name: 'Exact request', exact: true });
  await exactRegion.waitFor();
  assert.ok((await exactRegion.textContent()).includes('"name": "GMAIL_FETCH_EMAILS"'), 'The exact request shows the tool call');
  await noOverflow(); await shot('08-live-card-exact-request-1440.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await composerCard.getByRole('button', { name: 'Allow for this task', exact: true }).scrollIntoViewIfNeeded();
  await noOverflow(); await shot('09-live-card-390.png');
  await page.setViewportSize({ width: 1440, height: 940 });
  pass('Live card: plain lines first, buttons Allow once · Allow for this task · Always allow reading Gmail · Deny · Stop this turn, Exact request opens from collapsed, no horizontal scroll at 1440 or 390');
  await composerCard.getByRole('button', { name: 'Allow for this task', exact: true }).click();
  await until(() => answers.length === 1, 'Allow for this task answers the card');
  assert.deepEqual(answers[0], { path: `/api/threads/${bud.threadId}/respond`, body: { requestId: 'fictional-request-1', behavior: 'allow', scope: 'task' } });
  // The server settles the card (request.resolved → message.patch).
  await deliver({ kind: 'message.patch', threadId: bud.threadId, message: { ...card, card: { ...card.card, answered: 'allow', dismissed: false, resolution: 'user' } } });
  await page.getByText('Pending approval', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByText('Approved', { exact: true }).last().waitFor();
  await shot('10-live-card-resolved-1440.png');
  await page.goto(`${origin}/#/desk`);
  await panel.getByText('Nothing is waiting for your approval.', { exact: true }).waitFor();
  assert.equal(await panel.getByText(/^Bud is waiting on you/).count(), 0);
  pass('Allow for this task sends scope "task" to /api/threads/:id/respond; once the server settles it the composer card closes, the conversation shows Approved and the panel count clears');
  await page.unroute(url => /^\/api\/threads\/[\w-]+\/respond$/.test(url.pathname));

  assert.deepEqual(errors, [], 'No renderer page errors');
  pass('Zero renderer page errors');
  rmSync(join(output, 'failure.png'), { force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ checkedAt: new Date().toISOString(), layer: 'local-built-ui-with-real-api', realServer: true, checks, screenshots, pageErrors: errors,
    limits: [
      'Built React UI and an isolated local service (single desktop) with fictional records and an offline worker; no packaged build, installed device, live integration or customer proof.',
      'The read-only member case stubs GET /api/approvals and its history in the browser with an office reply; the store\'s department editor checks are proven by unit tests, not by a real office host.',
      'No connected app or office connector exists here, so the managed, direct and connector rows and the owner\'s "This only reads" links are covered by component tests, not this run.',
      'The live approval card (step 9) is delivered as the server\'s own event frames (message, then message.patch) into the renderer\'s open event stream, and the respond POST is captured in the browser: no provider holds a live request in this run. The server side of respond (live-card check, scope task/always-reads, read grants) is covered by index.test.ts and request-decision tests.',
      'The answered-by line ("Allowed once by … via Telegram · time") is covered by component tests; no phone channel exists in this run.',
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
