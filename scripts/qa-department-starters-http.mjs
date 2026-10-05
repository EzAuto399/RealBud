// Two disposable company installations, actual HTTP routes and PostgreSQL.
// Fictional data only. No browser automation, model, connector or external action.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyInstallation } from '../server/company-installation.ts';
import { departmentConfigurationReviewMaterial, normalizeDepartmentConfiguration } from '../shared/department-configuration.ts';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { readSessionToken } from './local-session.mjs';

assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or later.');
assert(!process.env.REALBUD_COMPANY_DATABASE_URL, 'Remove the external company database setting before this disposable QA run.');
const root = process.cwd();
const output = resolve(process.env.QA_OUTPUT ?? `outputs/qm-productization-2026-10-03/http-${Date.now()}`);
assert(!existsSync(output), 'Use a fresh QA_OUTPUT; earlier evidence is preserved.');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'rb-department-starters-http-'));
const bin = realpathSync(process.env.REALBUD_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@16/bin');
const ui = resolve(process.env.OMB_STATIC_DIR ?? 'outputs/qm-productization-2026-10-03/ui');
assert(existsSync(join(ui, 'index.html')), 'Build the intended isolated UI before running this fixture.');
const keep = process.env.KEEP_QA_FIXTURE === '1';
const offices = [], checks = [], requests = [];
const pause = ms => new Promise(done => setTimeout(done, ms));
const writeJson = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
let interrupted = false, releaseKeep;
const signal = () => { interrupted = true; releaseKeep?.(); };
process.once('SIGTERM', signal); process.once('SIGINT', signal);

// The production company listener binds all interfaces. This disposable harness
// narrows only wildcard listeners, in both setup and child processes, to loopback.
const oldListen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (args[0] && typeof args[0] === 'object' && ['0.0.0.0', '::'].includes(args[0].host)) args[0] = { ...args[0], host: '127.0.0.1' };
  if (['0.0.0.0', '::'].includes(args[1])) args[1] = '127.0.0.1';
  return oldListen.apply(this, args);
};
const preload = join(temp, 'loopback-only.cjs');
writeFileSync(preload, `const {Server}=require('node:net');const old=Server.prototype.listen;Server.prototype.listen=function(...args){if(args[0]&&typeof args[0]==='object'&&['0.0.0.0','::'].includes(args[0].host))args[0]={...args[0],host:'127.0.0.1'};if(['0.0.0.0','::'].includes(args[1]))args[1]='127.0.0.1';return old.apply(this,args)};\n`, { mode: 0o600 });

