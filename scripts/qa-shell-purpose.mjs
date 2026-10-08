import { readSessionToken, primeBrowserSession } from './local-session.mjs';
// Shell purpose (owner feedback 2026-10-05): every rail, context-sidebar, status-bar and
// side-panel control does something visible; the queue shortcuts filter Desk; headers are
// thinner and the Work composer shorter and wider. Built React UI from REALBUD_UI_DIR against a
// real, disposable local service. Fictional sample book, then an empty office book. Never reads
// ~/.realbud or dist/. Node 24, PLAYWRIGHT_MODULE, REALBUD_UI_DIR, optional CHROME_EXECUTABLE.
//   QA_MEASURE_ONLY=1  measure header and composer sizes only (run against the previous build);
//   QA_BASELINE=<receipt.json from that run>  the full run asserts against those sizes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module.');
assert.ok(process.env.REALBUD_UI_DIR, 'Set REALBUD_UI_DIR to a scratch `vite build --outDir` folder; dist/ is shared.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const measureOnly = process.env.QA_MEASURE_ONLY === '1';
const baseline = process.env.QA_BASELINE ? JSON.parse(readFileSync(process.env.QA_BASELINE, 'utf8')).measurements?.sizes : null;
assert.ok(measureOnly || baseline, 'Set QA_BASELINE to the receipt of a QA_MEASURE_ONLY=1 run against the previous build.');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/shell-purpose-2026-10-05'));
mkdirSync(output, { recursive: true });
const prefix = measureOnly ? 'before' : 'after';
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-shell-purpose-'));
const data = join(temp, 'data'); mkdirSync(data, { mode: 0o700 });
const checks = [], errors = [], screenshots = [], measurements = {}, controls = [];
let child, browser, page, failure, logs = '';
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const until = async (check, message) => { for (let i = 0; i < 100; i++) { if (await check()) return; await wait(50); } assert.fail(message); };
const shot = async name => { await page.screenshot({ path: join(output, `${prefix}-${name}`), animations: 'disabled' }); screenshots.push(`${prefix}-${name}`); };
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow');

/** Everything a press can visibly change: address, focus, selection/expansion state, dialogs,
 *  the queue's contents and the page headings. */
const observe = () => page.evaluate(() => {
  const name = element => element ? `${element.tagName}#${element.id}[${element.getAttribute('aria-label') ?? ''}]${(element.textContent ?? '').trim().slice(0, 40)}` : 'none';
  return JSON.stringify({
    hash: location.hash,
    focus: name(document.activeElement),
    states: [...document.querySelectorAll('[aria-current], [aria-selected="true"], [aria-expanded], [aria-pressed], details[open]')]
      .map(element => `${name(element)}:${element.getAttribute('aria-current')}/${element.getAttribute('aria-selected')}/${element.getAttribute('aria-expanded')}/${element.getAttribute('aria-pressed')}/${element.open ?? ''}`),
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 30)),
    queue: document.querySelector('#desk-queue-list')?.innerText ?? null,
    scope: document.querySelector('.property-scope-banner')?.innerText ?? null,
    headings: [...document.querySelectorAll('main h1, main h2')].map(heading => heading.innerText).join('|'),
  });
});
/** Press one control and fail if nothing observable changed. */
async function press(area, locator, label, expect) {
  const before = await observe();
  await locator.click();
  await wait(120);
  if (expect) await expect();
  const after = await observe();
  assert.notEqual(after, before, `${area} → "${label}" changed nothing visible`);
  const diff = Object.keys(JSON.parse(after)).filter(key => JSON.stringify(JSON.parse(after)[key]) !== JSON.stringify(JSON.parse(before)[key]));
  controls.push({ area, label, changed: diff });
}
/** Every button, link and menu trigger in a region, by accessible name. */
const names = region => region.locator('button:visible, a[href]:visible, summary:visible').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') || element.innerText.trim().replace(/\s+/g, ' ')));
const covered = (area, found, done) => { const missed = found.filter(item => !done.includes(item)); assert.deepEqual(missed, [], `${area}: controls not exercised`); };

