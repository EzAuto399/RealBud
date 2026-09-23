// Installed Windows company proof. Fictional profiles only; no Hermes or model.
// The outer process owns a native Job supervisor around the entire API scenario.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { smokeInstalledWorker } from './smoke-one-shot-worker.mjs';

const script = fileURLToPath(import.meta.url);
const scenarioMode = process.argv[2] === '--scenario';
const [resourcesArg, outputArg, scratchArg] = process.argv.slice(scenarioMode ? 3 : 2);
assert.equal(process.platform, 'win32', 'Native Windows required');
assert.equal(process.arch, 'x64', 'Native x64 required');
assert.ok(process.versions.electron && process.versions.node.startsWith('24.'), 'Use the installed Electron executable in Node mode');
assert.ok(resourcesArg && outputArg, 'Provide installed resources and a fresh output directory');
const resources = await realpath(resolve(resourcesArg)); const output = resolve(outputArg);
const executable = await realpath(process.execPath);
assert.equal(resources.toLowerCase(), (await realpath(join(dirname(executable), 'resources'))).toLowerCase(), 'Resources must belong to this installed executable');
process.env.REALBUD_RESOURCES_DIR = resources;
const supervisor = join(resources, 'RealBud Worker.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function gone(pid) {
  for (let index = 0; index < 150 && alive(pid); index++) await sleep(20);
  return !alive(pid);
}
async function closedPort(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); done(result); };
    socket.once('connect', () => finish(false)); socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function save(file, value) {
  const temporary = file + '.next';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n'); await rename(temporary, file);
}
const safeFailure = (error, stage) => ({ stage, reason: error?.code || error?.name || 'failure' });

