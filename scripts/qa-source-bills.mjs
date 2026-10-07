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
const data = join(temp, 'data'), output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/source-bills-2026-09-21'));
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
  setup = await request('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, agencyName: 'Fictional Bill Agency', workflowPackId: 'office-core', timeZone: 'UTC', gmailAccountId: 'fictional-bills', selectedWorkflows: ['bills-calendar'], propertyReferences: [{ propertyId, reference: 'FICTION-1', aliases: ['Fictional Oak Street'] }] } });
  setup = await request('/api/agency-setup/check-gmail', 'POST', { expectedRevision: setup.state.revision });
  const workflow = setup.workflows.find(w => w.id === 'bills-calendar'); assert.ok(workflow.canReview, JSON.stringify(workflow));
  await request('/api/agency-setup/workflows/bills-calendar/review', 'POST', { expectedRevision: setup.state.revision, expectedEvidenceDigest: workflow.evidenceDigest });
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
  await page.getByRole('button', { name: 'Customize desk', exact: true }).click();
  const showBills = page.getByLabel('Show Bills and calendar', { exact: true });
  if (!await showBills.isChecked()) { await showBills.check(); await page.getByRole('button', { name: 'Save layout', exact: true }).click(); await page.getByText('Desk layout saved.', { exact: true }).waitFor(); }
  await page.getByRole('button', { name: 'Close Customize desk', exact: true }).click();
  await page.locator('.desk-other-work > summary').click();
  await page.getByRole('group', { name: 'Other work', exact: true }).getByRole('button', { name: 'Bills and calendar', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Source-linked bills and calendar' }); await panel.waitFor();
  const preManualScanCalls = scanCalls;
  await panel.getByRole('button', { name: 'Check inbox for bills', exact: true }).click();
  // The fixture invoice arrives as a PDF attachment that collection does not
  // read, so the honest receipt is partial with exactly that one source gap.
  const collection = panel.getByRole('complementary', { name: 'Latest bill mail collection', exact: true });
  await collection.getByText('Latest mail collection: partial', { exact: true }).waitFor();
  await collection.getByText('Bill mail collection is partial.', { exact: false }).waitFor();
  await collection.getByText('Collection account and source gaps (1)', { exact: true }).waitFor();
  assert.equal(scanCalls, preManualScanCalls + 1); const mail = await request('/api/mail-workspace');
  assert.equal(mail.latestScan.status, 'partial'); assert.deepEqual(mail.latestScan.gaps, ['Attachment contents were not read. Any decision needing an attachment must stay held.']); assert.equal(mail.counts.total, 1); assert.equal(Object.hasOwn(mail, 'items'), false); const itemId = (await request('/api/mail-workspace/items?group=all&limit=20')).items[0].id;
  pass('Other work opens the full bills view and collects only the real HTTP host-reviewed fictional Gmail scope without enabling a schedule; the unread invoice attachment keeps the receipt partial with that one gap');
  await page.getByRole('region', { name: 'Bills and calendar', exact: true }).getByRole('button', { name: 'Back to tasks', exact: true }).click();
  // Saved views are managed by Bud. Seed the route through the revisioned API
  // so reload, two-window and unmount/hydration checks still use a durable view.
  const allBillsViews = (await request('/api/workspace-tabs')).state, allBillsViewId = `view-${randomUUID()}`;
  await request('/api/workspace-tabs', 'PUT', { version: 1, expectedRevision: allBillsViews.revision, tabs: [...allBillsViews.tabs, { id: allBillsViewId, label: 'Fictional bills and calendar', visible: true, view: { kind: 'bills', filter: 'all' } }] });
  const billsUrl = base + `/#/views/${allBillsViewId}`;
  await page.goto(billsUrl); await page.reload(); await panel.waitFor();
  await panel.getByRole('button', { name: 'Review a bill from saved mail', exact: true }).click();
  let editor = panel.getByRole('form', { name: 'Review source bill' }); await editor.getByLabel('Saved conversation', { exact: true }).selectOption(itemId); await editor.getByLabel('Source message', { exact: false }).selectOption('def');
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  const waitForDraft = async (id, note) => { for (let attempt = 0; attempt < 100; attempt++) { const result = (await request(`/api/bill-review-drafts/${id}`)).draft; if (result.fields.note === note) return result; await wait(100); } throw new Error('Draft save did not reach expected note'); };
  await editor.getByLabel('Amount (AUD)', { exact: true }).fill('12.');
  await editor.getByLabel('Bill note', { exact: true }).fill('Raw draft survives reload');
  await editor.getByRole('button', { name: 'Save for later', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  const firstDraft = (await request('/api/bill-review-drafts?filter=active&limit=10')).items[0];
  await page.reload(); await panel.waitFor();
  await panel.locator(`[data-review-id="${firstDraft.id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  assert.equal(await editor.getByLabel('Amount (AUD)', { exact: true }).inputValue(), '12.');
  assert.equal(await editor.getByLabel('Bill note', { exact: true }).inputValue(), 'Raw draft survives reload');
  assert.ok(!await editor.getByLabel('I reviewed this source', { exact: false }).isChecked());
  pass('Encrypted draft persists raw incomplete amount and notes across reload; reopening rereads evidence and resets source confirmation');
  const other = await context.newPage(); other.on('pageerror', error => errors.push(error.message)); await other.goto(billsUrl);
  const otherPanel = other.getByRole('region', { name: 'Source-linked bills and calendar' });
  await otherPanel.locator(`[data-review-id="${firstDraft.id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
  const otherEditor = otherPanel.getByRole('form', { name: 'Review source bill' }); await otherEditor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  await editor.getByLabel('Bill note', { exact: true }).fill('First window preserved note'); await waitForDraft(firstDraft.id, 'First window preserved note');
  await otherEditor.getByLabel('Bill note', { exact: true }).fill('Second window preserved note');
  await otherEditor.getByRole('alert').filter({ hasText: 'changed in another window' }).waitFor();
  assert.equal(await otherEditor.getByLabel('Bill note', { exact: true }).inputValue(), 'Second window preserved note');
  await otherEditor.getByRole('button', { name: 'Save my entries as a separate review', exact: true }).click();
  await otherPanel.getByText('Your entries were saved as a separate review.', { exact: false }).waitFor();
  await otherEditor.getByRole('button', { name: 'Save for later', exact: true }).click(); await otherEditor.waitFor({ state: 'hidden' }); await other.close();
  assert.equal((await request(`/api/bill-review-drafts/${firstDraft.id}`)).draft.fields.note, 'First window preserved note');
  const copies = await request('/api/bill-review-drafts?filter=active&limit=10'); assert.equal(copies.total, 2);
  pass('Two actual browser windows keep both staff notes on CAS conflict; an explicit separate copy preserves the remote review');
  await editor.getByLabel('Bill note', { exact: true }).fill('Navigation preserves latest entered note');
  await page.goto(base + '/#/desk'); await editor.waitFor({ state: 'hidden' }); await page.goto(billsUrl);
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  assert.equal(await editor.getByLabel('Bill note', { exact: true }).inputValue(), 'Navigation preserves latest entered note');
  await waitForDraft(firstDraft.id, 'Navigation preserves latest entered note');
  pass('Internal view navigation restores the in-memory current review while serialized autosave completes');
  for (const delayedPath of [`/api/bill-review-drafts/${firstDraft.id}`, `/api/bill-evidence/${itemId}`]) {
    await page.goto(base + '/#/desk'); await editor.waitFor({ state: 'hidden' });
    let releaseRead, readCaptured, finishRead, delayed = false;
    const hold = new Promise(resolve => { releaseRead = resolve; }), captured = new Promise(resolve => { readCaptured = resolve; }), finished = new Promise(resolve => { finishRead = resolve; });
    const delayedRoute = url => url.pathname === delayedPath;
    await page.route(delayedRoute, async route => {
      if (route.request().method() !== 'GET' || delayed) return route.continue(); delayed = true;
      const actual = await route.fetch(); readCaptured(); await Promise.race([hold, wait(10000)]); try { await route.fulfill({ response: actual }); } catch (error) { if (!/already handled|Target page|context.*closed|disposed/i.test(String(error))) throw error; } finally { finishRead(); }
    });
    await page.goto(billsUrl); await captured;
    assert.ok(await panel.getByRole('button', { name: 'Review a bill from saved mail', exact: true }).isDisabled());
    await page.goto(base + '/#/desk'); await page.goto(billsUrl);
    await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
    await editor.getByLabel('Bill note', { exact: true }).fill(`Later editor after delayed ${delayedPath}`);
    await waitForDraft(firstDraft.id, `Later editor after delayed ${delayedPath}`);
    releaseRead(); await finished; await page.unroute(delayedRoute);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await editor.getByLabel('Bill note', { exact: true }).inputValue(), `Later editor after delayed ${delayedPath}`);
  }
  pass('Delayed draft and source hydration keep initialization locked and cannot replace a later editor after navigation');
  let deniedDraftWrites = 0, proposalPostsBeforeSaved = 0;
  const draftRoute = url => url.pathname.startsWith('/api/bill-review-drafts');
  const draftWriteFailure = async route => { if (['POST', 'PUT'].includes(route.request().method())) { deniedDraftWrites++; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Explicit fictional draft-storage failure' }) }); } else await route.continue(); };
  await page.route(draftRoute, draftWriteFailure);
  const countProposalPost = request => { if (new URL(request.url()).pathname === '/api/bill-proposals' && request.method() === 'POST') proposalPostsBeforeSaved++; }; page.on('request', countProposalPost);
  await editor.getByRole('button', { name: 'Ask Bud to propose fields', exact: true }).click();
  await editor.getByRole('alert').filter({ hasText: 'Draft not saved' }).waitFor();
  assert.ok(deniedDraftWrites > 0); assert.equal(proposalPostsBeforeSaved, 0);
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  await page.unroute(draftRoute, draftWriteFailure);
  await editor.getByRole('button', { name: 'Save for later', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);
  pass('Actual App beforeunload listener prevents a cancelable event while a draft save is unconfirmed and clears after ACK; native close dialog is a separate proof layer');
  const failedRequestDraft = (await request(`/api/bill-review-drafts/${firstDraft.id}`)).draft; assert.ok(failedRequestDraft.proposalRequest);
  assert.equal((await request(`/api/bill-proposals/${failedRequestDraft.proposalRequest.requestId}`)).state, 'not-recorded');
  pass('Injected draft-storage failure prevents proposal dispatch; saving later retains the unused request identity without automatic retry');
  page.off('request', countProposalPost);
  await panel.getByRole('button', { name: 'Review a bill from saved mail', exact: true }).click();
  await editor.getByLabel('Saved conversation', { exact: true }).selectOption(itemId); await editor.getByLabel('Source message', { exact: true }).selectOption('def');
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  const proposalIds = [];
  await page.route('**/api/bill-proposals', async route => {
    proposalIds.push(route.request().postDataJSON().requestId);
    const actual = await route.fetch({ timeout: 270000 }); assert.equal(actual.status(), 200);
    // The worker and durable request run for real; only the first HTTP response
    // is replaced to exercise the user's uncertain-result recovery controls.
    if (proposalIds.length === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Explicit fictional lost proposal response' }) });
    else await route.fulfill({ response: actual });
  });
  await editor.getByLabel('Bill note', { exact: true }).fill('Keep this bill draft during an uncertain proposal result');
  await editor.getByRole('button', { name: 'Ask Bud to propose fields', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Explicit fictional lost proposal response' }).waitFor({ timeout: 60000 });
  await editor.getByText('The request identifier is kept.', { exact: false }).waitFor({ timeout: 60000 });
  assert.ok(await editor.getByLabel('Saved conversation', { exact: true }).isDisabled());
  assert.ok(await editor.getByRole('button', { name: 'Cancel bill review', exact: true }).isEnabled());
  assert.ok(await editor.getByRole('button', { name: 'Save for later', exact: true }).isEnabled());
  await editor.getByLabel('Find a saved conversation', { exact: true }).fill('No fictional conversation matches');
  await editor.getByText('Showing 0 of 0 conversations', { exact: false }).waitFor();
  await panel.getByRole('button', { name: 'Refresh bills and sources', exact: true }).click();
  await panel.getByText('Saved bills and available sources refreshed.', { exact: true }).waitFor();
  assert.equal(await editor.getByLabel('Saved conversation', { exact: true }).inputValue(), itemId);
  assert.equal(await editor.getByLabel('Bill note', { exact: true }).inputValue(), 'Keep this bill draft during an uncertain proposal result');
  await editor.getByRole('group', { name: 'Saved mail source picker', exact: true }).screenshot({ path: join(output, 'mail-picker-uncertain-desktop.png') });
  await editor.getByRole('button', { name: 'Check the saved proposal request', exact: true }).click();
  await editor.getByRole('complementary', { name: 'Bill field proposal' }).waitFor({ timeout: 60000 });
  assert.equal(proposalIds.length, 1); assert.ok(readPaths.includes(`/api/bill-proposals/${proposalIds[0]}`));
  const requestDraftPage = await request('/api/bill-review-drafts?filter=active&limit=10');
  let requestDraft;
  for (const summary of requestDraftPage.items) { const candidate = (await request(`/api/bill-review-drafts/${summary.id}`)).draft; if (candidate.proposalRequest?.requestId === proposalIds[0]) requestDraft = candidate; }
  assert.ok(requestDraft);
  await editor.getByRole('button', { name: 'Save for later', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  await page.reload(); await panel.waitFor();
  await panel.locator(`[data-review-id="${requestDraft.id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  assert.equal(await editor.getByLabel('Bill note', { exact: true }).inputValue(), 'Keep this bill draft during an uncertain proposal result');
  assert.ok(!await editor.getByLabel('I reviewed this source', { exact: false }).isChecked());
  assert.ok(await editor.getByRole('button', { name: 'Cancel bill review', exact: true }).isEnabled());
  await editor.getByRole('button', { name: 'Check the saved proposal request', exact: true }).click();
  await editor.getByRole('complementary', { name: 'Bill field proposal' }).waitFor();
  assert.equal(proposalIds.length, 1); assert.equal(JSON.parse(readFileSync(workerCalls, 'utf8')).length, 1);
  pass('Save for later and full reload retain the exact uncertain request; reopening and checking issue no proposal POST or extra worker call');
  await page.unroute('**/api/bill-proposals');
  await editor.getByLabel('Find a saved conversation', { exact: true }).fill('');
  await editor.getByText('Showing 1 of 1 conversations', { exact: false }).waitFor();
  pass('Explicit lost-response injection preserves the real proposal request ID and bill draft across search/refresh; historical GET recovers the result with no second POST and the fictional worker runs once');
  await editor.getByText('123.45', { exact: true }).waitFor();
  assert.equal((await request('/api/bill-register')).occurrences.items.length, 0);
  assert.equal(JSON.parse(readFileSync(workerCalls, 'utf8')).length, 1);
  await editor.getByText('PDF text read · fictional-invoice.pdf · 1 page', { exact:true }).click();
  await editor.getByText('Fictional Water invoice FICTION-001 AUD 123.45. Check the original before accepting.', { exact:true }).waitFor();
  assert.equal(attachmentCalls,1);
  const workerInput=JSON.parse(readFileSync(join(data,'vault/workflow-inputs/accounts-invoices.json'),'utf8'));
  assert.equal(workerInput.attachments[0].status,'read');assert.equal(workerInput.coverage.missingAttachments.length,0);assert.equal(workerInput.allowedAttachmentPaths.length,0);
  assert.ok(!JSON.stringify(workerInput).includes(pdfBytes.toString('base64')));
  for(const width of [390,768,1280]) {await page.setViewportSize({width,height:1000});await editor.getByText('PDF text read · fictional-invoice.pdf · 1 page', {exact:true}).scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(output,`pdf-proposal-${width}.png`),fullPage:true});}
  pass('One verified fictional PDF is parsed by the real restricted helper, shown as untrusted extracted text and reused on proposal reconciliation without downloading again');
  await editor.getByLabel('Bill property', { exact: false }).selectOption(propertyId); await editor.getByLabel('Bill kind', { exact: false }).fill('Water'); await editor.getByLabel('Vendor', { exact: false }).fill('Fictional Water'); await editor.getByLabel('Amount (AUD)', { exact: false }).fill('123.45'); await editor.getByLabel('Invoice date, if confirmed', { exact: false }).fill(sourceDate); await editor.getByLabel('Actual due date, if confirmed', { exact: false }).fill(dueDate); await editor.getByLabel('Reason for this bill review', { exact: false }).fill('Fictional source body, PDF text and property checked against the synthetic original');
  await editor.getByLabel('I reviewed this source', { exact: false }).check(); assert.equal(await editor.getByRole('button', { name: 'Accept reviewed bill', exact: true }).isDisabled(), true); await editor.getByLabel('I understand attachment contents', { exact: false }).check();
  let acceptancePosts = 0;
  await page.route('**/api/bill-occurrences', async route => { if (route.request().method() !== 'POST') return route.continue(); acceptancePosts++; const actual = await route.fetch(); assert.equal(actual.status(), 200); await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Explicit fictional lost bill acceptance response' }) }); });
  await editor.getByRole('button', { name: 'Accept reviewed bill', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  assert.equal(acceptancePosts, 1); await page.unroute('**/api/bill-occurrences');
  assert.equal((await request(`/api/bill-review-drafts/${requestDraft.id}`)).draft.state, 'accepted');
  pass('Lost acceptance response reconciles by exact saved-bill readback, records accepted draft and sends no duplicate bill mutation');
  await panel.getByLabel('Include closed reviews', { exact: true }).check();
  await panel.locator(`[data-review-id="${requestDraft.id}"]`).getByRole('button', { name: 'View saved review', exact: true }).click();
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  assert.ok(await editor.getByLabel('Bill note', { exact: true }).isDisabled());
  await editor.getByRole('button', { name: 'Check the saved proposal request', exact: true }).click(); await editor.getByRole('complementary', { name: 'Bill field proposal' }).waitFor();
  await editor.getByRole('button', { name: 'Close review history', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  await panel.getByLabel('Include closed reviews', { exact: true }).uncheck();
  pass('Closed accepted review retains fields and request receipt read-only, with an available history close action');
  let saved = await request('/api/bill-register'); assert.equal(saved.occurrences.items.length, 1); let bill = saved.occurrences.items[0]; assert.equal(bill.facts.currency, 'AUD'); assert.equal(bill.facts.amountCents, 12345); assert.equal(bill.source.message.id, 'def'); assert.equal(bill.state, 'received');
  pass('Actual UI acceptance requires source review plus original-attachment acknowledgement and retains source evidence');
  const evidence = await request(`/api/bill-evidence/${itemId}?messageId=def`), accepted = { itemId, messageId: 'def', expectedSourceDigest: evidence.digest, sourceReviewed: true, limitedSourceAcknowledged: true, facts: bill.facts, reviewReason: 'Fictional reviewed bill' };
  await request('/api/bill-scan', 'POST', {}); assert.equal((await request(`/api/bill-evidence/${itemId}?messageId=def`)).digest, evidence.digest);
  assert.equal((await request('/api/bill-occurrences', 'POST', accepted)).id, bill.id);
  await request('/api/bill-occurrences', 'POST', { ...accepted, facts: { ...bill.facts, propertyId: 'not-in-this-workspace' } }, 409);
  await request('/api/bill-occurrences', 'POST', { ...accepted, expectedSourceDigest: '0'.repeat(64) }, 409);
  assert.equal((await request('/api/bill-register')).occurrences.items.length, 1);
  pass('Real host API deduplicates a rescan while rejecting stale source digest and unknown workspace property');
  await panel.getByRole('button', { name: 'Review recurring arrivals', exact: true }).click();
  const pattern = panel.getByRole('form', { name: 'Approve bill arrival pattern' }); await pattern.getByLabel('Observed anchor date', { exact: false }).fill(sourceDate); await pattern.getByLabel('Days before anchor', { exact: false }).fill('0'); await pattern.getByLabel('Days after anchor', { exact: false }).fill('0'); await pattern.getByLabel('Arrival timezone', { exact: false }).fill('UTC'); await pattern.getByLabel('Reason for this arrival pattern', { exact: false }).fill('Fictional monthly arrival agreed by staff'); await pattern.getByRole('button', { name: 'Approve arrival pattern', exact: true }).click(); await pattern.waitFor({ state: 'hidden' });
  const calendar = panel.getByRole('region', { name: 'Bill calendar', exact: true });
  const waitForBills = () => page.waitForFunction(() => document.querySelector('section[aria-label="Source-linked bills and calendar"]')?.getAttribute('aria-busy') === 'false');
  const monthNames = Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat('en-AU', { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, month, 1)));
  const calendarDate = date => page.evaluate(value => new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)), date);
  const selectCalendarDay = async date => {
    await waitForBills();
    const [year, month, day] = date.split('-').map(Number);
    const [shownMonth, shownYear] = (await calendar.getByRole('heading', { level: 4 }).innerText()).split(' ');
    assert.ok(monthNames.includes(shownMonth));
    let current = Number(shownYear) * 12 + monthNames.indexOf(shownMonth);
    const target = year * 12 + month - 1, step = target > current ? 1 : -1;
    while (current !== target) {
      await calendar.getByRole('button', { name: step > 0 ? 'Next month' : 'Previous month', exact: true }).click();
      current += step;
      await calendar.getByRole('heading', { name: `${monthNames[current % 12]} ${Math.floor(current / 12)}`, exact: true }).waitFor();
      await waitForBills();
    }
    const dayButton = calendar.getByRole('button', { name: new RegExp(`^${day} ${monthNames[month - 1]}:`) });
    if (await dayButton.getAttribute('aria-pressed') !== 'true') await dayButton.click();
    const dayPanel = calendar.getByRole('region', { name: `Bills on ${await calendarDate(date)}`, exact: true });
    await dayPanel.waitFor();
    return dayPanel;
  };
  saved = await request(`/api/bill-register?from=${sourceDate}&to=${rangeEnd}`); assert.equal(saved.series.items.length, 1); assert.equal(saved.calendar.items.filter(e => e.type === 'invoice-due').length, 1); assert.ok(saved.calendar.items.some(e => e.type === 'expected-arrival' && e.state === 'predicted' && e.billId === null)); assert.equal(saved.occurrences.items.length, 1);
  const firstDueDay = await selectCalendarDay(dueDate);
  await firstDueDay.getByText(`Due · ${await calendarDate(dueDate)}`, { exact: true }).waitFor();
  await firstDueDay.getByText('Due date entered in the received bill’s source review.', { exact: true }).waitFor();
  // The unpaid received bill also yields an expected payment on its due date; count each entry separately.
  assert.equal(await firstDueDay.locator('li:not([data-entry="payment"])').getByRole('button', { name: 'Open received bill', exact: true }).count(), 1);
  const expectedPayment = firstDueDay.locator('li[data-entry="payment"]');
  assert.equal(await expectedPayment.count(), 1);
  await expectedPayment.getByText(/^Expected payment · /).first().waitFor();
  assert.equal(await firstDueDay.getByRole('button', { name: 'Review arrival pattern', exact: true }).count(), 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await calendar.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'bill-calendar-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await calendar.scrollIntoViewIfNeeded();
  assert.ok(await firstDueDay.isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, 'bill-calendar-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const firstPrediction = saved.calendar.items.find(entry => entry.type === 'expected-arrival');
  const firstArrivalDay = await selectCalendarDay(firstPrediction.date);
  await firstArrivalDay.getByText(`Expected · ${await calendarDate(firstPrediction.date)}`, { exact: true }).waitFor();
  await firstArrivalDay.getByText('Predicted from your approved arrival pattern. Not an invoice or due date.', { exact: true }).waitFor();
  assert.equal(await firstArrivalDay.getByRole('button', { name: 'Review arrival pattern', exact: true }).count(), 1);
  assert.equal(await firstArrivalDay.getByRole('button', { name: 'Open received bill', exact: true }).count(), 0);
  await firstArrivalDay.getByRole('button', { name: 'Close day', exact: true }).click();
  await firstArrivalDay.waitFor({ state: 'hidden' });
  pass('Separate explicit recurring approval produces arrival predictions while preserving the single reviewed invoice due date');
  await panel.getByRole('button', { name: 'Review or correct bill', exact: true }).click(); editor = panel.getByRole('form', { name: 'Review source bill' }); await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor(); await editor.getByLabel('Actual due date, if confirmed', { exact: false }).fill(laterDate); await editor.getByLabel('Bill review status', { exact: false }).selectOption('hold'); await editor.getByLabel('Reason for this bill review', { exact: false }).fill('Fictional staff correction with earlier date retained'); await editor.getByLabel('I reviewed this source', { exact: false }).check(); await editor.getByLabel('I understand attachment contents', { exact: false }).check(); await editor.getByRole('button', { name: 'Save bill correction', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  saved = await request('/api/bill-register'); bill = saved.occurrences.items[0]; assert.equal(bill.revision, 2); assert.equal(bill.history[0].facts.dueDate, dueDate); assert.equal(bill.facts.dueDate, laterDate);
  await request(`/api/bill-occurrences/${bill.id}`, 'PUT', { ...accepted, expectedRevision: 1, state: 'received' }, 409); await request(`/api/bill-occurrences/${bill.id}`, 'PUT', { ...accepted, expectedRevision: 2, state: 'paid' }, 400);
  await page.reload(); await panel.waitFor(); await panel.getByText('On hold · revision 2', { exact: true }).waitFor();
  pass('UI correction and reload retain earlier evidence; real API rejects stale corrections and payment-state mutation');
  await page.screenshot({ path: join(output, 'bills-desktop.png') }); const savedCard = panel.locator(`[id="${bill.id}"]`); await savedCard.getByText('Source and correction history (1)', { exact: true }).click(); await savedCard.screenshot({ path: join(output, 'bills-history-desktop.png') }); await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('heading', { name: /bills and calendar$/i }).first().scrollIntoViewIfNeeded(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(output, 'bills-mobile.png') });
  await panel.getByRole('button', { name: 'Review or correct bill', exact: true }).click(); editor = panel.getByRole('form', { name: 'Review source bill' }); await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor(); await editor.getByRole('complementary', { name: 'Bill source evidence' }).screenshot({ path: join(output, 'bills-source-mobile.png') }); await editor.getByLabel('Bill note', { exact: true }).focus(); await page.keyboard.press('Tab'); assert.ok(await editor.getByLabel('Reason for this bill review', { exact: false }).evaluate(element => element === document.activeElement)); await editor.getByRole('button', { name: 'Save for later', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'draft-actions-mobile.png') }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); assert.deepEqual(errors, []);
  pass('Built full-page UI, source form and saved history render at desktop and390px with no page errors or horizontal overflow');
  await editor.getByRole('button', { name: 'Cancel bill review', exact: true }).click(); if (await panel.getByRole('alertdialog', { name: 'Discard unsaved bill review', exact: true }).count()) await panel.getByRole('button', { name: 'Discard unsaved bill review', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const originPattern = (await request(`/api/bill-occurrences/${bill.id}`)).originSeries;
  const originalPrediction = (await request(`/api/bill-register?from=${sourceDate}&to=${rangeEnd}`)).calendar.items.find(entry => entry.type === 'expected-arrival');
  // Add real source-reviewed records through HTTP. Only the connector content
  // is fictional, apart from the explicit calendar cursor-conflict response below.
  extraThreads = Array.from({ length: 24 }, (_, index) => ({ id: (4096 + index).toString(16), historyComplete: true, messages: [{
    id: (8192 + index).toString(16), threadId: (4096 + index).toString(16), at: sourceAt,
    direction: 'incoming', from: 'fixture@example.test', to: 'office@example.test', subject: `Retained fixture bill ${index + 1}`,
    body: `Fictional source ${index + 1}; AUD 10.00; due ${dueDate}.`, bodyTruncated: false, attachments: [],
  }] }));
  await request('/api/bill-scan', 'POST', {});
  const expandedMail = await request('/api/mail-workspace/items?group=all&limit=100');
  for (let index = 0; index < extraThreads.length; index++) {
    const source = expandedMail.items.find(item => item.threadId === extraThreads[index].id);
    const preview = await request(`/api/bill-evidence/${source.id}?messageId=${extraThreads[index].messages[0].id}`);
    const review = { itemId: source.id, messageId: preview.message.id, expectedSourceDigest: preview.digest,
      sourceReviewed: true, limitedSourceAcknowledged: true, facts: { ...bill.facts, propertyId: index < 2 ? secondPropertyId : propertyId,
        kind: `Fixture ${index + 1}`, vendor: `Fictional Supplier ${index + 1}`, amountCents: 1000, dueDate, note: 'Pagination fixture' }, reviewReason: 'Explicit fictional review for retained-page rehearsal' };
    const received = await request('/api/bill-occurrences', 'POST', review);
    await request('/api/bill-series', 'POST', { occurrenceId: received.id, expectedOccurrenceRevision: received.revision, intervalMonths: 1,
      anchorDate: sourceDate, windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'UTC', reviewReason: 'Explicit fictional monthly pattern review' });
    if (index === 23) await request(`/api/bill-occurrences/${received.id}`, 'PUT', { ...review, expectedRevision: received.revision, state: 'hold', reviewReason: 'Fictional second held bill for draft-preservation rehearsal' });
  }
  await request('/api/expected-bills', 'POST', { propertyId, kind: 'Retained legacy fixture', status: 'hold', note: 'Earlier register row must remain visible separately.' });
  await page.reload(); await panel.waitFor();
  await panel.getByRole('heading', { name: 'Received bill records (20 of 25)', exact: true }).waitFor();
  assert.equal(await panel.locator(`[id="${bill.id}"]`).count(), 0);
  await page.getByText('Retained legacy fixture', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Load more bill records', exact: true }).click();
  await panel.getByRole('heading', { name: 'Received bill records (25 of 25)', exact: true }).waitFor();
  assert.equal(await panel.locator(`[id="${bill.id}"]`).count(), 1);
  await panel.getByLabel('Property filter', { exact: true }).selectOption(secondPropertyId);
  await panel.getByRole('heading', { name: 'Received bill records (2 of 2)', exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Load more bill records', exact: true }).count(), 0);
  await panel.getByLabel('Property filter', { exact: true }).selectOption('');
  await panel.getByRole('heading', { name: 'Received bill records (20 of 25)', exact: true }).waitFor();
  pass('Bounded received pages load25 unique records; property changes reset cursors; separate earlier-register query retains its legacy row');
  await panel.getByRole('button', { name: 'Review a bill from saved mail', exact: true }).click();
  editor = panel.getByRole('form', { name: 'Review source bill' });
  await editor.getByLabel('Find a saved conversation', { exact: true }).fill('');
  await editor.getByText('Showing 20 of 25 conversations', { exact: false }).waitFor();
  await editor.getByRole('button', { name: 'Load more saved conversations', exact: true }).click();
  await editor.getByText('Showing 25 of 25 conversations', { exact: false }).waitFor();
  assert.equal(await editor.getByLabel('Saved conversation', { exact: true }).locator('option').count(), 26);
  pass('Source picker requests bounded pages and loads all25 conversations only after explicit continuation');
  await editor.getByLabel('Find a saved conversation', { exact: true }).fill('Fictional water invoice');
  await editor.getByText('Showing 1 of 1 conversations', { exact: false }).waitFor();
  await editor.getByLabel('Saved conversation', { exact: true }).selectOption(itemId);
  await editor.getByLabel('Source message', { exact: true }).selectOption('def');
  await editor.getByText('This message already has a saved bill.', { exact: false }).waitFor();
  assert.ok(await editor.getByRole('button', { name: 'Accept reviewed bill', exact: true }).isDisabled());
  await editor.getByRole('button', { name: 'Open its saved review', exact: true }).click();
  await editor.getByRole('heading', { name: 'Correct a saved bill', exact: true }).waitFor();
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  assert.ok(readPaths.includes(`/api/bill-occurrences/by-source/${evidence.identity}`));
  assert.ok(readPaths.includes(`/api/bill-occurrences/${bill.id}/source`));
  await editor.getByLabel('Bill note', { exact: true }).fill('Keep this unsaved fictional draft during refresh');
  const otherConversation = expandedMail.items.find(item => item.threadId === extraThreads[23].id);
  await editor.getByLabel('Find a saved conversation', { exact: true }).fill('Retained fixture bill 24');
  await editor.getByText('Showing 1 of 1 conversations', { exact: false }).waitFor();
  assert.equal(await editor.getByLabel('Saved conversation', { exact: true }).inputValue(), itemId);
  await page.route(`**/api/mail-workspace/items/${otherConversation.id}/source`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Explicit fictional unavailable source read' }) }));
  await editor.getByLabel('Saved conversation', { exact: true }).selectOption(otherConversation.id);
  await panel.getByRole('alert').filter({ hasText: 'Explicit fictional unavailable source read' }).waitFor();
  assert.equal(await editor.getByLabel('Saved conversation', { exact: true }).inputValue(), itemId);
  assert.equal(await editor.getByLabel('Source message', { exact: true }).inputValue(), 'def');
  assert.equal(await editor.getByLabel('Bill note', { exact: true }).inputValue(), 'Keep this unsaved fictional draft during refresh');
  await page.unroute(`**/api/mail-workspace/items/${otherConversation.id}/source`);
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.getByRole('group', { name: 'Saved mail source picker', exact: true }).screenshot({ path: join(output, 'mail-picker-selected-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await editor.getByRole('button', { name: 'Cancel bill review', exact: true }).click();
  const billDiscard = panel.getByRole('alertdialog', { name: 'Discard unsaved bill review', exact: true });
  await billDiscard.getByRole('button', { name: 'Keep editing this bill', exact: true }).click();
  assert.equal(await editor.getByLabel('Bill note', { exact: true }).inputValue(), 'Keep this unsaved fictional draft during refresh');
  pass('Bill source search retains its off-page selection; explicitly injected failed source read and cancelled discard preserve evidence and unsaved fields');
  await panel.getByRole('button', { name: 'Refresh bills and sources', exact: true }).click();
  await panel.getByText('Saved bills and available sources refreshed.', { exact: true }).waitFor();
  assert.equal(await editor.getByLabel('Bill note', { exact: true }).inputValue(), 'Keep this unsaved fictional draft during refresh');
  assert.equal(await editor.getByText('This bill changed elsewhere.', { exact: false }).count(), 0);
  await editor.getByRole('button', { name: 'Cancel bill review', exact: true }).click(); if (await panel.getByRole('alertdialog', { name: 'Discard unsaved bill review', exact: true }).count()) await panel.getByRole('button', { name: 'Discard unsaved bill review', exact: true }).click();
  pass('Direct source identity finds an accepted bill outside the firstpage; direct current-mail source opens it and refresh preserves its unsaved draft');
  const correctedDueDay = await selectCalendarDay(laterDate);
  const moreCalendar = calendar.getByRole('button', { name: 'Load more for this month', exact: true });
  const originalDue = correctedDueDay.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Open received bill', exact: true }) }).filter({ hasText: 'Fictional Water' });
  for (let count = 0; count < 10 && !await originalDue.count(); count++) {
    await moreCalendar.click();
    await waitForBills();
  }
  await originalDue.getByText(`Due · ${await calendarDate(laterDate)}`, { exact: true }).waitFor();
  await originalDue.getByRole('button', { name: 'Open received bill', exact: true }).click();
  await editor.getByRole('heading', { name: 'Correct a saved bill', exact: true }).waitFor();
  assert.equal(await editor.getByLabel('Vendor', { exact: true }).inputValue(), 'Fictional Water');
  await editor.getByRole('button', { name: 'Cancel bill review', exact: true }).click(); if (await panel.getByRole('alertdialog', { name: 'Discard unsaved bill review', exact: true }).count()) await panel.getByRole('button', { name: 'Discard unsaved bill review', exact: true }).click();
  const predictionDay = await selectCalendarDay(originalPrediction.date);
  // Refresh even when both fixture dates share a month, resetting all cursors.
  await panel.getByRole('button', { name: 'Refresh bills and sources', exact: true }).click();
  await panel.getByText('Saved bills and available sources refreshed.', { exact: true }).waitFor();
  await waitForBills();
  await moreCalendar.waitFor();
  const calendarBeforeConflict = await calendar.innerText();
  const calendarPageRoute = url => url.pathname === '/api/bill-register/calendar';
  await page.route(calendarPageRoute, async route => {
    const actual = await route.fetch(); assert.equal(actual.status(), 200);
    const cursor = new URL(route.request().url()).searchParams.get('cursor'); assert.ok(cursor);
    await route.fulfill({ response: actual, json: { ...await actual.json(), nextCursor: cursor } });
  });
  await moreCalendar.click();
  await panel.getByRole('alert').filter({ hasText: 'The calendar page changed. Refresh before loading more.' }).waitFor();
  await waitForBills();
  assert.equal(await calendar.innerText(), calendarBeforeConflict);
  await page.unroute(calendarPageRoute);
  await panel.getByRole('button', { name: 'Refresh bills and sources', exact: true }).click();
  await panel.getByText('Saved bills and available sources refreshed.', { exact: true }).waitFor();
  await waitForBills();
  assert.equal(await panel.getByRole('alert').filter({ hasText: 'The calendar page changed. Refresh before loading more.' }).count(), 0);
  pass('A repeated calendar cursor shows the refresh-required conflict, retains the selected day and loaded entries, and clears after refresh');
  const originalArrival = predictionDay.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Review arrival pattern', exact: true }) }).filter({ hasText: 'Fictional Water' });
  let calendarPagesLoaded = 0;
  while (calendarPagesLoaded < 10 && await moreCalendar.count()) {
    await moreCalendar.click();
    await waitForBills();
    calendarPagesLoaded++;
  }
  assert.ok(calendarPagesLoaded > 0); assert.equal(await moreCalendar.count(), 0);
  assert.equal(await predictionDay.getByRole('button', { name: 'Review arrival pattern', exact: true }).count(), 25);
  await originalArrival.getByText(`Expected · ${await calendarDate(originalPrediction.date)}`, { exact: true }).waitFor();
  await originalArrival.getByText('Predicted from your approved arrival pattern. Not an invoice or due date.', { exact: true }).waitFor();
  await originalArrival.getByRole('button', { name: 'Review arrival pattern', exact: true }).click();
  await pattern.getByRole('button', { name: 'Save arrival pattern revision', exact: true }).waitFor();
  assert.ok(readPaths.includes(`/api/bill-series/${originPattern.id}`));
  assert.equal(await panel.locator(`[id="${bill.id}"]`).count(), 0);
  await pattern.getByRole('button', { name: 'Cancel pattern review', exact: true }).click();
  const patterns = panel.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Saved arrival patterns/ }) });
  await patterns.locator('summary').first().click();
  await patterns.getByRole('button', { name: 'Load more arrival patterns', exact: true }).click();
  await patterns.locator('summary').filter({ hasText: 'Saved arrival patterns (25 of 25)' }).waitFor();
  pass('Paged calendar opens off-page bill and arrival-pattern origin directly; independent pattern pages retain all25 reviewed series');
  await page.screenshot({ path: join(output, 'bills-retained-pages-desktop.png') });
  const tabs = (await request('/api/workspace-tabs')).state, viewId = `view-${randomUUID()}`;
  await request('/api/workspace-tabs', 'PUT', { version: 1, expectedRevision: tabs.revision, tabs: [...tabs.tabs, { id: viewId, label: 'Bills needing review', visible: true, view: { kind: 'bills', filter: 'needs-you' } }] });
  await page.goto(base + `/#/views/${viewId}`); await page.reload();
  const filtered = page.getByRole('region', { name: 'Saved bills list', exact: true });
  await filtered.getByText('3 of 3 matching records loaded', { exact: false }).waitFor();
  await filtered.getByLabel('Find in this view', { exact: true }).fill('Water');
  await filtered.getByText('1 of 1 matching records loaded', { exact: false }).waitFor();
  await filtered.getByRole('button', { name: /^Open received bill/ }).click();
  const selectedEditor = filtered.getByRole('form', { name: 'Review source bill', exact: true });
  await selectedEditor.getByRole('heading', { name: 'Correct a saved bill', exact: true }).waitFor();
  await selectedEditor.getByLabel('Bill note', { exact: true }).fill('Keep this draft while changing the search');
  await filtered.getByLabel('Find in this view', { exact: true }).fill('');
  await filtered.getByText('3 of 3 matching records loaded', { exact: false }).waitFor();
  const anotherRow = filtered.locator(':scope > ul > li').filter({ hasText: 'Fixture 24' });
  assert.ok(await anotherRow.getByRole('button', { name: /^Open received bill/ }).isDisabled());
  assert.equal(await selectedEditor.getByLabel('Bill note', { exact: true }).inputValue(), 'Keep this draft while changing the search');
  await filtered.getByRole('button', { name: 'Close selected review and keep draft', exact: true }).click();
  assert.ok(await anotherRow.getByRole('button', { name: /^Open received bill/ }).isEnabled());
  await anotherRow.getByRole('button', { name: /^Open received bill/ }).click();
  await selectedEditor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  assert.equal(await selectedEditor.getByLabel('Vendor', { exact: true }).inputValue(), 'Fictional Supplier 24');
  assert.notEqual(await selectedEditor.getByLabel('Bill note', { exact: true }).inputValue(), 'Keep this draft while changing the search');
  await filtered.getByRole('button', { name: 'Close selected review and keep draft', exact: true }).click();
  pass('Explicit saved-bill B opens B after closing A; A remains a retained draft instead of replacing the requested editor');
  pass('Filtered saved bill shortcut queries all matching retained records and opens the selected off-page source bill directly');
  pass('A selected-bill draft survives search changes and remains retained when its selected review is closed');

  // Same exact fictional invoice evidence arriving in a new message must hold
  // until staff review it. All reads and writes below use the real host routes.
  const originalMail = expandedMail.items.find(item => item.threadId === extraThreads[0].id);
  const originalEvidence = await request(`/api/bill-evidence/${originalMail.id}?messageId=${extraThreads[0].messages[0].id}`);
  let duplicateOriginal = (await request(`/api/bill-occurrences/by-source/${originalEvidence.identity}`)).occurrence;
  assert.ok(duplicateOriginal);
  extraThreads.push({ id: 'abc999', historyComplete: true, messages: [{ ...extraThreads[0].messages[0], id: 'def999', threadId: 'abc999', subject: 'Fictional resend requiring duplicate review' }] });
  await request('/api/bill-scan', 'POST', {});
  const resendMail = (await request('/api/mail-workspace/items?group=all&limit=100')).items.find(item => item.threadId === 'abc999');
  const resendEvidence = await request(`/api/bill-evidence/${resendMail.id}?messageId=def999`);
  const separateReason = 'Fictional staff checked both originals and explicitly confirmed separate invoices.';
  const resendFacts = { ...duplicateOriginal.facts, note: 'Fictional duplicate candidate draft preserved' };
  const resendReview = { itemId: resendMail.id, messageId: 'def999', expectedSourceDigest: resendEvidence.digest, sourceReviewed: true, facts: resendFacts, reviewReason: separateReason };
  assert.equal((await request('/api/bill-occurrences', 'POST', resendReview, 409)).code, 'bill_duplicate_review_required');
  await page.goto(billsUrl); await page.reload(); await panel.waitFor();
  await panel.getByRole('button', { name: 'Review a bill from saved mail', exact: true }).click();
  editor = panel.getByRole('form', { name: 'Review source bill' });
  await editor.getByLabel('Find a saved conversation', { exact: true }).fill('Fictional resend requiring duplicate review');
  await editor.getByText('Showing 1 of 1 conversations', { exact: false }).waitFor();
  await editor.getByLabel('Saved conversation', { exact: true }).selectOption(resendMail.id);
  await editor.getByLabel('Source message', { exact: true }).selectOption('def999');
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  await editor.getByLabel('Bill property', { exact: true }).selectOption(resendFacts.propertyId);
  await editor.getByLabel('Bill kind', { exact: true }).fill(resendFacts.kind);
  await editor.getByLabel('Vendor', { exact: true }).fill(resendFacts.vendor);
  await editor.getByLabel('Amount (AUD)', { exact: true }).fill(String(resendFacts.amountCents / 100));
  await editor.getByLabel('Invoice date, if confirmed', { exact: true }).fill(resendFacts.invoiceDate);
  await editor.getByLabel('Actual due date, if confirmed', { exact: true }).fill(resendFacts.dueDate);
  await editor.getByLabel('Bill note', { exact: true }).fill(resendFacts.note);
  await editor.getByLabel('Reason for this bill review', { exact: true }).fill(separateReason);
  await editor.getByLabel('I reviewed this source', { exact: false }).check();
  const distinct = editor.getByLabel('I checked the matching bills and confirm this is a separate invoice.', { exact: false });
  await distinct.waitFor(); assert.ok(!await distinct.isChecked());
  assert.ok(await editor.getByRole('button', { name: 'Accept reviewed bill', exact: true }).isDisabled());
  assert.equal((await request('/api/bill-register')).occurrences.total, 25);
  await page.screenshot({ path: join(output, 'duplicate-candidate-hold-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await distinct.scrollIntoViewIfNeeded(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, 'duplicate-candidate-hold-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  pass('Exact invoice evidence under a new message is held by both API and actual desktop/mobile UI; no second bill is silently saved');

  await distinct.check();
  await editor.getByRole('button', { name: 'Save draft and open matching bill', exact: true }).click();
  await editor.getByRole('heading', { name: 'Correct a saved bill', exact: true }).waitFor();
  assert.equal(await editor.getByLabel('Vendor', { exact: true }).inputValue(), duplicateOriginal.facts.vendor);
  let resendDraft;
  for (const summary of (await request('/api/bill-review-drafts?filter=active&limit=100')).items) {
    const draft = (await request(`/api/bill-review-drafts/${summary.id}`)).draft;
    if (draft.fields.note === resendFacts.note) resendDraft = draft;
  }
  assert.ok(resendDraft); assert.equal(resendDraft.state, 'saved');
  await editor.getByRole('button', { name: 'Cancel bill review', exact: true }).click();
  if (await panel.getByRole('alertdialog', { name: 'Discard unsaved bill review', exact: true }).count()) await panel.getByRole('button', { name: 'Discard unsaved bill review', exact: true }).click();
  await page.reload(); await panel.waitFor();
  await panel.locator(`[data-review-id="${resendDraft.id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  assert.equal(await editor.getByLabel('Bill note', { exact: true }).inputValue(), resendFacts.note);
  assert.ok(!await editor.getByLabel('I reviewed this source', { exact: false }).isChecked());
  await editor.getByLabel('I reviewed this source', { exact: false }).check();
  await distinct.waitFor(); assert.ok(!await distinct.isChecked());
  pass('Opening a matching bill saves the original draft; reloading restores its fields while requiring fresh source and distinct-invoice confirmation');

  await distinct.check();
  duplicateOriginal = await request(`/api/bill-occurrences/${duplicateOriginal.id}`, 'PUT', { itemId: originalMail.id, messageId: originalEvidence.message.id, expectedSourceDigest: originalEvidence.digest,
    expectedRevision: duplicateOriginal.revision, sourceReviewed: true, facts: duplicateOriginal.facts, state: 'hold', reviewReason: 'Fictional concurrent status review invalidates an older duplicate confirmation.' });
  await editor.getByRole('button', { name: 'Accept reviewed bill', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'The matching records may have changed.' }).waitFor();
  assert.ok(!await distinct.isChecked()); assert.ok(await editor.getByRole('button', { name: 'Accept reviewed bill', exact: true }).isDisabled());
  assert.equal((await request('/api/bill-register')).occurrences.total, 25);
  pass('A candidate revision changed in another session invalidates the UI confirmation at submit and leaves the second invoice unsaved');
  await distinct.check();
  await editor.getByRole('button', { name: 'Accept reviewed bill', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  const separateBill = (await request(`/api/bill-occurrences/by-source/${resendEvidence.identity}`)).occurrence;
  assert.ok(separateBill); assert.equal(separateBill.duplicateReview.candidates[0].revision, duplicateOriginal.revision);
  assert.equal(separateBill.duplicateReview.reason, separateReason);
  assert.equal((await request('/api/bill-occurrences', 'POST', resendReview)).id, separateBill.id);
  assert.equal((await request('/api/bill-register')).occurrences.total, 26);
  await page.reload(); await panel.waitFor();
  const reopened = (await request(`/api/bill-occurrences/${separateBill.id}`)).occurrence;
  assert.deepEqual(reopened.duplicateReview, separateBill.duplicateReview);
  assert.equal((await request(`/api/bill-review-drafts/${resendDraft.id}`)).draft.state, 'accepted');
  pass('Fresh explicit separate-invoice review saves one auditable second bill; reload and same-message replay preserve its decision without another record');
  assert.deepEqual(errors, []);
} catch (error) { failure = error instanceof Error ? error.stack : String(error); if (page) writeFileSync(join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'No page')); await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await page?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}); await browser?.close(); if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(4000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), wait(4000)]); } } await new Promise(r => connector.close(r)); const childExited = !child || child.exitCode !== null || child.signalCode !== null; if (childExited) rmSync(temp, { recursive: true, force: true }); else failure ??= 'Owned child did not exit; scratch preserved.';
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Actual local HTTP app + built UI; fictional connector + deterministic invoice worker; not live Gmail/Hermes/customer/Windows proof', checks, scanCalls, attachmentCalls, errors, limits: ['Fictional connector and deterministic worker; no live Gmail, payment or calendar provider call.', 'Text-layer PDF only; no OCR or complete image-content proof.', 'Mac browser rendering; no native Windows or two-computer acceptance.'], failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks }, null, 2));
}
