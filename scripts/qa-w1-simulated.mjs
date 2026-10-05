// W1 simulated end to end: FICTIONAL bank feed → reviewed import file → REI
// preview → the person processes → readback → coverage. Real source service
// and Vite renderer in headless Chrome; a local FAKE Redbark (live REST shapes:
// signed minor units, bare local dates, UTC datetimes, references, paging by an
// opaque token behind a foreign-host next_page_url) behind the lab bank
// provider; the FICTIONAL REI-style portal (server/testing/fictional-rei-portal.ts)
// behind the real broker and recipe runner. No bank, no REI, no customer data.
// Shaped after a read-only look at live REI (2 Oct 2026): the REI account is
// its top-bar business code (no reicid in REI's addresses after sign-in) and
// the import file goes in as File Format "ANZ(csv file)" (the default).
//
// Node 24+, PLAYWRIGHT_MODULE, optional CHROME_EXECUTABLE and QA_OUTPUT.
//   node scripts/qa-w1-simulated.mjs
//   node scripts/qa-w1-simulated.mjs --live-redbark   (blocked, see below)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// TODO(W1 live): the read-only live mode needs the Redbark MCP connection
// (OAuth; another packet). Once `listBankAccounts`/`listBankTransactions` are
// connected, call GET /api/w1/accounts and GET /api/bank-source/redbark/transactions
// against a disposable data dir and print only counts, the date span, whether
// every row is in range and truncation. It must never call /api/w1/runs/*.
if (process.argv.includes('--live-redbark')) {
  console.log('SKIP --live-redbark: RealBud now reaches Redbark through its MCP connection (OAuth), which is not wired yet. Nothing was read and no key was used. The owner verified the live MCP read separately.');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { serviceSmokeEnv } = await import(join(root, 'scripts/service-smoke-env.mjs'));
const { completeFictionalOnboarding } = await import(join(root, 'scripts/qa-onboarding.mjs'));
const { readSessionToken, primeBrowserSession } = await import(join(root, 'scripts/local-session.mjs'));
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const { createServer: createViteServer } = await import('vite');

const localDate = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const TODAY = localDate();
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const output = resolve(process.env.QA_OUTPUT ?? join(root, `outputs/w1-sim-${TODAY}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-w1-sim-'));
const data = join(scratch, 'data'); mkdirSync(data, { mode: 0o700 });
const checks = [], errors = [], deniedOrigins = [], scenarios = {}, shots = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
let child, childClosed, vite, browser, page, failure, logs = '', base, uiBase, token;

// ── FAKE Redbark (fictional ANZ-like accounts; synthetic key) ──────────────
const FICTIONAL_KEY = 'rbk_live_fictional_w1_simulation_0000';
const TRUST = 'acct_FictionalAnzTrust1', OPS = 'acct_FictionalAnzOps01', CONNECTION = 'conn_FictionalAnz0001';
const account = (id, name, last4) => ({ id, object: 'account_item', connection: CONNECTION, provider: 'fiskil', category: 'banking', name, type: 'transaction',
  institution: { id: 'inst_fk_anz_fictional', name: 'ANZ (fictional)', logo: null }, account_number: `xxxx${last4}`, currency: 'aud', status: 'available',
  last_updated_at: `${TODAY}T00:30:00.000Z`, livemode: true, created: '2026-08-21T09:30:00.000Z', updated: `${TODAY}T00:30:00.000Z` });
const ACCOUNTS = [account(TRUST, 'Fictional Trust Account', '4321'), account(OPS, 'Fictional Operating Account', '8765')];
/** A local date's row, booked at 17:18Z the evening before: the UTC instant falls on the previous calendar day. */
const txn = (id, acct, date, cents, reference, status = 'posted') => ({ id, object: 'transaction', account: acct, status, date, datetime: `${addDays(date, -1)}T17:18:00.000Z`,
  post_date: status === 'posted' ? date : null, post_datetime: status === 'posted' ? `${addDays(date, -1)}T17:20:00.000Z` : null, value_date: null, value_datetime: null,
  description: `FICTIONAL PAYMENT ${reference}`, reference, extended_description: null, amount: { amount: cents, currency: 'aud' }, direction: cents < 0 ? 'debit' : 'credit',
  provider_category: cents < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN', category: null, merchant_name: null, merchant_category_code: null, livemode: true });
/** The reviewer holds the bank fee (a debit) whenever it is offered. */
const holdFee = row => row.reference === 'FICTIONAL FEE' ? 'hold' : null;
const ledger = [
  txn('txn_fk_anz-0001', TRUST, addDays(TODAY, -2), 54000, 'FT-BRAVO'),
  txn('txn_fk_anz-0002', TRUST, addDays(TODAY, -1), 36000, 'FT-CHARLIE'),
  txn('txn_fk_anz-0003', TRUST, TODAY, 66000, 'FT-ECHO'),
  txn('txn_fk_anz-0004', TRUST, TODAY, 12000, 'FT-PENDING', 'pending'),
  ...[-12, -10, -9, -7, -5].map((offset, index) => txn(`txn_fk_anz-01${index}`, TRUST, addDays(TODAY, offset), 50000 + index * 100, 'FT-GOLF')),
  txn('txn_fk_anz-0901', OPS, addDays(TODAY, -1), -2500, 'FICTIONAL FEE'),
];
const redbarkLog = [];
const PAGE = 2;
const fakeRedbark = createServer((req, res) => {
  const url = new URL(req.url, 'http://fake'), send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${FICTIONAL_KEY}` || !req.headers['redbark-version']) return send(401, { error: { type: 'authentication_error', request_id: 'req_fictional401' } });
  const token = url.searchParams.get('page');
  redbarkLog.push({ path: url.pathname, page: Boolean(token) });
  const query = token ? JSON.parse(Buffer.from(token, 'base64url').toString()) : { ...Object.fromEntries(url.searchParams), offset: 0 };
  const list = (items, kind) => {
    const slice = items.slice(query.offset, query.offset + PAGE);
    const more = query.offset + PAGE < items.length;
    // A foreign host, as seen live: only the opaque page token may be reused against the configured base.
    const next = more ? `https://api.redbark.internal/v2/${kind}?page=${Buffer.from(JSON.stringify({ ...query, offset: query.offset + PAGE })).toString('base64url')}` : null;
    send(200, { object: 'list', data: slice, next_page_url: next, previous_page_url: null });
  };
  if (url.pathname === '/v2/accounts') return list(ACCOUNTS, 'accounts');
  if (url.pathname === '/v2/transactions') {
    const rows = ledger.filter(row => row.account === query.account && row.date >= query.from && row.date <= query.to && (query.include_pending !== 'false' || row.status === 'posted'))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    return list(rows, 'transactions');
  }
  send(404, { error: { type: 'invalid_request_error', request_id: 'req_fictional404' } });
});

