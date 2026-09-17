// Actual compiled services and PostgreSQL, two isolated profiles on this OS.
// Synthetic input only. No model, Cua, app connection or production data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const kit = resolve(process.argv[2]);
const atomicEnrollment = JSON.parse(await readFile(join(kit, 'test-kit.json'), 'utf8')).atomicCredentialEnrollment === true;
const output = resolve(process.argv[3]);
const scratch = await mkdtemp(join(tmpdir(), 'RealBud two profiles '));
const node = join(kit, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const children = new Set(); const checks = [];
let failure, cleanupComplete = false;
const overall = AbortSignal.timeout(180_000);
async function start(role) {
  const env = { PATH: dirname(node), HOME: scratch, USERPROFILE: scratch, TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(),
    REALBUD_TEST_LAB_ROOT: scratch, LANG: 'C', LC_ALL: 'C' };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(node, [join(kit, 'scripts/start-test-lab.mjs'), role], { env, cwd: kit, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const context = { role, child, stderr: '' }; children.add(context);
  context.exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  void context.exit.catch(() => {});
  child.stderr.on('data', bytes => { context.stderr = (context.stderr + bytes).slice(-8000); });
  let timer;
  try {
    context.url = await Promise.race([
      new Promise(resolve => child.on('message', message => { if (message?.type === 'realbud-test-ready') resolve(message.url); })),
      context.exit.then(() => { throw new Error(`${role} launcher exited before readiness: ${context.stderr}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${role} readiness timed out`)), 30_000); }),
    ]);
  } finally { clearTimeout(timer); }
  context.appToken = (await request(context, '/api/session')).token;
  return context;
}
async function stop(context) {
  let timer;
  if (context.child.exitCode === null && !context.child.signalCode) {
    assert.ok(context.child.connected, 'Owned launcher IPC is connected');
    context.child.send({ type: 'realbud-test-stop' });
  }
  try {
    const result = await Promise.race([context.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${context.role} shutdown timed out; preserve ${scratch}`)), 30_000); })]);
    assert.equal(result.code, 0, `${context.role} orderly exit: ${context.stderr}`);
    children.delete(context);
  } finally { clearTimeout(timer); }
}
async function request(context, path, body, expected = 200, method = body === undefined ? 'GET' : 'POST', extraHeaders = {}) {
  const response = await fetch(context.url + path, { method, signal: AbortSignal.any([overall, AbortSignal.timeout(20_000)]),
    headers: { ...(context.appToken ? { 'x-realbud-session': context.appToken } : {}),
      ...(context.adminToken ? { 'x-realbud-service-admin': context.adminToken } : {}),
      ...(context.memberToken ? { 'x-realbud-member-session': context.memberToken } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(response.status, expected, `${context.role} ${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
function passed(name) { checks.push(name); console.log(`PASS ${name}`); }
const alice = { loginName: 'lab.alice', password: 'Synthetic-Alice-password-2026' };
const bobby = { loginName: 'lab.bobby', password: 'Synthetic-Bobby-password-2026' };
try {
  let host = await start('host'); let client = await start('client');
  assert.notEqual(host.url, client.url); assert.notEqual(host.appToken, client.appToken);
  await request(client, '/api/workflow-packs/import', {}, 401, 'POST', { 'x-realbud-session': host.appToken });
  passed('Two compiled local services have independent app authority and profile roots');
  await request(host, '/api/company/setup', {}, 401);
  host.adminToken = (await request(host, '/api/service-admin/login', { password: 'RealBud-Synthetic-Lab-2026' })).token;
  await request(host, '/api/company/setup', {});
  const owner = await request(host, '/api/company/create', { name: 'Synthetic Two-Profile Office', ownerName: 'Alice Lab', ...(atomicEnrollment ? { credential: alice } : {}) }, 201);
  host.memberToken = owner.memberToken;
  if (atomicEnrollment) assert.match(owner.recoveryKey, /^[A-Za-z0-9_-]{43}$/);
  else await request(host, '/api/company/credentials', alice);
  await request(host, '/api/company/network', { hostname: '127.0.0.1' });
  const { hostCode } = await request(host, '/api/company/host-code');
  const invite = await request(host, '/api/company/invitations', { displayName: 'Bobby Lab' }, 201);
  await request(client, '/api/company/connect-host', { hostCode });
  const member = await request(client, '/api/company/join', { invitationToken: invite.invitationToken, ...(atomicEnrollment ? { credential: bobby } : {}) }, 201);
  client.memberToken = member.memberToken;
  if (atomicEnrollment) assert.match(member.recoveryKey, /^[A-Za-z0-9_-]{43}$/);
  else await request(client, '/api/company/credentials', bobby);
  assert.equal(member.company.id, owner.company.id); assert.notEqual(member.member.id, owner.member.id);
  assert.equal((await request(client, '/api/company/status')).transport, 'encrypted-company');
  await request(client, '/api/company/join', { invitationToken: invite.invitationToken, ...(atomicEnrollment ? { credential: bobby } : {}) }, 401);
  passed('Host provision, owner enrollment, pinned TLS join and separate member enrollment; invitation cannot replay');
  const privateScope = (await request(host, '/api/company/scopes', { kind: 'private', name: 'Alice private synthetic scope' }, 201)).scope;
  await request(client, '/api/company/knowledge/read', { scopeId: privateScope.id, key: 'private' }, 404);
  passed('Second member cannot read the owner private scope over the company transport');
  const fixture = JSON.parse(await readFile(join(kit, 'practice-pack.json'), 'utf8'));
  await request(host, '/api/workflow-packs/import', fixture);
  const template = await request(host, '/api/workflow-packs/company-template');
  assert.equal(template.recipes.length, 3);
  const publication = { expectedRevision: '0', template, companyId: owner.company.id, memberId: owner.member.id };
  await request(host, '/api/company/workflow-template', { ...publication, memberId: member.member.id }, 409, 'PUT');
  await request(host, '/api/company/workflow-template', publication, 200, 'PUT');
  const shared = await request(client, '/api/company/workflow-template');
  assert.deepEqual(shared.template, template); assert.equal(shared.revision, '1');
  await request(client, '/api/company/workflow-template', { ...publication, expectedRevision: '1', memberId: member.member.id }, 403, 'PUT');
  await request(host, '/api/company/workflow-template', publication, 409, 'PUT');
  passed('Owner publication binds reviewed identity and revision; member can read but cannot publish');
  for (let repeat = 0; repeat < 2; repeat++) await request(client, '/api/workflow-packs/import', shared.template);
  const saved = await request(client, '/api/workflow-packs/export');
  assert.equal(saved.recipes.length, 3);
  for (const recipe of saved.recipes) {
    assert.equal(recipe.status, 'shadow'); assert.equal(recipe.schedule, null);
    assert.ok(!recipe.approval); assert.ok(!recipe.attachment);
  }
  passed('Three plans import once, dormant and unapproved, into the other private workspace');
  const conflict = structuredClone(template); conflict.recipes[2].title = 'Conflicting synthetic title';
  await request(client, '/api/workflow-packs/import', conflict, 409);
  const malformed = structuredClone(template); malformed.recipes.push({ id: 'wf-invalid-last-row' });
  await request(client, '/api/workflow-packs/import', malformed, 400);
  assert.deepEqual((await request(client, '/api/workflow-packs/export')).recipes, saved.recipes);
  passed('Conflicting import and invalid final row leave every saved plan unchanged');
  await stop(host);
  await request(client, '/api/company/workflow-template', undefined, 503);
  assert.equal((await request(client, '/api/workflow-packs/export')).recipes.length, 3);
  passed('Host unavailable is explicit; local plans remain available without invented company results');
  await stop(client);
  host = await start('host'); client = await start('client');
  const ownerAgain = await request(host, '/api/company/sign-in', alice);
  const memberAgain = await request(client, '/api/company/sign-in', bobby);
  host.memberToken = ownerAgain.memberToken; client.memberToken = memberAgain.memberToken;
  assert.equal(ownerAgain.member.id, owner.member.id); assert.equal(memberAgain.member.id, member.member.id);
  assert.equal(ownerAgain.company.id, owner.company.id);
  assert.deepEqual((await request(client, '/api/company/workflow-template')).template, template);
  assert.deepEqual((await request(client, '/api/workflow-packs/export')).recipes, saved.recipes);
  passed('Both service restarts retain identities, pinned host connection, shared template and private imported plans');
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  for (const context of children) {
    try { await stop(context); } catch (error) { failure = `${failure || ''}\nCleanup: ${error.message}`; }
  }
  cleanupComplete = children.size === 0;
  if (cleanupComplete) await rm(scratch, { recursive: true, force: true });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ passed: !failure && checks.length === 8 && cleanupComplete, platform: process.platform, arch: process.arch,
    osRelease: release(), node: process.version, simulatedOS: false, twoPhysicalDevices: false, liveWorkflows: false,
    checks, failure, cleanupComplete, ...(!cleanupComplete ? { preservedData: scratch } : {}) }, null, 2) + '\n');
  console.log(`${failure ? 'FAILED' : 'PASSED'} two-profile compiled lab: ${output}`);
  if (failure) console.error(failure);
  process.exitCode = failure || checks.length !== 8 || !cleanupComplete ? 1 : 0;
}
