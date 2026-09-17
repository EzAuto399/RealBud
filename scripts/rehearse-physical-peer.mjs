// Synthetic two-physical-Mac acceptance. Execute on the peer with bundled Node.
// Transfers only sanitized receipts to the explicitly named existing Taildrop peer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const phase = process.argv[2] || 'join';
assert.ok(['join', 'offline', 'resume'].includes(phase));
const home = homedir();
const bootstrapName = process.argv[3] || 'realbud-peer-bootstrap.json';
assert.match(bootstrapName, /^realbud-peer-bootstrap(?:-v\d+)?\.json$/);
const bootstrap = JSON.parse(await readFile(join(home, 'Downloads', bootstrapName), 'utf8'));
assert.equal(bootstrap.syntheticOnly, true);
// Account login names and home directory names need not match on macOS.
// The supplied Node executable is inside this transferable kit's runtime/.
const kit = dirname(dirname(process.execPath));
const manifest = JSON.parse(await readFile(join(kit, 'test-kit.json'), 'utf8'));
assert.equal(manifest.kind, 'RealBud synthetic two-profile test kit');
const atomicEnrollment = manifest.atomicCredentialEnrollment === true;
const testRun = bootstrap.testRun || 'physical-macs-2026-09-14';
assert.match(testRun, /^[a-z0-9-]{1,80}$/);
const base = join(home, '.realbud/test-lab', testRun);
const identityFile = join(base, 'peer-test-identity.json');
const checks = [];
let child, exited, url, appToken, memberToken, failure, cleanupComplete = false, diagnostics = '';
const deadline = AbortSignal.timeout(120_000);
function pass(label) { checks.push(label); console.log('PASS ' + label); }
async function call(path, body, expected = 200, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(url + path, { method, signal: AbortSignal.any([deadline, AbortSignal.timeout(20_000)]),
    headers: { ...(appToken ? { 'x-realbud-session': appToken } : {}), ...(memberToken ? { 'x-realbud-member-session': memberToken } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const bodyResult = await response.json();
  assert.equal(response.status, expected, `${path}: expected ${expected}, received ${response.status}`);
  return bodyResult;
}
async function start() {
  const env = { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'C', LC_ALL: 'C', REALBUD_TEST_LAB_ROOT: base };
  child = spawn(process.execPath, [join(kit, 'scripts/start-test-lab.mjs'), 'client'], { cwd: kit, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  void exited.catch(() => {});
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  let timer;
  try {
    url = await Promise.race([new Promise(resolve => child.on('message', event => { if (event?.type === 'realbud-test-ready') resolve(event.url); })),
      exited.then(() => { throw new Error('Peer launcher exited before ready'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Peer launcher readiness timed out')), 30_000); })]);
  } finally { clearTimeout(timer); }
  appToken = (await call('/api/session')).token;
}
async function stop() {
  if (!child) return;
  if (!child.pid) { child = undefined; return; }
  if (child.exitCode === null && !child.signalCode) {
    assert.ok(child.connected, 'Owned launcher control remains connected');
    child.send({ type: 'realbud-test-stop' });
  }
  let timer;
  try { const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Peer shutdown needs recovery')), 30_000); })]); assert.equal(code, 0, 'Clean peer service stop'); }
  finally { clearTimeout(timer); }
  child = undefined;
}
try {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await start(); pass('Bundled compiled client starts on the physical Mac mini');
  if (phase === 'offline') {
    const identity = JSON.parse(await readFile(identityFile, 'utf8'));
    memberToken = identity.sessionToken;
    await call('/api/company/workflow-template', undefined, 503);
    assert.equal((await call('/api/workflow-packs/export')).recipes.length, 3);
    pass('Host-offline company error is explicit while three local plans remain readable');
  } else {
    let identity;
    if (phase === 'join') {
      await call('/api/company/connect-host', { hostCode: bootstrap.hostCode });
      if (atomicEnrollment) {
        await call('/api/company/join', { invitationToken: bootstrap.invitationToken }, 400);
        await call('/api/company/join', { invitationToken: bootstrap.invitationToken, credential: { loginName: bootstrap.ownerLoginName, password: bootstrap.credentials.password } }, 409);
        pass('Missing credentials and duplicate username preserve the physical peer invitation');
      }
      const joinBody = { invitationToken: bootstrap.invitationToken, ...(atomicEnrollment ? { credential: bootstrap.credentials } : {}) };
      identity = await call('/api/company/join', joinBody, 201);
      memberToken = identity.memberToken;
      assert.equal(identity.company.id, bootstrap.companyId);
      const credentials = atomicEnrollment ? identity : await call('/api/company/credentials', bootstrap.credentials);
      assert.match(credentials.recoveryKey, /^[A-Za-z0-9_-]{43}$/);
      await writeFile(identityFile, JSON.stringify({ companyId: identity.company.id, memberId: identity.member.id, sessionToken: memberToken, recoveryKey: credentials.recoveryKey }), { flag: 'wx', mode: 0o600 });
      await call('/api/company/join', joinBody, 401);
      pass('Second physical Mac joins the correct pinned company and rejects invitation replay');
    } else {
      const prior = JSON.parse(await readFile(identityFile, 'utf8'));
      identity = await call('/api/company/sign-in', bootstrap.credentials);
      assert.equal(identity.company.id, prior.companyId); assert.equal(identity.member.id, prior.memberId);
      memberToken = identity.memberToken;
      pass('Same peer member signs in after complete host and client restart');
    }
    assert.equal((await call('/api/company/status')).transport, 'encrypted-company');
    await call('/api/company/knowledge/read', { scopeId: bootstrap.ownerPrivateScopeId, key: 'private' }, 404);
    pass('Owner private scope is denied from the second physical Mac');
    const saved = await call('/api/company/workflow-template');
    assert.equal(saved.revision, '1'); assert.deepEqual(saved.template, bootstrap.expectedTemplate);
    await call('/api/company/workflow-template', { companyId: identity.company.id, memberId: identity.member.id, expectedRevision: saved.revision, template: saved.template }, 403, 'PUT');
    for (let repeat = 0; repeat < 2; repeat++) await call('/api/workflow-packs/import', saved.template);
    const local = await call('/api/workflow-packs/export'); assert.equal(local.recipes.length, 3);
    for (const recipe of local.recipes) { assert.equal(recipe.status, 'shadow'); assert.equal(recipe.schedule, null); assert.ok(!recipe.approval); assert.ok(!recipe.attachment); }
    pass('Three shared plans import once, remain dormant and cannot be published by a member');
    const changed = structuredClone(saved.template); changed.recipes[2].title = 'Conflicting peer plan';
    await call('/api/workflow-packs/import', changed, 409);
    assert.deepEqual((await call('/api/workflow-packs/export')).recipes, local.recipes);
    pass('Conflicting import preserves all existing peer plans');
    await stop(); memberToken = undefined; appToken = undefined; await start();
    const restored = await call('/api/company/sign-in', bootstrap.credentials); memberToken = restored.memberToken;
    assert.equal(restored.member.id, identity.member.id);
    assert.deepEqual((await call('/api/workflow-packs/export')).recipes, local.recipes);
    assert.deepEqual((await call('/api/company/workflow-template')).template, saved.template);
    pass('Physical peer service restart preserves member identity, host pairing and local plans');
  }
} catch (error) { failure = error instanceof Error ? error.message : 'Peer rehearsal failed'; }
finally {
  try { await stop(); cleanupComplete = true; } catch (error) { failure = (failure || '') + '; ' + error.message; }
  const osVersion = await execute('/usr/bin/sw_vers', ['-productVersion']).then(result => result.stdout.trim(), () => 'unavailable');
  const archiveSha256 = createHash('sha256').update(await readFile(join(home, 'Downloads', basename(kit) + '.zip'))).digest('hex');
  const receipt = { phase, passed: !failure && cleanupComplete, checks, failure, cleanupComplete, platform: process.platform, arch: process.arch, macOS: osVersion, kernel: release(), node: process.version, archiveSha256,
    physicalPeer: true, atomicEnrollment, testRun, liveWorkflows: false, windowsVerified: false, retainedSyntheticProfile: true };
  const file = join(home, 'Downloads', `realbud-peer-${phase}-result-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  if (failure) await writeFile(join(base, 'last-failure.log'), diagnostics, { mode: 0o600 });
  console.log(`${receipt.passed ? 'PASSED' : 'FAILED'} physical peer ${phase}: ${file}`);
  // Receipt contains no session, recovery key, password or host connection code.
  if (typeof bootstrap.receiptTarget === 'string' && /^100\.\d+\.\d+\.\d+:$/.test(bootstrap.receiptTarget)) {
    for (const executable of ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
      if (await access(executable).then(() => true, () => false)) {
        try { await execute(executable, ['file', 'cp', '--update-interval=0', file, bootstrap.receiptTarget], { timeout: 20_000 }); console.log('Sanitized receipt transferred to the test host.'); }
        catch { console.log('Receipt transfer unavailable; the local receipt is preserved.'); }
        break;
      }
    }
  }
  process.exitCode = receipt.passed ? 0 : 1;
}
