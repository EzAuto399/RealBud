// Real local API + built React UI, fictional bank bytes only. No bank/REI login,
// provider call, payment or customer file. Requires Node 24 and Playwright.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.QA_OUTPUT || join(root, 'outputs/bank-bytes-2026-09-21'));
const ui = resolve(process.env.REALBUD_UI_DIR || join(root, 'dist'));
const scratch = await mkdtemp(join(tmpdir(), 'RealBud bank bytes QA '));
const data = join(scratch, 'data');
const checks = [], errors = [];
let child, closed, browser, page, logs = '', failure;
const record = text => { checks.push(text); console.log(`PASS ${text}`); };
try {
  await mkdir(data); await mkdir(out, { recursive: true });
  await writeFile(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }));
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, 'server/index.ts')], { cwd: root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port }), OMB_STATIC_DIR: ui },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-16000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode) throw new Error('Fixture service exited before startup');
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null);
    if (health?.pid === child.pid) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Fixture startup');
  assert.equal((await fetch(base + '/api/bank-reference')).status, 401);
  const token = (await (await fetch(base + '/api/session')).json()).token;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'x-realbud-session': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`); return value;
  };
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#/schedule');
  await page.getByText('Prepare a new export', { exact: true }).click();
  const csv = '\uFEFFDate,Amount,Narrative,Reference,Extra\r\n2026-09-10,500.00,"FICTIONAL RENT café 🏡\n""quoted""","P101",unchanged\r\n2026-09-10,-20.00,FICTIONAL FEE,"",unchanged\n';
  const bytes = Buffer.from(csv), filename = 'Fictional bank café.csv';
  await page.getByLabel('Bank CSV', { exact: true }).setInputFiles({ name: filename, mimeType: 'text/csv', buffer: bytes });
  const columns = { date: 'Date', amount: 'Amount', narrative: 'Narrative', reference: 'Reference' };
  for (const [key, value] of Object.entries(columns)) await page.getByLabel(`${key} column`, { exact: true }).fill(value);
  await page.getByLabel('Date format', { exact: true }).selectOption('YYYY-MM-DD');
  await page.getByLabel('Property reference directory', { exact: true }).fill('Fictional Unit 1 | 00127 | FICTIONAL RENT');
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await page.getByText(/Original: Fictional bank café.csv/).waitFor();
  const download = async label => {
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: label, exact: true }).click();
    const file = await event; return { filename: file.suggestedFilename(), bytes: await readFile(await file.path()) };
  };
  const original = await download('Download original');
  assert.equal(original.filename, filename); assert.deepEqual(original.bytes, bytes);
  record('Actual upload and original download preserve BOM, Unicode, quoted multiline values, newlines and filename');
  await page.getByLabel('Your decision', { exact: true }).nth(0).selectOption('Fictional Unit 1');
  await page.getByLabel('Your decision', { exact: true }).nth(1).selectOption('keep');
  await page.getByLabel('Review reason', { exact: true }).nth(0).fill('Fictional approved property directory');
  await page.getByLabel('Review reason', { exact: true }).nth(1).fill('Fee retained unchanged');
  await page.getByRole('button', { name: 'Save reviewed copy', exact: true }).click();
  await page.getByRole('button', { name: 'Download reviewed REI copy', exact: true }).waitFor();
  const result = await download('Download reviewed REI copy');
  assert.deepEqual(result.bytes, Buffer.from(csv.replace('"P101"', '"00127"')));
  record('Actual reviewed binary download changes only the approved reference and retains its quoting');
  const id = (await request('/api/bank-reference')).batches[0].id;
  await page.reload(); await page.getByLabel('Saved reviews', { exact: true }).selectOption(id);
  await page.getByRole('button', { name: 'Download reviewed REI copy', exact: true }).waitFor();
  assert.deepEqual((await download('Download original')).bytes, bytes);
  record('Reloaded saved review retains the original byte artifact');
  const bankPanel = page.locator('section[aria-labelledby="bank-review-title"]');
  await bankPanel.screenshot({ path: join(out, 'bank-reviewed-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await bankPanel.screenshot({ path: join(out, 'bank-reviewed-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile has no horizontal page overflow');
  await page.setViewportSize({ width: 1365, height: 1000 });
  const details = page.getByText('Prepare a new export', { exact: true });
  await details.click();
  await page.getByLabel('Bank CSV', { exact: true }).setInputFiles({ name: 'unsupported-utf16.csv', mimeType: 'text/csv', buffer: Buffer.from([0xff, 0xfe, 0x44, 0]) });
  await page.getByRole('alert').filter({ hasText: 'UTF-8' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Prepare review', exact: true }).isDisabled(), true);
  assert.equal((await request('/api/bank-reference')).total, 1);
  record('Unsupported encoding clears the pending upload and leaves saved reviews unchanged');
  const legacy = await request('/api/bank-reference', 'POST', { csv: csv.replace('FICTIONAL RENT', 'FICTIONAL LEGACY'), columns, dateFormat: 'YYYY-MM-DD', rules: [] });
  await page.reload(); await page.getByLabel('Saved reviews', { exact: true }).selectOption(legacy.id);
  await page.getByRole('note').filter({ hasText: 'older review saved text only' }).waitFor();
  await page.getByRole('button', { name: 'Download saved text', exact: true }).waitFor();
  record('Legacy text reviews remain available with an explicit original-byte limitation');

  const rules = [{ propertyId: 'Fictional Unit 1', reference: '00127', aliases: ['FICTIONAL RENT'] }];
  const seed = async number => {
    const text = `Date,Amount,Narrative,Reference\r\n2026-09-10,100.00,FICTIONAL RENT ${number},OLD\r\n`;
    return request('/api/bank-reference', 'POST', { source: { filename: `Fictional history ${number}.csv`, bytesBase64: Buffer.from(text).toString('base64') }, columns, dateFormat: 'YYYY-MM-DD', rules });
  };
  const seeds = [];
  for (let number = 1; number <= 24; number++) seeds.push(await seed(number));
  const first = await request('/api/bank-reference?limit=20');
  assert.equal(first.version, 2); assert.equal(first.total, 26); assert.equal(first.batches.length, 20); assert.ok(first.nextCursor);
  await page.reload();
  const history = page.getByRole('region', { name: 'Saved bank review history', exact: true });
  await history.getByText('20 of 26 saved reviews loaded.', { exact: false }).waitFor();
  const inserted = await seed('after-first-page');
  const next = await request(`/api/bank-reference?limit=20&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(next.total, 26); assert.equal(next.nextCursor, null);
  assert.equal(new Set([...first.batches, ...next.batches].map(row => row.id)).size, 26);
  assert.ok(![...first.batches, ...next.batches].some(row => row.id === inserted.id));
  await history.getByRole('button', { name: 'Load more bank reviews', exact: true }).click();
  await history.getByText('26 of 26 saved reviews loaded.', { exact: false }).waitFor();
  assert.equal(await history.locator(`option[value="${inserted.id}"]`).count(), 0);
  record('Real HTTP and UI continuation retain the captured total and exclude an interleaved new import');

  await history.getByLabel('Saved reviews', { exact: true }).selectOption(id);
  await page.getByRole('button', { name: 'Download reviewed REI copy', exact: true }).waitFor();
  assert.deepEqual((await download('Download original')).bytes, bytes);
  assert.deepEqual((await download('Download reviewed REI copy')).bytes, Buffer.from(csv.replace('"P101"', '"00127"')));
  await history.getByRole('button', { name: 'Refresh bank history', exact: true }).click();
  await history.getByText('20 of 27 saved reviews loaded.', { exact: false }).waitFor();
  assert.equal(await history.getByLabel('Saved reviews', { exact: true }).inputValue(), id);
  assert.equal(await history.locator(`option[value="${id}"]`).textContent(), 'Currently open review · outside loaded history');
  assert.deepEqual((await download('Download original')).bytes, bytes);
  record('An older exact review and both byte-verified downloads remain open after refreshing away its history page');

  const draftId = seeds.at(-1).id;
  await history.getByLabel('Saved reviews', { exact: true }).selectOption(draftId);
  await page.getByText(/Original: Fictional history 24.csv/).waitFor();
  await page.getByLabel('Your decision', { exact: true }).selectOption('Fictional Unit 1');
  const draftReason = 'Human review in progress, retained across history failures';
  await page.getByLabel('Review reason', { exact: true }).fill(draftReason);
  await page.getByRole('region', { name: 'Unsaved bank decisions', exact: true }).waitFor();
  assert.equal(await history.getByLabel('Saved reviews', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Reload saved review', exact: true }).isDisabled(), true);
  await page.getByText('Prepare a new export', { exact: true }).click();
  assert.equal(await page.getByLabel('Bank CSV', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Prepare review', exact: true }).isDisabled(), true);
  await page.getByText('Prepare a new export', { exact: true }).click();
  await history.getByRole('button', { name: 'Load more bank reviews', exact: true }).click();
  await history.getByText('27 of 27 saved reviews loaded.', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Review reason', { exact: true }).inputValue(), draftReason);
  assert.equal(await page.getByLabel('Your decision', { exact: true }).inputValue(), 'Fictional Unit 1');
  await history.getByRole('button', { name: 'Refresh bank history', exact: true }).click();
  await history.getByText('20 of 27 saved reviews loaded.', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Review reason', { exact: true }).inputValue(), draftReason);
  record('History paging and refresh retain partial human decisions while switching, reloading and importing are disabled');

  // Deliberate browser-response failure injection; the real server and encrypted
  // saved record stay intact. This proves UI retention, not a server outage.
  const historyMatcher = url => url.origin === base && url.pathname === '/api/bank-reference';
  const failHistory = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fictional history response unavailable' }) });
  await page.route(historyMatcher, failHistory);
  await history.getByRole('button', { name: 'Refresh bank history', exact: true }).click();
  await history.getByRole('alert').filter({ hasText: 'Previously loaded history' }).waitFor();
  assert.equal(await page.getByLabel('Review reason', { exact: true }).inputValue(), draftReason);
  assert.equal(await history.getByLabel('Saved reviews', { exact: true }).inputValue(), draftId);
  assert.match(await history.textContent(), /20 of 27 saved reviews loaded/);
  assert.equal((await request(`/api/bank-reference/${draftId}`)).value.result, undefined);
  await page.unroute(historyMatcher, failHistory);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Review unsaved decisions discard', exact: true }).click();
  await page.getByRole('group', { name: 'Discard unsaved bank decisions', exact: true }).screenshot({ path: join(out, 'bank-unsaved-mobile.png') });
  await bankPanel.screenshot({ path: join(out, 'bank-draft-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile draft controls do not overflow');
  await page.getByRole('button', { name: 'Keep editing this review', exact: true }).click();
  assert.equal(await page.getByLabel('Review reason', { exact: true }).inputValue(), draftReason);
  record('Injected history-response failure retains loaded rows and unsaved decisions; mobile discard cancellation retains the draft');
  await page.getByRole('button', { name: 'Review unsaved decisions discard', exact: true }).click();
  await page.getByRole('button', { name: 'Discard unsaved bank decisions', exact: true }).click();
  assert.equal(await page.getByLabel('Review reason', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('Your decision', { exact: true }).inputValue(), '');
  assert.equal(await history.getByLabel('Saved reviews', { exact: true }).isEnabled(), true);
  assert.equal((await request(`/api/bank-reference/${draftId}`)).value.result, undefined);
  assert.equal((await request('/api/bank-reference')).total, 27);
  await page.setViewportSize({ width: 1365, height: 1000 });
  await history.getByRole('button', { name: 'Refresh bank history', exact: true }).click();
  await history.getByText('20 of 27 saved reviews loaded.', { exact: false }).waitFor();
  await history.screenshot({ path: join(out, 'bank-history-desktop.png') });
  record('Explicit discard clears only the unsaved form; original saved review and all 27 imports remain unchanged');

  const failedId = seeds.at(-2).id;
  const openMatcher = url => url.origin === base && url.pathname === `/api/bank-reference/${failedId}`;
  const failOpen = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fictional selected review unavailable' }) });
  await page.route(openMatcher, failOpen);
  await history.getByLabel('Saved reviews', { exact: true }).selectOption(failedId);
  await bankPanel.getByRole('alert').filter({ hasText: 'Fictional selected review unavailable' }).waitFor();
  assert.equal(await history.getByLabel('Saved reviews', { exact: true }).inputValue(), draftId);
  await page.getByText(/Original: Fictional history 24.csv/).waitFor();
  await page.unroute(openMatcher, failOpen);
  record('A failed exact-review open leaves the previously selected review intact');

  // Delay the actual persisted settings reply until the person has edited the
  // new-file mapping. No fabricated settings or financial data are introduced.
  let releaseSettings, settingsServed;
  const settingsGate = new Promise(resolve => { releaseSettings = resolve; });
  const settingsDone = new Promise(resolve => { settingsServed = resolve; });
  const settingsMatcher = url => url.origin === base && url.pathname === '/api/bank-reference/settings';
  const delaySettings = async route => {
    const response = await route.fetch();
    await settingsGate;
    await route.fulfill({ response });
    settingsServed();
  };
  await page.route(settingsMatcher, delaySettings);
  await page.reload();
  await page.getByText('Prepare a new export', { exact: true }).click();
  await page.getByLabel('Date format', { exact: true }).selectOption('DD/MM/YYYY');
  await page.getByLabel('date column', { exact: true }).fill('Human draft date header');
  await page.getByLabel('Property reference directory', { exact: true }).fill('Human directory edit in progress');
  releaseSettings();
  let settingsTimeout;
  try { await Promise.race([settingsDone, new Promise((_, reject) => { settingsTimeout = setTimeout(() => reject(new Error('Delayed settings response did not complete')), 10_000); })]); }
  finally { clearTimeout(settingsTimeout); }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByLabel('Date format', { exact: true }).inputValue(), 'DD/MM/YYYY');
  assert.equal(await page.getByLabel('date column', { exact: true }).inputValue(), 'Human draft date header');
  assert.equal(await page.getByLabel('Property reference directory', { exact: true }).inputValue(), 'Human directory edit in progress');
  await page.unroute(settingsMatcher, delaySettings);
  record('A delayed real saved-settings response cannot overwrite mapping, date format or directory already being edited');
  assert.deepEqual(errors, []); record('No browser JavaScript errors');
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  if (child && child.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM'); const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
    await closed.catch(() => {}); clearTimeout(forced);
  }
  await rm(scratch, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, checks, failure, ui,
    actual: ['built React UI', 'local HTTP API', 'encrypted saved review', 'browser binary downloads'],
    synthetic: ['bank CSV and property mapping', 'browser-only 503 history and detail response injections', 'delayed real settings response'], notProven: ['customer bank format', 'REI import acceptance', 'native installed Windows'],
    ...(failure ? { diagnostic: logs } : {}) }, null, 2) + '\n');
  if (failure) { console.error(failure); process.exitCode = 1; }
}
