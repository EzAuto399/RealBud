// Austin day-one rehearsal: one fictional Austin-shaped office through the nine
// steps of outputs/austin-day-one-rehearsal-2026-10-05/REPORT.md section 4, on
// ONE source service (server/bootstrap.ts) with a temp REALBUD home and a
// loopback-only network guard. Fictional data only (scripts/testing/
// austin-day-one-seed.json): fixture Gmail connector, fake Redbark, fictional
// REI portal, mock office grant and a deterministic worker in place of a model.
// Proves wiring, authority and recovery, never live providers or customers.
//
//   node scripts/qa-austin-day-one.mjs          (Node 24+, QA_OUTPUT optional)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { readSessionToken } from './local-session.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
import { windowsFilePrivacySync } from '../server/windows-file-privacy.ts';
import { fictionalWorkerModelKey, provisionMockWorkerGrant } from './testing/mock-worker-grant.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(readFileSync(join(root, 'scripts/testing/austin-day-one-seed.json'), 'utf8'));
const ZONE = seed.office.timeZone;
const localDate = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const TODAY = localDate();
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const output = resolve(process.env.QA_OUTPUT ?? join(root, `outputs/austin-day-one-${TODAY}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-austin-day-one-'));
const data = join(temp, 'data'); mkdirSync(data, { mode: 0o700 });
// Mode bits are not an ACL on Windows: protect the new home and data like the
// installed app does, or the service rightly refuses them (no-op elsewhere).
for (const dir of [temp, data]) windowsFilePrivacySync(dir, 'directory', true);
const wait = ms => new Promise(r => setTimeout(r, ms));
const steps = [];
let child, childClosed, logs = '', base, token, failure;

// ── fixture Gmail connector (Google OAuth stand-in) ────────────────────────
const GMAIL = seed.office.gmail.accountId, credential = `rbc_${'d'.repeat(64)}`;
const sentAt = daysAgo => Date.now() - daysAgo * 86_400_000 - 3_600_000;
const money = cents => (cents / 100).toFixed(2);
const message = (t, body) => ({ id: t.messageId, threadId: t.threadId, at: sentAt(t.daysAgo), direction: 'incoming', from: t.from, to: seed.office.gmail.address, subject: t.subject, body, bodyTruncated: false, attachments: [] });
const property = code => seed.properties.find(p => p.code === code);
const billFacts = b => ({ invoiceDate: localDate(sentAt(b.daysAgo)), dueDate: addDays(localDate(sentAt(b.daysAgo)), b.dueInDays) });
const threads = [
  ...seed.mailbox.triage.map(t => ({ id: t.threadId, historyComplete: true, messages: [message(t, t.body)] })),
  ...seed.mailbox.bills.map(b => ({ id: b.threadId, historyComplete: true, messages: [message(b,
    `Fictional ${b.kind.toLowerCase()} invoice for ${b.property} ${property(b.property).address}. Invoice number ${b.invoiceId}. Supplier: ${b.vendor}. Kind: ${b.kind}. Invoice date ${billFacts(b).invoiceDate}. Amount AUD ${money(b.amountCents)}. Due ${billFacts(b).dueDate}. No payment is recorded.`)] })),
];
const gmailLog = { status: 0, scan: 0, history: 0 };
const connector = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== `Bearer ${credential}` || req.headers['x-realbud-profile'] !== 'property') { res.writeHead(403); res.end('{"error":"fixture_denied"}'); return; }
  let raw = ''; for await (const part of req) raw += part;
  if (req.url === '/v1/connectors/status') {
    gmailLog.status++;
    res.end(JSON.stringify({ managed: true, checkedAt: new Date().toISOString(), serviceExpiresAt: Date.now() + 3_600_000, services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: GMAIL, label: seed.office.gmail.label, status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: ['GMAIL_GET_PROFILE', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID'] } }));
    return;
  }
  if (req.url === '/v1/connectors/mail-scan' || req.url === '/v1/connectors/mail-history-scan') {
    const body = JSON.parse(raw), scope = body.scope;
    if (body.expectedAccountId !== GMAIL || !scope) { res.writeHead(409); res.end('{}'); return; }
    const history = req.url.endsWith('history-scan');
    gmailLog[history ? 'history' : 'scan']++;
    const inWindow = threads.filter(t => t.messages.every(m => m.at >= scope.windowStartAt && m.at < scope.windowEndAt));
    res.end(JSON.stringify({ accountId: GMAIL, windowStartAt: scope.windowStartAt, windowEndAt: scope.windowEndAt, ...(history ? {} : { pages: 1, paginationComplete: true, gaps: [] }), threads: history ? inWindow : threads }));
    return;
  }
  res.writeHead(404); res.end('{}');
});

// ── fake Redbark (Redbark link stand-in): live REST shapes, synthetic key ──
const { FICTIONAL_REDBARK_KEY } = await import(pathToFileURL(join(root, 'server/testing/w1-lab.ts')).href);
const ACCOUNT = seed.redbark.account;
const redbarkAccount = { id: ACCOUNT.id, object: 'account_item', connection: ACCOUNT.connection, provider: 'fiskil', category: 'banking', name: ACCOUNT.name, type: 'transaction',
  institution: { id: 'inst_fk_anz_fictional', name: 'ANZ (fictional)', logo: null }, account_number: `xxxx${ACCOUNT.last4}`, currency: 'aud', status: 'available',
  last_updated_at: `${TODAY}T00:30:00.000Z`, livemode: true, created: '2026-08-21T09:30:00.000Z', updated: `${TODAY}T00:30:00.000Z` };
const ledger = seed.redbark.rows.map(row => {
  const date = addDays(TODAY, -row.daysAgo), status = row.status ?? 'posted';
  return { id: row.id, object: 'transaction', account: ACCOUNT.id, status, date, datetime: `${addDays(date, -1)}T17:18:00.000Z`,
    post_date: status === 'posted' ? date : null, post_datetime: status === 'posted' ? `${addDays(date, -1)}T17:20:00.000Z` : null, value_date: null, value_datetime: null,
    description: `FICTIONAL PAYMENT ${row.reference}`, reference: row.reference, extended_description: null, amount: { amount: row.amountCents, currency: 'aud' }, direction: 'credit',
    provider_category: 'TRANSFER_IN', category: null, merchant_name: null, merchant_category_code: null, livemode: true };
});
const redbarkLog = [];
const fakeRedbark = createServer((req, res) => {
  const url = new URL(req.url, 'http://fake'), send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${FICTIONAL_REDBARK_KEY}` || !req.headers['redbark-version']) return send(401, { error: { type: 'authentication_error' } });
  redbarkLog.push(url.pathname);
  const page = items => send(200, { object: 'list', data: items, next_page_url: null, previous_page_url: null });
  if (url.pathname === '/v2/accounts') return page([redbarkAccount]);
  if (url.pathname === '/v2/transactions') {
    const q = Object.fromEntries(url.searchParams);
    return page(ledger.filter(row => row.account === q.account && row.date >= q.from && row.date <= q.to && (q.include_pending !== 'false' || row.status === 'posted'))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)));
  }
  send(404, { error: { type: 'invalid_request_error' } });
});

