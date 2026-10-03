// W1 dry run on RealBud's side, in one process, FICTIONAL only: the ANZ-shaped
// fixture (server/testing/fixtures/anz-export-fictional.csv) through the
// first-pass matcher, served as bank rows by an in-process fake Redbark; the
// real W1 host routes (createW1Host().handle, the handler index.ts mounts at
// /api/w1/*), review store, coverage cursor and durable run; the FICTIONAL
// REI-style portal behind the real BrowserRuntime, broker and recipe runner
// (setup copied from server/testing/w1-lab.ts, not imported, so every portal
// command can pass the interlock first); the real openForSignIn over the real
// NativeBrowserRuntime with a fake work-browser host that starts CLOSED.
//
// Interlock: every URL a recipe, a sign-in or a browser command would open must
// be on the fictional portal's origins, and every recipe pack must point there.
// Anything else aborts the whole run and fails it. Negative cases prove it.
// No network (globalThis.fetch is replaced), no bank, no REI, nothing sent.
// The session gate and JSON rule in index.ts are not exercised here
// (scripts/qa-w1-simulated.mjs covers them over HTTP).
//
// Node 24:  node scripts/qa-workflows-dryrun.mjs   (QA_OUTPUT=<fresh dir> optional)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/workflows-dryrun-2026-10-02/w1'));
assert.ok(!existsSync(join(output, 'receipt.json')), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-w1-dryrun-'));
const data = join(scratch, 'data'); mkdirSync(data, { mode: 0o700 });
// Scratch only, before any server module reads its config. Never ~/.realbud.
assert.ok(!data.startsWith(join(homedir(), '.realbud')));
Object.assign(process.env, { HOME: join(scratch, 'home'), REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, 'hermes'), HERMES_HOME: join(data, 'hermes'), REALBUD_TEST_LAB: '1', REALBUD_TEST_W1_FICTIONAL_REI: '1' });
// No network beyond loopback: the recipe runner reaches its own browser broker on 127.0.0.1.
const blockedFetches = [], realFetch = globalThis.fetch;
let loopbackFetches = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') { loopbackFetches++; return realFetch(input, init); }
  blockedFetches.push(url.origin); throw new Error('Network is blocked in the W1 dry run.');
};

const { WorkflowDatabase } = await import('../server/workflow-database.ts');
const { BankReferenceStore, RedbarkCoverage } = await import('../server/bank-reference-store.ts');
const { restBankProvider } = await import('../server/bank-provider.ts');
const { createRedbarkClient } = await import('../server/redbark-source.ts');
const { BrowserRuntime } = await import('../server/browser-runtime.ts');
const { NativeBrowserRuntime } = await import('../server/native-browser-runtime.ts');
const { openForSignIn, siteFromMap } = await import('../server/browser-sign-in.ts');
const { loadPortalRecipePack } = await import('../server/portal-recipe-task.ts');
const { createW1Host } = await import('../server/w1-host.ts');
const { FICTIONAL_BUSINESS, FICTIONAL_REI_ORIGIN, FICTIONAL_REI_SIGNIN, fictionalReiPack, fictionalReiPortal } = await import('../server/testing/fictional-rei-portal.ts');

