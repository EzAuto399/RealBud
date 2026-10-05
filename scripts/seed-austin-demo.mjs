// Austin showcase demo host: one FICTIONAL Austin-shaped office in a fresh,
// disposable RealBud data folder, never ~/.realbud. It starts the real source
// service with the built UI, plus loopback fakes for every outside system:
//   Gmail       fixture managed connector (rbc_ credential) serving the seed mailbox
//   Redbark     fake bank feed with the live REST shapes behind the lab provider
//   REI         the fictional REI-style portal (server/testing/fictional-rei-portal.ts)
//   Model       pack/workflows/austin-showcase/demo-worker.mjs (deterministic, no model)
//   Website     a mock office grant (scripts/testing/mock-worker-grant.mjs)
// The service process runs behind a fetch guard that refuses every non-loopback
// address, so nothing can be sent, paid or imported to a real system.
// Seed: pack/workflows/austin-showcase/fixtures/ (every record is synthetic).
//
//   node scripts/seed-austin-demo.mjs [--root <dir under the temp folder>] [--port 8899] [--no-browser]
// Node 24+. Needs a built UI: REALBUD_UI_DIR=<dir from `pnpm exec vite build --outDir <dir>`>
// (defaults to dist/). With PLAYWRIGHT_MODULE (+ CHROME_EXECUTABLE) it opens a
// connected browser window for the presenter; Ctrl+C stops everything.
// scripts/qa-austin-showcase.mjs imports startAustinDemo().
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
import { provisionMockWorkerGrant } from './testing/mock-worker-grant.mjs';
import { readSessionToken, primeBrowserSession } from './local-session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const showcase = join(root, 'pack/workflows/austin-showcase');
export const seed = JSON.parse(readFileSync(join(showcase, 'fixtures/seed.json'), 'utf8'));
const ZONE = seed.office.timeZone;
export const localDate = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
export const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const wait = ms => new Promise(r => setTimeout(r, ms));
const money = cents => (cents / 100).toFixed(2);
const property = code => seed.properties.find(p => p.code === code);
const within = (parent, child) => { const part = relative(parent, child); return Boolean(part) && part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep); };

/** Bill facts relative to the run day, so the demo always looks current. */
export function billFacts(bill, today = localDate()) {
  const invoiceDate = addDays(today, -bill.daysAgo);
  return { invoiceDate, dueDate: addDays(invoiceDate, bill.dueInDays) };
}

function mailbox(today) {
  const sentAt = daysAgo => Date.parse(`${addDays(today, -daysAgo)}T00:00:00Z`) + 9 * 3_600_000 - 10 * 3_600_000; // 9am Brisbane
  const message = (t, body) => ({ id: t.messageId, threadId: t.threadId, at: Math.min(sentAt(t.daysAgo), Date.now() - 60_000), direction: 'incoming', from: t.from, to: seed.office.gmail.address, subject: t.subject, body, bodyTruncated: false, attachments: [] });
  const billBody = b => {
    const { invoiceDate, dueDate } = billFacts(b, today);
    const facts = `Fictional ${b.kind.toLowerCase()} invoice for ${b.property} ${property(b.property).address}. Invoice number ${b.invoiceId}. Supplier: ${b.vendor}. Kind: ${b.kind}. Invoice date ${invoiceDate}. Amount AUD ${money(b.amountCents)}. Due ${dueDate}. No payment is recorded.`;
    if (b.forwarded) return `Fictional note from the office: please file this one.\n\n---------- Forwarded message ----------\nFrom: ${b.vendor} <rates@fictional-council.example.invalid>\n${facts}`;
    if (b.corrected) return `This corrected invoice replaces the earlier ${b.invoiceId}; the amount and due date changed. ${facts}`;
    return facts;
  };
  return [
    ...seed.mailbox.triage.map(t => ({ id: t.threadId, historyComplete: true, messages: [message(t, `SYNTHETIC. ${t.body}`)] })),
    ...seed.mailbox.bills.map(b => ({ id: b.threadId, historyComplete: true, messages: [message(b, `SYNTHETIC. ${billBody(b)}`)] })),
  ];
}

