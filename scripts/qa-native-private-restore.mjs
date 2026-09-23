// Unmodified packaged main/preload/service/bootstrap and native UI. Only OS
// safeStorage is an in-memory AES fixture installed after adopting a prestarted service, so
// this never reads or changes the user's real keychain. No smoke-mode keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { serviceIdentity, findRunningService, SERVICE_PORTS } from '../electron/service-instance.mjs';
import { availableServicePort, readServiceHandle, requestServiceStop } from '../electron/service-lifecycle.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 1 && ['--reproduce-welcome-restore-block', '--welcome-restore'].includes(args[0]), 'Use no arguments for native restore, --welcome-restore for the visible welcome journey, or --reproduce-welcome-restore-block for expected-defect evidence only.');
const reproduceWelcomeBlock = args[0] === '--reproduce-welcome-restore-block', welcomeRestore = args[0] === '--welcome-restore';
const mode = reproduceWelcomeBlock ? 'expected-welcome-restore-block' : welcomeRestore ? 'welcome-private-restore' : 'native-private-restore';
const welcomeSourceContact = 'Fictional Imported Office Contact';
assert.ok(process.env.REALBUD_QA_RESOURCES && process.env.REALBUD_QA_EXECUTABLE && process.env.REALBUD_QA_PACKAGE_RECEIPT && process.env.PLAYWRIGHT_MODULE && process.env.QA_OUTPUT, 'Set REALBUD_QA_RESOURCES, REALBUD_QA_EXECUTABLE, REALBUD_QA_PACKAGE_RECEIPT, PLAYWRIGHT_MODULE and a new QA_OUTPUT.');
const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
const output = resolve(process.env.QA_OUTPUT);
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
mkdirSync(output, { mode: 0o700 }); // Refuse existing evidence before creating any fixture or process.
const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const resources = realpathSync(resolve(process.env.REALBUD_QA_RESOURCES)), executable = realpathSync(resolve(process.env.REALBUD_QA_EXECUTABLE));
for (const file of [executable, join(resources, 'app.asar'), join(resources, 'server/bootstrap.js'), join(resources, 'ui/index.html')]) assert.ok(statSync(file).isFile(), `Missing packaged file: ${file}`);
assert.equal(executable, realpathSync(join(resources, '..', 'MacOS', 'RealBud')), 'Use the executable belonging to these packaged resources.');
const artifact = Object.fromEntries(['app.asar', 'server/bootstrap.js', 'ui/index.html'].map(file => [file, hashFile(join(resources, file))]));
const packageReceiptPath = realpathSync(resolve(process.env.REALBUD_QA_PACKAGE_RECEIPT));
const packageDirectory = dirname(packageReceiptPath), packageManifestPath = join(packageDirectory, 'manifest.json'), appManifestPath = join(packageDirectory, 'app-manifest.json');
const packageReceipt = JSON.parse(readFileSync(packageReceiptPath, 'utf8')), packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8')), appManifest = JSON.parse(readFileSync(appManifestPath, 'utf8'));
assert.ok(packageReceipt.passed === true && packageReceipt.sourceUnchanged === true && /^[a-f0-9]{40}$/.test(packageReceipt.sourceRevision), 'A successful source-bound package receipt is required.');
assert.equal(packageManifest.sourceRevision, packageReceipt.sourceRevision); assert.equal(appManifest.sourceRevision, packageReceipt.sourceRevision);
assert.equal(realpathSync(appManifest.app), realpathSync(join(resources, '..', '..')));
for (const [name, file] of [['package-receipt.json', packageReceiptPath], ['app-manifest.json', appManifestPath]]) {
  const entries = packageManifest.files.filter(item => item.path === name);
  assert.equal(entries.length, 1); assert.equal(entries[0].kind, 'file');
  assert.equal(entries[0].bytes, statSync(file).size); assert.equal(entries[0].sha256, hashFile(file));
}
for (const [name, file] of [['Contents/MacOS/RealBud', executable], ...Object.keys(artifact).map(name => [`Contents/Resources/${name}`, join(resources, name)])]) {
  const entries = appManifest.files.filter(item => item.path === name);
  assert.equal(entries.length, 1); assert.equal(entries[0].kind, 'file');
  assert.equal(entries[0].bytes, statSync(file).size); assert.equal(entries[0].sha256, hashFile(file));
}
const provenance = { sourceRevision: packageReceipt.sourceRevision, packageReceipt: { path: packageReceiptPath, sha256: hashFile(packageReceiptPath) },
  packageManifestSha256: hashFile(packageManifestPath), appManifestSha256: hashFile(appManifestPath), executableSha256: hashFile(executable),
  harnessSha256: hashFile(script), sourceHelpers: Object.fromEntries(['scripts/service-smoke-env.mjs', 'electron/service-instance.mjs', 'electron/service-lifecycle.mjs', 'shared/service-identity.mjs'].map(file => [file, hashFile(join(root, file))])) };
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud native restore '));
const source = join(scratch, 'source'), data = join(scratch, 'target'), userData = join(scratch, 'electron');
for (const dir of [source, data, userData]) mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const dir of [source, data]) writeFileSync(join(dir, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
writeFileSync(join(userData, 'cua-human-pause.json'), JSON.stringify({ version: 1, paused: true }), { mode: 0o600 });
const delay = ms => new Promise(r => setTimeout(r, ms)), checks = [], errors = [], onboardingFixture = [], identity = serviceIdentity(data);
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const servicePids = new Set();
const exited = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
let sourceChild, targetChild, nativeChild, seedChild, inspector, browser, page, failure, sourceLog = '', nativeLog = '', origin, token, sourceToken, sourceOrigin, runtime, keyProof, reproduction, welcomeJourney;
let welcomeAgencyWrites = 0;
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]);
  if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await once(child, 'exit'); }
}
async function protocol(url) {
  const socket = new WebSocket(url), pending = new Map(), events = new Map(); let id = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const p = pending.get(message.id); if (p) { pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); } }
    else if (message.method) { for (const resolve of events.get(message.method) ?? []) resolve(message.params); events.delete(message.method); }
  });
  return {
    send(method, params = {}) { return new Promise((resolve, reject) => { const number = ++id; const timer = setTimeout(() => { pending.delete(number); reject(new Error(`Inspector timed out: ${method}`)); }, 15000); pending.set(number, { resolve, reject, timer }); socket.send(JSON.stringify({ id: number, method, params })); }); },
    event(method) { return new Promise(resolve => events.set(method, [...(events.get(method) ?? []), resolve])); },
    async evaluate(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Native fixture setup failed'); return result.result?.value; },
    close() { socket.close(); for (const p of pending.values()) clearTimeout(p.timer); },
  };
}
async function api(path, method = 'GET', body, status = 200, sourceRequest = false) {
  if (welcomeRestore && !sourceRequest && ['/api/onboarding', '/api/desk/agency'].includes(path)) assert.equal(method, 'GET', 'The visible welcome journey cannot use a target onboarding or agency API fixture.');
  const response = await fetch((sourceRequest ? sourceOrigin : origin) + path, { method, signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', 'x-realbud-session': sourceRequest ? sourceToken : token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`); return value;
}
async function sessionToken() {
  token = (await (await fetch(origin + '/api/session')).json()).token;
  const handle = readServiceHandle(data, identity.instanceId);
  if (handle) servicePids.add(handle.pid);
}
async function prepareBackupOnboarding(label) {
  // The visible welcome writes the office contact and makes the sample book
  // nonfresh. Reuse the scoped backup-QA setup API without changing that book;
  // this prepares the fixture and does not claim visible onboarding acceptance.
  let setup = await api('/api/onboarding');
  const initialStage = setup.stage;
  assert.ok(['profile', 'office-rules', 'complete'].includes(initialStage));
  for (const stage of ['office-rules', 'complete']) {
    if (setup.stage === 'complete') break;
    setup = await api('/api/onboarding', 'PUT', { expectedScope: setup.scope, expectedRevision: setup.revision, stage });
    assert.equal(setup.stage, stage);
  }
  assert.equal((await api('/api/onboarding')).stage, 'complete');
  onboardingFixture.push({ label, method: 'authoritative-scoped-api-fixture', initialStage, finalStage: 'complete', visibleWelcomeTested: false });
}
async function protectedDigest() {
  return inspector.evaluate(`(() => { const fs = process.getBuiltinModule('node:fs'), crypto = process.getBuiltinModule('node:crypto'); const key = require('electron').safeStorage.decryptString(fs.readFileSync(${JSON.stringify(join(data, 'desk.key.wrap'))})); return crypto.createHash('sha256').update(key).digest('hex'); })()`);
}
async function ipc(method) { return page.evaluate(method => window.ogb[method](), method); }
async function captureBackupContext(panel, name) {
  // You owns an internal scroller and sticky section navigation. Keep the
  // actual panel heading below that navigation instead of clipping it with a
  // locator screenshot of a panel taller than the native window.
  await panel.evaluate(element => {
    const scroller = element.closest('[data-you-scroll]');
    if (!scroller) throw new Error('Missing native settings scroller');
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 110;
  });
  await page.screenshot({ path: join(output, name) });
}
async function prepareSourceBackup() {
  // Prepare a source backup with a distinct key using the same compiled app.
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const sourcePort = server.address().port; await new Promise(r => server.close(r));
  sourceOrigin = `http://127.0.0.1:${sourcePort}`;
  const sourceKey = randomBytes(32);
  sourceChild = spawn(executable, [join(resources, 'server/bootstrap.js')], { cwd: resources, env: { ...serviceSmokeEnv({ executable, home: source, data: source, scratch, port: sourcePort }), REALBUD_DESK_KEY: sourceKey.toString('hex'), OMB_STATIC_DIR: join(resources, 'ui') }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [sourceChild.stdout, sourceChild.stderr]) stream.on('data', b => sourceLog = (sourceLog + b).slice(-15000));
  await until(async () => { if (sourceChild.exitCode !== null) throw new Error(sourceLog); try { return (await (await fetch(sourceOrigin + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === sourceChild.pid; } catch { return false; } }, 'source compiled service');
  sourceToken = (await (await fetch(sourceOrigin + '/api/session')).json()).token;
  const sourceBook = await api('/api/desk/properties', 'POST', { address: 'Fictional Native Restore Oak Street', tenantName: 'Fictional Tenant', tenantPhone: '0400 000 000', weeklyRentCents: 50000 }, 201, true);
  const propertyId = sourceBook.properties.find(property => property.address === 'Fictional Native Restore Oak Street')?.id;
  assert.ok(propertyId);
  // Seed fictional normalized records through the actual compiled domain. This
  // is explicit fixture setup, not evidence of a Gmail acquisition. The key is
  // supplied through the isolated process environment, never script text/args.
  const seedPath = join(scratch, 'seed-normalized-bills.mjs');
  writeFileSync(seedPath, `import { WorkflowDatabase } from ${JSON.stringify(pathToFileURL(join(resources, 'server/workflow-database.js')).href)};
import { SourceBillRegister, previewBillSource } from ${JSON.stringify(pathToFileURL(join(resources, 'server/source-bills.js')).href)};
import { createBillProposals } from ${JSON.stringify(pathToFileURL(join(resources, 'server/bill-proposals.js')).href)};
import { defaultAgencySettings } from ${JSON.stringify(pathToFileURL(join(resources, 'server/agency-setup.js')).href)};
import { createMailIngestionService } from ${JSON.stringify(pathToFileURL(join(resources, 'server/mail-ingestion.js')).href)};
import { loadWorkspaceIdentity } from ${JSON.stringify(pathToFileURL(join(resources, 'server/workspace-identity.js')).href)};
import assert from 'node:assert/strict';
import { join } from 'node:path';
const database = new WorkflowDatabase({dir:process.env.REALBUD_DATA_DIR,key:Buffer.from(process.env.REALBUD_DESK_KEY,'hex')});
try {
  const register = new SourceBillRegister(database,{dataDir:process.env.REALBUD_DATA_DIR});
  const mail = {accountId:'fictional-native-account',receiptId:'fictional-native-receipt',threadId:'fictional-thread',message:{id:'fictional-message',at:Date.parse('2026-09-01T08:00:00Z'),from:'fictional@example.invalid',subject:'Fictional native water bill',body:'Fictional retained bill source',attachments:[]}};
  const facts = {propertyId:${JSON.stringify(propertyId)},kind:'Water',vendor:'Fictional Water',amountCents:12345,currency:'AUD',invoiceDate:'2026-09-01',dueDate:'2026-09-21',note:'Fictional retained facts'};
  const review = {expectedSourceDigest:previewBillSource(mail).digest,sourceReviewed:true,facts,reviewReason:'Fictional staff source review'};
  const accepted = register.accept(review,mail,'fictional-native-reviewer');
  const settings = {intervalMonths:1,anchorDate:'2026-09-01',windowBeforeDays:0,windowAfterDays:0,timeZone:'UTC',reviewReason:'Fictional pattern reviewed'};
  const pattern = register.approveSeries({...settings,occurrenceId:accepted.id,expectedOccurrenceRevision:accepted.revision},'fictional-native-reviewer');
  const paused = register.reviseSeries(pattern.id,{...settings,expectedRevision:pattern.revision,active:false,reviewReason:'Paused for fictional source correction'},'fictional-native-reviewer');
  const changedMail = {...mail,message:{...mail.message,id:'fictional-corrected-message',body:'Fictional corrected bill source'}};
  const corrected = register.correct(accepted.id,{...review,expectedSourceDigest:previewBillSource(changedMail).digest,expectedRevision:accepted.revision,state:'hold',reviewReason:'Fictional correction retains both source identities'},changedMail,'fictional-native-reviewer');
  const proposalSource = {...mail,threadId:'abc123',message:{...mail.message,id:'ab12'}};
  const proposalAuthority = {settings:{...defaultAgencySettings(),agencyName:'Fictional native agency',gmailAccountId:proposalSource.accountId,timeZone:'UTC',workflowPackId:'office-core'},evidenceDigest:'b'.repeat(64),packBinding:'c'.repeat(64),recipe:{id:'wf-office-core-invoice-review',revision:2,approvedRevision:2,planApprovedAt:1,status:'active'}};
  const request = {requestId:'00000000-0000-0000-0000-000000000001',itemId:'a'.repeat(64),messageId:proposalSource.message.id,expectedSourceDigest:previewBillSource(proposalSource).digest};
  await assert.rejects(createBillProposals({database:()=>database,workroom:join(process.env.REALBUD_DATA_DIR,'vault'),epoch:()=> 'fixture',authorize:async()=>proposalAuthority,source:async()=>proposalSource,runs:()=>[],execute:async()=>{throw new Error('Fictional stop before worker admission');}})(request),/Fictional stop before worker admission/);
  const proposal = {request,source:proposalSource,authority:proposalAuthority,record:database.get('bill-proposal','bill-proposal:'+request.requestId)};
  assert.ok(proposal.record);
  const identity = await loadWorkspaceIdentity(join(process.env.REALBUD_DATA_DIR,'company-installation'));
  const mailSettings = {...defaultAgencySettings(),agencyName:'Fictional native agency',gmailAccountId:'fictional-native-mail',workflowPackId:'office-core',timeZone:'UTC'};
  let scanNumber = 0;
  const retainedMail = createMailIngestionService({directory:process.env.REALBUD_DATA_DIR,database,workspaceId:identity.id,key:Buffer.from(process.env.REALBUD_DESK_KEY,'hex'),workroomDirectory:join(process.env.REALBUD_DATA_DIR,'vault'),
    authorize:async()=>({accountId:mailSettings.gmailAccountId,bindingRevision:'b'.repeat(64),settingsRevision:1,settings:mailSettings}),
    scan:async(_authority,request)=>{const id=(++scanNumber).toString(16);return {accountId:mailSettings.gmailAccountId,windowStartAt:request.windowStartAt,windowEndAt:request.windowEndAt,pages:1,paginationComplete:true,gaps:[],threads:[{id,historyComplete:true,messages:[{id:'a'+id,threadId:id,at:request.windowEndAt-1000,direction:'incoming',from:'fictional@example.invalid',to:'office@example.invalid',subject:'Retained native conversation '+id,body:'Fictional retained native message '+id,bodyTruncated:false,attachments:[]}]}]};}});
  let mailFixture;
  try {
    await retainedMail.collect();
    const first=(await retainedMail.page({group:'all'})).items[0];
    await retainedMail.update(first.id,{expectedRevision:first.revision,status:'done',priority:'low',note:'Native restore preserves this completed staff decision'});
    await retainedMail.collect(); await retainedMail.prepareInput();
    mailFixture={item:await retainedMail.getItem(first.id),source:await retainedMail.source(first.id),metadata:await retainedMail.get(),prepared:database.get('mail-prepared','mail-prepared:workspace')};
    assert.ok(mailFixture.prepared);
  } finally {await retainedMail.close();}
  console.log(JSON.stringify({occurrence:corrected,series:paused,oldIdentity:previewBillSource(mail).identity,proposal,mail:mailFixture}));
} finally {database.close();}
`, { mode: 0o600 });
  let seedLog = '', seedError = '';
  seedChild = spawn(executable, [seedPath], { cwd: resources, env: { ...serviceSmokeEnv({ executable, home: source, data: source, scratch, port: sourcePort }), REALBUD_DESK_KEY: sourceKey.toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] });
  seedChild.stdout.on('data', bytes => { seedLog = (seedLog + bytes).slice(-30000); });
  seedChild.stderr.on('data', bytes => { seedError = (seedError + bytes).slice(-10000); });
  await until(() => seedChild.exitCode !== null || seedChild.signalCode, 'compiled source-bill fixture');
  assert.equal(seedChild.exitCode, 0, seedError);
  const billFixture = JSON.parse(seedLog);
  const draftWorkspace = (await api('/api/bill-review-drafts', 'GET', undefined, 200, true)).workspaceId;
  const draftRequest = billFixture.proposal.request;
  const retainedDraft = (await api('/api/bill-review-drafts', 'POST', {
    id: '00000000-0000-0000-0000-000000000002', expectedRevision: null,
    value: { workspaceId: draftWorkspace, state: 'saved', billId: null, billRevision: null,
      itemId: draftRequest.itemId, messageId: draftRequest.messageId, sourceDigest: draftRequest.expectedSourceDigest,
      fields: { propertyId, kind: 'Water', vendor: 'Fictional unfinished review', amount: '12.', invoiceDate: '', dueDate: '', note: 'Native restore keeps unfinished 私人 staff notes.' },
      billState: 'received', reason: 'Original document still needs review', seriesId: '', arrivalDate: '', proposalRequest: draftRequest },
  }, 200, true)).draft;
  const original = Buffer.from('\uFEFFDate,Amount,Narrative,Reference\r\n2026-09-21,45.67,"Native café 🏡","KEEP"\r\n');
  const batch = await api('/api/bank-reference', 'POST', { source: { filename: 'fictional-native.csv', bytesBase64: original.toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Narrative', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules: [] }, 200, true);
  if (welcomeRestore) assert.equal((await api('/api/desk/agency', 'PATCH', { office: { pmUser: welcomeSourceContact } }, 200, true)).book.office.pmUser, welcomeSourceContact);
  const passphrase = 'Fictional native restore phrase 2026';
  const exported = await api('/api/private-backup/export', 'POST', { passphrase }, 200, true);
  await stopChild(sourceChild);
  return { sourceKey, propertyId, billFixture, draftRequest, retainedDraft, original, batch, passphrase, exported };
}
async function reproduceWelcomeRestoreBlock() {
  let backupMutations = 0;
  const countBackupMutation = request => { if (new URL(request.url()).pathname.startsWith('/api/private-backup') && request.method() !== 'GET') backupMutations++; };
  page.on('request', countBackupMutation);
  await page.goto(origin + '/#/you');
  await page.getByRole('heading', { name: 'Make the desk yours', exact: true }).waitFor();
  const before = await api('/api/private-backup'), beforeBook = await api('/api/desk');
  assert.equal((await api('/api/onboarding')).stage, 'profile');
  assert.equal(before.canRestore, true); assert.equal(beforeBook.mode, 'demo'); assert.equal(beforeBook.revision, 1);
  assert.equal(await page.getByRole('region', { name: 'Private workspace backup', exact: true }).count(), 0, 'Fresh welcome blocks the direct backup route.');
  assert.equal(await page.getByRole('button', { name: /restore.*backup|backup.*restore/i }).count(), 0, 'This selected package has no welcome restore entry.');
  await page.screenshot({ path: join(output, 'welcome-before-completion.png') });
  await page.getByRole('button', { name: 'Explore the sample desk', exact: true }).click();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor();
  assert.equal((await api('/api/private-backup')).canRestore, true, 'Saving the sample profile alone must not be mistaken for the book mutation.');
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'You', exact: true }).waitFor();
  assert.equal((await api('/api/onboarding')).stage, 'complete');
  const after = await api('/api/private-backup'), afterBook = await api('/api/desk');
  const refusal = 'Restore requires a fresh workspace with only its untouched sample book. Existing private work is kept.';
  assert.equal(after.canRestore, false); assert.equal(after.reason, refusal);
  assert.ok(afterBook.revision > beforeBook.revision); assert.equal(afterBook.book.office.pmUser, 'Sample PM');
  await page.goto(origin + '/#/you');
  await page.locator('details#you-advanced > summary').click();
  const panel = page.getByRole('region', { name: 'Private workspace backup', exact: true }); await panel.waitFor();
  await panel.getByText(refusal, { exact: true }).waitFor();
  await captureBackupContext(panel, 'welcome-after-completion-restore-blocked.png');
  assert.equal(backupMutations, 0); assert.deepEqual(onboardingFixture, []); assert.deepEqual(errors, []);
  page.off('request', countBackupMutation);
  reproduction = { expectedDefect: true, productAcceptance: false, before: { canRestore: before.canRestore, bookRevision: beforeBook.revision, welcomeVisible: true, backupRouteHidden: true },
    after: { canRestore: after.canRestore, bookRevision: afterBook.revision, onboardingStage: 'complete', reason: after.reason, refusalVisible: true },
    visibleActions: ['Explore the sample desk', 'Open the sample desk first'], restoreInvoked: false, backupMutationRequests: backupMutations, apiOnboardingFixtureUsed: false };
  console.log('OBSERVED expected welcome-to-restore blockage; this is defect reproduction, not product acceptance.');
}
async function welcomeFreshness(label, firstDigest, wrappedDigest) {
  const status = await api('/api/private-backup'), snapshot = await api('/api/desk');
  assert.equal(snapshot.mode, 'demo', label); assert.equal(snapshot.revision, 1, label);
  assert.equal(status.canRestore, true, label); assert.equal(status.staged, false, label);
  assert.equal(await protectedDigest(), firstDigest, label); assert.equal(hashFile(join(data, 'desk.key.wrap')), wrappedDigest, label);
  assert.equal(existsSync(join(data, 'desk.key')), false, label); assert.equal(welcomeAgencyWrites, 0, label);
  assert.deepEqual(onboardingFixture, [], label);
  welcomeJourney.freshness.push({ label, mode: snapshot.mode, revision: snapshot.revision, canRestore: status.canRestore, staged: status.staged, keyPreserved: true, agencyWrites: 0 });
}
async function captureWelcomeEntry(width, height, name) {
  await page.setViewportSize({ width, height });
  const entry = page.getByRole('button', { name: 'Restore a private backup', exact: true });
  await entry.scrollIntoViewIfNeeded(); assert.equal(await entry.isEnabled(), true);
  const bounds = await entry.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Welcome has no horizontal overflow.');
  await page.screenshot({ path: join(output, name) });
  welcomeJourney.viewports.push({ width, height, entryVisible: true, horizontalOverflow: false });
}
async function prepareWelcomeRestore(exported, firstDigest) {
  const wrappedDigest = hashFile(join(data, 'desk.key.wrap'));
  welcomeJourney = { method: 'visible-welcome-and-backup-ui', targetOnboardingApiFixtureUsed: false, freshness: [], viewports: [] };
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/desk/agency' && request.method() !== 'GET') welcomeAgencyWrites++; });
  await page.goto(origin + '/');
  await page.getByRole('heading', { name: 'Make the desk yours', exact: true }).waitFor();
  assert.equal((await api('/api/onboarding')).stage, 'profile');
  await welcomeFreshness('before-welcome-entry', firstDigest, wrappedDigest);
  await captureWelcomeEntry(1440, 1050, 'welcome-restore-entry-desktop.png');
  await captureWelcomeEntry(390, 844, 'welcome-restore-entry-390.png');
  await page.getByRole('button', { name: 'Restore a private backup', exact: true }).click();
  await page.waitForURL(url => url.hash === '#you-private-backup');
  const panel = page.getByRole('region', { name: 'Private workspace backup', exact: true }); await panel.waitFor();
  assert.equal((await api('/api/onboarding')).stage, 'recovery');
  await welcomeFreshness('after-visible-entry', firstDigest, wrappedDigest);
  await page.reload(); await panel.waitFor();
  assert.equal(new URL(page.url()).hash, '#you-private-backup'); assert.equal(await page.locator('details#you-advanced').evaluate(element => element.open), true);
  assert.equal((await api('/api/onboarding')).stage, 'recovery');
  await welcomeFreshness('after-backup-route-reload', firstDigest, wrappedDigest);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Backup entry has no 390px horizontal overflow.');
  await captureBackupContext(panel, 'welcome-restore-reloaded-390.png');
  await page.setViewportSize({ width: 1440, height: 1050 });
  pass('Visible welcome restore entry is reachable at desktop and 390px; recovery and the backup deep link survive reload without changing fresh book or key custody');
  await panel.getByLabel('Encrypted private backup file', { exact: true }).setInputFiles({ name: exported.filename, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported.backup)) });
  await panel.getByLabel('Restore private backup passphrase', { exact: true }).fill('Incorrect fictional restore passphrase');
  await panel.getByRole('button', { name: 'Preview private backup contents', exact: true }).click();
  const progress = panel.getByRole('region', { name: 'Selected backup progress', exact: true });
  await progress.getByText('The backup could not be opened with that passphrase. Check it and try again.', { exact: true }).waitFor();
  const failedUploads = (await api('/api/private-backup/v2/operations?limit=20')).items.filter(item => item.kind === 'upload');
  assert.equal(failedUploads.length, 1); assert.equal(failedUploads[0].phase, 'failed'); assert.equal(failedUploads[0].error?.code, 'incorrect-passphrase');
  assert.equal(failedUploads[0].canCancel, true);
  await welcomeFreshness('after-wrong-passphrase', firstDigest, wrappedDigest);
  await progress.screenshot({ path: join(output, 'welcome-restore-wrong-passphrase.png') });
  pass('A wrong backup passphrase produces the visible refusal and preserves revision 1, restore availability and the same protected target key');
  await progress.getByRole('button', { name: 'Remove temporary copy', exact: true }).click();
  await progress.getByRole('heading', { name: 'Removed', exact: true }).waitFor();
  await panel.getByText('Temporary backup files removed. Your workspace records and original file are unchanged.', { exact: true }).waitFor();
  const cancelled = (await api('/api/private-backup/v2/operations?limit=20')).items.find(item => item.id === failedUploads[0].id);
  assert.equal(cancelled?.phase, 'cancelled'); assert.equal(cancelled.canCancel, false);
  await welcomeFreshness('after-remove-temporary-copy', firstDigest, wrappedDigest);
  await progress.screenshot({ path: join(output, 'welcome-restore-cancelled.png') });
  welcomeJourney.cancelledUploadId = cancelled.id;
  pass('Remove temporary copy cancels the failed upload through the real UI while the original fresh workspace remains restorable');
  return { panel, wrappedDigest };
}
async function finishRestoredWelcome() {
  const before = await api('/api/desk'); assert.equal(before.book.office.pmUser, welcomeSourceContact);
  assert.equal((await api('/api/onboarding')).stage, 'profile', 'Restored workspace identity requires its own visible welcome.');
  await page.getByRole('heading', { name: 'Make the desk yours', exact: true }).waitFor();
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Restore Operator');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'You', exact: true }).waitFor();
  assert.equal((await api('/api/onboarding')).stage, 'complete');
  const after = await api('/api/desk'); assert.equal(after.book.office.pmUser, welcomeSourceContact); assert.equal(after.revision, before.revision);
  assert.equal(welcomeAgencyWrites, 0); assert.deepEqual(onboardingFixture, []);
  const status = await api('/api/private-backup'); assert.equal(status.canRestore, false); assert.equal(status.staged, false);
  welcomeJourney.postRestore = { visibleWelcomeCompleted: true, restoredOfficeContactPreserved: true, bookRevisionPreserved: true, agencyWrites: 0, canRestore: status.canRestore, staged: status.staged };
  pass('After native restore, the actual visible welcome completes for the imported workspace without overwriting its named office contact or changing its book revision');
}
async function runScenario() {
  const nativePort = await availableServicePort(SERVICE_PORTS);
  assert.notEqual(nativePort, null, 'Native service needs one unused supported port; never stop another workspace.');
  const { sourceKey, propertyId, billFixture, draftRequest, retainedDraft, original, batch, passphrase, exported } = reproduceWelcomeBlock ? {} : await prepareSourceBackup();
  // Adopt a deliberately prestarted child first. Native startup therefore does
  // not touch safeStorage before the inspector installs its test boundary.
  const targetKey = randomBytes(32), controlToken = randomBytes(32).toString('hex');
  writeFileSync(join(data, 'desk.key'), targetKey, { mode: 0o600 });
  origin = `http://127.0.0.1:${nativePort}`;
  targetChild = spawn(executable, [join(resources, 'server/bootstrap.js')], { cwd: resources, env: { ...serviceSmokeEnv({ executable, home: scratch, data, scratch, port: nativePort }), REALBUD_DESK_KEY: targetKey.toString('hex'), REALBUD_PRODUCTION: '1', REALBUD_SERVICE_CONTROL_TOKEN: controlToken, OMB_STATIC_DIR: join(resources, 'ui') }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [targetChild.stdout, targetChild.stderr]) stream.on('data', b => sourceLog = (sourceLog + b).slice(-15000));
  writeFileSync(join(data, 'service.json'), JSON.stringify({ version: 1, pid: targetChild.pid, port: nativePort, instanceId: identity.instanceId, startedAt: Date.now(), controlToken }), { mode: 0o600 });
  await until(async () => { if (targetChild.exitCode !== null) throw new Error(sourceLog); return Boolean(await findRunningService(identity)); }, 'prestarted target service');
  const env = { ...serviceSmokeEnv({ executable, home: scratch, data, scratch, port: nativePort }), REALBUD_LOG_DIR: join(userData, 'logs') }; delete env.ELECTRON_RUN_AS_NODE;
  nativeChild = spawn(executable, ['--inspect=0', '--remote-debugging-port=0', `--user-data-dir=${userData}`, '--disable-background-networking', '--disable-component-update', '--no-first-run', '--use-mock-keychain'], { cwd: resources, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [nativeChild.stdout, nativeChild.stderr]) stream.on('data', b => nativeLog = (nativeLog + b).slice(-15000));
  const inspectorUrl = await until(() => { if (nativeChild.exitCode !== null) throw new Error(nativeLog); return nativeLog.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]; }, 'native main inspector');
  // The inspector is advertised before ESM/bootstrap initialization completes.
  // Requiring Electron in that transitional context can collect its promise.
  // A renderer endpoint proves the real main has reached native window startup.
  const chromeUrl = await until(() => { if (nativeChild.exitCode !== null) throw new Error(nativeLog); return nativeLog.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]; }, 'native renderer debugger');
  inspector = await protocol(inspectorUrl); await inspector.send('Runtime.enable');
  // Native startup adopts the already-live target, so it never reaches key
  // unwrapping before this fixture is installed. All later restarts are real.
  runtime = await inspector.evaluate(`(() => {
    const electron = require('electron'), crypto = process.getBuiltinModule('node:crypto');
    const wrappingKey = crypto.randomBytes(32), initialLogs = electron.app.getPath('logs'); let encrypted = 0, decrypted = 0;
    electron.app.setPath('userData', ${JSON.stringify(userData)});
    electron.safeStorage.isEncryptionAvailable = () => true;
    electron.safeStorage.encryptString = text => { encrypted++; const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv); return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]); };
    electron.safeStorage.decryptString = bytes => { decrypted++; const d = crypto.createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(0, 12)); d.setAuthTag(bytes.subarray(-16)); return Buffer.concat([d.update(bytes.subarray(12, -16)), d.final()]).toString('utf8'); };
    globalThis.__realbudCustodyFixture = () => ({ encrypted, decrypted });
    const originalRequest = electron.net.request.bind(electron.net);
    electron.net.request = (...args) => { const value = typeof args[0] === 'string' ? args[0] : args[0]?.url; const url = value ? new URL(value) : null; if (!url || !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('External network disabled for native backup QA'); return originalRequest(...args); };
    return { node: process.versions.node, electron: process.versions.electron, packaged: electron.app.isPackaged, resources: process.resourcesPath, initialLogs, logs: electron.app.getPath('logs') };
  })()`);
  assert.equal(runtime.packaged, true); assert.equal(realpathSync(runtime.resources), resources);
  assert.ok(runtime.initialLogs.startsWith(scratch + '/'), 'Native startup logs must belong to the isolated home.');
  assert.equal(runtime.initialLogs, join(userData, 'logs')); assert.equal(runtime.logs, runtime.initialLogs);
  await until(() => { const file = join(runtime.initialLogs, 'server.log'); return existsSync(file) && readFileSync(file, 'utf8').includes(`adopted the running office service on port ${nativePort}`); }, 'startup service-adoption log in isolated directory');
  browser = await chromium.connectOverCDP(chromeUrl); const context = browser.contexts()[0];
  await context.route('**/*', route => { const url = new URL(route.request().url()); return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort(); });
  page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 30000 }); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  const running = await until(() => findRunningService(identity), 'native-owned service'); origin = `http://127.0.0.1:${running.port}`;
  await page.waitForURL(origin + '/**'); await sessionToken();
  assert.ok((await ipc('serviceStatus')).manageable); assert.equal((await api('/api/private-backup')).canRestore, true);
  assert.equal(existsSync(join(data, 'desk.key.wrap')), false, 'Adoption must avoid calling the real OS keychain before the fixture is installed');
  assert.equal((await ipc('serviceStatus')).adopted, true);
  pass('Actual packaged app and preload adopt the isolated target service before the safeStorage fixture is installed');
  if (reproduceWelcomeBlock) { await reproduceWelcomeRestoreBlock(); return; }
  const firstDigest = createHash('sha256').update(targetKey.toString('hex')).digest('hex'); assert.notEqual(firstDigest, createHash('sha256').update(sourceKey.toString('hex')).digest('hex'));
  const firstPid = (await api('/api/health')).pid;
  const stopped = await ipc('serviceStop'); assert.equal(stopped.ok, true); assert.equal(stopped.status.running, false);
  const started = await ipc('serviceStart'); assert.equal(started.ok, true); assert.equal(started.status.running, true); await sessionToken();
  assert.notEqual((await api('/api/health')).pid, firstPid); assert.equal(await protectedDigest(), firstDigest); assert.equal(existsSync(join(data, 'desk.key')), false);
  pass('Real preload stop/start migrates existing custody to the mocked protected store and preserves the same key without a plaintext key file');
  let panel, welcomeWrappedDigest;
  if (welcomeRestore) ({ panel, wrappedDigest: welcomeWrappedDigest } = await prepareWelcomeRestore(exported, firstDigest));
  else {
    await prepareBackupOnboarding('fresh-restore-target');
    assert.equal((await api('/api/private-backup')).canRestore, true, 'Onboarding fixture setup must preserve the fresh restore target.');
    await page.goto(origin + '/#/you'); await page.reload(); await page.locator('details#you-advanced > summary').click();
    panel = page.getByRole('region', { name: 'Private workspace backup', exact: true }); await panel.waitFor();
  }
  await panel.getByLabel('Encrypted private backup file', { exact: true }).setInputFiles({ name: exported.filename, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported.backup)) });
  await panel.getByLabel('Restore private backup passphrase', { exact: true }).fill(passphrase); await panel.getByRole('button', { name: 'Preview private backup contents', exact: true }).click();
  const preview = panel.getByRole('region', { name: 'Private backup preview', exact: true }); await preview.waitFor();
  if (welcomeRestore) {
    const reviewed = (await api('/api/private-backup/v2/operations?limit=20')).items.filter(item => item.kind === 'upload' && item.phase === 'reviewed');
    assert.equal(reviewed.length, 1); assert.notEqual(reviewed[0].id, welcomeJourney.cancelledUploadId); welcomeJourney.reviewedUploadId = reviewed[0].id;
    assert.equal(await preview.getByRole('button', { name: 'Stage reviewed restore', exact: true }).isDisabled(), true);
    await welcomeFreshness('after-correct-reupload-preview', firstDigest, welcomeWrappedDigest);
  }
  await preview.getByLabel('I checked this backup', { exact: false }).check(); await preview.getByRole('button', { name: 'Stage reviewed restore', exact: true }).click();
  await panel.getByText('Restore staged — restart required', { exact: true }).waitFor(); const staged = await api('/api/private-backup');
  await panel.screenshot({ path: join(output, 'native-restore-staged.png') });
  await captureBackupContext(panel, 'native-restore-staged-context.png');
  const beforeRestore = (await api('/api/health')).pid;
  // The button reloads the renderer after its restart IPC resolves. A healthy
  // HTTP service alone does not mean that delayed navigation has finished;
  // wait for the actual reload before attempting any later route change.
  await Promise.all([
    page.waitForEvent('load', { timeout: 30000 }),
    panel.getByRole('button', { name: 'Restart service to finish restore', exact: true }).click(),
  ]);
  await until(async () => { try { const h = await (await fetch(origin + '/api/health')).json(); return h.pid !== beforeRestore; } catch { return false; } }, 'native backup restart');
  await sessionToken(); const completedStatus = await until(async () => { const status = await api('/api/private-backup'); return status.staged ? false : status; }, 'applied restore');
  assert.equal(await protectedDigest(), firstDigest); assert.equal(existsSync(join(data, 'desk.key')), false);
  assert.ok((await api('/api/desk')).properties.some(p => p.address === 'Fictional Native Restore Oak Street'));
  const restoredOriginal = await api(`/api/bank-reference/${batch.id}/original`, 'POST', {}); assert.deepEqual(Buffer.from(restoredOriginal.bytesBase64, 'base64'), original);
  const receipt = JSON.parse(readFileSync(join(data, 'private-workspace-restore-receipt.json'), 'utf8')); assert.equal(receipt.receipt.digest, staged.receipt.digest); assert.equal(receipt.rekeyed, true); assert.equal(receipt.reviewRequired, true);
  assert.deepEqual(completedStatus.completed, receipt, 'Completed API status must match the durable restore receipt');
  assert.equal((await api('/api/loops')).loops.some(loop => loop.enabled), false);
  pass('Native Restore restart button performs real preload/main IPC and cold bootstrap, preserving target custody and exact restored bank bytes');
  if (welcomeRestore) await finishRestoredWelcome();
  else { await prepareBackupOnboarding('restored-workspace'); await page.reload(); }
  const restoredBill = await api(`/api/bill-occurrences/${billFixture.occurrence.id}`);
  assert.deepEqual(restoredBill.occurrence, billFixture.occurrence); assert.deepEqual(restoredBill.originSeries, billFixture.series);
  assert.deepEqual((await api(`/api/bill-occurrences/by-source/${billFixture.oldIdentity}`)).occurrence, billFixture.occurrence);
  assert.deepEqual((await api(`/api/bill-series/${billFixture.series.id}`)).series, billFixture.series);
  assert.deepEqual((await api('/api/bill-register')).counts, { occurrences: 1, series: 1, activeSeries: 0 });
  pass('Compiled normalized bill history, paused pattern and old source alias survive the native different-key restore and resolve through real HTTP');
  // Read the actual restored encrypted request using compiled production code.
  // Source/authority callbacks below are explicitly fictional replay fixtures;
  // they do not reconnect Gmail or bypass the real HTTP setup-review boundary.
  const proposalProbe = join(scratch, 'probe-restored-proposal.mjs');
  writeFileSync(proposalProbe, `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { WorkflowDatabase } from ${JSON.stringify(pathToFileURL(join(resources, 'server/workflow-database.js')).href)};
import { createBillProposals } from ${JSON.stringify(pathToFileURL(join(resources, 'server/bill-proposals.js')).href)};
import { validateSavedBillProposal } from ${JSON.stringify(pathToFileURL(join(resources, 'server/bill-proposal-validation.js')).href)};
const fixture = ${JSON.stringify(billFixture.proposal)};
const retainedMail = ${JSON.stringify(billFixture.mail)};
const database = new WorkflowDatabase({dir:process.env.REALBUD_DATA_DIR,key:Buffer.from(process.env.REALBUD_DESK_KEY,'hex')});
try {
  assert.deepEqual(database.get('mail-prepared',retainedMail.prepared.id),retainedMail.prepared);
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.REALBUD_DATA_DIR,'vault/workflow-inputs/accounts-inbox.json'),'utf8')),retainedMail.prepared.value.input);
  const saved = database.get('bill-proposal',fixture.record.id);
  assert.deepEqual(saved,fixture.record);
  validateSavedBillProposal(saved.id,saved.value);
  let calls = 0;
  const retry = createBillProposals({database:()=>database,workroom:join(process.env.REALBUD_DATA_DIR,'vault'),epoch:()=> 'fixture',authorize:async()=>fixture.authority,source:async()=>fixture.source,runs:()=>[],execute:async()=>{calls++;throw new Error('Unexpected worker admission');}});
  await assert.rejects(retry(fixture.request),/earlier preparation stopped/);
  assert.equal(calls,0); assert.deepEqual(database.get('bill-proposal',saved.id),saved);
} finally {database.close();}
`, { mode: 0o600 });
  let seedError = '';
  seedChild = spawn(executable, [proposalProbe], { cwd: resources, env: { ...serviceSmokeEnv({ executable, home: scratch, data, scratch, port: nativePort }), REALBUD_DESK_KEY: targetKey.toString('hex') }, stdio: ['ignore', 'ignore', 'pipe'] });
  seedChild.stderr.on('data', bytes => { seedError = (seedError + bytes).slice(-10000); });
  await until(() => seedChild.exitCode !== null || seedChild.signalCode, 'compiled restored proposal probe');
  assert.equal(seedChild.exitCode, 0, seedError);
  pass('Compiled proposal intent survives native different-key restore exactly and its unfinished retry cannot admit another worker');
  assert.deepEqual((await api('/api/bill-review-drafts/' + retainedDraft.id)).draft, retainedDraft);
  assert.deepEqual((await api('/api/bill-review-drafts')).items.map(row => row.id), [retainedDraft.id]);
  const historical = await api('/api/bill-proposals/' + draftRequest.requestId);
  assert.equal(historical.state, 'intent-recorded'); assert.equal(historical.historical, true);
  assert.equal(historical.run, null); assert.equal(historical.sourceDigest, draftRequest.expectedSourceDigest);
  const restoredMail = await api('/api/mail-workspace');
  assert.equal(restoredMail.version,2); assert.equal(Object.hasOwn(restoredMail,'items'),false);
  assert.deepEqual(restoredMail.counts,billFixture.mail.metadata.counts);
  assert.deepEqual(restoredMail.latestScan,billFixture.mail.metadata.latestScan);
  assert.deepEqual((await api('/api/mail-workspace/items/'+billFixture.mail.item.id)).item,billFixture.mail.item);
  assert.deepEqual(await api('/api/mail-workspace/items/'+billFixture.mail.item.id+'/source'),billFixture.mail.source);
  const oldMailPage=await api('/api/mail-workspace/items?group=done&limit=1');
  assert.equal(oldMailPage.total,1);assert.equal(oldMailPage.items[0].id,billFixture.mail.item.id);
  const restoredScans=await api('/api/mail-workspace/scans?limit=1');
  assert.equal(restoredScans.total,2);assert.deepEqual(restoredScans.items[0],billFixture.mail.metadata.latestScan);
  await page.goto(origin+'/#/desk');
  await page.getByRole('button',{name:'Open mail priorities',exact:true}).click();
  const mailPanel=page.getByRole('region',{name:'Mail priorities and follow-ups',exact:true});
  await mailPanel.getByRole('button',{name:'Done (1)',exact:true}).click();
  await mailPanel.getByText('Your note: '+billFixture.mail.item.note,{exact:true}).waitFor();
  await mailPanel.getByRole('button',{name:'View source conversation',exact:true}).click();
  const restoredConversation=mailPanel.getByRole('complementary',{name:'Saved source conversation',exact:true});
  await restoredConversation.locator('summary').click();
  await restoredConversation.getByText(billFixture.mail.source.thread.messages[0].body,{exact:true}).waitFor();
  await restoredConversation.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(output,'native-restored-mail-source.png')});
  pass('Compiled normalized mail, completed staff decision, old source and scan history survive different-key native restore and open in the real GUI');
  let proposalPosts = 0;
  const countProposalPost = request => { if (new URL(request.url()).pathname === '/api/bill-proposals' && request.method() === 'POST') proposalPosts++; };
  page.on('request', countProposalPost);
  await page.goto(origin+'/#/desk');
  await page.getByRole('button', { name: 'Open bills and calendar', exact: true }).click();
  const billsPanel = page.getByRole('region', { name: 'Source-linked bills and calendar', exact: true });
  await billsPanel.locator(`[data-review-id="${retainedDraft.id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
  const reviewForm = billsPanel.getByRole('form', { name: 'Review source bill', exact: true });
  assert.equal(await reviewForm.getByLabel('Bill note', { exact: true }).inputValue(), retainedDraft.fields.note);
  assert.equal(await reviewForm.getByLabel('Amount (AUD)', { exact: true }).inputValue(), retainedDraft.fields.amount);
  await reviewForm.getByRole('button', { name: 'Check the saved proposal request', exact: true }).click();
  await reviewForm.getByText('The request was recorded, but no worker result is recorded.', { exact: false }).waitFor();
  const noteAfterRestore = retainedDraft.fields.note + ' Continued after native restore.';
  await reviewForm.getByLabel('Bill note', { exact: true }).fill(noteAfterRestore);
  await reviewForm.getByRole('button', { name: 'Save for later', exact: true }).click();
  await billsPanel.getByText('Review saved for later. Source confirmations must be checked again when reopened.', { exact: true }).waitFor();
  const resaved = (await api('/api/bill-review-drafts/' + retainedDraft.id)).draft;
  assert.equal(resaved.fields.note, noteAfterRestore); assert.deepEqual(resaved.proposalRequest, draftRequest);
  assert.ok(resaved.revision > retainedDraft.revision); assert.equal(resaved.state, 'saved');
  await billsPanel.locator(`[data-review-id="${retainedDraft.id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
  assert.equal(await reviewForm.getByLabel('Bill note', { exact: true }).inputValue(), noteAfterRestore);
  assert.equal(proposalPosts, 0); page.off('request', countProposalPost);
  await reviewForm.getByLabel('Bill note', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({path: join(output, 'native-restored-bill-review.png')});
  pass('Encrypted bill draft reopens after native different-key restore while source is unavailable; historical Check makes no proposal POST and manual notes save with the original request ID');
  await page.goto(origin+'/#/you');
  await page.waitForLoadState(); await page.reload(); await page.locator('details#you-advanced > summary').click(); await panel.waitFor();
  assert.equal(await panel.getByText('Restore staged — restart required', { exact: true }).count(), 0);
  const completedPanel = panel.getByRole('region', { name: 'Completed private restore', exact: true });
  await completedPanel.getByRole('heading', { name: 'Last restore completed', exact: true }).waitFor();
  await completedPanel.locator('summary').filter({ hasText: 'View restored backup details' }).click();
  await completedPanel.locator('summary').filter({ hasText: 'Backup identifiers' }).click();
  await completedPanel.getByText(staged.receipt.digest, { exact: false }).waitFor();
  await panel.screenshot({ path: join(output, 'native-restore-completed.png') });
  await captureBackupContext(panel, 'native-restore-completed-context.png');
  // A stale raw/quarantine alternative must not take custody from the live book.
  assert.equal((await ipc('serviceStop')).ok, true);
  const staleKey = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', staleKey, iv), ciphertext = Buffer.concat([cipher.update(JSON.stringify({ fictional: 'obsolete sample' })), cipher.final()]);
  const quarantine = join(data, 'desk.json.quarantine-2026-09-01');
  writeFileSync(quarantine, JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ciphertext.toString('base64') }), { mode: 0o600 });
  writeFileSync(join(data, 'desk.key'), staleKey, { mode: 0o600 }); const held = readFileSync(quarantine);
  assert.equal((await ipc('serviceStart')).ok, true); await sessionToken(); assert.equal(await protectedDigest(), firstDigest);
  assert.ok((await api('/api/desk')).properties.some(p => p.address === 'Fictional Native Restore Oak Street'));
  assert.deepEqual(readFileSync(quarantine), held); assert.deepEqual(readFileSync(join(data, 'desk.key')), staleKey);
  pass('Native restart prefers the current restored book over a stale quarantine and retains the alternative recovery key and bytes');
  keyProof = { sameTargetKeyAcrossThreeRestarts: true, sourceKeyDifferent: true, afterMigrationAndRestorePlaintextKeyAbsent: true, alternativeRecoveryKeyPreserved: true, fixtureCalls: await inspector.evaluate('globalThis.__realbudCustodyFixture()') };
  if (welcomeRestore) { assert.equal(welcomeAgencyWrites, 0); assert.deepEqual(onboardingFixture, []); }
  assert.deepEqual(errors, []);
}
try { await runScenario(); }
catch (error) { failure = error.stack || String(error); console.error(failure); process.exitCode = 1; await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  // Stop only the matching service recorded in this disposable directory.
  const handle = readServiceHandle(data, identity.instanceId);
  const uncertainHandle = existsSync(join(data, 'service.json')) && !handle;
  if (handle) { servicePids.add(handle.pid); await requestServiceStop(handle, identity); }
  await browser?.close().catch(() => {}); inspector?.close(); await stopChild(nativeChild); await stopChild(seedChild); await stopChild(sourceChild); await stopChild(targetChild);
  let cleanup = { capturedServicePids: [...servicePids], serviceProcessesExited: false, scratchRemoved: false };
  try {
    assert.equal(uncertainHandle, false, 'Service identity cannot be checked; retain the fixture directory.');
    // A missing HTTP response is not process-exit evidence. Signal 0 only
    // checks existence; never send a termination signal to a recorded PID.
    await until(async () => [...servicePids].every(exited) && !(await findRunningService(identity)), 'all owned native service processes exited', 12000);
    cleanup.serviceProcessesExited = true;
    if (!failure) { rmSync(scratch, { recursive: true, force: true }); cleanup.scratchRemoved = true; }
  } catch { failure ||= 'Fixture service termination could not be verified; disposable directory retained for recovery.'; process.exitCode = 1; }
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), mode, passed: !reproduceWelcomeBlock && !failure, ...(reproduceWelcomeBlock ? { reproductionMatched: !failure, productAcceptance: false, reproduction } : {}), executable, resources, artifact, provenance, runtime, checks, errors, keyProof, onboardingFixture, welcomeJourney, cleanup, limitations: ['Actual packaged Mac runtime, main, native preload IPC, detached service, bootstrap and UI', 'safeStorage is an in-memory AES fixture; OS Keychain/DPAPI protection and keychain prompts are not tested', reproduceWelcomeBlock ? 'Expected-defect reproduction only: visible sample onboarding is exercised without restoring a backup; a matched reproduction is not a product pass' : welcomeRestore ? 'Visible welcome, backup cancellation, passphrase refusal, reviewed restore and postrestore welcome use the real UI; source data is fictional and no target onboarding API fixture is used' : 'Scoped onboarding API calls prepare fictional backup fixtures; visible welcome acceptance is not tested here', 'Only fictional isolated data and allowlisted process environment without provider credentials; renderer and Electron requests are guarded after attachment, not process-wide network isolation', 'Signing and notarization are separate package evidence; this is not customer installation, an older-version upgrade, Windows or reboot survival'], failure, ...(failure ? { diagnostics: { sourceLog, nativeLog, retainedDirectory: cleanup.scratchRemoved ? null : scratch } } : {}) }, null, 2), { flag: 'wx', mode: 0o600 });
}
