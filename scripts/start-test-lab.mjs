#!/usr/bin/env node
// Synthetic-only, bounded preview using compiled resources. No installation,
// provider credentials, personal Hermes profile or production RealBud data.
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const role = process.argv[2];
if (!['host', 'client'].includes(role)) throw new Error('Choose host or client.');
const resources = resolve(process.env.REALBUD_TEST_RESOURCES || join(kit, 'resources'));
const base = resolve(process.env.REALBUD_TEST_LAB_ROOT || join(homedir(), '.realbud', 'test-lab', 'two-profiles-2026-09-14'));
const profile = join(base, role); const home = join(profile, 'home'); const data = join(home, '.realbud');
await mkdir(data, { recursive: true, mode: 0o700 });
let lock;
try { lock = await open(join(profile, 'launcher.lock'), 'wx', 0o600); }
catch { throw new Error('This test profile is already open or needs recovery. Check its session.json and existing test window. No process or data was replaced.'); }
let child, exited, timer, closing, cancelled = false, unexpectedExit = false;
async function close() {
  cancelled = true;
  return closing ??= (async () => {
    clearTimeout(timer);
    if (unexpectedExit) throw new Error('Test service ended unexpectedly; data and launcher lock preserved for recovery.');
    if (child && child.exitCode === null && !child.signalCode) {
      if (!child.connected) throw new Error('Test service control channel is unavailable; data and lock preserved.');
      child.send({ type: 'realbud-test-stop' });
      let deadline;
      try {
        const result = await Promise.race([exited, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Test service shutdown needs attention; data and lock preserved.')), 25_000); })]);
        if (result.code !== 0 || result.signal) throw new Error('Test service did not stop cleanly; data and launcher lock preserved for recovery.');
      }
      finally { clearTimeout(deadline); }
    }
    await lock.close(); await rm(join(profile, 'launcher.lock'));
    await writeFile(join(profile, 'stopped.json'), JSON.stringify({ stoppedAt: new Date().toISOString(), dataPreserved: true }) + '\n');
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close().catch(error => { console.error(error.message); process.exitCode = 1; }); });
if (process.send) process.on('message', message => {
  if (message?.type === 'realbud-test-stop') void close().catch(error => { console.error(error.message); process.exitCode = 1; });
});
function checkCancellation() { if (cancelled) throw new Error('Test startup was cancelled.'); }
try {
  // A fixed, clearly synthetic admin password is for this isolated test kit.
  // It protects no paid service and is never accepted on the company listener.
  const { createServiceAdminPasswordVerifier } = await import(pathToFileURL(join(resources, 'server/service-admin.js')).href);
  checkCancellation();
  for (const [name, contents] of [
    ['config.json', { profile: { name: role === 'host' ? 'Host tester' : 'Second-profile tester' }, instances: { fixture: { driver: 'not-a-real-driver' } } }],
    ['service-admin.json', { version: 1, passwordVerifier: await createServiceAdminPasswordVerifier('RealBud-Synthetic-Lab-2026') }],
  ]) {
    try { await writeFile(join(data, name), JSON.stringify(contents), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  checkCancellation();
  const url = `http://127.0.0.1:${port}`;
  const env = { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(), LANG: 'C', LC_ALL: 'C',
    REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, 'hermes'), HERMES_HOME: join(data, 'hermes'),
    REALBUD_MANAGED_SERVICE: '1', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '1', REALBUD_TEST_LAB: '1',
    REALBUD_COMPANY_HOST_PREVIEW: '1', OMB_PORT: String(port), OMB_STATIC_DIR: join(resources, 'ui'),
    ...(role === 'host' ? { REALBUD_COMPANY_POSTGRES_BIN: resolve(process.env.REALBUD_TEST_POSTGRES_BIN || join(kit, 'postgres/bin')) } : {}) };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  child = spawn(process.execPath, [join(resources, 'server/index.js')], { cwd: resources, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { unexpectedExit = !cancelled; resolve({ code, signal }); });
  });
  void exited.catch(() => {});
  child.stdout.resume(); child.stderr.on('data', bytes => { process.stderr.write(bytes); });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    checkCancellation();
    if (child.exitCode !== null || child.signalCode) throw new Error('Test service could not start. Existing test data is preserved.');
    if (await fetch(url + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.ok, () => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Test service did not become ready.');
  await writeFile(join(profile, 'session.json'), JSON.stringify({ role, url, pid: process.pid, sourceOnly: true, syntheticOnly: true, expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }, null, 2));
  console.log(`RealBud synthetic ${role} test: ${url}`);
  console.log('Service-admin test password: RealBud-Synthetic-Lab-2026');
  console.log('Keep this launcher open. Ctrl-C stops the test service; closing the browser does not. It stops automatically after two hours.');
  process.send?.({ type: 'realbud-test-ready', role, url });
  timer = setTimeout(() => { void close().catch(error => { console.error(error.message); process.exitCode = 1; }); }, 2 * 60 * 60_000);
  await exited;
} finally { try { await close(); } finally { process.disconnect?.(); } }