// ── deterministic worker (model stand-in) ─────────────────────────────────
// Branches on the job: the morning ledger answer comes from the seed's REI
// ledger stub; inbox triage and invoice preparation answer the host-written
// input that was written last. Every call is logged in Bud's work folder.
const worker = join(temp, 'fictional-worker.mjs'), budWork = join(data, 'vault', 'bud-work');
const workerCalls = join(budWork, 'worker-calls.json'), ledgerStub = join(budWork, 'rei-ledger-stub.json');
writeFileSync(worker, `#!${process.execPath}
import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('Hermes Agent v0.21.3 (2026.9.14)');process.exit(0);}
if(process.env.REALBUD_MODEL_API_KEY===${JSON.stringify(fictionalWorkerModelKey)}||!/^[a-f0-9]{64}$/.test(process.env.REALBUD_MODEL_API_KEY??''))throw new Error('Fictional worker did not receive an isolated relay token');
const log=(kind,count)=>{let calls=[];try{calls=JSON.parse(readFileSync(${JSON.stringify(workerCalls)},'utf8'));}catch{}calls.push({kind,count});writeFileSync(${JSON.stringify(workerCalls)},JSON.stringify(calls));};
const answer=result=>console.log(JSON.stringify({summary:'Fictional deterministic preparation',evidence:['Fictional fixture sources'],outputs:[JSON.stringify(result)],needsApproval:[]}));
if(process.argv.join(' ').includes('Morning arrears check')){const rows=JSON.parse(readFileSync(${JSON.stringify(ledgerStub)},'utf8'));log('ledger',rows.length);console.log(JSON.stringify(rows));process.exit(0);}
const dir=${JSON.stringify(join(data, 'vault/workflow-inputs'))};
const latest=['accounts-inbox.json','accounts-invoices.json'].filter(n=>existsSync(dir+'/'+n)).sort((a,b)=>statSync(dir+'/'+b).mtimeMs-statSync(dir+'/'+a).mtimeMs)[0];
if(!latest){console.log('{}');process.exit(0);}
const input=JSON.parse(readFileSync(dir+'/'+latest,'utf8'));
if(latest==='accounts-inbox.json'){
  log('inbox',input.threads.length);
  answer({version:1,kind:'accounts-inbox-triage',skillSource:'email-inbox-triage@0.1.0',sourceReference:input.sourceReference,status:'complete',coverageComplete:true,holds:[],actionsPerformed:[],
    threads:input.threads.map(t=>{const text=JSON.stringify(t);const code=(text.match(/SYN-P0[1-6]/)??['no property'])[0];
      return{threadId:t.threadId,disposition:/invoice|rates bill/i.test(text)?'reference':'action-review',owner:'property-manager',priority:/leak/i.test(text)?'high':'normal',sourceMessageIds:t.messages.map(m=>m.messageId),reason:'Fictional source names '+code+'.',nextAction:'Review internally; no external action was taken.',missingFacts:[]};})});
}else{
  const doc=input.documents[0],text=doc.subject+'\\n'+doc.body,pick=re=>(text.match(re)??[])[1]??null;
  const property=input.propertyMap.find(p=>text.includes(p.reference));log('invoice',1);
  answer({version:1,kind:'accounts-invoice-entry-review',sourceReference:input.sourceReference,status:'partial',coverageComplete:false,holds:[{itemId:'coverage',reason:'Only the selected fictional message is available.'}],actionsPerformed:[],
    documents:[{documentId:doc.documentId,decision:'hold',duplicateOf:null,conflictGroup:null,proposedEntry:{supplierId:pick(/Supplier: ([^.]+)\\./),invoiceId:pick(/Invoice number (\\S+)\\./),propertyId:property?.propertyId??null,amount:pick(/AUD ([0-9.]+)\\./),currency:'AUD',dueDate:pick(/Due (\\d{4}-\\d{2}-\\d{2})/),costType:pick(/Kind: ([^.]+)\\./)},sourceIds:[doc.sourceId],reason:'Fictional source text supplies candidate facts; staff approval remains required.'}]});
}
`, { mode: 0o700 });
const workerLog = () => { try { return JSON.parse(readFileSync(workerCalls, 'utf8')); } catch { return []; } };

