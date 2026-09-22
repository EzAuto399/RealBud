// Two real desktop HTTP services and the real managed connector gateway/parser.
// Only the Composio upstream and Hermes reasoning are fictional. No live credentials.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { createServiceAdminPasswordVerifier } from '../server/service-admin.ts';
import { canonicalServiceEntitlementPayload } from '../server/service-entitlement.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverExecutable = process.env.REALBUD_QA_EXECUTABLE || process.execPath, resources = process.env.REALBUD_QA_RESOURCES;
if (!!resources !== !!process.env.REALBUD_QA_EXECUTABLE) throw new Error('Specify both compiled resources and executable.');
const serverEntry = resources ? join(resources, 'server/bootstrap.js') : join(root, 'server/bootstrap.ts');
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'rb-managed-mail-'));
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/managed-mail-integration-2026-09-22'));
mkdirSync(output, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [], desktops = [], pending = new Map();
let gateway, gatewayClosed, gatewayLogs = '', failure, finalStats, ready, controlSequence = 0;
const assertPrivate = value => assert.ok(!/ak_fictional_gateway_canary_[AB]/.test(typeof value === 'string' ? value : JSON.stringify(value)), 'Gateway vendor key crossed the process boundary');
function watchLogs(stream, owner) {
  let overlap = '';
  stream.on('data', bytes => {
    const text = bytes.toString('utf8');
    try { assertPrivate(overlap + text); } catch (error) { failure ??= error; }
    overlap = (overlap + text).slice(-64);
    owner.logs = (owner.logs + text.replaceAll(/ak_fictional_gateway_canary_[AB]/g, '[redacted fixture canary]')).slice(-200000);
  });
}
const write = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
const closed = child => new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
async function stop(child, done) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try { await done; } finally { clearTimeout(timer); }
}
async function until(action, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (failure) throw failure; if (await action()) return; await wait(100); }
  throw new Error(`Timed out: ${description}`);
}
async function control(command, args = {}) {
  const id = ++controlSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Gateway control timeout: ${command}`)); }, 10000);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    gateway.send({ id, command, ...args });
  });
}
async function request(d, path, method = 'GET', body, expected = 200, admin = false) {
  const response = await fetch(d.base + path, { method, signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'x-realbud-session': d.session, ...(admin ? { 'x-realbud-service-admin': d.admin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assertPrivate(text);
  const value = JSON.parse(text);
  if (expected !== null) assert.equal(response.status, expected, `${method} ${path}: ${text}`);
  return expected === null ? { status: response.status, body: value } : value;
}
async function boot(d) {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(r => reserve.close(r)); d.base = `http://127.0.0.1:${port}`;
  d.child = spawn(serverExecutable, ['--import', d.networkGuard, serverEntry], { cwd: resources || root,
    env: { ...serviceSmokeEnv({ executable: serverExecutable, home: d.home, data: d.data, scratch: d.home, port }),
      REALBUD_HERMES_CLI: d.worker, REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: resources ? join(resources, 'ui') : join(root, 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  d.closed = closed(d.child); d.logs = '';
  for (const stream of [d.child.stdout, d.child.stderr]) watchLogs(stream, d);
  await until(async () => {
    if (d.child.exitCode !== null || d.child.signalCode) throw new Error(`Desktop ${d.name} exited`);
    try { return (await (await fetch(d.base + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === d.child.pid; } catch { return false; }
  }, `desktop ${d.name} startup`);
  d.session = (await (await fetch(d.base + '/api/session')).json()).token;
  assert.equal((await request(d, '/api/service/status')).state, 'active');
  assert.equal((await request(d, '/api/service-admin/status')).authenticated, false);
}
async function makeDesktop(name) {
  const home = join(temp, name), data = join(home, 'data'); mkdirSync(data, { recursive: true, mode: 0o700 });
  const d = { name, home, data, worker: join(home, 'worker.mjs'), networkGuard: join(home, 'network-guard.mjs'), calls: join(home, 'worker-calls.json'), password: `Fictional-${name}-administration-2026!`, session: '' };
  desktops.push(d);
  write(join(data, 'config.json'), { instances: { fixture: { driver: 'not-a-real-driver' } } });
  write(join(data, 'service-admin.json'), { version: 1, passwordVerifier: await createServiceAdminPasswordVerifier(d.password) });
  const keys = generateKeyPairSync('ed25519'), companyId = `company-${name.toLowerCase()}`, hostInstallationId = `install-${name.toLowerCase()}`;
  write(join(data, 'service-installation.json'), { schema: 1, companyId, hostInstallationId });
  write(join(data, 'service-trust-keys.json'), { schema: 1, keys: [{ keyId: 'fixture-key', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] });
  const payload = canonicalServiceEntitlementPayload({ schema: 1, companyId, licenseId: `license-${name.toLowerCase()}`, hostInstallationId,
    issuedAt: Date.now() - 60000, notBefore: Date.now() - 30000, expiresAt: Date.now() + 3600000, capabilities: ['reasoning', 'connected-tools'] });
  write(join(data, 'service-entitlement.json'), { schema: 1, keyId: 'fixture-key', payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64url') });
  write(d.networkGuard, `const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==${JSON.stringify(ready.endpoint)})throw new Error('QA denied non-gateway fetch');return realFetch(input,init);};`);
  writeFileSync(d.worker, `#!${process.execPath}\nimport {readFileSync,writeFileSync,existsSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('Hermes Agent v0.21.3 (2026.9.14)');process.exit(0);}
const path=${JSON.stringify(join(data, 'vault/workflow-inputs/accounts-inbox.json'))};if(!existsSync(path)){console.log('{}');process.exit(0);}
const input=JSON.parse(readFileSync(path,'utf8'));
const result={version:1,kind:'accounts-inbox-triage',skillSource:'email-inbox-triage@0.1.0',sourceReference:input.sourceReference,status:'complete',coverageComplete:true,holds:[],actionsPerformed:[],threads:input.threads.map(t=>({threadId:t.threadId,disposition:'action-review',owner:'property-manager',priority:'normal',sourceMessageIds:t.messages.map(m=>m.messageId),reason:'Fictional maintenance request.',nextAction:'Review internally.',missingFacts:[]}))};
let calls=[];try{calls=JSON.parse(readFileSync(${JSON.stringify(d.calls)},'utf8'));}catch{}calls.push(input.threads.length);writeFileSync(${JSON.stringify(d.calls)},JSON.stringify(calls));
console.log(JSON.stringify({summary:'Deterministic fictional review',evidence:['Fictional mail'],outputs:[JSON.stringify(result)],needsApproval:[]}));\n`, { mode: 0o700 });
  await boot(d);
  assert.equal((await fetch(d.base + '/api/mail-workspace')).status, 401);
  d.admin = (await request(d, '/api/service-admin/login', 'POST', { password: d.password })).token;
  await request(d, '/api/hermes/apply-pack', 'POST', {}, 200, true);
  await request(d, '/api/connected-apps/managed/setup', 'POST', { endpoint: ready.endpoint, credential: ready.agencies[name].credential }, 200, true);
  await request(d, '/api/service-admin/logout', 'POST', {}, 200, true); d.admin = undefined;
  const exported = await request(d, '/api/customer-packs/office-core/export');
  const preview = await request(d, '/api/customer-packs/preview', 'POST', { pack: exported });
  await request(d, '/api/customer-packs/install', 'POST', { pack: exported, expectedDigest: preview.digest });
  const recipe = (await request(d, '/api/recipes')).recipes.find(r => r.id === 'wf-office-core-inbox-triage');
  await request(d, `/api/recipes/${recipe.id}`, 'PATCH', { expectedRevision: recipe.revision, planApproved: true, status: 'active' });
  const status = await request(d, '/api/hermes'); assert.ok(status.workerFingerprint);
  write(join(data, 'hands-ping.json'), { at: Date.now(), ok: true, kind: 'ping', detail: 'Fictional CLI readiness, not a live model', workerFingerprint: status.workerFingerprint });
  await request(d, '/api/connected-apps/check', 'POST', {});
  let setup = await request(d, '/api/agency-setup');
  setup = await request(d, '/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings,
    agencyName: `Fictional Agency ${name}`, workflowPackId: 'office-core', timeZone: 'Australia/Brisbane', gmailAccountId: ready.agencies[name].accountId, selectedWorkflows: ['morning-priorities'] } });
  await reviewSetup(d); return d;
}
async function reviewSetup(d) {
  let setup = await request(d, '/api/agency-setup');
  setup = await request(d, '/api/agency-setup/check-gmail', 'POST', { expectedRevision: setup.state.revision });
  const workflow = setup.workflows.find(w => w.id === 'morning-priorities'); assert.ok(workflow.canReview, JSON.stringify(workflow));
  await request(d, '/api/agency-setup/workflows/morning-priorities/review', 'POST', { expectedRevision: setup.state.revision, expectedEvidenceDigest: workflow.evidenceDigest });
}
async function allItems(d) {
  const items = [], cursors = new Set(); let cursor, pages = 0;
  do { assert.ok(++pages <= 10, 'Mail page bound exceeded'); const page = await request(d, '/api/mail-workspace/items?group=all&limit=20' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); items.push(...page.items); assert.ok(items.length <= 100, 'Mail item bound exceeded'); cursor = page.nextCursor; if (cursor) { assert.ok(!cursors.has(cursor), 'Repeated mail cursor'); cursors.add(cursor); } } while (cursor);
  return items;
}
async function review(d) {
  const state = await request(d, '/api/mail-workspace'), body = { requestId: randomUUID(), expectedRevision: state.schedule.revision };
  await request(d, '/api/mail-workspace/review', 'POST', body, 202);
  await until(async () => (await request(d, '/api/mail-workspace')).operation?.state !== 'running', 'mail reasoning');
  assert.equal((await request(d, '/api/mail-workspace')).operation.state, 'complete'); return body;
}
async function preserved(d, before) { assert.deepEqual(await allItems(d), before); }
async function heldScan(d, mutation) {
  await control('hold', { agency: d.name });
  const pendingScan = request(d, '/api/mail-workspace/scan', 'POST', {}, null).then(value => ({ value }), error => ({ error }));
  let mutationError;
  try {
    await until(async () => (await control('stats')).agencies[d.name].holding, 'upstream held thread');
    await mutation();
  } catch (error) { mutationError = error; }
  finally { try { await control('release', { agency: d.name }); } catch (error) { mutationError ??= error; } }
  const settled = await pendingScan;
  if (mutationError) throw mutationError;
  if (settled.error) throw settled.error;
  const result = settled.value; assert.ok(result.status >= 400, JSON.stringify(result));
  return result;
}
try {
  gateway = fork(join(root, 'scripts/testing/managed-mail-gateway.ts'), [], { cwd: root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data: temp, scratch: temp, port: 0 }) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  gatewayClosed = closed(gateway);
  const gatewayLogOwner = { get logs() { return gatewayLogs; }, set logs(value) { gatewayLogs = value; } };
  for (const stream of [gateway.stdout, gateway.stderr]) watchLogs(stream, gatewayLogOwner);
  gateway.on('message', message => {
    try { assertPrivate(message); if (message.type === 'ready') ready = message;
      const p = pending.get(message.id); if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.result); }
    } catch (error) { failure = error; for (const p of pending.values()) p.reject(error); pending.clear(); }
  });
  await until(() => { if (gateway.exitCode !== null) throw new Error('Fixture gateway exited'); return ready; }, 'gateway startup');
  const a = await makeDesktop('A'), b = await makeDesktop('B');
  for (const d of [a, b]) {
    const replay = await review(d), state = await request(d, '/api/mail-workspace'), items = await allItems(d);
    assert.equal(state.counts.total, 45); assert.equal(state.latestScan.pages, 2); assert.equal(state.latestScan.status, 'complete'); assert.equal(state.schedule.enabled, false);
    assert.ok(items.every(row => row.accountId === ready.agencies[d.name].accountId));
    assert.deepEqual(JSON.parse(readFileSync(d.calls, 'utf8')), [20, 20, 5]);
    const before = await control('stats'); await request(d, '/api/mail-workspace/review', 'POST', replay, 202); await wait(100);
    assert.equal((await control('stats')).agencies[d.name].listCalls, before.agencies[d.name].listCalls);
    d.item = items[0]; await request(d, `/api/mail-workspace/items/${d.item.id}`, 'PATCH', { expectedRevision: d.item.revision, status: 'done', priority: 'low', note: `Staff decision ${d.name}` });
    await request(d, `/api/mail-workspace/items/${d.item.id}`, 'PATCH', { expectedRevision: d.item.revision, status: 'open' }, 409);
    const source = await request(d, `/api/mail-workspace/items/${d.item.id}/source`); assert.equal(source.accountId, ready.agencies[d.name].accountId);
  }
  checks.push('Two managed desktops with distinct signed grants/admins use real gateway HTTP, default Composio parser, two provider pages and three reasoning batches each; retry has no duplicate scan; account-linked data remains separate.');
  const before = await allItems(a), bBefore = await allItems(b);
  await request(a, `/api/mail-workspace/items/${b.item.id}`, 'GET', undefined, 404);
  await request(a, '/api/mail-workspace/scan', 'POST', { accountId: ready.agencies.B.accountId }, 400);
  const now = Date.now(), scope = { windowStartAt: now - 86400000, windowEndAt: now, maxMessages: 500, includeSent: true, carryThreadIds: [] };
  const statsBefore = await control('stats');
  for (const [profile, body, expected] of [['property', scope, 400], ['property', { expectedAccountId: ready.agencies.B.accountId, scope }, 409], ['property', { expectedAccountId: ready.agencies.A.accountId, scope, accountId: ready.agencies.B.accountId }, 400], ['other-profile', { expectedAccountId: ready.agencies.A.accountId, scope }, 403]]) {
    const response = await fetch(ready.endpoint + '/v1/connectors/mail-scan', { method: 'POST', headers: { authorization: `Bearer ${ready.agencies.A.credential}`, 'x-realbud-profile': profile, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, expected); assertPrivate(await response.text());
  }
  assert.deepEqual(await control('stats'), statsBefore);
  checks.push('Staff cannot override source scope/account; missing or forged expected-account preconditions, extra fields and mismatched profile are refused before provider access; agency A cannot read agency B saved rows.');
  await heldScan(a, () => control('revoke', { agency: 'A', active: false }));
  await preserved(a, before); await preserved(b, bBefore);
  await control('revoke', { agency: 'A', active: true });
  await heldScan(a, () => control('suspend', { agency: 'A', active: false }));
  await preserved(a, before); await control('suspend', { agency: 'A', active: true });
  checks.push('Device revocation and tenant suspension during held provider reads reject late success and retain both agencies’ exact prior staff rows.');
  const abortedBefore = (await control('stats')).agencies.A.aborted;
  await heldScan(a, async () => {
    const setup = await request(a, '/api/agency-setup');
    await request(a, '/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, agencyName: 'Fictional Agency A revised' } });
    await until(async () => (await control('stats')).agencies.A.aborted > abortedBefore, 'abort propagated to upstream fetch');
  });
  await preserved(a, before); assert.equal((await request(a, '/api/mail-workspace')).latestScan.status, 'interrupted');
  await reviewSetup(a);
  checks.push('Changing reviewed settings cancels an in-flight read through desktop, gateway HTTP and upstream AbortSignal; released late success cannot overwrite staff data.');
  for (const mode of ['provider-error', 'malformed', 'missing-key']) {
    await control('mode', { agency: 'A', value: mode });
    const result = await request(a, '/api/mail-workspace/scan', 'POST', {}, null); assert.ok(result.status >= 400, mode);
    await preserved(a, before); await control('mode', { agency: 'A', value: 'normal' });
  }
  await request(a, '/api/mail-workspace/scan', 'POST', {}); await preserved(a, before);
  await control('mode', { agency: 'A', value: 'partial' });
  await request(a, '/api/mail-workspace/scan', 'POST', {});
  assert.equal((await request(a, '/api/mail-workspace')).latestScan.status, 'partial');
  assert.equal((await request(a, `/api/mail-workspace/items/${a.item.id}`)).item.note, 'Staff decision A');
  await control('mode', { agency: 'A', value: 'normal' });
  checks.push('Upstream errors, malformed evidence and missing server key fail closed; normal recovery preserves staff decisions; incomplete provider coverage is recorded as partial.');
  await stop(a.child, a.closed); await boot(a);
  const restored = (await request(a, `/api/mail-workspace/items/${a.item.id}`)).item;
  assert.equal(restored.status, 'done'); assert.equal(restored.priority, 'low'); assert.equal(restored.note, 'Staff decision A');
  await preserved(b, bBefore);
  checks.push('A cold service restart retains reviewed staff decisions; the other agency remains unchanged.');
  await reviewSetup(a);
  await request(a, '/api/mail-workspace/schedule', 'PATCH', { enabled: true });
  assert.equal((await request(a, '/api/mail-workspace')).schedule.enabled, true);
  await request(b, '/api/mail-workspace/schedule', 'PATCH', { enabled: true });
  const unrelatedPack = await request(a, '/api/customer-packs/austin-office/export');
  const unrelatedPreview = await request(a, '/api/customer-packs/preview', 'POST', { pack: unrelatedPack });
  await request(a, '/api/customer-packs/install', 'POST', { pack: unrelatedPack, expectedDigest: unrelatedPreview.digest });
  assert.equal((await request(a, '/api/mail-workspace')).schedule.enabled, true, 'Unrelated pack must not pause the selected agency clock');
  const nextPack = await request(a, '/api/customer-packs/office-core/export'); nextPack.revision++;
  const packChange = await request(a, '/api/customer-packs/upgrade/preview', 'POST', { pack: nextPack });
  const upgradeRequest = { pack: nextPack, expectedInstalledDigest: packChange.installedDigest, expectedInstalledRevision: packChange.installedRevision, expectedDigest: packChange.digest, expectedPreviewDigest: packChange.previewDigest };
  await request(a, '/api/customer-packs/upgrade', 'POST', upgradeRequest);
  assert.equal((await request(a, '/api/mail-workspace')).schedule.enabled, false, 'A pack update must pause the selected agency morning clock');
  assert.equal((await request(b, '/api/mail-workspace')).schedule.enabled, true);
  const pausedPlan = (await request(a, '/api/recipes')).recipes.find(r => r.id === 'wf-office-core-inbox-triage');
  await request(a, `/api/recipes/${pausedPlan.id}`, 'PATCH', { expectedRevision: pausedPlan.revision, planApproved: true, status: 'active' });
  await reviewSetup(a); assert.equal((await request(a, '/api/mail-workspace')).schedule.enabled, false);
  await stop(a.child, a.closed); await boot(a); assert.equal((await request(a, '/api/mail-workspace')).schedule.enabled, false);
  await request(a, '/api/mail-workspace/schedule', 'PATCH', { enabled: true });
  await request(a, '/api/customer-packs/upgrade', 'POST', upgradeRequest);
  assert.equal((await request(a, '/api/mail-workspace')).schedule.enabled, true, 'Completed replay must not undo a later explicit schedule choice');
  await request(a, '/api/mail-workspace/schedule', 'PATCH', { enabled: false });
  checks.push('A selected-pack update durably disables the enabled morning clock through reapproval/restart; unrelated packs/agencies stay enabled and a completed retry preserves a later explicit schedule choice.');
  for (const d of desktops) {
    assertPrivate(d.logs);
    const inspect = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); if (entry.isDirectory()) inspect(path); else if (entry.isFile()) assertPrivate(readFileSync(path).toString('utf8'));
    } }; inspect(d.data);
  }
  assertPrivate(gatewayLogs); finalStats = await control('stats');
  assert.equal(finalStats.violations, 0);
  for (const d of ['A', 'B']) assert.equal(finalStats.agencies[d].violations, 0);
  if (failure) throw failure;
  checks.push('No fictional vendor key appears in HTTP responses, desktop files (including workflow inputs and database bytes), or captured service diagnostics; only revocable customer credentials were provisioned.');
} catch (error) { failure = error; }
finally {
  if (gateway?.connected) { try { await control('release', { agency: 'A' }); await control('release', { agency: 'B' }); } catch {} }
  for (const d of desktops) await stop(d.child, d.closed);
  if (gateway?.connected) { try { await control('stop'); } catch {} }
  await stop(gateway, gatewayClosed);
  for (const p of pending.values()) p.reject(new Error('QA stopped')); pending.clear();
  if (failure) {
    const log = desktops.map(d => `${d.name}\n${d.logs}`).join('\n') + '\nGateway\n' + gatewayLogs;
    write(join(output, 'failure.log'), log.replaceAll(/ak_fictional_gateway_canary_[AB]/g, '[redacted fixture canary]'));
  }
  rmSync(temp, { recursive: true, force: true });
  write(join(output, 'integration-receipt.json'), { at: new Date().toISOString(), passed: !failure,
    layer: `${resources ? 'Packaged' : 'Source'} two local managed desktop processes, actual source gateway/default Gmail adapter; fictional upstream and deterministic Hermes CLI; no live provider/model or native Windows proof`,
    checks, stats: finalStats, cleaned: !existsSync(temp), ...(failure ? { error: String(failure.message).replaceAll(/ak_fictional_gateway_canary_[AB]/g, '[redacted fixture canary]') } : {}) });
}
if (failure) throw failure;
console.log(JSON.stringify({ output, checks, cleaned: true }, null, 2));
