// Built renderer (dist/) + real isolated source service, fictional sample only. No worker.
// Node 24+, PLAYWRIGHT_MODULE, optional CHROME_EXECUTABLE and QA_OUTPUT. Run `vite build` first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: join(root, 'dist'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null);
    ready = health?.pid === child.pid; if (!ready) await wait(100);
  }
  assert.ok(ready, 'service starts');
  token = (await (await fetch(base + '/api/session')).json()).token;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, reducedMotion: 'reduce' });
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
  const openCustomize = async () => {
    const more = header.locator('details.desk-more').filter({ has: page.getByRole('group', { name: 'More Desk tools', exact: true, includeHidden: true }) });
    if (!await more.evaluate(element => element.open)) await more.locator(':scope > summary').click();
    const options = more.locator('details.desk-options');
    if (!await options.evaluate(element => element.open)) await options.locator(':scope > summary').click();
    await options.getByRole('button', { name: 'Customize desk', exact: true }).click();
  };
  await openCustomize();
  const panel = page.getByRole('region', { name: 'Customize desk', exact: true });
  await panel.waitFor();
  assert.equal(await panel.getByRole('checkbox', { name: 'Needs you always shows', exact: true }).isDisabled(), true);
  pass('Customize desk opens from More → Desk options with Needs you fixed');
  // Keyboard reorder: move Needs you to the top with the keyboard, hide mail/bills/shared work.
  for (let i = 0; i < 5; i++) { const up = panel.getByRole('button', { name: 'Move Needs you up', exact: true }); await up.focus(); await page.keyboard.press('Enter'); }
  for (const label of ['Mail priorities', 'Bills and calendar', 'Shared work']) await panel.getByRole('checkbox', { name: `Show ${label}`, exact: true }).uncheck();
  await panel.screenshot({ animations: 'disabled', path: join(output, 'customize-panel-draft.png') });
  await panel.getByRole('button', { name: 'Save layout', exact: true }).click();
  await panel.getByText('Desk layout saved.', { exact: true }).waitFor();
  const saved = (await call('/api/workspace-tabs')).body.state;
  assert.deepEqual(saved.desk.sections.map(s => s.id), ['queue', 'brief', 'mail', 'bills', 'shared-work', 'go-live', 'activity']);
  assert.deepEqual(saved.desk.sections.filter(s => !s.visible).map(s => s.id), ['mail', 'bills', 'shared-work']);
  assert.equal(saved.history.length, 2);
  pass('Save persists the reordered layout with history (earlier layout kept)');
  await panel.screenshot({ animations: 'disabled', path: join(output, 'customize-panel-saved.png') });

  // Stale save: another window changes the layout, this panel keeps its draft.
  await panel.getByRole('checkbox', { name: 'Show Activity', exact: true }).uncheck();
  const other = saved.desk.sections.map(s => s.id === 'go-live' ? { ...s, visible: false } : s);
  assert.equal((await call('/api/workspace-tabs', 'PUT', { version: 2, expectedRevision: saved.revision, tabs: saved.tabs, desk: { sections: other } })).status, 200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await panel.getByText(/This card changed — open it again/).waitFor();
  assert.equal(await panel.getByRole('checkbox', { name: 'Show Activity', exact: true }).isChecked(), false, 'draft kept');
  assert.equal(await panel.getByRole('button', { name: 'Save layout', exact: true }).isDisabled(), true);
  await panel.screenshot({ animations: 'disabled', path: join(output, 'customize-panel-stale.png') });
  pass('A layout changed in another window keeps the draft and shows the reopen message');
  await panel.getByRole('button', { name: 'Open again', exact: true }).click();
  await panel.getByRole('button', { name: 'Close Customize desk', exact: true }).click();
  await wait(200);
  const nav = header.getByRole('navigation', { name: 'Desk workspace', exact: true });
  assert.equal(await nav.getByRole('button', { name: /^Tasks(?:\s*\d+)?$/ }).getAttribute('aria-pressed'), 'true');
  await page.locator('.desk-content .desk-work-tasks').waitFor();
  await page.locator('.desk-queue-column').getByRole('combobox', { name: 'Status', exact: true }).waitFor();
  await header.locator('.desk-other-work > summary').click();
  const otherWork = header.getByRole('group', { name: 'Other work', exact: true });
  for (const label of ['Mail priorities', 'Bills and calendar', 'Shared work']) {
    assert.equal(await otherWork.getByRole('button', { name: label, exact: true }).count(), 0);
  }
  await otherWork.getByText('Turn these on in More → Desk options → Customize desk.', { exact: true }).waitFor();
  await page.screenshot({ animations: 'disabled', path: join(output, 'desk-customized.png') });
  await header.locator('.desk-other-work > summary').click();
  pass('Saved visibility removes mail/bills/shared work from Other work while Tasks and its queue remain available');

  // Revert to the layout before customizing.
  const current = (await call('/api/workspace-tabs')).body.state;
  const before = current.history.find(entry => entry.savedAt === null);
  assert.equal((await call('/api/workspace-tabs/revert', 'POST', { expectedRevision: current.revision - 1, toRevision: before.revision })).status, 409);
  assert.equal((await call('/api/workspace-tabs/revert', 'POST', { expectedRevision: current.revision, toRevision: before.revision })).status, 200);
  pass('Revert is revision-checked and restores the earlier layout as a new revision');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await header.locator('.desk-other-work > summary').click();
  await otherWork.getByRole('button', { name: 'Shared work', exact: true }).waitFor();
  const labels = { mail: 'Mail priorities', bills: 'Bills and calendar', 'shared-work': 'Shared work' };
  assert.deepEqual(await otherWork.getByRole('button').allTextContents(), before.sections.filter(section => section.visible && labels[section.id]).map(section => labels[section.id]));
  await otherWork.getByRole('button', { name: 'Mail priorities', exact: true }).click();
  const mail = page.locator('.desk-other-work-surface[data-other-work="mail"]');
  await mail.waitFor();
  assert.equal(await page.locator('.desk-work-tasks').isVisible(), false, 'Other work replaces Tasks');
  await mail.getByRole('button', { name: 'Back to tasks', exact: true }).click();
  await page.locator('.desk-work-tasks').waitFor();
  await mail.waitFor({ state: 'hidden' });
  pass('Restored Other work entries follow the saved order and replace the work area until Back to tasks');

  // Narrow window: no horizontal scroll with the panel open.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await openCustomize();
  await panel.waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll at 390px');
  await page.screenshot({ animations: 'disabled', path: join(output, 'customize-panel-390.png') });
  pass('390x844 shows the panel without horizontal scroll');
  assert.deepEqual(errors, []);
  pass('Zero renderer page errors');
} catch (error) {
  failure = error.stack || String(error);
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close').catch(() => {}); }
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Built React UI in headless Chrome; real isolated source service; fictional sample book; no worker, no customer accounts', limits: ['Fictional sample book only; not customer acceptance', 'Built renderer served by the source service, not a packaged or installed app', 'Bud-proposed layouts and department layouts are not built yet', 'Mail, bills and shared-work panels may render empty on the sample book'], checks, errors, failure, ...(failure ? { diagnostic: logs.slice(-3000) } : {}) }, null, 2));
  rmSync(scratch, { recursive: true, force: true });
  if (failure) { console.error(failure); process.exitCode = 1; }
}
