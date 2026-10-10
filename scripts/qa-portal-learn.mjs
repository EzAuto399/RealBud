// Bud learns a portal path in Ask; Refresh from REI reads REI's own list either way. Real source
// service + built UI on the FICTIONAL Austin demo office
// (scripts/seed-austin-demo.mjs) with the fictional REI-style portal behind the
// real browser runtime, broker and recipe runner (server/testing/w1-lab.ts).
// In the fictional REI the tenant list export carries a name other than the
// pack's placeholder (lab action "rename-reports"), so:
//   1. Refresh tenant list from REI reads REI's Tenants grid (no export, no card) and
//      previews rows that match REI's footer, before anything is learned;
//   2. the person asks Bud in Work to find how to export the tenant list; the
//      browser task card → Start; the person confirms the REI account once;
//      Bud (a scripted ACP worker, no model) opens REI's Reports menu with no
//      card (the pack's map); the report link opens a popup, so the page shows
//      no address to check and it asks, as do the Export Only choice and the
//      download; the person allows each once;
//   3. Bud proposes the path it took; the "Bud found how to export…" card shows
//      the exact steps; the person allows it and it is saved;
//   4. Refresh tenant list from REI still reads the grid: the learned export path
//      is never applied to it (no report, Export Only or download card), and the
//      preview's rows match REI's footer; Save.
// The person is simulated by this script. A pass proves RealBud's wiring and
// guards, never REI Cloud behaviour.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-portal-learn.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeBrowserSession } from './local-session.mjs';
import { startAustinDemo } from './seed-austin-demo.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT || join(root, `outputs/portal-learn-${new Date().toISOString().slice(0, 10)}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
const demoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-portal-learn-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [], errors = [], denied = [], shots = [];
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const REPORT = 'Tenant Contact Export (fictional)';
const REQUEST = 'Find out how to export the tenant list from rei-mock.fictional.test';
let demo, browser, page, failure;

