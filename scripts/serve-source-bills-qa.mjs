// Interactive source-UI rehearsal. All data and the worker are fictional.
// This starts no browser and never reads an installed RealBud workspace.
// Build with vite build --mode design-preview, then pass REALBUD_UI_DIR=/absolute/path.
// Use the printed fixture page for arrivals; exercise RealBud through its UI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fictionalPdf } from '../server/testing/pdf-fixture.ts';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
import { fictionalWorkerModelKey, provisionMockWorkerGrant } from './testing/mock-worker-grant.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = process.env.REALBUD_UI_DIR;
if (!ui || !isAbsolute(ui) || !existsSync(join(ui, 'index.html'))) throw new Error('Build an isolated renderer and set absolute REALBUD_UI_DIR first.');
if (!readFileSync(join(ui, 'index.html'), 'utf8').includes('<meta name="realbud-build-mode" content="design-preview"')) throw new Error('Build this fictional preview with --mode design-preview so it is labelled and live controls are disabled.');
const resume = process.env.QA_RESUME_STATE ? JSON.parse(readFileSync(process.env.QA_RESUME_STATE, 'utf8')) : null;
if (resume && (resume.kind !== 'fictional-source-ui-snapshot' || !isAbsolute(resume.data) || !Array.isArray(resume.threads) || !resume.threads.length)) throw new Error('Only a preserved fictional rehearsal snapshot can be resumed.');
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-bills-interactive-'));
const data = join(temp, 'data');
mkdirSync(data, { mode: 0o700 });
if (resume) {
  cpSync(resume.data, data, { recursive: true, preserveTimestamps: true });
  const restrict = path => { const info = lstatSync(path); if (info.isSymbolicLink()) throw new Error('Fictional snapshots cannot contain symbolic links.'); chmodSync(path, info.isDirectory() ? 0o700 : info.mode & 0o700); if (info.isDirectory()) for (const name of readdirSync(path)) restrict(join(path, name)); };
  restrict(data);
}
const sourceAt = resume?.sourceAt ?? Date.now() - 86400000;
const sourceDate = resume?.sourceDate ?? new Date(sourceAt).toISOString().slice(0, 10);
const dueDate = resume?.dueDate ?? new Date(sourceAt + 20 * 86400000).toISOString().slice(0, 10);
const nextDueDate = resume?.nextDueDate ?? new Date(sourceAt + 50 * 86400000).toISOString().slice(0, 10);
const credential = `rbc_${'c'.repeat(64)}`;
const labPath = `/fixture-${randomUUID()}`;
const pdfs = new Map([
  ['abc1', fictionalPdf(`Fictional Water invoice FICTION-001 version 1. Oak Street. AUD 123.45. Invoice date ${sourceDate}. Due ${dueDate}. No payment recorded.`)],
  ['abc2', fictionalPdf(`Fictional Water invoice FICTION-002 version 1. Oak Street. AUD 123.45. Invoice date ${sourceDate}. Due ${nextDueDate}. No payment recorded.`)],
]);
const original = resume?.threads[0] ?? { id: 'abc', historyComplete: true, messages: [{
  id: 'def', threadId: 'abc', at: sourceAt, direction: 'incoming', from: 'utility@example.test', to: 'office@example.test',
  subject: 'Fictional water invoice FICTION-001 · Oak Street',
  body: `Fictional Oak Street water bill. Invoice FICTION-001 version 1. Invoice date ${sourceDate}. AUD 123.45. Due ${dueDate}. Supplier: Fictional Water. No payment is recorded.`,
  bodyTruncated: false, attachments: [{ id: 'abc1', name: 'fictional-invoice.pdf', mimeType: 'application/pdf', size: pdfs.get('abc1').length }],
}] };
const extraThreads = resume?.threads.slice(1) ?? [];
let endpoint, base, child, logs = '', scanCalls = 0, attachmentCalls = 0, stopped = false, restarting = false, serviceExit;
let restartService, publishReceipt;
const wait = ms => new Promise(r => setTimeout(r, ms));
const connector = createServer(async (req, res) => {
  try {
    if (req.url === labPath && req.method === 'GET') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Fictional bill arrivals</title></head><body style="font:17px system-ui;max-width:760px;margin:50px auto;line-height:1.5"><h1>Fictional bill arrivals</h1><p>This isolated rehearsal uses generated invoices and a deterministic worker. It does not prove live Hermes extraction or touch installed RealBud data.</p><p><a href="${base}/#/desk" target="_blank" rel="noopener">Open isolated RealBud UI</a></p><p>Fixture mailbox: ${1 + extraThreads.length} conversations; ${scanCalls} scans; ${attachmentCalls} attachment reads. Return to RealBud and use its scan control after adding a message.</p><form method="post" action="${labPath}/forward"><button>Add forwarded FICTION-001 copy</button></form><form method="post" action="${labPath}/next"><button>Add separate FICTION-002 invoice</button></form><form method="post" action="${labPath}/restart"><button>Restart only this fictional service, preserving its records</button></form><h2>Review facts</h2><p>Property: Fictional Oak Street. Supplier: Fictional Water. Bill kind: Water. Amount: AUD 123.45. Invoice date: ${sourceDate}. FICTION-001 due: ${dueDate}; FICTION-002 due: ${nextDueDate}. Version: 1.</p><p>The forward preserves the first invoice's body and PDF while using a new message identity. A matching saved invoice should require duplicate review. FICTION-002 has a different invoice number and PDF.</p><p>The built UI is served from an independent output directory. Stop this launcher with Ctrl-C when the rehearsal finishes.</p></body></html>`);
      return;
    }
    if (req.method === 'POST' && req.url === `${labPath}/restart`) {
      if (req.headers.origin !== endpoint || !restartService) { res.writeHead(403).end('Fixture restart unavailable'); return; }
      await restartService(); res.writeHead(303, { location: labPath }).end(); return;
    }
    if (req.method === 'POST' && (req.url === `${labPath}/forward` || req.url === `${labPath}/next`)) {
      if (req.headers.origin !== endpoint) { res.writeHead(403).end('Fixture origin required'); return; }
      const forward = req.url.endsWith('/forward');
      const id = forward ? 'abc999' : 'abc998';
      if (!extraThreads.some(thread => thread.id === id)) {
        const message = structuredClone(original.messages[0]);
        message.id = forward ? 'def999' : 'def998';
        message.threadId = id;
        message.subject = forward ? 'Fictional forwarded water invoice FICTION-001' : 'Fictional next water invoice FICTION-002';
        if (!forward) {
          message.body = message.body.replaceAll('FICTION-001', 'FICTION-002').replaceAll(dueDate, nextDueDate);
          message.attachments = [{ id: 'abc2', name: 'fictional-next-invoice.pdf', mimeType: 'application/pdf', size: pdfs.get('abc2').length }];
        }
        extraThreads.push({ id, historyComplete: true, messages: [message] });
      }
      res.writeHead(303, { location: labPath }).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${credential}` || req.headers['x-realbud-profile'] !== 'property') { res.writeHead(403).end('{"error":"fixture_denied"}'); return; }
    if (req.url === '/v1/connectors/status') {
      res.end(JSON.stringify({ managed: true, checkedAt: new Date().toISOString(), serviceExpiresAt: Date.now() + 3600000, services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: 'fictional-bills', label: 'Fictional bills inbox', status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: ['GMAIL_GET_PROFILE', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID'] } })); return;
    }
    if (req.url === '/v1/connectors/mail-attachment') {
      let raw = ''; for await (const part of req) raw += part;
      const source = JSON.parse(raw), bytes = pdfs.get(source.attachment.id);
      const message = [original, ...extraThreads].find(thread => thread.id === source.threadId)?.messages.find(message => message.id === source.messageId);
      assert.equal(source.accountId, 'fictional-bills'); assert.ok(bytes && message?.attachments.some(attachment => attachment.id === source.attachment.id));
      attachmentCalls++; res.end(JSON.stringify({ ...source, bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })); return;
    }
    if (req.url === '/v1/connectors/mail-scan') {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      if (body.expectedAccountId !== 'fictional-bills' || !body.scope) { res.writeHead(409).end('{}'); return; }
      scanCalls++; res.end(JSON.stringify({ accountId: 'fictional-bills', windowStartAt: body.scope.windowStartAt, windowEndAt: body.scope.windowEndAt, pages: 1, paginationComplete: true, gaps: ['Attachment contents were not read. Any decision needing an attachment must stay held.'], threads: [original, ...extraThreads] })); return;
    }
    res.writeHead(404).end('{}');
  } catch (error) { console.error('Fixture request failed:', error.message); res.writeHead(500).end('{"error":"fixture_error"}'); }
});

async function cleanup() {
  if (stopped) return;
  stopped = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(4000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), wait(4000)]); }
  }
  connector.closeAllConnections();
  await new Promise(resolve => connector.close(resolve));
  if (!child || child.exitCode !== null || child.signalCode !== null) rmSync(temp, { recursive: true, force: true });
  else console.error(`Owned child did not exit; temporary workspace preserved: ${temp}`);
  console.log('Fictional source-UI rehearsal stopped. Installed RealBud was not changed.');
}

try {
  connector.listen(0, '127.0.0.1'); await once(connector, 'listening');
  endpoint = `http://127.0.0.1:${connector.address().port}`;
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const worker = join(temp, 'fictional-worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nimport {readFileSync,existsSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('Hermes Agent v0.21.3 (2026.9.14)');process.exit(0);}
if(process.env.REALBUD_MODEL_API_KEY!==${JSON.stringify(fictionalWorkerModelKey)})throw new Error('Fictional worker did not receive its managed grant');
const path=${JSON.stringify(join(data, 'vault/workflow-inputs/accounts-invoices.json'))};if(!existsSync(path)){console.log('{}');process.exit(0);}
const input=JSON.parse(readFileSync(path,'utf8')),doc=input.documents[0],isNext=JSON.stringify(doc).includes('FICTION-002');
const result={version:1,kind:'accounts-invoice-entry-review',sourceReference:input.sourceReference,status:'partial',coverageComplete:false,holds:[{itemId:'coverage',reason:'Selected fictional message only. Human source review required.'}],actionsPerformed:[],documents:[{documentId:doc.documentId,decision:'hold',duplicateOf:null,conflictGroup:null,proposedEntry:{supplierId:'Fictional Water',invoiceId:isNext?'FICTION-002':'FICTION-001',propertyId:input.propertyMap[0]?.propertyId??null,amount:'123.45',currency:'AUD',dueDate:isNext?${JSON.stringify(nextDueDate)}:${JSON.stringify(dueDate)},costType:'Water'},sourceIds:[doc.sourceId],reason:'Deterministic fictional extraction; staff approval remains required.'}]};
console.log(JSON.stringify({summary:'Fictional invoice preparation',evidence:[],outputs:[JSON.stringify(result)],needsApproval:[]}));\n`, { mode: 0o700 });
  const config = resume ? JSON.parse(readFileSync(join(data, 'config.json'), 'utf8')) : { instances: { fixture: { driver: 'not-a-real-driver' } } };
  config.composio = { managed: { endpoint, credential, profile: 'property' } };
  writeFileSync(join(data, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  provisionMockWorkerGrant({ home: temp, data, endpoint, credential, companyId: 'fictional-bills-office', hostInstallationId: 'fictional-bills-host', preserveFictionalLink: !!resume });
  const networkGuard = join(temp, 'network-guard.mjs');
  writeFileSync(networkGuard, `const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==${JSON.stringify(endpoint)})throw new Error('QA denied non-connector fetch');return realFetch(input,init);};`, { mode: 0o600 });
  const launchService = async () => {
    child = spawn(process.execPath, ['--import', networkGuard, join(root, 'server/index.ts')], { cwd: root, env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_HERMES_CLI: worker, REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: ui }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-24000); });
    child.once('exit', () => { if (!stopped && !restarting) { console.error('Owned QA service exited.\n' + logs); process.exitCode = 1; serviceExit?.(); } });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) break;
      try { if ((await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === child.pid) { ready = true; break; } } catch {}
      await wait(100);
    }
    assert.ok(ready, logs);
  };
  await launchService();
  restartService = async () => {
    if (restarting || stopped) throw new Error('The fictional service is already restarting or stopped.');
    restarting = true;
    try {
      const previous = child;
      previous.kill('SIGTERM'); await Promise.race([once(previous, 'exit'), wait(4000)]);
      if (previous.exitCode === null && previous.signalCode === null) throw new Error('Owned service did not stop; no second process was started.');
      await launchService(); publishReceipt?.();
    } finally { restarting = false; }
  };
  assert.equal((await fetch(base + '/api/bill-register')).status, 401);
  const token = (await (await fetch(base + '/api/session')).json()).token;
  const request = async (path, method = 'GET', body, expected = 200) => {
    const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await res.json(); assert.equal(res.status, expected, `${path}: ${JSON.stringify(value)}`); return value;
  };
  let propertyId = resume?.propertyId;
  if (!resume) {
  await completeFictionalOnboarding(request);
  const snapshot = await request('/api/desk/properties', 'POST', { address: 'Fictional Oak Street', tenantName: 'Fictional Tenant', tenantPhone: '0400 000 000', weeklyRentCents: 50000 }, 201);
  propertyId = snapshot.properties.find(property => property.address === 'Fictional Oak Street').id;
  await request('/api/hermes/apply-pack', 'POST', {});
  const pack = await request('/api/customer-packs/office-core/export');
  const preview = await request('/api/customer-packs/preview', 'POST', { pack });
  await request('/api/customer-packs/install', 'POST', { pack, expectedDigest: preview.digest });
  const recipe = (await request('/api/recipes')).recipes.find(recipe => recipe.id === 'wf-office-core-invoice-review'); assert.ok(recipe);
  await request(`/api/recipes/${recipe.id}`, 'PATCH', { expectedRevision: recipe.revision, planApproved: true, status: 'active' });
  const status = await request('/api/hermes'); assert.ok(status.workerFingerprint);
  writeFileSync(join(data, 'hands-ping.json'), JSON.stringify({ at: Date.now(), ok: true, detail: 'Fictional deterministic worker readiness; not model proof', kind: 'ping', workerFingerprint: status.workerFingerprint }), { mode: 0o600 });
  await request('/api/connected-apps/check', 'POST', {});
  let setup = await request('/api/agency-setup');
  setup = await request('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, agencyName: 'Fictional Bill Agency', workflowPackId: 'office-core', timeZone: 'UTC', gmailAccountId: 'fictional-bills', selectedWorkflows: ['bills-calendar'], propertyReferences: [{ propertyId, reference: 'FICTION-1', aliases: ['Fictional Oak Street'] }] } });
  setup = await request('/api/agency-setup/check-gmail', 'POST', { expectedRevision: setup.state.revision });
  const workflow = setup.workflows.find(workflow => workflow.id === 'bills-calendar'); assert.ok(workflow.canReview, JSON.stringify(workflow));
  await request('/api/agency-setup/workflows/bills-calendar/review', 'POST', { expectedRevision: setup.state.revision, expectedEvidenceDigest: workflow.evidenceDigest });
  }
  if (resume) {
    const status = await request('/api/hermes'); assert.ok(status.workerFingerprint);
    writeFileSync(join(data, 'hands-ping.json'), JSON.stringify({ at: Date.now(), ok: true, detail: 'Resumed fictional deterministic worker readiness; not model proof', kind: 'ping', workerFingerprint: status.workerFingerprint }), { mode: 0o600 });
  }
  const receipt = { kind: 'fictional-source-ui-rehearsal', pid: process.pid, servicePid: child.pid, baseUrl: base, fixtureUrl: `${endpoint}${labPath}`, temp, data, renderer: ui, sourceDate, dueDate, nextDueDate, propertyId, ...(resume ? { resumedFrom: process.env.QA_RESUME_STATE } : {}), generatedAt: new Date().toISOString(), cleanup: 'Send SIGINT to launcher PID; it stops only its owned child and deletes its temporary fictional workspace.' };
  publishReceipt = () => {
    receipt.servicePid = child.pid;
    receipt.generatedAt = new Date().toISOString();
  if (process.env.QA_RECEIPT) writeFileSync(process.env.QA_RECEIPT, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
  };
  publishReceipt();
  console.log(resume ? 'READY. Preserved fictional bill records and mailbox resumed. Ctrl-C cleans up.' : 'READY. No bill accepted or mail scan performed. Use the UI. Ctrl-C cleans up.');
  await new Promise(resolve => {
    process.once('SIGINT', resolve); process.once('SIGTERM', resolve);
    serviceExit = resolve;
  });
} catch (error) { console.error(error); console.error(logs); process.exitCode = 1; }
finally { await cleanup(); }