// ── service ───────────────────────────────────────────────────────────────
const freePort = async () => { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
let serviceEnv;
async function startService() {
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', pathToFileURL(join(temp, 'network-guard.mjs')).href, join(root, 'server/bootstrap.ts')], { cwd: root, env: { ...serviceEnv, OMB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  childClosed = new Promise((r, reject) => { child.once('close', r); child.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-40_000); });
  let ready = false;
  for (let i = 0; i < 200 && child.exitCode === null; i++) { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null))?.pid === child.pid) { ready = true; break; } await wait(100); }
  assert.ok(ready, `source service did not start\n${logs}`);
  assert.equal((await fetch(base + '/api/desk')).status, 401, 'Desk needs the session');
  token = await readSessionToken(data);
}
async function stopService() {
  if (child?.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await childClosed; } finally { clearTimeout(force); }
}
const request = async (path, method = 'GET', body, expected = 200) => {
  const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await res.json().catch(() => null); assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
};
const until = async (read, done, label, tries = 300) => { let value; for (let i = 0; i < tries; i++) { value = await read(); if (done(value)) return value; await wait(100); } throw new Error(`${label} did not settle: ${JSON.stringify(value)}`); };
const runLoop = async (id, expectedStatus = 201) => {
  const loop = (await request('/api/loops')).loops.find(l => l.id === id);
  const accepted = await request(`/api/loops/${id}/run`, 'POST', { requestId: randomUUID(), expectedRevision: loop.revision }, expectedStatus);
  return until(async () => (await request('/api/loops')).runs.find(r => r.id === accepted.run.id), r => r && !['queued', 'running'].includes(r.status), `${id} run`);
};

// ── step bookkeeping: PASS, BLOCKED (product gap, exact reason) or FAIL ────
class Blocked extends Error {}
let stopped = null;
async function step(n, name, fn) {
  if (stopped) { steps.push({ n, name, status: 'NOT RUN', detail: `Step ${stopped} failed first.` }); console.log(`NOT RUN ${n}. ${name}`); return; }
  try { const detail = await fn(); steps.push({ n, name, status: 'PASS', detail }); console.log(`PASS ${n}. ${name}: ${detail}`); }
  catch (error) {
    if (error instanceof Blocked) { steps.push({ n, name, status: 'BLOCKED', detail: error.message }); console.log(`BLOCKED ${n}. ${name}: ${error.message}`); return; }
    stopped = n; failure = error instanceof Error ? error.stack : String(error);
    steps.push({ n, name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) }); console.error(`FAIL ${n}. ${name}\n${failure}`);
  }
}