// Bud's CLI for this run: a scripted ACP peer that drives RealBud's browser broker like a worker would. Never calls a model.
const WORKER = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('Hermes Agent v0.21.3 (2026.9.14)'); process.exit(0); }
const log = entry => { try { appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n'); } catch {} };
if (!process.argv.includes('acp')) { console.log('{}'); process.exit(0); }
let browser = null, sequence = 1;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const say = (sessionId, text) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const rpc = async (method, params) => {
  const response = await fetch(browser.url, { method: 'POST', signal: AbortSignal.timeout(15 * 60_000), headers: { 'content-type': 'application/json', ...Object.fromEntries(browser.headers.map(h => [h.name, h.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: sequence++, method, ...(params ? { params } : {}) }) });
  return (await response.json()).result;
};
const tool = async (name, args = {}) => {
  const result = await rpc('tools/call', { name, arguments: args }); const text = String(result?.content?.[0]?.text ?? '');
  log({ tool: name, args: name === 'browser_read' ? undefined : args, isError: Boolean(result?.isError), text: name === 'browser_read' ? undefined : text.slice(0, 300) });
  if (result?.isError) throw new Error(name + ': ' + text);
  return text;
};
let page = '';
const read = async tab => { for (let i = 0; i < 6; i++) { page = JSON.parse(await tool('browser_read', { tab_id: tab })).text; if (!page.includes('Loading')) return page; await new Promise(r => setTimeout(r, 100)); } return page; };
const ref = (role, name) => { const want = role + ' ' + JSON.stringify(name); const line = page.split('\n').map(l => l.trim()).find(l => / /.test(l) && (l.endsWith(want) || l.includes(want + ' '))); const found = line?.match(/@e\d+/); if (!found) throw new Error('No ' + role + ' ' + name); return found[0]; };
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { void (async () => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return out({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (method === 'session/new' || method === 'session/load') {
    browser = (params?.mcpServers ?? []).find(s => s.name === 'workbrowser' && typeof s.url === 'string') ?? null;
    return out({ jsonrpc: '2.0', id, result: { sessionId: 'fictional-portal-learn', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } } });
  }
  if (method === 'session/prompt') {
    const sessionId = params?.sessionId ?? 'fictional-portal-learn';
    const text = JSON.stringify(params?.prompt ?? []);
    if (!browser || !/Start this task/.test(text)) { say(sessionId, 'This is the fictional portal-learn worker.'); return out({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }); }
    try {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fictional-portal-learn-worker', version: '1' } });
      const tools = (await rpc('tools/list', {})).tools.map(t => t.name); log({ tools });
      const tab = JSON.parse(await tool('browser_tabs')).tabs.find(t => t.site === 'https://rei-mock.fictional.test').tab_id;
      await tool('browser_borrow', { tab_id: tab }); await read(tab);
      await tool('browser_click_semantic', { tab_id: tab, ref: ref('link', 'Reports') }); await read(tab);
      await tool('browser_click_semantic', { tab_id: tab, ref: ref('link', REPORT) }); await read(tab);
      await tool('browser_select', { tab_id: tab, ref: ref('combobox', 'Output'), values: ['Export Only'] }); await read(tab);
      await tool('browser_download', { tab_id: tab, ref: ref('button', 'Export') });
      const saved = await tool('portal_propose_path', { slot: 'tenant-list', steps: [{ verb: 'nav', label: 'Reports' }, { verb: 'click', label: REPORT }, { verb: 'select', label: 'Output', option: 'Export Only' }, { verb: 'download', label: 'Export' }] });
      await tool('browser_release');
      say(sessionId, 'The tenant list export is under Reports → ' + REPORT + ', with Output set to Export Only. ' + saved + ' Nothing in REI was changed.');
    } catch (error) { log({ error: String(error.message ?? error) }); say(sessionId, 'I stopped: ' + String(error.message ?? error)); }
    return out({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  }
  if (id !== undefined) out({ jsonrpc: '2.0', id, result: {} });
})().catch(() => { process.exitCode = 1; lines.close(); }); });
`;

const request = (...args) => demo.request(...args);
const lab = action => request('/api/w1/lab', 'POST', { action });
const status = () => request('/api/rei-directory/status');
const until = async (read, done, label, tries = 300) => { let value; for (let i = 0; i < tries; i++) { value = await read(); if (done(value)) return value; await wait(100); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const tenantsPanel = () => page.getByRole('region', { name: 'Refresh tenant list from REI', exact: true });
const logFile = () => join(demo.data, 'vault', 'bud-work', 'portal-learn-worker.jsonl');
const workerLog = () => demo && existsSync(logFile()) ? readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function openBankJob() {
  await page.goto(`${demo.base}/#/desk`);
  await page.getByRole('button', { name: /^Schedule\b/ }).first().click();
  await page.getByRole('button', { name: 'Open job: Bank reference review', exact: true }).click();
  await tenantsPanel().waitFor();
}
async function shot(name, locator) {
  if (locator) await locator.scrollIntoViewIfNeeded().catch(() => {});
  const file = `${name}.png`; await page.screenshot({ path: join(output, file), animations: 'disabled' }); shots.push(file);
}

try {
  demo = await startAustinDemo({ demoRoot });
  // From here every Ask turn runs the scripted worker (the service reads the CLI path on each spawn).
  const demoFingerprint = (await request('/api/hermes')).workerFingerprint;
  writeFileSync(join(demoRoot, 'demo-worker.mjs'), `#!${process.execPath}\nconst LOG = ${JSON.stringify(logFile())};\nconst REPORT = ${JSON.stringify(REPORT)};\n${WORKER}`, { mode: 0o700 });
  // Swapping Bud's CLI changes its fingerprint, so the demo's readiness record no longer matches and Work's
  // composer stays locked ("Bud needs a check", 8873b29f). Re-record the same fictional readiness the demo
  // seed writes (scripts/seed-austin-demo.mjs), for this worker; not a live model test.
  const { workerFingerprint } = await until(() => request('/api/hermes'), s => s.workerFingerprint && s.workerFingerprint !== demoFingerprint, 'the scripted worker\'s fingerprint');
  writeFileSync(join(demo.data, 'hands-ping.json'), JSON.stringify({ at: Date.now(), ok: true, detail: 'Fictional portal-learn worker readiness; not a live model test', kind: 'ping', workerFingerprint }), { mode: 0o600 });
  assert.equal((await request('/api/hermes')).ready, true, 'Bud is ready with the scripted worker');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, demo.base, demo.token);
  await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === demo.base) return route.continue(); denied.push(origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  // The person is signed in to REI; REI's tenant export is not where the pack's placeholder says.
  await lab('sign-in'); await lab('rename-reports');

  // ── 1. Before learning: Refresh from REI reads REI's Tenants grid, no export and no card ──
  await openBankJob();
  await tenantsPanel().getByRole('button', { name: 'Refresh tenant list from REI', exact: true }).click();
  let now = await until(status, s => s.run && !s.run.working, 'first refresh ends');
  assert.equal(now.run.phase, 'preview', JSON.stringify(now.run));
  assert.equal(now.run.preview.countMatches, true, JSON.stringify(now.run.preview));
  assert.equal(await tenantsPanel().getByRole('group', { name: 'Approval for REI', exact: true }).count(), 0);
  await tenantsPanel().getByRole('group', { name: 'REI tenant list preview', exact: true }).getByText(/read from REI's list · matches the \d+ records REI lists/).waitFor();
  await shot('1-refresh-before-learning', tenantsPanel());
  await tenantsPanel().getByRole('button', { name: 'Discard', exact: true }).click();
  await until(status, s => !s.run?.working && s.run?.phase !== 'preview', 'first preview discarded');
  pass(`Before learning, Refresh from REI read REI's Tenants grid with no card: ${now.run.preview.rows} rows match REI's ${now.run.preview.footer} records`);

  // ── 2. Work: the browser task card → Start ──
  await page.goto(`${demo.base}/#/desk`);
  await page.getByRole('button', { name: /^Work\b/ }).first().click();
  const composer = page.getByRole('textbox', { name: 'Tell Bud what outcome you need', exact: true });
  await composer.fill(REQUEST); await composer.press('Enter');
  const card = page.getByRole('region', { name: 'Browser task', exact: true }).last();
  await card.getByText(/rei-mock\.fictional\.test/).first().waitFor();
  await shot('2-browser-task-card', card);
  await card.getByRole('button', { name: 'Start this task', exact: true }).click();
  pass('Work shows the browser task card for rei-mock.fictional.test; the person pressed Start this task');

  // ── 3. Account once, then only the steps the map and the task's read scope do not cover ask ──
  const allow = page.getByRole('button', { name: /^(Allow once|Continue in this account)$/ });
  const cards = [];
  for (let i = 0; i < 6; i++) {
    await allow.first().waitFor({ timeout: 60_000 });
    const pending = page.getByText('Pending approval', { exact: true }).last().locator('xpath=ancestor::div[contains(@class, "rounded-t-2xl")][1]');
    const text = (await pending.innerText().catch(() => page.locator('body').innerText())).replace(/\s+/g, ' ');
    const kind = /Check the account/.test(text) ? 'account' : /Bud found how to export/.test(text) ? 'proposal' : 'step';
    cards.push({ kind, text: text.slice(0, 400) });
    if (kind === 'proposal') break;
    await shot(`3-${kind}-${i + 1}`, allow.first());
    await page.getByRole('button', { name: kind === 'account' ? 'Continue in this account' : 'Allow once', exact: true }).first().click(); await wait(300);
  }
  assert.deepEqual(cards.map(card => card.kind), ['account', 'step', 'step', 'step', 'proposal'], JSON.stringify(cards));
  assert.match(cards[0].text, /Signed in to rei-mock\.fictional\.test as FICT1\. Continue in this account\?/);
  const proposal = cards[4].text;
  assert.match(proposal, new RegExp(`Bud found how to export the Tenants list: Reports → ${REPORT.replace(/[()]/g, '\\$&')} → Export Only → Export\\. Use this for Refresh from REI\\?`), proposal);
  const explored = cards.filter(card => card.kind === 'step').map(card => card.text);
  assert.ok(explored.every(text => !/Reports"/.test(text)), `no card for the Reports menu: ${JSON.stringify(explored)}`);
  assert.ok(explored[0].includes(REPORT), explored[0]);
  assert.match(explored[1], /Export Only/);
  assert.match(explored[2], /Download/i);
  const clicks = workerLog().filter(entry => entry.tool === 'browser_click_semantic');
  assert.ok(clicks.length === 2 && clicks.every(entry => !entry.isError), JSON.stringify(workerLog()));
  assert.ok(workerLog().some(entry => entry.tools?.includes('portal_propose_path')), 'the propose tool is offered on a mapped Ask task');
  pass(`The REI account (FICT1) was confirmed once; REI's Reports menu opened with no card; the person allowed ${explored.length} steps once each: the "${REPORT}" link (no address on the page to check), the Export Only choice and the download`);

  // ── 4. The proposal card → Allow → saved ──
  await shot('4-proposal-card', allow.first());
  await page.getByRole('button', { name: 'Allow once', exact: true }).first().click();
  await page.getByText(/Saved as the tenant-list path \(version 1\)/).first().waitFor({ timeout: 60_000 });
  const saved = JSON.parse(readFileSync(join(demo.data, 'portal-path-overrides.json'), 'utf8')).slots['rei-cloud/tenant-list'];
  assert.equal(saved.current, 1);
  assert.deepEqual(saved.versions[0].steps.map(s => s.verb), ['nav', 'click', 'select', 'download']);
  assert.ok(saved.versions[0].provenance.grantId && saved.versions[0].provenance.urls.includes('/report/reportlist'), JSON.stringify(saved.versions[0].provenance));
  const evidence = readFileSync(join(demo.data, 'portal-path-evidence.json'), 'utf8');
  assert.ok(!/Fictional Tenant|value=/.test(evidence), 'step evidence holds no page contents or field values');
  await shot('4-path-saved');
  pass(`"Bud found how to export…" card shows the exact steps; Allow saved version 1 with provenance (task ${saved.versions[0].provenance.grantId.slice(0, 8)}…, paths ${saved.versions[0].provenance.urls.join(', ')})`);
  const stop = page.getByRole('region', { name: 'Browser task', exact: true }).last().getByRole('button', { name: /^Stop/ });
  if (await stop.count()) await stop.first().click().catch(() => {});

  // ── 5. Refresh from REI still reads the grid: a learned export path is never applied to it ──
  await until(status, s => !s.run?.working, 'browser free');
  await openBankJob();
  await tenantsPanel().getByRole('button', { name: 'Refresh tenant list from REI', exact: true }).click();
  const preview = tenantsPanel().getByRole('group', { name: 'REI tenant list preview', exact: true });
  await preview.getByText(/read from REI's list · matches the \d+ records REI lists/).waitFor();
  assert.equal(await tenantsPanel().getByRole('group', { name: 'Approval for REI', exact: true }).count(), 0, 'no report, Export Only or download card');
  await shot('5-refresh-preview', tenantsPanel());
  now = await status();
  assert.equal(now.run.phase, 'preview'); assert.equal(now.run.preview.countMatches, true);
  await preview.getByRole('button', { name: /^Save/ }).first().click();
  now = await until(status, s => s.run?.phase === 'saved', 'tenant list saved');
  assert.equal(now.tenants.revision, 1);
  pass(`After a path was learned, Refresh from REI still read REI's grid with no card (no "${REPORT}", Export Only or download): ${now.run.preview?.rows ?? 'all'} rows matched REI's footer, Save stored revision ${now.tenants.revision}`);

  // ── 6. Nothing pressed in REI; no renderer errors; no off-origin requests ──
  assert.deepEqual((await lab('status')).effects, []);
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  pass('Nothing pressed in the fictional REI, no renderer errors and no off-origin browser requests');
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  await demo?.stop();
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    at: new Date().toISOString(), passed: !failure, label: 'fictional-portal-learn',
    layer: 'Real local source service and built UI (headless Chrome, macOS) on the fictional Austin demo office; real browser runtime, broker, path store and recipe runner over the fictional REI-style portal; a scripted ACP worker stands in for the model',
    checks, screenshots: shots, errors, deniedOrigins: denied,
    // Temp-folder paths (a download's workroom copy) are not evidence; they are dropped from the worker's log.
    worker: workerLog().map(entry => entry.text ? { ...entry, text: entry.text.replace(/"path":"[^"]*("|$)/g, '"path":"<temp>"') } : entry),
    limits: ['Fictional REI-style portal and data only; no REI account, credential, customer record or model was used.',
      'The worker is scripted: it proves RealBud lets a worker explore and propose through the broker and cards, not that a model explores well.',
      'Bud\'s readiness for the scripted worker is a fictional record this script writes, as the demo seed does; no readiness check ran.',
      'The fictional portal follows the pack map; the learned export path is exercised in Ask only, and real REI report export formats are still unconfirmed.',
      'Source service on macOS; not a packaged build, installed device or Windows. The person is simulated by this script.'],
    failure: failure ?? null, ...(failure && demo ? { diagnostic: demo.logs().slice(-8000) } : {}),
  }, null, 2));
  rmSync(demoRoot, { recursive: true, force: true });
  if (failure) process.exitCode = 1;
}