async function eventually(fn, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert(!interrupted, 'QA interrupted.');
    if (await fn()) return;
    await pause(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function stop(office) {
  if (!office.child || office.child.exitCode !== null || office.child.signalCode) return;
  office.child.kill('SIGTERM');
  const timer = setTimeout(() => office.child.kill('SIGKILL'), 10_000);
  try { await office.closed; } finally { clearTimeout(timer); }
}
async function app(office, path, body, expected = 200, method = body === undefined ? 'GET' : 'POST', member = office.ownerToken) {
  const response = await fetch(office.origin + path, { method, signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', 'x-realbud-session': office.token, 'x-realbud-member-session': member ?? '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let result;
  try { result = JSON.parse(text); } catch { throw new Error(`${method} ${path}: non-JSON ${response.status}`); }
  requests.push({ office: office.label, method, path, status: response.status });
  assert((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${office.label} ${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function start(office) {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(done => socket.close(done));
  office.origin = `http://127.0.0.1:${port}`;
  office.child = spawn(process.execPath, ['--require', preload, join(root, 'server/bootstrap.ts')], { cwd: root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: office.home, data: office.data, scratch: office.home, port }),
      REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', REALBUD_DESK_KEY: office.key.toString('hex'), REALBUD_COMPANY_POSTGRES_BIN: bin, OMB_STATIC_DIR: ui },
    stdio: ['ignore', 'pipe', 'pipe'] });
  office.closed = new Promise((done, reject) => { office.child.once('close', done); office.child.once('error', reject); });
  for (const stream of [office.child.stdout, office.child.stderr]) stream.on('data', bytes => { office.logs = (office.logs + bytes).slice(-80_000); });
  await eventually(async () => {
    if (office.child.exitCode !== null) throw new Error(`${office.label} server stopped: ${office.logs}`);
    try { return (await (await fetch(office.origin + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === office.child.pid; } catch { return false; }
  }, `${office.label} service health`);
  office.token = await readSessionToken(office.data);
  const signed = await app(office, '/api/company/sign-in', office.credential, 200, 'POST', '');
  office.ownerToken = signed.memberToken; office.companyId = signed.company.id; office.ownerId = signed.member.id;
}
async function createOffice(label, slug) {
  const home = join(temp, slug), data = join(home, 'data'); mkdirSync(data, { recursive: true, mode: 0o700 });
  const office = { label, slug, home, data, key: randomBytes(32), logs: '', ownerToken: '', token: '',
    credential: { loginName: `${slug}.owner`, password: `Fictional-${slug}-password-2026` } };
  offices.push(office);
  writeFileSync(join(data, 'config.json'), JSON.stringify({ profile: { name: `${label} owner` }, instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  const setup = createCompanyInstallation({ dataDirectory: data, binaryDirectory: bin, previewEnabled: true, privateStateKey: office.key,
    hasAdminSession: () => true, authorizeAdmin: () => ({ ok: true, expiresAt: Date.now() + 60_000 }) });
  office.setup = setup;
  const request = async (path, body, expected, member = '') => {
    const result = await setup.handle('/api/company/' + path, 'POST', { headers: { 'x-realbud-member-session': member } }, body);
    assert.equal(result.status, expected, JSON.stringify(result.body)); return result.body;
  };
  try {
    await request('setup', {}, 200);
    const created = await request('create', { name: label, ownerName: `${label} owner`, credential: office.credential }, 201);
    await request('network', { hostname: '127.0.0.1' }, 200, created.memberToken);
  } finally { await setup.close(); office.setup = null; }
  await start(office);
  let onboarding = await app(office, '/api/onboarding');
  for (const stage of ['office-rules', 'complete']) onboarding = await app(office, '/api/onboarding', { expectedScope: onboarding.scope, expectedRevision: onboarding.revision, stage }, 200, 'PUT');
  return office;
}
async function saveConfiguration(office, page, configuration, note, sourceReceiptId = null, acknowledge = true) {
  const input = { departmentId: page.department.id, expectedRevision: page.department.revision, configuration, note, sourceReceiptId };
  const reviewDigest = createHash('sha256').update(departmentConfigurationReviewMaterial(office.companyId, input)).digest('hex');
  const request = { ...input, requestId: randomUUID(), reviewDigest };
  const result = await app(office, '/api/company/departments/configuration/save', request);
  if (acknowledge) await app(office, '/api/company/department-outbox/ack', { requestId: request.requestId });
  return { request, result };
}
async function configure(office) {
  const pack = await app(office, '/api/customer-packs/department-starters/export');
  assert.equal(pack.id, 'department-starters'); assert.equal(pack.recipes.length, 5);
  const preview = await app(office, '/api/customer-packs/preview', { pack }); assert.equal(preview.canInstall, true);
  const installed = await app(office, '/api/customer-packs/install', { pack, expectedDigest: preview.digest }); assert.equal(installed.localReady, true);
  const first = (await app(office, '/api/recipes')).recipes;
  assert.equal(first.filter(recipe => recipe.id.startsWith('wf-department-starters-')).length, 5);
  assert(first.every(recipe => recipe.status === 'shadow' && recipe.planApprovedAt === null && recipe.schedule === null));
  office.departments = [];
  for (const name of ['Accounts', 'Property Management']) {
    const created = await app(office, '/api/company/departments', { requestId: randomUUID(), name }, 201);
    office.departments.push(created.department);
  }
  const before = await app(office, '/api/company/department-work/configuration-candidates', { departmentId: office.departments[0].id });
  assert.equal(before.candidates.length, 0); assert.equal(before.unavailable.length, 5);
  for (const recipe of first) await app(office, '/api/recipes/' + recipe.id, { expectedRevision: recipe.revision, planApproved: true, status: 'active' }, 200, 'PATCH');
  for (let index = 0; index < office.departments.length; index++) {
    const page = await app(office, '/api/company/department-work/configuration-candidates', { departmentId: office.departments[index].id });
    assert.equal(page.candidates.length, 5); assert.equal(page.configuration, null);
    const plans = page.candidates.filter(candidate => candidate.recipe.id.includes(index === 0 ? '-accounts-' : '-pm-'));
    const configuration = normalizeDepartmentConfiguration({ version: 1, template: index === 0 ? 'accounts-admin' : 'property-management', plans,
      workflowDefaults: plans.map(plan => ({ id: plan.recipe.id.replace('wf-department-starters-', ''), label: plan.recipe.review.plan.title, defaultRecipeId: plan.recipe.id })) });
    assert.equal(plans.length, index === 0 ? 3 : 2);
    const saved = await saveConfiguration(office, page, configuration, 'Reviewed fictional department starter plans.', null, false);
    const replay = await app(office, '/api/company/departments/configuration/save', saved.request);
    assert.equal(replay.replayed, true); assert.equal(replay.receiptId, saved.request.requestId);
    await app(office, '/api/company/department-outbox/ack', { requestId: saved.request.requestId });
    const catalog = await app(office, '/api/company/department-work/catalog', { departmentId: page.department.id });
    assert.equal(catalog.configured, true); assert.equal(catalog.recipes.length, plans.length); assert.deepEqual(catalog.unavailable, []);
    const created = await app(office, '/api/company/departments/cases/create', { requestId: randomUUID(), departmentId: page.department.id,
      title: `${office.label} ${index === 0 ? 'invoice issue' : 'maintenance review'}`,
      description: `Fictional ${office.slug} case only. A repair invoice needs the responsible person's review. Source date and complete evidence are missing; keep the decision held. No payment, dispatch or message is authorized.`, assigneeMemberId: office.ownerId }, 201);
    await app(office, '/api/company/department-outbox/ack', { requestId: created.receiptId });
    office.departments[index] = { ...saved.result.department, firstConfiguration: configuration, firstReceiptId: saved.result.receiptId, caseId: created.item.id };
  }
  const repeatPreview = await app(office, '/api/customer-packs/preview', { pack });
  assert.deepEqual(repeatPreview.additions, []);
  await app(office, '/api/customer-packs/install', { pack, expectedDigest: repeatPreview.digest });
  assert.equal((await app(office, '/api/recipes')).recipes.length, 5);
  assert.equal((await app(office, '/api/company/departments/list', { offset: 0 })).departments.length, 2);
  pass(`${office.label}: HTTP export/install, unapproved import, five exact candidates, two reviewed groups, idempotent save and correct 3/2-plan catalogs.`);
}

let success = false;
try {
  const a = await createOffice('Fictional Acacia Agency', 'acacia'); await configure(a);
  const b = await createOffice('Fictional Banksia Agency', 'banksia'); await configure(b);
  assert.notEqual(a.companyId, b.companyId); assert.notEqual(a.ownerId, b.ownerId);
  const aWorkspace = JSON.parse(readFileSync(join(a.data, 'company-installation', 'workspace.json'), 'utf8'));
  const bWorkspace = JSON.parse(readFileSync(join(b.data, 'company-installation', 'workspace.json'), 'utf8'));
  assert.notEqual(aWorkspace.id, bWorkspace.id);
  const emptyPrivate = await app(b, '/api/desk');
  assert(!JSON.stringify(emptyPrivate).includes('Acacia')); assert(!JSON.stringify(emptyPrivate).includes(a.companyId));
  pass('Both agencies have fresh company, member and workspace identities; no first-agency markers appear in the second private Desk.');
  for (const office of [a, b]) {
    const other = office === a ? b : a;
    await app(office, '/api/company/departments/configuration', { departmentId: other.departments[0].id }, [403, 404]);
    await app(office, '/api/company/departments/configuration', { departmentId: office.departments[0].id }, [401, 403], 'POST', other.ownerToken);
    await app(office, '/api/company/department-work/catalog', { departmentId: other.departments[0].id }, [403, 404]);
  }
  pass('Foreign department identifiers and another office owner token are refused through actual HTTP in both directions.');
  const departmentId = b.departments[0].id;
  const current = await app(b, '/api/company/departments/configuration', { departmentId });
  const changed = structuredClone(current.configuration); changed.workflowDefaults[0].label = 'Invoice exceptions for review';
  const update = await saveConfiguration(b, current, changed, 'Fictional adjustment for current agency.');
  const stale = { ...update.request, requestId: randomUUID() };
  await app(b, '/api/company/departments/configuration/save', stale, 409);
  const history = await app(b, '/api/company/departments/configuration/history', { departmentId, beforeRevision: null, limit: 10 });
  assert.equal(history.entries.length, 2);
  const original = history.entries.find(entry => entry.receiptId === b.departments[0].firstReceiptId); assert(original);
  const latest = await app(b, '/api/company/departments/configuration', { departmentId });
  const restored = await saveConfiguration(b, latest, original.configuration, 'Reviewed restoration of original fictional settings.', original.receiptId);
  assert.equal(BigInt(restored.result.department.revision), BigInt(latest.department.revision) + 1n);
  assert.deepEqual(restored.result.configuration, original.configuration);
  pass('Stale configuration writes are refused; history and explicit reviewed rollback preserve the original plan bytes in a new revision.');
  await stop(b); await start(b);
  const afterRestart = await app(b, '/api/company/departments/configuration', { departmentId });
  assert.deepEqual(afterRestart.configuration, original.configuration);
  const catalog = await app(b, '/api/company/department-work/catalog', { departmentId });
  assert.equal(catalog.recipes.length, 3); assert.deepEqual(catalog.unavailable, []);
  assert.equal((await app(b, '/api/job-runs')).runs.length, 0);
  pass('Cold service restart retains the exact department configuration/catalog and starts zero worker runs.');
  await stop(a);
  const sourceFiles = ['server/customer-packs.ts', 'server/department-starter-pack.ts', 'server/company/departments.ts', 'server/department-work.ts', 'shared/department-configuration.ts', 'src/components/CompanyDepartmentConfiguration.tsx'];
  writeJson('receipt.json', { passed: true, at: new Date().toISOString(), layer: 'Current source HTTP services + isolated PostgreSQL; compiled renderer available for separate CUA review', checks,
    sourceSha256: Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')])),
    limitations: ['Fictional data only; no worker or model request', 'Isolated service lab disables managed-service entitlement; worker and external-action admission are not tested', 'No live connectors, external actions, financial completion or cross-department execution claimed',
      'QA preload narrows wildcard company listeners to loopback; production LAN listener behavior is not exercised', 'Trusted setup helper bootstraps isolated local companies; normal onboarding, sign-in and workflow routes exercised over HTTP', 'GUI review is separate and uses CUA'] });
  writeJson('requests.json', requests);
  success = true;
  if (keep && !interrupted) {
    writeJson('fixture.json', { alive: true, supervisorPid: process.pid, serverPid: b.child.pid, origin: b.origin, ui,
      agency: b.label, companyId: b.companyId, credential: b.credential, departments: b.departments.map(({ id, name, caseId }) => ({ id, name, caseId })),
      cleanup: `Send SIGTERM to owned supervisor ${process.pid}.`, fictionalCredentialsOnly: true });
    console.log(`FIXTURE_READY ${b.origin} supervisor=${process.pid}; fictional login in ${join(output, 'fixture.json')}`);
    await new Promise(done => { releaseKeep = done; if (interrupted) done(); });
  }
} catch (error) {
  writeJson('failure.json', { passed: false, at: new Date().toISOString(), error: String(error), checks, requests });
  throw error;
} finally {
  for (const office of offices.reverse()) { await stop(office); await office.setup?.close(); writeFileSync(join(output, `${office.slug}-server.log`), office.logs, { mode: 0o600 }); }
  rmSync(temp, { recursive: true, force: true });
  Server.prototype.listen = oldListen;
  writeJson('cleanup.json', { complete: true, success, at: new Date().toISOString() });
}
