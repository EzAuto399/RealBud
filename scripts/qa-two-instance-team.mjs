#!/usr/bin/env node
// Two real compiled services, existing PostgreSQL 16, fictional users only.
// Reuses the mature test-kit launcher; never builds, installs, or calls a model.
// Usage (Node 24): --resources PATH --postgres-bin PATH --resource-proof FILE --output NEW_DIR
// Opt in with --runtime packaged-electron when invoking the selected Mac app
// executable with ELECTRON_RUN_AS_NODE=1. The default is standalone-node.
// resource-proof is an independently prepared archive/resource SHA256 inventory;
// its source attribution remains separate from this script's current Git HEAD.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { release, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]; const value = process.argv[index + 1];
  if (!['--resources', '--postgres-bin', '--resource-proof', '--output', '--runtime'].includes(key) || !value || value.startsWith('--') || options[key] !== undefined) {
    throw new Error('Provide each required path once: --resources --postgres-bin --resource-proof --output; optional --runtime standalone-node|packaged-electron.');
  }
  options[key] = key === '--runtime' ? value : resolve(value);
}
for (const key of ['--resources', '--postgres-bin', '--resource-proof', '--output']) {
  if (!options[key]) throw new Error(`Missing ${key}.`);
}
const runtimeMode = options['--runtime'] ?? 'standalone-node';
if (!['standalone-node', 'packaged-electron'].includes(runtimeMode)) throw new Error('Unknown rehearsal runtime.');
const packagedElectron = runtimeMode === 'packaged-electron';
if (process.versions.node.split('.')[0] !== '24') throw new Error('This compiled-service rehearsal requires Node 24.');
if (packagedElectron) {
  if (!process.versions.electron || process.platform !== 'darwin' || process.arch !== 'arm64' || process.env.ELECTRON_RUN_AS_NODE !== '1') {
    throw new Error('Packaged mode requires the selected macOS arm64 Electron executable with ELECTRON_RUN_AS_NODE=1.');
  }
} else if (process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== undefined) {
  throw new Error('Electron requires explicit --runtime packaged-electron; standalone mode must not set ELECTRON_RUN_AS_NODE.');
}
if (process.platform === 'win32') throw new Error('This launcher supervisor currently verifies POSIX process-group cleanup; native Windows two-instance proof is separate.');
const resources = await realpath(options['--resources']);
const pgBin = await realpath(options['--postgres-bin']);
const executable = await realpath(process.execPath);
if (packagedElectron && executable !== await realpath(join(resources, '..', 'MacOS', 'RealBud'))) {
  throw new Error('The Electron executable must belong to the selected app Resources.');
}
const output = options['--output'];
const launcher = join(root, 'scripts/start-test-lab.mjs');
const script = fileURLToPath(import.meta.url);
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    check(!entry.isSymbolicLink(), 'Resource proof refuses symlinks.');
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), name + '/'));
    else { check(entry.isFile(), 'Resource proof requires ordinary files.'); files.push(name); }
  }
  return files.sort();
}
// Verify current inputs against the separately recorded package archive proof.
const proofBytes = await readFile(options['--resource-proof']);
const proof = JSON.parse(proofBytes);
check(proof.schema === 1 && /^[a-f0-9]{40}$/.test(proof.sourceRevision) && await realpath(proof.resources) === resources,
  'Resource proof must identify these compiled resources and an exact source revision.');
check(JSON.stringify(proof.trees) === JSON.stringify(['server', 'shared', 'pack']), 'Resource proof must cover server, shared, and pack trees.');
for (const item of [proof.packageReceipt, proof.buildInputs, proof.archive]) {
  check(item && isAbsolute(item.path) && /^[a-f0-9]{64}$/.test(item.sha256) && await hash(item.path) === item.sha256,
    'Resource provenance input hash does not match.');
}
const packageReceipt = JSON.parse(await readFile(proof.packageReceipt.path, 'utf8'));
const buildInputs = JSON.parse(await readFile(proof.buildInputs.path, 'utf8'));
check(packageReceipt.sourceRevision === proof.sourceRevision && buildInputs.sourceRevision === proof.sourceRevision && packageReceipt.packageExitCode === 0,
  'Package receipt and source input snapshot must agree.');
