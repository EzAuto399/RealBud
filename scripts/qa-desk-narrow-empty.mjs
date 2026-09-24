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
async function wheelTo(locator, area = page.locator('.desk-workspace')) {
  await locator.waitFor({ state: 'attached' });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const target = await locator.boundingBox(), region = await area.boundingBox();
    assert.ok(target && region, 'Target and scroll region have rendered bounds');
    const top = Math.max(0, region.y) + 3;
    const bottom = Math.min(page.viewportSize().height - 64, region.y + region.height) - 3;
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
    const header = main.querySelector('.pm-desk-header');
    return { width: innerWidth, main: box(main), header: box(header), canvas: box(main.querySelector('.pm-split-canvas')),
      headerMaxHeight: getComputedStyle(header).maxHeight, outerOverflow: getComputedStyle(main).overflowY,
      emptyCanvas: main.getAttribute('data-empty-canvas'), documentWidth: document.documentElement.scrollWidth };
  });
}
async function openOverview() {
  const show = page.getByRole('region', { name: 'This morning', exact: true }).getByRole('button', { name: 'Show addresses', exact: true });
  if (await show.count()) { await wheelTo(show); await show.click(); }
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
  token = (await (await fetch(base + '/api/session')).json()).token;
  vite = await createViteServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn',
    server: { host: '127.0.0.1', port: uiPort, strictPort: true, proxy: { '/api': { target: base, changeOrigin: true, ws: true } } },
  });
  await vite.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
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
  await page.locator('.desk-workspace[data-empty-canvas="true"]').waitFor();
  assert.equal((await request('/api/onboarding')).stage, 'complete');

  await openOverview();
  const setup = page.getByRole('region', { name: 'Workspace setup', exact: true });
  const expand = setup.getByRole('button', { name: /^Workspace setup · / });
  await wheelTo(expand); await expand.click();
  await wheelTo(setup);
  const setupAction = setup.getByRole('button', { name: 'Open Agency workflow setup', exact: true });
  const title = setup.getByText('Step 1 of 3: Your agency', { exact: true });
  await wheelTo(title); await wheelTo(setupAction);
  assert.ok(await fits(setupAction));
  measurements.empty390 = await metrics();
  assert.ok(measurements.empty390.main.scrollTop > 0, 'The whole empty desk scrolls');
  assert.equal(measurements.empty390.header.scrollTop, 0, 'Setup is not trapped in a separate header scroller');
  assert.ok(measurements.empty390.header.height > measurements.empty390.main.height / 2, 'The header is no longer capped at half the window');
  await noOverflow();
  await page.screenshot({ path: join(output, 'setup-390.png') });
  await setupAction.click();
  await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  await page.locator('#schedule-packs').waitFor();
  record('At 390px, wheel input reaches setup title and action in one outer scroll; clicking opens Agency workflow setup');

  await page.getByRole('button', { name: 'Desk', exact: true }).click();
  await page.locator('.desk-workspace[data-empty-canvas="true"]').waitFor();
  for (const width of [720, 1400]) {
    await page.setViewportSize({ width, height: 844 });
    const measured = await metrics(); measurements[`empty${width}`] = measured;
    assert.ok(measured.header.height <= measured.main.height * 0.48 + 2, `${width}px retains the original header cap`);
    assert.ok(measured.canvas.height >= measured.main.height * 0.5, `${width}px retains the case canvas split`);
    assert.equal(measured.main.scrollTop, 0);
    await noOverflow(); await page.screenshot({ path: join(output, `empty-${width}.png`) });
  }
  record('At 720px and 1400px, the empty Desk retains the original header/canvas split without overflow');

  await page.setViewportSize({ width: 390, height: 844 });
  const sample = page.locator('.desk-empty-canvas').getByRole('button', { name: 'Run sample morning', exact: true });
  await wheelTo(sample); await noOverflow();
  await page.screenshot({ path: join(output, 'sample-action-390.png') });
  const practiced = page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/practice' && response.request().method() === 'POST');
  await sample.click(); assert.equal((await practiced).status(), 200);
  const snapshot = await request('/api/desk');
  assert.ok(snapshot.lastRunAt !== null && snapshot.drafts.length > 0);
  await page.locator('.desk-case').waitFor();
  assert.equal(await page.locator('.desk-workspace').getAttribute('data-empty-canvas'), null);
  record('Wheel input reaches the sample action; its actual local practice request creates sample review cases');

  const queue = page.getByRole('listbox', { name: 'Case queue', exact: true });
  const queuePane = page.locator('.desk-queue-pane');
  await queue.waitFor();
  const draft = snapshot.drafts.find(row => row.status === 'pending'); assert.ok(draft);
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
  const edit = caseView.getByRole('button', { name: 'Edit wording', exact: true });
  await edit.waitFor();
  const caseBody = caseView.locator('div.overflow-y-auto').first();
  await wheelTo(edit, caseBody); await edit.click();
  const wording = caseView.getByRole('textbox', { name: 'Draft wording', exact: true });
  await wording.waitFor(); assert.equal(await wording.inputValue(), draft.body);
  const cancel = caseView.getByRole('button', { name: 'Cancel', exact: true });
  await wheelTo(cancel, caseBody); await cancel.click();
  await wording.waitFor({ state: 'hidden' });
  assert.equal((await request('/api/desk')).drafts.find(row => row.id === draft.id).body, draft.body);
  measurements.case390 = await metrics();
  assert.ok(measurements.case390.header.height <= measurements.case390.main.height * 0.48 + 2);
  assert.ok(measurements.case390.canvas.height >= measurements.case390.main.height * 0.5);
  await noOverflow(); await page.screenshot({ path: join(output, 'selected-case-390.png') });
  record('At 390px, wheel input reaches a queue row; clicking selects its actual case and opens/cancels review editing without changing wording');

  const header = page.locator('.pm-desk-header');
  const queueToggle = header.getByRole('button', { name: /^Queue · / });
  await wheelTo(queueToggle, header); await queueToggle.click(); await queuePane.waitFor();
  const closeQueue = queuePane.getByRole('button', { name: 'Close queue', exact: true });
  await wheelTo(closeQueue, queuePane); await closeQueue.click(); await queuePane.waitFor({ state: 'hidden' });
  record('The narrow queue can be reopened and closed using its visible Close control');

  await queueToggle.click(); await queuePane.waitFor();
  await wheelTo(option, queuePane);
  const queueBox = await queuePane.boundingBox(); assert.ok(queueBox);
  await page.mouse.move(queueBox.x + queueBox.width / 2, queueBox.y + queueBox.height / 2);
  await page.mouse.wheel(0, 70); await wait(100);
  const beforeLeaving = await queuePane.evaluate(element => element.scrollTop);
  assert.ok(beforeLeaving > 0, 'A nonzero narrow queue position is saved');
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Desk', exact: true }).click();
  await queuePane.waitFor();
  await page.waitForFunction(expected => {
    const element = document.querySelector('.desk-queue-pane');
    return element && Math.abs(element.scrollTop - expected) <= 1;
  }, beforeLeaving, { timeout: 5_000 });
  const afterReturning = await queuePane.evaluate(element => element.scrollTop);
  const hideQueue = header.getByRole('button', { name: 'Hide queue', exact: true });
  await wheelTo(hideQueue, header); await hideQueue.click(); await queuePane.waitFor({ state: 'hidden' });
  await queueToggle.click(); await queuePane.waitFor();
  const afterReopening = await queuePane.evaluate(element => element.scrollTop);
  assert.ok(Math.abs(afterReopening - beforeLeaving) <= 1, 'Closing and reopening the drawer keeps its position');
  measurements.queueRestored390 = { beforeLeaving, afterReturning, afterReopening };
  await page.screenshot({ path: join(output, 'queue-restored-390.png') });
  await wheelTo(closeQueue, queuePane); await closeQueue.click(); await queuePane.waitFor({ state: 'hidden' });
  record('The narrow queue preserves its scroll position across Schedule → Desk navigation and closing/reopening the drawer');

  for (const width of [720, 1400]) {
    await page.setViewportSize({ width, height: 844 });
    const measured = await metrics(); measurements[`case${width}`] = measured;
    assert.equal(measured.emptyCanvas, null);
    assert.ok(measured.header.height <= measured.main.height * 0.48 + 2);
    assert.ok(measured.canvas.height >= measured.main.height * 0.5);
    assert.equal(await queuePane.evaluate(element => getComputedStyle(element).overflowY), 'visible');
    // At 720px the closed drawer stays hidden; inspect its CSS without opening it.
    assert.equal(await queuePane.getByRole('listbox', { name: 'Case queue', exact: true, includeHidden: true })
      .evaluate(element => getComputedStyle(element).overflowY), 'auto');
    await noOverflow(); await page.screenshot({ path: join(output, `selected-case-${width}.png`) });
  }
  record('At 720px and 1400px, selected cases retain their header/canvas split and the existing separate queue-row scroller');
  await page.setViewportSize({ width: 390, height: 844 });

  // These modes must never receive the empty-case layout override.
  const more = page.locator('.pm-desk-header').locator('summary').filter({ hasText: /^More$/ });
  const openMore = async () => {
    await wheelTo(more, header);
    if (!await page.locator('details.desk-more').evaluate(element => element.open)) await more.click();
    await page.getByRole('group', { name: 'More Desk tools', exact: true }).waitFor();
  };
  await openMore(); await page.getByRole('button', { name: 'Book · import & addresses', exact: true }).click();
  await page.getByRole('heading', { name: 'Properties', exact: true }).waitFor();
  assert.equal(await page.locator('.desk-workspace').getAttribute('data-empty-canvas'), null);
  await openMore(); await page.getByRole('button', { name: 'Batch prepare', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Needs you', exact: true }).waitFor();
  assert.equal(await page.locator('.desk-workspace').getAttribute('data-empty-canvas'), null);
  await noOverflow();
  record('Book and Batch modes keep their existing layout and never receive the empty-case override');
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
      '390x844 narrow empty and selected-case flows plus 720/1400x844 layout boundaries; not an exhaustive device or accessibility audit.'],
  }, null, 2));
}
if (failure) process.exitCode = 1;
