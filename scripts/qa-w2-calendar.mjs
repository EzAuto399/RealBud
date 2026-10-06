import { readSessionToken, primeBrowserSession } from './local-session.mjs';
// W2 positive path (Kevin, Phase A item 4): a weekly-review draft is accepted in the
// built UI, a recurring arrival pattern is approved, and the bill calendar shows the
// reviewed due date and predicted arrivals on separate date bases. Replaying W2
// creates no extra bill, pattern or calendar entry. Actual desktop HTTP service +
// built React UI; fictional connector and deterministic worker only. No customer
// mail, model or financial call; own temp home/data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { fictionalPdf } from '../server/testing/pdf-fixture.ts';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
import { fictionalWorkerModelKey, provisionMockWorkerGrant } from './testing/mock-worker-grant.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud W2 calendar QA '));
const data = join(temp, 'data'), output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/w2-calendar-2026-10-05'));
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
  child = spawn(process.execPath, ['--import', networkGuard, join(root, 'server/index.ts')], { cwd: root, env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_HERMES_CLI: worker, REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR || join(root, 'dist')) }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-24000); });
  let ready = false; for (let i = 0; i < 300; i++) { if (child.exitCode !== null) break; try { if ((await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === child.pid) { ready = true; break; } } catch {} await wait(100); } assert.ok(ready, logs);
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
  let loops = await request('/api/loops');
  const weekly = () => loops.loops.find(loop => loop.id === 'weekly-bills');
  assert.equal(weekly().enabled, false);
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
  const drafts = (await request('/api/bill-review-drafts?filter=active&limit=20')).items;
  assert.equal(drafts.length, 1); assert.equal(drafts[0].state, 'saved');
  assert.equal((await request('/api/bill-register')).occurrences.total, 0);
  pass('Paused W2 run saves one source-bound review draft and creates no bill on its own');

  // Office timezone is Brisbane; the pattern form defaults to the source's arrival date there.
  const zone = 'Australia/Brisbane';
  const arrivalDate = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(sourceAt);
  const plusMonth = (date, n) => { const [y, m, d] = date.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`; };
  const nextArrival = plusMonth(arrivalDate, 1);

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, base, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.on('request', request => { if (request.method() === 'GET') readPaths.push(new URL(request.url()).pathname); }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#/desk');
  await page.locator('.desk-more > summary').filter({ hasText: /^More$/ }).click();
  await page.locator('.desk-options > summary').click();
  await page.getByRole('button', { name: 'Customize desk', exact: true }).click();
  const showBills = page.getByLabel('Show Bills and calendar', { exact: true });
  if (!await showBills.isChecked()) { await showBills.check(); await page.getByRole('button', { name: 'Save layout', exact: true }).click(); await page.getByText('Desk layout saved.', { exact: true }).waitFor(); }
  await page.getByRole('button', { name: 'Close Customize desk', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Source-linked bills and calendar' });
  const openBills = async () => { await page.locator('.desk-other-work > summary').click(); await page.getByRole('group', { name: 'Other work', exact: true }).getByRole('button', { name: 'Bills and calendar', exact: true }).click(); await panel.waitFor(); };
  await openBills();

  // Accept the W2 draft through the actual review form.
  await panel.locator(`[data-review-id="${drafts[0].id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
  const editor = panel.getByRole('form', { name: 'Review source bill' });
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  await editor.getByLabel('Bill property', { exact: false }).selectOption(propertyId);
  await editor.getByLabel('Bill kind', { exact: false }).fill('Water');
  await editor.getByLabel('Vendor', { exact: false }).fill('Fictional Water');
  await editor.getByLabel('Amount (AUD)', { exact: false }).fill('123.45');
  await editor.getByLabel('Invoice date, if confirmed', { exact: false }).fill(sourceDate);
  await editor.getByLabel('Actual due date, if confirmed', { exact: false }).fill(dueDate);
  await editor.getByLabel('Reason for this bill review', { exact: false }).fill('Fictional W2 bill checked against the synthetic original');
  await editor.getByLabel('I reviewed this source', { exact: false }).check();
  const attachmentAck = editor.getByLabel('I understand attachment contents', { exact: false });
  if (await attachmentAck.count()) await attachmentAck.check();
  await editor.getByRole('button', { name: 'Accept reviewed bill', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  let saved = await request('/api/bill-register');
  assert.equal(saved.occurrences.total, 1); const bill = saved.occurrences.items[0];
  assert.equal(bill.state, 'received'); assert.equal(bill.facts.amountCents, 12345); assert.equal(bill.facts.dueDate, dueDate); assert.equal(bill.source.message.id, 'def');
  assert.equal((await request(`/api/bill-review-drafts/${drafts[0].id}`)).draft.state, 'accepted');
  pass('Built UI accepts the W2 draft as one received, source-linked bill with the reviewed due date');

  // Approve the recurring pattern with the form's defaults (Brisbane arrival date).
  await panel.getByRole('button', { name: 'Review recurring arrivals', exact: true }).click();
  const pattern = panel.getByRole('form', { name: 'Approve bill arrival pattern' });
  assert.equal(await pattern.getByLabel('Observed anchor date', { exact: false }).inputValue(), arrivalDate);
  assert.equal(await pattern.getByLabel('Arrival timezone', { exact: false }).inputValue(), zone);
  await pattern.getByLabel('Days before anchor', { exact: false }).fill('0'); await pattern.getByLabel('Days after anchor', { exact: false }).fill('0');
  await pattern.getByLabel('Reason for this arrival pattern', { exact: false }).fill('Fictional monthly water arrival agreed by Kevin');
  await pattern.getByRole('button', { name: 'Approve arrival pattern', exact: true }).click(); await pattern.waitFor({ state: 'hidden' });

  // HTTP calendar readback: each entry carries its own date basis.
  const range = `/api/bill-register?from=${sourceDate}&to=${rangeEnd}`;
  saved = await request(range);
  assert.equal(saved.series.total, 1); const series = saved.series.items[0];
  assert.equal(series.occurrenceId, bill.id); assert.equal(series.anchorDate, arrivalDate); assert.equal(series.timeZone, zone); assert.equal(series.active, true);
  const entries = saved.calendar.items;
  const due = entries.filter(e => e.type === 'invoice-due'), pay = entries.filter(e => e.type === 'expected-payment'), arrivals = entries.filter(e => e.type === 'expected-arrival');
  assert.equal(due.length, 1); assert.equal(due[0].date, dueDate); assert.equal(due[0].billId, bill.id); assert.equal(due[0].basis, 'human-reviewed-invoice-date');
  assert.equal(pay.length, 1, JSON.stringify(pay)); assert.equal(pay[0].date, dueDate); assert.equal(pay[0].basis, 'reviewed-bill-due-date');
  assert.ok(arrivals.length >= 4, JSON.stringify(arrivals));
  assert.ok(arrivals.every(e => e.basis === 'approved-arrival-pattern' && e.state === 'predicted' && e.billId === null && e.seriesId === series.id));
  assert.ok(!arrivals.some(e => e.date === arrivalDate), 'The received bill occupies its own arrival month');
  assert.equal(arrivals[0].date, nextArrival); assert.equal(arrivals[0].endDate, nextArrival);
  const calendarIds = entries.map(e => e.id).sort();
  pass(`Calendar readback: due ${dueDate} (reviewed due date) + expected payment on it; predicted arrivals from ${nextArrival} (approved pattern), none in the bill's own month`);

  // Replay: same request id returns the saved run; a fresh W2 run adds nothing.
  const scans = scanCalls;
  assert.equal((await request('/api/loops/weekly-bills/run', 'POST', first.body, 201)).run.id, first.run.id); assert.equal(scanCalls, scans);
  const second = await launch();
  assert.ok(['partial', 'succeeded', 'completed'].includes(second.run.status), JSON.stringify(second.run));
  assert.ok(scanCalls > scans, 'Fresh W2 run rescanned the fictional inbox');
  const result = (await request('/api/bill-register/routine')).result; assert.equal(result.runId, second.run.id);
  saved = await request(range);
  assert.equal(saved.occurrences.total, 1); assert.equal(saved.occurrences.items[0].id, bill.id); assert.equal(saved.occurrences.items[0].revision, bill.revision);
  assert.equal(saved.series.total, 1); assert.deepEqual(saved.calendar.items.map(e => e.id).sort(), calendarIds);
  assert.equal((await request('/api/bill-review-drafts?filter=active&limit=20')).items.length, 0);
  assert.equal(JSON.parse(readFileSync(workerCalls, 'utf8')).length, 1);
  pass(`W2 replay (same request id + a fresh run, result ${JSON.stringify(result.counts)}) creates no extra bill, pattern, draft, model call or calendar entry`);

  // Built UI calendar shows both date bases, desktop and 390px.
  await page.reload(); await openBills();
  const calendar = panel.getByRole('region', { name: 'Bill calendar', exact: true });
  const waitForBills = () => page.waitForFunction(() => document.querySelector('section[aria-label="Source-linked bills and calendar"]')?.getAttribute('aria-busy') === 'false');
  const monthNames = Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat('en-AU', { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, month, 1)));
  const calendarDate = date => page.evaluate(value => new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)), date);
  const selectCalendarDay = async date => {
    await waitForBills();
    const [year, month, day] = date.split('-').map(Number);
    const [shownMonth, shownYear] = (await calendar.getByRole('heading', { level: 4 }).innerText()).split(' ');
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
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const dueDay = await selectCalendarDay(dueDate);
    await dueDay.getByText(`Due · ${await calendarDate(dueDate)}`, { exact: true }).waitFor();
    await dueDay.getByText('Due date entered in the received bill’s source review.', { exact: true }).waitFor();
    assert.equal(await dueDay.locator('li:not([data-entry="payment"])').getByRole('button', { name: 'Open received bill', exact: true }).count(), 1);
    assert.equal(await dueDay.locator('li[data-entry="payment"]').count(), 1);
    assert.equal(await dueDay.getByRole('button', { name: 'Review arrival pattern', exact: true }).count(), 0);
    await calendar.scrollIntoViewIfNeeded(); assert.ok(await dueDay.isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow at ${width}px`);
    await page.screenshot({ path: join(output, `due-${width}.png`), fullPage: true });
    const arrivalDay = await selectCalendarDay(nextArrival);
    await arrivalDay.getByText(`Expected · ${await calendarDate(nextArrival)}`, { exact: true }).waitFor();
    await arrivalDay.getByText('Predicted from your approved arrival pattern. Not an invoice or due date.', { exact: true }).waitFor();
    assert.equal(await arrivalDay.getByRole('button', { name: 'Review arrival pattern', exact: true }).count(), 1);
    assert.equal(await arrivalDay.getByRole('button', { name: 'Open received bill', exact: true }).count(), 0);
    await calendar.scrollIntoViewIfNeeded(); assert.ok(await arrivalDay.isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow at ${width}px`);
    await page.screenshot({ path: join(output, `arrival-${width}.png`), fullPage: true });
    await arrivalDay.getByRole('button', { name: 'Close day', exact: true }).click(); await arrivalDay.waitFor({ state: 'hidden' });
    // Return to the due month for the next width.
    await selectCalendarDay(dueDate);
  }
  assert.deepEqual(errors, []);
  pass('Built UI calendar shows the reviewed due date (with payment forecast) and the predicted arrival as separate entries at 1440px and 390px, no page errors or overflow');
} catch (error) { failure = error instanceof Error ? error.stack : String(error); if (page) writeFileSync(join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'No page')); await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await page?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}); await browser?.close(); if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(4000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), wait(4000)]); } } await new Promise(r => connector.close(r)); const childExited = !child || child.exitCode !== null || child.signalCode !== null; if (childExited) rmSync(temp, { recursive: true, force: true }); else failure ??= 'Owned child did not exit; scratch preserved.';
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Actual local HTTP app + built UI; W2 accepted bill + approved pattern + calendar readback; fictional connector + deterministic invoice worker; not live Gmail/Hermes/customer/Windows proof', checks, scanCalls, attachmentCalls, errors, limits: ['Fictional connector and deterministic worker; no live Gmail, payment or calendar provider call.', 'Text-layer PDF only; no OCR or complete image-content proof.', 'Mac browser rendering; no native Windows or two-computer acceptance.'], failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks }, null, 2));
}