const checks = [], failures = [], bugs = [], scenarios = {};
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const failSoft = (text, detail) => { failures.push({ text, detail }); console.log(`FAIL ${text}: ${detail}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const dbs = [];

// ── Interlock ──────────────────────────────────────────────────────────────
const FICTIONAL_ORIGINS = new Set([FICTIONAL_REI_ORIGIN, FICTIONAL_REI_SIGNIN]);
function createInterlock(label) {
  const trips = [];
  const trip = (where, value) => { trips.push({ where, value }); throw Object.assign(new Error(`INTERLOCK (${label}): ${where} targets ${value}, which is not the fictional REI portal. The run is aborted.`), { interlock: true }); };
  /** Every http(s) URL must be on a fictional REI origin. */
  const url = (where, value) => {
    let origin; try { origin = new URL(value).origin; } catch { return; }
    if (/^https?:/i.test(value) && !FICTIONAL_ORIGINS.has(origin)) trip(where, origin);
  };
  /** A recipe pack must point only at the fictional portal. */
  const pack = (where, value) => {
    url(`${where} origin`, value.origin);
    for (const host of value.signIn?.hosts ?? []) url(`${where} sign-in host`, `https://${host}`);
    if (!FICTIONAL_ORIGINS.has(value.origin)) trip(`${where} origin`, value.origin);
    return value;
  };
  /** Wraps a portal command: each URL argument is checked before the portal sees it. */
  const command = (inner, where = 'browser command') => async args => { for (const arg of args) if (typeof arg === 'string' && /^https?:\/\//i.test(arg)) url(`${where} ${args[0]}`, arg); return inner(args); };
  const loader = (inner, where = 'recipe pack') => async portal => pack(where, await inner(portal));
  return { trips, url, pack, command, loader, assertClean() { if (trips.length) throw new Error(`INTERLOCK tripped: ${JSON.stringify(trips)}`); } };
}
const interlock = createInterlock('main');

// ── FICTIONAL bank rows from the ANZ-shaped fixture, behind a fake Redbark ──
const ANZ = readFileSync(join(root, 'server/testing/fixtures/anz-export-fictional.csv'));
const ACCOUNT = 'acct_FictionalAnzTrust1', CONNECTION = 'conn_FictionalAnz0001';
const iso = dmy => `${dmy.slice(6, 10)}-${dmy.slice(3, 5)}-${dmy.slice(0, 2)}`;
const cells = line => { const out = []; let cell = '', quoted = false; for (const c of line) { if (c === '"') quoted = !quoted; else if (c === ',' && !quoted) { out.push(cell); cell = ''; } else cell += c; } out.push(cell); return out; };
const txn = (id, date, cents, description, reference) => ({ id, object: 'transaction', account: ACCOUNT, status: 'posted', date, datetime: `${date}T02:00:00.000Z`, post_date: date,
  post_datetime: `${date}T03:00:00.000Z`, value_date: null, value_datetime: null, description, reference: reference || null, extended_description: null,
  amount: { amount: cents, currency: 'aud' }, direction: cents < 0 ? 'debit' : 'credit', provider_category: null, category: null, merchant_name: null, merchant_category_code: null, livemode: true });
const ledger = ANZ.toString('utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
  const c = cells(line);
  return txn(`txn_fk_anz-${String(index + 1).padStart(4, '0')}`, iso(c[0]), Math.round(Number(c[1]) * 100), c[2], c[7] || c[6]);
});
const redbarkLog = [];
const fakeRedbark = async input => {
  const url = new URL(input); redbarkLog.push(url.pathname);
  const list = items => new Response(JSON.stringify({ object: 'list', data: items, next_page_url: null, previous_page_url: null }), { status: 200 });
  if (url.pathname === '/v2/accounts') return list([{ id: ACCOUNT, object: 'account_item', connection: CONNECTION, provider: 'fiskil', category: 'banking', name: 'Fictional Trust Account',
    type: 'transaction', institution: { id: 'inst_fk_anz', name: 'ANZ (fictional)' }, account_number: 'xxxx4321', currency: 'aud', status: 'available', last_updated_at: null, livemode: true }]);
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  return list(ledger.filter(row => row.date >= from && row.date <= to).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)));
};
const provider = restBankProvider(createRedbarkClient({ key: 'rbk_live_fictional_w1_dryrun_0000', fetch: fakeRedbark, sleep: async () => {} }));

// The office's FICTIONAL directory: five ANZ-style codes mapped (as aliases) to the fictional portal's active tenancies.
const RULES = [['FP-02', 'FT-BRAVO', 'A2218', 'Fictional Tenant Bravo'], ['FP-03', 'FT-CHARLIE', 'A5U4', 'Fictional Tenant Charlie'], ['FP-05', 'FT-ECHO', 'A2004', 'Fictional Tenant Echo'],
  ['FP-06', 'FT-GOLF', 'B1605', 'Fictional Tenant Golf'], ['FP-07', 'FT-HOTEL', 'A114', 'Fictional Tenant Hotel'], ['FP-04', 'FT-BRAVO2', 'A5U2', 'Fictional Tenant Bravo-Two']]
  .map(([propertyId, reference, alias, tenant]) => ({ propertyId, reference, aliases: [alias, reference], tenant }));

// ── The FICTIONAL portal behind the real BrowserRuntime (w1-lab.ts setup, interlocked) ──
const portalOptions = { signedOut: true };
const portal = fictionalReiPortal(portalOptions);
let uploads = 0;
const portalCommand = interlock.command(async args => {
  if (args[0] !== 'upload') return portal.command(args);
  uploads += 1;
  try { return await portal.command(args); } finally { delete portalOptions.unknownUpload; }
});
// REI scopes the account by the top-bar business code; the dashboard address carries no reicid.
const DASHBOARD = `${FICTIONAL_REI_ORIGIN}/customers/dashboard`;
// Settings as the office saves them: the top-bar business code only, File Format left at its default (ANZ(csv file)).
const SETTINGS = { account: ACCOUNT, reiBusiness: FICTIONAL_BUSINESS, expectedRevision: 0 };
const personSignsIn = async () => { portal.signIn(); await portal.command(['navigate', DASHBOARD]); };
async function portalRuntime(name) {
  const runtime = new BrowserRuntime({ root: join(data, name), command: portalCommand, executable: async () => '/synthetic/bsk', startDaemon: async () => {} });
  await runtime.connect(); await runtime.select('work');
  return runtime;
}
const portalStatus = () => ({ uploads, effects: [...portal.effects], receipts: portal.receipts().length, pending: Boolean(portal.pendingUpload()) });

