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
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
import { fictionalWorkerModelKey, provisionMockWorkerGrant } from './testing/mock-worker-grant.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud bill source QA '));
const data = join(temp, 'data'), output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/w1-w3-operational-2026-10-02/bank-review'));
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
  let ready = false; for (let i = 0; i < 100; i++) { if (child.exitCode !== null) break; try { if ((await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === child.pid) { ready = true; break; } } catch {} await wait(100); } assert.ok(ready, logs);
  assert.equal((await fetch(base + '/api/bill-register')).status, 401);
  const token = (await (await fetch(base + '/api/session')).json()).token;
  const request = async (path, method = 'GET', body, expected = 200) => { const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await res.json(); assert.equal(res.status, expected, `${path}: ${JSON.stringify(value)}`); return value; };
  await completeFictionalOnboarding(request);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const screenshot = name => page.screenshot({ path: join(output, name+'.png'), fullPage: true });
  await page.goto(base+'/#/desk');
  const bankCsv = "Date,Amount,Narrative,Reference\n2026-09-10,500.00,FICTIONAL RENT,P101\n2026-09-10,500.00,FICTIONAL TRANSFER,\n";
  assert.equal((await fetch(base+"/api/bank-reference")).status, 401);
  await page.getByRole("button", { name: /^Schedule\b/ }).first().click();
  await page.getByRole("button", { name: "Open job: Bank reference review", exact: true }).click();
  await page.getByText("Prepare a new export", { exact: true }).click();
  await page.getByLabel("Bank CSV", { exact: true }).setInputFiles({ name: "fictional-bank.csv", mimeType: "text/csv", buffer: Buffer.from(bankCsv) });
  for (const [key, value] of Object.entries({ date: "Date", amount: "Amount", narrative: "Narrative", reference: "Reference" })) await page.getByLabel(`${key} column`, { exact: true }).fill(value);
  await page.getByLabel("Date format", { exact: true }).selectOption("YYYY-MM-DD");
  await page.getByLabel("Property reference directory", { exact: true }).fill("Fictional Unit 1 | 00127 | FICTIONAL RENT");
  await page.getByRole("button", { name: "Prepare review", exact: true }).click();
  const choices = page.getByLabel("Your decision", { exact: true });
  await choices.nth(0).selectOption("Fictional Unit 1");
  await choices.nth(1).selectOption("keep");
  await page.getByLabel("Review reason", { exact: true }).nth(0).fill("Fictional directory confirms property reference");
  await page.getByLabel("Review reason", { exact: true }).nth(1).fill("Unmatched transfer retained for review");
  await screenshot("06-bank-reference-review");
  await page.getByRole("button", { name: "Save reviewed copy", exact: true }).click();
  await page.getByRole("button", { name: "Download reviewed REI copy", exact: true }).waitFor();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download reviewed REI copy", exact: true }).click();
  const download = await downloadEvent;
  const preparedCsv = readFileSync(await download.path(), "utf8");
  assert.equal(preparedCsv, bankCsv.replace("FICTIONAL RENT,P101", "FICTIONAL RENT,00127"));
  await screenshot("07-bank-reviewed-copy");
  pass("Actual Schedule UI prepares, reviews and downloads a reference-only bank copy with the source preserved");
  writeFileSync(join(output, "synthetic-bank-example.csv"), bankCsv);
  const before = await request("/api/desk");
  const response = await fetch(base+"/api/desk/import/preview",{method:"POST",headers:{"content-type":"application/json","x-realbud-session":token},body:JSON.stringify({csv:bankCsv})});
  const preview={status:response.status,body:await response.json()};
  assert.ok(preview.status >= 400, "generic ledger importer must not silently accept a bank transaction format");
  const after = await request("/api/desk");
  assert.deepEqual(after.properties, before.properties);
  pass("Synthetic bank-shaped CSV is refused without changing the property book", { status: preview.status, error: preview.body.error });
  assert.deepEqual(errors, []);
} catch (error) { failure = error instanceof Error ? error.stack : String(error); if (page) writeFileSync(join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'No page')); await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await page?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}); await browser?.close(); if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(4000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), wait(4000)]); } } await new Promise(r => connector.close(r)); const childExited = !child || child.exitCode !== null || child.signalCode !== null; if (childExited) rmSync(temp, { recursive: true, force: true }); else failure ??= 'Owned child did not exit; scratch preserved.';
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Actual local HTTP app + built bank review UI; fictional CSV; no model execution or customer/Windows proof', checks, scanCalls, attachmentCalls, errors, limits: ['Fictional connector and deterministic worker; no live Gmail, payment or calendar provider call.', 'Text-layer PDF only; no OCR or complete image-content proof.', 'Mac browser rendering; no native Windows or two-computer acceptance.'], failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks }, null, 2));
}