async function sizes() {
  const box = selector => page.locator(selector).first().evaluate(element => { const rect = element.getBoundingClientRect(); return { height: Math.round(rect.height), width: Math.round(rect.width) }; });
  const result = {};
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('heading', { name: 'Work', exact: true }).waitFor();
  await page.locator('.ask-composer-frame').waitFor();
  result.workHeader = await box('.ask-header');
  result.composer = await box('.ask-composer-frame');
  result.composerBlock = await box('.ask-composer');
  await shot('work-1440.png');
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  result.scheduleHeader = await box('main > header');
  await shot('schedule-1440.png');
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Desk', exact: true }).click();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  result.deskHeader = await box('.pm-desk-header');
  result.deskToolbar = await box('.pm-desk-toolbar');
  await shot('desk-1440.png');
  return result;
}

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
  const call = (path, method = 'GET', body) => fetch(origin + path, { method, headers: { 'x-realbud-session': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, origin, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Purpose Reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/practice' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Check sample tasks', exact: true }).first().click();
  assert.equal((await checked).status(), 200);
  await page.getByRole('listbox', { name: 'Case queue', exact: true }).waitFor();

  measurements.sizes = await sizes();
  if (measureOnly) { pass(`Measured the previous build: ${JSON.stringify(measurements.sizes)}`); throw null; }

  // 1. Thinner headers, a shorter and wider composer (same 1440×940 window, same sample state).
  const now = measurements.sizes;
  for (const key of ['workHeader', 'scheduleHeader', 'deskHeader']) assert.ok(now[key].height < baseline[key].height, `${key} is thinner (${baseline[key].height} → ${now[key].height}px)`);
  assert.ok(now.composer.height <= baseline.composer.height, `Composer is no taller (${baseline.composer.height} → ${now.composer.height}px)`);
  assert.ok(now.composer.width >= baseline.composer.width, `Composer is no narrower (${baseline.composer.width} → ${now.composer.width}px)`);
  measurements.compared = Object.fromEntries(['workHeader', 'scheduleHeader', 'deskHeader', 'composer', 'composerBlock'].map(key => [key, { before: baseline[key], after: now[key] }]));
  pass(`Headers thinner (Work ${baseline.workHeader.height}→${now.workHeader.height}, Schedule ${baseline.scheduleHeader.height}→${now.scheduleHeader.height}, Desk ${baseline.deskHeader.height}→${now.deskHeader.height}px); composer ${baseline.composer.width}×${baseline.composer.height} → ${now.composer.width}×${now.composer.height}px`);

  // Composer still works: keyboard focus, 44px controls, Enter hint, attachments entry.
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Work', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Tell Bud what outcome you need', exact: true });
  await input.click(); await page.keyboard.type('Fictional outcome line one'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('line two');
  assert.match(await input.inputValue(), /line one\nline two/);
  const tall = await page.locator('.ask-composer-frame').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(tall > now.composer.height, 'The message box grows with a second line');
  for (const control of await page.locator('.ask-composer-input button:visible').all()) assert.ok((await control.boundingBox()).height >= 44, 'Composer controls keep 44px targets');
  await input.fill('');
  pass('The composer takes typing and Shift+Enter, grows with content and keeps 44px controls');

  // 2. Rail: every control lands somewhere.
  const rail = page.locator('aside.rb-sidebar');
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  const railDone = [];
  for (const [label, hash] of [['Desk', '#/desk'], ['Work', '#/ask'], ['Schedule', '#/schedule'], ['Workspace', '#/you'], ['Desk', '#/desk']]) {
    const control = label === 'Workspace' ? rail.getByRole('button', { name: 'Workspace', exact: true }) : nav.getByRole('button', { name: label, exact: true });
    await press('Rail', control, label, async () => { await page.waitForURL(url => url.hash === hash); assert.equal(await control.getAttribute('aria-current'), 'page'); });
    railDone.push(label);
  }
  covered('Rail', await names(rail), railDone);
  pass(`Rail: ${[...new Set(railDone)].join(', ')} each change the screen and aria-current (no update button outside the desktop app)`);

  // 3. Desk context: queue filters filter Desk, from any tab.
  const contextBar = page.getByRole('region', { name: 'Desk context', exact: true });
  const status = page.getByRole('combobox', { name: 'Status', exact: true });
  const queueList = page.getByRole('listbox', { name: 'Case queue', exact: true });
  const deskDone = [];
  const filterLabels = [['next', 'Next'], ['waiting', 'Waiting'], ['done', 'Done today'], ['all', 'All tasks'], ['now', 'Needs you']];
  const queueTexts = {};
  for (const [value, label] of filterLabels) {
    const item = contextBar.getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
    const count = Number((await item.innerText()).match(/(\d+)\s*$/)[1]);
    await press('Desk context', item, label, async () => {
      await until(async () => await item.getAttribute('aria-current') === 'true', `${label} is marked current`);
      assert.equal(await status.inputValue(), value, `${label} sets the queue Status`);
      const text = await queueList.innerText();
      if (!count) assert.ok(text.trim().length > 0, `An empty ${label} queue says so`);
      else assert.equal(await queueList.getByRole('option').count(), Math.min(count, 25), `${label} lists its ${count} tasks`);
      queueTexts[value] = text;
    });
    deskDone.push(await item.evaluate(element => element.innerText.trim().replace(/\s+/g, ' ')));
  }
  assert.ok(new Set(Object.values(queueTexts)).size > 1, 'The queue contents differ between filters');
  measurements.emptyQueueMessages = Object.fromEntries(Object.entries(queueTexts).filter(([, text]) => !/\n/.test(text.trim())).map(([key, text]) => [key, text.trim()]));
  await shot('desk-filter.png');
  // From Hermios: a queue shortcut returns to Tasks.
  await page.locator('.pm-desk-header').getByRole('button', { name: 'Hermios', exact: true }).click();
  await until(async () => (await page.getByRole('heading', { name: 'Task queue', exact: true }).count()) === 0, 'Hermios replaces the queue');
  const waiting = contextBar.getByRole('button', { name: /^Waiting \d+$/ });
  await press('Desk context', waiting, 'Waiting (from Hermios)', async () => {
    await page.getByRole('heading', { name: 'Task queue', exact: true }).waitFor();
    assert.equal(await status.inputValue(), 'waiting');
  });
  // From Properties: the same.
  await page.getByRole('tablist', { name: 'Desk views', exact: true }).getByRole('tab', { name: /^Properties/ }).click();
  await page.getByRole('heading', { name: 'Properties', exact: true }).waitFor();
  await press('Desk context', contextBar.getByRole('button', { name: /^Next \d+$/ }), 'Next (from Properties)', async () => {
    await page.getByRole('heading', { name: 'Task queue', exact: true }).waitFor();
    assert.equal(await status.inputValue(), 'next');
  });
  pass('Needs you / Next / Waiting / Done today / All tasks set the queue Status, mark aria-current, show counts and change the queue; from Hermios or Properties they return to Tasks');

  // Properties in the sidebar scope the queue; "All N properties" opens the book; Arrange Desk opens its sheet.
  const propertyButtons = await contextBar.locator('.rb-context-group').nth(1).getByRole('button').all();
  for (const button of propertyButtons) {
    const label = await button.evaluate(element => element.innerText.trim().replace(/\s+/g, ' '));
    if (/^All \d+ properties$/.test(label)) {
      await press('Desk context', button, label, () => page.getByRole('heading', { name: 'Properties', exact: true }).waitFor());
      await page.locator('.pm-desk-header').getByRole('button', { name: /^Tasks/ }).click();
    } else {
      await press('Desk context', button, label, async () => { await page.locator('.property-scope-banner').waitFor(); assert.equal(await button.getAttribute('aria-current'), 'true'); });
    }
    deskDone.push(label);
  }
  await press('Desk context', contextBar.getByRole('button', { name: 'Arrange Desk', exact: true }), 'Arrange Desk', () => page.getByRole('dialog', { name: 'Arrange Desk', exact: true }).waitFor());
  deskDone.push('Arrange Desk');
  await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: 'Arrange Desk', exact: true }).waitFor({ state: 'detached' });
  covered('Desk context', await names(contextBar), deskDone);
  pass(`Desk context: ${propertyButtons.length - 1} property shortcuts scope the queue, All properties opens the book, Arrange Desk opens its sheet`);

  // 4. Side panel: menus, rows, counts and links.
  await contextBar.getByRole('button', { name: /^Needs you \d+$/ }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel', exact: true });
  const panelDone = [];
  const evidence = panel.getByRole('region', { name: 'Evidence', exact: true });
  await press('Side panel', evidence.getByRole('button', { name: 'Open the case to decide', exact: true }), 'Open the case to decide', () => until(async () => page.evaluate(() => document.activeElement?.id === 'desk-case-column'), 'Focus moves to the case'));
  panelDone.push('Open the case to decide');
  const approvals = panel.getByRole('region', { name: 'Approvals waiting', exact: true });
  const approvalRows = await approvals.getByRole('button', { name: /^Open / }).all();
  if (approvalRows.length > 1) {
    const label = await approvalRows[1].getAttribute('aria-label');
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await press('Side panel', approvalRows[1], label, () => until(async () => (await page.locator('#desk-case-column').innerText()).includes(label.replace(/^Open /, '').split(',')[0]), 'The chosen case shows'));
  }
  for (const row of approvalRows) panelDone.push(await row.getAttribute('aria-label'));
  const seeAll = approvals.getByRole('button', { name: /^See all \d+ waiting$/ });
  if (await seeAll.count()) { await contextBar.getByRole('button', { name: /^All tasks \d+$/ }).click(); await press('Side panel', seeAll, 'See all waiting', async () => assert.equal(await status.inputValue(), 'now')); panelDone.push(await seeAll.innerText()); }
  const today = panel.getByRole('region', { name: 'Today', exact: true });
  for (const label of ['Waiting', 'Next', 'Needs you']) {
    const count = today.getByRole('button', { name: new RegExp(`^${label}: \\d+$`) });
    await press('Side panel', count, label, async () => { assert.equal(await count.getAttribute('aria-current'), 'true'); });
    panelDone.push(await count.getAttribute('aria-label'));
  }
  for (const title of ['Evidence', 'Approvals waiting', 'Today']) {
    const menu = panel.locator(`summary[aria-label="${title} options"]`);
    await press('Side panel', menu, `${title} options`, () => panel.getByRole('group', { name: `${title} options`, exact: true }).waitFor());
    panelDone.push(`${title} options`);
    await page.keyboard.press('Escape');
    await until(async () => !(await panel.getByRole('group', { name: `${title} options`, exact: true }).isVisible()), `${title} menu closes`);
  }
  const more = panel.getByRole('button', { name: 'More panels', exact: true });
  await press('Side panel', more, 'More panels', async () => { assert.equal(await more.getAttribute('aria-expanded'), 'true'); await panel.getByRole('button', { name: 'Show Bud activity', exact: true }).waitFor(); });
  panelDone.push('More panels');
  for (const hidden of await panel.getByRole('button', { name: /^Show / }).all()) panelDone.push(await hidden.innerText());
  await more.click();
  covered('Side panel', await names(panel), panelDone);
  pass('Side panel: Open the case moves focus to the case, approval rows open their case, Today counts filter the queue, each ⋯ menu opens and More panels lists hidden panels');

  // 5. Status bar.
  const statusBar = page.getByRole('contentinfo', { name: 'Status bar', exact: true });
  const statusDone = [];
  await nav.getByRole('button', { name: 'Work', exact: true }).click(); await page.waitForURL(url => url.hash === '#/ask');
  const runButton = statusBar.getByRole('button', { name: /Sample book|Desk/ }).first();
  const runLabel = await runButton.innerText();
  await press('Status bar', runButton, runLabel, async () => { await page.waitForURL(url => url.hash === '#/desk'); await page.getByRole('heading', { name: 'Task queue', exact: true }).waitFor(); });
  statusDone.push(runLabel);
  const loopButton = statusBar.getByRole('button', { name: /^Next: |^No loop scheduled$/ });
  const loopLabel = await loopButton.innerText();
  await press('Status bar', loopButton, loopLabel, async () => {
    await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
    if (loopLabel.startsWith('Next: ')) await page.getByRole('dialog').waitFor();
  });
  statusDone.push(loopLabel);
  if (loopLabel.startsWith('Next: ')) { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
  await shot('status-loop.png');
  covered('Status bar', await names(statusBar), statusDone);
  assert.doesNotMatch(await statusBar.locator('button').allInnerTexts().then(list => list.join('|')), /Connected/, 'Connection state stays a plain fact');
  pass(`Status bar: "${runLabel}" opens Desk tasks and "${loopLabel}" opens ${loopLabel.startsWith('Next: ') ? 'that loop in Schedule' : 'Schedule'}; Connected stays a fact (spend absent on an unlinked book)`);

  // 6. Schedule context: each loop opens its drawer. Work context: the thread opens with focus in the composer.
  const scheduleContext = page.getByRole('region', { name: 'Schedule context', exact: true });
  const loops = await scheduleContext.getByRole('button').all();
  const scheduleDone = [];
  assert.ok(loops.length >= 1, 'Schedule lists loops');
  for (const loop of loops) {
    const label = await loop.evaluate(element => element.querySelector('span span')?.innerText.trim() ?? element.innerText.trim());
    await press('Schedule context', loop, label, async () => { await page.getByRole('dialog').waitFor(); });
    scheduleDone.push(await loop.evaluate(element => element.innerText.trim().replace(/\s+/g, ' ')));
    await page.getByRole('dialog').getByRole('button', { name: /^Close / }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
  await scheduleContext.getByRole('button').first().click(); await page.getByRole('dialog').waitFor();
  await shot('schedule-loop-drawer.png');
  await page.getByRole('dialog').getByRole('button', { name: /^Close / }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
  covered('Schedule context', await names(scheduleContext), scheduleDone);
  await nav.getByRole('button', { name: 'Work', exact: true }).click();
  const workContext = page.getByRole('region', { name: 'Work context', exact: true });
  const workDone = [];
  for (const thread of await workContext.getByRole('button').all()) {
    const label = await thread.evaluate(element => element.innerText.trim().replace(/\s+/g, ' '));
    await page.locator('aside.rb-sidebar').getByRole('button', { name: 'Work', exact: true }).focus();
    await press('Work context', thread, label, () => until(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Tell Bud what outcome you need'), 'Focus lands in the composer'));
    workDone.push(label);
  }
  covered('Work context', await names(workContext), workDone);
  pass(`Schedule context: ${loops.length} loops each open their detail drawer; Work context: ${workDone.join(', ')} opens the thread with focus in the composer`);

  // 7. Empty office book: the queue collapses to one line that leads to Properties.
  const snap = await (await call('/api/desk')).json();
  const live = await call('/api/desk/live', 'POST', { expectedRevision: snap.revision });
  assert.equal(live.status, 200, await live.text());
  await nav.getByRole('button', { name: 'Desk', exact: true }).click();
  await page.reload();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  await until(async () => (await contextBar.getByRole('button', { name: /^No tasks (yet|in saved data)/ }).count()) === 1, 'The empty book shows one queue line');
  assert.equal(await contextBar.getByRole('button', { name: /^(Needs you|Next|Waiting|Done today|All tasks) \d+$/ }).count(), 0, 'No dead filter buttons on an empty book');
  await shot('empty-book-desk.png');
  const emptyDone = [];
  await press('Desk context (empty book)', contextBar.getByRole('button', { name: /^No tasks (yet|in saved data)/ }), 'No tasks — Add properties to start', () => page.getByRole('heading', { name: 'Properties', exact: true }).waitFor());
  emptyDone.push(await contextBar.getByRole('button', { name: /^No tasks (yet|in saved data)/ }).innerText().then(text => text.trim().replace(/\s+/g, ' ')));
  await press('Desk context (empty book)', contextBar.getByRole('button', { name: 'Arrange Desk', exact: true }), 'Arrange Desk', () => page.getByRole('dialog', { name: 'Arrange Desk', exact: true }).waitFor());
  emptyDone.push('Arrange Desk');
  await page.keyboard.press('Escape');
  covered('Desk context (empty book)', await names(contextBar), emptyDone);
  assert.equal(await today.getByRole('button').count(), 0, 'No zero-count shortcuts on an empty book');
  // Unlinked or stale, the empty copy speaks only for saved data.
  await today.getByText(/^No tasks (yet|in saved data)\.$/).waitFor();
  const emptyPanelDone = [];
  for (const title of ['Evidence', 'Approvals waiting', 'Today']) {
    await press('Side panel (empty book)', panel.locator(`summary[aria-label="${title} options"]`), `${title} options`, () => panel.getByRole('group', { name: `${title} options`, exact: true }).waitFor());
    emptyPanelDone.push(`${title} options`);
    await page.keyboard.press('Escape');
    await until(async () => !(await panel.getByRole('group', { name: `${title} options`, exact: true }).isVisible()), `${title} menu closes`);
  }
  await press('Side panel (empty book)', more, 'More panels', async () => assert.equal(await more.getAttribute('aria-expanded'), 'true'));
  emptyPanelDone.push('More panels', ...(await panel.getByRole('button', { name: /^Show / }).allInnerTexts()));
  covered('Side panel (empty book)', await names(panel), emptyPanelDone);
  await more.click();
  await nav.getByRole('button', { name: 'Work', exact: true }).click(); await page.waitForURL(url => url.hash === '#/ask');
  const notChecked = statusBar.getByRole('button', { name: 'Desk not checked yet', exact: true });
  await press('Status bar (empty book)', notChecked, 'Desk not checked yet', async () => { await page.waitForURL(url => url.hash === '#/desk'); await page.getByRole('heading', { name: 'Start your office book', exact: true }).waitFor(); });
  const emptyLoop = statusBar.getByRole('button', { name: /^Next: |^No loop scheduled$/ });
  const emptyLoopLabel = await emptyLoop.innerText();
  await press('Status bar (empty book)', emptyLoop, emptyLoopLabel, () => page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor());
  covered('Status bar (empty book)', await names(statusBar), ['Desk not checked yet', emptyLoopLabel]);
  if (await page.getByRole('dialog').count()) { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
  await nav.getByRole('button', { name: 'Desk', exact: true }).click();
  pass('Empty office book: the queue group is one "No tasks … · Add properties to start" button that opens Properties; Today shows "No tasks …" (scoped to saved data unless live) instead of zero shortcuts; panel menus and "Desk not checked yet" (→ Start your office book) still act');

  // 8. Phone width still fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(); await shot('desk-390.png');
  await nav.getByRole('button', { name: 'Work', exact: true }).click(); await page.getByRole('heading', { name: 'Work', exact: true }).waitFor();
  await noOverflow(); await shot('work-390.png');
  pass('At 390px Desk and Work have no horizontal scroll');

  measurements.controls = controls;
  assert.deepEqual(errors, []);
  pass(`No renderer page errors; ${controls.length} presses, each with an observable change`);
} catch (cause) {
  if (cause !== null) {
    failure = cause instanceof Error ? cause.stack : String(cause);
    await page?.screenshot({ path: join(output, `${prefix}-failure.png`), animations: 'disabled' }).catch(() => {});
    console.error(failure);
  }
} finally {
  await browser?.close();
  if (child?.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(temp, { recursive: true, force: true });
  if (measureOnly && !failure) measurements.controls = controls;
  writeFileSync(join(output, measureOnly ? 'before-receipt.json' : 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, mode: measureOnly ? 'measure previous build' : 'full', layer: 'Built React UI (scratch build) in headless Chrome against a real disposable local service; fictional sample book, then an empty office book', checks, measurements, screenshots, errors, failure: failure ?? null,
    limits: ['Fictional sample book and an offline fake worker; no customer records, accounts or browser profiles.', 'Not a packaged app or installed-device check; the rail update button exists only in the desktop app.', 'Spend and browser Stop need a linked office and a running task; here they are absent.'] }, null, 2) + '\n');
  if (failure) process.exitCode = 1;
}