// ── The work browser: real NativeBrowserRuntime over a fake host that starts CLOSED ──
const workBrowser = { open: false, launches: 0, tabs: new Map(), person: 'sign-in' };
const nativeHost = {
  async status() { return workBrowser.open ? { state: 'ready', profileId: 'work', detail: 'Fictional work browser open.' } : { state: 'disconnected', profileId: 'work', detail: 'Fictional work browser closed.' }; },
  async ensureOpen() { if (!workBrowser.open) { workBrowser.open = true; workBrowser.launches += 1; } return { profileId: 'work', endpoint: 'ws://127.0.0.1:9/fictional', bundle: {} }; },
  async disconnect() { workBrowser.open = false; },
  async openTab(url) {
    interlock.url('sign-in tab', url);
    if (!workBrowser.open) throw new Error('no browser');
    const id = `tab-${workBrowser.tabs.size + 1}`;
    workBrowser.tabs.set(id, `${FICTIONAL_REI_SIGNIN}/b2c_1_signin/authorize`);
    // The person signs in on REI's own page (Bud types nothing), or never does.
    if (workBrowser.person === 'sign-in') setTimeout(async () => { await personSignsIn(); workBrowser.tabs.set(id, DASHBOARD); }, 30);
    return id;
  },
  async tabUrl(id) { return workBrowser.tabs.get(id) ?? null; },
};
const native = new NativeBrowserRuntime({ root: join(data, 'browser'), host: nativeHost });
// Production wiring (server/index.ts): the selected browser only when the runtime says ready.
const productionBrowserId = async () => { const status = await native.status(); return status.state === 'ready' ? status.selectedBrowserId : null; };
const SIGN_IN_SITES = [siteFromMap('rei-cloud', { origin: FICTIONAL_REI_ORIGIN, signIn: { host: new URL(FICTIONAL_REI_SIGNIN).host }, scope: { urlParam: 'reicid' } })];
const signInCalls = [];
const fictionalOpenForSignIn = input => { signInCalls.push({ site: input.site, account: input.account }); for (const site of SIGN_IN_SITES) interlock.url('sign-in site', site.origin);
  return openForSignIn(input, { runtime: native, sites: SIGN_IN_SITES, pollMs: 5 }); };

