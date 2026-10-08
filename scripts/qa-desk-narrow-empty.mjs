// Real source renderer + loopback service, disposable fictional sample only.
// Node 24+, PLAYWRIGHT_MODULE, optional CHROME_EXECUTABLE. No build or worker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { readSessionToken, primeBrowserSession } from './local-session.mjs';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/integration-qa-2026-09-23/desk-narrow-empty'));
assert.ok(!existsSync(output), 'Choose a fresh QA_OUTPUT; existing evidence is preserved.');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-desk-narrow-'));
const data = join(scratch, 'data'); mkdirSync(data, { mode: 0o700 });
const checks = [], errors = [], deniedOrigins = [], measurements = {};
let child, childClosed, vite, browser, page, failure, logs = '', base, uiBase, token;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = message => { checks.push(message); console.log(`PASS ${message}`); };
const port = async () => {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
};
const request = async path => {
  const response = await fetch(base + path, { headers: { 'x-realbud-session': token }, signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `GET ${path}: ${response.status}`); return response.json();
};
const fits = async locator => locator.evaluate(element => {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1;
});

// Use actual wheel input over the intended scroll region. No scrollIntoView,
// scrollTop assignment or forced clicks can hide a trapped setup control.
async function wheelTo(locator, area = page.locator('.desk-content')) {
  await locator.waitFor({ state: 'attached' });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const target = await locator.boundingBox(), region = await area.boundingBox();
    assert.ok(target && region, 'Target and scroll region have rendered bounds');
    const top = Math.max(0, region.y) + 3;
    const bottom = Math.min(page.viewportSize().height, region.y + region.height) - 3;
    const hit = await locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const under = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return under !== null && element.contains(under);
    });
    if (target.y >= top && target.y + target.height <= bottom && hit) return target;
    await page.mouse.move(Math.max(8, Math.min(page.viewportSize().width - 8, region.x + region.width / 2)), (top + bottom) / 2);
    await page.mouse.wheel(0, target.y < top ? -220 : 220);
    await wait(80);
  }
  throw new Error('Wheel input could not reach the complete target and its hit area');
}

async function metrics() {
  return page.locator('.desk-workspace').evaluate(main => {
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), height: Math.round(rect.height), scrollTop: Math.round(element.scrollTop),
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
    };
    const scrollOwners = [main, ...main.querySelectorAll('*')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY);
    }).map(element => element.classList.contains('desk-content') ? '.desk-content'
      : element.classList.contains('desk-queue-column') ? '.desk-queue-column' : element.id || element.className);
    return { width: innerWidth, main: box(main), header: box(main.querySelector('.pm-desk-header')),
      content: box(main.querySelector('.desk-content')), queue: box(main.querySelector('.desk-queue-column')),
      case: box(main.querySelector('.desk-case-column')), scrollOwners,
      documentScrollTop: document.scrollingElement.scrollTop, documentWidth: document.documentElement.scrollWidth };
  });
}
async function singleContentScroll() {
  const measured = await metrics();
  assert.deepEqual(measured.scrollOwners, ['.desk-content'], 'Desk has one scroll owner: .desk-content');
  assert.equal(measured.main.scrollTop, 0, 'The whole Desk does not scroll');
  assert.equal(measured.header.scrollTop, 0, 'The toolbar does not scroll');
  assert.ok(measured.content.top >= measured.header.top + measured.header.height - 1, 'The scroll region starts below the fixed toolbar');
  return measured;
}
async function wheelMovesContent(area) {
  const content = page.locator('.desk-content');
  const before = await singleContentScroll();
  const region = await content.boundingBox(), target = await area.boundingBox();
  assert.ok(region && target);
  const top = Math.max(region.y, target.y, 0) + 4;
  const bottom = Math.min(region.y + region.height, target.y + target.height, page.viewportSize().height) - 4;
  assert.ok(bottom > top, 'The wheel target intersects the visible content');
  const point = { x: target.x + target.width / 2, y: (top + bottom) / 2 };
  assert.ok(await area.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point), 'Wheel input lands over the intended column');
  const maximum = before.content.scrollHeight - before.content.clientHeight;
  assert.ok(maximum > 1, 'Sample content overflows so wheel scrolling is exercised');
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, before.content.scrollTop >= maximum - 1 ? -120 : 120);
  await page.waitForFunction(previous => Math.abs(document.querySelector('.desk-content').scrollTop - previous) > 1, before.content.scrollTop);
  const after = await singleContentScroll();
  assert.equal(after.header.top, before.header.top, 'The toolbar stays in place');
  assert.equal(after.documentScrollTop, before.documentScrollTop, 'The document does not take the wheel');
  assert.equal(after.queue.scrollTop, 0, 'The wide queue has no nested scroll');
  assert.equal(after.case.scrollTop, 0, 'The case has no nested scroll');
  return { before: before.content.scrollTop, after: after.content.scrollTop };
}
async function noOverflow() {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
}