/** Fixture Gmail connector (Google OAuth stand-in), shaped like scripts/qa-morning-mail.mjs. */
function startConnector(credential, threads, counts) {
  const GMAIL = seed.office.gmail.accountId;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${credential}` || req.headers['x-realbud-profile'] !== 'property') { res.writeHead(403); res.end('{"error":"fixture_denied"}'); return; }
    let raw = ''; for await (const part of req) raw += part;
    if (req.url === '/v1/connectors/status') {
      counts.status++;
      res.end(JSON.stringify({ managed: true, checkedAt: new Date().toISOString(), serviceExpiresAt: Date.now() + 3_600_000, services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: GMAIL, label: seed.office.gmail.label, status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: ['GMAIL_GET_PROFILE', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID'] } }));
      return;
    }
    if (req.url === '/v1/connectors/mail-scan' || req.url === '/v1/connectors/mail-history-scan') {
      const body = JSON.parse(raw), scope = body.scope;
      if (body.expectedAccountId !== GMAIL || !scope) { res.writeHead(409); res.end('{}'); return; }
      const history = req.url.endsWith('history-scan');
      counts[history ? 'history' : 'scan']++;
      const inWindow = threads.filter(t => t.messages.every(m => m.at >= scope.windowStartAt && m.at < scope.windowEndAt));
      res.end(JSON.stringify({ accountId: GMAIL, windowStartAt: scope.windowStartAt, windowEndAt: scope.windowEndAt, ...(history ? {} : { pages: 1, paginationComplete: true, gaps: [] }), threads: history ? inWindow : threads }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return server;
}

/** Fake Redbark (bank link stand-in) with live REST shapes and the lab's synthetic key. */
function startRedbark(key, today, log) {
  const A = seed.redbark.account;
  const account = { id: A.id, object: 'account_item', connection: A.connection, provider: 'fiskil', category: 'banking', name: A.name, type: 'transaction',
    institution: { id: 'inst_fk_anz_fictional', name: 'ANZ (fictional)', logo: null }, account_number: `xxxx${A.last4}`, currency: 'aud', status: 'available',
    last_updated_at: `${today}T00:30:00.000Z`, livemode: true, created: '2026-08-21T09:30:00.000Z', updated: `${today}T00:30:00.000Z` };
  const ledger = seed.redbark.rows.map(row => {
    const date = addDays(today, -row.daysAgo), status = row.status ?? 'posted';
    return { id: row.id, object: 'transaction', account: A.id, status, date, datetime: `${addDays(date, -1)}T17:18:00.000Z`,
      post_date: status === 'posted' ? date : null, post_datetime: status === 'posted' ? `${addDays(date, -1)}T17:20:00.000Z` : null, value_date: null, value_datetime: null,
      description: `FICTIONAL PAYMENT ${row.reference}`, reference: row.reference, extended_description: null, amount: { amount: row.amountCents, currency: 'aud' }, direction: 'credit',
      provider_category: 'TRANSFER_IN', category: null, merchant_name: null, merchant_category_code: null, livemode: true };
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake'), send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${key}` || !req.headers['redbark-version']) return send(401, { error: { type: 'authentication_error' } });
    log.push(url.pathname);
    const page = items => send(200, { object: 'list', data: items, next_page_url: null, previous_page_url: null });
    if (url.pathname === '/v2/accounts') return page([account]);
    if (url.pathname === '/v2/transactions') {
      const q = Object.fromEntries(url.searchParams);
      return page(ledger.filter(row => row.account === q.account && row.date >= q.from && row.date <= q.to && (q.include_pending !== 'false' || row.status === 'posted'))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)));
    }
    send(404, { error: { type: 'invalid_request_error' } });
  });
  return { server, ledger };
}

const freePort = async () => { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };

/**
 * Starts (and on first use seeds) the demo office. Returns handles for a QA
 * driver; `stop()` ends the service and the fakes. The root must be inside the
 * system temp folder (the mock office grant refuses anything else).
 */