// ── Host (re)starts over one data directory ─────────────────────────────────
let TODAY = '2026-09-03';
const db = new WorkflowDatabase({ dir: data, key: Buffer.alloc(32, 7) }); dbs.push(db);
const store = new BankReferenceStore(db);
const coverage = new RedbarkCoverage(data);
const load = interlock.loader(async () => fictionalReiPack());
async function startHost(name) {
  const runtime = await portalRuntime(`portal-browser-${name}`);
  const host = createW1Host({ dataDir: data, provider: () => provider, coverage, store: () => store, today: async () => TODAY, runtime,
    browserId: productionBrowserId, load, lab: null, pollMs: 0, signInHolding: () => false, openForSignIn: fictionalOpenForSignIn });
  await host.status();
  return host;
}
let host;
const call = async (path, method = 'POST', body, on = host) => {
  const url = new URL(`http://x${path}`);
  const result = await on.handle(url.pathname, method, url.searchParams, async () => body);
  interlock.assertClean();
  return result;
};
/** The HTTP status a route answers with (index.ts maps a thrown {status} to it). */
const statusOf = async (...args) => { try { return (await call(...args)).status; } catch (error) { if (error.interlock) throw error; return error.status ?? 500; } };
const ok = async (...args) => { const result = await call(...args); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
async function settle(on = host) {
  for (let i = 0; i < 1500; i++) { interlock.assertClean(); const now = await on.status(); if (!now.working || now.ask) return now; await wait(10); }
  throw new Error('The run did not settle.');
}
const runCall = async (action, extra = {}, on = host) => { const now = await settle(on); return ok(`/api/w1/runs/${now.run.id}/${action}`, 'POST', { expectedRevision: now.run.revision, ...extra }, on); };
/** Answers asks with Allow until the run stops asking (or until `until` names the next tool, which is left open). */
async function allow({ on = host, until = null } = {}) {
  const tools = []; let now = await settle(on);
  while (now.ask && now.ask.tool !== until) { tools.push(now.ask.tool); await ok(`/api/w1/runs/${now.run.id}/answer`, 'POST', { requestId: now.ask.requestId, allowed: true }, on); now = await settle(on); }
  return { now, tools };
}
/** Stop never waits for the stage in flight: it is how the person ends it. */
const stop = async (on = host) => { const now = await on.status(); return ok(`/api/w1/runs/${now.run.id}/stop`, 'POST', {}, on); };
/** Stop at an idle checkpoint: nothing in flight, so nothing may change. */
async function stopIdle(label) {
  const before = (await settle()).run, effects = portalStatus();
  const after = await stop();
  assert.equal(after.run.step, before.step); assert.equal(after.run.revision, before.revision); assert.deepEqual(portalStatus(), effects);
  pass(`Stop at the ${label} checkpoint changes nothing (step ${before.step}, revision ${before.revision}, no portal effect)`);
}

// ── First pass over the ANZ fixture → W1 review decisions ───────────────────
let firstPass;
function anzFirstPass() {
  const saved = store.create({ source: { filename: 'anz-export-fictional.csv', bytesBase64: ANZ.toString('base64') }, columns: { date: '', amount: '', narrative: '', reference: '' }, dateFormat: 'YYYY-MM-DD', rules: RULES });
  assert.ok(saved.firstPass, 'the ANZ-layout upload gets a first pass');
  const narrative = new Map(saved.value.batch.rows.map(row => [row.id, row.narrative]));
  const byKey = new Map(saved.firstPass.rows.map(row => [`${iso(row.date)}|${row.amount}|${narrative.get(row.rowId)}`, row]));
  return { summary: saved.firstPass.summary, byKey, rows: saved.firstPass.rows };
}
/** Applies the Redbark batch's own first pass (exceptions first, never auto-imported) as the person would after checking it. */
function reviewWithFirstPass(batchId, on = store) {
  const saved = on.get(batchId);
  assert.ok(saved.firstPass, 'a Redbark batch gets its own first pass');
  assert.equal(saved.firstPass.layout, 'bank-feed');
  const byRow = new Map(saved.firstPass.rows.map(row => [row.rowId, row]));
  const counts = { import: 0, hold: 0, exclude: 0, carried: 0 };
  const decisions = saved.value.batch.rows.map(row => {
    const fp = byRow.get(row.id);
    assert.ok(fp, `first pass covers row ${row.id}`);
    assert.ok(!(fp.class === 'exception' && fp.disposition === 'import'), `exception row ${row.id} is never decided as import`);
    if (fp.reason.startsWith('Held from an earlier pull · ')) { assert.equal(fp.disposition, 'hold'); assert.equal(fp.class, 'exception'); counts.carried++; }
    counts[fp.disposition]++;
    return fp.disposition === 'import' ? { rowId: row.id, action: 'import', propertyId: fp.propertyId, reason: fp.reason } : { rowId: row.id, action: fp.disposition, reason: fp.reason };
  });
  on.review(batchId, saved.revision, decisions);
  return counts;
}

let failure = null;
try {
  // ── 0. Interlock negative cases (isolated; must trip) ──
  {
    const neg = createInterlock('negative');
    const seen = [];
    const guarded = neg.command(async args => { seen.push(args); return { ok: true }; });
    await assert.rejects(guarded(['navigate', 'https://app.reimasterapps.com.au/customers/dashboard?reicid=x']), /INTERLOCK/);
    assert.equal(seen.length, 0, 'a real-REI navigate never reaches the browser');
    await assert.rejects(neg.loader(loadPortalRecipePack)('rei-cloud'), /INTERLOCK/);
    assert.throws(() => neg.url('sign-in tab', 'https://reimasterapps.b2clogin.com/'), /INTERLOCK/);
    await guarded(['navigate', DASHBOARD]);
    assert.equal(seen.length, 1, 'the fictional portal still passes');
    // End to end: a host loading the REAL pack is stopped before its first browser command.
    const negDir = mkdtempSync(join(scratch, 'neg-')), negDb = new WorkflowDatabase({ dir: negDir, key: Buffer.alloc(32, 8) }); dbs.push(negDb);
    const negStore = new BankReferenceStore(negDb);
    negStore.create({ source: { filename: 'anz-export-fictional.csv', bytesBase64: ANZ.toString('base64') }, columns: { date: '', amount: '', narrative: '', reference: '' }, dateFormat: 'YYYY-MM-DD', rules: RULES });
    const negRuntime = new BrowserRuntime({ root: join(negDir, 'portal'), command: neg.command(portal.command), executable: async () => '/synthetic/bsk', startDaemon: async () => {} });
    await negRuntime.connect(); await negRuntime.select('work');
    const callsBefore = portal.calls.length;
    const negHost = createW1Host({ dataDir: negDir, provider: () => provider, coverage: new RedbarkCoverage(negDir), store: () => negStore, today: async () => TODAY, runtime: negRuntime,
      browserId: async () => 'work', load: neg.loader(loadPortalRecipePack), lab: null, pollMs: 0, signInHolding: () => false });
    const h = (path, method = 'POST', body) => negHost.handle(path, method, new URL(`http://x${path}`).searchParams, async () => body);
    await h('/api/w1/settings', 'PUT', SETTINGS);
    await h('/api/w1/runs/start');
    let now; for (let i = 0; i < 500; i++) { now = await negHost.status(); if (!now.working) break; await wait(10); }
    const batch = negStore.get(now.run.fetch.batchId);
    negStore.review(batch.id, batch.revision, batch.value.batch.rows.map(row => ({ rowId: row.id, action: 'hold', reason: 'negative case' })).map((d, i, all) => i === 0 && batch.value.batch.rows[0].candidates.length === 1 ? { rowId: d.rowId, action: 'import', propertyId: batch.value.batch.rows[0].candidates[0], reason: 'negative case' } : d));
    await h(`/api/w1/runs/${now.run.id}/advance`, 'POST', { expectedRevision: now.run.revision });
    for (let i = 0; i < 500; i++) { now = await negHost.status(); if (!now.working) break; await wait(10); }
    assert.ok(neg.trips.length >= 1, `the real REI pack trips the interlock: ${JSON.stringify(now.note)}`);
    assert.match(String(now.note), /INTERLOCK/);
    assert.deepEqual(portal.calls.slice(callsBefore), [], 'no browser command was sent');
    assert.deepEqual(interlock.trips, [], 'the main interlock is untouched');
    scenarios.interlockNegative = { trips: neg.trips, note: now.note, step: now.run.step, browserCommandsSent: 0 };
    pass('Interlock: a real-REI navigate, sign-in tab or recipe pack aborts before any browser command; a host loading the real REI pack stops at sign-in with nothing sent');
  }

  // ── 1. Settings, accounts, manual pull ──
  host = await startHost('a');
  await assert.rejects(call('/api/w1/runs/start'), /Choose the bank account/, 'start refuses without settings');
  const savedSettings = await ok('/api/w1/settings', 'PUT', SETTINGS);
  assert.deepEqual([savedSettings.settings.rei, savedSettings.settings.bankFormat], [{ marker: FICTIONAL_BUSINESS }, 'ANZ(csv file)'], 'business code only, no reicid; ANZ(csv file) by default');
  const accounts = await ok('/api/w1/accounts', 'GET');
  assert.deepEqual(accounts.accounts.map(a => [a.id, a.numberMasked]), [[ACCOUNT, '····4321']]);
  firstPass = anzFirstPass();
  scenarios.firstPass = { summary: firstPass.summary, rows: firstPass.rows.map(row => ({ date: row.date, amount: row.amount, class: row.class, disposition: row.disposition, propertyId: row.propertyId ?? null, reason: row.reason })) };
  const manual = await ok('/api/w1/pull', 'POST', { account: ACCOUNT });
  assert.deepEqual(manual.window, { from: '2026-09-01', to: TODAY, firstRun: true });
  assert.equal(manual.batch.rows, 12);
  pass(`Settings saved by top-bar business code ${FICTIONAL_BUSINESS} only (no reicid, File Format ANZ(csv file)), 1 masked account listed, manual pull ${manual.window.from}..${manual.window.to} → ${manual.batch.rows} fixture rows; ANZ first pass: ${JSON.stringify(firstPass.summary)}`);

  // ── 2. Run 1: pull → first-pass decisions → CSV build ──
  await ok('/api/w1/runs/start');
  let now = await settle();
  assert.equal(now.run.step, 'review'); assert.equal(now.run.fetch.transactionIds.length, 12);
  await stopIdle('review');
  const run1Counts = reviewWithFirstPass(now.run.fetch.batchId);
  const artifact = store.importArtifact(now.run.fetch.batchId);
  writeFileSync(join(output, 'run1-rei-import-FICTIONAL.csv'), artifact.artifact.csv);
  // File Format ANZ(csv file): the ANZ export layout, no header row, DD/MM/YYYY, the property reference in column 8.
  const lines = artifact.artifact.csv.split(/\r?\n/).filter(Boolean), header = 'ANZ(csv file) layout, no header';
  assert.equal(lines.length, artifact.summary.import);
  assert.ok(lines.every(line => { const c = cells(line); return c.length === 8 && /^\d{2}\/\d{2}\/\d{4}$/.test(c[0]) && RULES.some(rule => rule.reference === c[7]); }), lines.join(' | '));
  assert.ok(artifact.rows.filter(r => r.disposition === 'import').every(r => RULES.some(rule => rule.reference === r.reference)), 'imported rows carry the property reference, not the bank text');
  scenarios.csv = { header, summary: artifact.summary, digest: artifact.artifact.digest, sample: lines.slice(0, 3), rows: artifact.rows.map(r => ({ date: r.date, amount: r.amount, disposition: r.disposition, reference: r.reference, propertyId: r.propertyId ?? null, tenant: r.tenant ?? null })) };
  pass(`Run 1 review from the first pass: ${JSON.stringify(run1Counts)}; REI import file ${header} with ${artifact.summary.import} rows (held/excluded rows left out)`);

  // ── 3. Sign-in from a COLD START: no work browser open ──
  assert.equal(workBrowser.open, false); assert.equal(await productionBrowserId(), null);
  now = await runCall('advance'); now = await settle();
  const cold = { launches: workBrowser.launches, signInCalls: signInCalls.length, note: now.note, step: now.run.step, attention: now.run.attention, ask: now.ask?.tool ?? null };
  scenarios.coldStart = cold;
  assert.equal(workBrowser.launches, 1, JSON.stringify(cold)); assert.equal(signInCalls.length, 1, JSON.stringify(cold));
  assert.notEqual(now.run.step, 'sign_in', JSON.stringify(cold)); assert.equal(now.ask?.tool, 'browser_download', JSON.stringify(cold));
  pass(`Cold start: sign-in opened the work browser on REI's sign-in page (launches 1, openForSignIn 1); the person signed in and the run moved past sign-in to the ${now.ask.tool} ask (step ${now.run.step})`);
  let asked = await allow({ until: 'browser_upload' });
  now = asked.now;
  assert.equal(now.ask?.tool, 'browser_upload', JSON.stringify([now.note, now.run.step, now.run.attention]));
  pass(`Signed in through the handover (Bud typed nothing); the run asks before the upload (asks so far: ${asked.tools.join(', ') || 'none'})`);

  // ── 4. Stop with the upload ask open → unknown outcome → REI checked → nothing → person re-uploads ──
  now = await stop();
  assert.equal(now.run.step, 'check_outcome'); assert.equal(now.run.attention?.reason, 'outcome_unknown');
  assert.equal(portalStatus().uploads, 0);
  await runCall('advance'); asked = await allow(); now = asked.now;
  assert.equal(now.run.attention?.reason, 'nothing_found', JSON.stringify([now.note, now.run.attention]));
  assert.ok(!asked.tools.includes('browser_upload'));
  await runCall('retry-upload'); asked = await allow(); now = asked.now;
  assert.equal(now.run.step, 'handoff', JSON.stringify([now.note, now.run.attention])); assert.equal(now.run.attention, null);
  assert.equal(asked.tools.filter(t => t === 'browser_upload').length, 1);
  assert.deepEqual(portalStatus().effects, ['upload']); assert.equal(portalStatus().uploads, 1);
  scenarios.run1Preview = { rows: now.run.upload.preview.rows.length, warnings: now.run.upload.preview.warnings, handoff: now.handoff };
  pass('Stop at the upload ask: nothing uploaded, outcome checked in REI (nothing found), re-upload only after the person chose it; preview matches row for row');
  await stopIdle('handoff');

  // ── 5. Restart at the handoff, then posting, Stop during readback, readback, confirm ──
  host = await startHost('b');
  now = await settle();
  assert.equal(now.run.step, 'handoff');
  portal.post();
  now = await runCall('posting', { outcome: 'posted' });
  assert.equal(await statusOf(`/api/w1/runs/${now.run.id}/posting`, 'POST', { expectedRevision: now.run.revision - 1, outcome: 'posted' }), 409, 'a repeated posting report is refused');
  now = await settle();
  assert.equal(now.ask?.tool, 'browser_download', JSON.stringify([now.note, now.run.step]));
  now = await stop();
  assert.equal(now.run.attention?.reason, 'readback_failed', JSON.stringify([now.note, now.run.step, now.run.attention]));
  assert.equal((await ok(`/api/w1/coverage?account=${ACCOUNT}`, 'GET')).coveredThrough, null, 'coverage not advanced by a stopped readback');
  await runCall('advance'); asked = await allow(); now = asked.now;
  assert.equal(now.run.outcome, 'imported', JSON.stringify([now.note, now.run.attention]));
  assert.equal((await ok(`/api/w1/coverage?account=${ACCOUNT}`, 'GET')).coveredThrough, TODAY);
  scenarios.run1 = { pulled: 12, review: run1Counts, readback: now.readback, outcome: now.run.outcome, coveredThrough: TODAY, portal: portalStatus() };
  pass(`Restart at handoff keeps the run; person posts; Stop during the register read leaves coverage unmoved; readback ${JSON.stringify(now.readback)} → imported, covered through ${TODAY}`);

  // ── 6. Run 2: next pull (overlap + held rows offered again); restart mid-upload ──
  TODAY = '2026-09-08';
  await ok('/api/w1/runs/start');
  now = await settle();
  assert.equal(now.run.step, 'review');
  const heldBack = now.run.fetch.transactionIds.filter(id => ledger.find(r => r.id === id).date <= '2026-09-03').length;
  const run2Counts = reviewWithFirstPass(now.run.fetch.batchId);
  await runCall('advance');
  asked = await allow({ until: 'browser_upload' }); now = asked.now;
  assert.equal(now.ask?.tool, 'browser_upload', JSON.stringify([now.note, now.run.step, now.run.attention]));
  // RealBud restarts while the upload intent is saved and its ask is open.
  const crashed = host;
  host = await startHost('c');
  now = await settle();
  assert.equal(now.run.step, 'check_outcome', 'boot recovery turns an upload intent without a result into an unknown outcome');
  await stop(crashed).catch(() => {});
  assert.equal(portalStatus().uploads, 1, 'nothing uploaded by the crashed process');
  await runCall('advance'); asked = await allow(); now = asked.now;
  assert.equal(now.run.attention?.reason, 'nothing_found', JSON.stringify([now.note, now.run.attention]));
  await runCall('retry-upload'); asked = await allow(); now = asked.now;
  assert.equal(now.run.step, 'handoff', JSON.stringify([now.note, now.run.attention]));
  assert.equal(portalStatus().uploads, 2);
  // The person is unsure whether they processed it (they did): REI is read, never re-uploaded.
  portal.post();
  await runCall('posting', { outcome: 'unsure' });
  asked = await allow(); now = asked.now;
  assert.equal(now.run.outcome, 'imported', JSON.stringify([now.note, now.run.step, now.run.attention]));
  assert.equal(portalStatus().uploads, 2);
  const run2Held = now.run.review.heldIds, run2CoveredThrough = now.run.confirm.coveredThrough;
  scenarios.run2 = { pulled: now.run.fetch.transactionIds.length, heldOfferedAgain: heldBack, review: run2Counts, readback: now.readback, outcome: now.run.outcome, portal: portalStatus() };
  pass(`Run 2 (${now.run.fetch.from}..${now.run.fetch.to}): ${heldBack} held rows offered again; restart mid-upload → REI checked → re-upload by the person; posting "unsure" reconciled from the register → imported`);

  // ── 7. Lost reply after REI accepted the file → found pending, handed over, no second upload ──
  ledger.push(txn('txn_fk_dry-0101', '2026-09-08', 66100, 'FICTIONAL PAYMENT FT-ECHO', 'FT-ECHO'));
  await ok('/api/w1/runs/start');
  now = await settle();
  // Held rows are never confirmed and are carried into every later pull, however old, until a person imports or excludes them.
  const offered = new Set(now.run.fetch.transactionIds), dropped = run2Held.filter(id => !offered.has(id));
  const olderThanWindow = run2Held.filter(id => ledger.find(r => r.id === id).date < now.run.fetch.from).length;
  const pulled3 = await ok('/api/w1/pull', 'POST', { account: ACCOUNT });
  const run3Counts = reviewWithFirstPass(now.run.fetch.batchId);
  scenarios.heldCarried = { window: [now.run.fetch.from, now.run.fetch.to], heldBefore: run2Held.length, offeredAgain: run2Held.length - dropped.length, dropped: dropped.length,
    pullSummaryCarried: pulled3.carried, olderThanWindow, sameBatch: pulled3.batch?.id === now.run.fetch.batchId, review: run3Counts };
  assert.deepEqual(dropped, [], `every earlier hold is offered again: ${JSON.stringify(scenarios.heldCarried)}`);
  assert.ok(olderThanWindow > 0, 'some holds are older than the overlap window (the case that used to drop)');
  assert.equal(pulled3.carried, olderThanWindow, 'the pull summary counts the carried holds');
  assert.equal(run3Counts.carried, olderThanWindow, 'each carried hold is a Hold exception "Held from an earlier pull · {date}"');
  pass(`Run 3 (${now.run.fetch.from}..${now.run.fetch.to}): all ${run2Held.length} earlier holds offered again, ${pulled3.carried} carried from before the window as "Held from an earlier pull · {date}" holds; review ${JSON.stringify(run3Counts)}`);
  portalOptions.unknownUpload = 'after';
  const before7 = portalStatus().uploads;
  await runCall('advance'); asked = await allow(); now = asked.now;
  assert.equal(now.run.step, 'handoff', JSON.stringify([now.note, now.run.attention]));
  assert.equal(now.handoff, 'Your earlier upload is waiting in REI. Process or delete it there.');
  assert.equal(portalStatus().uploads, before7 + 1);
  portal.post();
  await runCall('posting', { outcome: 'posted' }); asked = await allow(); now = asked.now;
  assert.equal(now.run.outcome, 'imported');
  assert.equal(portalStatus().uploads, before7 + 1);
  scenarios.lostReplyAfter = { uploads: 1, handoff: now.handoff ?? 'Your earlier upload is waiting in REI. Process or delete it there.', outcome: 'imported' };
  pass('Lost upload reply after REI accepted the file: found pending, handed to the person, never uploaded twice');

  // ── 7b. No new bank transactions, but holds are open → a review, not "No new bank transactions" ──
  const openHolds = new Set(now.run.review.heldIds);
  assert.ok(openHolds.size > 0);
  await ok('/api/w1/runs/start');
  now = await settle();
  scenarios.holdsOnly = { step: now.run.step, outcome: now.run.outcome ?? null, note: now.note, offered: now.run.fetch?.transactionIds.length ?? 0, openHolds: openHolds.size };
  assert.equal(now.run.step, 'review', JSON.stringify(scenarios.holdsOnly)); assert.doesNotMatch(String(now.note), /No new bank transactions/);
  assert.ok(now.run.fetch.transactionIds.every(id => openHolds.has(id)), 'nothing new: every offered row is an open hold');
  assert.equal(now.run.fetch.transactionIds.length, openHolds.size, 'every open hold is offered');
  now = await runCall('abandon');
  assert.equal(now.run.outcome, 'abandoned');
  pass(`No new bank transactions with ${openHolds.size} holds open: the run opens a review of those holds instead of ending "No new bank transactions"`);

  // ── 8. Preview mismatch blocks the handoff and the posting report ──
  ledger.push(txn('txn_fk_dry-0201', '2026-09-08', 78100, 'FICTIONAL PAYMENT FT-GOLF', 'FT-GOLF'));
  portalOptions.previewEdit = rows => rows.map((row, index) => index === 0 ? [...row.slice(0, 4), (Number(row[4]) + 10).toFixed(2), row[5]] : row);
  await ok('/api/w1/runs/start');
  now = await settle();
  reviewWithFirstPass(now.run.fetch.batchId);
  await runCall('advance'); asked = await allow(); now = asked.now;
  assert.equal(now.run.attention?.reason, 'preview_mismatch');
  assert.equal(await statusOf(`/api/w1/runs/${now.run.id}/posting`, 'POST', { expectedRevision: now.run.revision, outcome: 'posted' }), 409);
  delete portalOptions.previewEdit;
  now = await runCall('abandon');
  assert.equal(now.run.outcome, 'abandoned');
  scenarios.mismatch = { warnings: now.run.upload.preview.warnings, outcome: 'abandoned' };
  pass('A preview that differs from the reviewed file blocks the handoff and the posting report; the person closes it');

  // ── 8a. A different business code in REI's top bar blocks the run before anything is uploaded ──
  {
    ledger.push(txn('txn_fk_dry-0251', '2026-09-08', 69900, 'FICTIONAL PAYMENT FT-CHARLIE', 'FT-CHARLIE'));
    await ok('/api/w1/runs/start');
    now = await settle();
    assert.equal(now.run.step, 'review');
    reviewWithFirstPass(now.run.fetch.batchId);
    const effects = portalStatus();
    portal.setBusiness('FICT2');
    try { await runCall('advance'); asked = await allow({ until: 'browser_upload' }); now = asked.now; } finally { portal.setBusiness(); }
    scenarios.businessMismatch = { step: now.run.step, attention: now.run.attention?.reason ?? null, note: now.note, ask: now.ask?.tool ?? null, asks: asked.tools };
    assert.equal(now.run.step, 'sign_in', JSON.stringify(scenarios.businessMismatch)); assert.equal(now.run.attention?.reason, 'account_mismatch', JSON.stringify(scenarios.businessMismatch));
    assert.ok(!asked.tools.includes('browser_upload')); assert.deepEqual(portalStatus(), effects, 'nothing changed in REI');
    now = await runCall('abandon');
    assert.equal(now.run.outcome, 'abandoned');
    pass(`Top-bar business FICT2 ≠ saved ${FICTIONAL_BUSINESS}: the run stops at sign-in (account_mismatch) before any upload ask; nothing changed in REI`);
  }

  // ── 8b. Warm path, its own run: work browser already open, REI signed out; Stop while the person has not signed in ──
  {
    assert.equal(await productionBrowserId(), 'work');
    const warmDir = mkdtempSync(join(scratch, 'warm-')), warmDb = new WorkflowDatabase({ dir: warmDir, key: Buffer.alloc(32, 9) }); dbs.push(warmDb);
    const warmStore = new BankReferenceStore(warmDb), warmPortal = fictionalReiPortal({ signedOut: true });
    const warmRuntime = new BrowserRuntime({ root: join(warmDir, 'portal'), command: interlock.command(warmPortal.command), executable: async () => '/synthetic/bsk', startDaemon: async () => {} });
    await warmRuntime.connect(); await warmRuntime.select('work');
    const warm = createW1Host({ dataDir: warmDir, provider: () => provider, coverage: new RedbarkCoverage(warmDir), store: () => warmStore, today: async () => TODAY, runtime: warmRuntime,
      browserId: productionBrowserId, load, lab: null, pollMs: 0, signInHolding: () => false, openForSignIn: fictionalOpenForSignIn });
    await ok('/api/w1/settings', 'PUT', SETTINGS, warm);
    ledger.push(txn('txn_fk_dry-0301', '2026-09-08', 72500, 'FICTIONAL PAYMENT FT-HOTEL', 'FT-HOTEL'));
    // The office directory (saved with an upload, as in the negative case) so the first pass can match the new row.
    warmStore.create({ source: { filename: 'anz-export-fictional.csv', bytesBase64: ANZ.toString('base64') }, columns: { date: '', amount: '', narrative: '', reference: '' }, dateFormat: 'YYYY-MM-DD', rules: RULES });
    await ok('/api/w1/runs/start', 'POST', undefined, warm);
    now = await settle(warm);
    assert.equal(now.run.step, 'review');
    reviewWithFirstPass(now.run.fetch.batchId, warmStore);
    const launches = workBrowser.launches, callsBefore = signInCalls.length;
    workBrowser.person = 'wait';
    await runCall('advance', {}, warm);
    for (let i = 0; i < 300 && signInCalls.length < callsBefore + 1; i++) await wait(10);
    assert.equal(signInCalls.length, callsBefore + 1, `openForSignIn called: ${JSON.stringify(await warm.status().then(s => [s.working, s.note, s.run.step, s.run.attention, s.ask]))}`);
    now = await stop(warm);
    assert.equal(now.run.step, 'sign_in'); assert.match(String(now.note), /Stopped/);
    assert.equal(workBrowser.launches, launches, 'the open work browser is reused');
    assert.deepEqual(warmPortal.effects, []);
    workBrowser.person = 'sign-in';
    scenarios.warmSignInStop = { step: now.run.step, note: now.note, launches: workBrowser.launches, signInCalls: signInCalls.length, effects: warmPortal.effects.length };
    pass('Warm path (own run): browser already open, REI signed out → REI\'s sign-in page handed to the person; Stop while they have not signed in ends the handover, the run stays at sign-in and nothing happened in REI');
  }

  // ── 9. Nothing pressed that posts; no network; interlock clean ──
  assert.ok(portal.effects.every(effect => effect === 'upload'), 'Bud never pressed Process Receipts or Receipt All');
  assert.deepEqual(blockedFetches, []); interlock.assertClean();
  pass(`Bud pressed nothing that posts (${portal.effects.length} approved uploads only); no network; interlock clean over ${portal.calls.length} portal commands`);
} catch (cause) {
  failure = cause instanceof Error ? cause.stack : String(cause);
  console.error(failure);
} finally {
  for (const item of dbs) try { item.close(); } catch { /* closed */ }
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    at: new Date().toISOString(), label: 'w1-dry-run-fictional', tier: 'local lab (source modules in one Node process); not packaged, not installed, not live',
    passed: !failure && !failures.length, node: process.version, checks, failures, bugs, failure, scenarios,
    interlock: { trips: interlock.trips, portalCommands: portal.calls.length, blockedFetches, loopbackFetches },
    sources: Object.fromEntries(['server/w1-host.ts', 'server/w1-workflow.ts', 'server/w1-state.ts', 'server/w1-rei-workflow.ts', 'server/w1-rei-reconciliation.ts', 'server/bank-reference-match.ts', 'server/browser-sign-in.ts',
      'server/native-browser-runtime.ts', 'server/testing/fictional-rei-portal.ts', 'scripts/qa-workflows-dryrun.mjs'].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
    limits: ['FICTIONAL bank rows (ANZ-shaped fixture) and FICTIONAL REI-style portal only. No Redbark, bank, REI Cloud, customer account or credential was used.',
      'The fictional portal\'s File Format, matching and register layout are guesses; real REI acceptance is unqualified.',
      'The person (sign-in, approvals, processing in REI) is simulated by this script.',
      'Host routes are called through createW1Host().handle; the HTTP session gate is covered by scripts/qa-w1-simulated.mjs, not here.'],
  }, null, 2));
  rmSync(scratch, { recursive: true, force: true });
  const summary = { output, passed: checks.length, failed: failures.length + (failure ? 1 : 0), bugs: bugs.map(b => b.id) };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failure || failures.length ? 1 : 0;
  // Background handovers and timers end with the process.
  setTimeout(() => process.exit(process.exitCode), 200).unref();
}
