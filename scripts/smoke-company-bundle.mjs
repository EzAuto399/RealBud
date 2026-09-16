// Run the compiled server outside the checkout so development node_modules
// cannot hide a missing packaged dependency. No native driver or model runs.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'RealBud package proof '));
const out = resolve(process.argv[2] || join(root, 'outputs/company-bundle-proof.json'));
let child, exited, timer, failure, stderr = '', cleanupComplete = false;
const checks = [];
try {
  const resources = join(scratch, 'resources');
  await cp(join(root, 'dist-server'), resources, { recursive: true });
  await writeFile(join(resources, 'package.json'), '{"type":"module"}\n');
  const home = join(scratch, 'home'); const data = join(home, '.realbud');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  // Check certificate generation too: importing selfsigned alone misses its
  // ASN.1 initialization and crypto path.
  const entry = join(resources, 'proof.mjs');
  await writeFile(entry, `import { createHostCertificate } from './server/company/host-certificate.js';\nawait createHostCertificate('127.0.0.1');\nawait import('./server/index.js');\n`);
  const env = { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, TMP: scratch, TEMP: scratch, TMPDIR: scratch,
    REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, 'hermes'), HERMES_HOME: join(data, 'hermes'),
    REALBUD_MANAGED_SERVICE: '1', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '1', OMB_PORT: String(port), LANG: 'C', LC_ALL: 'C' };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  child = spawn(process.execPath, [entry], { cwd: scratch, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16_000); });
  timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode) throw new Error('Compiled service exited before readiness');
    if (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.ok, () => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Compiled service readiness'); checks.push('Compiled server starts outside checkout without node_modules');
  const session = await fetch(base + '/api/session').then(r => r.json());
  const response = await fetch(base + '/api/company/status', { headers: { 'x-realbud-session': session.token } });
  assert.equal(response.status, 200); assert.equal((await response.json()).storageAvailable, false);
  checks.push('Packaged PostgreSQL driver loads; unprovisioned company status is usable');
  checks.push('Packaged TLS certificate generator executes successfully');
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
    proofLayer: 'Compiled service in isolated directory; not native installer or two-device acceptance', checks, failure, cleanupComplete, ...(failure ? { diagnostic: stderr } : {}) }, null, 2) + '\n');
  console.log(`${failure ? 'FAILED' : 'PASSED'} compiled company bundle: ${out}`);
  process.exitCode = failure ? 1 : 0;
}
