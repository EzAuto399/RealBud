// Run the compiled server outside the checkout so development node_modules
// cannot hide a missing packaged dependency. No native driver or model runs.
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serviceSmokeEnv } from './service-smoke-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// /var is a macOS alias. A fresh fixture must use real ancestry, like the app.
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'RealBud package proof ')));
const out = resolve(process.argv[2] || join(root, 'outputs/company-bundle-proof.json'));
// An explicit source checks the installed artifact, not the checkout's build.
const source = resolve(process.argv[3] || join(root, 'dist-server'));
// electron-builder combines these inputs; an explicit artifact has no fallback.
const packSource = process.argv[3] ? join(source, 'pack', 'property') : join(root, 'pack', 'property');
let child, exited, timer, failure, stderr = '', cleanupComplete = false, timedOut = false;
let profileProof, startupMs, profileCheckMs;
const checks = [];
const execute = promisify(execFile);
const requiredProfileFiles = ['SOUL.md', 'config.yaml', 'distribution.yaml', 'profile.yaml'];

// Independent read-only ACL witness, not the production verifier or a repair.
// No descriptor, SID, or path is returned by PowerShell.
const ACL_WITNESS = Buffer.from(`
$ErrorActionPreference = 'Stop'
try {
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
  $items = @($env:REALBUD_SMOKE_PRIVATE_PATHS | ConvertFrom-Json)
  if ($items.Count -lt 1 -or $items.Count -gt 256) { exit 1 }
  foreach ($item in $items) {
    $cursor = $item.path
    while (-not [string]::IsNullOrEmpty($cursor)) {
      if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
      $next = [IO.Path]::GetDirectoryName($cursor)
      if ($next -eq $cursor) { break }; $cursor = $next
    }
    $acl = Get-Acl -LiteralPath $item.path
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current) { exit 1 }
    $usable = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Deny' -or $allowed -notcontains $rule.IdentityReference.Value) { exit 1 }
      if ($rule.IdentityReference.Value -eq $current -and
          ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $usable = $true }
    }
    if (-not $usable) { exit 1 }
  }
  [Console]::Out.Write('private')
} catch { exit 1 }
`, 'utf16le').toString('base64');