const ids = {}; // seed code -> Desk property id
const evidence = {};
try {
  connector.listen(0, '127.0.0.1'); fakeRedbark.listen(0, '127.0.0.1');
  await Promise.all([once(connector, 'listening'), once(fakeRedbark, 'listening')]);
  const endpoint = `http://127.0.0.1:${connector.address().port}`, redbarkBase = `http://127.0.0.1:${fakeRedbark.address().port}`;
  // Loopback-only: plain http to 127.0.0.1 (the two fictional providers and the
  // service's own in-process brokers); every other origin throws.
  writeFileSync(join(temp, 'network-guard.mjs'), `const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('QA denied non-loopback fetch to '+url.origin);return realFetch(input,init);};`, { mode: 0o600 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } }, composio: { managed: { endpoint, credential, profile: 'property' } } }), { mode: 0o600 });
  serviceEnv = { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port: 0 }), REALBUD_MANAGED_SERVICE: '0', REALBUD_HERMES_CLI: worker,
    REALBUD_TEST_LAB: '1', REALBUD_TEST_W1_FICTIONAL_REI: '1', REALBUD_TEST_REDBARK_BASE: redbarkBase, OMB_STATIC_DIR: join(root, 'dist') };

  await step(1, 'Office: mock grant, onboarding, agency setup, Austin pack', async () => {
    // Website office link stand-in: the grant is redeemed against a fictional website before the service starts.
    provisionMockWorkerGrant({ home: temp, data, endpoint, credential, companyId: 'fictional-wattle-office', hostInstallationId: 'fictional-wattle-host' });
    await startService();
    const link = await request('/api/office-link');
    evidence.officeLink = { state: link.state ?? null, keys: Object.keys(link) };
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
    writeFileSync(join(data, 'hands-ping.json'), JSON.stringify({ at: Date.now(), ok: true, detail: 'Deterministic fixture readiness; not a live model test', kind: 'ping', workerFingerprint: status.workerFingerprint }), { mode: 0o600 });
    let setup = await request('/api/agency-setup');
    setup = await request('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, agencyName: seed.office.agencyName, workflowPackId: seed.office.workflowPackId, timeZone: ZONE } });
    assert.equal(setup.state.settings.timeZone, ZONE); assert.equal(setup.state.settings.workflowPackId, 'austin-office');
    return `office link read back (${JSON.stringify(evidence.officeLink)}); ${seed.office.agencyName}, ${ZONE}, austin-office installed, 3 plans approved`;
  });

  await step(2, 'Desk: office book, 6 seed properties, REI ledger CSV import', async () => {
    let snap = await request('/api/desk');
    evidence.deskAtLink = { mode: snap.mode, properties: snap.properties.length };
    // A linked office replaces the untouched sample with an empty book at boot (server/index.ts startOfficeBook).
    snap = await until(() => request('/api/desk'), s => s.mode === 'live' && s.properties.length === 0, 'empty office book', 50).catch(() => null) ?? await request('/api/desk');
    evidence.deskAfterBoot = { mode: snap.mode, properties: snap.properties.length };
    if (snap.properties.length) throw new Error(`Desk did not start empty after the office link: ${snap.properties.length} sample properties, mode ${snap.mode}`);
    // CSV import only updates facts for properties already on the book, so the book entry comes first.
    for (const p of seed.properties) {
      snap = await request('/api/desk/properties', 'POST', { address: p.address, tenantName: p.tenant.name, tenantPhone: p.tenant.phone, weeklyRentCents: p.weeklyRentCents, propertyCode: p.code, ...(p.options ? { options: p.options } : {}) }, 201);
      ids[p.code] = snap.properties.find(item => item.propertyCode === p.code).id;
    }
    const csv = ['propertyCode,daysSinceDue,rentLanded,levyPaid', ...seed.reiLedger.rows.map(r => [r.code, r.daysSinceDue, r.rentLanded, r.levyPaid].join(','))].join('\n');
    const preview = await request('/api/desk/import/preview', 'POST', { csv });
    assert.equal(preview.matched.length, 6, JSON.stringify(preview)); assert.equal(preview.unmatched.length + preview.ambiguous.length, 0);
    snap = await request('/api/desk/import', 'POST', { csv, expectedDigest: preview.digest, expectedRevision: preview.expectedRevision, observedAt: preview.observedAt });
    assert.equal(snap.properties.length, 6); assert.equal(snap.mode, 'live'); assert.equal(snap.hands, 'csv');
    assert.deepEqual(snap.properties.map(p => p.propertyCode).sort(), seed.properties.map(p => p.code));
    // The worker's morning ledger answer: the same REI ledger stub, keyed by this book's ids.
    mkdirSync(budWork, { recursive: true, mode: 0o700 });
    writeFileSync(ledgerStub, JSON.stringify(seed.reiLedger.rows.map(({ code, daysSinceDue, rentLanded, levyPaid, daysSinceCourtesy }) => ({ propertyId: ids[code], daysSinceDue, rentLanded, levyPaid, daysSinceCourtesy }))), { mode: 0o600 });
    evidence.deskDraftsAfterImport = snap.drafts.map(d => ({ code: snap.properties.find(p => p.id === d.propertyId)?.propertyCode, kind: d.kind }));
    return `empty office book at link; 6 properties added; CSV preview matched 6/6, import made the book live (hands csv)`;
  });

  await step(3, 'Gmail: fixture connector reports the inbox connected; history complete', async () => {
    await request('/api/connected-apps/check', 'POST', {});
    let setup = await request('/api/agency-setup');
    const propertyReferences = seed.properties.map(p => ({ propertyId: ids[p.code], reference: p.code, aliases: [p.address] }));
    setup = await request('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, gmailAccountId: GMAIL, selectedWorkflows: ['bills-calendar', 'morning-priorities'], propertyReferences } });
    setup = await request('/api/agency-setup/check-gmail', 'POST', { expectedRevision: setup.state.revision });
    for (const id of ['morning-priorities', 'bills-calendar']) {
      const workflow = setup.workflows.find(w => w.id === id); assert.ok(workflow?.canReview, JSON.stringify(workflow));
      await request(`/api/agency-setup/workflows/${id}/review`, 'POST', { expectedRevision: setup.state.revision, expectedEvidenceDigest: workflow.evidenceDigest });
      setup = await request('/api/agency-setup');
    }
    const mail = await until(() => request('/api/mail-workspace'), s => s.history && s.history.state !== 'checking', 'mail history');
    evidence.history = mail.history;
    assert.equal(mail.history.state, 'complete', JSON.stringify(mail.history));
    const gmailCheck = setup.workflows.find(w => w.id === 'morning-priorities').checks.find(c => c.id === 'gmail');
    assert.equal(gmailCheck?.state, 'passed', JSON.stringify(gmailCheck));
    return `${GMAIL} verified through the fixture connector; both plans reviewed; ${mail.history.detail}`;
  });

  await step(4, 'W3 morning priorities: run, items for seed mail, rerun makes no worker call', async () => {
    let state = await request('/api/mail-workspace');
    assert.equal(state.schedule.enabled, false, 'Morning priorities stays off until the office enables it');
    const run = await runLoop('inbound-triage');
    // A prepared result waits for the person's review; it is never auto-applied.
    assert.equal(run.status, 'awaiting-approval', JSON.stringify(run));
    state = await request('/api/mail-workspace');
    assert.equal(state.counts.total, threads.length, JSON.stringify(state.counts));
    const items = (await request('/api/mail-workspace/items?group=all&limit=50')).items;
    const triage = seed.mailbox.triage.map(t => items.find(i => JSON.stringify(i).includes(t.subject)));
    assert.ok(triage.every(Boolean), 'every seed triage thread is an item');
    const named = triage.filter((item, i) => JSON.stringify(item).includes(seed.mailbox.triage[i].property)).length;
    const calls = workerLog().filter(c => c.kind === 'inbox').length;
    const again = await runLoop('inbound-triage');
    assert.equal(workerLog().filter(c => c.kind === 'inbox').length, calls, 'rerun on unchanged mail calls the worker again');
    assert.ok(again.detail?.includes('No changed results'), JSON.stringify(again));
    evidence.w3 = { items: items.length, triageItemsNamingSeedProperty: named, workerCalls: calls, rerunDetail: again.detail };
    return `${items.length} items (${seed.mailbox.triage.length} triage threads; ${named}/${seed.mailbox.triage.length} name their SYN property only in source text, items carry no property link); rerun: 0 worker calls`;
  });

  await step(5, 'W2 weekly bills: run, accept one bill, bill on the calendar', async () => {
    const run = await runLoop('weekly-bills');
    assert.equal(run.status, 'awaiting-approval', JSON.stringify(run));
    const result = (await request('/api/bill-register/routine')).result;
    assert.equal(result.counts.candidates, seed.mailbox.bills.length, JSON.stringify(result.counts));
    assert.equal(result.counts.prepared, seed.mailbox.bills.length, JSON.stringify(result.counts));
    assert.equal((await request('/api/bill-register')).occurrences.total, 0, 'a run never creates a payable bill');
    const drafts = (await request('/api/bill-review-drafts?filter=active&limit=20')).items;
    const bill = seed.mailbox.bills[0], draft = drafts.find(d => d.messageId === bill.messageId); assert.ok(draft, 'draft for the first seed bill');
    const source = await request(`/api/bill-evidence/${draft.itemId}?messageId=${bill.messageId}`);
    const { invoiceDate, dueDate } = billFacts(bill);
    const facts = { propertyId: ids[bill.property], kind: bill.kind, vendor: bill.vendor, amountCents: bill.amountCents, currency: 'AUD', invoiceDate, dueDate, note: 'Fictional reviewed bill' };
    const accepted = await request('/api/bill-occurrences', 'POST', { itemId: draft.itemId, messageId: bill.messageId, expectedSourceDigest: source.digest, sourceReviewed: true, facts, reviewReason: 'Fictional person checked the saved source' });
    const register = await request(`/api/bill-register?from=${addDays(TODAY, -30)}&to=${addDays(TODAY, 60)}`);
    const due = register.calendar.items.find(e => e.type === 'invoice-due' && e.billId === accepted.id);
    assert.ok(due, `accepted bill on the calendar: ${JSON.stringify(register.calendar.items)}`);
    assert.equal(due.date, dueDate);
    evidence.w2 = { run: run.status, counts: result.counts, billId: accepted.id, calendar: due };
    return `${result.counts.candidates} bill candidates prepared, 0 bills until accepted; ${bill.vendor} ${bill.invoiceId} for ${bill.property} accepted and shown on the calendar due ${dueDate}`;
  });

  await step(6, 'W1 bank: lab Redbark rows, review, fictional REI, approve upload once, read back N/N', async () => {
    let loops = await request('/api/loops');
    evidence.bankLoopBeforeSettings = { available: loops.loops.find(l => l.id === 'bank-references').available };
    const rules = seed.properties.map(p => ({ propertyId: p.code, reference: p.tenant.reiTenantRef, aliases: [p.tenant.reiTenantRef], tenant: p.tenant.name }));
    await request('/api/bank-reference', 'POST', { csv: `Date,Amount,Narrative,Reference\n${addDays(TODAY, -60)},1.00,FICTIONAL SEED,\n`, columns: { date: 'Date', amount: 'Amount', narrative: 'Narrative', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules });
    await request('/api/w1/settings', 'PUT', { account: ACCOUNT.id, reiBusiness: seed.office.rei.business, expectedRevision: 0 });
    loops = await request('/api/loops');
    const bank = loops.loops.find(l => l.id === 'bank-references');
    if (!bank.available) throw new Blocked('bank-references stays available:false after the office saves its W1 settings.');
    const run = await runLoop('bank-references');
    assert.equal(run.status, 'awaiting-approval', JSON.stringify(run));
    const settle = () => until(() => request('/api/w1/status'), s => !s.working || s.ask, 'bank import', 600);
    const asks = [];
    const allowAll = async () => { let now = await settle(); while (now.ask) { asks.push(now.ask.tool); await request(`/api/w1/runs/${now.run.id}/answer`, 'POST', { requestId: now.ask.requestId, allowed: true }); now = await settle(); } return now; };
    const act = async (action, extra = {}) => { const now = await settle(); return request(`/api/w1/runs/${now.run.id}/${action}`, 'POST', { expectedRevision: now.run.revision, ...extra }); };
    let now = await settle();
    const posted = ledger.filter(r => r.status === 'posted').map(r => r.id).sort();
    assert.equal(now.run.step, 'review'); assert.deepEqual(now.run.fetch.transactionIds.slice().sort(), posted, 'pending row left out');
    const saved = await request(`/api/bank-reference/${now.run.fetch.batchId}`);
    await request(`/api/bank-reference/${now.run.fetch.batchId}/review`, 'POST', { revision: saved.revision, decisions: saved.value.batch.rows.map(row => {
      assert.equal(row.candidates.length, 1, `one directory match for ${row.narrative}`); return { rowId: row.id, action: 'assign', propertyId: row.candidates[0], reason: 'Fictional directory match checked' }; }) });
    await act('advance'); now = await allowAll();
    if (now.run.step === 'sign_in') { await request('/api/w1/lab', 'POST', { action: 'sign-in' }); await act('advance'); now = await allowAll(); }  // portal sign-in stand-in
    assert.equal(now.run.step, 'handoff', JSON.stringify([now.note, now.run.step, now.run.attention]));
    assert.equal(asks.filter(t => t === 'browser_upload').length, 1, `upload approved once: ${asks}`);
    await request('/api/w1/lab', 'POST', { action: 'process' }); // the person processes the receipts in REI
    await act('posting', { outcome: 'posted' }); now = await allowAll();
    assert.equal(now.run.outcome, 'imported', JSON.stringify([now.note, now.run.attention]));
    assert.deepEqual(now.readback, { accepted: posted.length, rejected: 0, pending: 0, warnings: [] });
    const portal = await request('/api/w1/lab', 'POST', { action: 'status' });
    assert.ok(portal.effects.every(e => e === 'upload'), 'Bud pressed nothing that posts');
    assert.equal((await request(`/api/w1/coverage?account=${ACCOUNT.id}`)).coveredThrough, TODAY);
    evidence.w1 = { runStatus: run.status, asks, readback: now.readback, uploads: portal.uploads, effects: portal.effects };
    return `loop became available once W1 settings were saved; pulled ${posted.length} (pending excluded), upload asked once, read back ${now.readback.accepted}/${posted.length}, coverage through ${TODAY}`;
  });

  await step(7, "Arrears and owner letters: cards for seed tenants and owners; Allow one; send stays 403", async () => {
    let snap = await request("/api/desk");
    const codeOf = id => snap.properties.find(p => p.id === id)?.propertyCode;
    // Cards the REI ledger CSV import put on Desk (step 2).
    const arrears = snap.drafts.filter(d => d.kind === "courtesy-rent" || d.kind === "levy-from-rent").map(d => `${codeOf(d.propertyId)}:${d.kind}`).sort();
    const expected = seed.reiLedger.rows.flatMap(r => !r.rentLanded && r.daysSinceDue > 0 ? [`${r.code}:courtesy-rent`] : r.rentLanded && !r.levyPaid && property(r.code).options?.levyFromRent ? [`${r.code}:levy-from-rent`] : []).sort();
    assert.deepEqual(arrears, expected, "arrears cards follow the REI ledger stub");
    const letters = await runLoop("owner-letter");
    assert.equal(letters.status, "completed", JSON.stringify(letters));
    snap = await request("/api/desk");
    const ownerLetters = snap.drafts.filter(d => d.kind === "owner-letter");
    assert.deepEqual(ownerLetters.map(d => codeOf(d.propertyId)).sort(), seed.properties.map(p => p.code));
    const card = snap.drafts.find(d => d.kind === "courtesy-rent" && d.status === "pending");
    const tenant = seed.properties.find(p => p.code === codeOf(card.propertyId)).tenant.name;
    const allowed = await request(`/api/desk/drafts/${card.id}/allow`, "POST", { expectedRevision: snap.revision });
    assert.equal(allowed.draft.status, "allowed");
    for (const draft of [card, ownerLetters[0]]) await request(`/api/desk/drafts/${draft.id}/send`, "POST", {}, 403);
    const namesOwner = ownerLetters.some(d => seed.properties.some(p => JSON.stringify(d).includes(p.owner.name)));
    const done = `arrears cards from the CSV ${arrears.join(", ")}; ${ownerLetters.length} owner letters; Allowed the ${codeOf(card.propertyId)} card; send 403 on both kinds; seed owner names in letters: ${namesOwner ? "yes" : "no (Desk has no owner field)"}`;
    // The Morning money check routine asks the worker for the same ledger.
    const morning = await runLoop("morning-arrears");
    snap = await request("/api/desk");
    const ledgerRows = workerLog().filter(c => c.kind === "ledger").at(-1)?.count;
    evidence.arrears = { csvCards: arrears, ownerLetters: ownerLetters.length, allowed: card.id, tenant, cardNamesTenant: JSON.stringify(card).includes(tenant), ownerLetterNamesSeedOwner: namesOwner,
      morningRun: { status: morning.status, detail: morning.detail }, workerLedgerRows: ledgerRows, hands: snap.hands };
    if (morning.status === "partial" && ledgerRows === seed.properties.length && /answered 1 of 6/.test(morning.detail ?? ""))
      throw new Blocked(`${done}. Morning money check: the worker printed a ${ledgerRows}-row JSON array but the run reports "${morning.detail}": parseLedgerFacts (server/hermes-hands.ts) starts from the last "{" and returns only the final object of any multi-row array, so 5 of 6 seed properties are held.`);
    assert.equal(morning.status, "completed", JSON.stringify([morning, snap.handsDetail]));
    assert.equal(snap.hands, "hermes", snap.handsDetail);
    return `${done}; Morning money check read the REI ledger stub for all 6`;
  });

  await step(8, 'Restart: everything kept, nothing reruns', async () => {
    const before = { desk: await request('/api/desk'), mail: await request('/api/mail-workspace'), bills: await request('/api/bill-register'), w1: await request('/api/w1/status'), loops: await request('/api/loops') };
    const calls = { worker: workerLog().length, gmail: { ...gmailLog }, redbark: redbarkLog.length };
    await stopService();
    await startService();
    await wait(3_000); // let boot-time work (automatic setup, office book, history) run if it would
    const after = { desk: await request('/api/desk'), mail: await request('/api/mail-workspace'), bills: await request('/api/bill-register'), w1: await request('/api/w1/status'), loops: await request('/api/loops') };
    assert.deepEqual(after.desk.properties.map(p => p.id), before.desk.properties.map(p => p.id));
    assert.deepEqual(after.desk.drafts.map(d => [d.id, d.status]), before.desk.drafts.map(d => [d.id, d.status]));
    assert.equal(after.mail.counts.total, before.mail.counts.total);
    assert.deepEqual(after.bills.occurrences.items.map(b => b.id), before.bills.occurrences.items.map(b => b.id));
    assert.equal(after.w1.run?.outcome, 'imported'); assert.equal(after.w1.run?.id, before.w1.run?.id);
    assert.deepEqual(after.loops.runs.map(r => [r.id, r.status]), before.loops.runs.map(r => [r.id, r.status]), 'no run was added or changed');
    assert.deepEqual(after.loops.loops.map(l => [l.id, l.enabled]), before.loops.loops.map(l => [l.id, l.enabled]), 'schedules keep their on/off choice');
    assert.ok(after.loops.loops.filter(l => ['inbound-triage', 'weekly-bills', 'bank-references'].includes(l.id)).every(l => !l.enabled), 'the three Austin workflow schedules stay off until the office turns them on');
    assert.deepEqual({ worker: workerLog().length, gmail: gmailLog, redbark: redbarkLog.length }, calls, 'no worker, Gmail or bank call after restart');
    evidence.restart = { properties: after.desk.properties.length, drafts: after.desk.drafts.length, mailItems: after.mail.counts.total, bills: after.bills.occurrences.items.length, runs: after.loops.runs.length, enabled: after.loops.loops.filter(l => l.enabled).map(l => l.id), calls };
    return `${after.desk.properties.length} properties, ${after.desk.drafts.length} Desk cards, ${after.mail.counts.total} mail items, ${after.bills.occurrences.items.length} bill, W1 import and ${after.loops.runs.length} runs kept; 0 new worker, Gmail or bank calls`;
  });

  await step(9, 'Receipt', async () => `written to ${join(output, 'receipt.json')}`);
} catch (error) {
  failure ??= error instanceof Error ? error.stack : String(error);
  console.error(failure);
} finally {
  await stopService().catch(() => {});
  await Promise.all([new Promise(r => connector.close(r)), new Promise(r => fakeRedbark.close(r))]);
  if (failure) writeFileSync(join(output, 'failure.log'), `${failure}\n\n${logs}`);
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    at: new Date().toISOString(), label: 'fictional-austin-day-one', tier: 'local tests (fake providers)',
    layer: 'source service (server/bootstrap.ts) on this Mac with a temp REALBUD home and a loopback-only fetch guard; API only, no renderer',
    passed: !failure && steps.every(s => s.status === 'PASS' || s.status === 'BLOCKED'), node: process.version, today: TODAY, timeZone: ZONE,
    steps, standIns: {
      'Google OAuth': 'Fixture managed connector (rbc_ credential) on loopback reports the Gmail account connected and serves the seed mailbox; no Google sign-in.',
      'Redbark link': 'Fake Redbark on loopback with the live REST shapes behind the lab bank provider (REALBUD_TEST_REDBARK_BASE, synthetic key); no Redbark link session.',
      'Portal sign-in': 'Fictional REI-style portal (server/testing/fictional-rei-portal.ts); POST /api/w1/lab sign-in and process play the person.',
      'Website office link': 'provisionMockWorkerGrant redeems a fictional website grant before the service starts; no website or Modelvia customer.',
      Model: 'Deterministic worker script: triage and invoice answers from the host-written inputs, morning ledger from the seed REI ledger stub.',
    },
    evidence, calls: { worker: workerLog(), gmail: gmailLog, redbark: redbarkLog.length },
    limits: ['Fictional data and fake providers only: no Gmail, Redbark, bank, REI Cloud, website, model, customer account or credential was used.',
      'API only: no renderer, packaged build, installed device, Windows or two-computer evidence.',
      'The person is simulated: reviews, approvals, REI sign-in and processing were done by this script.',
      'The deterministic worker proves wiring and guards, not model judgement.'],
    failure: failure ?? null,
  }, null, 2));
  rmSync(temp, { recursive: true, force: true });
  for (const s of steps) console.log(`${s.status.padEnd(7)} ${s.n}. ${s.name}`);
  if (failure) process.exitCode = 1;
}
