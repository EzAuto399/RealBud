import { readSessionToken, primeBrowserSession, enterSampleDeskForQa } from './local-session.mjs';
// "Show Bud a task" drawer (Schedule header button and #schedule-learn): built renderer + real isolated
// source service with seeded fictional learned-recipe drafts. Never presses
// "Start showing" (it opens a real work browser). No worker, no portal.
// Node 24+, PLAYWRIGHT_MODULE, optional CHROME_EXECUTABLE, QA_OUTPUT and
// REALBUD_UI_DIR (a `vite build --outDir <scratch>`; defaults to dist/).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { serviceSmokeEnv } = await import(join(root, 'scripts/service-smoke-env.mjs'));
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const ui = resolve(process.env.REALBUD_UI_DIR ?? join(root, 'dist'));
assert.ok(existsSync(join(ui, 'index.html')), `No built renderer at ${ui}; run vite build --outDir <scratch> and set REALBUD_UI_DIR.`);
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/learn-ui-2026-10-07'));
assert.ok(!existsSync(output), 'Choose a fresh QA_OUTPUT; existing evidence is preserved.');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-learn-ui-'));
const data = join(scratch, 'data'); mkdirSync(data, { mode: 0o700 });
const file = join(data, 'learned-recipes.json');
const checks = [], findings = [], errors = [], consoleErrors = [], failedResponses = [];
let child, browser, page, failure, logs = '', base, token;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const finding = message => { findings.push(message); console.log(`FINDING ${message}`); };
const call = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { 'x-realbud-session': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
};
const onDisk = () => JSON.parse(readFileSync(file, 'utf8'));
const diskRecipe = id => onDisk().recipes.find(recipe => recipe.id === id);

// Synthetic drafts only (fictional titles; REI Cloud labels from the shipped pack).
const DRAFT = 'lr_' + 'a'.repeat(24), PUBLISHED = 'lr_' + 'b'.repeat(24), now = Date.now();
const recipe = (fields) => ({ version: 1, purpose: 'realbud-learned-recipe', portal: 'rei-cloud', confirmedLabels: [], flags: [], stopBefore: [], inputs: [], createdAt: now, updatedAt: now, revision: 1, ...fields });
writeFileSync(file, JSON.stringify({ version: 1, purpose: 'realbud-learned-recipes', revision: 2, recipes: [
  recipe({ id: DRAFT, name: 'learned-fictional-receipts-check', title: 'Fictional receipts check', state: 'draft',
    steps: [{ nav: ['Receipts', 'Tenant receipts'] }, { click: 'Show filters' }, { type: { field: 'Date from', value: '{date_from}' } }, { click: 'Search' }, { wait: 'table' }, { read: 'table' }],
    inputs: ['date_from'], stopBefore: ['Process Receipts'],
    flags: [{ code: 'needs-confirm', label: 'Show filters' }, { code: 'outside-main', label: 'Help' }] }),
  recipe({ id: PUBLISHED, name: 'learned-fictional-dashboard-read', title: 'Fictional dashboard read', state: 'published', steps: [{ nav: ['Dashboard'] }, { read: 'controls' }] }),
] }, null, 2), { mode: 0o600 });