try {
  const servicePort = await port(), uiPort = await port();
  base = `http://127.0.0.1:${servicePort}`; uiBase = `http://127.0.0.1:${uiPort}`;
  process.env.OMB_UI_PORT = String(uiPort);
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port: servicePort }),
      REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_UI_PORT: String(uiPort), OMB_STATIC_DIR: join(root, 'dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childClosed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) break;
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(response => response.json()).catch(() => null);
    if (health?.pid === child.pid) { ready = true; break; }
    await wait(100);
  }
  assert.ok(ready, 'Disposable source service starts');
  token = await readSessionToken(data);
  vite = await createViteServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn',
    server: { host: '127.0.0.1', port: uiPort, strictPort: true, proxy: { '/api': { target: base, changeOrigin: true, ws: true } } },
  });
  await vite.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, uiBase, token);
  await context.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    if (origin === uiBase) return route.continue();
    deniedOrigins.push(origin); return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(uiBase);
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Narrow Desk Person');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.locator('.desk-content .desk-empty-canvas').waitFor();
  assert.equal((await request('/api/onboarding')).stage, 'complete');

  // Get started sits on Desk itself, open, even on an empty office.
  const setup = page.getByRole('region', { name: 'Get started', exact: true });
  const expand = setup.getByRole('button', { name: /^Get started · / });
  if (await expand.count()) { await wheelTo(expand); await expand.click(); }
  const setupAction = setup.getByRole('button', { name: 'Enter link code', exact: true });
  const title = setup.getByText(/^1\. Paste the link code your office sent you/);
  await wheelTo(title); await wheelTo(setupAction);
  assert.ok(await fits(setupAction));
  measurements.empty390 = await singleContentScroll();
  await noOverflow();
  await page.screenshot({ path: join(output, 'setup-390.png') });
  await setupAction.click();
  await page.locator('#you-website').waitFor();
  record('At 390px, the Get started card and its current action are reachable inside .desk-content below a fixed toolbar; Enter link code opens the Website account section');

  await page.getByRole('button', { name: 'Desk', exact: true }).click();
  await page.locator('.desk-content .desk-empty-canvas').waitFor();
  for (const width of [720, 1400]) {
    await page.setViewportSize({ width, height: 844 });
    measurements[`empty${width}`] = await singleContentScroll();
    await noOverflow(); await page.screenshot({ path: join(output, `empty-${width}.png`) });
  }
  record('At 720px and 1400px, the empty Desk has one content scroll owner and no horizontal overflow');

  await page.setViewportSize({ width: 390, height: 844 });
  const sample = page.locator('.desk-empty-canvas').getByRole('button', { name: 'Check sample tasks', exact: true });
  await wheelTo(sample); await noOverflow();
  await page.screenshot({ path: join(output, 'sample-action-390.png') });
  const practiced = page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/practice' && response.request().method() === 'POST');
  await sample.click(); assert.equal((await practiced).status(), 200);
  const snapshot = await request('/api/desk');
  assert.ok(snapshot.lastRunAt !== null && snapshot.drafts.length > 0);
  await page.locator('.desk-case').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.desk-empty-canvas').count(), 0);
  record('Wheel input reaches the sample action; its actual local practice request creates sample review cases');

  const queue = page.getByRole('listbox', { name: 'Case queue', exact: true, includeHidden: true });
  const queuePane = page.locator('.desk-queue-column');
  await page.getByRole('dialog', { name: 'Tasks', exact: true }).waitFor();
  await queue.waitFor();
  assert.equal(await page.locator('.desk-content').evaluate(element => getComputedStyle(element).overflowY), 'hidden');
  assert.deepEqual((await metrics()).scrollOwners, ['.desk-queue-column'], 'Only the Tasks drawer scrolls while open');
  const status = queuePane.getByRole('combobox', { name: 'Status', exact: true });
  assert.equal(await status.inputValue(), 'now');
  assert.deepEqual(await status.locator('option').evaluateAll(options => options.map(option => option.textContent.split(' · ')[0])), ['Needs you', 'Next', 'Waiting', 'Done', 'All']);
  await queuePane.locator('.desk-queue-filters > summary').click();
  assert.equal(await queuePane.locator('.desk-case-kind select').inputValue(), 'all');
  await queuePane.getByRole('button', { name: 'Show reminders', exact: true }).click();
  await queuePane.getByRole('form', { name: 'Add a reminder', exact: true }).waitFor();
  const draft = snapshot.drafts.filter(row => row.status === 'pending').at(-1); assert.ok(draft);
  const property = snapshot.properties.find(row => row.id === draft.propertyId); assert.ok(property);
  const option = page.locator(`[id="queue-row-draft:${draft.id}"]`);
  await wheelTo(option, queuePane);
  measurements.queue390 = await queuePane.evaluate(element => ({
    scrollTop: Math.round(element.scrollTop), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    rowHeight: Math.round(element.querySelector('[role="listbox"]').getBoundingClientRect().height),
  }));
  assert.ok(measurements.queue390.scrollTop > 0 && measurements.queue390.rowHeight > 0, 'Wheel input reaches naturally sized queue rows');
  await page.screenshot({ path: join(output, 'queue-390.png') });
  await option.click(); await queuePane.waitFor({ state: 'hidden' });
  const caseView = page.locator('.desk-case');
  await caseView.getByRole('heading', { name: property.address, exact: true }).waitFor();
  const edit = caseView.getByRole('group', { name: 'Review wording', exact: true }).getByRole('button', { name: 'Edit wording', exact: true });
  await edit.waitFor();
  await wheelTo(edit); await edit.click();
  const wording = caseView.getByRole('textbox', { name: 'Draft wording', exact: true });
  await wording.waitFor(); assert.equal(await wording.inputValue(), draft.body);
  const cancel = caseView.getByRole('button', { name: 'Cancel', exact: true });
  await wheelTo(cancel); await cancel.click();
  await wording.waitFor({ state: 'hidden' });
  assert.equal((await request('/api/desk')).drafts.find(row => row.id === draft.id).body, draft.body);
  measurements.case390 = await singleContentScroll();
  await noOverflow(); await page.screenshot({ path: join(output, 'selected-case-390.png') });
  record('At 390px, wheel input reaches a queue row; clicking selects its actual case and opens/cancels review editing without changing wording');

  const header = page.locator('.pm-desk-header');
  const queueToggle = header.getByRole('button', { name: /^Tasks · \d+$/ });
  await queueToggle.click(); await queuePane.waitFor();
  const closeQueue = queuePane.getByRole('button', { name: 'Close tasks', exact: true });
  await wheelTo(closeQueue, queuePane); await closeQueue.click(); await queuePane.waitFor({ state: 'hidden' });
  record('Tasks · N opens the narrow drawer and its visible Close tasks control closes it');

  await queueToggle.click(); await queuePane.waitFor();
  await wheelTo(option, queuePane);
  const queueBox = await queuePane.boundingBox(); assert.ok(queueBox);
  await page.mouse.move(queueBox.x + queueBox.width / 2, queueBox.y + queueBox.height / 2);
  await page.mouse.wheel(0, 70); await wait(100);
  const beforeClosing = await queuePane.evaluate(element => element.scrollTop);
  assert.ok(beforeClosing > 0, 'The narrow drawer has a nonzero scroll position');
  const behindDrawer = await page.locator('.desk-content').evaluate(element => element.scrollTop);
  await page.keyboard.press('Escape'); await queuePane.waitFor({ state: 'hidden' });
  await queueToggle.click(); await queuePane.waitFor();
  const afterReopening = await queuePane.evaluate(element => element.scrollTop);
  assert.ok(Math.abs(afterReopening - beforeClosing) <= 1, 'Closing and reopening the drawer keeps its position');
  assert.equal(await page.locator('.desk-content').evaluate(element => element.scrollTop), behindDrawer, 'The content stays put behind the drawer');
  measurements.queueRestored390 = { beforeClosing, afterReopening, behindDrawer };
  await page.screenshot({ path: join(output, 'queue-restored-390.png') });
  await wheelTo(closeQueue, queuePane); await closeQueue.click(); await queuePane.waitFor({ state: 'hidden' });
  record('The narrow drawer preserves its position when closed with Escape and reopened, while the content behind it stays put');

  for (const width of [720, 959, 960, 1400]) {
    await page.setViewportSize({ width, height: 844 });
    measurements[`case${width}`] = await singleContentScroll();
    assert.equal(await queue.evaluate(element => getComputedStyle(element).overflowY), 'visible');
    if (width < 960) {
      await queuePane.waitFor({ state: 'hidden' });
      await queueToggle.click();
      await page.getByRole('dialog', { name: 'Tasks', exact: true }).waitFor();
      assert.deepEqual((await metrics()).scrollOwners, ['.desk-queue-column']);
      await wheelTo(closeQueue, queuePane); await closeQueue.click(); await queuePane.waitFor({ state: 'hidden' });
    } else {
      await queuePane.waitFor();
      assert.equal(await queueToggle.isVisible(), false);
      await wheelTo(option);
      measurements[`wheelQueue${width}`] = await wheelMovesContent(queuePane);
      measurements[`wheelCase${width}`] = await wheelMovesContent(page.locator('.desk-case-column'));
    }
    await noOverflow(); await page.screenshot({ path: join(output, `selected-case-${width}.png`) });
  }
  record('Below 960px Tasks is a drawer; at 960px and 1400px wheels over both queue and case move the same .desk-content');

  // The new shared content owner, rather than the transient drawer, keeps the navigation position.
  // A short window guarantees the shared region overflows, so a saved position can be nonzero.
  await page.setViewportSize({ width: 1400, height: 520 });
  const hideReminders = queuePane.getByRole('button', { name: 'Hide reminders', exact: true });
  await wheelTo(hideReminders); await hideReminders.click();
  const filters = queuePane.locator('.desk-queue-filters > summary');
  await wheelTo(filters); await filters.click();
  await wheelTo(option);
  await wheelMovesContent(queuePane);
  const beforeLeaving = await page.locator('.desk-content').evaluate(element => element.scrollTop);
  assert.ok(beforeLeaving > 0, 'A nonzero content position is saved');
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Desk', exact: true }).click();
  await caseView.getByRole('heading', { name: property.address, exact: true }).waitFor();
  await page.waitForFunction(expected => {
    const element = document.querySelector('.desk-content');
    return element && Math.abs(element.scrollTop - expected) <= 1;
  }, beforeLeaving, { timeout: 5_000 });
  measurements.contentRestored1400 = { beforeLeaving, afterReturning: (await singleContentScroll()).content.scrollTop };
  record('Schedule → Desk restores the selected case and the shared content scroll position');
  await page.setViewportSize({ width: 390, height: 844 });

  // Properties and batch work replace Tasks inside the same content container.
  const more = page.locator('.pm-desk-header').locator('summary').filter({ hasText: /^More$/ });
  const openMore = async () => {
    if (!await more.evaluate(element => element.parentElement.open)) await more.click();
    await page.getByRole('group', { name: 'More Desk tools', exact: true }).waitFor();
  };
  await openMore(); await page.getByRole('button', { name: 'Properties and imports', exact: true }).click();
  await page.getByRole('heading', { name: 'Properties', exact: true }).waitFor();
  await page.locator('.desk-content .desk-property-book').waitFor();
  assert.equal(await page.locator('.desk-empty-canvas').count(), 0);
  await openMore(); await page.getByRole('button', { name: 'Prepare several properties', exact: true }).click();
  await page.locator('.desk-content').getByRole('region', { name: 'Batch workspace', exact: true }).waitFor();
  await header.getByRole('navigation', { name: 'Desk workspace', exact: true }).getByRole('button', { name: /^Tasks\s*\d*$/, pressed: false }).waitFor();
  assert.equal(await page.locator('.desk-empty-canvas').count(), 0);
  await noOverflow();
  record('Properties and batch modes open from More inside .desk-content with the Tasks tab as the way back');
  assert.deepEqual(errors, []); assert.deepEqual(deniedOrigins, []);
  record('No horizontal overflow, renderer errors or off-origin browser requests in the exercised flows');
} catch (cause) {
  failure = cause instanceof Error ? cause.stack : String(cause);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  writeFileSync(join(output, 'failure.log'), `${failure}\n\n${logs}`); console.error(failure);
} finally {
  await browser?.close(); await vite?.close();
  if (child?.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 4_000);
    try { await childClosed; } finally { clearTimeout(force); }
  }
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), layer: 'source-rendered-local',
    passed: !failure, node: process.version, checks, measurements, errors, deniedOrigins, failure: failure ?? null,
    cleanup: { serviceExited: !child || child.exitCode !== null || child.signalCode !== null, scratchRemoved: !existsSync(scratch) },
    sources: Object.fromEntries(['src/components/DeskPage.tsx', 'src/desk.css', 'scripts/qa-desk-narrow-empty.mjs'].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
    limits: ['Fictional disposable sample only; no customer data, account linking, provider, model, worker or portal actions.',
      'Real source Vite renderer and loopback Node service in headless Chrome on this host; not a packaged app, native Windows or customer acceptance.',
      '390x844 narrow empty and selected-case flows plus 720/959/960/1400x844 layout boundaries; not an exhaustive device or accessibility audit.',
      'Cross-navigation scroll restoration covers .desk-content; the transient Tasks drawer has no saved cross-navigation scroll contract.'],
  }, null, 2));
}
if (failure) process.exitCode = 1;