// ── helpers ─────────────────────────────────────────────────────────────
const port = async () => { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const request = async (path, method = 'GET', body, expected = 200) => {
  const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await res.json(); assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
};
const lab = action => request('/api/w1/lab', 'POST', { action });
/** Waits until Bud stops working or asks the person. */
async function settle() {
  for (let i = 0; i < 600; i++) { const now = await request('/api/w1/status'); if (!now.working || now.ask) return now; await wait(50); }
  throw new Error('The bank import did not settle.');
}
/** Answers every ask with Allow (the simulated person); returns the tools asked about. */
async function allowAll() {
  const tools = []; let now = await settle();
  while (now.ask) { tools.push(now.ask.tool); await request(`/api/w1/runs/${now.run.id}/answer`, 'POST', { requestId: now.ask.requestId, allowed: true }); now = await settle(); }
  return { now, tools };
}
const act = async (action, extra = {}) => { const now = await settle(); return request(`/api/w1/runs/${now.run.id}/${action}`, 'POST', { expectedRevision: now.run.revision, ...extra }); };
/** Reviews a pulled batch through the bank review API: every row imported to its directory match, unless `decide` holds or excludes it. */
async function reviewByApi(batchId, decide = () => null) {
  const saved = await request(`/api/bank-reference/${batchId}`);
  const decisions = saved.value.batch.rows.map(row => {
    const other = decide(row);
    if (other) return { rowId: row.id, action: other, reason: 'Fictional reviewer decision' };
    assert.equal(row.candidates.length, 1, `one directory match for ${row.narrative}`); return { rowId: row.id, action: 'assign', propertyId: row.candidates[0], reason: 'Fictional directory match checked' };
  });
  await request(`/api/bank-reference/${batchId}/review`, 'POST', { revision: saved.revision, decisions });
}
const strip = () => page.getByRole('region', { name: 'Bank import', exact: true });
async function noOverflow() { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll'); }
/** 1440 and 390 screenshots of a region, with the 390 overflow check. */
async function capture(name, locator) {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await locator.scrollIntoViewIfNeeded();
    if (width === 390) await noOverflow();
    const file = `${name}-${width}.png`; await page.screenshot({ path: join(output, file), animations: 'disabled' }); shots.push(file);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function openBankJob() {
  await page.goto(`${uiBase}/#/desk`);
  await page.getByRole('button', { name: /^Schedule\b/ }).first().click();
  await page.getByRole('button', { name: 'Open job: Bank reference review', exact: true }).click();
  await strip().or(page.getByRole('region', { name: 'Set up bank imports', exact: true })).first().waitFor();
}
const stripSays = text => strip().getByText(text, { exact: false }).first().waitFor({ timeout: 30_000 });
async function allowInStrip() {
  const tools = [];
  for (let i = 0; i < 20; i++) {
    const now = await settle();
    if (!now.ask) return tools;
    tools.push(now.ask.tool);
    await strip().getByRole('button', { name: 'Allow', exact: true }).click();
    await wait(200);
  }
  throw new Error('Too many asks.');
}

try {
  fakeRedbark.listen(0, '127.0.0.1'); await once(fakeRedbark, 'listening');
  const redbarkBase = `http://127.0.0.1:${fakeRedbark.address().port}`;
  const servicePort = await port(), uiPort = await port();
  base = `http://127.0.0.1:${servicePort}`; uiBase = `http://127.0.0.1:${uiPort}`;
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root, env: {
    ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port: servicePort }),
    REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', REALBUD_TEST_W1_FICTIONAL_REI: '1', REALBUD_TEST_REDBARK_BASE: redbarkBase,
    OMB_UI_PORT: String(uiPort), OMB_STATIC_DIR: join(root, 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  childClosed = new Promise((r, reject) => { child.once('close', r); child.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-24_000); });
  let ready = false;
  for (let i = 0; i < 150 && child.exitCode === null; i++) { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null))?.pid === child.pid) { ready = true; break; } await wait(100); }
  assert.ok(ready, 'Disposable source service starts');
  token = await readSessionToken(data);
  assert.equal((await fetch(base + '/api/w1/status')).status, 401);
  pass('W1 routes need the session');
  await completeFictionalOnboarding(request);
  // The office's property directory, with each property's REI tenant (a fictional earlier review).
  const rules = [['FP-02', 'FT-BRAVO', 'Fictional Tenant Bravo'], ['FP-03', 'FT-CHARLIE', 'Fictional Tenant Charlie'], ['FP-05', 'FT-ECHO', 'Fictional Tenant Echo'],
    ['FP-06', 'FT-GOLF', 'Fictional Tenant Golf'], ['FP-07', 'FT-HOTEL', 'Fictional Tenant Hotel']].map(([propertyId, reference, tenant]) => ({ propertyId, reference, aliases: [reference], tenant }));
  await request('/api/bank-reference', 'POST', { csv: `Date,Amount,Narrative,Reference\n${addDays(TODAY, -60)},1.00,FICTIONAL SEED,\n`, columns: { date: 'Date', amount: 'Amount', narrative: 'Narrative', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules });

  vite = await createViteServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn',
    server: { host: '127.0.0.1', port: uiPort, strictPort: true, proxy: { '/api': { target: base, changeOrigin: true, ws: true } } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, uiBase, token);
  await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === uiBase) return route.continue(); deniedOrigins.push(origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));

  // ── 1. Happy path, through the UI ──
  // The REI account is its top-bar business code with no reicid, and the File Format defaults to ANZ(csv file).
  // Saved through the API: the setup form still requires a reicid (src/components/schedule/BankReferenceReview.tsx).
  const saved = await request('/api/w1/settings', 'PUT', { account: TRUST, reiBusiness: 'FICT1', expectedRevision: 0 });
  assert.deepEqual([saved.settings.rei, saved.settings.bankFormat], [{ marker: 'FICT1' }, 'ANZ(csv file)']);
  await openBankJob();
  await strip().getByRole('button', { name: 'Start bank import', exact: true }).click();
  await stripSays('Review the pulled transactions');
  let status = await settle();
  assert.deepEqual(status.run.fetch.transactionIds.slice().sort(), ['txn_fk_anz-0001', 'txn_fk_anz-0002', 'txn_fk_anz-0003']);
  assert.deepEqual([status.run.fetch.from, status.run.fetch.to], [addDays(TODAY, -2), TODAY]);
  await strip().getByRole('button', { name: 'Open pulled transactions', exact: true }).click();
  const rowCards = page.locator('article.border').filter({ has: page.getByLabel('Your decision', { exact: true }) });
  await rowCards.first().waitFor();
  const rowCount = await rowCards.count();
  assert.equal(rowCount, 3, 'pending row left out of the review');
  for (let i = 0; i < rowCount; i++) {
    const card = rowCards.nth(i), ref = /FT-[A-Z]+/.exec(await card.innerText())[0], rule = rules.find(item => item.reference === ref);
    await card.getByLabel('Your decision', { exact: true }).selectOption(rule.propertyId);
    await card.getByLabel('Review reason', { exact: true }).fill('Fictional directory match checked');
  }
  await page.getByRole('button', { name: 'Save reviewed copy', exact: true }).click();
  await strip().getByRole('button', { name: 'Continue', exact: true }).click();
  await stripSays('Waiting for you to sign in to REI');
  await capture('run-sign-in', strip());
  await lab('sign-in');
  await strip().getByRole('button', { name: 'Continue', exact: true }).click();
  await wait(300);
  const uploadAsk = await allowInStrip();
  assert.ok(uploadAsk.includes('browser_upload'), `upload asked once of the person: ${uploadAsk}`);
  assert.equal(uploadAsk.filter(tool => tool === 'browser_upload').length, 1);
  await stripSays('Preview matches · Ready for you to process in REI');
  await capture('run-preview-ready', strip());
  let portal = await lab('status');
  assert.deepEqual(portal.effects, ['upload']);
  assert.equal(portal.pending, true);
  await lab('process'); // the simulated person processes the receipts in REI
  await strip().getByRole('button', { name: "I've processed it in REI", exact: true }).click();
  await wait(300);
  const readAsk = await allowInStrip();
  assert.ok(readAsk.includes('browser_download') && !readAsk.includes('browser_upload'), `readback asked, no upload: ${readAsk}`);
  await stripSays('Last import confirmed');
  status = await settle();
  assert.equal(status.run.outcome, 'imported');
  assert.deepEqual(status.readback, { accepted: 3, rejected: 0, pending: 0, warnings: [] });
  assert.equal((await request(`/api/w1/coverage?account=${TRUST}`)).coveredThrough, TODAY);
  assert.equal(status.run.destination, 'FICT1', 'the run is scoped by the business code');
  await capture('run-done', strip());
  portal = await lab('status');
  assert.ok(portal.effects.every(effect => effect === 'upload'), 'Bud pressed nothing that posts');
  scenarios.happyPath = { pulled: 3, pendingExcluded: 1, uploads: portal.uploads, readback: status.readback, coveredThrough: TODAY, asks: [...uploadAsk, ...readAsk] };
  pass('Happy path: pull → review → sign-in → upload preview (asked once) → person processes → readback 3/3 accepted → coverage advanced to today');

  // ── 2. Overlap re-pull: the Pull from bank source shows coverage and adds nothing ──
  await page.getByText('Prepare a new export', { exact: true }).click();
  const pull = page.getByRole('region', { name: 'Pull from bank', exact: true });
  await pull.getByText(/^Covered to .* · next pull from /).waitFor();
  const coverage = await pull.getByText(/^Covered to /).innerText();
  await capture('pull-from-bank', pull);
  await pull.getByRole('button', { name: 'Pull from bank', exact: true }).click();
  await pull.getByText(/No new transactions to review; 3 were already imported\./).waitFor();
  const overlapRun = await request('/api/w1/runs/start', 'POST', {});
  status = await settle();
  assert.equal(status.run.outcome, 'nothing_new', JSON.stringify(overlapRun.run));
  assert.equal(status.run.fetch, null);
  scenarios.overlap = { coverageLine: coverage, window: [addDays(TODAY, -3), TODAY], newRows: 0, alreadyImported: 3 };
  pass(`Overlap re-pull (${addDays(TODAY, -3)} to ${TODAY}) re-reads imported rows and creates no batch or duplicate`);

  // ── 3. Late posting appears in the next pull, alone ──
  ledger.push(txn('txn_fk_anz-0005', TRUST, addDays(TODAY, -1), 78000, 'FT-GOLF'));
  await request('/api/w1/runs/start', 'POST', {});
  status = await settle();
  assert.equal(status.run.step, 'review');
  assert.deepEqual(status.run.fetch.transactionIds, ['txn_fk_anz-0005']);
  scenarios.latePosting = { transactionIds: status.run.fetch.transactionIds, window: [status.run.fetch.from, status.run.fetch.to] };
  pass('A late posting dated inside the overlap arrives in the next pull, alone');

  // ── 4. Lost reply after upload: readback first, no re-upload until the person decides ──
  await reviewByApi(status.run.fetch.batchId);
  await lab('lost-reply');
  const beforeLost = (await lab('status')).uploads;
  await act('advance');
  let answered = await allowAll();
  assert.equal(answered.tools.filter(tool => tool === 'browser_upload').length, 1);
  assert.ok(answered.tools.slice(answered.tools.indexOf('browser_upload') + 1).includes('browser_download'), 'register read before anything else');
  assert.equal(answered.now.run.step, 'check_outcome');
  assert.equal(answered.now.run.attention?.reason, 'nothing_found');
  assert.equal((await lab('status')).uploads, beforeLost + 1, 'no second upload on its own');
  await openBankJob();
  await stripSays('REI shows nothing from the previous upload');
  await capture('run-check-previous-upload', strip());
  await strip().getByRole('button', { name: 'Upload again', exact: true }).click();
  await wait(300);
  answered = { tools: await allowInStrip() };
  await stripSays('Preview matches · Ready for you to process in REI');
  assert.equal((await lab('status')).uploads, beforeLost + 2);
  await lab('process');
  await act('posting', { outcome: 'posted' });
  answered = await allowAll();
  assert.equal(answered.now.run.outcome, 'imported');
  scenarios.lostReply = { uploadsBeforeDecision: 1, inspection: 'nothing', retryAfterPersonChose: true, outcome: 'imported' };
  pass('Lost reply after upload: REI register read first; a second upload only after the person chose Upload again');

  // ── 4b. A batch with a held debit and an excluded credit imports its 3 import rows ──
  ledger.push(txn('txn_fk_anz-0201', TRUST, TODAY, 54100, 'FT-BRAVO'), txn('txn_fk_anz-0202', TRUST, TODAY, 36100, 'FT-CHARLIE'), txn('txn_fk_anz-0203', TRUST, TODAY, 66100, 'FT-ECHO'),
    txn('txn_fk_anz-0204', TRUST, TODAY, -2500, 'FICTIONAL FEE'), txn('txn_fk_anz-0205', TRUST, TODAY, 12000, 'FICTIONAL UNKNOWN'));
  await request('/api/w1/runs/start', 'POST', {});
  status = await settle();
  assert.equal(status.run.fetch.transactionIds.length, 5);
  await reviewByApi(status.run.fetch.batchId, row => holdFee(row) ?? (row.reference === 'FICTIONAL UNKNOWN' ? 'exclude' : null));
  const mixedUploads = (await lab('status')).uploads;
  await act('advance');
  answered = await allowAll();
  assert.equal(answered.now.run.step, 'handoff', JSON.stringify([answered.now.note, answered.now.run.attention]));
  assert.deepEqual([answered.now.run.review.importIds.length, answered.now.run.review.heldIds, answered.now.run.review.excludedIds], [3, ['txn_fk_anz-0204'], ['txn_fk_anz-0205']]);
  assert.equal(answered.now.run.upload.preview.rows.length, 3);
  await lab('process');
  await act('posting', { outcome: 'posted' });
  answered = await allowAll();
  assert.equal(answered.now.run.outcome, 'imported', JSON.stringify([answered.now.note, answered.now.run.attention]));
  assert.deepEqual(answered.now.readback, { accepted: 3, rejected: 0, pending: 0, warnings: [] });
  assert.equal((await lab('status')).uploads, mixedUploads + 1);
  scenarios.heldAndExcluded = { pulled: 5, imported: 3, held: answered.now.run.review.heldIds, excluded: answered.now.run.review.excludedIds, readback: answered.now.readback, outcome: 'imported' };
  pass('A batch with 3 import rows, 1 held debit and 1 excluded credit uploads only the import file and confirms 3/3; the held and excluded rows are not imported');

  // ── 4c. Lost reply after REI accepted the file: found pending, handed to the person, never uploaded again ──
  ledger.push(txn('txn_fk_anz-0301', TRUST, TODAY, 78100, 'FT-GOLF'));
  await request('/api/w1/runs/start', 'POST', {});
  status = await settle();
  // The held fee is offered again (held rows are never confirmed) beside the new credit.
  assert.deepEqual(status.run.fetch.transactionIds.slice().sort(), ['txn_fk_anz-0204', 'txn_fk_anz-0301']);
  await reviewByApi(status.run.fetch.batchId, holdFee);
  await lab('lost-reply-after');
  const pendingUploads = (await lab('status')).uploads;
  await act('advance');
  answered = await allowAll();
  assert.equal(answered.now.run.step, 'handoff', JSON.stringify([answered.now.note, answered.now.run.attention]));
  assert.equal(answered.now.handoff, 'Your earlier upload is waiting in REI. Process or delete it there.');
  portal = await lab('status');
  assert.equal(portal.uploads, pendingUploads + 1, 'no second upload');
  assert.equal(portal.pending, true);
  await lab('process');
  await act('posting', { outcome: 'posted' });
  answered = await allowAll();
  assert.equal(answered.now.run.outcome, 'imported');
  assert.equal((await lab('status')).uploads, pendingUploads + 1);
  scenarios.lostReplyAfter = { uploads: 1, inspection: 'pending (ours)', handoff: 'Your earlier upload is waiting in REI. Process or delete it there.', outcome: 'imported' };
  pass('Lost reply after REI accepted the file: pending import found, handed to the person, no second upload');

  // ── 4d. A different business in REI's top bar blocks before any upload ──
  ledger.push(txn('txn_fk_anz-0007', TRUST, TODAY, 54200, 'FT-BRAVO'));
  await request('/api/w1/runs/start', 'POST', {});
  status = await settle();
  await reviewByApi(status.run.fetch.batchId, holdFee);
  const switchUploads = (await lab('status')).uploads;
  await lab('switch-business');
  await act('advance');
  status = await settle();
  assert.equal(status.run.attention?.reason, 'account_mismatch', JSON.stringify([status.note, status.run.step, status.run.attention]));
  assert.equal(status.run.step, 'sign_in');
  assert.equal((await lab('status')).uploads, switchUploads, 'nothing uploaded to the other business');
  await openBankJob();
  await capture('run-account-mismatch', strip());
  await lab('restore-business');
  await act('advance');
  answered = await allowAll();
  assert.equal(answered.now.run.step, 'handoff', JSON.stringify([answered.now.note, answered.now.run.attention]));
  assert.equal(answered.now.run.attention, null);
  await lab('process');
  await act('posting', { outcome: 'posted' });
  answered = await allowAll();
  assert.equal(answered.now.run.outcome, 'imported', JSON.stringify([answered.now.note, answered.now.run.attention]));
  scenarios.businessMismatch = { attention: 'account_mismatch', uploadsWhileSwitched: 0, afterSwitchBack: 'imported' };
  pass('A different business code in REI\'s top bar stops the run before any upload; back on FICT1 it imports');

  // ── 5. Preview mismatch blocks the handoff ──
  ledger.push(txn('txn_fk_anz-0006', TRUST, TODAY, 96000, 'FT-HOTEL'));
  await lab('mismatch');
  await request('/api/w1/runs/start', 'POST', {});
  status = await settle();
  await reviewByApi(status.run.fetch.batchId, holdFee);
  await act('advance');
  answered = await allowAll();
  assert.equal(answered.now.run.attention?.reason, 'preview_mismatch');
  assert.match(answered.now.run.upload.preview.warnings.join(' '), /FT-HOTEL 960\.00: REI shows a different amount/);
  await request(`/api/w1/runs/${answered.now.run.id}/posting`, 'POST', { expectedRevision: answered.now.run.revision, outcome: 'posted' }, 409);
  await openBankJob();
  await stripSays("REI's preview doesn't match. Don't process it.");
  await strip().getByRole('list', { name: "Differences in REI's preview" }).waitFor();
  await capture('run-preview-mismatch', strip());
  await strip().getByRole('button', { name: 'Close this import', exact: true }).click();
  await stripSays('The last import was closed without importing.');
  scenarios.mismatch = { warnings: answered.now.run.upload.preview.warnings, postingReport: 409, outcome: 'abandoned' };
  pass('A preview that differs from the reviewed file blocks the handoff and the posting report');


  // ── 6. Date-range check: read-only transactions, paging via the token only ──
  const from = addDays(TODAY, -12), to = addDays(TODAY, -5), before = redbarkLog.length;
  const range = await request(`/api/bank-source/redbark/transactions?${new URLSearchParams({ account: TRUST, from, to })}`);
  const expected = ledger.filter(row => row.account === TRUST && row.status === 'posted' && row.date >= from && row.date <= to);
  assert.equal(range.transactions.length, expected.length);
  assert.ok(range.transactions.every(row => row.postDate >= from && row.postDate <= to && row.currency === 'AUD' && Number.isSafeInteger(row.amountCents)));
  assert.deepEqual(range.transactions.map(row => row.postDate), [...range.transactions.map(row => row.postDate)].sort().reverse(), 'newest first');
  assert.equal(range.account.numberMasked, '····4321');
  const pagesFollowed = redbarkLog.slice(before).filter(entry => entry.path === '/v2/transactions' && entry.page).length;
  assert.ok(pagesFollowed >= 2, 'later pages fetched by token from the configured base, not the foreign host');
  await request(`/api/bank-source/redbark/transactions?${new URLSearchParams({ account: TRUST, from: addDays(TODAY, -120), to: TODAY })}`, 'GET', undefined, 400);
  const coverageAfter = await request(`/api/w1/coverage?account=${TRUST}`);
  assert.equal(coverageAfter.coveredThrough, TODAY);
  scenarios.dateRange = { from, to, rows: range.transactions.length, allInRange: true, pagesFollowedByToken: pagesFollowed, truncated: range.truncated, over93DaysRefused: true, coverageUnchanged: true };
  pass(`Date-range check ${from}..${to}: ${range.transactions.length} rows, all in range, ${pagesFollowed} token pages, read-only`);


  // ── 7. In-process host on a movable office clock: cold start, then held rows carried across pulls ──
  // Same createW1Host the service mounts, the fake Redbark above, the FICTIONAL portal, the real
  // openForSignIn over the real NativeBrowserRuntime with a fake work browser that starts CLOSED.
  // Server modules read HOME/data paths, so point them at scratch before importing.
  Object.assign(process.env, { HOME: join(scratch, 'home'), REALBUD_DATA_DIR: join(scratch, 'in-process'), REALBUD_HERMES_HOME: join(scratch, 'in-process', 'hermes'), HERMES_HOME: join(scratch, 'in-process', 'hermes') });
  const [{ createW1Host }, { createW1Lab }, { BankReferenceStore, RedbarkCoverage }, { WorkflowDatabase }, { NativeBrowserRuntime }, { openForSignIn, siteFromMap }, { FICTIONAL_REI_ORIGIN, FICTIONAL_REI_SIGNIN, FICTIONAL_BUSINESS }] = await Promise.all(
    ['server/w1-host.ts', 'server/testing/w1-lab.ts', 'server/bank-reference-store.ts', 'server/workflow-database.ts', 'server/native-browser-runtime.ts', 'server/browser-sign-in.ts', 'server/testing/fictional-rei-portal.ts'].map(path => import(join(root, path))));
  const HOLD = 'acct_FictionalAnzHold01';
  ACCOUNTS.push(account(HOLD, 'Fictional Holding Account', '2468'));
  const dir = join(scratch, 'in-process'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 5) });
  try {
    const store = new BankReferenceStore(db), w1lab = await createW1Lab(dir, { redbarkBase });
    store.create({ csv: 'Date,Amount,Narrative,Reference\n2026-08-01,1.00,FICTIONAL SEED,\n', columns: { date: 'Date', amount: 'Amount', narrative: 'Narrative', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules });
    const DASHBOARD = `${FICTIONAL_REI_ORIGIN}/customers/dashboard`;
    const work = { open: false, launches: 0, tabs: new Map() }, signIns = [];
    const native = new NativeBrowserRuntime({ root: join(dir, 'browser'), host: {
      async status() { return work.open ? { state: 'ready', profileId: 'work', detail: 'Fictional work browser open.' } : { state: 'disconnected', profileId: 'work', detail: 'Fictional work browser closed.' }; },
      async ensureOpen() { if (!work.open) { work.open = true; work.launches++; } return { profileId: 'work', endpoint: 'ws://127.0.0.1:9/fictional', bundle: {} }; },
      async disconnect() { work.open = false; },
      async openTab(url) {
        assert.ok(url.startsWith(FICTIONAL_REI_SIGNIN) || url.startsWith(FICTIONAL_REI_ORIGIN), `sign-in tab stays on the fictional portal: ${url}`);
        const id = `tab-${work.tabs.size + 1}`; work.tabs.set(id, `${FICTIONAL_REI_SIGNIN}/b2c_1_signin/authorize`);
        // The simulated person signs in on the portal's own page; Bud types nothing.
        setTimeout(async () => { await w1lab.handle({ action: 'sign-in' }); work.tabs.set(id, DASHBOARD); }, 30);
        return id;
      },
      async tabUrl(id) { return work.tabs.get(id) ?? null; } } });
    const sites = [siteFromMap('rei-cloud', { origin: FICTIONAL_REI_ORIGIN, signIn: { host: new URL(FICTIONAL_REI_SIGNIN).host }, scope: { urlParam: 'reicid' } })];
    let day = '2026-09-03';
    const host = createW1Host({ dataDir: dir, provider: () => w1lab.provider, coverage: new RedbarkCoverage(dir), store: () => store, today: async () => day,
      runtime: w1lab.runtime, load: w1lab.load, lab: null, pollMs: 0, signInHolding: () => false,
      // Production wiring: the selected browser only while the work browser is ready.
      browserId: async () => { const state = await native.status(); return state.state === 'ready' ? state.selectedBrowserId : null; },
      openForSignIn: input => { signIns.push(input.site); return openForSignIn(input, { runtime: native, sites, pollMs: 5 }); } });
    const call = async (path, body, method = 'POST') => { const out = await host.handle(path, method, new URL(`http://x${path}`).searchParams, async () => body); assert.equal(out.status, 200, `${path}: ${JSON.stringify(out.body)}`); return out.body; };
    const settled = async () => { for (let i = 0; i < 600; i++) { const now = await host.status(); if (!now.working || now.ask) return now; await wait(10); } throw new Error('In-process run did not settle.'); };
    const allow = async () => { let now = await settled(); while (now.ask) { await call(`/api/w1/runs/${now.run.id}/answer`, { requestId: now.ask.requestId, allowed: true }); now = await settled(); } return now; };
    const step = async (action, extra = {}) => { const now = await settled(); await call(`/api/w1/runs/${now.run.id}/${action}`, { expectedRevision: now.run.revision, ...extra }); return allow(); };
    /** Imports rows with one directory match unless `choose` says hold or exclude. */
    const decide = (batchId, choose = () => null) => { const saved = store.get(batchId); store.review(batchId, saved.revision, saved.value.batch.rows.map(row => { const other = choose(row); return other ? { rowId: row.id, action: other, reason: 'Fictional reviewer decision' } : { rowId: row.id, action: 'import', propertyId: row.candidates[0], reason: 'Fictional directory match checked' }; })); };
    const unknown = row => /FICTIONAL UNKNOWN/.test(row.narrative) ? 'hold' : null;
    /** One run on the clock's day: pull, review, REI, the person processes, readback. */
    async function importRun(choose = unknown) {
      await call('/api/w1/runs/start', {});
      let now = await settled();
      assert.equal(now.run.step, 'review', JSON.stringify([now.note, now.run.attention]));
      const fetched = now.run.fetch, batch = store.get(fetched.batchId);
      decide(fetched.batchId, choose);
      now = await step('advance');
      assert.equal(now.run.step, 'handoff', JSON.stringify([now.note, now.run.step, now.run.attention]));
      await w1lab.handle({ action: 'process' });
      now = await step('posting', { outcome: 'posted' });
      assert.equal(now.run.outcome, 'imported', JSON.stringify([now.note, now.run.attention]));
      return { fetched, batch, run: now.run };
    }
    await call('/api/w1/settings', { account: HOLD, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 0 }, 'PUT');
    ledger.push(txn('txn_fk_hold-0001', HOLD, '2026-09-02', 41000, 'FICTIONAL UNKNOWN A'), txn('txn_fk_hold-0002', HOLD, '2026-09-03', 42000, 'FICTIONAL UNKNOWN B'),
      txn('txn_fk_hold-0101', HOLD, '2026-09-03', 54000, 'FT-BRAVO'));

    // 7a. Cold start: no work browser open when the run reaches sign-in.
    assert.equal(work.open, false);
    const run1 = await importRun();
    assert.deepEqual({ launches: work.launches, signIns: signIns.length }, { launches: 1, signIns: 1 });
    scenarios.coldStart = { launches: work.launches, signInCalls: signIns.length, outcome: run1.run.outcome, held: run1.run.review.heldIds };
    pass('Cold start: the run opened the work browser and handed REI\'s sign-in page to the person (1 launch, 1 sign-in), then uploaded, read back and confirmed');

    // 7b. Two later runs: the holds age out of the 3-day overlap but are carried, labelled, until resolved.
    day = '2026-09-20'; ledger.push(txn('txn_fk_hold-0102', HOLD, '2026-09-19', 36000, 'FT-CHARLIE'));
    const run2 = await importRun();
    assert.deepEqual(run2.run.review.heldIds.slice().sort(), ['txn_fk_hold-0001', 'txn_fk_hold-0002'], 'run 2 still pulls the holds itself');
    day = '2026-09-30'; ledger.push(txn('txn_fk_hold-0103', HOLD, '2026-09-29', 66000, 'FT-ECHO'));
    const run3 = await importRun(row => row.id === 'redbark:txn_fk_hold-0001' ? 'exclude' : unknown(row));
    assert.deepEqual([run3.fetched.from, run3.fetched.to], ['2026-09-17', '2026-09-30']);
    assert.deepEqual(run3.fetched.transactionIds.slice().sort(), ['txn_fk_hold-0001', 'txn_fk_hold-0002', 'txn_fk_hold-0103'], 'both holds carried beside the new row');
    const label = run3.batch.firstPass.rows.filter(row => row.reason.startsWith('Held from an earlier pull · ')).map(row => row.rowId).sort();
    assert.deepEqual(label, ['redbark:txn_fk_hold-0001', 'redbark:txn_fk_hold-0002']);
    assert.equal(run3.batch.firstPass.summary.carried, 2);
    assert.ok(run3.batch.firstPass.rows.every(row => !label.includes(row.rowId) || row.disposition === 'hold'), 'a carried hold is never suggested for import');
    // The excluded hold stops carrying; the remaining hold comes forward again.
    day = '2026-10-10'; ledger.push(txn('txn_fk_hold-0104', HOLD, '2026-10-09', 78000, 'FT-GOLF'));
    await call('/api/w1/runs/start', {});
    const run4 = (await settled()).run;
    assert.deepEqual(run4.fetch.transactionIds.slice().sort(), ['txn_fk_hold-0002', 'txn_fk_hold-0104']);
    assert.equal(store.get(run4.fetch.batchId).firstPass.summary.carried, 1);
    scenarios.heldCarry = { run3: { window: [run3.fetched.from, run3.fetched.to], offered: run3.fetched.transactionIds, carried: 2, firstPass: run3.batch.firstPass.summary },
      run4: { window: [run4.fetch.from, run4.fetch.to], offered: run4.fetch.transactionIds, carried: 1 }, uploads: (await w1lab.handle({ action: 'status' })).uploads };
    pass('Held rows older than the 3-day overlap are carried into later reviews with their original id, labelled "Held from an earlier pull", until a person excludes or imports them');
  } finally { db.close(); }
  portal = await lab('status');
  assert.ok(portal.effects.every(effect => effect === 'upload'), 'Bud never pressed Process Receipts or Receipt All');
  assert.deepEqual(errors, []); assert.deepEqual(deniedOrigins, []);
  pass('No renderer errors, no off-origin browser requests, no posting control pressed by Bud');
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
  await new Promise(r => fakeRedbark.close(r));
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), label: 'fictional-w1-simulation', layer: 'source → local simulation (real source service + Vite renderer in headless Chrome)',
    passed: !failure, node: process.version, today: TODAY, scenarios, checks, screenshots: shots, errors, deniedOrigins, failure: failure ?? null,
    fakeRedbark: { requests: redbarkLog.length, tokenPages: redbarkLog.filter(entry => entry.page).length },
    sources: Object.fromEntries(['server/w1-host.ts', 'server/w1-workflow.ts', 'server/w1-state.ts', 'server/bank-provider.ts', 'server/testing/w1-lab.ts', 'src/components/schedule/BankReferenceReview.tsx', 'scripts/qa-w1-simulated.mjs']
      .map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
    limits: ['FICTIONAL bank feed and REI-style portal only: no Redbark, bank, REI Cloud, customer account or credential was used.',
      'The fake Redbark follows the REST shapes in docs/REDBARK-LIVE-CHECK-2026-10-02.md behind a lab provider; the production bank feed is the Redbark MCP connection, which is not wired yet.',
      "The fictional portal's ANZ(csv file) parser, matching and register layout are guesses; REI's real ANZ import, preview and Receipt Register are unqualified until one authorised real preview.",
      'Source service and Vite renderer on this Mac; not a packaged build, installed device, Windows, or customer acceptance.',
      'The person is simulated: sign-in, approvals and posting were pressed by this script.'] }, null, 2));
  if (failure) process.exitCode = 1; else console.log(JSON.stringify({ output, checks: checks.length }, null, 2));
}