// Query the actual service's token, not the PowerShell observer's identity.
// CheckTokenMembership requires an impersonation token; duplication preserves
// enabled/deny-only group state. Never emit names, SIDs or token contents.
const WINDOWS_TOKEN_CLASSIFIER = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class RealBudTeamToken {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CheckTokenMembership(IntPtr token, byte[] sid, out bool member);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out uint value, uint size, out uint returned);
  static byte[] Sid(WellKnownSidType kind) {
    var sid = new SecurityIdentifier(kind, null); var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0); return bytes;
  }
  static string Failure(int pid, string stage, uint error) {
    return "{\"schema\":1,\"pid\":" + pid + ",\"outcome\":\"query-failed\",\"stage\":\"" + stage + "\",\"win32Error\":" + error + "}";
  }
  public static string Inspect(int pid) {
    IntPtr process = IntPtr.Zero, token = IntPtr.Zero, duplicate = IntPtr.Zero;
    string stage = "open-process";
    try {
      process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
      if (process == IntPtr.Zero) return Failure(pid, stage, unchecked((uint)Marshal.GetLastWin32Error()));
      stage = "open-token";
      if (!OpenProcessToken(process, 0x000A, out token)) return Failure(pid, stage, unchecked((uint)Marshal.GetLastWin32Error())); // QUERY | DUPLICATE
      stage = "duplicate-token";
      if (!DuplicateToken(token, 2, out duplicate)) return Failure(pid, stage, unchecked((uint)Marshal.GetLastWin32Error())); // SecurityImpersonation
      bool admin, powerUsers;
      stage = "administrator-membership";
      if (!CheckTokenMembership(duplicate, Sid(WellKnownSidType.BuiltinAdministratorsSid), out admin)) return Failure(pid, stage, unchecked((uint)Marshal.GetLastWin32Error()));
      stage = "power-users-membership";
      if (!CheckTokenMembership(duplicate, Sid(WellKnownSidType.BuiltinPowerUsersSid), out powerUsers)) return Failure(pid, stage, unchecked((uint)Marshal.GetLastWin32Error()));
      uint elevated, elevationType, returned;
      stage = "elevation";
      if (!GetTokenInformation(token, 20, out elevated, 4, out returned)) return Failure(pid, stage, unchecked((uint)Marshal.GetLastWin32Error()));
      if (returned != 4 || elevated > 1) return Failure(pid, stage, 13);
      stage = "elevation-type";
      if (!GetTokenInformation(token, 18, out elevationType, 4, out returned)) return Failure(pid, stage, unchecked((uint)Marshal.GetLastWin32Error()));
      if (returned != 4 || elevationType < 1 || elevationType > 3) return Failure(pid, stage, 13);
      return "{\"schema\":1,\"pid\":" + pid + ",\"outcome\":\"queried\",\"administratorEnabled\":" + (admin ? "true" : "false") +
        ",\"powerUsersEnabled\":" + (powerUsers ? "true" : "false") + ",\"elevated\":" + (elevated == 1 ? "true" : "false") + ",\"elevationType\":" + elevationType + "}";
    } catch { return Failure(pid, stage, 0); }
    finally {
      if (duplicate != IntPtr.Zero) CloseHandle(duplicate);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (process != IntPtr.Zero) CloseHandle(process);
    }
  }
}
'@
  $diagnosticPid = [int]$env:REALBUD_TEAM_DIAGNOSTIC_PID
  if ($diagnosticPid -le 0) { throw 'Invalid diagnostic pid' }
  [Console]::Out.WriteLine([RealBudTeamToken]::Inspect($diagnosticPid))
} catch { exit 1 }
`;

// Fixture-only observation, installed before the compiled bootstrap imports
// child_process. Exact owned-server stderr alone changes from ignore to a drained
// pipe; native arguments, environment and other stdio remain unchanged.
// Only fixed classifications and numeric lifecycle data cross fixture IPC;
// neither native output nor argument/environment values are published.
const NATIVE_DIAGNOSTIC_ENTRY = String.raw`
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const cp = createRequire(import.meta.url)('node:child_process');
const root = resolve(process.argv[3]).toLowerCase();
const admitted = new Set(['postgres.exe', 'initdb.exe', 'pg_ctl.exe']);
const accepts = file => typeof file === 'string' && dirname(resolve(file)).toLowerCase() === root && admitted.has(basename(file).toLowerCase());
const code = value => Number.isSafeInteger(value) ? value : typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(value) ? value : null;
const markers = output => {
  const text = String(output || '').slice(0, 131072);
  return [
    ['permission-denied', /permission denied|access is denied|access denied/i],
    ['postgres-admin-token-refused', /Execution of PostgreSQL by a user with administrative permissions is not\s+permitted\./],
    ['token-membership-query-failed', /could not check access token membership: error code/i],
    ['winsock-startup-failed', /WSAStartup failed:/],
    ['configuration-refused', /configuration file.*(?:contains errors|could not|cannot)|could not (?:open|access).*configuration file|unrecognized configuration parameter/i],
    ['admin-or-restricted-token', /administrative permissions|administrator|restricted token|CreateRestrictedToken|CreateProcessAsUser/i],
    ['process-creation-failed', /could not (?:execute|start|fork|create process)|failed to (?:execute|start|fork|create process)/i],
    ['native-library-unavailable', /(?:dll|library).*(?:not found|missing|could not|failed)|(?:could not|failed to) load/i],
    ['path-unavailable', /no such file|cannot find|not found|does not exist|invalid directory/i],
    ['locale-unavailable', /invalid locale|locale.*(?:not supported|not recognized|could not)/i],
    ['version-mismatch', /not the same version|version mismatch|wrong version/i],
    ['directory-not-empty', /not empty|already exists/i],
    ['disk-or-memory-exhausted', /no space left|out of memory|not enough memory|cannot allocate memory/i],
    ['socket-or-port-refused', /could not bind|address already in use|could not create.*socket/i],
    ['password-file-refused', /password file.*(?:could not|cannot|failed|empty)|could not.*password file/i],
    ['creating-data-directories', /creating (?:directory|subdirectories)/i],
    ['selecting-runtime-defaults', /selecting default|selecting dynamic shared memory/i],
    ['creating-configuration', /creating configuration files/i],
    ['running-bootstrap', /running bootstrap script/i],
    ['post-bootstrap', /performing post-bootstrap initialization/i],
    ['syncing-data', /syncing data to disk/i],
    ['initdb-completed', /Success\. You can now start the database server/i],
  ].filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
};
let count = 0;
function emit(value) {
  if (count++ >= 64 || !process.connected) return;
  try { process.send({ type: 'realbud-team-native-diagnostic', value }, () => {}); } catch { /* diagnostics cannot change execution */ }
}
function begin(file, args, options) {
  const operation = args.includes('--version') ? 'version' : basename(file).toLowerCase() === 'initdb.exe' ? 'initdb' : args.includes('stop') ? 'stop' : 'server';
  const base = { binary: basename(file).toLowerCase(), operation };
  const environmentKeys = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'TMP', 'TEMP', 'LANG', 'LC_ALL'].filter(key => Object.hasOwn(options?.env || {}, key));
  emit({ ...base, event: 'begin', environmentKeys });
  const started = performance.now();
  return (error, stdout, stderr) => emit({ ...base, event: 'complete', elapsedMs: Math.round(performance.now() - started),
    code: error ? code(error.code) : 0, signal: /^SIG[A-Z]+$/.test(error?.signal || '') ? error.signal : null,
    killed: error?.killed === true, stdoutBytes: Buffer.byteLength(String(stdout || '')), stderrBytes: Buffer.byteLength(String(stderr || '')),
    markers: [...new Set([...markers(stdout), ...markers(stderr)])] });
}
const realFile = cp.execFile, custom = Symbol.for('nodejs.util.promisify.custom'), realPromise = realFile[custom];
function observedFile(file, ...rest) {
  if (!accepts(file) || typeof rest.at(-1) !== 'function') return realFile.call(this, file, ...rest);
  const done = rest.at(-1), record = begin(file, Array.isArray(rest[0]) ? rest[0] : [], rest[1]);
  return realFile.call(this, file, ...rest.slice(0, -1), function(error, stdout, stderr) { record(error, stdout, stderr); return done.call(this, error, stdout, stderr); });
}
if (typeof realPromise === 'function') Object.defineProperty(observedFile, custom, { value: function(file, ...rest) {
  if (!accepts(file)) return realPromise.call(this, file, ...rest);
  const record = begin(file, Array.isArray(rest[0]) ? rest[0] : [], rest[1]);
  const original = realPromise.call(this, file, ...rest);
  const observed = original.then(result => { record(null, result.stdout, result.stderr); return result; }, error => { record(error, error.stdout, error.stderr); throw error; });
  if (Object.hasOwn(original, 'child')) Object.defineProperty(observed, 'child', Object.getOwnPropertyDescriptor(original, 'child'));
  return observed;
} });
cp.execFile = observedFile;
const realSpawn = cp.spawn;
cp.spawn = function(file, ...rest) {
  const [args, options] = rest;
  const ownedData = process.env.REALBUD_DATA_DIR && resolve(process.env.REALBUD_DATA_DIR, 'company-installation/postgres/data').toLowerCase();
  const observeStderr = accepts(file) && basename(file).toLowerCase() === 'postgres.exe' && Array.isArray(args) && args.length === 2 &&
    args[0] === '-D' && typeof args[1] === 'string' && ownedData && resolve(args[1]).toLowerCase() === ownedData &&
    options?.detached === false && Array.isArray(options.stdio) && options.stdio.length === 3 && options.stdio.every(value => value === 'ignore');
  const actual = observeStderr ? [args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] }] : rest;
  const child = realSpawn.call(this, file, ...actual);
  if (accepts(file)) {
    const started = performance.now(), base = { binary: basename(file).toLowerCase(), operation: 'server' };
    child.once('spawn', () => emit({ ...base, event: 'spawn', pid: child.pid }));
    child.once('error', error => emit({ ...base, event: 'error', code: code(error.code), elapsedMs: Math.round(performance.now() - started) }));
    child.once('exit', (status, signal) => emit({ ...base, event: 'exit', code: code(status), signal: /^SIG[A-Z]+$/.test(signal || '') ? signal : null, elapsedMs: Math.round(performance.now() - started) }));
    if (observeStderr) {
      let tail = Buffer.alloc(0), bytes = 0, readFailed = false;
      const found = new Set();
      child.stderr?.on('data', chunk => {
        bytes += chunk.length;
        // Retain at most 4 KiB; scan bounded windows so split error lines match.
        for (let offset = 0; offset < chunk.length; offset += 4096) {
          const window = Buffer.concat([tail, chunk.subarray(offset, offset + 4096)]);
          for (const label of markers(window.toString('utf8'))) found.add(label);
          tail = Buffer.from(window.subarray(Math.max(0, window.length - 4096)));
        }
      });
      child.stderr?.once('error', () => { readFailed = true; });
      child.once('close', () => emit({ ...base, event: 'stderr', observation: 'ignored-to-drained-pipe',
        stderrBytes: bytes, readFailed, markers: [...found], elapsedMs: Math.round(performance.now() - started) }));
    }
  }
  return child;
};
function tokenResult(output, expectedPid) {
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 || value.pid !== expectedPid) return null;
    const exact = keys => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    if (value.outcome === 'queried' && exact(['schema', 'pid', 'outcome', 'administratorEnabled', 'powerUsersEnabled', 'elevated', 'elevationType']) &&
      ['administratorEnabled', 'powerUsersEnabled', 'elevated'].every(key => typeof value[key] === 'boolean') && [1, 2, 3].includes(value.elevationType)) return value;
    if (value.outcome === 'query-failed' && exact(['schema', 'pid', 'outcome', 'stage', 'win32Error']) &&
      ['open-process', 'open-token', 'duplicate-token', 'administrator-membership', 'power-users-membership', 'elevation', 'elevation-type'].includes(value.stage) &&
      Number.isInteger(value.win32Error) && value.win32Error >= 0 && value.win32Error <= 0xffffffff) return value;
  } catch { /* No raw classifier output crosses IPC. */ }
  return null;
}
if (process.platform === 'win32') {
  const started = performance.now(), base = { binary: 'powershell.exe', operation: 'service-token', event: 'inspection' };
  try {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    if (!systemRoot || !isAbsolute(systemRoot) || !process.argv[4]) throw new Error('Classifier unavailable');
    const output = cp.execFileSync(resolve(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', process.argv[4]], {
        env: { ...process.env, REALBUD_TEAM_DIAGNOSTIC_PID: String(process.pid) }, windowsHide: true,
        timeout: 15_000, maxBuffer: 2048, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    emit({ ...base, ...(tokenResult(output, process.pid) || { outcome: 'classifier-output-invalid' }), elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
    emit({ ...base, outcome: 'classifier-unavailable', code: code(error.code), elapsedMs: Math.round(performance.now() - started) });
  }
}
syncBuiltinESMExports();
await import(pathToFileURL(process.argv[2]).href);
`;

if (scenarioMode) {
  // This entry is launched exclusively below through the installed supervisor.
  assert.ok(scratchArg, 'Owned scenario scratch required');
  const scratch = await realpath(scratchArg); const contexts = new Set();
  const checks = [], requests = [], generations = [], observedPids = [], observedPorts = [], nativeDiagnostics = [], setupDiagnostics = [];
  const progress = () => save(join(output, 'scenario-state.json'), { stage, observedPids, observedPorts, nativeDiagnostics, setupDiagnostics });
  const { windowsFilePrivacySync: protect } = await import(pathToFileURL(join(resources, 'server/windows-file-privacy.js')).href);
  const { createServiceAdminPasswordVerifier } = await import(pathToFileURL(join(resources, 'server/service-admin.js')).href);
  let stage = 'startup', failure = null, tlsPort, cleanupComplete = false;
  const abort = new AbortController(); const deadline = setTimeout(() => abort.abort(), 420_000);
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
  async function captureSetup(context, response) {
    const directory = join(context.data, 'company-installation/postgres');
    const objects = {};
    for (const name of ['.', 'owner.lock', 'setup-progress.json', 'ownership.json', 'credentials', 'credentials/admin', 'credentials/application', 'initdb-pwfile', 'data', 'data/PG_VERSION', 'data/postgresql.conf', 'data/pg_hba.conf', 'data/postmaster.pid']) {
      try { const stat = await lstat(join(directory, name)); objects[name] = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'; }
      catch (error) { objects[name] = error.code === 'ENOENT' ? 'missing' : 'inspection-refused'; }
    }
    let phase = null, version = null;
    if (objects['setup-progress.json'] === 'file') {
      try {
        const file = join(directory, 'setup-progress.json'); check((await lstat(file)).size < 2048, 'Progress record too large');
        const value = JSON.parse(await readFile(file, 'utf8'));
        phase = value.schemaVersion === 1 && value.kind === 'realbud-owned-postgres-progress' && ['credentials', 'initdb', 'configured', 'bootstrapped'].includes(value.phase) ? value.phase : 'invalid';
      } catch { phase = 'unreadable'; }
    }
    if (objects['data/PG_VERSION'] === 'file') {
      try { const file = join(directory, 'data/PG_VERSION'); check((await lstat(file)).size < 16, 'Version record too large'); const value = (await readFile(file, 'utf8')).trim(); version = /^\d{1,3}$/.test(value) ? value : 'invalid'; }
      catch { version = 'unreadable'; }
    }
    const message = String(response?.error || '');
    const command = message.match(/Owned PostgreSQL failed running (postgres|initdb|pg_ctl)\.exe/)?.[1] || null;
    const responseClass = command ? 'native-command-failed' : /Windows.*privacy|private.*directory/i.test(message) ? 'private-storage-admission' : /runtime.*unavailable|PostgreSQL 16.*missing/i.test(message) ? 'runtime-admission' : /before becoming ready|did not become ready/i.test(message) ? 'native-server-readiness' : 'unclassified';
    setupDiagnostics.push({ role: context.role, servicePid: context.child.pid, phase, version, objects, responseClass, command });
  }
  async function call(context, path, body, expected = 200, method = body === undefined ? 'GET' : 'POST', headers = {}, timeout = 90_000) {
    stage = `${context.role} ${method} ${path}`; await progress();
    const started = performance.now();
    let response, result;
    try {
      response = await fetch(context.url + path, { method, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]),
        headers: { ...(context.token ? { 'x-realbud-session': context.token } : {}),
          ...(context.member ? { 'x-realbud-member-session': context.member } : {}),
          ...(context.admin ? { 'x-realbud-service-admin': context.admin } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      result = await response.json();
    } catch (error) {
      requests.push({ role: context.role, method, path, status: response?.status ?? null, expected, elapsedMs: Math.round(performance.now() - started), outcome: 'transport-or-body-failure' });
      if (context.role === 'host' && path === '/api/company/setup' && expected === 200) await captureSetup(context, null);
      await progress(); throw error;
    }
    requests.push({ role: context.role, method, path, status: response.status, expected, elapsedMs: Math.round(performance.now() - started) });
    if (context.role === 'host' && path === '/api/company/setup' && expected === 200) await captureSetup(context, result);
    await progress();
    check((Array.isArray(expected) ? expected : [expected]).includes(response.status), 'Unexpected company HTTP status');
    return result;
  }
  async function captureDatabase(context) {
    if (context.role !== 'host') return;
    const data = join(context.data, 'company-installation/postgres/data');
    let lines;
    try { lines = (await readFile(join(data, 'postmaster.pid'), 'utf8')).split(/\r?\n/); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const pid = Number(lines[0]), port = Number(lines[3]);
    check(Number.isSafeInteger(pid) && pid > 0 && resolve(lines[1]).toLowerCase() === data.toLowerCase() && Number.isInteger(port) && port > 0 && port < 65536,
      'Owned database marker identity mismatch');
    context.postgresPid = pid; context.ports.add(port);
    if (!observedPids.includes(pid)) observedPids.push(pid);
    if (!observedPorts.includes(port)) observedPorts.push(port);
    await progress();
  }
  async function start(role) {
    stage = `start-${role}`;
    const started = performance.now();
    const home = join(scratch, role), data = join(home, '.realbud');
    await mkdir(home, { recursive: true });
    if (!existsSync(data)) { await mkdir(data); protect(data, 'directory', true); }
    const seed = async (name, value) => {
      const file = join(data, name); if (existsSync(file)) return;
      await writeFile(file, '', { flag: 'wx' }); protect(file, 'file', true); await writeFile(file, JSON.stringify(value));
    };
    await seed('config.json', { profile: { name: `fictional-${role}-local` }, instances: { fixture: { driver: 'not-a-real-driver' } } });
    if (!existsSync(join(data, 'service-admin.json'))) await seed('service-admin.json', { version: 1,
      passwordVerifier: await createServiceAdminPasswordVerifier('Fictional-Windows-Team-Admin-2026') });
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(r => socket.close(r));
    const env = { ...serviceSmokeEnv({ executable, home, data, scratch, port }), REALBUD_TEST_LAB: '1', REALBUD_COMPANY_HOST_PREVIEW: '1',
      OMB_STATIC_DIR: join(resources, 'ui'), REALBUD_RESOURCES_DIR: resources,
      ...(role === 'host' ? { REALBUD_COMPANY_POSTGRES_BIN: join(resources, 'postgres/bin') } : {}) };
    await mkdir(env.APPDATA, { recursive: true }); await mkdir(env.LOCALAPPDATA, { recursive: true });
    const entry = join(home, 'team-native-diagnostics.mjs');
    await writeFile(entry, NATIVE_DIAGNOSTIC_ENTRY, { mode: 0o600 });
    const child = spawn(executable, [entry, join(resources, 'server/bootstrap.js'), join(resources, 'postgres/bin'), Buffer.from(WINDOWS_TOKEN_CLASSIFIER, 'utf16le').toString('base64')], { cwd: resources, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const context = { role, child, data, url: `http://127.0.0.1:${port}`, ports: new Set([port]), token: '', member: '', admin: '' };
    contexts.add(context); observedPids.push(child.pid); observedPorts.push(port);
    child.on('message', message => {
      if (message?.type !== 'realbud-team-native-diagnostic' || !message.value || nativeDiagnostics.length >= 128) return;
      nativeDiagnostics.push({ role, servicePid: child.pid, ...message.value });
      if (message.value.event === 'spawn' && Number.isSafeInteger(message.value.pid) && message.value.pid > 0 && !observedPids.includes(message.value.pid)) observedPids.push(message.value.pid);
    });
    if (role === 'host' && tlsPort) context.ports.add(tlsPort);
    context.exit = new Promise(resolveExit => {
      child.once('error', () => resolveExit({ code: null, signal: null }));
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    child.stdout.resume(); child.stderr.resume(); // No arbitrary service output or credentials in published evidence.
    await progress();
    let ready = false;
    for (const began = Date.now(); Date.now() - began < 90_000 && !abort.signal.aborted;) {
      if (child.exitCode !== null || child.signalCode) break;
      try {
        const health = await (await fetch(context.url + '/api/health', { signal: AbortSignal.timeout(1000) })).json();
        if (health.app === 'realbud' && health.pid === child.pid) { ready = true; break; }
      } catch { /* finite readiness probe */ }
      await sleep(200);
    }
    check(ready, 'Installed service readiness failed');
    context.startupMs = Math.round(performance.now() - started);
    context.token = (await call(context, '/api/session')).token; await captureDatabase(context);
    return context;
  }
  async function stop(context) {
    const started = performance.now();
    let markerValid = true; try { await captureDatabase(context); } catch { markerValid = false; }
    if (context.child.exitCode === null && !context.child.signalCode && context.child.connected) context.child.send({ type: 'realbud-test-stop' }, () => {});
    let ended; try { ended = await bounded(context.exit, 35_000, 'Service stop timed out'); } catch { /* native Job remains the fail-safe */ }
    const pidsGone = !alive(context.child.pid) && !alive(context.postgresPid);
    const portsClosed = (await Promise.all([...context.ports].map(closedPort))).every(Boolean);
    const orderly = ended?.code === 0 && ended?.signal === null;
    generations.push({ role: context.role, pid: context.child.pid, postgresPid: context.postgresPid ?? null, startupMs: context.startupMs ?? null, stopMs: Math.round(performance.now() - started), markerValid, orderly, pidsGone, portsClosed });
    if (markerValid && pidsGone && portsClosed) contexts.delete(context);
    check(markerValid && orderly && pidsGone && portsClosed, 'Owned service cleanup unconfirmed');
  }
  const ownerCredential = { loginName: 'fictional.owner', password: 'Fictional-Owner-Password-2026' };
  const memberCredential = { loginName: 'fictional.member', password: 'Fictional-Member-Password-2026' };
  try {
    let host = await start('host'), client = await start('client');
    check(host.token !== client.token && host.child.pid !== client.child.pid, 'Two independent services required');
    await call(client, '/api/config', undefined, 401, 'GET', { 'x-realbud-session': host.token });
    pass('Two installed services have separate private homes, processes and app authority');
    await call(host, '/api/company/setup', {}, 401);
    host.admin = (await call(host, '/api/service-admin/login', { password: 'Fictional-Windows-Team-Admin-2026' })).token;
    await call(host, '/api/company/setup', {}, 200, 'POST', {}, 120_000); await captureDatabase(host);
    check(host.postgresPid, 'Owned native PostgreSQL must be running');
    const owner = await call(host, '/api/company/create', { name: 'Fictional Windows Office', ownerName: 'Fictional Owner', credential: ownerCredential }, 201);
    host.member = owner.memberToken;
    await call(host, '/api/company/network', { hostname: '127.0.0.1' });
    const { hostCode } = await call(host, '/api/company/host-code');
    const target = new URL(JSON.parse(Buffer.from(hostCode.slice(4), 'base64url').toString('utf8')).origin);
    check(target.protocol === 'https:' && target.hostname === '127.0.0.1', 'Only loopback TLS targets allowed');
    tlsPort = Number(target.port); host.ports.add(tlsPort); observedPorts.push(tlsPort); await progress();
    pass('Installed PostgreSQL provisions an office and separate owner authority enables TLS joining');
    await call(client, '/api/company/connect-host', { hostCode });
    const revoked = await call(host, '/api/company/invitations', { displayName: 'Fictional Revoked Invite' }, 201);
    await call(host, '/api/company/invitations/revoke', { invitationId: revoked.invitationId });
    await call(client, '/api/company/join', { invitationToken: revoked.invitationToken, credential: memberCredential }, 401);
    const invitation = await call(host, '/api/company/invitations', { displayName: 'Fictional Member' }, 201);
    const member = await call(client, '/api/company/join', { invitationToken: invitation.invitationToken, credential: memberCredential }, 201);
    client.member = member.memberToken;
    check(member.company.id === owner.company.id && member.member.id !== owner.member.id, 'Distinct member in the same office required');
    check((await call(client, '/api/company/status')).transport === 'encrypted-company', 'Actual encrypted transport required');
    check((await call(client, '/api/company/join', { invitationToken: invitation.invitationToken, credential: memberCredential }, 409)).code === 'seat_identity_conflict', 'Bound-seat replay must refuse');
    pass('Pinned TLS joining rejects revoked invitations and repeated bound-seat enrollment');
    await call(client, '/api/company/invitations', { displayName: 'Fictional Forbidden Invite' }, 403);
    const scopes = (await call(host, '/api/company/scopes')).scopes;
    const privateScope = scopes.find(value => value.kind === 'private'), shared = scopes.find(value => value.kind === 'company');
    await call(host, '/api/company/knowledge', { scopeId: privateScope.id, key: 'fictional-private', expectedRevision: '0', content: 'fictional-owner-private-canary', sourceRefs: [] }, 200, 'PUT');
    await call(client, '/api/company/knowledge/read', { scopeId: privateScope.id, key: 'fictional-private' }, [403, 404]);
    await call(host, '/api/company/knowledge', { scopeId: shared.id, key: 'fictional-guide', expectedRevision: '0', content: 'fictional-shared-guide', sourceRefs: [] }, 200, 'PUT');
    pass('Ordinary membership cannot issue invitations or read the owner private canary');
    await stop(host);
    await call(client, '/api/company/status', undefined, 503);
    check((await call(client, '/api/config')).profile.name === 'fictional-client-local', 'Private local preferences remain available offline');
    host = await start('host'); host.member = (await call(host, '/api/company/sign-in', ownerCredential)).memberToken;
    const again = await call(client, '/api/company/sign-in', memberCredential); client.member = again.memberToken;
    check(again.member.id === member.member.id && again.company.id === owner.company.id, 'Restart retains the office and member');
    check((await call(client, '/api/company/knowledge/read', { scopeId: shared.id, key: 'fictional-guide' })).knowledge.content === 'fictional-shared-guide', 'Shared data must survive host restart');
    pass('Host outage is explicit; restart reconnects the same member and retained company data');
    await call(host, '/api/company/members/revoke', { memberId: member.member.id });
    for (const token of [member.memberToken, again.memberToken]) await call(client, '/api/company/me', undefined, 401, 'GET', { 'x-realbud-member-session': token });
    await call(client, '/api/company/sign-in', memberCredential, 401);
    pass('Member revocation retires both warm sessions and password sign-in');
    await stop(client); await stop(host);
    host = await start('host'); client = await start('client');
    const ownerAgain = await call(host, '/api/company/sign-in', ownerCredential); host.member = ownerAgain.memberToken;
    check(ownerAgain.member.id === owner.member.id && ownerAgain.company.id === owner.company.id, 'Both restarts retain office ownership');
    client.member = again.memberToken; await call(client, '/api/company/me', undefined, 401);
    await call(client, '/api/company/sign-in', memberCredential, 401);
    check((await call(host, '/api/company/membership/management', {})).members.some(value => value.id === member.member.id && value.active === false), 'Revocation must persist');
    pass('Both installed service restarts preserve revocation and office ownership');
  } catch (error) { failure = safeFailure(error, stage); }
  finally {
    clearTimeout(deadline); const cleanupErrors = [];
    for (const context of [...contexts].reverse()) { try { await stop(context); } catch { cleanupErrors.push(context.role); } }
    cleanupComplete = contexts.size === 0 && cleanupErrors.length === 0;
    await save(join(output, 'scenario.json'), { schema: 1, passed: !failure && cleanupComplete && checks.length === 7,
      runtime: { node: process.versions.node, electron: process.versions.electron }, checks, requests, generations, failure, cleanupErrors,
      cleanupComplete, observedPids, observedPorts, nativeDiagnostics, setupDiagnostics, diagnosticEntrySha256: hash(NATIVE_DIAGNOSTIC_ENTRY), tokenClassifierSha256: hash(WINDOWS_TOKEN_CLASSIFIER), scratch });
    process.exitCode = !failure && cleanupComplete && checks.length === 7 ? 0 : 1;
    // A failed graceful shutdown must let the supervisor close the complete Job.
    if (!cleanupComplete) process.exit(1);
  }
} else {
  await mkdir(output); // No overwrite of earlier evidence.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'RealBud Windows team ')));
  const env = { ...serviceSmokeEnv({ executable, home: scratch, data: join(scratch, 'outer-data'), scratch, port: 0 }), REALBUD_RESOURCES_DIR: resources };
  await mkdir(env.APPDATA, { recursive: true }); await mkdir(env.LOCALAPPDATA, { recursive: true });
  const checks = []; let failure = null, scenario, stage = 'containment-controls', scenarioChild, scenarioClosed, controlsComplete = false;
  const pendingControls = new Set();
  async function parentDeathControl() {
    const tree = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},100);setTimeout(()=>process.exit(77),60000);'],{stdio:'ignore'});
child.once('spawn',()=>console.log(JSON.stringify({leader:process.pid,descendant:child.pid})));
setInterval(()=>{},100);setTimeout(()=>process.exit(77),60000);`;
    const ownerSource = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const helper=spawn(process.argv[1],['--',process.execPath,'-e',process.argv[2]],{stdio:['pipe','pipe','inherit'],windowsHide:true});
fs.writeFileSync(process.argv[3],JSON.stringify({supervisor:helper.pid}));
let output='';helper.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('\\n')){console.log(JSON.stringify({supervisor:helper.pid,...JSON.parse(output.split('\\n')[0])}));}});
setInterval(()=>{},100);setTimeout(()=>process.exit(77),60000);`;
    const marker = join(scratch, 'parent-control.json');
    const owner = spawn(executable, ['-e', ownerSource, supervisor, tree, marker], { env, cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    pendingControls.add(owner); owner.stderr.resume();
    const ended = new Promise(resolveExit => owner.once('close', resolveExit));
    let record;
    try {
      record = JSON.parse(await bounded(new Promise((resolveLine, reject) => {
        let text = ''; owner.once('error', reject);
        owner.stdout.on('data', bytes => { text += bytes; if (text.length > 4096) reject(new Error('Control output exceeded limit')); else if (text.includes('\n')) resolveLine(text.split('\n')[0]); });
      }), 15_000, 'Parent-death control did not become ready'));
      for (const pid of Object.values(record)) check(Number.isSafeInteger(pid) && pid > 0, 'Control must identify owned PIDs');
      owner.kill('SIGKILL'); await bounded(ended, 5000, 'Owned parent did not exit');
      for (const pid of Object.values(record)) check(await gone(pid), 'Parent death left a native owned process');
      checks.push('Installed supervisor parent death closes its Job and removes the real leader and descendant');
    } finally {
      if (alive(owner.pid)) owner.kill('SIGKILL'); await bounded(ended, 5000, 'Owned parent cleanup timed out'); pendingControls.delete(owner);
      const pids = record || (existsSync(marker) ? JSON.parse(await readFile(marker, 'utf8')) : {});
      for (const pid of Object.values(pids)) check(await gone(pid), 'Native containment control cleanup unconfirmed');
    }
  }
  try {
    check(existsSync(supervisor), 'Installed Job supervisor is missing');
    const pg = JSON.parse(await readFile(join(resources, 'postgres/runtime.json'), 'utf8'));
    check(pg.platform === 'win32' && pg.architecture === 'x64' && pg.schema === 2, 'Installed PostgreSQL manifest mismatch');
    for (const binary of pg.binaries) check(hash(await readFile(join(resources, 'postgres/bin', binary.name))) === binary.sha256, 'Installed PostgreSQL binary hash mismatch');
    checks.push(...await smokeInstalledWorker(resources, executable));
    await parentDeathControl();
    controlsComplete = true;
    stage = 'two-service-scenario';
    const { runOneShot, windowsWorkerSupervisor } = await import(pathToFileURL(join(resources, 'server/one-shot-process.js')).href);
    check(windowsWorkerSupervisor() === supervisor, 'Exact installed supervisor required');
    const result = new Promise(resolveResult => {
      scenarioChild = runOneShot(executable, [script, '--scenario', resources, output, scratch],
        { cwd: scratch, env, timeout: 480_000, encoding: 'utf8', maxBuffer: 128 * 1024 },
        (error, stdout) => resolveResult({ error, stdout }));
    });
    check(scenarioChild?.pid, 'Native scenario supervisor did not start');
    scenarioClosed = new Promise(resolveClosed => scenarioChild.once('close', resolveClosed));
    await save(join(output, 'controller.json'), { supervisorPid: scenarioChild.pid, outerPid: process.pid });
    const completed = await bounded(result, 490_000, 'Native scenario exceeded its bounded deadline');
    await bounded(scenarioClosed, 5000, 'Native supervisor did not close');
    check(!completed.error, 'Contained company scenario failed');
    scenario = JSON.parse(await readFile(join(output, 'scenario.json'), 'utf8'));
    check(scenario.passed && scenario.cleanupComplete && scenario.checks.length === 7, 'Company scenario receipt did not pass');
    for (const pid of scenario.observedPids) check(await gone(pid), 'Recorded service or database PID survived');
    for (const port of scenario.observedPorts) check(await closedPort(port), 'Recorded office listener remained open');
    checks.push('Contained installed scenario passed seven groups and every recorded service/database PID and listener is gone');
    process.stdout.write(completed.stdout);
  } catch (error) { failure = safeFailure(error, stage); }
  finally {
    if (scenarioChild && alive(scenarioChild.pid)) { scenarioChild.kill('SIGKILL'); scenarioChild.stdin?.destroy(); }
    if (scenarioClosed) await bounded(scenarioClosed, 5000, 'Supervisor cleanup deadline').catch(() => { failure ||= { stage: 'cleanup', reason: 'supervisor-close-unconfirmed' }; });
    for (const child of pendingControls) if (alive(child.pid)) child.kill('SIGKILL');
    let known; try { known = JSON.parse(await readFile(join(output, 'scenario-state.json'), 'utf8')); } catch { /* scenario may not have begun */ }
    const pidsGone = (!scenarioChild || await gone(scenarioChild.pid)) && (await Promise.all((known?.observedPids || []).map(gone))).every(Boolean);
    const portsClosed = (await Promise.all((known?.observedPorts || []).map(closedPort))).every(Boolean);
    const cleanupComplete = controlsComplete && pidsGone && portsClosed && pendingControls.size === 0;
    if (!cleanupComplete) failure ||= { stage: 'cleanup', reason: 'owned-process-or-port-unconfirmed' };
    if (cleanupComplete) await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await save(join(output, 'receipt.json'), { schema: 1, passed: !failure && checks.length === 5 && scenario?.passed === true && cleanupComplete,
      generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, osRelease: release(),
      runtime: { node: process.versions.node, electron: process.versions.electron }, resources, executable,
      harnessSha256: hash(readFileSync(script)), compiledSourceRevision: process.env.REALBUD_QA_COMPILED_SHA,
      harnessSourceRevision: process.env.REALBUD_QA_HARNESS_SHA, checks, failure, cleanupComplete,
      proofLayer: 'Two installed Windows services, real packaged PostgreSQL and pinned TLS on one disposable Windows CI machine',
      limits: ['No physical Windows11 customer PC or second physical device is proved.', 'No rendered UI, live account, Hermes provisioning, model call, firewall or sleep/resume acceptance.',
        'Company TLS binds 0.0.0.0 temporarily; every fixture request targets loopback and observed listeners must close.',
        'Owner-issued local invitation authorizes enrollment; external identity-provider or website approvals are not exercised.'],
      ...(!cleanupComplete ? { preservedFixture: scratch } : {}) });
    process.exitCode = !failure && checks.length === 5 && scenario?.passed === true && cleanupComplete ? 0 : 1;
  }
}