try {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root, env: {
    ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port }),
    REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: ui,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null);
    ready = health?.pid === child.pid; if (!ready) await wait(100);
  }
  assert.ok(ready, 'service starts');
  token = await readSessionToken(data);
  const seeded = await call('/api/learn');
  assert.equal(seeded.status, 200);
  assert.deepEqual(seeded.body.recipes.map(r => [r.id, r.state]), [[DRAFT, 'draft'], [PUBLISHED, 'published']]);
  assert.equal(seeded.body.session.state, 'idle');
  pass('Service accepts the seeded learned-recipes file (one draft, one published)');

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, base, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
  const learnPosts = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/learn')) learnPosts.push(new URL(request.url()).pathname); });
  await page.goto(base + '/');
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Learn Person');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // First run has no sample-desk exit: the QA helper completes it as that button did and passes the office-link screen.
  await page.getByRole('heading', { name: 'Connect this computer to your office', exact: true }).waitFor();
  await enterSampleDeskForQa(page);
  pass('Fictional sample Desk opens');

  // Staff path: Schedule → "Show Bud a task" in the header. Then the deep link.
  await page.getByRole('button', { name: 'Schedule', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  const card = page.getByRole('dialog', { name: 'Show Bud a task', exact: true });
  const subtitle = 'Do the task in the work browser. Bud records which buttons, menus and fields you use. It never keeps what you type into fields.';
  await page.getByRole('button', { name: 'Show Bud a task', exact: true }).click();
  await card.getByText(subtitle, { exact: true }).waitFor();
  assert.equal(await card.getByRole('heading', { name: 'Show Bud a task' }).count(), 1, 'drawer title only; the card does not repeat it');
  assert.equal(await card.evaluate(element => element.hasAttribute('data-wide')), true, 'drawer is wide');
  pass('Schedule header "Show Bud a task" opens a wide drawer with one title and the new subtitle');
  await card.getByRole('button', { name: 'Close Show Bud a task', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  await page.evaluate(() => { location.hash = '#schedule-learn'; });
  await card.getByText(subtitle, { exact: true }).waitFor();
  pass('#schedule-learn opens the same drawer');

  const start = card.getByRole('button', { name: 'Start showing', exact: true });
  assert.equal(await start.isEnabled(), true);
  assert.equal(await card.getByRole('combobox').count(), 0, 'one portal: no portal picker');
  pass('Idle state shows an enabled "Start showing" (not pressed: it opens a real work browser)');

  const draft = card.locator('li').filter({ has: page.getByRole('heading', { name: 'Fictional receipts check', exact: true }) });
  const published = card.locator('li').filter({ has: page.getByRole('heading', { name: 'Fictional dashboard read', exact: true }) });
  const steps = await draft.locator('ol > li > span:first-child').allTextContents();
  assert.deepEqual(steps, ['1. Open Receipts › Tenant receipts', '2. Press Show filters', '3. Type into Date from (asked each run)', '4. Press Search', '5. Wait for the table', '6. Read the table']);
  assert.deepEqual(await published.locator('ol > li > span:first-child').allTextContents(), ['1. Open Dashboard', '2. Read the page']);
  pass('Steps render in plain words; the {date_from} step reads "asked each run"');
  await draft.getByText('Stops before: Process Receipts', { exact: true }).waitFor();
  pass('"Stops before: Process Receipts" line shows');
  const warnings = draft.getByRole('list', { name: 'Warnings for Fictional receipts check', exact: true });
  await warnings.getByText('“Help” sits outside the main page, so Bud can\'t repeat it.', { exact: true }).waitFor();
  const skip = warnings.getByRole('button', { name: 'OK, skip this: Help', exact: true });
  assert.equal(await skip.isEnabled(), true);
  assert.equal(await warnings.getByText(/Show filters/).count(), 0, 'needs-confirm is a checkbox, not a warning');
  pass('Outside-main flag shows as a warning with "OK, skip this"');
  const tick = draft.getByRole('checkbox', { name: 'Show filters only opens or shows something', exact: true });
  assert.equal(await tick.count(), 1, 'only the unconfirmed click gets a checkbox (Search is read-safe)');
  assert.equal(await tick.isChecked(), false);
  pass('Needs-confirm click shows the "Only opens or shows something" checkbox, unticked');
  const publish = draft.getByRole('button', { name: 'Publish Fictional receipts check', exact: true });
  assert.equal(await publish.isDisabled(), true);
  await draft.getByText('Sort out the warnings first.', { exact: true }).waitFor();
  assert.equal(await published.getByText('Published', { exact: true }).count(), 1);
  assert.equal(await published.getByRole('button', { name: 'Unpublish Fictional dashboard read', exact: true }).isEnabled(), true);
  pass('Publish is disabled with reason "Sort out the warnings first."; the published recipe shows Run/Unpublish');
  await card.screenshot({ animations: 'disabled', path: join(output, 'learn-card-1365-initial.png') });

  // Keyboard only: Tab from Start showing through the draft reaches its controls, each with a visible name.
  // The drawer traps focus, so stop once Tab wraps back to Start showing.
  await start.focus(); await start.evaluate(el => { el.dataset.qaStart = '1'; });
  const reached = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el.dataset.qaStart || !document.querySelector('[role="dialog"]')?.contains(el)) return null;
      const label = el.getAttribute('aria-label') || el.closest('label')?.innerText.trim() || el.innerText?.trim() || '';
      const box = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), label, aria: el.getAttribute('aria-label'), visible: box.width > 0 && box.height > 0, outline: getComputedStyle(el).outlineStyle };
    });
    if (!focused) break;
    reached.push(focused);
  }
  const names = reached.map(item => item.label);
  for (const name of ['Show filters only opens or shows something', 'OK, skip this: Help', 'Delete Fictional receipts check', 'Remove step 2: Press Show filters', 'Use fixed text for Date from']) assert.ok(names.includes(name), `Tab reaches "${name}" (reached: ${names.join(' | ')})`);
  assert.ok(reached.every(item => item.label && item.visible && item.outline !== 'none'), `every stop has a visible label and focus outline: ${JSON.stringify(reached)}`);
  const distinct = names.filter(name => name.startsWith('Remove step ') || name.startsWith('Delete '));
  assert.equal(new Set(distinct).size, distinct.length, `repeated controls have unique names: ${distinct.join(' | ')}`);
  pass(`Tab reaches the checkbox, Remove, Use fixed text, OK skip this and Delete, each with a unique name and focus outline (${reached.length} stops)`);

  // Step rows line up: compact inline controls, each still a 24px hit target, no text selection on double-click.
  const rowHeights = await draft.locator('ol > li').evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height)));
  assert.ok(Math.max(...rowHeights) - Math.min(...rowHeights) <= 4 && Math.max(...rowHeights) <= 32, `even step rows: ${rowHeights}`);
  const targets = await draft.locator('ol button').evaluateAll(buttons => buttons.map(b => [b.getAttribute('aria-label'), Math.round(b.getBoundingClientRect().height), getComputedStyle(b).userSelect]));
  assert.ok(targets.every(([, height, select]) => height >= 24 && select === 'none'), `inline step buttons ≥24px and select-none: ${JSON.stringify(targets)}`);
  pass(`Draft step rows are even (${rowHeights.join('/')}px) and inline buttons are ≥24px with select-none`);

  // Acknowledge the flag and tick the confirm, by keyboard.
  await skip.focus(); await page.keyboard.press('Enter');
  await card.getByRole('status').getByText('Warning cleared.', { exact: true }).waitFor();
  await warnings.waitFor({ state: 'detached' });
  await draft.getByText('Tick or remove: Show filters.', { exact: true }).waitFor();
  assert.equal(await publish.isDisabled(), true);
  pass('Acknowledging the flag clears it; Publish stays disabled with "Tick or remove: Show filters."');
  await tick.focus(); await page.keyboard.press('Space');
  await card.getByRole('status').getByText('“Show filters” marked as only opening or showing something.', { exact: true }).waitFor();
  assert.equal(await tick.isChecked(), true);
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find(x => x.getAttribute('aria-label') === 'Publish Fictional receipts check'); return b && !b.disabled; });
  const beforePublish = diskRecipe(DRAFT);
  assert.deepEqual([beforePublish.state, beforePublish.confirmedLabels, beforePublish.flags], ['draft', ['Show filters'], []]);
  pass(`Ticking the confirm enables Publish (file: draft, confirmed ["Show filters"], no flags, revision ${beforePublish.revision})`);
  await card.screenshot({ animations: 'disabled', path: join(output, 'learn-card-1365-ready.png') });

  // Double-click Publish: one request, then Published.
  const postsBefore = learnPosts.length;
  await publish.dblclick();
  await card.getByRole('status').getByText('Fictional receipts check is published.', { exact: true }).waitFor();
  await draft.getByText('Published', { exact: true }).waitFor();
  await wait(500);
  const publishPosts = learnPosts.slice(postsBefore);
  assert.deepEqual(publishPosts, [`/api/learn/recipes/${DRAFT}/publish`], `one publish request, got ${JSON.stringify(publishPosts)}`);
  const afterPublish = diskRecipe(DRAFT);
  assert.equal(afterPublish.state, 'published');
  assert.equal(afterPublish.revision, beforePublish.revision + 1);
  assert.equal(await publish.count(), 0);
  assert.equal(await draft.getByRole('checkbox').count(), 0, 'published recipes are not editable');
  pass(`Double-clicked Publish sends exactly one request; chip shows Published; file revision ${beforePublish.revision} → ${afterPublish.revision}, state published`);
  await card.screenshot({ animations: 'disabled', path: join(output, 'learn-card-1365-published.png') });

  // Stale revision: another window unpublishes and republishes behind the card's back.
  const stale = afterPublish.revision;
  assert.equal((await call(`/api/learn/recipes/${DRAFT}/unpublish`, 'POST', { expectedRevision: stale })).status, 200);
  assert.equal((await call(`/api/learn/recipes/${DRAFT}/publish`, 'POST', { expectedRevision: stale + 1 })).status, 200);
  const unpublish = draft.getByRole('button', { name: 'Unpublish Fictional receipts check', exact: true });
  await unpublish.click();
  await card.getByRole('alert').getByText('This recipe changed elsewhere. Reload and try again.', { exact: true }).waitFor();
  assert.equal(diskRecipe(DRAFT).state, 'published', 'stale write refused');
  await card.screenshot({ animations: 'disabled', path: join(output, 'learn-card-1365-stale.png') });
  pass('A stale-revision Unpublish shows "This recipe changed elsewhere. Reload and try again." and leaves the file unchanged');

  // The list reloaded, so the next Unpublish carries the fresh revision.
  await unpublish.click();
  await card.getByRole('status').getByText('Fictional receipts check is back to a draft.', { exact: true }).waitFor();
  assert.equal(await card.getByRole('alert').count(), 0, 'error cleared');
  await draft.getByText('Draft', { exact: true }).waitFor();
  const unpublished = diskRecipe(DRAFT);
  assert.deepEqual([unpublished.state, unpublished.revision], ['draft', stale + 3]);
  assert.equal(await publish.isEnabled(), true, 'confirmations survive unpublish');
  pass(`After the 409 the card reloaded: Unpublish succeeds (file draft, revision ${stale + 3}) and Publish is ready again`);

  // Delete asks first; Cancel keeps it, OK removes it.
  const dialogs = [];
  let answer = 'dismiss';
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog[answer](); });
  const del = draft.getByRole('button', { name: 'Delete Fictional receipts check', exact: true });
  const postsBeforeDelete = learnPosts.length;
  await del.click(); await wait(300);
  assert.equal(learnPosts.length, postsBeforeDelete, 'cancelled delete sends nothing');
  assert.ok(diskRecipe(DRAFT), 'cancelled delete keeps the recipe');
  answer = 'accept';
  await del.click();
  await card.getByRole('status').getByText('Fictional receipts check deleted.', { exact: true }).waitFor();
  await draft.waitFor({ state: 'detached' });
  assert.deepEqual(dialogs, ['Delete Fictional receipts check? This can\'t be undone.', 'Delete Fictional receipts check? This can\'t be undone.']);
  assert.deepEqual(onDisk().recipes.map(r => r.id), [PUBLISHED]);
  await published.waitFor();
  pass('Delete asks "Delete Fictional receipts check? This can\'t be undone."; Cancel keeps it, OK removes it from card and file');

  await page.setViewportSize({ width: 1024, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll at 1024px');
  await card.screenshot({ animations: 'disabled', path: join(output, 'learn-card-1024.png') });
  await page.screenshot({ animations: 'disabled', path: join(output, 'schedule-1024.png') });
  pass('1024px wide: card renders without horizontal page scroll');

  assert.deepEqual(errors, []);
  // Chrome logs every 4xx as a console resource error; only the stale Unpublish 409 belongs to this card.
  assert.deepEqual(failedResponses.filter(line => line.includes('/api/learn')), [`409 POST /api/learn/recipes/${DRAFT}/unpublish`]);
  const unexpected = consoleErrors.filter(text => !/^Failed to load resource: the server responded with a status of \d{3}/.test(text));
  assert.deepEqual(unexpected, [], 'no console errors other than logged HTTP statuses');
  pass(`Zero renderer page errors; the card's only failed request is the expected stale 409 (other app responses: ${failedResponses.filter(line => !line.includes('/api/learn')).join(', ') || 'none'})`);
} catch (error) {
  failure = error.stack || String(error);
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close').catch(() => {}); }
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Built React UI in headless Chrome; real isolated source service; seeded fictional learned recipes; no worker, no work browser, no portal or customer accounts',
    limits: ['Seeded fictional drafts only; recording (Start showing / Finish / Discard) is not exercised because it opens a real work browser', 'Run → Send to Work is not exercised', 'Built renderer served by the source service, not a packaged or installed app', 'Not customer acceptance'],
    checks, findings, errors, consoleErrors, failedResponses, failure, ...(failure ? { diagnostic: logs.slice(-3000) } : {}) }, null, 2));
  rmSync(scratch, { recursive: true, force: true });
  if (failure) { console.error(failure); process.exitCode = 1; }
}