export async function startAustinDemo({ demoRoot, port, uiDir = process.env.REALBUD_UI_DIR || join(root, 'dist'), log = () => {} } = {}) {
  demoRoot = demoRoot ? resolve(demoRoot) : mkdtempSync(join(realpathSync(tmpdir()), 'realbud-austin-demo-'));
  mkdirSync(demoRoot, { recursive: true, mode: 0o700 });
  demoRoot = realpathSync(demoRoot);
  assert.ok(within(realpathSync(tmpdir()), demoRoot), `The demo folder must be inside ${realpathSync(tmpdir())}; it is never your office data.`);
  const realOffice = resolve(process.env.REALBUD_DATA_DIR || join(homedir(), '.realbud'));
  assert.ok(demoRoot !== realOffice && !within(demoRoot, realOffice) && !within(realOffice, demoRoot), 'Refusing to put the demo near real office data.');
  assert.ok(existsSync(join(uiDir, 'index.html')), `No built UI at ${uiDir}. Run: pnpm exec vite build --outDir <scratch> and set REALBUD_UI_DIR.`);
  const home = join(demoRoot, 'home'), data = join(home, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const marker = join(data, 'austin-showcase-seed.json'), fresh = !existsSync(marker);
  const today = localDate();

  // Fakes. The credential is a synthetic fixture value, not a secret.
  const credential = `rbc_${'a'.repeat(64)}`;
  const gmailCalls = { status: 0, scan: 0, history: 0 }, redbarkCalls = [];
  const threads = mailbox(fresh ? today : JSON.parse(readFileSync(marker, 'utf8')).today);
  const connector = startConnector(credential, threads, gmailCalls);
  const { FICTIONAL_REDBARK_KEY } = await import(pathToFileURL(join(root, 'server/testing/w1-lab.ts')).href);
  const redbark = startRedbark(FICTIONAL_REDBARK_KEY, today, redbarkCalls);
  connector.listen(0, '127.0.0.1'); redbark.server.listen(0, '127.0.0.1');
  await Promise.all([once(connector, 'listening'), once(redbark.server, 'listening')]);
  const endpoint = `http://127.0.0.1:${connector.address().port}`, redbarkBase = `http://127.0.0.1:${redbark.server.address().port}`;

  // Bud's CLI: the deterministic demo worker behind a generated header.
  const worker = join(demoRoot, 'demo-worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nconst DATA = ${JSON.stringify(data)};\nconst CHANGE = ${JSON.stringify(seed.sherryRules.scriptedChange)};\n${readFileSync(join(showcase, 'demo-worker.mjs'), 'utf8')}`, { mode: 0o700 });
  chmodSync(worker, 0o700);
  // On Windows server/env-path.ts runs a node-shebang script as `node <script>` (not yet tried on Windows).
  const cli = worker;
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { hermes: { driver: 'hermesAgent', config: { cli } } }, composio: { managed: { endpoint, credential, profile: 'property' } } }), { mode: 0o600 });
  if (fresh) provisionMockWorkerGrant({ home, data, endpoint, credential, companyId: 'fictional-austin-demo-office', hostInstallationId: 'fictional-austin-demo-host' });

  // Loopback-only: every non-127.0.0.1 address is refused inside the service.
  const guard = join(demoRoot, 'network-guard.mjs');
  writeFileSync(guard, `const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.hostname!=='127.0.0.1')return Promise.reject(new Error('Austin demo: outside network refused ('+url.origin+')'));return realFetch(input,init);};`, { mode: 0o600 });
  port ??= await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, join(root, 'server/bootstrap.ts')], { cwd: root, env: {
    ...serviceSmokeEnv({ executable: process.execPath, home, data, scratch: home, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_HERMES_CLI: cli,
    REALBUD_TEST_LAB: '1', REALBUD_TEST_W1_FICTIONAL_REI: '1', REALBUD_TEST_REDBARK_BASE: redbarkBase, OMB_STATIC_DIR: uiDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(r => child.once('close', r));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-40_000); });
  const stop = async () => {
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 5_000); await closed; clearTimeout(force); }
    await Promise.all([new Promise(r => connector.close(r)), new Promise(r => redbark.server.close(r))]);
  };
  try {
    let ready = false;
    for (let i = 0; i < 300 && child.exitCode === null; i++) { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null))?.pid === child.pid) { ready = true; break; } await wait(100); }
    assert.ok(ready, `The demo service did not start.\n${logs}`);
    const token = await readSessionToken(data);
    const request = async (path, method = 'GET', body, expected = 200) => {
      const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await res.json().catch(() => null); assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    };
    const demo = { base, data, home, demoRoot, today, request, fetch, token, stop, logs: () => logs, gmailCalls, redbarkCalls, ledger: redbark.ledger, threads, seeded: [], skipped: [] };
    if (fresh) { await seedOffice(demo, log); writeFileSync(marker, JSON.stringify({ synthetic: true, seededAt: new Date().toISOString(), today, seeded: demo.seeded, skipped: demo.skipped }), { mode: 0o600 }); }
    else { const saved = JSON.parse(readFileSync(marker, 'utf8')); demo.seeded = saved.seeded; demo.skipped = saved.skipped; demo.today = saved.today; }
    return demo;
  } catch (error) { await stop(); throw error; }
}

