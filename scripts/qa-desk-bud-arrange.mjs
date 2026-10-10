import { readSessionToken, primeBrowserSession } from './local-session.mjs';
// Bud arranges Desk (docs/DESK-WORK-AREAS-2026-10-10.md, slice 1): a real Ask turn on the fake
// ACP worker calls desk_arrange over its loopback tool server; the open Desk follows without a
// focus event or reload, the receipt's Undo restores the earlier layout, and an Undo after a
// person changed Desk changes nothing. Built React UI from REALBUD_UI_DIR against a disposable
// local service; fictional sample book; no model, account or network.
// Node 24, PLAYWRIGHT_MODULE, REALBUD_UI_DIR (scratch `vite build --outDir`), optional CHROME_EXECUTABLE and QA_OUTPUT.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module.');
assert.ok(process.env.REALBUD_UI_DIR, 'Set REALBUD_UI_DIR to a scratch `vite build --outDir` folder; dist/ is shared.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/desk-bud-arrange-2026-10-10'));
assert.ok(!existsSync(output), 'Choose a fresh QA_OUTPUT; existing evidence is preserved.');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-desk-bud-'));
const data = join(temp, 'data'); mkdirSync(data, { mode: 0o700 });
// The fake worker writes inside the same boundary as the real one; the dump holds a bearer, so it stays in temp.
const dump = join(data, 'vault', 'bud-work', 'fake-acp-dump.json');
const checks = [], errors = [];
let child, browser, page, failure, logs = '';
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const until = async (check, message) => { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await wait(50); } assert.fail(message); };

