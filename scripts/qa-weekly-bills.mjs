// Actual desktop HTTP service + built React UI; fictional private connector and
// deterministic invoice worker only. No customer mail, model or financial call.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { fictionalPdf } from '../server/testing/pdf-fixture.ts';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { readSessionToken, primeBrowserSession } from './local-session.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
import { fictionalWorkerModelKey, provisionMockWorkerGrant } from './testing/mock-worker-grant.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud bill source QA '));
const data = join(temp, 'data'), output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/w1-w3-operational-2026-10-02/weekly-bills'));
mkdirSync(data, { mode: 0o700 }); mkdirSync(output, { recursive: true });
const checks = [], errors = [], wait = ms => new Promise(r => setTimeout(r, ms));
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const sourceAt = Date.now() - 86400000, sourceDate = new Date(sourceAt).toISOString().slice(0, 10), dueDate = new Date(sourceAt + 20 * 86400000).toISOString().slice(0, 10), laterDate = new Date(sourceAt + 25 * 86400000).toISOString().slice(0, 10), rangeEnd = new Date(sourceAt + 180 * 86400000).toISOString().slice(0, 10);
const pdfBytes = fictionalPdf('Fictional Water invoice FICTION-001 AUD 123.45. Check the original before accepting.');
let attachmentCalls = 0;
const credential = `rbc_${'c'.repeat(64)}`;
let child, browser, page, logs = '', scanCalls = 0, failure;
let extraThreads = [];
const readPaths = [];
const connector = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== `Bearer ${credential}` || req.headers['x-realbud-profile'] !== 'property') { res.writeHead(403); res.end('{"error":"fixture_denied"}'); return; }
  if (req.url === '/v1/connectors/status') { res.end(JSON.stringify({ managed: true, checkedAt: new Date().toISOString(), serviceExpiresAt: Date.now() + 3600000, services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: 'fictional-bills', label: 'Fictional bills inbox', status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: ['GMAIL_GET_PROFILE', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID'] } })); return; }
  if (req.url === '/v1/connectors/mail-attachment') {
    let raw = ''; for await (const part of req) raw += part; const source = JSON.parse(raw);
    assert.equal(source.accountId, 'fictional-bills'); assert.equal(source.threadId, 'abc'); assert.equal(source.messageId, 'def'); assert.equal(source.attachment.id, 'abc1');
    attachmentCalls++; res.end(JSON.stringify({...source, bytesBase64:pdfBytes.toString('base64'), sha256:createHash('sha256').update(pdfBytes).digest('hex')})); return;
  }
  if (req.url === '/v1/connectors/mail-scan') {
    let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw);
    if (body.expectedAccountId !== 'fictional-bills' || !body.scope) { res.writeHead(409).end('{}'); return; }
    const request = body.scope; scanCalls++;
    res.end(JSON.stringify({ accountId: 'fictional-bills', windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt, pages: 1, paginationComplete: true, gaps: ['Attachment contents were not read. Any decision needing an attachment must stay held.'], threads: [{ id: 'abc', historyComplete: true, messages: [{ id: 'def', threadId: 'abc', at: sourceAt, direction: 'incoming', from: 'utility@example.test', to: 'office@example.test', subject: 'Fictional water invoice · Oak Street', body: `Fictional Oak Street water bill. Invoice date ${sourceDate}. AUD 123.45. Due ${dueDate}. Supplier: Fictional Water. No payment is recorded.`, bodyTruncated: false, attachments: [{ id: 'abc1', name: 'fictional-invoice.pdf', mimeType: 'application/pdf', size: pdfBytes.length }] }] }, ...extraThreads] })); return;
  }
  res.writeHead(404); res.end('{}');
});
try {
  connector.listen(0, '127.0.0.1'); await once(connector, 'listening'); const endpoint = `http://127.0.0.1:${connector.address().port}`;
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r)); const base = `http://127.0.0.1:${port}`;
  // Fixture call evidence stays inside the real worker's writable work folder.
  const worker = join(temp, 'fictional-worker.mjs'), workerCalls = join(data, 'vault', 'bud-work', 'worker-calls.json');
  writeFileSync(worker, `#!${process.execPath}\nimport {readFileSync,writeFileSync,existsSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('Hermes Agent v0.21.3 (2026.9.14)');process.exit(0);}
// The provider key stays with the host; this worker receives only the loopback relay token.
if(process.env.REALBUD_MODEL_API_KEY===${JSON.stringify(fictionalWorkerModelKey)}||!/^[a-f0-9]{64}$/.test(process.env.REALBUD_MODEL_API_KEY??''))throw new Error('Fictional worker did not receive an isolated relay token');
const relayOverlay=JSON.parse(readFileSync(process.env.HERMES_MANAGED_DIR+'/config.yaml','utf8'));
const relayProviders=Object.values(relayOverlay.providers??{});
if(relayProviders.length!==1||!['api','url','base_url'].every(key=>{const url=new URL(relayProviders[0][key]);return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port;}))throw new Error('Fictional worker relay must use loopback only');
const path=${JSON.stringify(join(data, 'vault/workflow-inputs/accounts-invoices.json'))};if(!existsSync(path)){console.log('{}');process.exit(0);}
const input=JSON.parse(readFileSync(path,'utf8')), doc=input.documents[0];
const result={version:1,kind:'accounts-invoice-entry-review',sourceReference:input.sourceReference,status:'partial',coverageComplete:false,holds:[{itemId:'coverage',reason:'Only the selected fictional message is available; the text layer needs human review.'}],actionsPerformed:[],documents:[{documentId:doc.documentId,decision:'hold',duplicateOf:null,conflictGroup:null,proposedEntry:{supplierId:'Fictional Water',invoiceId:'FICTION-001',propertyId:input.propertyMap[0]?.propertyId??null,amount:'123.45',currency:'AUD',dueDate:${JSON.stringify(dueDate)},costType:'Water'},sourceIds:[doc.sourceId],reason:'Fictional source text supplies candidate facts; staff approval remains required.'}]};
const log=${JSON.stringify(workerCalls)};let calls=[];try{calls=JSON.parse(readFileSync(log,'utf8'));}catch{}calls.push(input.sourceReference);writeFileSync(log,JSON.stringify(calls));console.log(JSON.stringify({summary:'Fictional invoice preparation',evidence:[],outputs:[JSON.stringify(result)],needsApproval:[]}));\n`, { mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } }, composio: { managed: { endpoint, credential, profile: 'property' } } }), { mode: 0o600 });
  provisionMockWorkerGrant({ home: temp, data, endpoint, credential, companyId: 'fictional-bills-office', hostInstallationId: 'fictional-bills-host' });
  const networkGuard = join(temp, 'network-guard.mjs');
  writeFileSync(networkGuard, `const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==${JSON.stringify(endpoint)})throw new Error('QA denied non-connector fetch');return realFetch(input,init);};`, { mode: 0o600 });
  child = spawn(process.execPath, ['--import', pathToFileURL(networkGuard).href, join(root, 'server/index.ts')], { cwd: root, env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_HERMES_CLI: worker, REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR || join(root, 'dist')) }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-24000); });
  let ready = false; for (let i = 0; i < 100; i++) { if (child.exitCode !== null) break; try { if ((await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === child.pid) { ready = true; break; } } catch {} await wait(100); } assert.ok(ready, logs);
  assert.equal((await fetch(base + '/api/bill-register')).status, 401);
  const token = await readSessionToken(data);
  const request = async (path, method = 'GET', body, expected = 200) => { const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await res.json(); assert.equal(res.status, expected, `${path}: ${JSON.stringify(value)}`); return value; };
  await completeFictionalOnboarding(request);
  const snapshot = await request('/api/desk/properties', 'POST', { address: 'Fictional Oak Street', tenantName: 'Fictional Tenant', tenantPhone: '0400 000 000', weeklyRentCents: 50000 }, 201);
  const propertyId = snapshot.properties.find(p => p.address === 'Fictional Oak Street').id;
  const secondProperty = await request('/api/desk/properties', 'POST', { address: 'Fictional Pine Street', tenantName: 'Fictional Tenant Two', tenantPhone: '0400 000 001', weeklyRentCents: 51000 }, 201);
  const secondPropertyId = secondProperty.properties.find(p => p.address === 'Fictional Pine Street').id;
  await request('/api/hermes/apply-pack', 'POST', {});
  const pack = await request('/api/customer-packs/office-core/export'), preview = await request('/api/customer-packs/preview', 'POST', { pack });
  await request('/api/customer-packs/install', 'POST', { pack, expectedDigest: preview.digest });
  const recipe = (await request('/api/recipes')).recipes.find(r => r.id === 'wf-office-core-invoice-review'); assert.ok(recipe);
  await request(`/api/recipes/${recipe.id}`, 'PATCH', { expectedRevision: recipe.revision, planApproved: true, status: 'active' });
  const status = await request('/api/hermes'); assert.ok(status.workerFingerprint);
  writeFileSync(join(data, 'hands-ping.json'), JSON.stringify({ at: Date.now(), ok: true, detail: 'Fictional deterministic worker readiness; not model proof', kind: 'ping', workerFingerprint: status.workerFingerprint }), { mode: 0o600 });
  await request('/api/connected-apps/check', 'POST', {});
  let setup = await request('/api/agency-setup');
  setup = await request('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, agencyName: 'Fictional Bill Agency', workflowPackId: 'office-core', timeZone: 'Australia/Brisbane', gmailAccountId: 'fictional-bills', selectedWorkflows: ['bills-calendar'], propertyReferences: [{ propertyId, reference: 'FICTION-1', aliases: ['Fictional Oak Street'] }] } });
  setup = await request('/api/agency-setup/check-gmail', 'POST', { expectedRevision: setup.state.revision });
  const workflow = setup.workflows.find(w => w.id === 'bills-calendar'); assert.ok(workflow.canReview, JSON.stringify(workflow));
  await request('/api/agency-setup/workflows/bills-calendar/review', 'POST', { expectedRevision: setup.state.revision, expectedEvidenceDigest: workflow.evidenceDigest });

  // Setup review may start the separately bounded history collector. Wait for
  // that owned operation; W2 must not replace its source while it is running.
  for (let i=0; i<300; i++) {
    const mail = await request('/api/mail-workspace');
    if (mail.history?.state !== 'checking') break;
    await wait(100);
  }
  assert.equal((await fetch(base + '/api/bill-register/routine')).status, 401);
  let loops = await request('/api/loops');
  const weekly = () => loops.loops.find(loop => loop.id === 'weekly-bills');
  assert.equal(weekly().enabled, false);
  assert.equal(weekly().schedule.time, '08:00');
  assert.deepEqual(weekly().schedule.weekdays, [1]);
  const bank = loops.loops.find(loop => loop.id === 'bank-references');
  assert.equal(bank.enabled, false); assert.equal(bank.available, true); // Austin pack: available, off until the office turns it on
  await request('/api/loops/weekly-bills/run', 'POST', {}, 400);
  const launch = async () => {
    loops = await request('/api/loops');
    const body = { requestId: randomUUID(), expectedRevision: weekly().revision };
    const accepted = await request('/api/loops/weekly-bills/run', 'POST', body, 201);
    for (let i=0; i<300; i++) {
      loops = await request('/api/loops');
      const run = loops.runs.find(run => run.id === accepted.run.id);
      if (run && !['queued','running'].includes(run.status)) return { run, body };
      await wait(100);
    }
    throw new Error('Weekly review did not settle');
  };
  const first = await launch();
  assert.equal(first.run.status, 'partial', JSON.stringify(first.run));
  let result = (await request('/api/bill-register/routine')).result;
  assert.equal(result.runId, first.run.id); assert.equal(result.accountId, 'fictional-bills');
  assert.equal(result.counts.candidates, 1); assert.equal(result.counts.prepared, 1);
  assert.equal(result.metrics.modelCalls, 1); assert.ok(result.gaps.length);
  let drafts = (await request('/api/bill-review-drafts?filter=active&limit=20')).items;
  assert.equal(drafts.length, 1); assert.equal(drafts[0].state, 'saved');
  assert.equal((await request('/api/bill-register')).occurrences.total, 0);
  assert.equal(weekly().enabled, false); assert.equal(attachmentCalls, 1);
  pass('Paused W2 runs through real HTTP, saves a source-bound review and PDF proposal, records coverage gaps and creates no payable bill');
  const scans = scanCalls;
  const replay = await request('/api/loops/weekly-bills/run', 'POST', first.body, 201);
  assert.equal(replay.run.id, first.run.id); assert.equal(scanCalls, scans);
  const second = await launch();
  result = (await request('/api/bill-register/routine')).result;
  assert.equal(result.runId, second.run.id); assert.equal(result.counts.changed, 0);
  assert.equal(result.metrics.modelCalls, 0); assert.ok(second.run.seenAt);
  assert.equal(JSON.parse(readFileSync(workerCalls, 'utf8')).length, 1); assert.equal(attachmentCalls, 1);
  assert.equal((await request('/api/bill-review-drafts?filter=active&limit=20')).items.length, 1);
  pass('Replayed request returns its saved run; unchanged mail reuses one draft/proposal and suppresses repeated notification');
  const tuned = await request('/api/loops/weekly-bills', 'PATCH', { enabled: true, intervalDays: 3, anchorDate: '2026-10-02', time: '08:00', weekdays: [0,1,2,3,4,5,6] });
  assert.equal(tuned.loop.schedule.timezone, 'Australia/Brisbane'); assert.equal(tuned.loop.schedule.intervalDays, 3);
  assert.ok(tuned.loop.nextRunAt > Date.now());
  await request('/api/loops/weekly-bills', 'PATCH', { enabled: false });
  pass('Reviewed W2 can adopt every-three-calendar-days at 08:00 Brisbane, then pause without running a past slot');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, base, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.on('request', request => { if (request.method() === 'GET') readPaths.push(new URL(request.url()).pathname); }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#/desk');
  // New private workspaces use Simple desk. Show this workflow through the
  // normal layout controls before expecting its Other work entry to be present.
  await page.locator('.desk-more > summary').filter({ hasText: /^More$/ }).click();
  await page.locator('.desk-options > summary').click();
  await page.locator('.desk-options-body').getByRole('button', { name: 'Arrange Desk', exact: true }).click();
  const arrange = page.getByRole('dialog', { name: 'Arrange Desk', exact: true });
  const showBills = arrange.getByLabel('Show Bills and calendar on my Desk', { exact: true });
  if (!await showBills.isChecked()) { await showBills.check(); await arrange.getByRole('button', { name: 'Save', exact: true }).click(); await arrange.getByText('Desk arrangement saved.', { exact: true }).waitFor(); }
  await arrange.getByRole('button', { name: 'Close Arrange Desk', exact: true }).click();
  await page.locator('.desk-other-work > summary').click();
  await page.getByRole('group', { name: 'Other work', exact: true }).getByRole('button', { name: 'Bills and calendar', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Source-linked bills and calendar' }); await panel.waitFor();

  const resultPanel = panel.getByRole('region', { name: 'Latest weekly bills result' });
  await resultPanel.getByText('Latest weekly bills review', { exact: true }).waitFor();
  assert.ok((await resultPanel.innerText()).includes('fictional-bills'));
  await page.screenshot({ path: join(output, 'weekly-result.png'), fullPage: true });
  await panel.locator(`[data-review-id="${drafts[0].id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
  const editor = panel.getByRole('form', { name: 'Review source bill' });
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  assert.ok(!await editor.getByLabel('I reviewed this source', { exact: false }).isChecked());
  await editor.getByRole('button', { name: 'Check the saved proposal request', exact: true }).click();
  await editor.getByRole('complementary', { name: 'Bill field proposal' }).getByText('Fictional source text supplies candidate facts; staff approval remains required.', { exact: true }).waitFor();
  await editor.getByText('Draft saved in this workspace.', { exact: true }).waitFor();
  assert.equal(JSON.parse(readFileSync(workerCalls, 'utf8')).length, 1);

  await page.screenshot({ path: join(output, 'weekly-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'weekly-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  pass('Built React UI exposes the saved W2 result and draft, rereads original evidence and requires fresh confirmation on desktop and narrow layout');
  await editor.getByRole('button', { name: 'Save for later', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base+'/#/schedule');
  await page.getByRole('button', { name: 'Open job: Weekly bills review', exact: true }).click();
  const routine=page.locator('#routine-weekly-bills');
  await routine.locator('summary').filter({ hasText: /^Timing ·/ }).click();
  await routine.getByLabel('Weekly bills review cadence', { exact: true }).selectOption('2');
  assert.equal(await routine.getByRole('group', { name: 'Weekly bills review days', exact: true }).count(), 0);
  await routine.getByRole('button', { name: 'Save', exact: true }).click();
  for(let i=0;i<100;i++){loops=await request('/api/loops');if(weekly().schedule.intervalDays===2)break;await wait(100);}
  assert.equal(weekly().schedule.intervalDays, 2); assert.equal(weekly().enabled, false);
  await routine.getByLabel('Weekly bills review cadence', { exact: true }).selectOption('0');
  const days=routine.getByRole('group', { name: 'Weekly bills review days', exact: true });
  for (const day of ['Tue','Wed','Thu','Fri','Sat','Sun']) await days.getByRole('button', { name: day, exact: true }).click();
  await routine.getByRole('button', { name: 'Save', exact: true }).click();
  for(let i=0;i<100;i++){loops=await request('/api/loops');if(weekly().schedule.intervalDays===undefined)break;await wait(100);}
  assert.equal(weekly().schedule.intervalDays, undefined); assert.deepEqual(weekly().schedule.weekdays,[1]);
  await page.screenshot({ path: join(output, 'weekly-schedule.png'), fullPage: true });
  pass('Actual Schedule controls switch between calendar-day intervals and Monday weekly review, preserve 08:00 and keep the routine paused');
  setup = await request('/api/agency-setup');
  await request('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, agencyName: 'Fictional revised agency' } });
  loops = await request('/api/loops'); assert.equal(weekly().enabled, false);
  const held = await launch(); assert.equal(held.run.status, 'failed');
  assert.equal((await request('/api/bill-register')).occurrences.total, 0);
  pass('Changed agency setup invalidates W2 authority; later run is held and saved results do not become bills');
} catch (error) { failure = error instanceof Error ? error.stack : String(error); if (page) writeFileSync(join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'No page')); await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await page?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}); await browser?.close(); if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(4000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), wait(4000)]); } } await new Promise(r => connector.close(r)); const childExited = !child || child.exitCode !== null || child.signalCode !== null; if (childExited) rmSync(temp, { recursive: true, force: true }); else failure ??= 'Owned child did not exit; scratch preserved.';
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Actual local HTTP app + built UI; fictional connector + deterministic invoice worker; not live Gmail/Hermes/customer/Windows proof', checks, scanCalls, attachmentCalls, errors, limits: ['Fictional connector and deterministic worker; no live Gmail, payment or calendar provider call.', 'Text-layer PDF only; no OCR or complete image-content proof.', 'Mac browser rendering; no native Windows or two-computer acceptance.'], failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks }, null, 2));
}