check(packageReceipt.artifacts.some(item => item.path === proof.archive.path && item.sha256 === proof.archive.sha256 && item.size === proof.archive.bytes),
  'Package receipt must bind the verified archive.');
const resourceNames = (await Promise.all(proof.trees.map(tree => inventory(join(resources, tree), tree + '/')))).flat().sort();
check(Array.isArray(proof.files) && JSON.stringify(proof.files.map(item => item.path)) === JSON.stringify(resourceNames),
  'Resource proof inventory differs from the current compiled trees.');
for (const item of proof.files) {
  check(/^[a-f0-9]{64}$/.test(item.sha256) && (await lstat(join(resources, item.path))).size === item.bytes && await hash(join(resources, item.path)) === item.sha256,
    'A compiled resource differs from the archive comparison.');
}
for (const name of ['postgres', 'initdb', 'pg_ctl']) await access(join(pgBin, name));
const postgres = execFileSync(join(pgBin, 'postgres'), ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
check(/PostgreSQL\) 16\./.test(postgres), 'Installed PostgreSQL 16 is required.');
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 }).trim();
const runtime = { mode: runtimeMode, node: process.versions.node, electron: process.versions.electron ?? null,
  executable, executableSha256: await hash(executable) };
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { mode: 0o700 }); // Deliberately refuses an existing receipt directory.
await writeFile(join(output, 'resource-proof.json'), proofBytes, { flag: 'wx', mode: 0o600 });
const scratch = await mkdtemp(join(await realpath(tmpdir()), 'rb-team-'));
const checks = []; const requests = []; const processes = []; const children = new Set();
const abort = new AbortController(); const startedAt = new Date().toISOString();
const timer = setTimeout(() => abort.abort(), 240_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
let stage = 'startup', failure = null, cleanupComplete = false, tlsPort;
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
function passed(name) { check(!abort.signal.aborted, 'Rehearsal interrupted.'); checks.push(name); console.log(`PASS ${name}`); }
async function bounded(promise, ms, label, signal) {
  let deadline, onAbort;
  try {
    return await Promise.race([promise,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(label)), ms); }),
      ...(signal ? [new Promise((_, reject) => {
        onAbort = () => reject(new Error('Rehearsal interrupted.'));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      })] : []),
    ]);
  } finally { clearTimeout(deadline); if (onAbort) signal.removeEventListener('abort', onAbort); }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function portClosed(port) {
  return new Promise(resolveClosed => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolveClosed(value); };
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function request(context, path, body, expected = 200, method = body === undefined ? 'GET' : 'POST', headers = {}, timeout = 20_000) {
  const response = await fetch(context.url + path, { method, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]),
    headers: { ...(context.appToken ? { 'x-realbud-session': context.appToken } : {}),
      ...(context.adminToken ? { 'x-realbud-service-admin': context.adminToken } : {}),
      ...(context.memberToken ? { 'x-realbud-member-session': context.memberToken } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  requests.push({ role: context.role, method, path, status: response.status, expected });
  check((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${context.role} ${method} ${path} returned an unexpected HTTP status.`);
  return result;
}
async function capturePostgres(context) {
  if (context.role !== 'host') return;
  const data = join(scratch, 'host/home/.realbud/company-installation/postgres/data');
  let lines;
  try { lines = (await readFile(join(data, 'postmaster.pid'), 'utf8')).split(/\r?\n/); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const pid = Number(lines[0]); const port = Number(lines[3]);
  check(Number.isSafeInteger(pid) && pid > 0 && resolve(lines[1]) === data && Number.isInteger(port) && port > 0 && port <= 65535,
    'Owned PostgreSQL marker does not match the disposable profile.');
  context.postgresPid = pid; context.ports.add(port);
}
async function start(role) {
  stage = `start-${role}`;
  const env = { PATH: dirname(process.execPath), HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    REALBUD_TEST_RESOURCES: resources, REALBUD_TEST_POSTGRES_BIN: pgBin, REALBUD_TEST_LAB_ROOT: scratch, LANG: 'C', LC_ALL: 'C',
    ...(packagedElectron ? { REALBUD_TEST_RUNTIME: 'packaged-electron', ELECTRON_RUN_AS_NODE: '1' } : {}) };
  const child = spawn(process.execPath, [launcher, role], { env, cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const context = { role, child, startedAt: Date.now(), ports: new Set(), appToken: '', memberToken: '', adminToken: '' };
  children.add(context); child.stderr.resume(); // Never copy service logs or credential-bearing responses into evidence.
  context.exit = new Promise(resolveExit => {
    child.once('error', () => resolveExit({ code: null, signal: null, spawnFailed: true }));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const ready = new Promise(resolveReady => child.on('message', message => {
    if (message?.type === 'realbud-test-ready' && message.role === role) resolveReady(message.url);
  }));
  context.url = await bounded(Promise.race([ready, context.exit.then(() => { throw new Error('Owned launcher ended before readiness.'); })]),
    30_000, 'Owned launcher readiness timed out.', abort.signal);
  const url = new URL(context.url);
  check(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'Launcher must advertise a loopback application URL.');
  context.ports.add(Number(url.port));
  if (role === 'host' && tlsPort) context.ports.add(tlsPort);
  const health = await request(context, '/api/health');
  check(health.app === 'realbud' && Number.isSafeInteger(health.pid) && health.pid > 0 && health.pid !== child.pid, 'A distinct RealBud service must report readiness.');
  context.serverPid = health.pid;
  context.appToken = (await request(context, '/api/session')).token;
  check(typeof context.appToken === 'string' && context.appToken.length > 20, 'Local application session must exist.');
  await capturePostgres(context);
  return context;
}
async function stop(context) {
  if (!children.has(context)) return;
  // Damaged metadata is a failed proof, not a reason to skip stopping the
  // launcher and its owned group. Keep this context/fixture held afterward.
  let markerValid = true;
  try { await capturePostgres(context); } catch { markerValid = false; }
  let orderly = false; let forced = false;
  try {
    if (context.child.exitCode === null && !context.child.signalCode && context.child.connected) {
      context.child.send({ type: 'realbud-test-stop' }, () => {});
    }
    const result = await bounded(context.exit, 32_000, 'Owned launcher shutdown timed out.');
    const stopped = JSON.parse(await readFile(join(scratch, context.role, 'stopped.json'), 'utf8'));
    orderly = result.code === 0 && result.signal === null && stopped.dataPreserved === true && Date.parse(stopped.stoppedAt) >= context.startedAt;
  } catch { /* The fallback only addresses this launcher's own POSIX process group. */ }
  if (alive(-context.child.pid)) {
    forced = true;
    try { process.kill(-context.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let attempt = 0; attempt < 30 && alive(-context.child.pid); attempt++) await wait(100);
    if (alive(-context.child.pid)) {
      try { process.kill(-context.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      for (let attempt = 0; attempt < 30 && alive(-context.child.pid); attempt++) await wait(100);
    }
  }
  const pidsGone = !alive(-context.child.pid) && !alive(context.serverPid) && !alive(context.postgresPid);
  const portsClosed = (await Promise.all([...context.ports].map(portClosed))).every(Boolean);
  processes.push({ role: context.role, launcherPid: context.child.pid, serverPid: context.serverPid, postgresPid: context.postgresPid ?? null,
    markerValid, orderly, forced, processGroupEmpty: !alive(-context.child.pid), pidsGone, portsClosed, ports: [...context.ports] });
  if (markerValid && pidsGone && portsClosed) children.delete(context);
  check(markerValid && orderly && !forced && pidsGone && portsClosed, 'Owned service cleanup was not fully confirmed; inspect the preserved fixture.');
}

const ownerCredential = { loginName: 'fictional.owner', password: 'Fictional-Owner-Password-2026' };
const memberCredential = { loginName: 'fictional.member', password: 'Fictional-Member-Password-2026' };
const changedCredential = { ...memberCredential, password: 'Fictional-Changed-Password-2026' };
const privateKey = 'fictional-private-note';
try {
  let host = await start('host'); let client = await start('client');
  stage = 'independent-authority';
  check(host.url !== client.url && host.serverPid !== client.serverPid && host.appToken !== client.appToken, 'Two services must have independent process and app authority.');
  await request(client, '/api/config', undefined, 401, 'GET', { 'x-realbud-session': host.appToken });
  await request(host, '/api/config', { profile: { name: 'fictional-owner-local' } }, 200, 'PATCH');
  await request(client, '/api/config', { profile: { name: 'fictional-member-local' } }, 200, 'PATCH');
  passed('Two real services have separate homes, PIDs, app tokens, and local preferences');

  stage = 'owner-provisioning';
  await request(host, '/api/company/setup', {}, 401);
  host.adminToken = (await request(host, '/api/service-admin/login', { password: 'RealBud-Synthetic-Lab-2026' })).token;
  await request(host, '/api/company/setup', {}, 200, 'POST', {}, 90_000);
  await capturePostgres(host); check(host.postgresPid, 'Provisioning must start an owned PostgreSQL process.');
  const owner = await request(host, '/api/company/create', { name: 'Fictional Two-Instance Office', ownerName: 'Fictional Owner', credential: ownerCredential }, 201);
  host.memberToken = owner.memberToken;
  check(owner.member.role === 'owner', 'Owner enrollment must return the owner role.');
  await request(host, '/api/company/network', { hostname: '127.0.0.1' });
  const { hostCode } = await request(host, '/api/company/host-code');
  const origin = new URL(JSON.parse(Buffer.from(hostCode.slice(4), 'base64url').toString('utf8')).origin);
  check(origin.protocol === 'https:' && origin.hostname === '127.0.0.1', 'The fixture must use a loopback TLS target.');
  tlsPort = Number(origin.port); host.ports.add(tlsPort);
  passed('Service admin provisions native PostgreSQL; separate owner authority enables pinned TLS joining');

  stage = 'invitation-and-joining';
  await request(client, '/api/company/connect-host', { hostCode: 'fictional-invalid-host-code' }, 400);
  await request(client, '/api/company/connect-host', { hostCode });
  await request(client, '/api/company/connect-host', { hostCode });
  const cancelledInvite = await request(host, '/api/company/invitations', { displayName: 'Fictional Cancelled Member' }, 201);
  await request(host, '/api/company/invitations/revoke', { invitationId: cancelledInvite.invitationId });
  await request(client, '/api/company/join', { invitationToken: cancelledInvite.invitationToken, credential: memberCredential }, 401);
  const invitation = await request(host, '/api/company/invitations', { displayName: 'Fictional Member' }, 201);
  const member = await request(client, '/api/company/join', { invitationToken: invitation.invitationToken, credential: memberCredential }, 201);
  client.memberToken = member.memberToken;
  check(member.company.id === owner.company.id && member.member.id !== owner.member.id && member.member.role === 'member', 'Joined member must have the same office and a distinct member identity.');
  check((await request(client, '/api/company/status')).transport === 'encrypted-company', 'Companion must use encrypted company transport.');
  const replay = await request(client, '/api/company/join', { invitationToken: invitation.invitationToken, credential: memberCredential }, 409);
  check(replay.code === 'seat_identity_conflict', 'A bound workspace must refuse a second enrollment.');
  passed('Pinned TLS join rejects a revoked invite; owner-issued enrollment is atomic and the bound seat refuses replay');

  stage = 'member-authority';
  await request(client, '/api/company/invitations', { displayName: 'Fictional Forbidden Invite' }, 403);
  await request(client, '/api/company/members/revoke', { memberId: owner.member.id }, 403);
  await request(client, '/api/company/sign-in', ownerCredential, 409);
  check((await request(client, '/api/company/me')).member.id === member.member.id, 'Wrong-person sign-in must preserve the original seat.');
  check((await request(client, '/api/company/membership/management', {})).members.length === 0, 'Ordinary members must not receive the owner management roster.');
  passed('Member cannot administer membership or replace the workspace identity by signing in as its owner');

  stage = 'private-and-shared-data';
  const ownerScopes = (await request(host, '/api/company/scopes')).scopes;
  const memberScopes = (await request(client, '/api/company/scopes')).scopes;
  const ownerPrivate = ownerScopes.find(scope => scope.kind === 'private');
  const memberPrivate = memberScopes.find(scope => scope.kind === 'private');
  let shared = ownerScopes.find(scope => scope.kind === 'company');
  check(ownerPrivate && memberPrivate && shared && ownerPrivate.id !== memberPrivate.id, 'Each member must have a distinct private scope.');
  for (const [context, scope, content] of [[host, ownerPrivate, 'fictional-owner-canary'], [client, memberPrivate, 'fictional-member-canary']]) {
    await request(context, '/api/company/knowledge', { scopeId: scope.id, key: privateKey, expectedRevision: '0', content, sourceRefs: [] }, 200, 'PUT');
  }
  await request(client, '/api/company/knowledge/read', { scopeId: ownerPrivate.id, key: privateKey }, [403, 404]);
  await request(host, '/api/company/knowledge/read', { scopeId: memberPrivate.id, key: privateKey }, [403, 404]);
  passed('Private knowledge is inaccessible in both directions, including to the office owner');
  const sharedInput = { scopeId: shared.id, key: 'fictional-shared-guide', expectedRevision: '0', content: 'fictional-approved-guide', sourceRefs: [] };
  await request(host, '/api/company/knowledge', sharedInput, 200, 'PUT');
  check((await request(client, '/api/company/knowledge/read', { scopeId: shared.id, key: sharedInput.key })).knowledge.content === sharedInput.content, 'Members can read the shared office guide.');
  await request(client, '/api/company/knowledge', { ...sharedInput, expectedRevision: '1' }, 403, 'PUT');
  shared = await request(host, '/api/company/grants', { scopeId: shared.id, memberId: member.member.id, permissions: ['read', 'write'], expectedRevision: shared.revision }, 200, 'PUT');
  const update = { ...sharedInput, expectedRevision: '1', content: 'fictional-member-reviewed-guide' };
  await request(client, '/api/company/knowledge', update, 200, 'PUT');
  await request(host, '/api/company/knowledge', update, 409, 'PUT');
  passed('Shared knowledge respects read-only access, an explicit write grant, and stale-revision rejection');

  stage = 'ownership-approval';
  const cancelledOffer = await request(host, '/api/company/ownership/offer', { memberId: member.member.id });
  await request(client, '/api/company/ownership/cancel', { transferId: cancelledOffer.id });
  await request(client, '/api/company/ownership/accept', { transferId: cancelledOffer.id }, 409);
  const offer = await request(host, '/api/company/ownership/offer', { memberId: member.member.id });
  check((await request(host, '/api/company/me')).member.role === 'owner', 'Offering ownership must not transfer authority early.');
  check((await request(client, '/api/company/membership/management', {})).transfer.id === offer.id, 'Only the intended recipient sees this pending transfer.');
  await request(host, '/api/company/ownership/accept', { transferId: offer.id }, 409);
  await request(client, '/api/company/ownership/accept', { transferId: offer.id });
  await request(client, '/api/company/ownership/accept', { transferId: offer.id });
  check((await request(client, '/api/company/me')).member.role === 'owner' && (await request(host, '/api/company/me')).member.role === 'member', 'Recipient approval must atomically change both roles.');
  await request(host, '/api/company/invitations', { displayName: 'Fictional Former Owner Invite' }, 403);
  await request(client, '/api/company/knowledge/read', { scopeId: ownerPrivate.id, key: privateKey }, [403, 404]);
  passed('Ownership requires recipient acceptance; cancellation, wrong-recipient approval and repeat acceptance are safe');
  const returnOffer = await request(client, '/api/company/ownership/offer', { memberId: owner.member.id });
  await request(host, '/api/company/ownership/accept', { transferId: returnOffer.id });
  check((await request(host, '/api/company/me')).member.role === 'owner' && (await request(client, '/api/company/me')).member.role === 'member', 'Ownership can be deliberately transferred back.');
  passed('A second approved ownership transfer restores the original roles without moving private knowledge');

  stage = 'host-outage';
  const before = (await request(client, '/api/company/knowledge/read', { scopeId: shared.id, key: sharedInput.key })).knowledge;
  await stop(host);
  await request(client, '/api/company/status', undefined, 503);
  await request(client, '/api/company/knowledge', { ...sharedInput, expectedRevision: before.revision, content: 'fictional-offline-attempt-must-not-appear' }, 503, 'PUT');
  check((await request(client, '/api/config')).profile.name === 'fictional-member-local', 'Local preferences remain accessible while the office is offline.');
  passed('Host shutdown gives explicit unavailable results while the other process retains local work');
  host = await start('host');
  stage = 'host-reconnect';
  host.memberToken = (await request(host, '/api/company/sign-in', ownerCredential)).memberToken;
  const signed = await request(client, '/api/company/sign-in', memberCredential); client.memberToken = signed.memberToken;
  check(signed.member.id === member.member.id && signed.company.id === owner.company.id, 'Reconnect must preserve member and office identity.');
  check((await request(client, '/api/company/status')).transport === 'encrypted-company', 'The saved pinned TLS connection must survive restart.');
  check(JSON.stringify((await request(client, '/api/company/knowledge/read', { scopeId: shared.id, key: sharedInput.key })).knowledge) === JSON.stringify(before), 'Unavailable write must not replay after host reconnect.');
  check((await request(host, '/api/service-admin/status')).authenticated === false, 'Restart must not inherit the prior service-admin session.');
  passed('Host restart reconnects the same identities and pinned office without replaying the failed offline write');

  stage = 'credential-recovery';
  const oldSession = client.memberToken;
  const recovery = await request(client, '/api/company/recover-member', { loginName: memberCredential.loginName, recoveryKey: member.recoveryKey, newPassword: changedCredential.password });
  client.memberToken = recovery.memberToken;
  check(recovery.member.id === member.member.id && recovery.company.id === owner.company.id && recovery.recoveryKey !== member.recoveryKey, 'Recovery must retain identity and rotate the recovery key.');
  await request(client, '/api/company/me', undefined, 401, 'GET', { 'x-realbud-member-session': oldSession });
  await request(client, '/api/company/sign-in', memberCredential, 401);
  await request(client, '/api/company/recover-member', { loginName: memberCredential.loginName, recoveryKey: member.recoveryKey, newPassword: changedCredential.password }, 401);
  const secondSession = (await request(client, '/api/company/sign-in', changedCredential)).memberToken;
  check((await request(client, '/api/company/knowledge/read', { scopeId: memberPrivate.id, key: privateKey })).knowledge.content === 'fictional-member-canary', 'Credential recovery must preserve private knowledge.');
  passed('Member recovery rotates credentials, retires old authority, and preserves the original private scope');

  stage = 'active-member-revocation';
  const work = await request(host, '/api/company/cases', { scopeId: shared.id, title: 'Fictional interrupted review' }, 201);
  const claim = await request(client, '/api/company/cases/claim', { caseId: work.caseId, ttlMs: 30_000 });
  await request(host, '/api/company/members/revoke', { memberId: member.member.id });
  for (const token of [recovery.memberToken, secondSession]) await request(client, '/api/company/me', undefined, 401, 'GET', { 'x-realbud-member-session': token });
  await request(client, '/api/company/cases/renew', { caseId: work.caseId, fence: claim.fence, claimToken: claim.claimToken, ttlMs: 30_000 }, 401);
  const held = await request(host, '/api/company/cases/claim', { caseId: work.caseId, ttlMs: 30_000 }, 409);
  check(held.code === 'recovery_required', 'Revocation must hold unfinished work rather than allow duplicate execution.');
  await request(client, '/api/company/sign-in', changedCredential, 401);
  await request(client, '/api/company/recover-member', { loginName: memberCredential.loginName, recoveryKey: recovery.recoveryKey, newPassword: changedCredential.password }, 401);
  passed('Revocation retires every warm member session and credential path; unfinished work remains held');

  stage = 'both-process-restart';
  await stop(client); await stop(host);
  host = await start('host'); client = await start('client');
  const ownerAgain = await request(host, '/api/company/sign-in', ownerCredential); host.memberToken = ownerAgain.memberToken;
  check(ownerAgain.member.id === owner.member.id && ownerAgain.company.id === owner.company.id && ownerAgain.member.role === 'owner', 'Both restarts must preserve the owner and company.');
  client.memberToken = secondSession;
  await request(client, '/api/company/me', undefined, 401);
  await request(client, '/api/company/sign-in', changedCredential, 401);
  check((await request(host, '/api/company/membership/management', {})).members.some(row => row.id === member.member.id && row.active === false), 'Revoked membership must remain inactive after restart.');
  check((await request(host, '/api/company/cases/claim', { caseId: work.caseId, ttlMs: 30_000 }, 409)).code === 'recovery_required', 'The interrupted claim must remain held after restart.');
  check((await request(client, '/api/config')).profile.name === 'fictional-member-local' && (await request(host, '/api/config')).profile.name === 'fictional-owner-local', 'Both private local preferences must survive restarts and offboarding.');
  passed('Both service restarts preserve ownership, local preferences, persistent revocation, and the interrupted-work hold');
} catch (error) {
  // Record the assertion location, never arbitrary service output or token values.
  failure = { stage, reason: error instanceof Error && !error.code && error.name === 'Error' ? error.message : (error?.code || error?.name || 'unknown') };
} finally {
  clearTimeout(timer);
  const cleanupErrors = [];
  for (const context of [...children].reverse()) {
    try { await stop(context); } catch { cleanupErrors.push(`${context.role} orderly cleanup not confirmed`); }
  }
  cleanupComplete = children.size === 0;
  if (cleanupComplete && cleanupErrors.length === 0) {
    await rm(scratch, { recursive: true, force: true });
    checks.push('Every owned launcher, service, PostgreSQL process and listener stopped before temporary profiles were removed');
  }
  const passedRun = !failure && cleanupErrors.length === 0 && cleanupComplete && checks.length === 14;
  const receipt = { schema: 1, passed: passedRun, startedAt, completedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, osRelease: release(), node: process.version, postgres, runtime,
    sources: { harnessHead: sourceHead, harnessSha256: await hash(script), launcherSha256: await hash(launcher),
      resources, resourcesSourceRevision: proof.sourceRevision, resourceFilesVerified: proof.files.length,
      resourceProof: 'resource-proof.json', resourceProofSha256: createHash('sha256').update(proofBytes).digest('hex'),
      sourceAttribution: proof.sourceAttribution },
    proofLayer: packagedElectron
      ? 'Two independent compiled RealBud HTTP services under the selected packaged Electron-as-Node executable, actual pinned TLS and native PostgreSQL on this host'
      : 'Two independent compiled RealBud HTTP services under standalone Node 24, actual pinned TLS and native PostgreSQL on this host',
    twoPhysicalDevices: false, installedElectronRuntime: false, packagedElectronAsNode: packagedElectron,
    installedApplicationLifecycle: false, renderedUI: false, liveAccounts: false, simulatedOS: false,
    limits: [
      'This is one machine with two isolated private profiles, not physical two-device or cross-platform acceptance.',
      packagedElectron
        ? 'The packaged executable runs in Electron-as-Node mode; this does not verify app installation, GUI windows, or the normal Electron application lifecycle.'
        : 'The existing launcher uses standalone Node 24; this run does not verify the packaged Electron executable or rendered UI.',
      'The company TLS listener binds 0.0.0.0 on an ephemeral port; every test request targets loopback and cleanup checks that listener closes.',
      'Owner invitation issuance authorizes local enrollment; ownership transfer separately requires recipient acceptance. No live website, identity provider, or customer account is used.',
      'Invitation expiry, multi-office isolation, crash/lost-response recovery, and concurrent database races remain separate integration and physical-device cases.',
    ], checks, requests, processes, failure, cleanupErrors, cleanupComplete,
    ...(!cleanupComplete || cleanupErrors.length ? { preservedFixture: scratch } : {}) };
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`${passedRun ? 'PASSED' : 'FAILED'} two-instance team rehearsal: ${relative(root, join(output, 'receipt.json'))}`);
  process.exitCode = passedRun ? 0 : 1;
}