async function assertMissing(path) {
  await assert.rejects(lstat(path), error => error?.code === 'ENOENT', 'Fresh fixture contains unexpected profile state');
}
async function inspectProfile(home, pack, status, env) {
  const profile = join(home, 'profiles', 'property');
  assert.deepEqual(status.pack, { installed: true, approvalsManual: true, workroomReady: true }, 'Fresh private profile is not usable');
  assert.equal(status.homeDir, home, 'Service used another Hermes home');
  assert.equal(status.profileDir, profile, 'Service used another profile');
  assert.equal(status.model?.attached, false, 'Fresh fixture unexpectedly has a model login');
  assert.equal(status.ready, false, 'An unconfigured worker must remain held');
  const objects = [home, join(home, 'profiles'), profile].map(path => ({ path, directory: true }));
  const files = [join(home, 'auth.json'), ...requiredProfileFiles.map(name => join(profile, name))];
  const copies = ['SOUL.md', 'distribution.yaml', 'profile.yaml'].map(name => ({ from: join(pack, name), to: join(profile, name) }));
  await assertMissing(join(profile, '.env'));
  async function skills(from, to, depth = 0) {
    assert.ok(depth <= 12 && objects.length + files.length <= 256, 'Shipped skill inventory exceeds smoke bound');
    objects.push({ path: to, directory: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Shipped skill contains an alias');
      if (entry.isDirectory()) await skills(join(from, entry.name), join(to, entry.name), depth + 1);
      else {
        assert.ok(entry.isFile(), 'Shipped skill is not a regular file');
        const path = join(to, entry.name); files.push(path);
        copies.push({ from: join(from, entry.name), to: path });
      }
    }
  }
  await skills(join(pack, 'skills'), join(profile, 'skills'));
  assert.ok(objects.length + files.length <= 256, 'Shipped skill inventory exceeds smoke bound');
  objects.push(...files.map(path => ({ path, directory: false })));
  const before = [];
  for (const item of objects) {
    const stat = await lstat(item.path, { bigint: true });
    assert.ok(!stat.isSymbolicLink() && (item.directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n), 'Profile contains an alias or unexpected object');
    if (process.platform !== 'win32') {
      assert.equal(stat.mode & 0o077n, 0n, 'Profile is not private');
      assert.equal(stat.uid, BigInt(process.getuid()), 'Profile has an unexpected owner');
    }
    before.push(stat);
  }
  if (process.platform === 'win32') {
    assert.ok(env.SystemRoot && isAbsolute(env.SystemRoot) && !env.SystemRoot.includes('\0'), 'Windows ACL witness unavailable');
    let witness;
    try {
      witness = await execute(join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', ACL_WITNESS], {
        env: { ...env, REALBUD_SMOKE_PRIVATE_PATHS: JSON.stringify(objects) }, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 4096,
      });
    } catch { throw new Error('Fresh profile Windows privacy verification failed'); }
    assert.equal(witness.stdout, 'private', 'Windows ACL witness did not confirm privacy');
  }
  for (const { from, to } of copies) assert.deepEqual(await readFile(to), await readFile(from), 'Shipped safeguard or skill bytes were not provisioned');
  const config = await readFile(join(profile, 'config.yaml'), 'utf8');
  assert.match(config, /^approvals:\s*\n\s+mode:\s*manual\s*$/m);
  assert.match(config, /^\s+home_mode:\s*profile\s*$/m);
  assert.match(config, /^\s+write_approval:\s*true\s*$/m);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')), { version: 1, providers: {}, credential_pool: {} });
  for (let index = 0; index < objects.length; index++) {
    const after = await lstat(objects[index].path, { bigint: true }), prior = before[index];
    assert.deepEqual([after.dev, after.ino, after.mode, after.size, after.mtimeNs, after.ctimeNs, after.nlink], [prior.dev, prior.ino, prior.mode, prior.size, prior.mtimeNs, prior.ctimeNs, prior.nlink], 'Profile changed during read-only privacy inspection');
  }
  return { freshHome: true, installed: true, approvalsManual: true, workroomReady: true, modelAttached: false, workerReady: false,
    privacy: process.platform === 'win32' ? 'independent protected Windows DACL witness' : 'POSIX owner and private mode', files: files.length, directories: objects.length - files.length };
}
try {
  const resources = join(scratch, 'resources');
  for (const directory of ['server', 'shared', 'src']) {
    await cp(join(source, directory), join(resources, directory), { recursive: true });
  }
  await cp(packSource, join(resources, 'pack', 'property'), { recursive: true });
  for (const name of requiredProfileFiles) assert.ok((await lstat(join(resources, 'pack', 'property', name))).isFile(), `Missing shipped ${name}`);
  await writeFile(join(resources, 'package.json'), '{"type":"module"}\n');
  const home = join(scratch, 'home'); const data = join(home, '.realbud');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  // Check certificate generation too: importing selfsigned alone misses its
  // ASN.1 initialization and crypto path.
  const entry = join(resources, 'proof.mjs');
  await writeFile(entry, `import { createHostCertificate } from './server/company/host-certificate.js';\nawait createHostCertificate('127.0.0.1');\nawait import('./server/bootstrap.js');\n`);
  const env = serviceSmokeEnv({ executable: process.execPath, home, data, scratch, port });
  await assertMissing(env.REALBUD_HERMES_HOME);
  const started = performance.now();
  child = spawn(process.execPath, [entry], { cwd: scratch, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16_000); });
  timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 25_000);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode) throw new Error('Compiled service exited before readiness');
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })
      .then(r => r.ok ? r.json() : null).catch(() => null);
    if (health?.app === 'realbud' && health.pid === child.pid) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Compiled service readiness'); checks.push('Compiled server starts outside checkout without node_modules');
  startupMs = Math.round(performance.now() - started);
  const session = await fetch(base + '/api/session').then(r => r.json());
  const response = await fetch(base + '/api/company/status', { headers: { 'x-realbud-session': session.token } });
  assert.equal(response.status, 200); assert.equal((await response.json()).storageAvailable, false);
  checks.push('Packaged PostgreSQL driver loads; unprovisioned company status is usable');
  checks.push('Packaged TLS certificate generator executes successfully');
  const checked = performance.now();
  const hermesResponse = await fetch(base + '/api/hermes', { headers: { 'x-realbud-session': session.token }, signal: AbortSignal.timeout(10_000) });
  assert.equal(hermesResponse.status, 200, 'Private profile status is unavailable');
  profileProof = await inspectProfile(env.REALBUD_HERMES_HOME, join(resources, 'pack', 'property'), await hermesResponse.json(), env);
  profileCheckMs = Math.round(performance.now() - checked);
  assert.equal(timedOut, false, 'Compiled service probe exceeded its 25-second watchdog');
  assert.equal(child.exitCode, null, 'Compiled service stopped before profile proof completed');
  assert.equal(child.signalCode, null, 'Compiled service was terminated before profile proof completed');
  checks.push('Fresh private Hermes profile has shipped safeguards and skills, private storage, and no model credentials');
} catch (error) { failure = error instanceof Error ? error.message : 'Package probe failed'; }
finally {
  if (child && child.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM'); const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited.catch(() => {}); clearTimeout(forced);
  }
  clearTimeout(timer);
  await rm(scratch, { recursive: true, force: true }); cleanupComplete = true;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ passed: !failure, platform: process.platform, arch: process.arch, node: process.version,
    source, packSource, runtime: process.versions.electron ? 'installed Electron/Node' : 'Node',
    proofLayer: 'Compiled service and fresh private profile from the selected inputs; not Hermes runtime installation, model access, GUI or two-device acceptance',
    timings: { startupMs, profileCheckMs, watchdogMs: 25_000, readinessAttempts: 150, perHealthRequestMs: 500 }, profileProof,
    checks, failure, cleanupComplete, ...(failure ? { diagnostic: stderr } : {}) }, null, 2) + '\n');
  console.log(`${failure ? 'FAILED' : 'PASSED'} compiled company bundle: ${out}`);
  process.exitCode = failure ? 1 : 0;
}
