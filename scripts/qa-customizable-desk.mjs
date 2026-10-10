// Built renderer (dist/) + real isolated source service, fictional sample only. No worker.
// Node 24+, PLAYWRIGHT_MODULE, optional CHROME_EXECUTABLE, QA_OUTPUT and REALBUD_UI_DIR (a scratch
// `vite build --outDir`; default dist/). Run `vite build` first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessionToken, primeBrowserSession } from './local-session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { serviceSmokeEnv } = await import(join(root, 'scripts/service-smoke-env.mjs'));
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/customizable-desk-2026-09-30'));
assert.ok(!existsSync(output), 'Choose a fresh QA_OUTPUT; existing evidence is preserved.');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-desk-layout-'));
const data = join(scratch, 'data'); mkdirSync(data, { mode: 0o700 });
const checks = [], errors = [];
let child, browser, page, failure, logs = '', base, token;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const call = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { 'x-realbud-session': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
};
try {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root, env: {
    ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port }),
    REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR || join(root, 'dist')),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null);
    ready = health?.pid === child.pid; if (!ready) await wait(100);
  }
  assert.ok(ready, 'service starts');
  token = await readSessionToken(data);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, base, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/');
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Layout Person');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  pass('Fictional sample Desk opens');

  // Default: today's order.
  assert.equal((await call('/api/workspace-tabs')).body.state.version, 2);
  const header = page.locator('.pm-desk-header');
  const openArrange = async () => {
    const more = header.locator('details.desk-more').filter({ has: page.getByRole('group', { name: 'More Desk tools', exact: true, includeHidden: true }) });
    if (!await more.evaluate(element => element.open)) await more.locator(':scope > summary').click();
    await more.getByRole('group', { name: 'More Desk tools', exact: true }).getByRole('button', { name: 'Arrange Desk', exact: true }).click();
  };
  await openArrange();
  const panel = page.getByRole('dialog', { name: 'Arrange Desk', exact: true });
  await panel.waitFor();
  assert.equal(await panel.getByRole('checkbox', { name: 'Needs you always shows', exact: true }).isDisabled(), true);
  await panel.getByText(/Saved on this computer/).waitFor();
  await panel.getByRole('heading', { name: 'On this computer', exact: true }).waitFor();
  await panel.getByRole('combobox', { name: 'Spacing', exact: true }).waitFor();
  pass('Arrange Desk opens from More with Needs you fixed, a "Saved on this computer" line and this computer\'s layout options');
  // Keyboard reorder: move Needs you to the top with the keyboard, hide mail/bills/shared work.
  for (let i = 0; i < 5; i++) { const up = panel.getByRole('button', { name: 'Move Needs you up', exact: true }); await up.focus(); await page.keyboard.press('Enter'); }
  for (const label of ['Mail priorities', 'Bills and calendar', 'Shared work']) await panel.getByRole('checkbox', { name: `Show ${label} on my Desk`, exact: true }).uncheck();
  await panel.screenshot({ animations: 'disabled', path: join(output, 'arrange-desk-draft.png') });
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByText('Desk arrangement saved.', { exact: true }).waitFor();
  const saved = (await call('/api/workspace-tabs')).body.state;
  assert.deepEqual(saved.desk.sections.map(s => s.id), ['queue', 'brief', 'mail', 'bills', 'shared-work', 'go-live', 'activity']);
  assert.deepEqual(saved.desk.sections.filter(s => !s.visible).map(s => s.id), ['mail', 'bills', 'shared-work']);
  assert.equal(saved.history.length, 2);
  pass('Save persists the reordered layout with history (earlier layout kept)');
  await panel.screenshot({ animations: 'disabled', path: join(output, 'arrange-desk-saved.png') });

  // Stale save: another window changes the layout, this panel keeps its draft. No focus
  // event or reload: the service announces the write to every open window.
  await panel.getByRole('checkbox', { name: 'Show Activity on my Desk', exact: true }).uncheck();
  const other = saved.desk.sections.map(s => s.id === 'go-live' ? { ...s, visible: false } : s);
  assert.equal((await call('/api/workspace-tabs', 'PUT', { version: 2, expectedRevision: saved.revision, tabs: saved.tabs, desk: { sections: other } })).status, 200);
  await panel.getByText(/This card changed — open it again/).waitFor();
  assert.equal(await panel.getByRole('checkbox', { name: 'Show Activity on my Desk', exact: true }).isChecked(), false, 'draft kept');
  assert.equal(await panel.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  await panel.screenshot({ animations: 'disabled', path: join(output, 'arrange-desk-stale.png') });
  pass('A layout changed in another window reaches this one without focus or reload, keeps the draft and shows the reopen message');
  await panel.getByRole('button', { name: 'Open again', exact: true }).click();
  await panel.getByRole('button', { name: 'Close Arrange Desk', exact: true }).click();
  await wait(200);
  const nav = header.getByRole('navigation', { name: 'Desk workspace', exact: true });
  assert.equal(await nav.getByRole('button', { name: /^Tasks(?:\s*\d+)?$/ }).getAttribute('aria-pressed'), 'true');
  await page.locator('.desk-content .desk-work-tasks').waitFor();
  await page.locator('.desk-queue-column').getByRole('combobox', { name: 'Status', exact: true }).waitFor();
  const deskTabs = async () => (await nav.locator('.desk-workspace-tabs > button').allTextContents()).map(text => text.replace(/\d+$/, '').trim());
  for (const label of ['Mail priorities', 'Bills and calendar', 'Shared work']) {
    assert.equal(await nav.getByRole('button', { name: label, exact: true }).count(), 0);
  }
  assert.deepEqual(await deskTabs(), ['Tasks', 'Hermios']);
  await page.screenshot({ animations: 'disabled', path: join(output, 'desk-customized.png') });
  pass('Saved visibility removes mail/bills/shared work from the Desk tabs while Tasks and its queue remain available');

  // Revert to the layout before customizing.
  const current = (await call('/api/workspace-tabs')).body.state;
  const before = current.history.find(entry => entry.savedAt === null);
  assert.equal((await call('/api/workspace-tabs/revert', 'POST', { expectedRevision: current.revision - 1, toRevision: before.revision })).status, 409);
  // The sheet's Change history restores it with one click, as a new revision.
  await openArrange();
  await panel.getByRole('heading', { name: 'Change history', exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Restore layout from Before customizing', exact: true }).click();
  await panel.getByText('Earlier layout restored.', { exact: true }).waitFor();
  const restored = (await call('/api/workspace-tabs')).body.state;
  assert.equal(restored.revision, current.revision + 1);
  assert.deepEqual(restored.desk.sections, before.sections);
  await panel.getByRole('button', { name: 'Close Arrange Desk', exact: true }).click();
  pass('Revert is revision-checked on the API; Change history → Restore puts the earlier layout back as a new revision');
  await nav.getByRole('button', { name: 'Shared work', exact: true }).waitFor();
  const labels = { mail: 'Mail priorities', bills: 'Bills and calendar', 'shared-work': 'Shared work' };
  assert.deepEqual(await deskTabs(), ['Tasks', ...before.sections.filter(section => section.visible && labels[section.id]).map(section => labels[section.id]), 'Hermios']);
  await nav.getByRole('button', { name: 'Mail priorities', exact: true }).click();
  const mail = page.locator('.desk-other-work-surface[data-other-work="mail"]');
  await mail.waitFor();
  assert.equal(await nav.getByRole('button', { name: 'Mail priorities', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.desk-work-tasks').isVisible(), false, 'A work-area tab replaces Tasks');
  await nav.getByRole('button', { name: /^Tasks\s*\d*$/ }).click();
  await page.locator('.desk-work-tasks').waitFor();
  await mail.waitFor({ state: 'hidden' });
  pass('Restored work-area tabs follow the saved order and replace the work area until the Tasks tab');

  // Narrow window: no horizontal scroll with the panel open.
  await page.setViewportSize({ width: 390, height: 844 });
  // The Desk tab row stays one line and scrolls inside its own strip.
  const row = await nav.evaluate(element => {
    const centers = [...element.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0).map(button => { const box = button.getBoundingClientRect(); return box.top + box.height / 2; });
    return { spread: Math.max(...centers) - Math.min(...centers), overflow: getComputedStyle(element).overflowX, scrolls: element.scrollWidth > element.clientWidth };
  });
  assert.ok(row.spread < 4 && row.overflow === 'auto', `one-line tab row at 390px (${JSON.stringify(row)})`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll on Desk at 390px');
  await page.screenshot({ animations: 'disabled', path: join(output, 'desk-390.png') });
  await openArrange();
  await panel.waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll at 390px');
  await page.screenshot({ animations: 'disabled', path: join(output, 'arrange-desk-390.png') });
  pass('390x844 keeps the Desk tab row on one scrolling line and shows the sheet without horizontal page scroll');
  assert.deepEqual(errors, []);
  pass('Zero renderer page errors');
} catch (error) {
  failure = error.stack || String(error);
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close').catch(() => {}); }
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Built React UI in headless Chrome; real isolated source service; fictional sample book; no worker, no customer accounts', limits: ['Fictional sample book only; not customer acceptance', 'Built renderer served by the source service, not a packaged or installed app', "Bud's own arrangement and its Undo are checked by scripts/qa-desk-bud-arrange.mjs; department layouts are not built yet", 'Mail, bills and shared-work panels may render empty on the sample book'], checks, errors, failure, ...(failure ? { diagnostic: logs.slice(-3000) } : {}) }, null, 2));
  rmSync(scratch, { recursive: true, force: true });
  if (failure) { console.error(failure); process.exitCode = 1; }
}
