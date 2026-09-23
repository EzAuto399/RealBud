// Installed Windows company proof. Fictional profiles only; no Hermes or model.
// The outer process owns a native Job supervisor around the entire API scenario.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
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

if (scenarioMode) {
  // This entry is launched exclusively below through the installed supervisor.
  assert.ok(scratchArg, 'Owned scenario scratch required');
  const scratch = await realpath(scratchArg); const contexts = new Set();
  const checks = [], requests = [], generations = [], observedPids = [], observedPorts = [];
  const progress = () => save(join(output, 'scenario-state.json'), { stage, observedPids, observedPorts });
  const { windowsFilePrivacySync: protect } = await import(pathToFileURL(join(resources, 'server/windows-file-privacy.js')).href);
  const { createServiceAdminPasswordVerifier } = await import(pathToFileURL(join(resources, 'server/service-admin.js')).href);
  let stage = 'startup', failure = null, tlsPort, cleanupComplete = false;
  const abort = new AbortController(); const deadline = setTimeout(() => abort.abort(), 420_000);
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
  async function call(context, path, body, expected = 200, method = body === undefined ? 'GET' : 'POST', headers = {}, timeout = 90_000) {
    stage = `${context.role} ${method} ${path}`; await progress();
    const response = await fetch(context.url + path, { method, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]),
      headers: { ...(context.token ? { 'x-realbud-session': context.token } : {}),
        ...(context.member ? { 'x-realbud-member-session': context.member } : {}),
        ...(context.admin ? { 'x-realbud-service-admin': context.admin } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); requests.push({ role: context.role, method, path, status: response.status, expected });
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
    const child = spawn(executable, [join(resources, 'server/bootstrap.js')], { cwd: resources, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const context = { role, child, data, url: `http://127.0.0.1:${port}`, ports: new Set([port]), token: '', member: '', admin: '' };
    contexts.add(context); observedPids.push(child.pid); observedPorts.push(port);
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
    context.token = (await call(context, '/api/session')).token; await captureDatabase(context);
    return context;
  }
  async function stop(context) {
    let markerValid = true; try { await captureDatabase(context); } catch { markerValid = false; }
    if (context.child.exitCode === null && !context.child.signalCode && context.child.connected) context.child.send({ type: 'realbud-test-stop' }, () => {});
    let ended; try { ended = await bounded(context.exit, 35_000, 'Service stop timed out'); } catch { /* native Job remains the fail-safe */ }
    const pidsGone = !alive(context.child.pid) && !alive(context.postgresPid);
    const portsClosed = (await Promise.all([...context.ports].map(closedPort))).every(Boolean);
    const orderly = ended?.code === 0 && ended?.signal === null;
    generations.push({ role: context.role, pid: context.child.pid, postgresPid: context.postgresPid ?? null, markerValid, orderly, pidsGone, portsClosed });
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
      cleanupComplete, observedPids, observedPorts, scratch });
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