try {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolveClose => listener.close(resolveClose));
  const origin = `http://127.0.0.1:${port}`;
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { hermes: { driver: 'hermesAgent', config: { cli: join(root, 'server/testing/fake-acp-cli.ts') },
    environment: { FAKE_ACP_MODE: 'hang', FAKE_ACP_DUMP: dump } } } }), { mode: 0o600 });
  child = spawn(process.execPath, [join(root, 'server/index.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, OMB_PORT: String(port), OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR), ELECTRON_RUN_AS_NODE: '1', VITEST: 'true' } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) { try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {} await wait(200); }
  assert.ok(ready, logs.slice(-1500));
  const token = await readSessionToken(data);
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, { method, headers: { 'x-realbud-session': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const views = async () => (await call('/api/workspace-tabs')).body.state;

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, origin, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Desk Reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  const deskRow = page.locator('.pm-desk-header').getByRole('navigation', { name: 'Desk workspace', exact: true });
  const rowTabs = async () => (await deskRow.locator('.desk-workspace-tabs > button').allTextContents()).map(text => text.replace(/\d+$/, '').trim());
  const showsTabs = expected => until(async () => JSON.stringify(await rowTabs()) === JSON.stringify(expected), `Desk tabs read ${expected.join(', ')}`);
  const standard = ['Tasks', 'Mail priorities', 'Bills and calendar', 'Shared work', 'Hermios'];
  await showsTabs(standard);
  // A reload would drop this marker; focus events are never sent by this script.
  await page.evaluate(() => { window.qaSameDocument = true; });
  const original = await views();
  const updates = page.getByRole('status', { name: 'Updates', exact: true });
  // Notices sit above the status bar (desktop) or the phone navigation, never over them.
  const clearOf = async selector => (await updates.boundingBox()).y + (await updates.boundingBox()).height <= (await page.locator(selector).boundingBox()).y;

  // A real Ask turn: the fake worker holds it open, so Bud's Desk tools stay mounted for this turn.
  assert.equal((await call('/api/bots/bud/messages', 'POST', { text: 'Put shared work first and hide bills on my Desk' })).status, 202);
  const server = await until(() => { try { return JSON.parse(readFileSync(dump, 'utf8')).mcpServers?.find(row => row.name === 'workspace-views'); } catch { return null; } }, 'The Ask turn mounts Bud\'s Desk tools');
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  let rpc = 0;
  const tool = async (name, args) => {
    const response = await fetch(server.url, { method: 'POST', headers: Object.fromEntries(server.headers.map(row => [row.name, row.value])), body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
    return (await response.json()).result;
  };
  const listed = (await tool('views_list', {})).structuredContent;
  assert.equal(listed.revision, original.revision);
  assert.deepEqual(listed.locked, ['queue']);
  assert.deepEqual(listed.desk.map(row => row.id), original.desk.sections.map(section => section.id));
  const bud = ['shared-work', ...listed.desk.map(row => row.id).filter(id => id !== 'shared-work')].map(id => ({ id, visible: id === 'bills' ? false : listed.desk.find(row => row.id === id).visible }));
  const arranged = await tool('desk_arrange', { revision: listed.revision, sections: bud });
  assert.equal(arranged.isError, undefined, JSON.stringify(arranged));
  assert.match(arranged.content[0].text, new RegExp(`^Arranged Desk: hid Bills and calendar; changed the order\\. .*previous revision ${original.revision}, now ${original.revision + 1}\\)\\.$`));
  assert.deepEqual(arranged.structuredContent, { revision: original.revision + 1, previousRevision: original.revision });
  assert.deepEqual((await views()).desk.sections, bud);
  pass('A real Ask turn reads the Desk revision with views_list and desk_arrange saves at once with no card, telling Bud what changed and the previous revision');

  await showsTabs(['Tasks', 'Shared work', 'Mail priorities', 'Hermios']);
  await updates.getByText('Bud arranged Desk: hid Bills and calendar; changed the order.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.qaSameDocument), true, 'No reload');
  assert.ok(await clearOf('.rb-status-bar'), 'The notice leaves the status bar visible');
  await page.screenshot({ path: join(output, '01-bud-arranged.png'), animations: 'disabled' });
  pass('The open Desk follows Bud\'s change without focus or reload, and a polite notice above the status bar says what Bud changed with Undo');

  const stale = await tool('desk_arrange', { revision: original.revision, sections: original.desk.sections });
  assert.equal(stale.content[0].text, 'Desk changed since you read it. Nothing was changed. Call views_list again, then retry desk_arrange with the new revision.');
  assert.equal((await views()).revision, original.revision + 1, 'A stale Bud write changes nothing');
  await updates.getByRole('button', { name: 'Undo', exact: true }).click();
  await updates.getByText('Desk is back as it was before Bud arranged it.', { exact: true }).waitFor();
  const undone = await views();
  assert.equal(undone.revision, original.revision + 2);
  assert.deepEqual(undone.desk.sections, original.desk.sections);
  await showsTabs(standard);
  assert.equal(await updates.getByRole('button', { name: 'Undo', exact: true }).count(), 0, 'The receipt leaves after Undo');
  pass('A stale Bud write is refused without overwriting, and Undo restores the layout before Bud\'s change as a new revision');

  // Bud arranges again; a person then changes Desk in another window, so Undo must not overwrite them.
  const again = (await tool('views_list', {})).structuredContent;
  assert.equal((await tool('desk_arrange', { revision: again.revision, sections: again.desk.map(row => ({ id: row.id, visible: row.id === 'mail' ? false : row.visible })) })).isError, undefined);
  await updates.getByText('Bud arranged Desk: hid Mail priorities.', { exact: true }).waitFor();
  const budState = await views();
  const person = budState.desk.sections.map(section => section.id === 'shared-work' ? { ...section, visible: false } : section);
  assert.equal((await call('/api/workspace-tabs', 'PUT', { version: 2, expectedRevision: budState.revision, tabs: budState.tabs, desk: { sections: person } })).status, 200);
  await showsTabs(['Tasks', 'Bills and calendar', 'Hermios']);
  await updates.getByRole('button', { name: 'Undo', exact: true }).click();
  await updates.getByText("Desk was changed after Bud's change, so nothing was undone.", { exact: true }).waitFor();
  const kept = await views();
  assert.equal(kept.revision, budState.revision + 1);
  assert.deepEqual(kept.desk.sections, person);
  await showsTabs(['Tasks', 'Bills and calendar', 'Hermios']);
  // Recovery in place: the same notice opens Arrange Desk on the person's current layout.
  await updates.getByRole('button', { name: 'Open Arrange Desk', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Arrange Desk', exact: true });
  await sheet.waitFor();
  assert.equal(await sheet.getByRole('checkbox', { name: 'Show Shared work on my Desk', exact: true }).isChecked(), false);
  assert.equal(await updates.getByRole('button', { name: 'Open Arrange Desk', exact: true }).count(), 0, 'The notice leaves once used');
  assert.equal(await updates.getByText('Desk is back as it was before Bud arranged it.', { exact: true }).count(), 0, 'An earlier Undo notice never reads as current');
  await page.screenshot({ path: join(output, '02-undo-refused-arrange.png'), animations: 'disabled' });
  await sheet.getByRole('button', { name: 'Close Arrange Desk', exact: true }).click();
  pass('After a person changes Desk, Undo of Bud\'s earlier change is refused, says Desk was changed after Bud\'s change, and its Open Arrange Desk button opens the sheet on the current layout');

  // 390px: the tab row stays one line and scrolls in its own strip; the page never scrolls sideways.
  const restored = await views();
  assert.equal((await call('/api/workspace-tabs', 'PUT', { version: 2, expectedRevision: restored.revision, tabs: restored.tabs, desk: original.desk })).status, 200);
  await showsTabs(standard);
  await page.setViewportSize({ width: 390, height: 844 });
  await deskRow.waitFor();
  const row = await deskRow.evaluate(element => {
    const centers = [...element.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0).map(button => { const box = button.getBoundingClientRect(); return box.top + box.height / 2; });
    return { buttons: centers.length, spread: Math.max(...centers) - Math.min(...centers), overflow: getComputedStyle(element).overflowX, scrolls: element.scrollWidth > element.clientWidth };
  });
  assert.ok(row.buttons >= 6 && row.spread < 4 && row.overflow === 'auto' && row.scrolls, `One scrolling tab line at 390px (${JSON.stringify(row)})`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page scroll at 390px');
  assert.ok(await clearOf('aside.rb-sidebar'), 'Notices leave the phone navigation visible');
  await deskRow.getByRole('button', { name: 'Shared work', exact: true }).click();
  await page.locator('[data-other-work="shared-work"]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page scroll with a work area open');
  await page.screenshot({ path: join(output, '03-desk-390.png'), animations: 'disabled' });
  pass('At 390px the Desk tabs stay on one line that scrolls in its own strip, a far tab opens its area, notices stay above the navigation, and the page has no horizontal scroll');
  assert.deepEqual(errors, []);
  pass('No renderer page errors');
} catch (cause) {
  failure = cause instanceof Error ? cause.stack : String(cause);
  await page?.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
  console.error(failure);
} finally {
  await browser?.close().catch(() => {});
  if (child?.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure,
    layer: 'Built React UI (scratch build) in headless Chrome against a real disposable local service; a real Ask turn on the fake ACP worker; fictional sample book', checks, errors, failure: failure ?? null,
    ...(failure ? { diagnostic: logs.slice(-3000) } : {}),
    limits: ['The fake worker is held open and the script calls Bud\'s Desk tools over the turn\'s loopback server in its place; no model chose the change.', 'Fictional sample book only; no customer records or accounts.', 'Not a packaged app or installed-device check.'] }, null, 2) + '\n');
  if (failure) process.exitCode = 1;
}