async function seedOffice(demo, log) {
  const { request, data, today } = demo;
  const note = text => { demo.seeded.push(text); log(`seeded: ${text}`); };
  await completeFictionalOnboarding(request);
  await request('/api/hermes/apply-pack', 'POST', {});
  const pack = await request(`/api/customer-packs/${seed.office.workflowPackId}/export`), preview = await request('/api/customer-packs/preview', 'POST', { pack });
  await request('/api/customer-packs/install', 'POST', { pack, expectedDigest: preview.digest });
  const recipes = (await request('/api/recipes')).recipes;
  for (const id of ['wf-austin-accounts-inbox-triage', 'wf-austin-accounts-invoice-review', 'wf-austin-accounts-bill-exceptions']) {
    const recipe = recipes.find(r => r.id === id); assert.ok(recipe, `pack recipe ${id}`);
    await request(`/api/recipes/${id}`, 'PATCH', { expectedRevision: recipe.revision, planApproved: true, status: 'active' });
  }
  const status = await request('/api/hermes'); assert.ok(status.workerFingerprint, 'worker fingerprint');
  writeFileSync(join(data, 'hands-ping.json'), JSON.stringify({ at: Date.now(), ok: true, detail: 'Fictional demo worker readiness; not a live model test', kind: 'ping', workerFingerprint: status.workerFingerprint }), { mode: 0o600 });
  let setup = await request('/api/agency-setup');
  setup = await request('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, agencyName: seed.office.agencyName, workflowPackId: seed.office.workflowPackId, timeZone: ZONE } });
  note(`office "${seed.office.agencyName}", ${ZONE}, austin-office pack installed, 3 plans approved (mock office grant, demo worker)`);

  // Desk book: add the six properties, then the REI ledger stub as CSV.
  const ids = {};
  let snap;
  for (const p of seed.properties) {
    snap = await request('/api/desk/properties', 'POST', { address: p.address, tenantName: p.tenant.name, tenantPhone: p.tenant.phone, weeklyRentCents: p.weeklyRentCents, propertyCode: p.code, ...(p.options ? { options: p.options } : {}) }, 201);
    ids[p.code] = snap.properties.find(item => item.propertyCode === p.code).id;
  }
  const csv = ['propertyCode,daysSinceDue,rentLanded,levyPaid', ...seed.reiLedger.rows.map(r => [r.code, r.daysSinceDue, r.rentLanded, r.levyPaid].join(','))].join('\n');
  const ledgerPreview = await request('/api/desk/import/preview', 'POST', { csv });
  assert.equal(ledgerPreview.matched.length, seed.properties.length, JSON.stringify(ledgerPreview));
  snap = await request('/api/desk/import', 'POST', { csv, expectedDigest: ledgerPreview.digest, expectedRevision: ledgerPreview.expectedRevision, observedAt: ledgerPreview.observedAt });
  assert.equal(snap.properties.length, seed.properties.length);
  demo.propertyIds = ids;
  note(`Desk book: ${snap.properties.length} fictional properties; REI ledger stub imported as CSV`);

  // Gmail (fixture connector) + both mail plans reviewed.
  await request('/api/connected-apps/check', 'POST', {});
  setup = await request('/api/agency-setup');
  const propertyReferences = seed.properties.map(p => ({ propertyId: ids[p.code], reference: p.code, aliases: [p.address] }));
  setup = await request('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, gmailAccountId: seed.office.gmail.accountId, selectedWorkflows: ['bills-calendar', 'morning-priorities'], propertyReferences } });
  setup = await request('/api/agency-setup/check-gmail', 'POST', { expectedRevision: setup.state.revision });
  for (const id of ['morning-priorities', 'bills-calendar']) {
    const workflow = setup.workflows.find(w => w.id === id); assert.ok(workflow?.canReview, JSON.stringify(workflow));
    await request(`/api/agency-setup/workflows/${id}/review`, 'POST', { expectedRevision: setup.state.revision, expectedEvidenceDigest: workflow.evidenceDigest });
    setup = await request('/api/agency-setup');
  }
  for (let i = 0; i < 300; i++) { const mail = await request('/api/mail-workspace'); if (mail.history?.state !== 'checking') break; await wait(100); }
  note(`fictional Gmail inbox ${seed.office.gmail.accountId} (fixture connector): ${seed.mailbox.triage.length} morning items, ${seed.mailbox.bills.length} invoices incl. a forwarded copy and a corrected version`);

  // W1: tenant reference directory + bank settings.
  const rules = seed.properties.map(p => ({ propertyId: p.code, reference: p.tenant.reiTenantRef, aliases: [p.tenant.reiTenantRef], tenant: p.tenant.name }));
  await request('/api/bank-reference', 'POST', { csv: `Date,Amount,Narrative,Reference\n${addDays(today, -60)},1.00,FICTIONAL SEED,\n`, columns: { date: 'Date', amount: 'Amount', narrative: 'Narrative', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules });
  await request('/api/w1/settings', 'PUT', { account: seed.redbark.account.id, reiBusiness: seed.office.rei.business, expectedRevision: 0 });
  note(`bank: tenant reference directory (${rules.length}), fictional trust account ${seed.redbark.account.id}, fictional REI business ${seed.office.rei.business}`);

  // W4: supplier list + last month's reviewed maintenance invoices.
  const suppliers = readFileSync(join(showcase, 'fixtures/supplier-directory.csv'), 'utf8');
  const directory = await request('/api/supplier-directory');
  await request('/api/supplier-directory/import', 'POST', { csv: suppliers, expectedRevision: directory.revision ?? directory.directory?.revision ?? 0 });
  const accepted = await seedMaintenanceHistory(data, ids, today);
  note(`maintenance: supplier list (${suppliers.trim().split('\n').length - 1}) and ${accepted} reviewed invoices from last month`);

  // W5: Sherry's inspection rules; history only if the inspections import exists.
  const ruleState = await request('/api/inspection-rules');
  await request('/api/inspection-rules', 'PUT', { rules: seed.sherryRules.inspectionRules, expectedRevision: ruleState.revision });
  const probe = (await demo.fetch(demo.base + '/api/inspections', { headers: { 'x-realbud-session': demo.token } })).status;
  if (probe === 200) {
    const state = await request('/api/inspections');
    const history = readFileSync(join(showcase, 'fixtures/inspection-history.csv'), 'utf8');
    const imported = await request('/api/inspections/history/import', 'POST', { csv: history, expectedRevision: state.history?.revision ?? 0 });
    note(`inspections: Sherry's rules and history for ${imported.history?.properties?.length ?? imported.history?.rows?.length ?? 'the'} properties (${imported.history?.unmatched?.length ?? 0} unmatched)`);
  } else { note("inspections: Sherry's rules saved"); demo.skipped.push(`W5 inspection history: /api/inspections answered ${probe}, so the history import is not in this build yet.`); }

  // Show every Desk section the demo uses.
  const tabs = await request('/api/workspace-tabs');
  if (tabs.state) await request('/api/workspace-tabs', 'PUT', { version: 2, tabs: tabs.state.tabs, desk: { sections: tabs.state.desk.sections.map(s => ({ ...s, visible: true })) }, expectedRevision: tabs.state.revision });
}

/** Reviewed maintenance bills go through SourceBillRegister.accept (the same
 * validation and duplicate holds as the Bills screen), as in qa-maintenance-review. */
async function seedMaintenanceHistory(data, ids, today) {
  const [{ SourceBillRegister, previewBillSource }, { WorkflowDatabase }] = await Promise.all([import('../server/source-bills.ts'), import('../server/workflow-database.ts')]);
  const db = new WorkflowDatabase({ dir: data });
  try {
    const register = new SourceBillRegister(db, { dataDir: data });
    const [y, m] = today.split('-').map(Number), last = new Date(Date.UTC(y, m - 2, 1));
    const day = n => `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    let count = 0;
    for (const inv of seed.mailbox.maintenance.invoices) {
      const date = day(inv.dayOfLastMonth), id = createHash('sha256').update(`austin-showcase-${count}`).digest('hex').slice(0, 16);
      const source = { accountId: seed.office.gmail.accountId, receiptId: 'fictional-showcase-receipt', threadId: `thread${id}`,
        message: { id, at: Date.parse(`${inv.receivedDayOfLastMonth ? day(inv.receivedDayOfLastMonth) : date}T00:30:00Z`), from: inv.from, subject: inv.subject, body: `SYNTHETIC. Fictional invoice ${inv.number} for ${inv.work}.`, bodyTruncated: false, attachments: [] } };
      const facts = { propertyId: ids[inv.property], kind: inv.kind ?? 'Maintenance', vendor: inv.vendor, amountCents: inv.cents, currency: 'AUD', invoiceDate: date, dueDate: null, note: 'Synthetic showcase history',
        invoiceNumber: inv.number, invoiceVersion: null, supplierReference: inv.ref ?? null, workDescription: inv.work };
      const body = { expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true, facts, reviewReason: 'Fictional earlier review (showcase seed)' };
      try { register.accept(body, source, 'fictional-reviewer'); }
      catch (error) {
        if (error.code !== 'bill_duplicate_review_required') throw error;
        const check = register.duplicateCandidates({ expectedSourceDigest: body.expectedSourceDigest, facts }, source);
        register.accept({ ...body, duplicateReview: { reviewDigest: check.reviewDigest } }, source, 'fictional-reviewer');
      }
      count++;
    }
    return count;
  } finally { db.close?.(); }
}

// ── CLI: the presenter's demo host ──────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const demo = await startAustinDemo({ demoRoot: arg('--root'), port: arg('--port') ? Number(arg('--port')) : undefined, log: line => console.log(line) });
  console.log(`\nAustin demo (FICTIONAL sample office) is running at ${demo.base}\nDemo folder: ${demo.demoRoot}  (delete it after the demo)\n${demo.skipped.map(s => `Skipped: ${s}`).join('\n')}`);
  let browser;
  if (process.env.PLAYWRIGHT_MODULE && !process.argv.includes('--no-browser')) {
    const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
    browser = await chromium.launch({ headless: false, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: null });
    await primeBrowserSession(context, demo.base, demo.token);
    await context.route('**/*', route => new URL(route.request().url()).origin === demo.base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(`${demo.base}/#/desk`);
    console.log('A connected browser window is open. Follow outputs/austin-showcase-2026-10-05/DEMO-SCRIPT.md.');
  } else console.log('Set PLAYWRIGHT_MODULE to open a connected browser window (see DEMO-SCRIPT.md).');
  console.log('Press Ctrl+C to stop.');
  const end = async () => { await browser?.close().catch(() => {}); await demo.stop(); process.exit(0); };
  process.once('SIGINT', end); process.once('SIGTERM', end);
}
